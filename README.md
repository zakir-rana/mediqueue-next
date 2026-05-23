# MediQueue Next v3.0 — Enterprise Chamber Queue Management

Bangladesh chamber queue management system — patient token allocation, billing, TV display, analytics. Built as a production-grade installable PWA.

**Live:** https://zakir-rana.github.io/mediqueue-next/

---

## Features

- **Queue Management** — Token allocation, priority triage (Emergency / Doc Ref / Follow-up / Regular), wait time estimates
- **Reserved Slots** — Doctor/Admin-only slots at configurable intervals (every 5th/10th/15th)
- **Billing System** — Per-patient fee, payment status (Paid/Unpaid/Partial/Waived), bKash/Nagad/Card support
- **TV Display** — Full-screen public queue display with Bengali ticker and real-time status
- **Bengali Announcement** — Audio TTS token announcement (bn-BD voice)
- **Multi-Doctor** — Switch between doctors; per-doctor isolated queues and session data
- **Role System** — Super Admin / Doctor / Senior Assistant / Assistant / Desk / Viewer
- **Patient References** — Upload PDF/JPG/PNG documents per patient (prescription, lab, scan, ECG)
- **Analytics & Reports** — Staff performance, billing summary, registration channel breakdown
- **Recall Patient** — Re-add completed/no-show patients to active queue
- **Export** — CSV, Excel, mobile follow-up list, clipboard copy
- **Offline Mode** — Full offline capability via Service Worker + localStorage mirror
- **Cross-tab Sync** — localStorage storage event + Supabase polling (3.5s interval)
- **PWA Install** — Android Chrome install prompt, iOS Add to Home Screen, desktop installable

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS (ES6+), no frameworks |
| Styles | CSS custom properties, responsive grid |
| Backend | Supabase (Postgres + Realtime-ish polling) |
| Offline | Service Worker + localStorage |
| Future backend | Firebase Realtime DB (prepared, not yet active) |
| Hosting | GitHub Pages |
| Fonts | DM Sans, DM Mono, Kalpurush (Bengali) |

---

## File Structure

```
mediqueue-next/
├── index.html          — App shell HTML (no inline JS/CSS)
├── styles.css          — All CSS extracted from original
├── app.js              — All JS: Supabase, queue engine, UI render
├── service-worker.js   — PWA SW: versioned cache, offline, update strategy
├── manifest.json       — PWA manifest: GitHub Pages paths, shortcuts
├── firebase-config.js  — Firebase preparation + abstract StorageAdapter
├── offline.html        — Offline fallback page (served by SW)
├── generate-icons.html — Browser tool to generate PNG icons
├── icons/
│   ├── icon-72.png     — Required: generate via generate-icons.html
│   ├── icon-96.png
│   ├── icon-128.png
│   ├── icon-144.png
│   ├── icon-152.png
│   ├── icon-192.png
│   ├── icon-384.png
│   └── icon-512.png
├── screenshots/
│   ├── desktop.png     — Optional: for richer install UX
│   └── mobile.png
├── README.md
└── .gitignore
```

---

## Setup & Deploy

### 1. Generate Icons

Open `generate-icons.html` in Chrome, download all 8 PNG files, place them in `icons/`.

### 2. Create Screenshots (optional but improves install UX)

Take screenshots of the app at 1280×720 (desktop) and 390×844 (mobile), save to `screenshots/`.

### 3. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "MediQueue Next v3.0"
git remote add origin https://github.com/zakir-rana/mediqueue-next.git
git push -u origin main
```

Enable GitHub Pages → Settings → Pages → Source: `main` branch, root folder.

App will be live at: `https://zakir-rana.github.io/mediqueue-next/`

---

## Supabase Database Schema

```sql
-- Sessions table (one row per doctor per day)
CREATE TABLE sessions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  day         TEXT NOT NULL,        -- YYYYMMDD format
  doctor_id   TEXT,                 -- matches doctorStore[].id
  patients    JSONB DEFAULT '[]',
  next_token  INTEGER DEFAULT 1,
  doctor_status TEXT DEFAULT 'arriving',
  consult_ts  JSONB DEFAULT '{}',
  ref_meta    JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(day, doctor_id)
);

-- Audit logs table
CREATE TABLE audit_logs (
  id      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  day     TEXT NOT NULL,
  type    TEXT,
  icon    TEXT,
  action  TEXT,
  detail  TEXT,
  by      TEXT,
  reason  TEXT DEFAULT '',
  time    TEXT,
  ts      BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Row-Level Security (recommended for production)
ALTER TABLE sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Allow anon key full access (current setup — tighten for production)
CREATE POLICY "Allow all" ON sessions   FOR ALL USING (true);
CREATE POLICY "Allow all" ON audit_logs FOR ALL USING (true);
```

---

## Default Login Credentials

| Username | PIN | Role |
|----------|-----|------|
| admin | 9999 | Super Admin |
| dr_bose | 1234 | Doctor |
| jogesh | 0000 | Assistant |
| shahin | 1111 | Assistant |
| desk1 | 5678 | Desk |

⚠️ Change all PINs immediately after first login via the Users tab.

---

## PWA Installation

### Android (Chrome)
1. Open `https://zakir-rana.github.io/mediqueue-next/` in Chrome
2. Tap the "⊕ Install App" banner or Menu → "Add to Home screen"
3. App installs as standalone (no browser chrome)

### iOS (Safari)
1. Open in Safari
2. Tap Share → "Add to Home Screen"
3. Name it "MediQueue Next" → Add

### Desktop (Chrome / Edge)
1. Visit the URL
2. Click the install icon (⊕) in the address bar

---

## Firebase Migration Guide

When ready to migrate from Supabase to Firebase:

1. Create Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Realtime Database** (or Firestore — update `firebase-config.js` accordingly)
3. Enable **Anonymous Auth** for offline-safe sessions
4. Fill in `FIREBASE_CONFIG` in `firebase-config.js`
5. Set `FIREBASE_ENABLED = true` in `firebase-config.js`
6. Uncomment the Firebase SDK `<script>` tags in `index.html`
7. Disable or remove the Supabase `<script>` tag in `index.html`
8. All `StorageAdapter.*` calls in `app.js` route to Firebase automatically

---

## Performance Notes

- **No React / Vue / Angular** — stays lightweight, fast first paint
- **Service Worker** caches app shell on install; subsequent loads are instant offline
- **Polling interval** 3.5s; write debounce 600ms; poll backs off 4s after local write
- **Dynamic cache** capped at 60 entries; trimmed on each new entry
- **localStorage** used only for user/doctor/schedule config and offline session mirror; never for large blobs
- **File uploads** (patient references) stored in memory only; not persisted to localStorage or Supabase (by design, keep session-scoped)

---

## Known Issues & Limitations

| Issue | Status |
|-------|--------|
| Duplicate `id="priority-reason-group"` in `renderEntry()` HTML output | Low impact (only one is visible at a time); fix: rename one ID |
| Patient reference file data (base64) not persisted to Supabase | By design; add a Supabase Storage bucket for persistence |
| `doctor-switcher-chip` always shows even for single doctor | Minor cosmetic; condition is `accessible.length > 1 ? 'flex' : 'flex'` — fix to `!== 'none'` |
| iOS Safari TTS (Bengali) not available | Platform limitation; silent fallback already in place |

---

## Changelog

### v3.0 (2026-05)
- Extracted inline CSS → `styles.css`
- Extracted inline JS → `app.js`
- Added production Service Worker with versioned cache, stale cleanup, `skipWaiting()`
- Fixed GitHub Pages manifest path (`./` relative, not `/`)
- Fixed SW scope for GitHub Pages subdirectory
- Added PWA install prompt handler + update banner
- Added `firebase-config.js` with `StorageAdapter` abstract layer
- Added `LocalStore` centralised localStorage wrapper
- Added `offline.html` PWA fallback page
- All `///` CSS comments removed (invalid syntax fixed)
- `applySwUpdate()` + `triggerPWAInstall()` exposed globally

### v18 → v3.0 Fixes
- `[F1]` Schema v2 migration with `applySessionData()` deduplication
- `[F2]` Per-doctor localStorage keys prevent cross-doctor offline collision
- `[F3]` `renderedReservedTokens` Set prevents cross-section reserved slot duplication
- `[F4]` `_lastWriteAt` poll guard prevents race condition overwrite
- `[F5]` `sessionCache` now keyed `dayKey__doctorId` to prevent cross-doctor session collision
- `[F6]` Doctor entity upgraded with `nameBn`, `nameEn`, `room`, `prescriptionSoftwareUrl`
- `[F7]` TV display Bengali announcement uses `makeBanglaAnnouncement()` properly
- `[F8]` Mobile export / WhatsApp / Excel export functions
- `[F9]` Performance analytics use `registeredByName` (Schema v2) with `addedBy` fallback
- `[F10]` Billing system with `pay-paid`/`pay-unpaid`/`pay-partial` badges
- `[F11]` Calling banner + Bengali TTS announcement system
- `[F12]` Doctor registry CRUD in Settings tab
- `[F13]` Recall patient feature
- `[F14]` Queue search bar
