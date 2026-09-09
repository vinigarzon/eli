// ============================================================
// Data layer. Two implementations with the same interface:
//   SupabaseBackend — production (shared database, auth, realtime)
//   MockBackend     — local demo (?mock=1): in-memory + localStorage,
//                     syncs between tabs with BroadcastChannel so two
//                     "sessions" can be tested in one browser.
// ============================================================

const POST_FIELDS = [
  'title', 'scheduled_date', 'scheduled_time', 'channel', 'format', 'status',
  'topic', 'assignee', 'palette', 'ready_3x4', 'ready_9x16', 'caption',
  'notes', 'asset_links', 'import_key', 'series', 'photo_brief', 'photo_status',
];

export function pickPostFields(obj) {
  const out = {};
  for (const k of POST_FIELDS) if (k in obj) out[k] = obj[k];
  if ('scheduled_time' in out && !out.scheduled_time) out.scheduled_time = null;
  if ('import_key' in out && !out.import_key) out.import_key = null;
  return out;
}

export class ConflictError extends Error {
  constructor(latest) { super('version_conflict'); this.latest = latest; }
}
export class NotFoundError extends Error {
  constructor() { super('not_found'); }
}

// ------------------------------------------------------------
// Supabase
// ------------------------------------------------------------
export class SupabaseBackend {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.listeners = new Set();
    this.channel = null;
    this.realtimeStatus = 'connecting';
  }

  async init() {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    this.client = createClient(this.config.SUPABASE_URL, this.config.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  // ---- auth ----
  onAuthChange(cb) {
    this.client.auth.onAuthStateChange((event, session) => cb(event, session));
  }
  async getSession() {
    const { data } = await this.client.auth.getSession();
    return data.session;
  }
  async signIn(email, password) {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendlyAuthError(error));
  }
  async signUp(email, password, displayName) {
    const { data, error } = await this.client.auth.signUp({
      email, password,
      options: { data: { display_name: displayName }, emailRedirectTo: appUrl() },
    });
    if (error) throw new Error(friendlyAuthError(error));
    // Supabase returns a user with an empty identities array when the email already exists.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error('An account with this email already exists. Try signing in or resetting your password.');
    }
    return { needsConfirmation: !data.session };
  }
  async resetPassword(email) {
    const { error } = await this.client.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
    if (error) throw new Error(friendlyAuthError(error));
  }
  async updatePassword(password) {
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw new Error(friendlyAuthError(error));
  }
  async signOut() {
    await this.client.auth.signOut();
    if (this.channel) { await this.client.removeChannel(this.channel); this.channel = null; }
  }

  // ---- profile / members ----
  async getProfile() {
    const { data: { user } } = await this.client.auth.getUser();
    if (!user) return null;
    const { data, error } = await this.client.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async updateDisplayName(name) {
    const { data: { user } } = await this.client.auth.getUser();
    const { error } = await this.client.from('profiles').update({ display_name: name }).eq('id', user.id);
    if (error) throw error;
  }
  async listMembers() {
    const { data, error } = await this.client.from('profiles').select('*').order('created_at');
    if (error) throw error;
    return data;
  }
  async listInvitations() {
    const { data, error } = await this.client.from('invitations').select('*').order('created_at');
    if (error) throw error;
    return data;
  }
  async addInvitation(email, role) {
    const { error } = await this.client.from('invitations').upsert({ email: email.trim().toLowerCase(), role }, { onConflict: 'email' });
    if (error) throw error;
  }
  async removeInvitation(email) {
    const { error } = await this.client.from('invitations').delete().eq('email', email);
    if (error) throw error;
  }
  async setMemberRole(id, role) {
    const { error } = await this.client.from('profiles').update({ role }).eq('id', id);
    if (error) throw error;
  }
  async removeMember(id, email) {
    const { error } = await this.client.from('profiles').delete().eq('id', id);
    if (error) throw error;
    if (email) await this.client.from('invitations').delete().eq('email', email);
  }

  // ---- posts ----
  async listPosts() {
    const { data, error } = await this.client.from('posts').select('*').order('scheduled_date').order('scheduled_time', { nullsFirst: true });
    if (error) throw error;
    return data;
  }
  async getPost(id) {
    const { data, error } = await this.client.from('posts').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async insertPost(post) {
    const row = pickPostFields(post);
    if (post.id) row.id = post.id;
    const { data, error } = await this.client.from('posts').insert(row).select().single();
    if (error) throw error;
    return data;
  }
  async insertPostsIgnoreDuplicates(posts) {
    const rows = posts.map((p) => { const r = pickPostFields(p); if (p.id) r.id = p.id; return r; });
    const { data, error } = await this.client.from('posts').upsert(rows, { onConflict: 'import_key', ignoreDuplicates: true }).select();
    if (error) throw error;
    return data;
  }
  async updatePost(id, expectedVersion, patch) {
    const row = pickPostFields(patch);
    row.version = expectedVersion + 1;
    const { data, error } = await this.client.from('posts').update(row).eq('id', id).eq('version', expectedVersion).select();
    if (error) throw error;
    if (!data || data.length === 0) {
      const latest = await this.getPost(id);
      if (!latest) throw new NotFoundError();
      throw new ConflictError(latest);
    }
    return data[0];
  }
  async deletePost(id) {
    const { error } = await this.client.from('posts').delete().eq('id', id);
    if (error) throw error;
  }

  // ---- comments ----
  async listComments(postId) {
    const { data, error } = await this.client.from('post_comments').select('*').eq('post_id', postId).order('created_at');
    if (error) throw error;
    return data;
  }
  async listAllComments() {
    const { data, error } = await this.client.from('post_comments').select('*').order('created_at');
    if (error) throw error;
    return data;
  }
  async addComment(postId, body) {
    const { data, error } = await this.client.from('post_comments').insert({ post_id: postId, body }).select().single();
    if (error) throw error;
    return data;
  }
  async insertCommentsIgnoreDuplicates(comments) {
    if (!comments.length) return [];
    const rows = comments.map((c) => ({ id: c.id, post_id: c.post_id, body: c.body, author_name: c.author_name || '', created_at: c.created_at }));
    const { data, error } = await this.client.from('post_comments').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }).select();
    if (error) throw error;
    return data;
  }
  async deleteComment(id) {
    const { error } = await this.client.from('post_comments').delete().eq('id', id);
    if (error) throw error;
  }

  // ---- realtime ----
  subscribe(cb, onStatus) {
    if (this.channel) this.client.removeChannel(this.channel);
    this.channel = this.client
      .channel('eli-planner')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, (p) => cb({ table: 'posts', type: p.eventType, new: p.new, old: p.old }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'post_comments' }, (p) => cb({ table: 'post_comments', type: p.eventType, new: p.new, old: p.old }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (p) => cb({ table: 'profiles', type: p.eventType, new: p.new, old: p.old }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invitations' }, (p) => cb({ table: 'invitations', type: p.eventType, new: p.new, old: p.old }))
      .subscribe((status) => { this.realtimeStatus = status; onStatus && onStatus(status); });
  }
}

function appUrl() {
  const u = new URL(window.location.href);
  u.hash = '';
  u.search = '';
  return u.toString();
}

function friendlyAuthError(error) {
  const m = (error && error.message) || 'Something went wrong.';
  if (/not been invited/i.test(m)) return 'This email address has not been invited to the ELI Content Planner. Ask the workspace owner to add you.';
  if (/Database error saving new user/i.test(m)) return 'This email address has not been invited to the ELI Content Planner. Ask the workspace owner to add you.';
  if (/Invalid login credentials/i.test(m)) return 'Incorrect email or password.';
  if (/Email not confirmed/i.test(m)) return 'Please confirm your email address first (check your inbox), then sign in.';
  if (/rate limit/i.test(m)) return 'Too many emails were sent recently. Please wait a few minutes and try again.';
  return m;
}

// ------------------------------------------------------------
// Mock backend (local demo only)
// ------------------------------------------------------------
const MOCK_KEY = 'eli-planner-mock-db-v1';

export class MockBackend {
  constructor() {
    this.listeners = new Set();
    this.session = null;
    this.authCb = null;
    this.bc = ('BroadcastChannel' in window) ? new BroadcastChannel('eli-planner-mock') : null;
    if (this.bc) this.bc.onmessage = (e) => { this._load(); this.listeners.forEach((cb) => cb(e.data)); };
    this._load();
  }
  _load() {
    try {
      const raw = localStorage.getItem(MOCK_KEY);
      this.db = raw ? JSON.parse(raw) : null;
    } catch { this.db = null; }
    if (!this.db) this.db = { users: [], profiles: [], invitations: [], posts: [], comments: [] };
  }
  _save() { try { localStorage.setItem(MOCK_KEY, JSON.stringify(this.db)); } catch {} }
  _emit(evt) { this._save(); this.listeners.forEach((cb) => cb(evt)); if (this.bc) this.bc.postMessage(evt); }
  async init() {
    try { this.session = JSON.parse(sessionStorage.getItem(MOCK_KEY + ':session') || 'null'); } catch { this.session = null; }
  }
  _me() { return this.session ? this.db.profiles.find((p) => p.id === this.session.user_id) : null; }
  _requireMember() { const me = this._me(); if (!me) throw new Error('Not a member'); return me; }
  _requireOwner() { const me = this._requireMember(); if (me.role !== 'owner') throw new Error('Owner access required'); return me; }

  onAuthChange(cb) { this.authCb = cb; }
  async getSession() { return this.session; }
  async signIn(email, password) {
    this._load();
    const u = this.db.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u || u.password !== password) throw new Error('Incorrect email or password.');
    this.session = { user_id: u.id };
    sessionStorage.setItem(MOCK_KEY + ':session', JSON.stringify(this.session));
    this.authCb && this.authCb('SIGNED_IN', this.session);
  }
  async signUp(email, password, displayName) {
    this._load();
    email = email.trim().toLowerCase();
    if (this.db.users.some((x) => x.email === email)) throw new Error('An account with this email already exists. Try signing in.');
    const inv = this.db.invitations.find((i) => i.email.toLowerCase() === email);
    if (!inv && this.db.profiles.length > 0) throw new Error('This email address has not been invited to the ELI Content Planner. Ask the workspace owner to add you.');
    const id = uuid();
    this.db.users.push({ id, email, password });
    this.db.profiles.push({ id, email, display_name: displayName || email.split('@')[0], role: inv ? inv.role : 'owner', created_at: new Date().toISOString() });
    if (inv) inv.accepted_at = new Date().toISOString();
    else this.db.invitations.push({ email, role: 'owner', created_at: new Date().toISOString(), accepted_at: new Date().toISOString() });
    this._emit({ table: 'profiles', type: 'INSERT' });
    await this.signIn(email, password);
    return { needsConfirmation: false };
  }
  async resetPassword() { throw new Error('Password reset emails are not available in demo mode.'); }
  async updatePassword(password) { const u = this.db.users.find((x) => x.id === this.session.user_id); u.password = password; this._save(); }
  async signOut() { this.session = null; sessionStorage.removeItem(MOCK_KEY + ':session'); this.authCb && this.authCb('SIGNED_OUT', null); }

  async getProfile() { this._load(); return this._me(); }
  async updateDisplayName(name) { const me = this._requireMember(); me.display_name = name; this._emit({ table: 'profiles', type: 'UPDATE' }); }
  async listMembers() { this._requireMember(); return [...this.db.profiles]; }
  async listInvitations() { this._requireOwner(); return [...this.db.invitations]; }
  async addInvitation(email, role) {
    this._requireOwner(); email = email.trim().toLowerCase();
    const ex = this.db.invitations.find((i) => i.email === email);
    if (ex) ex.role = role; else this.db.invitations.push({ email, role, created_at: new Date().toISOString(), accepted_at: null });
    this._emit({ table: 'invitations', type: 'INSERT' });
  }
  async removeInvitation(email) { this._requireOwner(); this.db.invitations = this.db.invitations.filter((i) => i.email !== email); this._emit({ table: 'invitations', type: 'DELETE' }); }
  async setMemberRole(id, role) { this._requireOwner(); const p = this.db.profiles.find((x) => x.id === id); if (p) p.role = role; this._emit({ table: 'profiles', type: 'UPDATE' }); }
  async removeMember(id, email) {
    this._requireOwner();
    this.db.profiles = this.db.profiles.filter((x) => x.id !== id);
    this.db.invitations = this.db.invitations.filter((i) => i.email !== email);
    this._emit({ table: 'profiles', type: 'DELETE', old: { id } });
  }

  async listPosts() { this._load(); this._requireMember(); return this.db.posts.map((p) => ({ ...p })); }
  async getPost(id) { this._load(); return this.db.posts.find((p) => p.id === id) || null; }
  async insertPost(post) {
    const me = this._requireMember();
    const now = new Date().toISOString();
    const row = { id: post.id || uuid(), ...defaultPost(), ...pickPostFields(post), version: 1, created_by: me.id, created_at: now, updated_by: me.id, updated_by_name: me.display_name, updated_at: now };
    this.db.posts.push(row);
    this._emit({ table: 'posts', type: 'INSERT', new: row });
    return { ...row };
  }
  async insertPostsIgnoreDuplicates(posts) {
    const out = [];
    for (const p of posts) {
      if (p.import_key && this.db.posts.some((x) => x.import_key === p.import_key)) continue;
      if (p.id && this.db.posts.some((x) => x.id === p.id)) continue;
      out.push(await this.insertPost(p));
    }
    return out;
  }
  async updatePost(id, expectedVersion, patch) {
    await sleep(120);
    this._load();
    const me = this._requireMember();
    const row = this.db.posts.find((p) => p.id === id);
    if (!row) throw new NotFoundError();
    if (row.version !== expectedVersion) throw new ConflictError({ ...row });
    Object.assign(row, pickPostFields(patch), { version: expectedVersion + 1, updated_by: me.id, updated_by_name: me.display_name, updated_at: new Date().toISOString() });
    this._emit({ table: 'posts', type: 'UPDATE', new: { ...row } });
    return { ...row };
  }
  async deletePost(id) {
    this._requireMember();
    const old = this.db.posts.find((p) => p.id === id);
    this.db.posts = this.db.posts.filter((p) => p.id !== id);
    this.db.comments = this.db.comments.filter((c) => c.post_id !== id);
    this._emit({ table: 'posts', type: 'DELETE', old: old ? { id } : { id } });
  }

  async listComments(postId) { this._load(); return this.db.comments.filter((c) => c.post_id === postId); }
  async listAllComments() { this._load(); return [...this.db.comments]; }
  async addComment(postId, body) {
    const me = this._requireMember();
    const c = { id: uuid(), post_id: postId, author_id: me.id, author_name: me.display_name, body, created_at: new Date().toISOString() };
    this.db.comments.push(c);
    this._emit({ table: 'post_comments', type: 'INSERT', new: c });
    return c;
  }
  async insertCommentsIgnoreDuplicates(comments) {
    const out = [];
    for (const c of comments) {
      if (this.db.comments.some((x) => x.id === c.id)) continue;
      const row = { id: c.id || uuid(), post_id: c.post_id, author_id: null, author_name: c.author_name || '', body: c.body, created_at: c.created_at || new Date().toISOString() };
      this.db.comments.push(row); out.push(row);
    }
    this._emit({ table: 'post_comments', type: 'INSERT' });
    return out;
  }
  async deleteComment(id) { this.db.comments = this.db.comments.filter((c) => c.id !== id); this._emit({ table: 'post_comments', type: 'DELETE', old: { id } }); }

  subscribe(cb, onStatus) { this.listeners.add(cb); onStatus && onStatus('SUBSCRIBED'); }
}

export function defaultPost() {
  return {
    title: '', scheduled_date: '', scheduled_time: null, channel: 'Instagram', format: 'single_image',
    status: 'idea', topic: '', assignee: '', palette: 'red', ready_3x4: false, ready_9x16: false,
    caption: '', notes: '', asset_links: '', import_key: null,
    series: '', photo_brief: '', photo_status: 'none',
  };
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBackend(config) {
  const mock = config.MOCK || new URLSearchParams(location.search).get('mock') === '1';
  return mock ? new MockBackend() : new SupabaseBackend(config);
}
