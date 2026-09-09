// ============================================================
// ELI Content Planner — configuration
// Fill in the two Supabase values from:
//   Supabase dashboard → Project Settings → API
// The publishable (anon) key is safe to ship in the browser:
// every table is protected by Row Level Security.
// ============================================================
export const CONFIG = {
  SUPABASE_URL: 'https://qjvesvlavainehkuijai.supabase.co',
  SUPABASE_KEY: 'sb_publishable_ZnD4aNUjQxN_4uE1dYZykg_WyHCMoB-',

  // Workspace identity
  APP_NAME: 'ELI Content Planner',
  ORG_NAME: 'English Language Institute · North Central College',
  CORE_MESSAGE: 'Improve your English. Build your future.',
  TIME_ZONE: 'America/Chicago',

  // Shown at the bottom of the Brand & content rules panel.
  BRAND_ASSETS_NOTE:
    'Palette, typography and logo rules come from the official NCC Graphic Identity & Messaging Guidelines (2026) ' +
    'and the logo files supplied by the ELI team. The International logo (for recruiting materials) is not in the ' +
    'assets folder yet; request it from oic@noctrl.edu.',

  // Dropdown options (editable). Free-text values typed into posts are added automatically.
  CHANNELS: ['Instagram', 'Instagram Story', 'Facebook', 'LinkedIn', 'YouTube', 'Website', 'Email'],
  TOPICS: [
    'Admissions & Onboarding',
    'Student Success',
    'Motivation',
    'Campus Life',
    'Programs & Academics',
    'Humor & Culture',
    'Community & Alumni',
  ],

  // Suggested places / subjects for grouping photo requests in the Shot list
  PHOTO_GROUPS: ['ELI office', 'ELI team', 'Instructors & classrooms', 'Students', 'Campus', 'Downtown Naperville', 'Homecoming', 'Chippy'],

  // Local demo mode: in-browser fake backend (no Supabase). Also enabled with ?mock=1
  MOCK: false,
};
