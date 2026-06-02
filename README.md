# MediQueue Next

**Smart Chamber Management & Healthcare Queue Platform**  
Bangladesh-specific clinic (chamber) queue management PWA.

🌐 **Live:** https://zakir-rana.github.io/mediqueue-next/  
📦 **Repo:** https://github.com/zakir-rana/mediqueue-next

---

## Features

- Multi-doctor queue management with token allocation
- Reserved slot system (every Nth token for privileged patients)
- Role-based access: superadmin, doctor, senior_assistant, assistant, desk, viewer
- Real-time multi-device sync via Supabase (3.5s polling)
- Bengali/English UI with Kalpurush font
- TV display mode with Bengali TTS announcements
- Billing: bKash, Nagad, Cash, Card
- PWA: installable, works offline after first load
- CSV export, audit log, schedule management

---

## File Structure

```
mediqueue-next/
├── index.html           # App shell — all UI markup
├── app.js               # All queue logic, roles, Supabase sync, SW registration
├── styles.css           # Dark theme, Bengali font stack, mobile CSS
├── service-worker.js    # PWA offline cache (v3.1 — fixed offline behaviour)
├── manifest.json        # PWA manifest
├── supabase-config.js   # Supabase URL + anon key (public, safe to expose)
├── firebase-config.js   # Firebase abstraction layer (disabled; Supabase active)
├── offline.html         # Fallback page — shown ONLY if app shell is not cached
├── icons/
│   ├── icon-72.png
│   ├── icon-96.png
│   ├── icon-128.png
│   ├── icon-144.png
│   ├── icon-152.png
│   ├── icon-192.png
│   ├── icon-256.png
│   ├── icon-384.png
│   └── icon-512.png
└── screenshots/
    ├── desktop.png      # 1280×720 (for PWA install dialog)
    └── mobile.png       # 390×844
```

---

## Offline Behaviour (v3.1 Fix)

| Condition | Result |
|---|---|
| Online | Normal app, Supabase sync active |
| Offline, app previously loaded | **Normal app from cache** — login, queue, reports all visible |
| Offline, app NEVER loaded (no cache) | `offline.html` fallback shown |

### Root Cause of Previous Bug (v3.0)

Service worker pre-cached assets using **relative paths** (e.g. `'./index.html'`).  
Fetch events arrive with **full URLs** (e.g. `https://zakir-rana.github.io/mediqueue-next/index.html`).  
`caches.match()` compared full URL vs relative key → **always missed** → fell through to `offline.html`.

### Fix Applied (v3.1)

- All `STATIC_ASSETS` now resolved to full URLs at SW install time using `_BASE` (derived from `self.location.href`).
- `networkFirstWithFallback()` has a 3-tier fallback: exact URL → `index.html` → `offline.html`.
- `offline.html` is only served when the app shell is confirmed absent from cache.

---

## Deployment

### GitHub Pages (automatic via push to `main`)

```bash
git add .
git commit -m "deploy: v3.1 offline fix"
git push origin main
```

Pages serves from repo root. All paths are relative (`./app.js`, `./styles.css`, etc).

### After deploying a new service-worker.js

1. Open the app in Chrome/Firefox.
2. Open DevTools → Application → Service Workers.
3. Click **Update** or **skipWaiting** to activate the new SW immediately.
4. Or: hard refresh (Ctrl+Shift+R / Cmd+Shift+R).
5. The in-app "🔄 New version available" banner will also appear and can be used to update.

### Clear stale cache (if needed)

Open DevTools → Application → Storage → **Clear site data**.  
Or send `postMessage({ type: 'CLEAR_CACHE' })` to the SW from the console.

---

## Backend

**Supabase** (Singapore region, free tier)

- Project: `fmnhutxxxasgulwzohto`
- Tables: `sessions`, `audit_logs`
- Auth: Row Level Security (RLS) policies

### Required Supabase table schemas

```sql
-- sessions
create table sessions (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  doctor_id text,
  patients jsonb default '[]',
  next_token int default 1,
  doctor_status text default 'arriving',
  consult_ts jsonb default '{}',
  ref_meta jsonb default '[]',
  updated_at timestamptz default now(),
  unique(day, doctor_id)
);

-- audit_logs
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  day date,
  type text, icon text, action text,
  detail text, by text, reason text,
  time text, ts bigint
);
```

---

## Default Credentials

| Role | Username | PIN |
|---|---|---|
| Super Admin | admin | 9999 |
| Doctor | dr_bose | 1234 |
| Senior Assistant | jogesh | 0000 |
| Assistant | shahin | 1111 |
| Desk | desk1 | 5678 |

---

## Migrating to Firebase (future)

1. Fill `FIREBASE_CONFIG` in `firebase-config.js`
2. Set `FIREBASE_ENABLED = true`
3. Add Firebase SDK `<script>` tags in `index.html` (see comments)
4. Remove the Supabase `<script>` tag
5. All `StorageAdapter.*` calls route to Firebase automatically
