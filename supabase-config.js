// ══════════════════════════════════════════════════════
// MediQueue Next — Supabase Configuration
// Repo: zakir-rana/mediqueue-next
//
// This file is loaded BEFORE app.js in index.html.
// app.js reads SUPABASE_URL and SUPABASE_ANON_KEY as globals.
//
// NOTE: SUPABASE_ANON_KEY is the public anon key — safe to
// expose in client code. Row Level Security (RLS) policies
// on supabase.co enforce data access control.
// ══════════════════════════════════════════════════════

const SUPABASE_URL      = 'https://fmnhutxxxasgulwzohto.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZtbmh1dHh4eGFzZ3Vsd3pvaHRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMjM5ODQsImV4cCI6MjA5NDY5OTk4NH0.WhrtSCr77lxiC5x8wfWCQlkOTy7SlAv1zN906UzHM0o';

// Supabase client — available globally as window._supa
// app.js uses _supa directly (defined in its own SUPABASE CONFIG section).
// This file ensures the constants are available even if app.js is refactored
// to read them from here in future.
window.SUPABASE_URL      = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
