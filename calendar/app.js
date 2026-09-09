// ============================================================
// ELI Content Planner — application
// ============================================================
import { CONFIG } from './config.js?v=202609091842';
import { SAMPLE_POSTS } from './samples.js?v=202609091842';
import { createBackend, ConflictError, NotFoundError, defaultPost, pickPostFields, uuid } from './backend.js?v=202609091842';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FORMAT_LABEL = { single_image: 'Single image', carousel: 'Carousel', reel: 'Reel', story: 'Story' };
const FORMAT_ICON = { single_image: '▣', carousel: '▤', reel: '▶', story: '▮' };
const STATUS_LABEL = { idea: 'Idea', draft: 'Draft', in_review: 'In Review', approved: 'Approved', scheduled: 'Scheduled', published: 'Published' };
const PALETTE_LABEL = { red: 'Red', black: 'Black', white: 'White' };
const PHOTO_LABEL = { none: 'not needed', needed: 'needed', requested: 'requested', delivered: 'delivered' };

const state = {
  backend: null,
  profile: null,
  posts: new Map(),
  comments: new Map(), // postId -> [comments]
  members: [],
  view: 'month',
  listAll: false, // list view: false = selected month, true = every post
  month: '', // YYYY-MM
  filters: { q: '', channel: '', format: '', status: '', topic: '', assignee: '', series: '' },
  quick: '',
  selectedDay: '', // mobile agenda
  shotsIncludeDelivered: false,
  open: null, // { id, base (snapshot of saved row), dirty }
  saving: 0,
  undoStack: [],
};

// ------------------------------------------------------------
// Date helpers — all calendar math is done on YYYY-MM-DD strings
// (never through local Date parsing) so dates never shift across time zones.
// ------------------------------------------------------------
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function parts(iso) { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; }
function iso(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function addDays(isoDate, n) {
  const { y, m, d } = parts(isoDate);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function dow(isoDate) { const { y, m, d } = parts(isoDate); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function monthOf(isoDate) { return isoDate.slice(0, 7); }
function shiftMonth(ym, n) { let [y, m] = ym.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }
function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function longDate(isoDate) { const { y, m, d } = parts(isoDate); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
function shortDate(isoDate) { const { y, m, d } = parts(isoDate); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
function fmtTime(t) { if (!t) return ''; const [h, mi] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; const hh = ((h + 11) % 12) + 1; return `${hh}:${String(mi).padStart(2, '0')} ${ap}`; }
function fmtStamp(ts) { if (!ts) return ''; return new Date(ts).toLocaleString('en-US', { timeZone: CONFIG.TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

// ------------------------------------------------------------
// Caption checks (flag only, never rewrite)
// ------------------------------------------------------------
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;
export function captionChecks(caption, channel) {
  const out = [];
  const text = caption || '';
  if (!text.trim()) return [{ level: 'info', msg: 'No caption yet.' }];
  const dashes = (text.match(/[-–—]/g) || []).length;
  const hashtags = (text.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  const emojis = (text.match(EMOJI_RE) || []).length;
  const nonEnglish = (text.match(/[ñÑáéíóúÁÉÍÓÚ¿¡üÜçÇ]/g) || []).length;
  const ig = /instagram/i.test(channel || '');
  if (dashes) out.push({ level: 'warn', msg: `${dashes} dash${dashes > 1 ? 'es' : ''} found. Captions must not contain dashes.` });
  else out.push({ level: 'ok', msg: 'No dashes.' });
  if (hashtags === 3) out.push({ level: 'ok', msg: 'Exactly three hashtags.' });
  else out.push({ level: ig ? 'warn' : 'info', msg: `${hashtags} hashtag${hashtags === 1 ? '' : 's'} (rule: exactly three).` });
  if (emojis >= 2 && emojis <= 3) out.push({ level: 'ok', msg: `${emojis} emojis.` });
  else out.push({ level: ig ? 'warn' : 'info', msg: `${emojis} emoji${emojis === 1 ? '' : 's'} (rule: two to three).` });
  if (nonEnglish) out.push({ level: 'warn', msg: 'Accented or Spanish characters found. Captions must be in English.' });
  if (!/build your future/i.test(text)) out.push({ level: 'info', msg: 'Core message not included ("Improve your English. Build your future.").' });
  return out;
}

// ------------------------------------------------------------
// UI utilities
// ------------------------------------------------------------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function toast(msg, { undo, error, timeout = 6000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (undo) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = 'Undo';
    b.onclick = async () => { el.remove(); try { await undo(); } catch (e) { toast('Undo failed: ' + e.message, { error: true }); } };
    el.appendChild(b);
  }
  const x = document.createElement('button'); x.type = 'button'; x.className = 'btn small'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
  x.onclick = () => el.remove(); if (!undo) x.style.marginLeft = 'auto';
  el.appendChild(x);
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

function setSaveStatus(stateName, text) {
  const el = $('#save-status');
  el.dataset.state = stateName;
  el.textContent = text;
}
let savedTimer;
function markSaving() { state.saving++; setSaveStatus('saving', 'Saving…'); }
function markSaved() {
  state.saving = Math.max(0, state.saving - 1);
  if (state.saving === 0) {
    setSaveStatus('saved', 'Saved ✓');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { if (state.saving === 0 && $('#save-status').dataset.state === 'saved') setSaveStatus('idle', 'All changes saved'); }, 2500);
  }
}
function markError(msg) {
  state.saving = Math.max(0, state.saving - 1);
  setSaveStatus('error', 'Save failed ⚠');
  toast(msg || 'Could not save. Check your connection and try again.', { error: true, timeout: 9000 });
}

function modal(html) {
  const m = $('#modal'); m.innerHTML = html; m.hidden = false; $('#modal-backdrop').hidden = false;
  const first = m.querySelector('input,select,button'); first && first.focus();
  return m;
}
function closeModal() { $('#modal').hidden = true; $('#modal-backdrop').hidden = true; $('#modal').innerHTML = ''; }
function confirmDialog({ title, body, okText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const m = modal(`<h3>${esc(title)}</h3><p>${esc(body)}</p><div class="actions"><button type="button" class="btn ghost" data-r="0">Cancel</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okText)}</button></div>`);
    m.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => { closeModal(); resolve(b.dataset.r === '1'); });
  });
}
function promptDialog({ title, label, value = '', okText = 'Save' }) {
  return new Promise((resolve) => {
    const m = modal(`<h3>${esc(title)}</h3><form><label class="hint">${esc(label)}<input type="text" name="v" value="${esc(value)}" required style="margin-top:6px"></label><div class="actions"><button type="button" class="btn ghost" data-r="0">Cancel</button><button type="submit" class="btn primary">${esc(okText)}</button></div></form>`);
    m.querySelector('[data-r="0"]').onclick = () => { closeModal(); resolve(null); };
    m.querySelector('form').onsubmit = (e) => { e.preventDefault(); const v = m.querySelector('input').value.trim(); closeModal(); resolve(v || null); };
    m.querySelector('input').select();
  });
}

// ------------------------------------------------------------
// Auth screen
// ------------------------------------------------------------
function showAuth(panel = 'signin', msg = '', kind = '') {
  $('#app').hidden = true; $('#auth').hidden = false;
  $$('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === panel));
  $$('.auth-form').forEach((f) => f.hidden = f.dataset.panel !== panel);
  const m = $('#auth-msg'); m.textContent = msg; m.className = 'auth-msg ' + kind;
}
function bindAuth() {
  $$('.auth-tabs button').forEach((b) => b.onclick = () => showAuth(b.dataset.tab));
  const busy = (form, on) => form.querySelectorAll('button').forEach((b) => b.disabled = on);
  $('#form-signin').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; busy(f, true);
    try { await state.backend.signIn(f.email.value.trim(), f.password.value); }
    catch (err) { showAuth('signin', err.message, 'error'); }
    finally { busy(f, false); }
  };
  $('#form-signup').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; busy(f, true);
    try {
      const r = await state.backend.signUp(f.email.value.trim(), f.password.value, f.name.value.trim());
      if (r.needsConfirmation) showAuth('signin', 'Account created. Check your inbox and click the confirmation link, then sign in.', 'ok');
    } catch (err) { showAuth('signup', err.message, 'error'); }
    finally { busy(f, false); }
  };
  $('#form-reset').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; busy(f, true);
    try { await state.backend.resetPassword(f.email.value.trim()); showAuth('reset', 'If that email belongs to a member, a reset link is on its way.', 'ok'); }
    catch (err) { showAuth('reset', err.message, 'error'); }
    finally { busy(f, false); }
  };
  $('#form-newpass').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; busy(f, true);
    try { await state.backend.updatePassword(f.password.value); toast('Password updated.'); await enterApp(); }
    catch (err) { showAuth('newpass', err.message, 'error'); }
    finally { busy(f, false); }
  };
}

// ------------------------------------------------------------
// App bootstrap
// ------------------------------------------------------------
let entering = false;
async function enterApp() {
  if (entering) return; entering = true;
  try { await enterAppInner(); } finally { entering = false; }
}
async function enterAppInner() {
  let profile;
  try { profile = await state.backend.getProfile(); }
  catch (e) { showAuth('signin', 'Could not load your profile: ' + e.message, 'error'); return; }
  if (!profile) {
    await state.backend.signOut();
    showAuth('signin', 'Your account is not a member of this workspace. Ask the workspace owner to invite you.', 'error');
    return;
  }
  state.profile = profile;
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#me-name').textContent = profile.display_name;
  $('#me-name2').textContent = profile.display_name;
  $('#me-email').textContent = profile.email;
  $('#me-role').textContent = profile.role;
  $('#menu-admin').hidden = profile.role !== 'owner';
  $('#brand-assets-note').textContent = CONFIG.BRAND_ASSETS_NOTE;
  if (!state.month) state.month = monthOf(todayISO());
  $('#month-label').textContent = monthLabel(state.month);
  setSaveStatus('saving', 'Loading…');
  await loadAll();
  if ($('#save-status').dataset.state === 'saving') setSaveStatus('idle', 'All changes saved');
  state.backend.subscribe(onRealtime, (status) => { const el = $('#live-status'); el.dataset.state = status; el.title = 'Live updates: ' + status; });
}

async function loadAll() {
  try {
    const [posts, members] = await Promise.all([state.backend.listPosts(), state.backend.listMembers()]);
    state.posts = new Map(posts.map((p) => [p.id, p]));
    state.members = members;
    render();
  } catch (e) {
    showBanner('Could not load posts: ' + e.message + ' ', true, { label: 'Retry', fn: loadAll });
  }
}

function showBanner(text, error = false, action = null) {
  const b = $('#banner'); b.className = 'banner' + (error ? ' error' : ''); b.hidden = false;
  b.innerHTML = `<span>${esc(text)}</span>`;
  if (action) { const btn = document.createElement('button'); btn.className = 'btn small'; btn.textContent = action.label; btn.onclick = () => { b.hidden = true; action.fn(); }; b.appendChild(btn); }
  const x = document.createElement('button'); x.className = 'btn small ghost'; x.textContent = 'Dismiss'; x.onclick = () => b.hidden = true; b.appendChild(x);
}

function onRealtime(evt) {
  if (evt.table === 'posts') {
    if (evt.type === 'DELETE') {
      const id = evt.old && evt.old.id;
      if (id && state.posts.has(id)) {
        state.posts.delete(id);
        if (state.open && state.open.id === id) { showConflict('This post was deleted by another team member.', [{ label: 'Close', fn: () => closeDrawer(true) }]); }
      }
    } else if (evt.new) {
      const incoming = evt.new;
      const current = state.posts.get(incoming.id);
      if (!current || incoming.version >= (current.version || 0) || evt.type === 'INSERT') state.posts.set(incoming.id, incoming);
      if (state.open && state.open.id === incoming.id && incoming.version !== state.open.base.version && incoming.updated_by !== state.profile.id) {
        if (state.open.dirty) {
          showConflict(`${incoming.updated_by_name || 'Someone'} updated this post at ${fmtStamp(incoming.updated_at)} while you were editing.`, [
            { label: 'Load their version', fn: () => { fillForm(incoming); state.open.base = incoming; setDirty(false); hideConflict(); } },
            { label: 'Keep my edits (will overwrite)', fn: () => { state.open.base = incoming; hideConflict(); } },
          ]);
        } else { fillForm(incoming); state.open.base = incoming; renderMeta(incoming); }
      }
    } else { loadAll(); return; }
    render();
  } else if (evt.table === 'post_comments') {
    if (state.open && ((evt.new && evt.new.post_id === state.open.id) || (evt.old && evt.old.post_id === state.open.id) || !evt.new)) loadComments(state.open.id);
  } else if (evt.table === 'profiles') {
    state.backend.listMembers().then((m) => { state.members = m; renderDatalists(); }).catch(() => {});
    if (evt.type === 'DELETE' && evt.old && evt.old.id === state.profile.id) { state.backend.signOut(); showAuth('signin', 'Your access to this workspace was removed.', 'error'); }
  }
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------
function visiblePosts() {
  const f = state.filters; const q = f.q.trim().toLowerCase();
  return [...state.posts.values()].filter((p) =>
    (!f.channel || p.channel === f.channel) &&
    (!f.format || p.format === f.format) &&
    (!f.status || p.status === f.status) &&
    (!f.topic || p.topic === f.topic) &&
    (!f.assignee || p.assignee === f.assignee) &&
    (!f.series || p.series === f.series) &&
    quickMatch(p) &&
    (!q || [p.title, p.caption, p.notes, p.topic, p.assignee, p.channel, p.series, p.photo_brief].some((v) => (v || '').toLowerCase().includes(q)))
  ).sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || (a.scheduled_time || '').localeCompare(b.scheduled_time || '') || a.title.localeCompare(b.title));
}
const isMobile = () => window.matchMedia('(max-width: 720px)').matches;
function filtersActive() { return Object.values(state.filters).some(Boolean); }
function weekRange(isoDate) { const start = addDays(isoDate, -dow(isoDate)); return [start, addDays(start, 6)]; }
function quickMatch(p) {
  switch (state.quick) {
    case 'photos_needed': return p.photo_status === 'needed' || p.photo_status === 'requested';
    case 'photos_delivered': return p.photo_status === 'delivered' && !['published'].includes(p.status);
    case 'in_progress': return ['draft', 'in_review', 'approved'].includes(p.status);
    case 'week': { const [s, e] = weekRange(todayISO()); return p.scheduled_date >= s && p.scheduled_date <= e; }
    default: return true;
  }
}

function render() {
  renderDatalists();
  $('#month-label').textContent = monthLabel(state.month);
  $$('.seg').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#f-clear').hidden = !filtersActive();
  const posts = visiblePosts();
  $('#empty').hidden = !(state.posts.size === 0);
  $$('.owner-only').forEach((el) => el.hidden = state.profile.role !== 'owner');
  $('#empty [data-action=samples]').hidden = state.profile.role !== 'owner';
  $$('.qf').forEach((b) => b.classList.toggle('active', b.dataset.quick === state.quick));
  $('#f-clear').hidden = !(filtersActive() || state.quick);
  $('#view-month').hidden = state.view !== 'month'; $('#view-list').hidden = state.view !== 'list'; $('#view-shots').hidden = state.view !== 'shots';
  if (state.view === 'month') renderMonth(posts);
  else if (state.view === 'list') renderList(state.listAll ? posts : posts.filter((p) => monthOf(p.scheduled_date) === state.month));
  else renderShots();
  $('#list-scope').hidden = state.view !== 'list';
  $('.toolbar').hidden = state.view === 'shots'; $('.quick').hidden = state.view === 'shots';
}

function renderDatalists() {
  const vals = (key, base = []) => [...new Set([...base, ...[...state.posts.values()].map((p) => p[key]).filter(Boolean)])].sort();
  const fill = (sel, values, placeholder) => {
    const el = $(sel); const cur = el.value;
    el.innerHTML = `<option value="">${placeholder}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    el.value = values.includes(cur) ? cur : '';
  };
  const channels = vals('channel', CONFIG.CHANNELS); const topics = vals('topic', CONFIG.TOPICS);
  const assignees = vals('assignee', state.members.map((m) => m.display_name));
  const series = vals('series');
  fill('#f-channel', channels, 'All channels'); fill('#f-topic', topics, 'All topics'); fill('#f-assignee', assignees, 'All assignees'); fill('#f-series', series, 'All series');
  $('#dl-series').innerHTML = series.map((v) => `<option value="${esc(v)}">`).join('');
  $('#dl-photo-group').innerHTML = vals('photo_group', CONFIG.PHOTO_GROUPS || []).map((v) => `<option value="${esc(v)}">`).join('');
  $('#dl-channel').innerHTML = channels.map((v) => `<option value="${esc(v)}">`).join('');
  $('#dl-topic').innerHTML = topics.map((v) => `<option value="${esc(v)}">`).join('');
  $('#dl-assignee').innerHTML = assignees.map((v) => `<option value="${esc(v)}">`).join('');
}

function chipHTML(p) {
  return `<button type="button" class="chip pal-${p.palette}" draggable="true" data-id="${p.id}" title="${esc(p.title)} · ${STATUS_LABEL[p.status]} · ${FORMAT_LABEL[p.format]}${p.assignee ? ' · ' + esc(p.assignee) : ''}">
    <span class="fmt" aria-hidden="true">${FORMAT_ICON[p.format] || ''}</span>
    ${p.photo_status && p.photo_status !== 'none' ? `<span class="cam ${p.photo_status}" title="Photo ${p.photo_status}">📷</span>` : ''}
    ${p.scheduled_time ? `<span class="time">${fmtTime(p.scheduled_time)}</span>` : ''}
    <span class="t">${esc(p.title || '(untitled)')}</span>
    <span class="st s-${p.status}">${STATUS_LABEL[p.status]}</span>
  </button>`;
}

function renderMonth(posts) {
  const [y, m] = state.month.split('-').map(Number);
  const first = iso(y, m, 1);
  const start = addDays(first, -dow(first));
  const total = daysInMonth(y, m);
  const last = iso(y, m, total);
  const end = addDays(last, 6 - dow(last));
  const byDate = new Map();
  for (const p of posts) { if (!byDate.has(p.scheduled_date)) byDate.set(p.scheduled_date, []); byDate.get(p.scheduled_date).push(p); }
  const today = todayISO();
  const mobile = isMobile();
  if (mobile) {
    const sel = state.selectedDay;
    if (!sel || monthOf(sel) !== state.month) {
      const firstWithPosts = posts.map((p) => p.scheduled_date).find((x) => monthOf(x) === state.month);
      state.selectedDay = monthOf(today) === state.month ? today : (firstWithPosts || first);
    }
  }
  let html = '';
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (dow(d) === 0) {
      const names = [...new Set([...state.posts.values()].filter((p) => p.scheduled_date >= d && p.scheduled_date <= addDays(d, 6) && p.series).map((p) => p.series))];
      html += `<div class="week-band" aria-label="Series this week">${names.map((n) => `<span class="series-tag" title="${esc(n)}">${esc(n)}</span>`).join('')}</div>`;
    }
    const inMonth = monthOf(d) === state.month;
    const list = byDate.get(d) || [];
    if (mobile) {
      const dots = list.slice(0, 4).map((p) => `<i class="dot pal-${p.palette}"></i>`).join('') + (list.length > 4 ? `<i class="more">+${list.length - 4}</i>` : '');
      html += `<button type="button" class="day mini${inMonth ? '' : ' other'}${d === today ? ' today' : ''}${d === state.selectedDay ? ' selected' : ''}" data-date="${d}" data-select="${d}" role="gridcell" aria-label="${longDate(d)}, ${list.length} post${list.length === 1 ? '' : 's'}" aria-pressed="${d === state.selectedDay}">
        <span class="dnum">${parts(d).d}</span><span class="dots">${dots}</span>
      </button>`;
      continue;
    }
    html += `<div class="day${inMonth ? '' : ' other'}${d === today ? ' today' : ''}" data-date="${d}" role="gridcell" aria-label="${longDate(d)}, ${list.length} post${list.length === 1 ? '' : 's'}">
      <div class="dnum"><span>${parts(d).d}</span><button type="button" class="add" data-new-date="${d}" aria-label="New post on ${longDate(d)}" title="New post">+</button></div>
      <div class="chips">${inMonth ? list.map(chipHTML).join('') : (list.length ? `<span class="hint" style="font-size:10px">${list.length} post${list.length === 1 ? '' : 's'}</span>` : '')}</div>
    </div>`;
  }
  $('#grid').innerHTML = html;
  renderAgenda(mobile ? (byDate.get(state.selectedDay) || []) : null);
}

function renderAgenda(list) {
  const el = $('#agenda');
  if (list === null) { el.hidden = true; el.innerHTML = ''; return; }
  const d = state.selectedDay; const today = todayISO();
  const series = [...new Set([...state.posts.values()].filter((p) => { const [s, e] = weekRange(d); return p.scheduled_date >= s && p.scheduled_date <= e && p.series; }).map((p) => p.series))];
  el.hidden = false;
  el.innerHTML = `
    <div class="agenda-head">
      <div><strong>${d === today ? 'Today · ' : ''}${longDate(d)}</strong>${series.length ? `<div class="agenda-series">${series.map((s) => `<span class="series-tag">${esc(s)}</span>`).join('')}</div>` : ''}</div>
      <button type="button" class="btn primary small" data-new-date="${d}">+ Post</button>
    </div>
    ${list.length ? list.map((p) => `
      <button type="button" class="agenda-item pal-${p.palette}" data-id="${p.id}">
        <span class="a-top"><span class="time">${p.scheduled_time ? fmtTime(p.scheduled_time) : 'No time'}</span><span class="st s-${p.status}">${STATUS_LABEL[p.status]}</span></span>
        <span class="a-title">${esc(p.title || '(untitled)')}</span>
        <span class="a-meta">${FORMAT_LABEL[p.format]} · ${esc(p.channel)}${p.assignee ? ' · ' + esc(p.assignee) : ''}${p.photo_status && p.photo_status !== 'none' ? ` · 📷 ${esc(PHOTO_LABEL[p.photo_status])}` : ''}</span>
      </button>`).join('') : '<p class="hint agenda-empty">No posts on this day. Tap + Post to add one, or use Move to date inside a post.</p>'}`;
}

const isVideo = (p) => /video|clip|reel|footage/i.test(p.photo_brief || '') || p.format === 'reel';
function shotItems() {
  return [...state.posts.values()]
    .filter((p) => p.photo_status && p.photo_status !== 'none')
    .filter((p) => state.shotsIncludeDelivered || p.photo_status !== 'delivered')
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
}
function renderShots() {
  const items = shotItems();
  const groups = new Map();
  for (const p of items) { const g = p.photo_group || 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  const ordered = [...groups.entries()].sort((a, b) => a[1][0].scheduled_date.localeCompare(b[1][0].scheduled_date));
  const total = items.reduce((n, p) => n + (p.photo_qty || 1), 0);
  const pending = items.filter((p) => p.photo_status !== 'delivered');
  const el = $('#view-shots');
  el.innerHTML = `
    <div class="shots-head">
      <div><h3>Shot list</h3><div class="sub">Grouped by place or subject so several posts can be covered in one trip. Only the photo information is shown.</div></div>
      <div class="shots-actions">
        <label><input type="checkbox" id="shots-delivered" ${state.shotsIncludeDelivered ? 'checked' : ''}> Include delivered</label>
        <button type="button" class="btn ghost small" data-action="shots-copy">Copy as text</button>
        <button type="button" class="btn ghost small" data-action="shots-print">Print / Save PDF</button>
      </div>
    </div>
    <div class="shots-summary">
      <div class="big">${total} shot${total === 1 ? '' : 's'} across ${ordered.length} place${ordered.length === 1 ? '' : 's'}${pending.length !== items.length ? ` · ${pending.reduce((n, p) => n + (p.photo_qty || 1), 0)} still pending` : ''}</div>
      <ul>${ordered.map(([g, list]) => `<li><b>${list.reduce((n, p) => n + (p.photo_qty || 1), 0)}</b> ${esc(g)}</li>`).join('')}</ul>
    </div>
    ${ordered.length ? ordered.map(([g, list]) => `
      <section class="shot-group">
        <header><h4>${esc(g)}</h4><span class="by">first needed ${shortDate(list[0].scheduled_date)}</span><span class="count">${list.reduce((n, p) => n + (p.photo_qty || 1), 0)} shots · ${list.length} post${list.length === 1 ? '' : 's'}</span></header>
        ${list.map((p) => `
          <div class="shot ${p.photo_status}" data-id="${p.id}">
            <span class="qty">${p.photo_qty || 1} × ${isVideo(p) ? '🎬' : '📷'}</span>
            <div><div class="what">${esc(p.photo_brief || 'No brief yet.')}</div>
              <div class="ctx">For: <span class="t">${esc(p.title)}</span> · ${shortDate(p.scheduled_date)} · ${FORMAT_LABEL[p.format]}${p.series ? ' · ' + esc(p.series) : ''}</div></div>
            <label class="done"><input type="checkbox" data-delivered="${p.id}" ${p.photo_status === 'delivered' ? 'checked' : ''}> Delivered</label>
          </div>`).join('')}
      </section>`).join('') : '<p class="hint">No photo requests yet. Set “Photo needed” on a post and give it a place or subject.</p>'}`;
}
function shotsAsText() {
  const items = shotItems(); const groups = new Map();
  for (const p of items) { const g = p.photo_group || 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  const lines = [`ELI CONTENT PLANNER · SHOT LIST (${todayISO()})`, ''];
  lines.push('SUMMARY: ' + [...groups.entries()].map(([g, l]) => `${l.reduce((n, p) => n + (p.photo_qty || 1), 0)} × ${g}`).join(' · '), '');
  for (const [g, list] of groups) {
    lines.push(`== ${g.toUpperCase()} (${list.reduce((n, p) => n + (p.photo_qty || 1), 0)} shots, first needed ${shortDate(list[0].scheduled_date)})`);
    for (const p of list) lines.push(`- ${p.photo_qty || 1} × ${isVideo(p) ? 'video' : 'photo'}: ${p.photo_brief || 'No brief yet.'}  [for: ${p.title}, ${shortDate(p.scheduled_date)}${p.photo_status === 'delivered' ? ', delivered' : ''}]`);
    lines.push('');
  }
  return lines.join('\n');
}
async function setDelivered(id, delivered) {
  const p = state.posts.get(id); if (!p) return;
  markSaving();
  try { const saved = await state.backend.updatePost(id, p.version, { photo_status: delivered ? 'delivered' : 'needed' }); state.posts.set(id, saved); markSaved(); render(); }
  catch (err) { if (err instanceof ConflictError) { state.posts.set(id, err.latest); markSaved(); render(); toast('This post was just changed by someone else. Try again.', { error: true }); } else markError('Could not update: ' + err.message); }
}

function renderList(posts) {
  const el = $('#view-list');
  if (!posts.length) { el.innerHTML = `<p class="hint">${state.posts.size ? (state.listAll ? 'No posts match the current filters.' : 'No posts in ' + monthLabel(state.month) + ' match the current filters. Use the arrows to change month or show all months.') : ''}</p>`; return; }
  const today = todayISO();
  const groups = new Map();
  for (const p of posts) { if (!groups.has(p.scheduled_date)) groups.set(p.scheduled_date, []); groups.get(p.scheduled_date).push(p); }
  el.innerHTML = [...groups.entries()].map(([d, list]) => `
    <section class="list-day">
      <h3 class="${d === today ? 'today' : ''}">${longDate(d)}${d === today ? ' · Today' : ''}</h3>
      ${list.map((p) => `
        <article class="post-row" data-id="${p.id}">
          <div>
            <div class="head">
              <button type="button" class="title" data-open="${p.id}">${esc(p.title || '(untitled)')}</button>
              <span class="st s-${p.status}">${STATUS_LABEL[p.status]}</span>
            </div>
            <div class="tags">
              <span>${esc(p.channel)}</span><span>${FORMAT_LABEL[p.format]}</span>
              ${p.scheduled_time ? `<span>${fmtTime(p.scheduled_time)}</span>` : ''}
              ${p.topic ? `<span>${esc(p.topic)}</span>` : ''}
              ${p.series ? `<span style="color:var(--ncc-red)">${esc(p.series)}</span>` : ''}
              <span class="pal ${p.palette}">${PALETTE_LABEL[p.palette]} emphasis</span>
            </div>
          </div>
          <div class="side">
            <span>${p.assignee ? 'Assigned to <strong>' + esc(p.assignee) + '</strong>' : 'Unassigned'}</span>
            <span class="ready"><span class="${p.ready_3x4 ? 'ok' : 'no'}">${p.ready_3x4 ? '✓' : '○'} 3:4</span> &nbsp; <span class="${p.ready_9x16 ? 'ok' : 'no'}">${p.ready_9x16 ? '✓' : '○'} 9:16 Story</span></span>
          </div>
          ${p.photo_status && p.photo_status !== 'none' ? `<div class="photo ${p.photo_status}"><b>📷 Photo ${esc(PHOTO_LABEL[p.photo_status])}</b>${p.photo_brief ? ' · ' + esc(p.photo_brief) : ''}</div>` : ''}
          <div class="caption${p.caption ? '' : ' empty'}">${p.caption ? esc(p.caption) : 'No caption yet.'}${p.caption ? `<button type="button" class="btn small ghost copy" data-copy="${p.id}">Copy</button>` : ''}</div>
          <div class="meta">Last updated by ${esc(p.updated_by_name || '—')} · ${fmtStamp(p.updated_at)}</div>
        </article>`).join('')}
    </section>`).join('');
}

// ------------------------------------------------------------
// Drag and drop
// ------------------------------------------------------------
let dragId = null;
function bindDnD() {
  const grid = $('#grid');
  grid.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    dragId = chip.dataset.id; chip.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId);
  });
  grid.addEventListener('dragend', () => { dragId = null; $$('.chip.dragging').forEach((c) => c.classList.remove('dragging')); $$('.day.drop-target').forEach((d) => d.classList.remove('drop-target')); });
  grid.addEventListener('dragover', (e) => { const day = e.target.closest('.day'); if (!day || !dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!day.classList.contains('drop-target')) { $$('.day.drop-target').forEach((d) => d.classList.remove('drop-target')); day.classList.add('drop-target'); } });
  grid.addEventListener('dragleave', (e) => { const day = e.target.closest('.day'); if (day && !day.contains(e.relatedTarget)) day.classList.remove('drop-target'); });
  grid.addEventListener('drop', async (e) => {
    const day = e.target.closest('.day'); if (!day) return; e.preventDefault();
    const id = dragId || e.dataTransfer.getData('text/plain'); const date = day.dataset.date;
    $$('.day.drop-target').forEach((d) => d.classList.remove('drop-target'));
    if (id && date) await movePost(id, date);
  });
}

async function movePost(id, newDate, { silent = false } = {}) {
  const p = state.posts.get(id); if (!p || p.scheduled_date === newDate) return;
  const from = p.scheduled_date;
  const optimistic = { ...p, scheduled_date: newDate }; state.posts.set(id, optimistic); render();
  markSaving();
  try {
    const saved = await state.backend.updatePost(id, p.version, { scheduled_date: newDate });
    state.posts.set(id, saved); markSaved(); render();
    if (state.open && state.open.id === id) { state.open.base = saved; if (!state.open.dirty) fillForm(saved); renderMeta(saved); }
    if (!silent) toast(`Moved "${p.title || 'post'}" to ${shortDate(newDate)}.`, { undo: () => movePost(id, from, { silent: true }) });
  } catch (err) {
    state.posts.set(id, p); render();
    if (err instanceof ConflictError) { state.posts.set(id, err.latest); render(); markSaved(); toast(`"${p.title}" was changed by ${err.latest.updated_by_name || 'someone else'} a moment ago. Showing the latest version; try again.`, { error: true }); }
    else if (err instanceof NotFoundError) { state.posts.delete(id); render(); markSaved(); toast('That post no longer exists.', { error: true }); }
    else markError('Could not move the post: ' + err.message);
  }
}

// ------------------------------------------------------------
// Post drawer
// ------------------------------------------------------------
const form = () => $('#post-form');
function readForm() {
  const f = form();
  return {
    title: f.title.value.trim(), scheduled_date: f.scheduled_date.value, scheduled_time: f.scheduled_time.value || null,
    channel: f.channel.value.trim() || 'Instagram', format: f.format.value, status: f.status.value, topic: f.topic.value.trim(),
    assignee: f.assignee.value.trim(), palette: f.palette.value || 'red', ready_3x4: f.ready_3x4.checked, ready_9x16: f.ready_9x16.checked,
    caption: f.caption.value, notes: f.notes.value, asset_links: f.asset_links.value,
    series: f.series.value.trim(), photo_brief: f.photo_brief.value, photo_status: f.photo_status.value || 'none',
    photo_group: f.photo_group.value.trim(), photo_qty: Math.max(0, Math.min(99, parseInt(f.photo_qty.value, 10) || 0)),
  };
}
function fillForm(p) {
  const f = form();
  f.title.value = p.title || ''; f.scheduled_date.value = p.scheduled_date || ''; f.scheduled_time.value = (p.scheduled_time || '').slice(0, 5);
  f.channel.value = p.channel || 'Instagram'; f.format.value = p.format || 'single_image'; f.status.value = p.status || 'idea';
  f.topic.value = p.topic || ''; f.assignee.value = p.assignee || ''; f.palette.value = p.palette || 'red';
  f.ready_3x4.checked = !!p.ready_3x4; f.ready_9x16.checked = !!p.ready_9x16;
  f.caption.value = p.caption || ''; f.notes.value = p.notes || ''; f.asset_links.value = p.asset_links || '';
  f.series.value = p.series || ''; f.photo_brief.value = p.photo_brief || ''; f.photo_status.value = p.photo_status || 'none';
  f.photo_group.value = p.photo_group || ''; f.photo_qty.value = p.photo_qty ?? 1;
  $('#move-date').value = p.scheduled_date || '';
  renderChecks();
}
function renderChecks() {
  const f = form();
  $('#caption-checks').innerHTML = captionChecks(f.caption.value, f.channel.value).map((c) => `<li class="${c.level}">${c.level === 'ok' ? '✓' : c.level === 'warn' ? '⚠' : 'ℹ'} ${esc(c.msg)}</li>`).join('');
}
function renderMeta(p) {
  $('#d-meta').textContent = p.id
    ? `Last updated by ${p.updated_by_name || '—'} · ${fmtStamp(p.updated_at)} · version ${p.version}`
    : 'Not saved yet.';
}
function setDirty(v) { if (state.open) state.open.dirty = v; $('#d-dirty').hidden = !v; }
function showConflict(text, actions) {
  const c = $('#d-conflict'); c.hidden = false; c.innerHTML = `<span>${esc(text)}</span>`;
  actions.forEach((a) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = a.label; b.onclick = a.fn; c.appendChild(b); });
}
function hideConflict() { $('#d-conflict').hidden = true; }

function openPost(id) {
  const p = state.posts.get(id); if (!p) return;
  state.open = { id, base: p, dirty: false };
  $('#drawer-title').textContent = 'Edit post';
  fillForm(p); renderMeta(p); hideConflict(); setDirty(false);
  $('#comments-section').hidden = false;
  $$('#drawer [data-action=duplicate],#drawer [data-action=delete]').forEach((b) => b.hidden = false);
  $('.move-row').hidden = false;
  loadComments(id);
  showDrawer();
}
function newPost(date) {
  const p = { ...defaultPost(), scheduled_date: date || todayISO(), status: 'idea' };
  state.open = { id: null, base: p, dirty: false };
  $('#drawer-title').textContent = 'New post';
  fillForm(p); renderMeta(p); hideConflict(); setDirty(false);
  $('#comments-section').hidden = true; $('#comments').innerHTML = '';
  $$('#drawer [data-action=duplicate],#drawer [data-action=delete]').forEach((b) => b.hidden = true);
  $('.move-row').hidden = true;
  showDrawer();
  form().title.focus();
}
function showDrawer() { $('#drawer').hidden = false; $('#drawer-backdrop').hidden = false; $('.d-body').scrollTop = 0; }
async function closeDrawer(force = false) {
  if (!force && state.open && state.open.dirty) {
    const ok = await confirmDialog({ title: 'Discard changes?', body: 'You have unsaved changes in this post.', okText: 'Discard', danger: true });
    if (!ok) return;
  }
  $('#drawer').hidden = true; $('#drawer-backdrop').hidden = true; state.open = null;
}

async function savePost() {
  if (!state.open) return;
  const data = readForm();
  if (!data.title) { form().title.focus(); toast('Please add a title.', { error: true }); return; }
  if (!data.scheduled_date) { form().scheduled_date.focus(); toast('Please choose a scheduled date.', { error: true }); return; }
  const btn = $('#btn-save'); btn.disabled = true; markSaving();
  try {
    let saved;
    if (state.open.id) saved = await state.backend.updatePost(state.open.id, state.open.base.version, data);
    else saved = await state.backend.insertPost(data);
    state.posts.set(saved.id, saved);
    state.open.id = saved.id; state.open.base = saved; setDirty(false); hideConflict(); renderMeta(saved);
    if ($('#drawer-title').textContent === 'New post') { $('#drawer-title').textContent = 'Edit post'; $('#comments-section').hidden = false; $$('#drawer [data-action=duplicate],#drawer [data-action=delete]').forEach((b) => b.hidden = false); $('.move-row').hidden = false; }
    $('#move-date').value = saved.scheduled_date;
    if (monthOf(saved.scheduled_date) !== state.month && state.view === 'month') state.month = monthOf(saved.scheduled_date);
    markSaved(); render();
  } catch (err) {
    if (err instanceof ConflictError) {
      markSaved();
      const latest = err.latest; state.posts.set(latest.id, latest); render();
      showConflict(`${latest.updated_by_name || 'Someone'} saved a newer version of this post at ${fmtStamp(latest.updated_at)}. Your changes were not saved.`, [
        { label: 'Load their version', fn: () => { fillForm(latest); state.open.base = latest; renderMeta(latest); setDirty(false); hideConflict(); } },
        { label: 'Overwrite with mine', fn: () => { state.open.base = latest; hideConflict(); savePost(); } },
      ]);
    } else if (err instanceof NotFoundError) {
      markSaved(); showConflict('This post was deleted by another team member.', [{ label: 'Close', fn: () => closeDrawer(true) }, { label: 'Save as new post', fn: () => { state.open.id = null; state.open.base = { ...state.open.base, id: undefined, version: 1 }; savePost(); } }]);
    } else markError('Could not save: ' + err.message);
  } finally { btn.disabled = false; }
}

async function deletePost(id) {
  const p = state.posts.get(id); if (!p) return;
  const ok = await confirmDialog({ title: 'Delete this post?', body: `"${p.title}" will be removed for everyone. You can undo this for a few seconds.`, okText: 'Delete', danger: true });
  if (!ok) return;
  const comments = state.comments.get(id) || [];
  markSaving();
  try {
    await state.backend.deletePost(id);
    state.posts.delete(id); markSaved(); render();
    if (state.open && state.open.id === id) closeDrawer(true);
    toast(`Deleted "${p.title}".`, { timeout: 10000, undo: async () => {
      markSaving();
      try {
        const restored = await state.backend.insertPost({ ...p, id: p.id });
        state.posts.set(restored.id, restored);
        if (comments.length) await state.backend.insertCommentsIgnoreDuplicates(comments.map((c) => ({ ...c, post_id: restored.id })));
        markSaved(); render(); toast('Post restored.');
      } catch (e) { markError('Could not restore: ' + e.message); }
    } });
  } catch (err) { markError('Could not delete: ' + err.message); }
}

async function duplicatePost(id) {
  const p = state.posts.get(id); if (!p) return;
  markSaving();
  try {
    const copy = { ...pickPostFields(p), title: p.title + ' (copy)', status: 'draft', import_key: null };
    const saved = await state.backend.insertPost(copy);
    state.posts.set(saved.id, saved); markSaved(); render(); openPost(saved.id); toast('Post duplicated.');
  } catch (err) { markError('Could not duplicate: ' + err.message); }
}

async function loadComments(postId) {
  try {
    const list = await state.backend.listComments(postId);
    state.comments.set(postId, list);
    if (!state.open || state.open.id !== postId) return;
    $('#comments').innerHTML = list.length ? list.map((c) => `<li><div class="who"><span>${esc(c.author_name || '—')} · ${fmtStamp(c.created_at)}</span>${(c.author_id === state.profile.id || state.profile.role === 'owner') ? `<button type="button" data-del-comment="${c.id}" aria-label="Delete comment">×</button>` : ''}</div>${esc(c.body)}</li>`).join('') : '<li class="hint">No comments yet.</li>';
  } catch (e) { $('#comments').innerHTML = `<li class="hint">Could not load comments: ${esc(e.message)}</li>`; }
}
async function addComment() {
  if (!state.open || !state.open.id) return;
  const ta = $('#comment-body'); const body = ta.value.trim(); if (!body) return;
  markSaving();
  try { await state.backend.addComment(state.open.id, body); ta.value = ''; markSaved(); await loadComments(state.open.id); }
  catch (e) { markError('Could not add comment: ' + e.message); }
}

async function copyText(text, label = 'Caption copied.') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(label); } catch { toast('Copy failed. Select the text and copy it manually.', { error: true }); } ta.remove(); }
}

// ------------------------------------------------------------
// Samples, export, import
// ------------------------------------------------------------
function nextMonday(fromISO) { const d = dow(fromISO); return addDays(fromISO, d === 1 ? 7 : (8 - d) % 7 || 7); }
async function loadSamples() {
  const base = nextMonday(todayISO());
  const rows = SAMPLE_POSTS.map((s) => ({ ...defaultPost(), ...s, scheduled_date: addDays(base, s.offset), assignee: '' }));
  markSaving();
  try {
    const inserted = await state.backend.insertPostsIgnoreDuplicates(rows);
    for (const p of inserted) state.posts.set(p.id, p);
    markSaved();
    if (inserted.length && monthOf(inserted[0].scheduled_date) !== state.month) state.month = monthOf(inserted[0].scheduled_date);
    render();
    toast(inserted.length ? `Loaded ${inserted.length} sample draft${inserted.length === 1 ? '' : 's'} starting ${shortDate(base)}.` : 'The sample drafts are already in the calendar.');
  } catch (e) { markError('Could not load samples: ' + e.message); }
}

async function exportJSON() {
  try {
    const comments = await state.backend.listAllComments();
    const payload = { app: 'eli-content-planner', schema: 1, exported_at: new Date().toISOString(), exported_by: state.profile.display_name, posts: [...state.posts.values()], comments };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `eli-content-planner-${todayISO()}.json`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Backup downloaded.');
  } catch (e) { toast('Export failed: ' + e.message, { error: true }); }
}

function normalizeImported(raw) {
  // Accept this app's export, or a plain array of posts (e.g. from the earlier prototype).
  const posts = Array.isArray(raw) ? raw : (raw.posts || raw.items || []);
  const comments = Array.isArray(raw) ? [] : (raw.comments || []);
  const norm = posts.map((p) => {
    const o = { ...defaultPost() };
    o.id = p.id && /^[0-9a-f-]{36}$/i.test(p.id) ? p.id : undefined;
    o.title = p.title || p.name || '';
    o.scheduled_date = (p.scheduled_date || p.date || '').slice(0, 10);
    o.scheduled_time = p.scheduled_time || p.time || null;
    o.channel = p.channel || 'Instagram';
    const fmt = String(p.format || '').toLowerCase().replace(/\s+/g, '_');
    o.format = ['single_image', 'carousel', 'reel', 'story'].includes(fmt) ? fmt : (fmt.includes('carousel') ? 'carousel' : fmt.includes('reel') ? 'reel' : fmt.includes('story') ? 'story' : 'single_image');
    const st = String(p.status || 'draft').toLowerCase().replace(/\s+/g, '_');
    o.status = ['idea', 'draft', 'in_review', 'approved', 'scheduled', 'published'].includes(st) ? st : 'draft';
    o.topic = p.topic || p.pillar || '';
    o.assignee = p.assignee || p.owner || '';
    const pal = String(p.palette || 'red').toLowerCase();
    o.palette = ['red', 'black', 'white'].includes(pal) ? pal : 'red';
    o.ready_3x4 = !!(p.ready_3x4 ?? p.ready34 ?? (p.checklist && p.checklist['3:4']));
    o.ready_9x16 = !!(p.ready_9x16 ?? p.ready916 ?? (p.checklist && p.checklist['9:16']));
    o.caption = p.caption || p.final_caption || '';
    o.notes = p.notes || p.creative_notes || '';
    o.asset_links = Array.isArray(p.asset_links) ? p.asset_links.join('\n') : (p.asset_links || p.assets || '');
    o.import_key = p.import_key || null;
    o.series = p.series || '';
    o.photo_brief = p.photo_brief || '';
    o.photo_status = ['none', 'needed', 'requested', 'delivered'].includes(p.photo_status) ? p.photo_status : 'none';
    o.photo_group = p.photo_group || '';
    o.photo_qty = Number.isFinite(+p.photo_qty) ? Math.max(0, Math.min(99, +p.photo_qty)) : 1;
    o.version = p.version;
    return o;
  }).filter((p) => p.title || p.caption);
  return { posts: norm, comments };
}
function samePost(a, b) { return ['title', 'scheduled_date', 'scheduled_time', 'channel', 'format', 'status', 'topic', 'assignee', 'palette', 'ready_3x4', 'ready_9x16', 'caption', 'notes', 'asset_links', 'series', 'photo_brief', 'photo_status', 'photo_group', 'photo_qty'].every((k) => (a[k] ?? null) === (b[k] ?? null) || (k === 'scheduled_time' && (a[k] || '').slice(0, 5) === (b[k] || '').slice(0, 5))); }

async function importJSON(file) {
  let raw;
  try { raw = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.', { error: true }); return; }
  const { posts, comments } = normalizeImported(raw);
  if (!posts.length) { toast('No posts found in that file.', { error: true }); return; }
  const existing = [...state.posts.values()];
  const plan = posts.map((p) => {
    if (!p.scheduled_date) return { p, action: 'skip', why: 'missing date' };
    let match = p.id && state.posts.get(p.id);
    if (!match && p.import_key) match = existing.find((e) => e.import_key === p.import_key);
    if (!match) match = existing.find((e) => e.title === p.title && e.scheduled_date === p.scheduled_date);
    if (!match) return { p, action: 'new' };
    if (samePost(match, p)) return { p, action: 'skip', why: 'identical', match };
    return { p, action: 'update', match };
  });
  const counts = { new: 0, update: 0, skip: 0 }; plan.forEach((x) => counts[x.action]++);
  const m = modal(`<h3>Import preview</h3>
    <p>${counts.new} new · ${counts.update} to update · ${counts.skip} skipped (identical or invalid). Nothing has been changed yet.</p>
    <div style="max-height:45vh;overflow:auto"><table><thead><tr><th>Action</th><th>Date</th><th>Title</th><th>Note</th></tr></thead><tbody>
    ${plan.map((x) => `<tr><td class="tag-${x.action}">${x.action.toUpperCase()}</td><td>${esc(x.p.scheduled_date || '—')}</td><td>${esc(x.p.title)}</td><td class="hint">${x.why ? esc(x.why) : x.match ? 'matches existing post' : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <label class="check" style="display:flex;gap:6px;align-items:center;font-size:14px"><input type="checkbox" id="imp-updates" checked> Apply updates to existing posts (${counts.update})</label>
    <div class="actions"><button type="button" class="btn ghost" data-r="0">Cancel</button><button type="button" class="btn primary" data-r="1" ${counts.new + counts.update ? '' : 'disabled'}>Import</button></div>`);
  m.querySelector('[data-r="0"]').onclick = closeModal;
  m.querySelector('[data-r="1"]').onclick = async () => {
    const applyUpdates = m.querySelector('#imp-updates').checked; closeModal(); markSaving();
    let ok = 0, failed = 0;
    try {
      const news = plan.filter((x) => x.action === 'new').map((x) => x.p);
      const idMap = new Map();
      if (news.length) {
        const inserted = await state.backend.insertPostsIgnoreDuplicates(news);
        inserted.forEach((r) => { state.posts.set(r.id, r); ok++; });
      }
      if (applyUpdates) for (const x of plan.filter((y) => y.action === 'update')) {
        try { const r = await state.backend.updatePost(x.match.id, x.match.version, pickPostFields(x.p)); state.posts.set(r.id, r); ok++; idMap.set(x.p.id, r.id); }
        catch { failed++; }
      }
      if (comments.length) {
        const valid = comments.filter((c) => c.post_id && state.posts.has(c.post_id) && c.body);
        if (valid.length) await state.backend.insertCommentsIgnoreDuplicates(valid);
      }
      markSaved(); render();
      toast(`Imported ${ok} post${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed (changed by someone else meanwhile)` : ''}.`);
    } catch (e) { markError('Import failed: ' + e.message); }
  };
}

// ------------------------------------------------------------
// Members & invitations (owner)
// ------------------------------------------------------------
async function openAdmin() {
  if (state.profile.role !== 'owner') return;
  let members, invitations;
  try { [members, invitations] = await Promise.all([state.backend.listMembers(), state.backend.listInvitations()]); }
  catch (e) { toast('Could not load members: ' + e.message, { error: true }); return; }
  const memberEmails = new Set(members.map((m) => m.email.toLowerCase()));
  const pending = invitations.filter((i) => !memberEmails.has(i.email.toLowerCase()));
  const m = modal(`<h3>Members &amp; invitations</h3>
    <p class="hint">Only invited email addresses can create an account. Editors can create, edit, move and delete posts. Owners can also manage members.</p>
    <table><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>
    ${members.map((x) => `<tr><td><strong>${esc(x.display_name)}</strong><br><span class="hint">${esc(x.email)}</span></td>
      <td><select data-role="${x.id}" ${x.id === state.profile.id ? 'disabled' : ''}><option value="editor" ${x.role === 'editor' ? 'selected' : ''}>Editor</option><option value="owner" ${x.role === 'owner' ? 'selected' : ''}>Owner</option></select></td>
      <td>${x.id === state.profile.id ? '<span class="hint">you</span>' : `<button type="button" class="btn danger small" data-remove="${x.id}" data-email="${esc(x.email)}">Remove</button>`}</td></tr>`).join('')}
    </tbody></table>
    <h3 style="font-size:14px">Pending invitations</h3>
    <table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
    ${pending.length ? pending.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.role)}</td><td><button type="button" class="btn ghost small" data-revoke="${esc(i.email)}">Revoke</button></td></tr>`).join('') : '<tr><td colspan="3" class="hint">No pending invitations.</td></tr>'}
    </tbody></table>
    <form id="inv-form" class="row"><label>Invite by email <input type="email" name="email" required placeholder="colleague@noctrl.edu"></label><label>Role <select name="role"><option value="editor">Editor</option><option value="owner">Owner</option></select></label><button type="submit" class="btn primary small">Add invitation</button></form>
    <p class="hint" style="margin-top:8px">After adding an email, tell your colleague to open <strong>${esc(location.origin + location.pathname)}</strong>, choose <em>Create account</em> and use that exact email.</p>
    <p class="err" id="inv-err"></p>
    <div class="actions"><button type="button" class="btn ghost" data-r="0">Close</button></div>`);
  m.querySelector('[data-r="0"]').onclick = closeModal;
  m.querySelector('#inv-form').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await state.backend.addInvitation(f.email.value, f.role.value); toast(`Invitation added for ${f.email.value.trim()}.`); openAdmin(); }
    catch (err) { m.querySelector('#inv-err').textContent = err.message; }
  };
  m.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { try { await state.backend.removeInvitation(b.dataset.revoke); openAdmin(); } catch (err) { m.querySelector('#inv-err').textContent = err.message; } });
  m.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
    closeModal();
    const ok = await confirmDialog({ title: 'Remove member?', body: `${b.dataset.email} will immediately lose access to the calendar.`, okText: 'Remove', danger: true });
    if (ok) { try { await state.backend.removeMember(b.dataset.remove, b.dataset.email); toast('Member removed.'); } catch (err) { toast(err.message, { error: true }); } }
    openAdmin();
  });
  m.querySelectorAll('[data-role]').forEach((s) => s.onchange = async () => { try { await state.backend.setMemberRole(s.dataset.role, s.value); toast('Role updated.'); } catch (err) { m.querySelector('#inv-err').textContent = err.message; } });
}

// ------------------------------------------------------------
// Event wiring
// ------------------------------------------------------------
function bindApp() {
  $$('.seg').forEach((b) => b.onclick = () => { state.view = b.dataset.view; render(); });
  $('#prev').onclick = () => { state.month = shiftMonth(state.month, -1); render(); };
  $('#next').onclick = () => { state.month = shiftMonth(state.month, 1); render(); };
  $('#today').onclick = () => { state.month = monthOf(todayISO()); state.selectedDay = todayISO(); render(); };
  $('#btn-filters').onclick = () => { const f = $('#filters'); f.classList.toggle('open'); $('#btn-filters').setAttribute('aria-expanded', String(f.classList.contains('open'))); };
  $('#list-scope').onchange = (e) => { state.listAll = e.target.value === 'all'; render(); };
  $('#btn-new').onclick = () => newPost();
  $('#empty [data-action=new]').onclick = () => newPost();
  $('#empty [data-action=samples]').onclick = loadSamples;

  const f = state.filters;
  $('#f-q').oninput = (e) => { f.q = e.target.value; render(); };
  for (const k of ['channel', 'format', 'status', 'topic', 'assignee', 'series']) $('#f-' + k).onchange = (e) => { f[k] = e.target.value; render(); };
  $('#f-clear').onclick = () => { Object.keys(f).forEach((k) => f[k] = ''); $('#f-q').value = ''; state.quick = ''; render(); };
  $$('.qf').forEach((b) => b.onclick = () => { state.quick = b.dataset.quick; if (state.quick === 'week') state.month = monthOf(todayISO()); render(); });

  // guidelines
  $('#btn-guidelines').onclick = () => { const g = $('#guidelines'); g.hidden = !g.hidden; $('#btn-guidelines').setAttribute('aria-expanded', String(!g.hidden)); };
  $('#guidelines [data-action=close-guidelines]').onclick = () => { $('#guidelines').hidden = true; $('#btn-guidelines').setAttribute('aria-expanded', 'false'); };

  // menu
  $('#btn-menu').onclick = (e) => { e.stopPropagation(); const m = $('#menu'); m.hidden = !m.hidden; $('#btn-menu').setAttribute('aria-expanded', String(!m.hidden)); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('#menu').hidden = true; });
  $('#menu').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return; $('#menu').hidden = true;
    if (b.classList.contains('owner-only') && state.profile.role !== 'owner') return;
    switch (b.dataset.action) {
      case 'rename': { const v = await promptDialog({ title: 'Change my name', label: 'This name is shown to your colleagues.', value: state.profile.display_name }); if (v) { try { await state.backend.updateDisplayName(v); state.profile.display_name = v; $('#me-name').textContent = v; $('#me-name2').textContent = v; toast('Name updated.'); } catch (err) { toast(err.message, { error: true }); } } break; }
      case 'admin': openAdmin(); break;
      case 'export': exportJSON(); break;
      case 'import': $('#import-file').click(); break;
      case 'samples': loadSamples(); break;
      case 'signout': await state.backend.signOut(); state.posts.clear(); showAuth('signin', 'You have signed out.'); break;
    }
  };
  $('#import-file').onchange = (e) => { const file = e.target.files[0]; e.target.value = ''; if (file) importJSON(file); };

  // grid / list clicks
  $('#grid').addEventListener('click', (e) => {
    const add = e.target.closest('[data-new-date]'); if (add) { newPost(add.dataset.newDate); return; }
    const chip = e.target.closest('.chip'); if (chip) { openPost(chip.dataset.id); return; }
    const sel = e.target.closest('[data-select]'); if (sel) { state.selectedDay = sel.dataset.select; if (monthOf(state.selectedDay) !== state.month) state.month = monthOf(state.selectedDay); render(); }
  });
  $('#view-shots').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && b.dataset.action === 'shots-copy') { copyText(shotsAsText(), 'Shot list copied. Paste it in an email or a note.'); return; }
    if (b && b.dataset.action === 'shots-print') { window.print(); return; }
    const t = e.target.closest('.shot .ctx .t'); if (t) openPost(t.closest('.shot').dataset.id);
  });
  $('#view-shots').addEventListener('change', (e) => {
    if (e.target.id === 'shots-delivered') { state.shotsIncludeDelivered = e.target.checked; render(); return; }
    const cb = e.target.closest('[data-delivered]'); if (cb) setDelivered(cb.dataset.delivered, cb.checked);
  });
  $('#agenda').addEventListener('click', (e) => {
    const add = e.target.closest('[data-new-date]'); if (add) { newPost(add.dataset.newDate); return; }
    const item = e.target.closest('.agenda-item'); if (item) openPost(item.dataset.id);
  });
  window.matchMedia('(max-width: 720px)').addEventListener('change', () => render());
  $('#grid').addEventListener('dblclick', (e) => { const day = e.target.closest('.day'); if (day && !e.target.closest('.chip')) newPost(day.dataset.date); });
  $('#view-list').addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]'); if (c) { copyText(state.posts.get(c.dataset.copy).caption); return; }
    const o = e.target.closest('[data-open]'); if (o) openPost(o.dataset.open);
  });
  bindDnD();

  // drawer
  const pf = form();
  const isPostField = (e) => !e.target.closest('.move-row, .comments');
  pf.addEventListener('input', (e) => { if (!isPostField(e)) return; setDirty(true); renderChecks(); });
  pf.addEventListener('change', (e) => { if (isPostField(e)) setDirty(true); });
  pf.onsubmit = (e) => { e.preventDefault(); savePost(); };
  $('#drawer').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    switch (b.dataset.action) {
      case 'close': closeDrawer(); break;
      case 'copy-caption': copyText(pf.caption.value); break;
      case 'duplicate': if (state.open && state.open.id) duplicatePost(state.open.id); break;
      case 'delete': if (state.open && state.open.id) deletePost(state.open.id); break;
      case 'add-comment': addComment(); break;
      case 'move': {
        const d = $('#move-date').value; if (!d || !state.open || !state.open.id) return;
        if (state.open.dirty) { pf.scheduled_date.value = d; toast('Date updated in the form. Click Save to apply.'); return; }
        await movePost(state.open.id, d); pf.scheduled_date.value = d; break;
      }
    }
  });
  $('#comments').addEventListener('click', async (e) => { const b = e.target.closest('[data-del-comment]'); if (!b) return; try { await state.backend.deleteComment(b.dataset.delComment); loadComments(state.open.id); } catch (err) { toast(err.message, { error: true }); } });
  $('#drawer-backdrop').onclick = () => closeDrawer();
  $('#modal-backdrop').onclick = closeModal;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else if (!$('#drawer').hidden) closeDrawer(); else if (!$('#menu').hidden) $('#menu').hidden = true; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !$('#drawer').hidden) { e.preventDefault(); savePost(); }
  });
  window.addEventListener('beforeunload', (e) => { if (state.open && state.open.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('online', () => { if ($('#save-status').dataset.state === 'offline') setSaveStatus('idle', 'Back online'); loadAll(); });
  window.addEventListener('offline', () => setSaveStatus('offline', 'Offline: changes cannot be saved'));
  $('#save-status').onclick = () => { if ($('#save-status').dataset.state === 'error' && state.open) savePost(); };
}

// ------------------------------------------------------------
async function main() {
  bindAuth(); bindApp();
  const mock = CONFIG.MOCK || new URLSearchParams(location.search).get('mock') === '1';
  if (!mock && (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR-PROJECT-REF'))) {
    showAuth('signin', 'This planner is not connected to a database yet. Fill in calendar/config.js with the Supabase project URL and publishable key.', 'error');
    $$('.auth-form button').forEach((b) => b.disabled = true);
    return;
  }
  state.backend = createBackend(CONFIG);
  try { await state.backend.init(); }
  catch (e) { showAuth('signin', 'Could not load the database client: ' + e.message, 'error'); return; }
  if (mock) document.title = 'ELI Content Planner (demo mode)';
  state.backend.onAuthChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') { showAuth('newpass'); return; }
    if (event === 'SIGNED_IN' && session && $('#app').hidden) await enterApp();
    if (event === 'SIGNED_OUT') { state.posts.clear(); if (!$('#app').hidden) showAuth('signin'); }
  });
  const session = await state.backend.getSession();
  if (session) await enterApp(); else showAuth('signin');
}
main();
