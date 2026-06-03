// ══════════════════════════════════════════════════════
// MediQueue Next — app.js v3.0
// Production build — all logic extracted from index.html
// GitHub Pages: https://zakir-rana.github.io/mediqueue-next/
//
// BUGS FIXED vs v18:
//  [F1]  Duplicate event listeners: removed — render() is called centrally, no addEventListener loops
//  [F2]  Reserved slot render duplication: renderedReservedTokens Set prevents cross-section duplication
//  [F3]  Cross-doctor session pollution: per-doctor localStorage keys + sessionCache isolation
//  [F4]  Race condition on addPatient: nextToken stamped and synced before DB write
//  [F5]  Poll overwriting local state: _lastWriteAt guard (4s debounce after local write)
//  [F6]  priority-reason-group duplicate ID: note left in renderEntry
//  [F7]  getAccessibleDoctors used before doctorStore load: ensured loadDoctors() called first
//  [F8]  Token availability check in isTokenAvailable fixed to respect filled reserved patients
//  [F9]  Service worker registration: moved to DOMContentLoaded + correct GitHub Pages path
//  [F10] PWA update: skipWaiting postMessage now fires on SW update found
//  [F11] localStorage quota guard: saveOfflineSession wrapped in try/catch already (kept)
//  [F12] Cross-tab storage: event listener already fires soft render (kept)
//  [F13] Memory leak: _tvClockInterval and _tvAutoRefresh cleared on tab switch (kept)
//  [F14] SUPABASE_ANON_KEY is public anon key — safe to expose (by design)
// ══════════════════════════════════════════════════════

'use strict';


// ═══════════════════════════════════════════════════
// SUPABASE CONFIG
// ═══════════════════════════════════════════════════
const SUPABASE_URL      = 'https://gkzorxvdzpuvoawlliqt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdrem9yeHZkenB1dm9hd2xsaXF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzM4MTUsImV4cCI6MjA5NTA0OTgxNX0.U3Env20-xZ8ra7b7tf-xqAnp4zRowdEaCHVxydUcfrQ';0.WhrtSCr77lxiC5x8wfWCQlkOTy7SlAv1zN906UzHM0o';
const _supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function dayKey(dateStr) {
  // Returns YYYY-MM-DD for Supabase date column compatibility
  return dateStr ? dateStr : todayISO();
}
function dayKeyInt(dateStr) {
  // Returns YYYYMMDD integer-style string — for localStorage keys only
  return (dateStr || todayISO()).replace(/-/g,'');
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addDays(isoStr, n) {
  const d = new Date(isoStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function formatDisplayDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return { day: days[d.getDay()], date: d.getDate(), month: months[d.getMonth()], full: iso };
}

function setSyncBadge(state, msg) {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  if (state === 'ok')  { el.textContent = '🟢 Synced'; el.className = 'sync-badge sync-ok'; }
  else if (state === 'err') { el.textContent = '🔴 ' + (msg||'Offline'); el.className = 'sync-badge sync-err'; }
  else { el.textContent = '🟡 ' + (msg||'Syncing'); el.className = 'sync-badge sync-wait'; }
}

/// UPDATED SECTION — sessionCache now keyed by date+doctorId to prevent cross-doctor session collision (Fix #1 root cause)
const sessionCache = {}; // "dayKey__doctorId" -> {id}
const SESSION_KEYS = ['patients','next_token','doctor_status','consult_ts','ref_meta','doctor_id'];

function _sessionCacheKey(isoDate, doctorId) {
  return dayKey(isoDate) + '__' + (doctorId || 'null');
}

async function getOrCreateSession(isoDate, doctorId) {
  const dk  = dayKey(isoDate);    // YYYY-MM-DD  (Supabase date/text ISO)
  const dki = dayKeyInt(isoDate); // YYYYMMDD    (legacy integer-style fallback)
  const ck  = _sessionCacheKey(isoDate, doctorId);
  if (sessionCache[ck]?.id) return sessionCache[ck].id;

  // Try ISO format first (correct for date column type)
  let query = _supa.from('sessions').select('id').eq('day', dk);
  if (doctorId) query = query.eq('doctor_id', doctorId);
  else query = query.is('doctor_id', null);
  let { data, error } = await query.maybeSingle();

  // Fallback: try integer format (in case column is text and old data used YYYYMMDD)
  if (!data && error) {
    let query2 = _supa.from('sessions').select('id').eq('day', dki);
    if (doctorId) query2 = query2.eq('doctor_id', doctorId);
    else query2 = query2.is('doctor_id', null);
    const res2 = await query2.maybeSingle();
    data = res2.data;
    error = res2.error;
  }

  if (data) { sessionCache[ck] = { id: data.id }; return data.id; }

  // Create — use ISO format for new rows
  const ins = await _supa.from('sessions').insert({
    day: dk, doctor_id: doctorId || null,
    patients: [], next_token: 1,
    doctor_status: 'arriving', consult_ts: {}, ref_meta: [],
  }).select('id').single();
  if (ins.data) { sessionCache[ck] = { id: ins.data.id }; return ins.data.id; }
  return null;
}

/// UPDATED SECTION — supaLoadSession (stub removed; full offline-capable version defined below at session init section)

let _wt = null;
function scheduleWrite(isoDate, doctorId, stateObj) {
  clearTimeout(_wt);
  _wt = setTimeout(() => doWrite(isoDate, doctorId, stateObj), 600);
}
async function doWrite(isoDate, doctorId, stateObj) {
  try {
    const sid = await getOrCreateSession(isoDate, doctorId);
    if (!sid) return;
    const { error } = await _supa.from('sessions').update(stateObj).eq('id', sid);
    if (error) { setSyncBadge('err', 'Write failed'); }
    else {
      setSyncBadge('ok');
      /// UPDATED SECTION — After confirmed write, reset _lastSnap so next poll re-reads fresh committed state
      _lastSnap = null;
    }
  } catch(e) { setSyncBadge('err', 'Offline'); }
}

async function supaLogAudit(entry) {
  try {
    await _supa.from('audit_logs').insert({
      day: dayKey(entry.isoDate || todayISO()),
      type: entry.type, icon: entry.icon, action: entry.action,
      detail: entry.detail, by: entry.by, reason: entry.reason || '',
      time: entry.time, ts: entry._ts,
    });
  } catch(e) {}
}

async function supaLoadAudit(isoDate) {
  try {
    const { data } = await _supa.from('audit_logs')
      .select('*').eq('day', dayKey(isoDate)).order('ts', { ascending: false });
    return (data || []).map(r => ({ type:r.type,icon:r.icon,action:r.action,detail:r.detail,by:r.by,reason:r.reason,time:r.time,_ts:r.ts }));
  } catch(e) { return []; }
}

// Polling
let _pollTimer = null;
let _lastSnap = null;
/// UPDATED SECTION — _lastWriteAt: tracks when syncState() last wrote, poll skips applySessionData for 4s after a write to prevent race condition (poll overwriting locally-added patients before DB commit)
let _lastWriteAt = 0;

function startPolling(isoDate, doctorId, onUpdate) {
  stopPolling();
  _pollTimer = setInterval(async () => {
    try {
      const sid = await getOrCreateSession(isoDate, doctorId);
      if (!sid) return;
      const { data, error } = await _supa.from('sessions').select('*').eq('id', sid).single();
      if (error || !data) return;
      const snap = JSON.stringify(data);
      if (snap === _lastSnap) return;
      // UPDATED SECTION — Skip poll update if a local write happened in the last 4s (write debounce is 600ms + network latency)
      if (Date.now() - _lastWriteAt < 4000) return;
      _lastSnap = snap;
      onUpdate(data);
      setSyncBadge('ok');
    } catch(e) { setSyncBadge('err', 'Offline'); }
  }, 3500);
}
function stopPolling() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }



// ═══════════════════════════════════════════════════
// ROLE SYSTEM
// ═══════════════════════════════════════════════════
const ROLE_META = {
  superadmin:       { label: 'Super Admin',       icon: '👑', tabs: ['queue','entry','doctor','refs','display','users','schedule','audit','reports','settings'], canConsult: true, canComplete: true, canDoctorStatus: true, canEditSchedule: true, canManageUsers: true },
  doctor:           { label: 'Doctor',            icon: '🩺', tabs: ['queue','doctor','refs','display','reports'],                                                canConsult: true, canComplete: true, canDoctorStatus: true, canEditSchedule: true, canManageUsers: false },
  senior_assistant: { label: 'Senior Assistant',  icon: '💼', tabs: ['queue','entry','refs','display','reports'],                                                 canConsult: false, canComplete: false, canDoctorStatus: false, canEditSchedule: false, canManageUsers: false },
  assistant:        { label: 'Assistant',         icon: '👤', tabs: ['queue','entry','refs','display'],                                                            canConsult: false, canComplete: false, canDoctorStatus: false, canEditSchedule: false, canManageUsers: false },
  desk:             { label: 'Desk',              icon: '🖥️', tabs: ['queue','entry','display','reports'],                                                         canConsult: false, canComplete: false, canDoctorStatus: false, canEditSchedule: false, canManageUsers: false },
  viewer:           { label: 'Viewer',            icon: '👁️', tabs: ['queue','display'],                                                                           canConsult: false, canComplete: false, canDoctorStatus: false, canEditSchedule: false, canManageUsers: false },
};

function canDo(action) {
  if (!currentUser) return false;
  const rm = ROLE_META[currentUser.role];
  if (!rm) return false;
  return rm[action] === true || rm['can'+action.charAt(0).toUpperCase()+action.slice(1)] === true;
}
function hasTab(tab) {
  if (!currentUser) return false;
  return ROLE_META[currentUser.role]?.tabs.includes(tab);
}

// ═══════════════════════════════════════════════════
// USER STORE — seeded defaults, persisted via localStorage
// ═══════════════════════════════════════════════════
const DEFAULT_USERS = [
  { id: 'u1', username: 'admin',   name: 'Super Admin',   role: 'superadmin', pin: '9999', active: true, notes: 'System Administrator', assignedDoctorId: null },
  { id: 'u2', username: 'dr_bose', name: 'Dr. B. K. Bose',role: 'doctor',     pin: '1234', active: true, notes: 'MBBS, MCPS · MD Chest Medicine', assignedDoctorId: 'd1' },
  { id: 'u3', username: 'jogesh',  name: 'Jogesh',        role: 'assistant',  pin: '0000', active: true, notes: 'Morning shift assistant', assignedDoctorId: 'd1' },
  { id: 'u4', username: 'shahin',  name: 'Shahin',        role: 'assistant',  pin: '1111', active: true, notes: 'Evening shift assistant', assignedDoctorId: 'd1' },
  { id: 'u5', username: 'desk1',   name: 'Desk Officer',  role: 'desk',       pin: '5678', active: true, notes: 'Front desk · Billing', assignedDoctorId: null },
];

/// UPDATED SECTION — Extended DEFAULT_DOCTORS with full enterprise doctor entity schema
const DEFAULT_DOCTORS = [
  {
    id: 'd1', name: 'Dr. B. K. Bose',
    nameBn: 'ডাঃ. বি. কে. বোস', nameEn: 'Dr. B. K. Bose',
    qualifications: 'MBBS, MCPS · MD Chest Medicine · IAEA Fellow',
    specialty: 'Chest Medicine', room: 'Room 1',
    chamberName: 'Dr. B. K. Bose Chamber', chamberNumber: '101',
    consultationFee: 500, dailyLimit: 50, avgConsultTime: 8,
    prescriptionSoftwareUrl: 'https://digitalrxpro.com',
    status: 'available', active: true
  },
];

function loadUsers() {
  try { const s = localStorage.getItem('mq_users_v1'); return s ? JSON.parse(s) : [...DEFAULT_USERS]; }
  catch(e) { return [...DEFAULT_USERS]; }
}
function saveUsers(arr) { localStorage.setItem('mq_users_v1', JSON.stringify(arr)); }

function loadDoctors() {
  try { const s = localStorage.getItem('mq_doctors_v1'); return s ? JSON.parse(s) : [...DEFAULT_DOCTORS]; }
  catch(e) { return [...DEFAULT_DOCTORS]; }
}
function saveDoctors(arr) { localStorage.setItem('mq_doctors_v1', JSON.stringify(arr)); }

// Day schedule config: { doctorId_YYYYMMDD: { maxPatients, reservedInterval } }
function loadScheduleConf() {
  try { const s = localStorage.getItem('mq_schedule_v1'); return s ? JSON.parse(s) : {}; }
  catch(e) { return {}; }
}
function saveScheduleConf(obj) { localStorage.setItem('mq_schedule_v1', JSON.stringify(obj)); }

let userStore   = loadUsers();
let doctorStore = loadDoctors();
let scheduleConf = loadScheduleConf();

function getScheduleKey(doctorId, isoDate) {
  return `${doctorId}_${dayKeyInt(isoDate)}`;
}
function getSchedule(doctorId, isoDate) {
  const k = getScheduleKey(doctorId, isoDate);
  return scheduleConf[k] || { maxPatients: 50, reservedInterval: 5 };
}

// ═══════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════
let currentUser = null;
let currentDoctor = null; // { id, name, ... }
let currentDate = todayISO();
let currentTab = 'queue';
let doctorStatus = 'arriving';
let selectedPriority = 'regular';
let selectedSource = '';
let completedCollapsed = true;
let skipTargetToken = null;
let editingUserId = null;
let _refPatientToken = null;
let _pendingFile = null;

let patients   = [];
let auditLog   = [];
let nextToken  = 1;
let consultStartTimestamps = {};
let consultDurations = [];
let patientReferences = [];

let _tvClockInterval = null;
let _tvAutoRefresh = null;

const doctorStatuses = {
  arriving:  { label: 'Arriving Soon',  cls: 'ds-arriving',  tv: 'amber' },
  inchamber: { label: 'In Chamber',     cls: 'ds-inchamber', tv: 'green' },
  delayed:   { label: 'Delayed',        cls: 'ds-delayed',   tv: 'red'   },
  closed:    { label: 'Chamber Closed', cls: 'ds-closed',    tv: 'gray'  },
  break:     { label: 'Short Break',    cls: 'ds-break',     tv: 'pink'  },
};

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════
function nowTime() { return new Date().toLocaleTimeString('en-BD', { hour: '2-digit', minute: '2-digit' }); }
function getActorName() { return currentUser ? currentUser.name : 'System'; }
function isDoctorPresent() { return doctorStatus === 'inchamber'; }
function uid() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function getAvgConsultDuration() {
  if (consultDurations.length === 0) return 8;
  return Math.round(consultDurations.reduce((a,b) => a+b, 0) / consultDurations.length);
}
function formatDuration(ms) {
  if (!ms) return '0:00';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}
function getLiveConsultDuration(token) {
  if (!consultStartTimestamps[token]) return null;
  return Date.now() - consultStartTimestamps[token];
}

// ═══════════════════════════════════════════════════
// QUEUE ALLOCATION ENGINE v2 — Non-blocking reserved slots
// ═══════════════════════════════════════════════════

// Reserved slot store: { tokenNum: { reservedBy, reservedAt, label, expiresAt|null } }
// Persisted per doctor+date in localStorage.
const _reservedSlotPrefix = 'mq_reserved_v1__';

function _reservedKey(doctorId, isoDate) {
  return _reservedSlotPrefix + (doctorId||'null') + '__' + (isoDate||'');
}
function loadReservedSlots() {
  try {
    const raw = localStorage.getItem(_reservedKey(currentDoctor?.id, currentDate));
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}
function saveReservedSlots(obj) {
  try {
    localStorage.setItem(_reservedKey(currentDoctor?.id, currentDate), JSON.stringify(obj));
  } catch(e) {}
}

// Live in-memory store (refreshed on load/doctor-switch)
let _reservedSlots = {};

function _syncReservedSlots() {
  _reservedSlots = loadReservedSlots();
  // Purge expired
  const now = Date.now();
  let dirty = false;
  Object.keys(_reservedSlots).forEach(k => {
    const s = _reservedSlots[k];
    if (s.expiresAt && now > s.expiresAt) { delete _reservedSlots[k]; dirty = true; }
  });
  if (dirty) saveReservedSlots(_reservedSlots);
}

/**
 * isReservedSlot — returns true if tokenNum is a schedule-defined reserved interval slot
 * AND has not already been filled by an actual patient.
 */
function isReservedSlot(tokenNum) {
  const sch = getSchedule(currentDoctor?.id || 'd1', currentDate);
  if (!sch.reservedInterval || sch.reservedInterval <= 0) return false;
  if (tokenNum % sch.reservedInterval !== 0) return false;
  // If a real patient already occupies this token, it's no longer "reserved"
  if (patients.find(p => p.token === tokenNum)) return false;
  return true;
}

function canFillReserved() {
  return currentUser && ['superadmin','doctor'].includes(currentUser.role);
}

// Alias used by the engine below
function canAutoFillReservedSlot() { return canFillReserved(); }

/**
 * reserveSlot — explicitly mark a slot as reserved (with optional expiry)
 * @param {number} tokenNum
 * @param {string} reservedBy
 * @param {number|null} durationMinutes  null = never expires
 * @param {string} label  human label e.g. "VIP Patient"
 */
function reserveSlot(tokenNum, reservedBy, durationMinutes, label) {
  _syncReservedSlots();
  _reservedSlots[String(tokenNum)] = {
    reservedBy: reservedBy || getActorName(),
    reservedAt: nowTime(),
    label: label || 'Reserved',
    expiresAt: durationMinutes ? Date.now() + durationMinutes * 60000 : null,
  };
  saveReservedSlots(_reservedSlots);
  logAction('modify','⭐','Slot reserved',`Token #${tokenNum} reserved by ${reservedBy||getActorName()} — ${label||''}`);
}

/**
 * fillReservedSlot — convert a reserved slot into an active patient registration.
 * Preserves the exact token number.
 */
function fillReservedSlot(tokenNum, patientData) {
  _syncReservedSlots();
  delete _reservedSlots[String(tokenNum)];
  saveReservedSlots(_reservedSlots);
  // patientData is merged into the standard patient object by addPatient()
}

/**
 * releaseReservedSlot — Doctor/Admin can release a reserved slot so normal
 * registration can flow through it.
 */
function releaseReservedSlot(tokenNum) {
  _syncReservedSlots();
  delete _reservedSlots[String(tokenNum)];
  saveReservedSlots(_reservedSlots);
  logAction('modify','🔓','Reserved slot released',`Token #${tokenNum} released — now open for regular registration.`);
  showToast(`✓ Slot #${tokenNum} released — queue unblocked`,'success');
  syncState(); render();
}

/**
 * getNextAvailableToken — CORE ENGINE FUNCTION
 *
 * Returns the next token number that:
 *  1. Is not already used by any patient in the queue
 *  2. Is not a schedule-reserved slot the current user cannot fill
 *  3. Is sequential with no gaps where avoidable
 *
 * For non-privileged users (assistants, desk):
 *   — Reserved slot tokens are SKIPPED transparently.
 *   — The patient gets the next non-reserved token.
 *   — Reserved tokens remain available for Doctor/Admin to fill later.
 *
 * For Doctor/Admin:
 *   — Reserved slots are offered first (they get priority fill).
 *   — If they want to skip one, use releaseReservedSlot().
 */
function getNextAvailableToken() {
  const usedTokens = new Set(patients.map(p => p.token));
  let candidate = nextToken;

  // Safety ceiling: never infinite-loop
  const ceiling = candidate + 500;
  while (candidate < ceiling) {
    if (usedTokens.has(candidate)) { candidate++; continue; }
    if (isReservedSlot(candidate) && !canAutoFillReservedSlot()) {
      // Non-privileged: skip this reserved slot silently
      candidate++; continue;
    }
    return candidate;
  }
  return candidate; // fallback (shouldn't happen in practice)
}

/**
 * getUsableTokens — returns `count` sequential usable token numbers starting
 * from the current nextToken position, respecting the same skip rules.
 */
function getUsableTokens(count) {
  const usedTokens = new Set(patients.map(p => p.token));
  const result = [];
  let candidate = nextToken;
  const ceiling = candidate + 1000;
  while (result.length < count && candidate < ceiling) {
    if (usedTokens.has(candidate)) { candidate++; continue; }
    if (isReservedSlot(candidate) && !canAutoFillReservedSlot()) { candidate++; continue; }
    result.push(candidate);
    candidate++;
  }
  return result;
}

// ── END QUEUE ALLOCATION ENGINE ──

/**
 * _fillReservedNow — called by Doctor/Admin "Fill #N" button in Entry tab banner.
 * Temporarily forces nextToken to the reserved slot, then switches to Entry tab
 * so the doctor can complete registration with that token pre-selected.
 */
function _fillReservedNow(tokenNum) {
  if (!canFillReserved()) {
    showToast('⛔ Only Doctor or Admin can fill reserved slots.', 'error');
    return;
  }
  openFillReservedModal(tokenNum);
}

let _fillReservedTokenNum = null;

function openFillReservedModal(tokenNum) {
  if (!canFillReserved()) {
    showToast('⛔ Only Doctor or Admin can fill reserved slots.', 'error');
    return;
  }
  _fillReservedTokenNum = tokenNum;
  document.getElementById('fill-token-num').textContent = tokenNum;
  document.getElementById('fill-name').value    = '';
  document.getElementById('fill-phone').value   = '';
  document.getElementById('fill-age').value     = '';
  document.getElementById('fill-gender').value  = 'M';
  document.getElementById('fill-priority').value = 'regular';
  document.getElementById('fill-notes').value   = '';
  openModal('modal-fill-reserved');
}

function confirmFillReservedSlot() {
  const tokenNum  = _fillReservedTokenNum;
  if (!tokenNum) return;
  const name   = document.getElementById('fill-name')?.value?.trim();
  const phone  = document.getElementById('fill-phone')?.value?.trim();
  const age    = document.getElementById('fill-age')?.value || '?';
  const gender = document.getElementById('fill-gender')?.value || 'M';
  const prio   = document.getElementById('fill-priority')?.value || 'regular';
  const notes  = document.getElementById('fill-notes')?.value?.trim() || '';
  if (!name)  { alert('Patient name required'); return; }
  if (!phone) { alert('Phone number required'); return; }

  // Check token is still available (not grabbed by another session)
  const alreadyFilled = patients.find(p => p.token === tokenNum && !['completed','noshow','cancelled'].includes(p.status));
  if (alreadyFilled) {
    showToast(`❌ Slot #${tokenNum} already filled by ${alreadyFilled.name}`, 'error');
    closeModal('modal-fill-reserved');
    render();
    return;
  }

  const np = {
    token: tokenNum,
    name, phone, age: parseInt(age)||0, gender,
    type: prio,
    status: 'waiting',
    source: 'reserved_fill',
    registrationSource: 'desk',
    addedBy: currentUser?.name || getActorName(),
    registeredBy: currentUser?.username || currentUser?.name || 'system',
    registeredByName: currentUser?.name || getActorName(),
    registeredByRole: currentUser?.role || 'unknown',
    slotType: 'doctor_priority',
    isReservedSlot: true,
    reservedBy: currentUser?.username || null,
    reservedUntil: null,
    addedAt: nowTime(),
    addedAtISO: new Date().toISOString(),
    notes,
    fee: 0, paid: 0, payStatus: 'unpaid', payMethod: 'Cash',
    arrived_at: null, called_at: null,
    consultation_started_at: null, consultation_ended_at: null, completed_at: null,
    assignedDoctorId: currentDoctor?.id || null,
    _schemaVersion: 2,
  };

  // Ensure nextToken advances past this reserved slot
  nextToken = Math.max(nextToken, tokenNum + 1);
  patients.push(np);
  patients.sort((a,b) => a.token - b.token);

  logAction('add','⭐','Reserved slot filled',`${name} registered into reserved slot #${tokenNum}.`);
  syncState();
  updateNavBadges();
  closeModal('modal-fill-reserved');
  _fillReservedTokenNum = null;
  showToast(`✅ ${name} — Token #${tokenNum} (Reserved Slot)`, 'success');
  if (['queue','doctor','display'].includes(currentTab)) render();
}

function getMaxPatients(doctorId, isoDate) {
  return getSchedule(doctorId || 'd1', isoDate).maxPatients || 50;
}
/// UPDATED SECTION — getActiveCount: excludes unfilled reserved placeholders and assignedDoctorId guard
function getActiveCount(arr) {
  const src = arr || patients;
  const did = currentDoctor?.id;
  return src.filter(p =>
    !['completed','noshow','cancelled'].includes(p.status) &&
    !p.isReservedSlot &&
    (!p.assignedDoctorId || !did || p.assignedDoctorId === did)
  ).length;
}
function getTotalRegisteredForDate(doctorId, isoDate) {
  // Just use current patients if same date, else 0 (Supabase holds the truth)
  if (isoDate === currentDate) return patients.length;
  return 0; // Will be loaded from DB for future dates
}

function getPriorityInfo(type) {
  return { regular: {cls:'tk-regular',label:'Regular'}, emergency: {cls:'tk-emergency',label:'Emergency'}, docref: {cls:'tk-docref',label:'Doc Ref'}, followup: {cls:'tk-followup',label:'Follow-up'} }[type] || {cls:'tk-regular',label:'Regular'};
}
function getBigTokenCls(type) { return {emergency:'bt-emg',docref:'bt-ref',followup:'bt-fup'}[type]||''; }
function getStatusChip(s) {
  return ({ waiting:'<span class="chip ch-waiting">Waiting</span>', arrived:'<span class="chip ch-arrived">✓ Arrived</span>', called:'<span class="chip ch-called">📣 Called</span>', incons:'<span class="chip ch-incons">🏥 In Consultation</span>', completed:'<span class="chip ch-completed">✔ Completed</span>', noshow:'<span class="chip ch-noshow">✗ No Show</span>', cancelled:'<span class="chip ch-cancelled">Cancelled</span>' })[s] || `<span class="chip ch-waiting">${s}</span>`;
}
function getSourceTag(src, addedBy) {
  const displayName = addedBy || src;
  const cls = src === 'direct' ? 'tg-direct' : src === 'docref' ? 'tg-docref' : 'tg-user';
  return `<span class="tag ${cls}">${displayName}</span>`;
}
function getRoleBadgeCls(role) { return 'rb-' + (role || 'assistant'); }
function getRoleAvatarCls(role) { return 'ua-' + (role || 'assistant'); }
function getRoleIcon(role) { return {superadmin:'👑',doctor:'🩺',senior_assistant:'💼',assistant:'👤',desk:'🖥️',viewer:'👁️'}[role]||'👤'; }

function logAction(type, icon, action, detail, by, reason, isoDate) {
  const entry = { type, icon, action, detail, by: by||getActorName(), reason: reason||'', time: nowTime(), _ts: Date.now(), isoDate: isoDate||currentDate };
  auditLog.unshift(entry);
  const b = document.getElementById('nb-audit'); if(b) b.textContent = auditLog.length;
  if (window.fbLogAction) window.fbLogAction(entry);
}

function updateNavBadges() {
  const active = getActiveCount();
  const qb = document.getElementById('nb-queue'); if(qb) qb.textContent = active;
  const rb = document.getElementById('nb-refs'); if(rb) rb.textContent = patientReferences.length;
  // UPDATED SECTION — Mobile nav badge update
  const mbnBadge = document.getElementById('mbn-badge-queue');
  if (mbnBadge) { mbnBadge.textContent = active; mbnBadge.style.display = active > 0 ? '' : 'none'; }
}

function showToast(msg, type='info') {
  const colors = { success: 'var(--green)', info: 'var(--accent)', warning: 'var(--amber)', error: 'var(--red)' };
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:${colors[type]};color:#fff;padding:10px 20px;border-radius:var(--radius);font-size:13px;font-weight:700;z-index:3000;box-shadow:var(--shadow-lg);max-width:90vw;text-align:center;transition:opacity 0.3s;white-space:nowrap;font-family:var(--font)`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),300); }, 3500);
}

function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

// ═══════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// AUTH — 2-STEP LOGIN
// ═══════════════════════════════════════════════════
function clearLoginErr() {
  document.getElementById('login-error').classList.remove('show');
  const e2 = document.getElementById('login-error-step2');
  if (e2) e2.classList.remove('show');
}

let _pendingLoginUser = null; // user object after step 1 validated
let _selectedLoginDoctorId = null;

function doLoginStep1() {
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const pin      = document.getElementById('login-pin-inp').value;
  if (!username || !pin) {
    document.getElementById('login-error').textContent = '❌ Username এবং PIN দিন।';
    document.getElementById('login-error').classList.add('show'); return;
  }
  userStore   = loadUsers();
  doctorStore = loadDoctors();
  const user  = userStore.find(u => u.username.toLowerCase() === username && u.pin === pin && u.active);
  if (!user) {
    document.getElementById('login-error').textContent = '❌ ভুল Username বা PIN।';
    document.getElementById('login-error').classList.add('show');
    document.getElementById('login-pin-inp').value = ''; return;
  }
  _pendingLoginUser = user;
  _selectedLoginDoctorId = null;

  // Determine which doctors this user can access
  const accessibleDoctors = getAccessibleDoctors(user);

  if (accessibleDoctors.length === 1) {
    // Only one doctor → skip step 2, go straight in
    _selectedLoginDoctorId = accessibleDoctors[0].id;
    finalizeLogin();
  } else {
    // Multiple doctors → show step 2 selector
    showDoctorSelectStep(user, accessibleDoctors);
  }
}

/// UPDATED SECTION — getAccessibleDoctors: proper role-based filtering
// Super Admin → all doctors
// Doctor → self only (own assignedDoctorId)
// Reception/assistant/senior_assistant with assignedDoctorId → only that doctor
// desk/viewer with no assignment → all doctors
function getAccessibleDoctors(user) {
  doctorStore = loadDoctors(); // always fresh
  const allActive = doctorStore.filter(d => d.active);

  // Super Admin: see ALL doctors
  if (user.role === 'superadmin') return allActive;

  // Doctor role: only their own assigned doctor (self)
  if (user.role === 'doctor') {
    const mine = allActive.find(d => d.id === user.assignedDoctorId);
    return mine ? [mine] : (allActive.length > 0 ? [allActive[0]] : []);
  }

  // Reception / assistant / senior_assistant with specific assigned doctor
  if (user.assignedDoctorId) {
    const mine = allActive.find(d => d.id === user.assignedDoctorId);
    return mine ? [mine] : allActive; // fallback: all if assigned doctor not found/inactive
  }

  // desk / viewer / any role with no assignment: all active doctors
  return allActive;
}

/// UPDATED SECTION — showDoctorSelectStep: proper nameBn/nameEn/room display in login doctor grid
function showDoctorSelectStep(user, doctors) {
  document.getElementById('login-step-1').style.display = 'none';
  document.getElementById('login-step-2').style.display = 'block';
  document.getElementById('login-step2-user').textContent = user.name;
  const rm = ROLE_META[user.role];
  document.getElementById('login-step2-role').textContent = (rm?.icon||'') + ' ' + (rm?.label||user.role);

  const grid = document.getElementById('doctor-select-grid');
  grid.innerHTML = doctors.map(d => {
    const bn   = d.nameBn || d.name;
    const en   = d.nameEn || d.name;
    const room = d.room   || '';
    return `
    <div class="doctor-btn ${_selectedLoginDoctorId===d.id?'sel':''}" id="docbtn-${d.id}" onclick="selectLoginDoctor('${d.id}')">
      <span class="db-icon">🩺</span>
      <span class="db-name">${bn}</span>
      <span class="db-qual">${en}${room ? '<br>' + room : ''}</span>
    </div>`;
  }).join('');
}

function selectLoginDoctor(id) {
  _selectedLoginDoctorId = id;
  document.querySelectorAll('.doctor-btn').forEach(b => b.classList.remove('sel'));
  const btn = document.getElementById('docbtn-' + id);
  if (btn) btn.classList.add('sel');
  document.getElementById('login-error-step2').classList.remove('show');
}

function doLoginStep2() {
  if (!_selectedLoginDoctorId) {
    document.getElementById('login-error-step2').classList.add('show'); return;
  }
  finalizeLogin();
}

function backToStep1() {
  document.getElementById('login-step-1').style.display = 'block';
  document.getElementById('login-step-2').style.display = 'none';
  _pendingLoginUser = null; _selectedLoginDoctorId = null;
}

function finalizeLogin() {
  const user = _pendingLoginUser;
  currentUser   = user;
  currentDoctor = doctorStore.find(d => d.id === _selectedLoginDoctorId) || doctorStore[0];
  _pendingLoginUser = null; _selectedLoginDoctorId = null;

  document.getElementById('login-wrap').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  // Reset login form for next time
  document.getElementById('login-step-1').style.display = 'block';
  document.getElementById('login-step-2').style.display = 'none';

  // Topbar
  const rm = ROLE_META[user.role];
  document.getElementById('user-chip-name').textContent = user.name;
  const badge = document.getElementById('header-role-badge');
  badge.textContent = (rm.icon + ' ' + rm.label);
  badge.className = 'role-badge ' + getRoleBadgeCls(user.role);

  updateDoctorChip();
  applyNavVisibility();
  // Doctor switcher — only show if user can access multiple doctors
  const accessible = getAccessibleDoctors(user);
  document.getElementById('doctor-switcher-chip').style.display = accessible.length > 1 ? 'flex' : 'flex'; // always show

  // UPDATED SECTION — Show mobile bottom nav, hide/show items by role
  const mbnNav = document.getElementById('mobile-bottom-nav');
  if (mbnNav) mbnNav.style.display = 'flex';
  // Hide mobile nav items not accessible to this role
  [['mbn-entry','entry'],['mbn-doctor','doctor'],['mbn-reports','reports']].forEach(([id, tabName]) => {
    const el = document.getElementById(id)?.closest('.mbn-item-wrap');
    if (el) el.style.display = hasTab(tabName) ? '' : 'none';
  });

  logAction('login','🔑','User logged in',`${user.name} (${user.role}) → ${currentDoctor.name}`,user.name,'',currentDate);
  currentDate   = todayISO();
  selectedSource = user.username;
  initSession();
}

function updateDoctorChip() {
  const el = document.getElementById('current-doctor-name');
  if (el && currentDoctor) el.textContent = currentDoctor.name.replace('Dr. ','Dr. ').split(' ').slice(0,3).join(' ');
  if (currentDoctor) {
    document.getElementById('tb-title').textContent = currentDoctor.name + ' — Chamber';
    document.getElementById('tb-sub').textContent   = currentDoctor.qualifications;
  }
}

/// UPDATED SECTION — openDoctorSwitcher: removed broken single-doctor toast, proper nameBn/nameEn/room display
function openDoctorSwitcher() {
  if (!currentUser) return;
  doctorStore = loadDoctors(); // always fresh
  const accessible = getAccessibleDoctors(currentUser);
  if (accessible.length === 0) { showToast('কোনো Active Doctor পাওয়া যায়নি।','info'); return; }
  const grid = document.getElementById('doctor-switch-grid');
  grid.innerHTML = accessible.map(d => {
    const bn   = d.nameBn || d.name;
    const en   = d.nameEn || d.name;
    const room = d.room   || '';
    return `
    <div class="doctor-btn ${currentDoctor?.id===d.id?'sel':''}" onclick="switchDoctor('${d.id}')">
      <span class="db-icon">🩺</span>
      <span class="db-name">${bn}</span>
      <span class="db-qual">${en}${room ? '<br>' + room : ''}</span>
    </div>`;
  }).join('');
  openModal('modal-doctor-switch');
}

/// UPDATED SECTION — Doctor-wise doctorStatus per doctor (Fix #1 — each doctor has own status)
const _doctorStatusMap = {}; // { doctorId: 'arriving' | 'inchamber' | ... }

function getDoctorStatus(doctorId) {
  return _doctorStatusMap[doctorId] || doctorStatus;
}
function setDoctorStatusForId(doctorId, status) {
  _doctorStatusMap[doctorId] = status;
  if (currentDoctor?.id === doctorId) {
    doctorStatus = status;
  }
}

/// UPDATED SECTION — switchDoctor: full reload of queue, dashboard, TV, waiting count (Fix #1)
async function switchDoctor(doctorId) {
  if (currentDoctor?.id === doctorId) { closeModal('modal-doctor-switch'); return; }
  stopPolling();
  // Save current doctor's status
  if (currentDoctor?.id) _doctorStatusMap[currentDoctor.id] = doctorStatus;
  /// UPDATED SECTION — Flush sessionCache for old doctor so stale session ID doesn't bleed into new doctor (Fix #5)
  if (currentDoctor?.id) {
    const oldCk = _sessionCacheKey(currentDate, currentDoctor.id);
    delete sessionCache[oldCk];
  }
  // Clear current queue state — must be fully isolated per doctor
  patients = []; nextToken = 1; consultStartTimestamps = {}; patientReferences = [];
  currentDoctor = doctorStore.find(d => d.id === doctorId);
  currentDate   = todayISO();
  // Restore this doctor's status if previously set
  doctorStatus  = _doctorStatusMap[doctorId] || 'arriving';
  updateDoctorChip();
  // Update doctor status chip in topbar
  const ds = doctorStatuses[doctorStatus] || doctorStatuses.arriving;
  const chip = document.getElementById('doc-status-chip');
  const txt  = document.getElementById('doc-status-text');
  if (chip) chip.className = 'doc-status-chip ' + ds.cls;
  if (txt)  txt.textContent = ds.label;
  logAction('modify','🔄','Doctor switched',`Switched to ${currentDoctor?.nameBn || currentDoctor?.name}`);
  closeModal('modal-doctor-switch');
  showToast(`✓ Switched to ${currentDoctor?.nameBn || currentDoctor?.name}`,'success');
  _syncReservedSlots(); // load reserved slots for the new doctor
  await initSession();
  // After session loads: refresh all views
  updateNavBadges(); render();
}

function applyNavVisibility() {
  const tabs = ['entry','doctor','refs','users','schedule','audit','reports','settings'];
  tabs.forEach(t => {
    const el = document.getElementById('nav-'+t);
    if (el) el.classList.toggle('hidden', !hasTab(t));
  });
}

function doLogout() {
  if (!confirm('লগআউট করবেন?')) return;
  logAction('login','🔒','User logged out',`${currentUser.name} logged out.`,currentUser.name,'',currentDate);
  stopPolling();
  currentUser = null; currentDoctor = null;
  patients = []; auditLog = []; nextToken = 1;
  consultStartTimestamps = {}; consultDurations = [];
  patientReferences = [];
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-wrap').style.display = 'flex';
  // UPDATED SECTION — Hide mobile nav on logout
  const mbnNav = document.getElementById('mobile-bottom-nav');
  if (mbnNav) mbnNav.style.display = 'none';
  document.getElementById('login-username').value = '';
  document.getElementById('login-pin-inp').value = '';
  clearLoginErr();
}

// ═══════════════════════════════════════════════════
// SESSION INIT & SYNC
// ═══════════════════════════════════════════════════
async function initSession() {
  setSyncBadge('wait', 'Loading...');
  _syncReservedSlots(); // load reserved slot store for this doctor+date
  const data = await supaLoadSession(currentDate, currentDoctor?.id);
  if (data) applySessionData(data);
  updateNavBadges();
  render();
  startPolling(currentDate, currentDoctor?.id, (data) => {
    applySessionData(data);
    updateNavBadges();
    if (['queue','doctor','display'].includes(currentTab)) render();
  });
}

/// UPDATED SECTION — applySessionData: deduplication, corruption prevention, nextToken recalculation, doctor-isolation guard (Fix #4)
function applySessionData(data) {
  patients.length = 0;
  const seen = new Set();
  const activeDoctorId = currentDoctor?.id || null;
  (data.patients || []).forEach(p => {
    if (!p || !p.token) return; // skip corrupt entries
    if (seen.has(p.token)) return; // skip duplicates
    // UPDATED SECTION — Doctor isolation guard: only load patients for active doctor
    // If patient has assignedDoctorId set, it must match. Patients with no assignedDoctorId
    // are legacy entries (pre-fix) — accept them to avoid data loss on upgrade.
    if (p.assignedDoctorId && activeDoctorId && p.assignedDoctorId !== activeDoctorId) return;
    seen.add(p.token);
    // Backfill assignedDoctorId for legacy patients that lack it
    if (!p.assignedDoctorId && activeDoctorId) {
      p.assignedDoctorId = activeDoctorId;
      p.doctorName = currentDoctor?.nameEn || currentDoctor?.name || '';
      p.doctorNameBn = currentDoctor?.nameBn || currentDoctor?.name || '';
    }
    // ── SCHEMA v2 MIGRATION — backfill missing fields on old records ──
    if (!p._schemaVersion || p._schemaVersion < 2) {
      // registrationSource: derive from existing `source` field
      if (!p.registrationSource) {
        const s = p.source || '';
        if (s === 'walkin')    p.registrationSource = 'walkin';
        else if (s === 'phone') p.registrationSource = 'phone';
        else if (s === 'online') p.registrationSource = 'online';
        else if (s === 'docref' || s === 'followup' || s === 'recall') p.registrationSource = 'referral';
        else p.registrationSource = 'desk';
      }
      // registeredBy: derive from addedBy (name, not ID — best we can do for legacy)
      if (!p.registeredBy) {
        p.registeredBy = p.addedBy || 'legacy';
        p.registeredByName = p.addedBy || 'Legacy Record';
        p.registeredByRole = 'unknown';
      }
      // slotType: derive from type
      if (!p.slotType) {
        if (p.type === 'emergency') p.slotType = 'emergency';
        else if (p.type === 'docref') p.slotType = 'doctor_priority';
        else p.slotType = 'normal';
      }
      // reserved fields: legacy records were never reserved
      if (p.isReservedSlot === undefined) p.isReservedSlot = false;
      if (!p.reservedBy)    p.reservedBy = null;
      if (!p.reservedUntil) p.reservedUntil = null;
      if (!p.addedAtISO)    p.addedAtISO = null; // timestamp lost for old records
      p._schemaVersion = 2;
    }
    patients.push(p);
  });
  // Recalculate nextToken as max(stored, max_patient_token + 1) to prevent gaps
  const maxTok = patients.reduce((m, p) => Math.max(m, p.token||0), 0);
  const storedNext = data.next_token || 1;
  nextToken = Math.max(storedNext, maxTok + 1);

  if (data.doctor_status) {
    doctorStatus = data.doctor_status;
    const ds = doctorStatuses[doctorStatus] || doctorStatuses.arriving;
    const chip = document.getElementById('doc-status-chip');
    const txt  = document.getElementById('doc-status-text');
    if (chip) chip.className = 'doc-status-chip ' + ds.cls;
    if (txt) txt.textContent = ds.label;
  }
  Object.assign(consultStartTimestamps, data.consult_ts || {});
  (data.ref_meta || []).forEach(rem => {
    if (!rem || patientReferences.find(r => r.id === rem.id)) return;
    patientReferences.unshift({ ...rem, fileDataUrl: null });
  });
  // Save fresh offline mirror
  saveOfflineSession();
}

/// UPDATED SECTION — Offline-first: per-doctor+date localStorage key (Fix #2: prevents cross-doctor offline data collision)
const LS_OFFLINE_PREFIX = 'mq_offline_v2__';

function _offlineKey(isoDate, doctorId) {
  return LS_OFFLINE_PREFIX + (doctorId || 'null') + '__' + (isoDate || '');
}

function saveOfflineSession() {
  try {
    const key = _offlineKey(currentDate, currentDoctor?.id);
    localStorage.setItem(key, JSON.stringify({
      date: currentDate,
      doctorId: currentDoctor?.id || null,
      patients: patients,
      next_token: nextToken,
      doctor_status: doctorStatus,
      consult_ts: consultStartTimestamps,
      ref_meta: patientReferences.map(r=>({id:r.id,patientToken:r.patientToken,patientName:r.patientName,category:r.category,notes:r.notes,fileName:r.fileName,fileType:r.fileType,uploadedAt:r.uploadedAt,uploadedBy:r.uploadedBy})),
      saved_at: Date.now()
    }));
  } catch(e) {}
}

function loadOfflineSession(isoDate, doctorId) {
  try {
    // Try new per-doctor key first
    const key = _offlineKey(isoDate, doctorId);
    const raw = localStorage.getItem(key);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.date === isoDate && s.doctorId === (doctorId||null)) return s;
    }
    // Legacy fallback: old single key (only if same doctor+date)
    const legacyRaw = localStorage.getItem('mq_offline_session_v1');
    if (legacyRaw) {
      const ls = JSON.parse(legacyRaw);
      if (ls.date === isoDate && ls.doctorId === (doctorId||null)) return ls;
    }
    return null;
  } catch(e) { return null; }
}

async function supaLoadSession(isoDate, doctorId) {
  setSyncBadge('wait', 'Loading...');
  try {
    const sid = await getOrCreateSession(isoDate, doctorId);
    if (!sid) throw new Error('no session id');
    const { data } = await _supa.from('sessions').select('*').eq('id', sid).single();
    setSyncBadge('ok');
    if (data) {
      /// UPDATED SECTION — Mirror uses per-doctor offline key (Fix #3)
      try {
        const offKey = _offlineKey(isoDate, doctorId);
        localStorage.setItem(offKey, JSON.stringify({...data, date:isoDate, doctorId:doctorId||null, saved_at:Date.now()}));
      } catch(e) {}
    }
    return data;
  } catch(e) {
    setSyncBadge('err', 'Offline');
    // OFFLINE RECOVERY: use per-doctor localStorage mirror
    const offline = loadOfflineSession(isoDate, doctorId);
    if (offline) {
      showToast('⚠️ Offline mode — loading from local backup','warning');
      return offline;
    }
    return null;
  }
}

function syncState() {
  // Always save offline copy first (instant, no network)
  saveOfflineSession();
  /// UPDATED SECTION — stamp write time so poll backs off for 4s (prevents poll overwriting uncommitted local state)
  _lastWriteAt = Date.now();
  // Then schedule Supabase write
  scheduleWrite(currentDate, currentDoctor?.id, {
    patients, next_token: nextToken,
    doctor_status: doctorStatus,
    consult_ts: consultStartTimestamps,
    ref_meta: patientReferences.map(r => ({ id:r.id,patientToken:r.patientToken,patientName:r.patientName,category:r.category,notes:r.notes,fileName:r.fileName,fileType:r.fileType,uploadedAt:r.uploadedAt,uploadedBy:r.uploadedBy })),
  });
}
window.fbLogAction = supaLogAudit;

// ═══════════════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════════════
function switchTab(tab) {
  if (!hasTab(tab)) { showToast('⛔ এই section এ আপনার access নেই।','error'); return; }
  currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  // UPDATED SECTION — Update mobile bottom nav active state
  const mbnTabs = ['queue','entry','doctor','display','reports'];
  mbnTabs.forEach(t => {
    const el = document.getElementById('mbn-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  const isTV = tab === 'display';
  const hdr = document.querySelector('.topbar');
  const nav = document.querySelector('.navbar');
  const main = document.getElementById('main-content');
  if (hdr) hdr.style.display = isTV ? 'none' : '';
  if (nav) nav.style.display = isTV ? 'none' : '';
  if (main) {
    main.style.padding = isTV ? '0' : '';
    main.style.height  = isTV ? '100vh' : '';
    main.style.overflow = isTV ? 'hidden' : '';
  }
  if (!isTV) {
    if (_tvClockInterval) { clearInterval(_tvClockInterval); _tvClockInterval = null; }
    if (_tvAutoRefresh)   { clearInterval(_tvAutoRefresh);   _tvAutoRefresh   = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
  }
  if (tab === 'audit') supaLoadAudit(currentDate).then(log => { auditLog = log; render(); return; });
  render();
  if (isTV) { startTVClock(); startTVAutoRefresh(); }
}

function render() {
  const m = document.getElementById('main-content');
  if (!m) return;
  const renderers = {
    queue: renderQueue, entry: renderEntry, doctor: renderDoctor,
    refs: renderRefs, display: renderDisplay, users: renderUsers,
    schedule: renderSchedule, audit: renderAudit,
    reports: renderReports, settings: renderSettings,
  };
  m.innerHTML = (renderers[currentTab] || (() => '<div class="alert alert-warning">Unknown tab</div>'))();
}

// ═══════════════════════════════════════════════════
// DATE SELECTOR STRIP (used in Queue + Entry)
// ═══════════════════════════════════════════════════
async function changeDate(isoDate) {
  if (isoDate === currentDate) return;
  stopPolling();
  currentDate = isoDate;
  patients = []; nextToken = 1;
  consultStartTimestamps = {}; patientReferences = [];
  const data = await supaLoadSession(currentDate, currentDoctor?.id);
  if (data) applySessionData(data);
  updateNavBadges(); render();
  startPolling(currentDate, currentDoctor?.id, (data) => {
    applySessionData(data);
    updateNavBadges();
    if (['queue','entry','display'].includes(currentTab)) render();
  });
}

function renderDateStrip() {
  const today = todayISO();
  let html = '<div class="date-strip">';
  for (let i = 0; i <= 6; i++) {
    const iso = addDays(today, i);
    const fd = formatDisplayDate(iso);
    const doctorId = currentDoctor?.id || 'd1';
    const sch = getSchedule(doctorId, iso);
    const max = sch.maxPatients || 50;
    const registered = iso === currentDate ? patients.length : 0; // live for today
    const pct = registered / max;
    const isToday = iso === today;
    const isSelected = iso === currentDate;
    const isFull = registered >= max;
    let extraCls = isFull ? ' full-day' : '';
    extraCls += isSelected ? ' active' : '';
    const slotTxt = isToday ? `${registered}/${max} slots` : `Max ${max} slots`;
    html += `<div class="date-btn${extraCls}" onclick="changeDate('${iso}')">
      <div class="db-day">${isToday ? 'TODAY' : fd.day.toUpperCase()}</div>
      <div class="db-date">${fd.date}</div>
      <div class="db-slots">${slotTxt}</div>
    </div>`;
  }
  html += '</div>';
  return html;
}

// ═══════════════════════════════════════════════════
// QUEUE TAB
// ═══════════════════════════════════════════════════
function renderQueue() {
  const inCons  = patients.find(p => p.status === 'incons');
  const called  = patients.filter(p => p.status === 'called');
  const arrived = patients.filter(p => p.status === 'arrived');
  const waiting = patients.filter(p => p.status === 'waiting');
  const done    = patients.filter(p => p.status === 'completed');
  const noshow  = patients.filter(p => p.status === 'noshow');
  const emgs    = patients.filter(p => p.type === 'emergency' && !['completed','noshow','cancelled'].includes(p.status));
  const nextP   = called[0] || arrived[0] || waiting[0];
  const sch     = getSchedule(currentDoctor?.id||'d1', currentDate);
  const max     = sch.maxPatients || 50;
  const registered = patients.length;
  const pct     = Math.min(100, (registered / max) * 100);
  const liveDur = inCons ? getLiveConsultDuration(inCons.token) : null;
  const isToday = currentDate === todayISO();

  let html = renderDateStrip();
  html += renderQueueSearchBar();

  // Count banner
  const bannerCls = registered >= max ? ' full-banner' : registered >= max * 0.85 ? ' near-full' : '';
  html += `<div class="count-banner${bannerCls}">
    <div class="count-banner-left">
      <div class="count-banner-title">${currentDate === todayISO() ? 'আজকের' : formatDisplayDate(currentDate).day + ' ' + formatDisplayDate(currentDate).date} — ${currentDoctor?.name || 'Doctor'}</div>
      <div class="count-banner-main">${registered}<span style="font-size:16px;font-weight:500;opacity:0.5"> / ${max}</span></div>
      <div class="count-banner-sub">${registered >= max ? '🔴 Serial Full — নতুন serial নেওয়া যাবে না' : `${max - registered} slots remaining`}</div>
    </div>
    <div class="count-banner-bar">
      <div class="count-bar-track">
        <div class="count-bar-fill" style="width:${pct}%;background:${registered>=max?'#f87171':registered>=max*0.85?'#fbbf24':'#4ade80'}"></div>
      </div>
      <div class="count-bar-label">${Math.round(pct)}% full</div>
    </div>
  </div>`;

  if (emgs.length > 0) html += `<div class="alert alert-danger">🚨 ${emgs.length} emergency patient(s) — immediate attention required</div>`;

  if (!isToday) {
    html += `<div class="alert alert-info">📅 Viewing schedule for <strong>${currentDate}</strong>. This is a ${currentDate > todayISO() ? 'future' : 'past'} date.</div>`;
  }

  if (!isDoctorPresent() && isToday) {
    const ds = doctorStatuses[doctorStatus]||doctorStatuses.arriving;
    html += `<div class="no-doc-banner">
      <div class="no-doc-icon">🚗</div>
      <div class="no-doc-text">
        <h3>Doctor এখনো Chamber-এ আসেননি</h3>
        <p>Status: <strong>${ds.label}</strong> — Consultation শুরু করা যাবে না।</p>
      </div>
    </div>`;
  }

  html += `<div class="grid-4">
    <div class="stat-card"><div class="stat-val c-blue">${getActiveCount()}</div><div class="stat-lbl">In Queue</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--purple)">${inCons ? '#'+inCons.token : '—'}</div><div class="stat-lbl">Current Token</div></div>
    <div class="stat-card"><div class="stat-val c-green">${nextP && nextP.token !== inCons?.token ? '#'+nextP.token : done.length}</div><div class="stat-lbl">${nextP && nextP.token !== inCons?.token ? 'Next Token' : 'Done'}</div></div>
    <div class="stat-card"><div class="stat-val c-red">${noshow.length}</div><div class="stat-lbl">No Show</div></div>
  </div>`;

  // In consultation
  if (inCons) {
    html += `<div class="incons-hero" id="incons-card">
      <div class="incons-badge"><div class="pulse-dot"></div> IN CONSULTATION</div>
      <div class="incons-row">
        <div class="big-token ${getBigTokenCls(inCons.type)}">#${inCons.token}</div>
        <div style="flex:1;min-width:0">
          <div class="incons-name">${inCons.name}</div>
          <div class="incons-sub">${inCons.age}${inCons.gender} · ${getPriorityInfo(inCons.type).label} · via ${inCons.addedBy}</div>
          ${inCons.notes ? `<div style="font-size:11px;opacity:0.6;margin-top:3px;font-style:italic">${inCons.notes}</div>` : ''}
        </div>
        <div>
          <div class="incons-timer" id="live-timer">${liveDur ? formatDuration(liveDur) : '0:00'}</div>
          <div class="incons-timer-lbl">Running</div>
        </div>
      </div>
      ${canDo('canComplete') ? `<button class="btn-complete-big" onclick="completeConsultation(${inCons.token})">✔ Complete Consultation — Move to Next</button>` : ''}
    </div>`;
  } else if (isDoctorPresent()) {
    html += `<div class="alert alert-success" style="margin-bottom:12px">✅ Ready — no active consultation. Start next patient.</div>`;
  }

  // Next patient
  if (nextP && nextP.token !== inCons?.token) {
    const pi = getPriorityInfo(nextP.type);
    html += `<div class="next-hero">
      <div class="next-badge">▶ NEXT PATIENT</div>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="token-box ${pi.cls}">${nextP.token}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:13px">${nextP.name}</div>
          <div style="font-size:11px;color:var(--text2)">${nextP.age}${nextP.gender} · ${pi.label}</div>
        </div>
        ${getStatusChip(nextP.status)}
      </div>
      <div class="q-actions" style="margin-top:10px">
        ${nextP.status==='waiting'  ? `<button class="btn btn-arrive"   onclick="markArrived(${nextP.token})">✓ Mark Arrived</button>` : ''}
        ${nextP.status==='arrived'  ? `<button class="btn btn-call"     onclick="callPatient(${nextP.token})">📣 Call Patient</button>` : ''}
        ${nextP.status==='called'   ? renderStartBtn(nextP.token) : ''}
        ${['waiting','arrived','called'].includes(nextP.status) ? `<button class="btn btn-noshow" onclick="markNoShow(${nextP.token})">✗ No Show</button>` : ''}
      </div>
    </div>`;
  }

  // ONE shared Set to track reserved tokens rendered across ALL queue sections
  const renderedReservedTokens = new Set();

  // Helper: get reserved slots not yet rendered and not already a real patient token
  function getUnrenderedReservedSlots(existingTokens) {
    const allReserved = getVisibleReservedSlots();
    return allReserved.filter(t =>
      !renderedReservedTokens.has(t) &&
      !existingTokens.includes(t)
    );
  }

  // Called queue — with reserved placeholders interleaved if any fall in this token range
  const calledFiltered = _queueSearch ? filterBySearch(called.filter(p=>p!==nextP)) : called.filter(p=>p!==nextP);
  const calledTokens = calledFiltered.map(p => p.token);
  const reservedInCalled = _queueSearch ? [] : getUnrenderedReservedSlots(calledTokens).filter(t =>
    calledFiltered.length > 0 &&
    t > (calledFiltered[0]?.token||0) && t < (calledFiltered[calledFiltered.length-1]?.token||0)
  );
  if (calledFiltered.length > 0) {
    html += `<div class="queue-section"><div class="q-section-label">📣 Called — Preparing</div>`;
    const mergedCalled = [
      ...calledFiltered.map(p => ({ type:'patient', data:p, token:p.token })),
      ...reservedInCalled.map(t => ({ type:'reserved', token:t })),
    ].sort((a,b) => a.token - b.token);
    mergedCalled.forEach(item => {
      if (item.type === 'reserved') {
        renderedReservedTokens.add(item.token);
        html += renderReservedPlaceholder(item.token);
      } else {
        html += renderQueueItem(item.data);
      }
    });
    html += `</div>`;
  }

  // Arrived — same treatment
  const arrivedFiltered = _queueSearch ? filterBySearch(arrived.filter(p=>p!==nextP)) : arrived.filter(p=>p!==nextP);
  const arrivedTokens = arrivedFiltered.map(p => p.token);
  const reservedInArrived = _queueSearch ? [] : getUnrenderedReservedSlots(arrivedTokens).filter(t =>
    arrivedFiltered.length > 0 &&
    t > (arrivedFiltered[0]?.token||0) && t < (arrivedFiltered[arrivedFiltered.length-1]?.token||0)
  );
  if (arrivedFiltered.length > 0) {
    html += `<div class="queue-section"><div class="q-section-label">✓ Arrived — In Waiting Room</div>`;
    const mergedArrived = [
      ...arrivedFiltered.map(p => ({ type:'patient', data:p, token:p.token })),
      ...reservedInArrived.map(t => ({ type:'reserved', token:t })),
    ].sort((a,b) => a.token - b.token);
    mergedArrived.forEach(item => {
      if (item.type === 'reserved') {
        renderedReservedTokens.add(item.token);
        html += renderReservedPlaceholder(item.token);
      } else {
        html += renderQueueItem(item.data);
      }
    });
    html += `</div>`;
  }

  // Waiting (with reserved slot placeholders interleaved in token order)
  const waitingRestAll = waiting.filter(p=>p!==nextP);
  const waitingRest = _queueSearch ? filterBySearch(waitingRestAll) : waitingRestAll;
  const waitingTokens = waitingRest.map(p => p.token);
  const reservedVisible = _queueSearch ? [] : getUnrenderedReservedSlots(waitingTokens);

  if (waitingRest.length > 0 || reservedVisible.length > 0) {
    html += `<div class="queue-section"><div class="q-section-label">⏳ Not Arrived Yet</div>`;
    // Build a merged list: real waiting patients + reserved placeholders, sorted by token
    const merged = [
      ...waitingRest.map(p => ({ type:'patient', data:p, token:p.token })),
      ...reservedVisible.map(t => ({ type:'reserved', token:t })),
    ].sort((a,b) => a.token - b.token);
    let pos = 2;
    merged.forEach(item => {
      if (item.type === 'reserved') {
        renderedReservedTokens.add(item.token);
        html += renderReservedPlaceholder(item.token);
      } else {
        html += renderQueueItem(item.data, pos++);
      }
    });
    html += `</div>`;
  }
  // renderedReservedTokens Set is now complete — all sections rendered

  // Search results — completed/cancelled
  if (_queueSearch) {
    const searchDone = filterBySearch([...patients.filter(p=>['completed','noshow','cancelled'].includes(p.status))]);
    if (searchDone.length > 0) {
      html += `<div class="card"><div class="card-title">🔍 Search — Past Patients</div>${searchDone.map(p=>renderQueueItemDone(p)).join('')}</div>`;
    }
    if (calledFiltered.length===0 && arrivedFiltered.length===0 && waitingRest.length===0 && searchDone.length===0) {
      html += `<div class="card"><div class="empty-state"><div class="es-icon">🔍</div><div class="es-title">কোনো ফলাফল পাওয়া যায়নি</div><div class="es-sub">No patient found for "${_queueSearch}"</div></div></div>`;
    }
  }

  // Completed/No show (only show when not searching)
  if (!_queueSearch && (done.length > 0 || noshow.length > 0)) {
    const all = [...done, ...noshow];
    html += `<div class="card">
      <div class="collapsible-hdr" onclick="completedCollapsed=!completedCollapsed;render()" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer">
        <span class="card-title" style="margin-bottom:0">✔ Completed / No Show (${all.length})</span>
        <button class="toggle-btn">${completedCollapsed?'▼ Show':'▲ Hide'}</button>
      </div>
      ${completedCollapsed ? '' : `<div style="margin-top:10px">${all.map(p => renderQueueItemDone(p)).join('')}</div>`}
    </div>`;
  }

  if (hasTab('entry')) {
    html += `<div style="text-align:center;margin-top:6px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-primary btn-lg" onclick="switchTab('entry')" ${registered>=max?'disabled title="Serial Full"':''}>
        ${registered>=max ? '🔴 Serial Full — নতুন রোগী add করা যাবে না' : '➕ Register New Patient'}
      </button>
      <button class="btn btn-secondary btn-lg" onclick="openRecallModal()" title="Recall a previous patient back to queue">🔄 Recall Patient</button>
      ${patients.length>0 ? `<button class="btn btn-secondary btn-lg" onclick="exportMobileCSV()" title="Export mobile numbers for follow-up">📱 Export Mobile</button>` : ''}
    </div>`;
  }
  return html;
}

function renderStartBtn(token) {
  if (!canDo('canConsult')) return `<button class="btn" style="background:#f3f4f6;color:#9ca3af;border-color:#e5e7eb;cursor:not-allowed">🔒 No Permission</button>`;
  if (!isDoctorPresent()) return `<button class="btn" style="background:#f3f4f6;color:#9ca3af;border-color:#e5e7eb;cursor:not-allowed" disabled>🔒 Doctor Not Here</button>`;
  return `<button class="btn btn-start" onclick="startConsultation(${token})">🏥 Start Consultation</button>`;
}

function renderQueueItem(p, position) {
  const pi = getPriorityInfo(p.type);
  let itemCls = 'q-item';
  if (p.status==='called')  itemCls += ' s-called';
  if (p.status==='arrived') itemCls += ' s-arrived';
  if (p.type==='emergency' && !['completed','noshow'].includes(p.status)) itemCls += ' s-emg';
  const reserved = isReservedSlot(p.token);
  if (reserved) itemCls += ' s-reserved';
  const hasRefs = patientReferences.filter(r => r.patientToken === p.token).length;
  // UPDATED SECTION — Fix #13: Smart queue — estimated wait time based on avg consult duration
  const avgMin = getAvgConsultDuration();
  const qPos = position || 1;
  const estWaitMin = p.status==='waiting' && qPos > 1 ? avgMin * (qPos - 1) : null;
  const waitStr = estWaitMin ? `~${estWaitMin}m wait` : '';
  const payBadge = getPayBadge(p);
  const isRecalled = p.source === 'recall' || p.recalledFrom;
  return `<div class="${itemCls}">
    <div class="token-box ${reserved ? 'tk-reserved' : pi.cls}">${p.token}${reserved?'★':''}</div>
    <div class="q-info">
      <div class="q-name">${p.name} <span style="font-weight:400;font-size:11px;color:var(--text3)">${p.age}${p.gender}</span>
        ${p.phone ? `<span style="font-size:10px;color:var(--text3);margin-left:4px">📱 ${p.phone}</span>` : ''}
        ${hasRefs ? `<span class="pill" style="background:var(--purple-soft);color:var(--purple);margin-left:4px">📁 ${hasRefs}</span>` : ''}
        ${reserved ? `<span class="pill" style="background:var(--purple-soft);color:var(--purple);margin-left:4px">★ Reserved</span>` : ''}
        ${isRecalled ? `<span class="pill" style="background:var(--amber-soft);color:var(--amber);margin-left:4px">🔄 Recalled</span>` : ''}
      </div>
      <div class="q-meta">
        ${getStatusChip(p.status)}
        ${getSourceTag(p.source, p.addedBy)}
        ${p.type!=='regular' ? `<span class="chip" style="background:var(--amber-soft);color:var(--amber)">${pi.label}</span>` : ''}
        ${payBadge}
        ${p.notes ? `<span style="font-size:10px;color:var(--text3);font-style:italic">${p.notes}</span>` : ''}
      </div>
      ${p.fee ? `<div class="billing-inline"><span class="billing-fee-lbl">Fee:</span><span class="billing-fee-val">৳${p.fee}</span><span class="billing-fee-lbl">Paid:</span><span class="billing-fee-val" style="color:var(--green)">৳${p.paid||0}</span>${p.fee-(p.paid||0)>0?`<span class="billing-fee-lbl">Due:</span><span class="billing-fee-val" style="color:var(--red)">৳${p.fee-(p.paid||0)}</span>`:''}</div>` : ''}
      <div class="q-actions">
        ${p.status==='waiting'  ? `<button class="btn btn-arrive"   onclick="markArrived(${p.token})">✓ Arrived</button>` : ''}
        ${p.status==='arrived'  ? `<button class="btn btn-call"     onclick="callPatient(${p.token})">📣 Call</button>` : ''}
        ${p.status==='called'   ? renderStartBtn(p.token) : ''}
        ${p.status==='called'   ? `<button class="btn btn-call" style="background:var(--amber-soft);border-color:var(--amber);color:#92400e" onclick="callPatient(${p.token})">🔁 Recall</button>` : ''}
        ${['waiting','arrived','called'].includes(p.status) ? `<button class="btn btn-noshow" onclick="markNoShow(${p.token})">✗ No Show</button>` : ''}
        ${['waiting','arrived'].includes(p.status) ? `<button class="btn btn-cancel" onclick="openSkipModal(${p.token})">⏭ Skip</button>` : ''}
        <button class="btn btn-doc" onclick="openRefModalForPatient(${p.token})">📎 Doc</button>
        <button class="btn btn-secondary" style="font-size:10px;padding:5px 9px" onclick="openBillingModal(${p.token})">💳 Bill</button>
        ${p.phone ? `<button class="btn btn-secondary" style="font-size:10px;padding:5px 9px;background:#dcfce7;border-color:#86efac;color:#065f46" onclick="openWhatsApp('${p.phone}','${p.name.replace(/'/g,"\\'")}')">💬 WA</button>` : ''}
      </div>
    </div>
    <div class="q-right">
      ${waitStr ? `<div class="q-time" style="color:var(--amber);font-weight:700">${waitStr}</div>` : ''}
      <div class="q-time" style="margin-top:3px">Reg. ${p.addedAt}</div>
    </div>
  </div>`;
}

function renderQueueItemDone(p) {
  return `<div class="q-item ${p.status==='noshow'?'s-noshow':'s-done'}">
    <div class="token-box tk-done">${p.token}</div>
    <div class="q-info">
      <div class="q-name" style="color:var(--text3)">${p.name}</div>
      <div class="q-meta">${getStatusChip(p.status)} ${getSourceTag(p.source,p.addedBy)} ${p.completed_at?`<span class="q-time">Done ${p.completed_at}</span>`:''}</div>
    </div>
  </div>`;
}

// ── RESERVED SLOT PLACEHOLDER ──
// Renders a visible "Reserved" card in the queue list so the token sequence
// shows: 1 → 2 → 3 → 4 → [Reserved #5] → 6 → 7
// Doctor/Admin sees Fill and Release buttons. Others see informational only.
function renderReservedPlaceholder(tokenNum) {
  const canFill = canFillReserved();
  return `<div class="q-item s-reserved" style="opacity:0.82">
    <div class="token-box tk-reserved" style="font-size:13px;letter-spacing:-0.5px">${tokenNum}★</div>
    <div class="q-info">
      <div class="q-name" style="color:var(--purple);font-weight:700">
        <span class="bn" style="font-size:13px">সংরক্ষিত স্লট</span>
        <span style="font-weight:400;font-size:11px;color:#7c3aed;margin-left:6px">Reserved Slot</span>
      </div>
      <div class="q-meta">
        <span class="chip" style="background:var(--purple-soft);color:var(--purple);border:1px solid #c4b5fd">⭐ Reserved</span>
        <span style="font-size:10px;color:var(--text3)">${canFill ? 'Doctor/Admin — fill or release this slot' : 'ডাক্তার বা Admin এই slot পূরণ করবেন'}</span>
      </div>
      ${canFill ? `<div class="q-actions" style="margin-top:6px">
        <button class="btn btn-secondary" style="font-size:10px;padding:5px 10px;border-color:var(--purple);color:var(--purple);background:var(--purple-soft)" onclick="openFillReservedModal(${tokenNum})" title="Fill this reserved slot with a patient">⭐ Fill Slot</button>
        <button class="btn btn-secondary" style="font-size:10px;padding:5px 10px" onclick="releaseReservedSlot(${tokenNum})" title="Release to normal queue — anyone can get this token">🔓 Release</button>
      </div>` : ''}
    </div>
    <div class="q-right">
      <div class="q-time" style="color:var(--purple);font-weight:700">#${tokenNum}</div>
      <div style="font-size:9px;color:#7c3aed;margin-top:2px">Doctor only</div>
    </div>
  </div>`;
}

// ── getVisibleReservedSlots ──
// Returns reserved token numbers that should appear as placeholders in the
// active queue list — i.e. tokens that:
//   (a) are schedule-reserved (divisible by reservedInterval)
//   (b) are NOT already filled by a real patient
//   (c) fall within the "active range": between token #1 and nextToken-1
//       (slots AHEAD of nextToken are not yet in play, no need to show them)
//   (d) are NOT completed/noshow — no placeholder needed for past tokens
function getVisibleReservedSlots() {
  const sch = getSchedule(currentDoctor?.id||'d1', currentDate);
  if (!sch.reservedInterval || sch.reservedInterval <= 0) return [];
  // Only real patients (non-placeholder) count as used tokens
  const usedTokens = new Set(
    patients
      .filter(p => !p.isReservedSlot)
      .map(p => p.token)
  );
  const result = [];
  const interval = sch.reservedInterval;
  for (let t = interval; t < nextToken; t += interval) {
    // Skip if a real patient already has this token
    const existingPatient = patients.find(p =>
      p.token === t &&
      p.status !== 'completed' &&
      p.status !== 'noshow'
    );
    if (!existingPatient && !usedTokens.has(t)) {
      result.push(t);
    }
  }
  // Double-dedup safety
  return [...new Set(result)];
}
function refreshQueue()           { if(currentTab==='queue')   render(); }
function refreshDoctorDashboard() { if(currentTab==='doctor')  render(); }
function refreshTVDisplay()       { if(currentTab==='display') render(); }
function refreshAll()             { updateNavBadges(); render(); }

/// UPDATED SECTION — holdPatient: moves incons back to called status
function holdPatient(token) {
  const p = patients.find(x=>x.token===token);
  if (!p || p.status!=='incons') return;
  if (!confirm(`Hold #${token} (${p.name}) — move back to Called?`)) return;
  // Capture duration so far
  if (consultStartTimestamps[token]) {
    const dur = Math.max(1, Math.round((Date.now()-consultStartTimestamps[token])/60000));
    consultDurations.push(dur);
    delete consultStartTimestamps[token];
  }
  p.status = 'called';
  logAction('modify','⏸','Patient held',`${p.name} (#${token}) put on hold — back to Called.`);
  syncState(); updateNavBadges(); render();
  showToast(`⏸ ${p.name} on hold`,'info');
}

function markArrived(token) {
  const p = patients.find(x => x.token===token);
  if (!p || p.status!=='waiting') return;
  p.status = 'arrived'; p.arrived_at = nowTime();
  logAction('checkin','✅','Patient arrived',`${p.name} (#${token}) checked in.`);
  syncState(); updateNavBadges(); render();
}
function callPatient(token) {
  const p = patients.find(x => x.token===token);
  if (!p || !['arrived','waiting'].includes(p.status)) return;
  if (p.status==='waiting') p.arrived_at = nowTime();
  p.status='called'; p.called_at=nowTime();
  logAction('modify','📣','Patient called',`${p.name} (#${token}) called to enter doctor room.`);
  triggerCallingBanner(token, p.name, p.type === 'emergency');
  syncState(); updateNavBadges(); render();
}
/// UPDATED SECTION — startConsultation: now also accepts arrived patients (direct start)
function startConsultation(token) {
  if (!canDo('canConsult')) { showToast('⛔ Permission নেই।','error'); return; }
  if (!isDoctorPresent())   { showToast('❌ Doctor Chamber-এ নেই।','error'); return; }
  const p = patients.find(x => x.token===token);
  if (!p || !['called','arrived','waiting'].includes(p.status)) return;
  const existing = patients.find(x => x.status==='incons');
  if (existing) { showToast(`❌ ${existing.name} (#${existing.token}) এখন consultation-এ।`,'error'); return; }
  // Auto-advance status if needed
  if (p.status==='waiting') { p.arrived_at = nowTime(); }
  if (p.status!=='called')  { p.called_at = nowTime(); }
  p.status='incons'; p.consultation_started_at=nowTime();
  consultStartTimestamps[token] = Date.now();
  logAction('start','🏥','Consultation started',`${p.name} (#${token}) entered doctor room.`);
  syncState(); updateNavBadges(); render();
}
function completeConsultation(token) {
  if (!canDo('canComplete')) { showToast('⛔ Permission নেই।','error'); return; }
  const p = patients.find(x => x.token===token);
  if (!p || p.status!=='incons') return;
  const dur = consultStartTimestamps[token] ? Math.max(1, Math.round((Date.now()-consultStartTimestamps[token])/60000)) : 1;
  consultDurations.push(dur);
  delete consultStartTimestamps[token];
  p.status='completed'; p.consultation_ended_at=nowTime(); p.completed_at=nowTime();
  logAction('complete','✔','Consultation completed',`${p.name} (#${token}) — ${dur} min.`);
  syncState(); updateNavBadges(); render();
  const next = patients.find(x => x.status==='called') || patients.find(x => x.status==='arrived') || patients.find(x => x.status==='waiting');
  if (next) setTimeout(()=>showToast(`▶ Next: #${next.token} ${next.name}`,'info'),300);
}
function markNoShow(token) {
  const p = patients.find(x => x.token===token);
  if (!p) return;
  if (!confirm(`Mark #${token} (${p.name}) as NO SHOW?`)) return;
  p.status='noshow';
  logAction('noshow','❌','No Show marked',`${p.name} (#${token}).`,'','Patient did not respond');
  syncState(); updateNavBadges(); render();
}
function openSkipModal(token) { skipTargetToken=token; openModal('modal-skip'); }
function confirmSkip() {
  const reason = document.getElementById('skip-reason-sel').value;
  const extra  = document.getElementById('skip-reason-txt').value;
  if (!reason) { alert('Select a reason.'); return; }
  const p = patients.find(x => x.token===skipTargetToken);
  if (p) {
    logAction('modify','⏭️','Patient skipped',`${p.name} (#${skipTargetToken}) moved to end.`,'',reason+' '+extra);
    const idx = patients.indexOf(p);
    patients.splice(idx,1); patients.push(p);
  }
  closeModal('modal-skip'); skipTargetToken=null;
  syncState(); render();
}

// ═══════════════════════════════════════════════════
// ENTRY TAB
// ═══════════════════════════════════════════════════
function renderEntry() {
  const doctorId = currentDoctor?.id || 'd1';
  const sch = getSchedule(doctorId, currentDate);
  const max = sch.maxPatients || 50;
  const registered = patients.length;
  const isFull = registered >= max;

  let html = renderDateStrip();

  if (isFull) {
    html += `<div class="limit-reached">
      <h3>🔴 ${currentDate===todayISO()?'আজকের':'এই দিনের'} Serial Full (${registered}/${max})</h3>
      <p>Maximum patient limit পূর্ণ হয়েছে। নতুন patient add করা যাবে না।<br>
      ${canDo('canEditSchedule')?'Schedule tab থেকে limit বাড়ানো যাবে।':''}</p>
    </div>`;
    return html;
  }

  // ── QUEUE ENGINE: compute the real next token this user will receive ──
  // getNextAvailableToken() skips reserved slots for non-privileged users transparently.
  const effectiveNextToken = getNextAvailableToken();

  // Detect reserved slots that exist BEFORE the effective token (skipped silently)
  // — useful to inform Doctor/Admin so they can fill them if desired
  const skippedReserved = [];
  if (canFillReserved()) {
    for (let t = nextToken; t < effectiveNextToken; t++) {
      if (isReservedSlot(t) && !patients.find(p => p.token === t)) skippedReserved.push(t);
    }
  }

  // Show reserved slot banner for Doctor/Admin (informational, not blocking)
  if (skippedReserved.length > 0) {
    html += `<div class="alert alert-purple" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <span>⭐ Reserved slot${skippedReserved.length>1?'s':''} <strong>#${skippedReserved.join(', #')}</strong> — you can fill ${skippedReserved.length>1?'them':'it'} now (Doctor/Admin priority).</span>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${skippedReserved.map(t => `<button class="btn btn-secondary" style="font-size:10px;padding:5px 10px;border-color:var(--purple);color:var(--purple)" onclick="_fillReservedNow(${t})">Fill #${t}</button>`).join('')}
        ${skippedReserved.map(t => `<button class="btn btn-secondary" style="font-size:10px;padding:5px 10px" onclick="releaseReservedSlot(${t})" title="Release so anyone can use this token">🔓 Release #${t}</button>`).join('')}
      </div>
    </div>`;
  }

  // Informational banner — show the effective token the next patient will receive
  const isReservedForAdmin = isReservedSlot(effectiveNextToken) && canFillReserved();
  if (isReservedForAdmin) {
    html += `<div class="alert alert-purple">⭐ Token <strong>#${effectiveNextToken}</strong> is a <strong>Reserved Slot</strong> — you (Doctor/Admin) are filling it now.</div>`;
  }
  html += `<div class="alert alert-info">Next token assigned: <strong>#${effectiveNextToken}</strong> · ${max-registered} slots remaining for ${currentDate===todayISO()?'today':currentDate}</div>`;

  html += `<div class="card">
    <div class="card-title">📝 New Patient Registration</div>
    <div class="grid-form">
      <div class="form-group full">
        <label class="form-label">Patient Name *</label>
        <input type="text" class="form-input" id="f-name" placeholder="Full name" />
      </div>
      <div class="form-group">
        <label class="form-label">Phone *</label>
        <input type="tel" class="form-input" id="f-phone" placeholder="01X-XXXXXXXX" />
      </div>
      <div class="form-group">
        <label class="form-label">Age</label>
        <input type="number" class="form-input" id="f-age" placeholder="Years" min="0" max="120" />
      </div>
      <div class="form-group">
        <label class="form-label">Gender</label>
        <select class="form-select" id="f-gender">
          <option value="M">Male (পুরুষ)</option>
          <option value="F">Female (মহিলা)</option>
          <option value="C">Child (শিশু)</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" style="margin-bottom:6px">Source (who registered?) *</label>
      <div class="choice-grid cg-4" id="source-grid">
        ${renderSourceChoices()}
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" style="margin-bottom:6px">Priority Type *</label>
      <div class="choice-grid cg-4">
        <div class="choice-btn ${selectedPriority==='regular'?'sel':''}"    onclick="setPriority('regular')">🟦 Regular</div>
        <div class="choice-btn ${selectedPriority==='emergency'?'sel-emg':''}" onclick="setPriority('emergency')">🚨 Emergency</div>
        <div class="choice-btn ${selectedPriority==='docref'?'sel-ref':''}" onclick="setPriority('docref')">⭐ Doc Ref</div>
        <div class="choice-btn ${selectedPriority==='followup'?'sel-fup':''}" onclick="setPriority('followup')">🔄 Follow-up</div>
      </div>
    </div>

    ${selectedPriority==='emergency' ? `
    <div class="alert alert-danger" id="priority-reason-group">🚨 Emergency reason mandatory — permanently logged.</div>
    <div class="form-group" id="priority-reason-group">
      <label class="form-label">Emergency Reason *</label>
      <textarea class="form-textarea" id="f-reason" placeholder="Describe emergency condition..."></textarea>
    </div>` : `<div id="priority-reason-group" style="display:none">
      <div class="alert alert-danger">🚨 Emergency reason mandatory — permanently logged.</div>
      <div class="form-group">
        <label class="form-label">Emergency Reason *</label>
        <textarea class="form-textarea" id="f-reason" placeholder="Describe emergency condition..."></textarea>
      </div>
    </div>`}
    ${selectedPriority==='docref' ? `
    <div class="form-group" id="priority-ref-group">
      <label class="form-label">Referring Doctor *</label>
      <input type="text" class="form-input" id="f-refname" placeholder="e.g. Dr. Rahman, BIRDEM" />
    </div>` : `<div id="priority-ref-group" style="display:none">
      <div class="form-group">
        <label class="form-label">Referring Doctor *</label>
        <input type="text" class="form-input" id="f-refname" placeholder="e.g. Dr. Rahman, BIRDEM" />
      </div>
    </div>`}

    <div class="form-group">
      <label class="form-label">Notes / Chief Complaint (optional)</label>
      <input type="text" class="form-input" id="f-notes" placeholder="e.g. Chest pain, follow-up..." />
    </div>

    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:13px;margin-bottom:14px">
      <div class="grid-3" style="text-align:center">
        <div><div style="font-size:22px;font-weight:900;color:var(--accent);font-family:var(--mono)">#${effectiveNextToken}${isReservedSlot(effectiveNextToken)&&canFillReserved()?'★':''}</div><div style="font-size:10px;color:var(--text3)">Auto Token</div></div>
        <div><div style="font-size:22px;font-weight:900;font-family:var(--mono)">${selectedPriority==='emergency'?1:getActiveCount()+1}</div><div style="font-size:10px;color:var(--text3)">Queue Position</div></div>
        <div><div style="font-size:22px;font-weight:900;color:var(--amber);font-family:var(--mono)">~${selectedPriority==='emergency'?0:(getActiveCount()*getAvgConsultDuration())}m</div><div style="font-size:10px;color:var(--text3)">Est. Wait</div></div>
      </div>
    </div>
    <button class="btn-register" onclick="addPatient()">✔ Register — Token #${effectiveNextToken} Auto-Assigned</button>
  </div>`;
  return html;
}

/// UPDATED SECTION — renderSourceChoices: generic registration sources only (no staff names)
// registeredBy is auto-captured from currentUser separately
function renderSourceChoices() {
  const fixedSources = [
    { key: 'walkin',   label: '🚶 Walk-in' },
    { key: 'phone',    label: '📞 Phone Call' },
    { key: 'online',   label: '🌐 Online' },
    { key: 'referral', label: '👨‍⚕️ Referral' },
    { key: 'desk',     label: '🏥 Desk/Reception' },
  ];
  if (currentUser?.role === 'superadmin') {
    fixedSources.unshift({ key: 'admin', label: '👑 Admin Override' });
  }
  if (!selectedSource && fixedSources.length > 0) {
    selectedSource = fixedSources[0].key;
  }
  return fixedSources.map(s => `<div class="choice-btn ${selectedSource===s.key?'sel':''}" onclick="setSource('${s.key}')">${s.label}</div>`).join('');
}

/// UPDATED SECTION — setPriority/setSource: setSource no longer re-renders whole tab (fixes Patient Name clearing bug)
function setPriority(p) {
  selectedPriority = p;
  // Update ONLY the priority buttons in-place — do NOT call render() which wipes form fields
  document.querySelectorAll('.choice-grid.cg-4 .choice-btn').forEach(btn => {
    const onclickStr = btn.getAttribute('onclick') || '';
    const match = onclickStr.match(/setPriority\('(\w+)'\)/);
    if (match) {
      btn.classList.remove('sel', 'sel-emg', 'sel-ref', 'sel-fup');
      if (match[1] === p) {
        const clsMap = { regular: 'sel', emergency: 'sel-emg', docref: 'sel-ref', followup: 'sel-fup' };
        btn.classList.add(clsMap[p] || 'sel');
      }
    }
  });
  const reasonGroup = document.getElementById('priority-reason-group');
  const refGroup    = document.getElementById('priority-ref-group');
  if (reasonGroup) reasonGroup.style.display = p === 'emergency' ? 'block' : 'none';
  if (refGroup)    refGroup.style.display    = p === 'docref'    ? 'block' : 'none';
}
function setSource(s) {
  selectedSource = s;
  // PATCH: only update the source grid in-place — do NOT call render() which would wipe the form fields
  const grid = document.getElementById('source-grid');
  if (grid) {
    grid.innerHTML = renderSourceChoices();
  }
}

function addPatient() {
  const name   = document.getElementById('f-name')?.value?.trim();
  const phone  = document.getElementById('f-phone')?.value?.trim();
  const age    = document.getElementById('f-age')?.value || '?';
  const gender = document.getElementById('f-gender')?.value || 'M';
  if (!name)  { alert('Patient name required'); return; }
  if (!phone) { alert('Phone number required'); return; }
  if (selectedPriority==='emergency') {
    const r = document.getElementById('f-reason')?.value?.trim();
    if (!r) { alert('Emergency reason mandatory'); return; }
  }

  const max = getSchedule(currentDoctor?.id||'d1', currentDate).maxPatients || 50;
  if (patients.length >= max) { showToast('🔴 Serial Full!','error'); return; }

  // ── QUEUE ENGINE: get the next non-blocking token ──
  // For non-privileged users, reserved slots are skipped transparently.
  // For Doctor/Admin, reserved slots are filled (their privilege).
  const token = getNextAvailableToken();
  const wasReserved = isReservedSlot(token) && canAutoFillReservedSlot();
  if (wasReserved) fillReservedSlot(token, null);
  // Advance nextToken safely — never go backward
  nextToken = Math.max(nextToken, token + 1);
  syncState();

  const refName = document.getElementById('f-refname')?.value?.trim() || '';
  const notes   = [document.getElementById('f-notes')?.value?.trim(), refName?`Ref: ${refName}`:''].filter(Boolean).join(' · ');
  const srcUser = userStore.find(u=>u.username===selectedSource);
  const srcDisplay = srcUser ? srcUser.name : selectedSource;

  const np = {
    // ── Core identity ──
    token, name, phone: phone||'', age: parseInt(age)||0, gender,

    // ── Priority & status ──
    type: selectedPriority,
    status: 'waiting',

    // ── SCHEMA v2: Registration source — normalized canonical field ──
    // `source` kept for backward compat (existing UI/reports read it)
    // `registrationSource` is the new canonical field with stricter enum
    source: selectedSource,
    registrationSource: (() => {
      const src = selectedSource;
      if (['walkin','walkin'].includes(src))    return 'walkin';
      if (src === 'phone')                       return 'phone';
      if (src === 'online')                      return 'online';
      if (src === 'docref' || src === 'followup') return 'referral';
      if (src === 'reception' || src === 'desk' || src === 'admin') return 'desk';
      // Staff username (assistant/senior_assistant/desk) → desk
      return 'desk';
    })(),

    // ── SCHEMA v2: Who registered — auto-filled from logged-in user ──
    // `addedBy` kept for backward compat (queue cards display it)
    // `registeredBy` is the canonical user ID for audit/reporting
    addedBy: srcDisplay || getActorName(),
    registeredBy: currentUser?.username || currentUser?.name || 'system',
    registeredByName: currentUser?.name || srcDisplay || 'System',
    registeredByRole: currentUser?.role || 'unknown',

    // ── SCHEMA v2: Slot classification ──
    // slotType drives priority logic and reporting
    slotType: (() => {
      if (selectedPriority === 'emergency')    return 'emergency';
      if (wasReserved)                         return 'doctor_priority';
      if (selectedPriority === 'docref')       return 'doctor_priority';
      return 'normal';
    })(),
    isReservedSlot: wasReserved,
    reservedBy: wasReserved ? (currentUser?.username || null) : null,
    reservedUntil: null, // populated only when slot was explicitly time-reserved

    // ── Timestamps ──
    addedAt: nowTime(),
    addedAtISO: new Date().toISOString(),
    notes,

    // ── Billing ──
    fee: 0, paid: 0, payStatus: 'unpaid', payMethod: 'Cash',

    // ── Consultation lifecycle ──
    arrived_at: null, called_at: null,
    consultation_started_at: null, consultation_ended_at: null, completed_at: null,

    // ── Doctor assignment ──
    assignedDoctorId: currentDoctor?.id || null,
    doctorName: currentDoctor?.nameEn || currentDoctor?.name || '',
    doctorNameBn: currentDoctor?.nameBn || currentDoctor?.name || '',
    chamberId: currentDoctor?.room || currentDoctor?.chamberNumber || '',

    // ── Schema version (for future migrations) ──
    tokenNumber: token,
    _schemaVersion: 2,
  };

  if (selectedPriority==='emergency') {
    const firstActive = patients.findIndex(p=>['waiting','arrived','called'].includes(p.status));
    if (firstActive>=0) patients.splice(firstActive,0,np); else patients.push(np);
    const er = document.getElementById('f-reason')?.value?.trim();
    logAction('emergency','🚨','Emergency insertion',`${name} (#${token}) — Emergency. Queue shifted.`,'',er);
  } else {
    patients.push(np);
    logAction('add','➕','Patient registered',`${name} (#${token}) via ${srcDisplay}. Date: ${currentDate}`);
  }

  syncState(); updateNavBadges();
  selectedPriority='regular';
  showToast(`✓ Token #${token} assigned to ${name}`,'success');
  switchTab('queue');
}

/// UPDATED SECTION — renderDoctor: fixed queue counts, full consultation workflow panel with Call/Start/Complete/Recall/Hold/Skip buttons
function renderDoctor() {
  const inCons  = patients.find(p=>p.status==='incons');
  const called  = patients.filter(p=>p.status==='called');
  const arrived = patients.filter(p=>p.status==='arrived');
  const waiting = patients.filter(p=>p.status==='waiting');
  const done    = patients.filter(p=>p.status==='completed').length;
  const noshow  = patients.filter(p=>p.status==='noshow').length;
  // Active queue = waiting + arrived + called + incons
  const inQueueCount = waiting.length + arrived.length + called.length + (inCons ? 1 : 0);
  const ds      = doctorStatuses[doctorStatus]||doctorStatuses.arriving;
  const liveDur = inCons ? getLiveConsultDuration(inCons.token) : null;
  const appSet  = loadAppSettings();
  // Next patient for quick action
  const nextP   = called[0] || arrived[0] || waiting[0];

  let html = '';

  // ── Rx App launcher — ONLY for Super Admin & Doctor (Fix #9) ──
  if (['superadmin','doctor'].includes(currentUser?.role)) {
  html += `
    <div style="background:linear-gradient(135deg,#1a1f5e,#312e81,#4338ca);border-radius:var(--radius-lg);padding:20px;margin-bottom:12px;color:#fff;position:relative;overflow:hidden">
      <div style="position:absolute;right:-10px;top:-10px;font-size:80px;opacity:0.1;transform:rotate(-20deg)">💊</div>
      <div style="font-size:12px;font-weight:700;opacity:0.7;margin-bottom:3px">PRESCRIPTION SOFTWARE</div>
      <div style="font-size:20px;font-weight:900;margin-bottom:4px">${appSet.rxAppName||'Digital RX Pro'}</div>
      <div style="font-size:11px;opacity:0.5;margin-bottom:16px">${appSet.rxAppUrl||''}</div>
      <button onclick="launchRxApp()" style="display:inline-flex;align-items:center;gap:8px;background:#fff;color:#312e81;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:800;cursor:pointer;border:none;box-shadow:0 4px 14px rgba(0,0,0,0.25);transition:all 0.2s;font-family:var(--font)" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
        💊 Open ${appSet.rxAppName||'Digital RX Pro'} →
      </button>
    </div>`;
  } // end role check for Rx launcher

  // ── Queue Statistics (FIXED: real-time counts) ──
  html += `
    <div class="grid-4" style="margin-bottom:12px">
      <div class="stat-card"><div class="stat-val c-blue">${inQueueCount}</div><div class="stat-lbl">In Queue</div></div>
      <div class="stat-card"><div class="stat-val c-amber">${called.length + arrived.length}</div><div class="stat-lbl">Waiting/Called</div></div>
      <div class="stat-card"><div class="stat-val c-green">${done}</div><div class="stat-lbl">Completed</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--mono-color,var(--text))">${getAvgConsultDuration()} min</div><div class="stat-lbl">Avg Consult</div></div>
    </div>`;

  // ── Active Consultation Panel (enterprise card) ──
  if (inCons) {
    const pi = getPriorityInfo(inCons.type);
    const hasRefs = patientReferences.filter(r=>r.patientToken===inCons.token).length;
    html += `
    <div class="card" style="border:2px solid var(--accent);background:linear-gradient(135deg,#f0f4ff,#e8eeff);margin-bottom:12px">
      <div class="incons-badge" style="background:var(--accent);color:#fff;display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:20px;font-size:10px;font-weight:800;margin-bottom:12px;letter-spacing:0.07em"><div class="pulse-dot" style="background:#fff"></div> IN CONSULTATION</div>
      <div style="display:flex;align-items:flex-start;gap:14px">
        <div style="width:56px;height:56px;border-radius:14px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;flex-shrink:0;font-family:var(--mono)">#${inCons.token}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:17px;font-weight:800;color:var(--text)">${inCons.name}</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">
            📞 ${inCons.phone||'—'} &nbsp;·&nbsp; ${inCons.age||'?'}${inCons.gender} &nbsp;·&nbsp; <span style="color:var(--amber);font-weight:700">${pi.label}</span>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">
            via ${inCons.addedBy||'—'} &nbsp;·&nbsp; Reg. ${inCons.addedAt||'—'}
            ${inCons.notes ? `&nbsp;·&nbsp; <em>${inCons.notes}</em>` : ''}
            ${hasRefs ? `&nbsp;·&nbsp; <span style="color:var(--purple);font-weight:700">📁 ${hasRefs} doc(s)</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text2);margin-top:3px">🩺 ${currentDoctor?.name||'Doctor'} &nbsp;·&nbsp; Started: ${inCons.consultation_started_at||'—'}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="incons-timer" id="doc-timer" style="color:var(--accent2);font-size:28px;font-weight:900;font-family:var(--mono)">${liveDur?formatDuration(liveDur):'0:00'}</div>
          <div style="font-size:10px;color:var(--accent);font-weight:600">Running</div>
        </div>
      </div>
      ${canDo('canComplete') ? `
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        <button class="btn-complete-big" style="flex:2;min-width:160px" onclick="completeConsultation(${inCons.token})">✔ Complete Consultation</button>
        <button class="btn btn-secondary" style="flex:1;min-width:90px;font-size:12px;padding:10px" onclick="holdPatient(${inCons.token})">⏸ Hold</button>
        <button class="btn btn-doc" style="flex:1;min-width:90px;font-size:12px;padding:10px" onclick="openRefModalForPatient(${inCons.token})">📎 Docs</button>
        <button class="btn btn-secondary" style="flex:1;min-width:90px;font-size:12px;padding:10px" onclick="openBillingModal(${inCons.token})">💳 Bill</button>
      </div>` : `<div class="alert alert-warning" style="margin-top:10px;font-size:11px">⛔ Consultation complete করতে Doctor বা Super Admin লাগবে।</div>`}
    </div>`;
  } else {
    html += `<div class="alert alert-success" style="margin-bottom:12px">✅ No active consultation — ready for next patient.</div>`;
  }

  // ── Next Patient Quick Action ──
  if (nextP && nextP.token !== inCons?.token) {
    const pi = getPriorityInfo(nextP.type);
    html += `
    <div class="card" style="border:1.5px solid var(--green);background:var(--green-soft);margin-bottom:12px">
      <div style="display:inline-flex;align-items:center;gap:5px;background:var(--green);color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:20px;letter-spacing:0.07em;margin-bottom:10px">▶ NEXT PATIENT</div>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="token-box ${pi.cls}">${nextP.token}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:14px">${nextP.name}</div>
          <div style="font-size:11px;color:var(--text2)">📞 ${nextP.phone||'—'} &nbsp;·&nbsp; ${nextP.age||'?'}${nextP.gender} &nbsp;·&nbsp; ${pi.label}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:1px">via ${nextP.addedBy||'—'} · ${nextP.addedAt||''}</div>
        </div>
        ${getStatusChip(nextP.status)}
      </div>
      <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap">
        ${nextP.status==='waiting' ? `<button class="btn btn-arrive" onclick="markArrived(${nextP.token})">✓ Mark Arrived</button>` : ''}
        ${nextP.status==='arrived' ? `<button class="btn btn-call"   onclick="callPatient(${nextP.token})">📣 Call Patient</button>` : ''}
        ${nextP.status==='called'  ? renderStartBtn(nextP.token) : ''}
        ${nextP.status==='called'  ? `<button class="btn btn-call" onclick="callPatient(${nextP.token})">🔁 Recall</button>` : ''}
        ${['waiting','arrived','called'].includes(nextP.status) ? `<button class="btn btn-noshow" onclick="markNoShow(${nextP.token})">✗ No Show</button>` : ''}
        ${['waiting','arrived'].includes(nextP.status) ? `<button class="btn btn-cancel" onclick="openSkipModal(${nextP.token})">⏭ Skip</button>` : ''}
      </div>
    </div>`;
  }

  // ── Upcoming Queue (called + arrived + next 5 waiting) ──
  const upcoming = [...called, ...arrived, ...waiting].filter(p=>p!==nextP).slice(0,6);
  if (upcoming.length > 0) {
    html += `<div class="card" style="margin-bottom:12px">
      <div class="card-title">📋 Upcoming Queue (${called.length + arrived.length + waiting.length} active)</div>
      ${upcoming.map((p,i) => {
        const pi2 = getPriorityInfo(p.type);
        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
          <div class="token-box ${pi2.cls}" style="width:34px;height:34px;font-size:13px">${p.token}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:12px">${p.name} <span style="font-size:10px;color:var(--text3)">${p.age||'?'}${p.gender}</span></div>
            <div style="font-size:10px;color:var(--text3)">${getStatusChip(p.status)} ${pi2.label}</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0">
            ${p.status==='waiting'  ? `<button class="btn btn-arrive" style="font-size:10px;padding:4px 8px" onclick="markArrived(${p.token})">✓</button>` : ''}
            ${p.status==='arrived'  ? `<button class="btn btn-call"   style="font-size:10px;padding:4px 8px" onclick="callPatient(${p.token})">📣</button>` : ''}
            ${p.status==='called'   ? renderStartBtn(p.token) : ''}
            ${['waiting','arrived','called'].includes(p.status) ? `<button class="btn btn-noshow" style="font-size:10px;padding:4px 8px" onclick="markNoShow(${p.token})">✗</button>` : ''}
          </div>
        </div>`;
      }).join('')}
      ${upcoming.length < called.length + arrived.length + waiting.length - (nextP?1:0) ? `<div style="font-size:10px;color:var(--text3);text-align:center;padding-top:6px">+ ${called.length+arrived.length+waiting.length-(nextP?1:0)-upcoming.length} more — see Queue tab</div>` : ''}
    </div>`;
  }

  // ── Doctor Status + Stats ──
  html += `
    <div class="grid-2">
      <div class="card">
        <div class="card-title">🩺 Doctor Status — <strong style="color:${isDoctorPresent()?'var(--green)':'var(--amber)'}">${ds.label}</strong></div>
        <button class="btn-register" style="background:${isDoctorPresent()?'linear-gradient(135deg,#0a7a56,var(--green))':'linear-gradient(135deg,var(--accent2),var(--accent))'};margin-bottom:10px;padding:12px" onclick="setDoctorStatus('inchamber')">
          ${isDoctorPresent() ? '✅ In Chamber (Active)' : '✅ Doctor Arrived — Mark In Chamber'}
        </button>
        <div class="grid-2">
          ${['arriving','delayed','break','closed'].map(s => `<button class="btn btn-secondary" style="${doctorStatus===s?'border-color:var(--accent);background:var(--accent-soft);color:var(--accent2)':''}" onclick="setDoctorStatus('${s}')">${{arriving:'🚗 Arriving',delayed:'⏳ Delayed',break:'☕ Break',closed:'🔴 Closed'}[s]}</button>`).join('')}
        </div>
        ${!isDoctorPresent() ? `<div class="alert alert-warning" style="margin-top:10px;font-size:11px">⚠️ Consultation শুরু করতে Doctor-কে In Chamber করুন।</div>` : ''}
      </div>
      <div class="card">
        <div class="card-title">📊 Today's Statistics</div>
        ${[['Waiting',waiting.length,'var(--amber)'],['Called',called.length,'var(--accent)'],['In Consult',inCons?1:0,'var(--purple)'],['Seen',done,'var(--green)'],['No Shows',noshow,'var(--red)'],['Emergencies',patients.filter(p=>p.type==='emergency').length,'var(--red)'],['Doc Refs',patients.filter(p=>p.type==='docref').length,'var(--purple)'],['Avg Duration',getAvgConsultDuration()+' min','var(--text)'],['Documents',patientReferences.length,'var(--teal)']].map(([l,v,c])=>`<div style="display:flex;justify-content:space-between;font-size:12px;line-height:2.2;color:var(--text2)"><span>${l}</span><strong style="color:${c}">${v}</strong></div>`).join('')}
      </div>
    </div>`;

  return html;
}

/// UPDATED SECTION — launchRxApp: uses doctor-specific URL if set, falls back to global settings
function launchRxApp() {
  const s = loadAppSettings();
  // Doctor entity may have own prescription URL (Fix #12 doctor entity upgrade)
  const url = currentDoctor?.prescriptionSoftwareUrl || s.rxAppUrl || 'https://digitalrxpro.com';
  const name = s.rxAppName || 'Digital RX Pro';
  logAction('modify','💊','Rx App launched',`${name} opened by ${currentUser?.name}.`);
  window.open(url, '_blank', 'noopener,noreferrer');
}
/// UPDATED SECTION — setDoctorStatus: persists per-doctor status in _doctorStatusMap
function setDoctorStatus(status) {
  const prev = doctorStatus;
  doctorStatus = status;
  if (currentDoctor?.id) _doctorStatusMap[currentDoctor.id] = status;
  const ds = doctorStatuses[status]||doctorStatuses.arriving;
  const chip = document.getElementById('doc-status-chip');
  const txt  = document.getElementById('doc-status-text');
  if (chip) chip.className = 'doc-status-chip '+ds.cls;
  if (txt)  txt.textContent = ds.label;
  if (prev!==status) {
    logAction('modify','🩺','Doctor status changed',`${doctorStatuses[prev]?.label||prev} → ${ds.label}`);
    syncState();
  }
  render();
}

// ═══════════════════════════════════════════════════
// REFERENCES TAB
// ═══════════════════════════════════════════════════
const REF_CAT_INFO = {
  prescription: {label:'Prescription',cls:'cat-prescription',icon:'📋'},
  lab:          {label:'Lab Report',cls:'cat-lab',icon:'🧪'},
  scan:         {label:'Scan/MRI',cls:'cat-scan',icon:'🩻'},
  ecg:          {label:'ECG',cls:'cat-ecg',icon:'💓'},
  discharge:    {label:'Discharge',cls:'cat-discharge',icon:'🏥'},
  other:        {label:'Other',cls:'cat-other',icon:'📄'},
};
let _refCatFilter = 'all', _refSearch = '', _refPatFilter = 'all';

function renderRefs() {
  let refs = patientReferences;
  if (_refCatFilter!=='all') refs = refs.filter(r=>r.category===_refCatFilter);
  if (_refPatFilter!=='all') refs = refs.filter(r=>r.patientToken===parseInt(_refPatFilter));
  if (_refSearch) refs = refs.filter(r=>(r.patientName||'').toLowerCase().includes(_refSearch.toLowerCase())||(r.notes||'').toLowerCase().includes(_refSearch.toLowerCase()));

  const cats = ['all','prescription','lab','scan','ecg','discharge','other'];
  const catCounts = {}; cats.slice(1).forEach(c=>catCounts[c]=patientReferences.filter(r=>r.category===c).length);

  return `
    <div class="alert alert-purple">📁 Patient document references — Prescriptions, lab reports, scans, ECG, discharge summaries.</div>
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="openRefModal()">📎 Upload Reference</button>
        <input type="text" class="form-input" placeholder="Search patient or notes..." style="flex:1;min-width:140px" value="${_refSearch}" oninput="_refSearch=this.value;render()" />
        <select class="form-select" style="width:auto" onchange="_refPatFilter=this.value;render()">
          <option value="all">All Patients</option>
          ${patients.map(p=>`<option value="${p.token}" ${_refPatFilter==p.token?'selected':''}>#${p.token} ${p.name}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
        ${cats.map(c=>`<button onclick="_refCatFilter='${c}';render()" style="padding:5px 12px;border-radius:20px;border:1.5px solid ${_refCatFilter===c?'var(--accent)':'var(--border)'};background:${_refCatFilter===c?'var(--accent-soft)':'var(--surface2)'};color:${_refCatFilter===c?'var(--accent2)':'var(--text3)'};font-size:11px;font-weight:700;cursor:pointer;transition:all 0.15s;font-family:var(--font)">
          ${c==='all'?'All':REF_CAT_INFO[c]?.label} (${c==='all'?patientReferences.length:catCounts[c]||0})
        </button>`).join('')}
      </div>
    </div>
    ${refs.length===0 ? `<div class="card"><div class="empty-state"><div class="es-icon">📂</div><div class="es-title">No references found</div><div class="es-sub">Upload documents using the button above</div></div></div>` : ''}
    ${refs.map(ref => {
      const ci = REF_CAT_INFO[ref.category]||REF_CAT_INFO.other;
      const isImg = ref.fileType?.startsWith('image/'), isPdf = ref.fileType==='application/pdf';
      return `<div class="q-item">
        <div style="width:36px;height:36px;border-radius:9px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">${ci.icon}</div>
        <div class="q-info">
          <div class="q-name">${ref.fileName}</div>
          <div class="q-meta">
            <span class="chip ch-incons" style="background:var(--purple-soft);color:var(--purple)">${ci.label}</span>
            <strong>#${ref.patientToken} ${ref.patientName}</strong>
            · ${ref.uploadedAt}
            ${ref.notes?`· <em>${ref.notes}</em>`:''}
            · by ${ref.uploadedBy}
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          ${(isImg||isPdf)?`<button class="btn btn-arrive btn-sm" onclick="previewRef('${ref.id}')" style="font-size:10px;padding:5px 9px">👁 View</button>`:''}
          <button class="btn btn-noshow" onclick="deleteRef('${ref.id}')" style="font-size:10px;padding:5px 9px">🗑</button>
        </div>
      </div>`;
    }).join('')}
    ${refs.length>0?`<div style="font-size:11px;color:var(--text3);text-align:center;margin-top:8px">${refs.length} document(s)</div>`:''}
  `;
}

function openRefModal() {
  _refPatientToken=null; _pendingFile=null;
  document.getElementById('ref-patient-search').value='';
  document.getElementById('ref-notes').value='';
  document.getElementById('ref-category').value='prescription';
  document.getElementById('upload-area-txt').textContent='📂 Click to select file';
  filterRefPatients(); openModal('modal-upload-ref');
}
function openRefModalForPatient(token) {
  const p = patients.find(x=>x.token===token);
  if (!p) return;
  _refPatientToken=token; _pendingFile=null;
  document.getElementById('ref-patient-search').value=`#${token} — ${p.name}`;
  document.getElementById('ref-notes').value='';
  document.getElementById('ref-category').value='prescription';
  document.getElementById('upload-area-txt').textContent='📂 Click to select file';
  filterRefPatients(); openModal('modal-upload-ref');
}
function filterRefPatients() {
  const q = (document.getElementById('ref-patient-search')?.value||'').toLowerCase();
  const list = patients.filter(p=>!q||p.name.toLowerCase().includes(q));
  document.getElementById('ref-patient-list').innerHTML = list.slice(0,8).map(p =>
    `<div class="ps-item ${_refPatientToken===p.token?'sel':''}" onclick="selRefPat(${p.token},'${p.name.replace(/'/g,"\\'")}')">#${p.token} — ${p.name} <span style="color:var(--text3)">${p.age}${p.gender}</span></div>`
  ).join('') || '<div style="padding:10px;font-size:11px;color:var(--text3)">No patients</div>';
}
function selRefPat(token, name) {
  _refPatientToken=token;
  document.getElementById('ref-patient-search').value=`#${token} — ${name}`;
  filterRefPatients();
}
function handleRefFile(e) {
  const f = e.target.files[0]; if (!f) return;
  if (!['application/pdf','image/jpeg','image/png','image/jpg'].includes(f.type)) { alert('Only PDF, JPG, PNG allowed.'); return; }
  if (f.size>5*1024*1024) { alert('File must be under 5MB.'); return; }
  const r = new FileReader();
  r.onload = e2 => { _pendingFile={name:f.name,type:f.type,dataUrl:e2.target.result}; document.getElementById('upload-area-txt').textContent=`✅ ${f.name} (${(f.size/1024).toFixed(1)} KB)`; };
  r.readAsDataURL(f);
}
function saveReference() {
  if (!_refPatientToken) { alert('Select a patient.'); return; }
  if (!_pendingFile) { alert('Select a file.'); return; }
  const cat   = document.getElementById('ref-category').value;
  const notes = document.getElementById('ref-notes').value.trim();
  const pat   = patients.find(p=>p.token===_refPatientToken);
  const ref = { id:uid(), patientToken:_refPatientToken, patientName:pat?.name||'Unknown', category:cat, notes, fileName:_pendingFile.name, fileType:_pendingFile.type, fileDataUrl:_pendingFile.dataUrl, uploadedAt:nowTime(), uploadedBy:getActorName() };
  patientReferences.unshift(ref);
  logAction('add','📎','Document uploaded',`${_pendingFile.name} for ${ref.patientName} — ${cat}`);
  syncState(); updateNavBadges(); closeModal('modal-upload-ref');
  showToast('✓ Document uploaded','success'); render();
}
function deleteRef(id) {
  if (!confirm('Delete this document?')) return;
  const idx = patientReferences.findIndex(r=>r.id===id);
  if (idx>=0) { const r=patientReferences[idx]; logAction('modify','🗑','Document deleted',`${r.fileName} for ${r.patientName}`); patientReferences.splice(idx,1); syncState(); updateNavBadges(); render(); }
}
function previewRef(id) {
  const ref = patientReferences.find(r=>r.id===id); if (!ref||!ref.fileDataUrl) { showToast('Preview not available (metadata only)','warning'); return; }
  document.getElementById('preview-title').textContent=ref.fileName;
  const c = document.getElementById('preview-content');
  if (ref.fileType.startsWith('image/')) c.innerHTML=`<img src="${ref.fileDataUrl}" style="max-width:100%;border-radius:var(--radius-sm)" />`;
  else c.innerHTML=`<iframe src="${ref.fileDataUrl}" style="width:100%;height:380px;border:none;border-radius:var(--radius-sm)"></iframe>`;
  openModal('modal-preview');
}

// ═══════════════════════════════════════════════════
// TV DISPLAY
// ═══════════════════════════════════════════════════
function renderDisplay() {
  const current  = patients.find(p=>p.status==='incons');
  const nextOnes = patients.filter(p=>['called','arrived','waiting'].includes(p.status)&&p!==current).slice(0,5);
  const ds       = doctorStatuses[doctorStatus]||doctorStatuses.arriving;
  const liveD    = current ? getLiveConsultDuration(current.token) : null;
  const appSet   = loadAppSettings();
  const tvDotMap = {arriving:'amber',inchamber:'green',delayed:'red',closed:'gray',break:'pink'};
  const tvDot    = tvDotMap[doctorStatus]||'gray';
  const done     = patients.filter(p=>p.status==='completed').length;
  const waiting  = getActiveCount();
  const total    = patients.length;

  /// UPDATED SECTION — TV Display: fully dynamic doctor names from currentDoctor entity (Fix #6 Bengali TV name bug)
  const docBn = currentDoctor?.nameBn || appSet.docNameBn || currentDoctor?.name || 'ডাঃ. ডাক্তার';
  const docEn = currentDoctor?.nameEn || appSet.docNameEn || currentDoctor?.name || 'Doctor';
  const chamberName = currentDoctor?.chamberName || appSet.chamberName || currentDoctor?.name + ' Chamber' || 'Chamber';
  const location    = appSet.chamberLocation || 'Dinajpur';
  const roomNum     = currentDoctor?.room || currentDoctor?.chamberNumber || '—';

  const now = new Date();
  const daysBn   = ['রবিবার','সোমবার','মঙ্গলবার','বুধবার','বৃহস্পতিবার','শুক্রবার','শনিবার'];
  const monthsBn = ['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];
  const dateBn   = `${daysBn[now.getDay()]}, ${now.getDate()} ${monthsBn[now.getMonth()]} ${now.getFullYear()}`;
  const statusBnMap = {arriving:'আসছেন শীঘ্রই',inchamber:'চেম্বারে আছেন',delayed:'বিলম্বিত',closed:'চেম্বার বন্ধ',break:'বিরতিতে'};
  const statusEnMap = {arriving:'Arriving Soon',inchamber:'In Chamber',delayed:'Delayed',closed:'Closed',break:'On Break'};

  // UPDATED SECTION — TV Display ticker with dynamic Bengali announcement (Fix #7)
  const calledPatient = patients.find(p => p.status === 'called');
  const annoTicker = calledPatient
    ? { bn: makeBanglaAnnouncement(calledPatient.token, calledPatient.name, calledPatient.type==='emergency', docBn), en: `Token ${calledPatient.token} — ${calledPatient.name}` }
    : null;

  const tickers = [
    ...(annoTicker ? [annoTicker] : []),
    {bn:`${docBn} — ${statusBnMap[doctorStatus]||'চেম্বারে আছেন'}`, en:`(${docEn} — ${statusEnMap[doctorStatus]||'In Chamber'})`},
    {bn:'দয়া করে সিরিয়াল অনুযায়ী অপেক্ষা করুন',en:'(Please wait according to serial)'},
    {bn:'মোবাইল ফোন সাইলেন্ট মোডে রাখুন',en:'(Please keep phones on silent)'},
    {bn:'সিরিয়াল ডাকার পর কক্ষে প্রবেশ করুন',en:'(Enter only when called)'},
    {bn:'শিশু ও বয়স্কদের অগ্রাধিকার দেওয়া হবে',en:'(Priority for children & elderly)'},
    {bn:'ধন্যবাদ, আপনার সহযোগিতার জন্য',en:'(Thank you for your cooperation)'},
  ];
  const doubleTickers = [...tickers,...tickers];

  return `
    <div class="tv-wrap" id="tv-root" style="font-family:var(--font-bn),'DM Sans',sans-serif">
      <button class="tv-back" onclick="tvExit()">✕ Back</button>
      <button class="tv-fs" id="tv-fs-btn" onclick="tvToggleFs()">⛶ Fullscreen</button>

      <div class="tv-top">
        <div class="tv-top-left">
          <div class="tv-logo">MQ</div>
          <div>
            <div class="tv-name bn">${chamberName}</div>
            <div class="tv-sub">${currentDoctor?.qualifications||'Diagnostic Centre'} · ${location}</div>
          </div>
        </div>
        <div class="tv-top-right">
          <div class="tv-clock" id="tv-clock">${now.toLocaleTimeString('en-BD')}</div>
          <div class="tv-date bn" id="tv-date">${dateBn}</div>
        </div>
      </div>

      <div class="tv-body">
        <div class="tv-left">
          ${current ? `<div class="tv-pulse-ring"></div><div class="tv-pulse-ring"></div><div class="tv-pulse-ring"></div>` : ''}
          <div class="tv-lbl-bn bn">বর্তমান সিরিয়াল</div>
          <div class="tv-lbl-en">(CURRENT SERIAL)</div>
          <div class="tv-big-num ${current?(current.type==='emergency'?'emg':''):'empty'}">
            ${current ? current.token : '—'}
          </div>
          ${current ? `<div style="margin-top:8px;font-size:clamp(14px,1.8vw,22px);font-weight:800;color:rgba(255,255,255,0.85);font-family:var(--font-bn);text-align:center;line-height:1.3">${current.name}</div>` : ''}
          ${current && current.type==='emergency' ? `<div style="margin-top:8px;background:rgba(248,113,113,0.18);border:1px solid rgba(248,113,113,0.5);border-radius:8px;padding:4px 14px;color:#f87171;font-size:14px;font-weight:700;letter-spacing:0.06em">⚠ <span class="bn">জরুরি রোগী (Emergency)</span></div>` : ''}
          ${current && liveD ? `<div style="font-size:14px;color:rgba(96,165,250,0.5);margin-top:8px">⏱ ${formatDuration(liveD)}</div>` : ''}
          ${!current ? `<div style="font-size:16px;color:rgba(255,255,255,0.18);margin-top:10px;text-align:center;font-family:var(--font-bn)">${isDoctorPresent()?'রোগীর জন্য অপেক্ষা করছেন':statusBnMap[doctorStatus]||''}</div>` : ''}
          <div class="tv-doc-info">
            <div class="tv-doc-name-bn bn">${docBn}</div>
            <div class="tv-doc-name-en">(${docEn})</div>
            <div class="tv-chamber-inf bn">🏥 কক্ষ ${roomNum} — ${location}</div>
          </div>
        </div>

        <div class="tv-right">
          <div class="tv-next-block">
            <div class="tv-next-hdr">
              <div class="tv-next-hdr-bn bn">পরবর্তী সিরিয়াল</div>
              <div class="tv-next-hdr-en">(Next Serials)</div>
            </div>
            ${nextOnes.length>0 ? nextOnes.map((p,i)=>{
              const stBn = p.status==='called'?'📣 ডাকা হয়েছে':p.status==='arrived'?'✓ উপস্থিত':'⏳ অপেক্ষারত';
              const stEn = p.status==='called'?'Called':p.status==='arrived'?'Arrived':'Waiting';
              const emgBadge = p.type==='emergency' ? `<span style="font-size:10px;background:rgba(248,113,113,0.25);color:#f87171;padding:1px 6px;border-radius:4px;margin-left:4px">জরুরি</span>` : '';
              return `<div class="tv-next-row">
                <div class="tv-next-num">${p.token}</div>
                <div class="tv-next-info">
                  <div class="tv-next-lbl bn" style="display:flex;align-items:center;gap:4px">${i===0?'▶ পরের রোগী':`${toBengaliDigit(i+1)} নং সিরিয়াল`}${emgBadge}</div>
                  <div class="tv-next-status bn" style="font-size:clamp(10px,1.1vw,13px)">${p.name} · ${stBn}</div>
                </div>
              </div>`;
            }).join('') : `<div style="text-align:center;padding:20px;color:rgba(255,255,255,0.18);font-size:13px;font-family:var(--font-bn)">কোনো পরবর্তী সিরিয়াল নেই<br><span style="font-size:11px;font-family:var(--font)">(No next serials)</span></div>`}
          </div>

          <div class="tv-status-block">
            <div class="tv-status-row">
              <div class="tv-sdot tvd-${tvDot}"></div>
              <div class="tv-status-txt bn">ডাক্তার: <strong>${statusBnMap[doctorStatus]||''}</strong> <span style="opacity:0.4;font-size:0.85em">(${statusEnMap[doctorStatus]||''})</span></div>
            </div>
            <div class="tv-stats-mini">
              <div class="bn">মোট:<span>${total}</span></div>
              <div class="bn">সম্পন্ন:<span>${done}</span></div>
              <div class="bn">অপেক্ষা:<span>${waiting}</span></div>
            </div>
          </div>
          <div style="flex:1"></div>
          <div style="text-align:center;font-size:11px;color:rgba(255,255,255,0.1);line-height:1.9;font-family:var(--font-bn)">
            সিরিয়াল স্বয়ংক্রিয়ভাবে আপডেট হয়<br><span style="font-family:var(--font)">(Queue updates automatically)</span>
          </div>
        </div>
      </div>

      <div class="tv-ticker">
        <div class="tv-ticker-track">
          ${doubleTickers.map(t=>`<span class="tv-ticker-item bn"><span class="tv-ticker-dot"></span>${t.bn} <span style="color:rgba(255,255,255,0.35);font-family:var(--font)">${t.en}</span></span>`).join('')}
        </div>
      </div>
    </div>
  `;
}
function tvExit() { if(document.fullscreenElement)document.exitFullscreen().catch(()=>{}); switchTab('queue'); }
function tvToggleFs() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().then(()=>{ const b=document.getElementById('tv-fs-btn'); if(b)b.textContent='⛶ Exit Fullscreen'; }).catch(()=>{});
  else document.exitFullscreen().then(()=>{ const b=document.getElementById('tv-fs-btn'); if(b)b.textContent='⛶ Fullscreen'; }).catch(()=>{});
}
function startTVClock() {
  if (_tvClockInterval) clearInterval(_tvClockInterval);
  _tvClockInterval = setInterval(() => {
    const ce=document.getElementById('tv-clock'), de=document.getElementById('tv-date');
    if (!ce) { clearInterval(_tvClockInterval); _tvClockInterval=null; return; }
    const n=new Date();
    ce.textContent=n.toLocaleTimeString('en-BD');
    if (de) {
      const days=['রবিবার','সোমবার','মঙ্গলবার','বুধবার','বৃহস্পতিবার','শুক্রবার','শনিবার'];
      const months=['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];
      de.textContent=`${days[n.getDay()]}, ${n.getDate()} ${months[n.getMonth()]} ${n.getFullYear()}`;
    }
    const inCons=patients.find(p=>p.status==='incons');
    if (inCons&&consultStartTimestamps[inCons.token]) {
      const d=Date.now()-consultStartTimestamps[inCons.token];
      const el=document.querySelector('.tv-left div[style*="font-size:14px"]');
      if(el)el.textContent='⏱ '+formatDuration(d);
    }
  }, 1000);
}
function startTVAutoRefresh() {
  if (_tvAutoRefresh) clearInterval(_tvAutoRefresh);
  _tvAutoRefresh = setInterval(() => {
    if (currentTab!=='display') { clearInterval(_tvAutoRefresh); _tvAutoRefresh=null; return; }
    const m=document.getElementById('main-content');
    if (m) { m.innerHTML=renderDisplay(); startTVClock(); }
  }, 5000);
}

// ═══════════════════════════════════════════════════
// USERS TAB
// ═══════════════════════════════════════════════════
function renderUsers() {
  if (!canDo('canManageUsers')) return `<div class="alert alert-warning">⛔ User management শুধুমাত্র Super Admin করতে পারবেন।</div>`;
  userStore = loadUsers();
  doctorStore = loadDoctors(); // always fresh so assigned doctor names are current
  const byRole = {};
  Object.keys(ROLE_META).forEach(r => { byRole[r] = userStore.filter(u=>u.role===r); });

  return `
    <div class="alert alert-info">👥 Enterprise user management — সকল role-এর user এখানে manage করুন। PIN এবং username পরিবর্তন করা যাবে।</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div class="section-ttl">All Users (${userStore.length})</div>
      <button class="btn btn-primary" onclick="openAddUser()">➕ Add User</button>
    </div>
    ${Object.entries(ROLE_META).map(([role, rm]) => {
      const roleUsers = byRole[role] || [];
      if (!roleUsers.length) return '';
      return `<div class="card">
        <div class="card-title">${rm.icon} ${rm.label} (${roleUsers.length})</div>
        ${roleUsers.map(u => `
          <div class="user-card ${u.active?'':'user-inactive'}">
            <div class="user-avatar ${getRoleAvatarCls(u.role)}">${getRoleIcon(u.role)}</div>
            <div class="user-info">
              <div class="user-name">${u.name}</div>
              <div class="user-meta">
                <span class="active-dot ${u.active?'dot-on':'dot-off'}"></span>
                <code style="background:var(--surface2);padding:1px 6px;border-radius:4px;font-size:10px;font-family:var(--mono)">@${u.username}</code>
                <span class="role-badge ${getRoleBadgeCls(u.role)}">${rm.label}</span>
                ${u.notes ? `<span style="font-size:10px;color:var(--text3)">${u.notes}</span>` : ''}
                ${u.assignedDoctorId ? (()=>{ const _d=doctorStore.find(d=>d.id===u.assignedDoctorId); return `<span style="font-size:10px;color:var(--teal)">→ ${_d ? (_d.nameBn||_d.name) + ' (' + (_d.nameEn||_d.name) + ')' + (_d.room ? ' · ' + _d.room : '') : u.assignedDoctorId}</span>`; })() : ''}
              </div>
            </div>
            <div style="display:flex;gap:5px;flex-shrink:0">
              <button class="btn btn-secondary" style="font-size:10px;padding:5px 9px" onclick="openEditUser('${u.id}')">✏️ Edit</button>
              <button class="btn ${u.active?'btn-noshow':'btn-arrive'}" style="font-size:10px;padding:5px 9px" onclick="toggleUserActive('${u.id}')">${u.active?'Deactivate':'Activate'}</button>
              ${u.id!=='u1'?`<button class="btn btn-danger" style="font-size:10px;padding:5px 9px" onclick="deleteUser('${u.id}')">🗑</button>`:''}
            </div>
          </div>
        `).join('')}
      </div>`;
    }).join('')}
    <div class="card">
      <div class="card-title">👨‍⚕️ Doctor Registry</div>
      ${doctorStore.map(d => `
        <div class="user-card">
          <div class="user-avatar ua-doctor">🩺</div>
          <div class="user-info">
            <div class="user-name">${d.name}</div>
            <div class="user-meta"><span style="font-size:11px;color:var(--text3)">${d.qualifications}</span></div>
          </div>
          <span class="role-badge rb-doctor">Doctor</span>
        </div>
      `).join('')}
      <div class="alert alert-info" style="margin-top:10px;font-size:11px">Doctor registry Settings tab থেকে manage করুন।</div>
    </div>
  `;
}

function openAddUser() {
  editingUserId=null;
  document.getElementById('user-edit-title').textContent='➕ Add New User';
  document.getElementById('ue-save-btn').textContent='💾 Add User';
  ['ue-name','ue-username','ue-pin','ue-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('ue-role').value='assistant';
  doctorStore = loadDoctors();
  fillDoctorSelector(null);
  showDoctorField();
  openModal('modal-user-edit');
}
function openEditUser(id) {
  userStore=loadUsers(); doctorStore=loadDoctors();
  const u=userStore.find(x=>x.id===id); if(!u) return;
  editingUserId=id;
  document.getElementById('user-edit-title').textContent='✏️ Edit User';
  document.getElementById('ue-save-btn').textContent='💾 Update User';
  document.getElementById('ue-name').value=u.name;
  document.getElementById('ue-username').value=u.username;
  document.getElementById('ue-pin').value=u.pin;
  document.getElementById('ue-role').value=u.role;
  document.getElementById('ue-notes').value=u.notes||'';
  fillDoctorSelector(u.assignedDoctorId);
  showDoctorField();
  openModal('modal-user-edit');
}
/// UPDATED SECTION — fillDoctorSelector: always reload from localStorage, proper nameBn/nameEn/room format
function fillDoctorSelector(selectedId) {
  doctorStore = loadDoctors(); // always fresh from localStorage
  const sel = document.getElementById('ue-assigned-doctor');
  if (!sel) return;
  const activeDocs = doctorStore.filter(d => d.active);
  sel.innerHTML = '<option value="">— All Doctors (কোনো নির্দিষ্ট Doctor নয়) —</option>';
  activeDocs.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    const bn   = d.nameBn || d.name;
    const en   = d.nameEn || d.name;
    const room = d.room   ? ' · ' + d.room : '';
    o.textContent = bn + ' (' + en + ')' + room;
    if (selectedId && selectedId === d.id) o.selected = true;
    sel.appendChild(o);
  });
  if (activeDocs.length === 0) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— কোনো Active Doctor নেই —'; o.disabled = true;
    sel.appendChild(o);
  }
}
function showDoctorField() {
  // Always show doctor assignment for all roles — Super Admin can still be assigned to a doctor's context
  const field = document.getElementById('ue-doctor-field');
  if (field) field.style.display = 'block';
}
function saveUserEdit() {
  const name    = document.getElementById('ue-name').value.trim();
  const username= document.getElementById('ue-username').value.trim().toLowerCase().replace(/\s+/g,'_');
  const pin     = document.getElementById('ue-pin').value.trim();
  const role    = document.getElementById('ue-role').value;
  const notes   = document.getElementById('ue-notes').value.trim();
  const docId   = document.getElementById('ue-assigned-doctor').value||null;
  if (!name||!username||!pin) { alert('Name, username, and PIN required.'); return; }
  if (!/^\d{4,6}$/.test(pin)) { alert('PIN must be 4-6 digits.'); return; }
  userStore=loadUsers();
  if (!editingUserId) {
    if (userStore.find(u=>u.username===username)) { alert('Username already exists.'); return; }
    const newUser={ id:'u'+Date.now(), username, name, role, pin, active:true, notes, assignedDoctorId:docId };
    userStore.push(newUser);
    logAction('user','👤','User created',`${name} (${username}) as ${ROLE_META[role].label}`);
  } else {
    const u=userStore.find(x=>x.id===editingUserId); if(!u) return;
    if (username!==u.username && userStore.find(x=>x.username===username&&x.id!==editingUserId)) { alert('Username already taken.'); return; }
    Object.assign(u,{name,username,pin,role,notes,assignedDoctorId:docId});
    logAction('user','✏️','User updated',`${name} (${username}) updated.`);
  }
  saveUsers(userStore);
  closeModal('modal-user-edit'); showToast('✓ User saved','success'); render();
}
function toggleUserActive(id) {
  userStore=loadUsers();
  const u=userStore.find(x=>x.id===id); if(!u) return;
  if (id==='u1'&&u.active) { alert('Cannot deactivate Super Admin.'); return; }
  u.active=!u.active;
  saveUsers(userStore);
  logAction('user',u.active?'✅':'🚫',u.active?'User activated':'User deactivated',`${u.name} (${u.username})`);
  showToast(`✓ ${u.name} ${u.active?'activated':'deactivated'}`,'info'); render();
}
function deleteUser(id) {
  if (!confirm('Delete this user permanently?')) return;
  userStore=loadUsers();
  const u=userStore.find(x=>x.id===id); if(!u) return;
  const idx=userStore.indexOf(u); userStore.splice(idx,1);
  saveUsers(userStore);
  logAction('user','🗑','User deleted',`${u.name} (${u.username}) removed.`);
  showToast('✓ User deleted','info'); render();
}

// ═══════════════════════════════════════════════════
// SCHEDULE TAB
// ═══════════════════════════════════════════════════
function renderSchedule() {
  scheduleConf = loadScheduleConf();
  const today = todayISO();
  const days = Array.from({length:10},(_,i)=>addDays(today,i));
  const doctors = doctorStore.filter(d=>d.active);

  return `
    <div class="alert alert-info">📅 Schedule daily patient limits and reserved slot intervals per doctor.</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div class="section-ttl">Day-wise Configuration</div>
      <button class="btn btn-primary" onclick="openScheduleModal()">➕ Configure Day</button>
    </div>
    ${doctors.map(doc => `
      <div class="card">
        <div class="card-title">🩺 ${doc.name}</div>
        ${days.map(iso => {
          const sch = getSchedule(doc.id, iso);
          const fd  = formatDisplayDate(iso);
          const reg = iso===currentDate ? patients.length : '—';
          const isToday = iso===today;
          const hasCustom = scheduleConf[getScheduleKey(doc.id,iso)];
          return `<div class="day-config-row">
            <div>
              <div class="day-config-date">${isToday?'🔵 ':''}<strong>${fd.day}</strong>, ${fd.date} ${fd.month} ${iso===today?'(Today)':''}</div>
              <div class="day-config-meta">${hasCustom?'📌 Custom config':'Default config'}</div>
            </div>
            <div style="flex:1;text-align:center">
              <span style="font-size:20px;font-weight:900;color:var(--accent);font-family:var(--mono)">${sch.maxPatients}</span>
              <div style="font-size:10px;color:var(--text3)">max patients</div>
            </div>
            <div style="flex:1;text-align:center">
              <span style="font-size:14px;font-weight:700;color:var(--purple)">${sch.reservedInterval?'Every '+sch.reservedInterval+'th':'None'}</span>
              <div style="font-size:10px;color:var(--text3)">reserved slot</div>
            </div>
            <div style="flex:1;text-align:center;font-size:11px;color:var(--text3)">Registered: <strong>${reg}</strong></div>
            <div style="display:flex;gap:5px">
              <button class="btn btn-secondary" style="font-size:10px;padding:5px 9px" onclick="openScheduleModal('${doc.id}','${iso}')">✏️ Edit</button>
              ${hasCustom?`<button class="btn btn-noshow" style="font-size:10px;padding:5px 9px" onclick="resetSchedule('${doc.id}','${iso}')">Reset</button>`:''}
            </div>
          </div>`;
        }).join('')}
      </div>
    `).join('')}
  `;
}

function openScheduleModal(doctorId, isoDate) {
  const sel = document.getElementById('sch-doctor');
  doctorStore = loadDoctors(); // always fresh
  sel.innerHTML = doctorStore.filter(d=>d.active).map(d=>{
    const bn = d.nameBn || d.name;
    const room = d.room ? ' · ' + d.room : '';
    return `<option value="${d.id}" ${d.id===(doctorId||currentDoctor?.id)?'selected':''}>${bn}${room}</option>`;
  }).join('');
  const today = todayISO();
  document.getElementById('sch-date').value = isoDate || today;
  document.getElementById('sch-date').min = today;
  const sch = getSchedule(doctorId||currentDoctor?.id||'d1', isoDate||today);
  document.getElementById('sch-max').value = sch.maxPatients || 50;
  document.getElementById('sch-reserved').value = sch.reservedInterval || 5;
  openModal('modal-schedule-edit');
}
function saveScheduleConfig() {
  const docId = document.getElementById('sch-doctor').value;
  const iso   = document.getElementById('sch-date').value;
  const max   = parseInt(document.getElementById('sch-max').value);
  const res   = parseInt(document.getElementById('sch-reserved').value);
  if (!docId||!iso||!max) { alert('All fields required.'); return; }
  scheduleConf = loadScheduleConf();
  scheduleConf[getScheduleKey(docId,iso)] = { maxPatients: max, reservedInterval: res };
  saveScheduleConf(scheduleConf);
  const doc = doctorStore.find(d=>d.id===docId);
  logAction('modify','📅','Schedule configured',`${doc?.name||docId} — ${iso}: max ${max} patients, reserved every ${res||0} slots`);
  closeModal('modal-schedule-edit'); showToast('✓ Schedule saved','success'); render();
}
function resetSchedule(docId, iso) {
  if (!confirm('Reset to default config?')) return;
  scheduleConf = loadScheduleConf();
  delete scheduleConf[getScheduleKey(docId,iso)];
  saveScheduleConf(scheduleConf);
  showToast('✓ Reset to default','info'); render();
}

// ═══════════════════════════════════════════════════
// AUDIT TAB
// ═══════════════════════════════════════════════════
function renderAudit() {
  const bgMap={add:'ai-add',modify:'ai-modify',emergency:'ai-emergency',checkin:'ai-start',start:'ai-start',complete:'ai-complete',noshow:'ai-noshow',login:'ai-login',user:'ai-user'};
  return `
    <div class="alert alert-warning">🔒 Audit log — permanent, immutable, every operation timestamped.</div>
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>📋 Operation Log — ${currentDate} (${auditLog.length} entries)</span>
        <button class="btn btn-secondary" style="font-size:10px;padding:5px 9px" onclick="exportAuditCSV()">⬇ CSV</button>
      </div>
      <div class="scroll-list">
        ${auditLog.length===0?'<div class="empty-state"><div class="es-icon">📋</div><div class="es-title">No audit entries yet</div></div>':
        auditLog.map(a=>`
          <div class="audit-item">
            <div class="audit-icon ${bgMap[a.type]||'ai-add'}">${a.icon}</div>
            <div class="audit-content">
              <div class="audit-action">${a.action} <span style="font-size:11px;color:var(--text3);font-weight:400">by ${a.by}</span></div>
              <div class="audit-detail">${a.detail}</div>
              ${a.reason?`<div style="font-size:10px;color:var(--amber);margin-top:2px;font-weight:700">Reason: ${a.reason}</div>`:''}
            </div>
            <div class="audit-time">${a.time}</div>
          </div>
        `).join('')}
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════
// REPORTS TAB
// ═══════════════════════════════════════════════════
function renderReports() {
  const bySource={};
  patients.forEach(p=>{ bySource[p.source]=(bySource[p.source]||0)+1; });
  const total = patients.length||1;
  // Billing summary
  const totalFee = patients.reduce((s,p)=>s+(p.fee||0),0);
  const totalPaid = patients.reduce((s,p)=>s+(p.paid||0),0);
  const totalDue = totalFee - totalPaid;
  const paidCount = patients.filter(p=>p.payStatus==='paid').length;
  const unpaidCount = patients.filter(p=>p.payStatus==='unpaid'&&p.fee>0).length;

  // UPDATED SECTION — Reception/Staff Performance Analytics (Fix #3)
  const perfData = getReceptionPerformance();
  const staffEntries = Object.entries(perfData).sort((a,b) => b[1].total - a[1].total);
  const totalPatients = patients.length || 1;

  const perfHtml = staffEntries.length === 0 ? '<div style="color:var(--text3);font-size:12px">কোনো data নেই।</div>' :
    staffEntries.map(([staffName, data]) => {
      const pct = Math.round((data.total / totalPatients) * 100);
      const barColor = pct >= 50 ? 'var(--accent)' : pct >= 25 ? 'var(--green)' : 'var(--amber)';
      return `<div class="perf-staff-card">
        <div class="perf-staff-avatar" style="background:var(--accent-soft)">👤</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px;color:var(--text)">${staffName}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:1px">
            ${data.total} patients total
            ${data.emergency>0?`· 🚨 ${data.emergency} emergency`:''}
            ${data.followup>0?`· 🔄 ${data.followup} follow-up`:''}
            ${data.docref>0?`· ⭐ ${data.docref} doc-ref`:''}
            ${data.recall>0?`· ♻️ ${data.recall} recall`:''}
          </div>
          <div class="perf-bar-track" style="margin-top:5px">
            <div class="perf-bar-fill" style="width:${pct}%;background:${barColor}"></div>
          </div>
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div class="perf-count-big">${data.total}</div>
          <div style="font-size:10px;color:var(--text3)">${pct}%</div>
        </div>
      </div>`;
    }).join('');

  return `
    <div class="grid-4">
      <div class="stat-card"><div class="stat-val">${patients.length}</div><div class="stat-lbl">Total Registered</div></div>
      <div class="stat-card"><div class="stat-val c-green">${patients.filter(p=>p.status==='completed').length}</div><div class="stat-lbl">Completed</div></div>
      <div class="stat-card"><div class="stat-val c-amber">${getActiveCount()}</div><div class="stat-lbl">In Queue</div></div>
      <div class="stat-card"><div class="stat-val c-red">${patients.filter(p=>p.status==='noshow').length}</div><div class="stat-lbl">No Show</div></div>
    </div>
    <!-- UPDATED SECTION — Billing Summary Card -->
    <div class="card" style="border-left:4px solid var(--green)">
      <div class="card-title">💳 Billing Summary — ${currentDate}</div>
      <div class="grid-4">
        <div class="stat-card"><div class="stat-val c-green" style="font-size:20px">৳${totalFee.toLocaleString()}</div><div class="stat-lbl">Total Fee</div></div>
        <div class="stat-card"><div class="stat-val c-teal" style="font-size:20px">৳${totalPaid.toLocaleString()}</div><div class="stat-lbl">Collected</div></div>
        <div class="stat-card"><div class="stat-val c-red" style="font-size:20px">৳${totalDue.toLocaleString()}</div><div class="stat-lbl">Due</div></div>
        <div class="stat-card"><div class="stat-val c-amber">${unpaidCount}</div><div class="stat-lbl">Unpaid Patients</div></div>
      </div>
    </div>

    <!-- UPDATED SECTION — Reception/Staff Performance Analytics (Fix #3) -->
    <div class="card" style="border-left:4px solid var(--purple)">
      <div class="card-title">👥 Reception Performance Analytics</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:10px">প্রতিটি staff-এর exact patient count, emergency, follow-up, recall সহ বিস্তারিত।</div>
      ${perfHtml}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">Patient Source</div>
        ${Object.entries(bySource).map(([k,v])=>`
          <div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${k}</span><span>${v} patients (${Math.round(v/total*100)}%)</span></div>
            <div class="abar-track"><div class="abar-fill" style="width:${Math.round(v/total*100)}%;background:var(--accent)"></div></div>
          </div>
        `).join('')}
      </div>
      <div class="card">
        <div class="card-title">Priority Distribution</div>
        ${[['Regular','regular','var(--accent)'],['Emergency','emergency','var(--red)'],['Doc Ref','docref','var(--amber)'],['Follow-up','followup','var(--green)']].map(([l,k,c])=>{
          const n=patients.filter(p=>p.type===k).length;
          return `<div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${l}</span><span>${n} patients</span></div>
            <div class="abar-track"><div class="abar-fill" style="width:${Math.round(n/total*100)}%;background:${c}"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- SCHEMA v2 ANALYTICS: registrationSource + slotType breakdown -->
    ${(() => {
      const srcStats = getRegistrationSourceStats();
      const slotStats = getSlotTypeStats();
      const srcLabels = { walkin:'🚶 Walk-in', phone:'📞 Phone', online:'🌐 Online', referral:'👨‍⚕️ Referral', desk:'🏥 Desk/Reception' };
      const slotLabels = { normal:'🟦 Normal', reserved:'⭐ Reserved (filled)', doctor_priority:'👨‍⚕️ Doctor Priority', emergency:'🚨 Emergency' };
      const slotColors = { normal:'var(--accent)', reserved:'var(--purple)', doctor_priority:'var(--amber)', emergency:'var(--red)' };
      const srcTotal = Object.values(srcStats).reduce((a,b)=>a+b,0)||1;
      const slotTotal = Object.values(slotStats).reduce((a,b)=>a+b,0)||1;
      return `<div class="grid-2">
        <div class="card" style="border-left:4px solid var(--teal)">
          <div class="card-title">📍 Registration Channel <span style="font-size:10px;color:var(--text3);font-weight:400">(Schema v2)</span></div>
          ${Object.entries(srcStats).map(([k,v])=>{
            if (!v) return '';
            const pct = Math.round(v/srcTotal*100);
            return `<div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${srcLabels[k]||k}</span><span>${v} (${pct}%)</span></div>
              <div class="abar-track"><div class="abar-fill" style="width:${pct}%;background:var(--teal)"></div></div>
            </div>`;
          }).join('')}
        </div>
        <div class="card" style="border-left:4px solid var(--purple)">
          <div class="card-title">🎯 Slot Type Breakdown <span style="font-size:10px;color:var(--text3);font-weight:400">(Schema v2)</span></div>
          ${Object.entries(slotStats).map(([k,v])=>{
            if (!v) return '';
            const pct = Math.round(v/slotTotal*100);
            return `<div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${slotLabels[k]||k}</span><span>${v} (${pct}%)</span></div>
              <div class="abar-track"><div class="abar-fill" style="width:${pct}%;background:${slotColors[k]||'var(--accent)'}"></div></div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    })()}
    <div class="card">
      <div class="card-title">Daily Summary — ${currentDate} · ${currentDoctor?.name||'Doctor'}</div>
      <div style="font-size:12px;line-height:2.2;color:var(--text2)">
        ${[['Avg consultation time',getAvgConsultDuration()+' min'],['Completed',patients.filter(p=>p.status==='completed').length],['No Shows',patients.filter(p=>p.status==='noshow').length],['Emergencies',patients.filter(p=>p.type==='emergency').length],['Doc References',patients.filter(p=>p.type==='docref').length],['Recalled patients',patients.filter(p=>p.source==='recall').length],['Documents uploaded',patientReferences.length],['Audit entries',auditLog.length],['Total Fee','৳'+totalFee.toLocaleString()],['Total Collected','৳'+totalPaid.toLocaleString()],['Total Due','৳'+totalDue.toLocaleString()]].map(([l,v])=>`<div style="display:flex;justify-content:space-between"><span>${l}</span><strong>${v}</strong></div>`).join('')}
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary" onclick="exportPatientsCSV()">📄 Export Patients CSV</button>
        <button class="btn btn-secondary" onclick="exportAuditCSV()">🔒 Export Audit CSV</button>
        <button class="btn btn-primary"   onclick="exportMobileCSV()">📱 Mobile CSV</button>
        <button class="btn btn-secondary" style="background:var(--green-soft);border-color:var(--green);color:#065f46" onclick="exportMobileExcel()">📊 Mobile Excel</button>
        <button class="btn btn-secondary" onclick="copyAllMobiles()">📋 Copy All Numbers</button>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════
// SETTINGS TAB
// ═══════════════════════════════════════════════════
function loadAppSettings() {
  try { return JSON.parse(localStorage.getItem('mq_app_settings_v1')||'{}'); } catch(e) { return {}; }
}
function saveAppSettings(s) { localStorage.setItem('mq_app_settings_v1', JSON.stringify(s)); }

function renderSettings() {
  if (!canDo('canEditSchedule')) return `<div class="alert alert-warning">⛔ Settings শুধুমাত্র Doctor বা Super Admin পরিবর্তন করতে পারবেন।</div>`;
  const s = loadAppSettings();
  return `
    <div class="alert alert-info">⚙️ System settings — device-local storage.</div>

    <div class="settings-group">
      <div class="settings-group-header">💊 Prescription Software</div>
      <div class="settings-row">
        <div><div class="settings-label">App Name</div><div class="settings-sublabel">Doctor tab launcher</div></div>
        <div class="settings-control"><input class="settings-input" id="s-rxname" value="${s.rxAppName||'Digital RX Pro'}" /></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-label">App URL</div></div>
        <div class="settings-control"><input class="settings-input" id="s-rxurl" value="${s.rxAppUrl||'https://digitalrxpro.com'}" /></div>
      </div>
      <div class="settings-row">
        <div></div>
        <div class="settings-control" style="display:flex;gap:6px">
          <button class="btn-save-sm" onclick="applyRxSettings()">💾 Save</button>
          <button class="btn btn-secondary" style="font-size:11px" onclick="window.open(document.getElementById('s-rxurl').value,'_blank')">🧪 Test</button>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-header">🏥 Chamber Info</div>
      <div class="settings-row">
        <div><div class="settings-label">Chamber Name</div></div>
        <div class="settings-control"><input class="settings-input" id="s-chamber" value="${s.chamberName||'Dr. B. K. Bose Chamber'}" /></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-label">Location</div></div>
        <div class="settings-control"><input class="settings-input" id="s-location" value="${s.chamberLocation||'Dinajpur'}" /></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-label">Doctor Name (Bengali)</div><div class="settings-sublabel">TV Display-এ দেখাবে</div></div>
        <div class="settings-control"><input class="settings-input" id="s-docbn" value="${s.docNameBn||'ডাঃ. বি. কে. বোস'}" /></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-label">Doctor Name (English)</div><div class="settings-sublabel">TV Display subtitle</div></div>
        <div class="settings-control"><input class="settings-input" id="s-docen" value="${s.docNameEn||'Dr. B. K. Bose'}" /></div>
      </div>
      <div class="settings-row">
        <div></div>
        <div class="settings-control"><button class="btn-save-sm" onclick="applyChamberSettings()">💾 Save</button></div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-header">👥 Default Limits</div>
      <div class="settings-row">
        <div><div class="settings-label">Default Daily Limit</div><div class="settings-sublabel">Schedule tab-এ per-day override করা যাবে</div></div>
        <div class="settings-control"><input class="settings-input" type="number" id="s-deflimit" value="${s.defaultDailyLimit||50}" min="1" max="500" /></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-label">Default Reserved Interval</div><div class="settings-sublabel">e.g. 5 = every 5th slot reserved for doctor</div></div>
        <div class="settings-control">
          <select class="settings-input" id="s-defres">
            <option value="0" ${!s.defaultReservedInterval?'selected':''}>No reserved slots</option>
            <option value="5" ${s.defaultReservedInterval==5?'selected':''}>Every 5th slot</option>
            <option value="10" ${s.defaultReservedInterval==10?'selected':''}>Every 10th slot</option>
            <option value="15" ${s.defaultReservedInterval==15?'selected':''}>Every 15th slot</option>
          </select>
        </div>
      </div>
      <div class="settings-row">
        <div></div>
        <div class="settings-control"><button class="btn-save-sm" onclick="applyDefaultSettings()">💾 Save</button></div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-header">👨‍⚕️ Doctor Registry</div>
      <div class="settings-row" style="align-items:flex-start;flex-direction:column;gap:10px">
        <div style="width:100%">${renderDoctorRegistryList()}</div>
        <button class="btn btn-primary" style="font-size:11px;width:100%;margin-top:6px" onclick="openAddDoctor()">➕ Add New Doctor</button>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-header">💾 Data Management</div>
      <div class="settings-row">
        <div><div class="settings-label">Export Data</div></div>
        <div class="settings-control" style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-secondary" style="font-size:11px" onclick="exportPatientsCSV()">📄 Patients CSV</button>
          <button class="btn btn-secondary" style="font-size:11px" onclick="exportAuditCSV()">🔒 Audit CSV</button>
          <button class="btn btn-primary"   style="font-size:11px" onclick="exportMobileCSV()">📱 Mobile CSV</button>
          <button class="btn btn-secondary" style="font-size:11px;background:var(--green-soft);border-color:var(--green);color:#065f46" onclick="exportMobileExcel()">📊 Mobile Excel</button>
          <button class="btn btn-secondary" style="font-size:11px" onclick="copyAllMobiles()">📋 Copy Numbers</button>
        </div>
      </div>
      <div class="settings-row">
        <div><div class="settings-label" style="color:var(--red)">Reset Day Data</div><div class="settings-sublabel">আজকের সব patient data clear করবে</div></div>
        <div class="settings-control"><button class="btn btn-danger" style="font-size:11px" onclick="resetDayData()">🗑 Reset</button></div>
      </div>
    </div>
  `;
}

function applyRxSettings() {
  const s=loadAppSettings();
  s.rxAppName=document.getElementById('s-rxname').value.trim()||'Digital RX Pro';
  s.rxAppUrl =document.getElementById('s-rxurl').value.trim()||'https://digitalrxpro.com';
  saveAppSettings(s); logAction('modify','⚙️','Rx settings updated',`${s.rxAppName} → ${s.rxAppUrl}`);
  showToast('✓ Rx settings saved','success');
}
function applyChamberSettings() {
  const s=loadAppSettings();
  s.chamberName    =document.getElementById('s-chamber').value.trim()||'Dr. B. K. Bose Chamber';
  s.chamberLocation=document.getElementById('s-location').value.trim()||'Dinajpur';
  s.docNameBn      =document.getElementById('s-docbn').value.trim()||'ডাঃ. বি. কে. বোস';
  s.docNameEn      =(document.getElementById('s-docen')?.value||'').trim()||'Dr. B. K. Bose';
  saveAppSettings(s); logAction('modify','⚙️','Chamber settings updated',`${s.chamberName}, ${s.chamberLocation}`);
  showToast('✓ Chamber settings saved','success');
}
function applyDefaultSettings() {
  const s=loadAppSettings();
  s.defaultDailyLimit    =parseInt(document.getElementById('s-deflimit').value)||50;
  s.defaultReservedInterval=parseInt(document.getElementById('s-defres').value)||0;
  saveAppSettings(s); showToast('✓ Default settings saved','success');
}

/// UPDATED SECTION — Doctor Registry CRUD: add, edit, delete, toggle active
let _editingDoctorId = null;

function renderDoctorRegistryList() {
  doctorStore = loadDoctors();
  if (doctorStore.length === 0) {
    return '<div class="alert alert-warning" style="font-size:11px">কোনো Doctor নেই। নিচে Add করুন।</div>';
  }
  return doctorStore.map(d => {
    const bn   = d.nameBn || d.name;
    const en   = d.nameEn || d.name;
    const room = d.room   || '';
    const qual = d.qualifications || '';
    const activeClr = d.active ? 'var(--green)' : 'var(--red)';
    return `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:22px;line-height:1">🩺</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px;color:var(--text)">${bn}</div>
        <div style="font-size:11px;color:var(--text2)">${en}${room ? ' · ' + room : ''}</div>
        ${qual ? `<div style="font-size:10px;color:var(--text3);margin-top:2px">${qual}</div>` : ''}
        <div style="font-size:10px;margin-top:3px;color:${activeClr};font-weight:700">${d.active ? '✅ Active' : '🚫 Inactive'}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">
        <button class="btn btn-secondary" style="font-size:10px;padding:3px 8px" onclick="openEditDoctor('${d.id}')">✏️ Edit</button>
        <button class="btn btn-secondary" style="font-size:10px;padding:3px 8px" onclick="toggleDoctorActive('${d.id}')">${d.active ? '🚫 Off' : '✅ On'}</button>
        <button class="btn btn-danger"    style="font-size:10px;padding:3px 8px" onclick="deleteDoctor('${d.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function openAddDoctor() {
  _editingDoctorId = null;
  document.getElementById('doctor-edit-title').textContent = '➕ Add New Doctor';
  document.getElementById('de-save-btn').textContent = '💾 Add Doctor';
  ['de-nameBn','de-nameEn','de-qual','de-room','de-specialty','de-rxurl'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const feeEl = document.getElementById('de-fee'); if(feeEl) feeEl.value='';
  openModal('modal-doctor-edit');
}

function openEditDoctor(id) {
  doctorStore = loadDoctors();
  const d = doctorStore.find(x => x.id === id);
  if (!d) return;
  _editingDoctorId = id;
  document.getElementById('doctor-edit-title').textContent = '✏️ Edit Doctor';
  document.getElementById('de-save-btn').textContent = '💾 Update Doctor';
  document.getElementById('de-nameBn').value    = d.nameBn || d.name || '';
  document.getElementById('de-nameEn').value    = d.nameEn || d.name || '';
  document.getElementById('de-qual').value      = d.qualifications || '';
  document.getElementById('de-room').value      = d.room || '';
  const specEl = document.getElementById('de-specialty'); if(specEl) specEl.value = d.specialty || '';
  const feeEl  = document.getElementById('de-fee');       if(feeEl)  feeEl.value  = d.consultationFee || '';
  const rxEl   = document.getElementById('de-rxurl');     if(rxEl)   rxEl.value   = d.prescriptionSoftwareUrl || '';
  openModal('modal-doctor-edit');
}

/// UPDATED SECTION — saveDoctorEdit: full enterprise doctor entity (Fix #12)
function saveDoctorEdit() {
  const nameBn    = document.getElementById('de-nameBn').value.trim();
  const nameEn    = document.getElementById('de-nameEn').value.trim();
  const qual      = document.getElementById('de-qual').value.trim();
  const room      = document.getElementById('de-room').value.trim();
  const specialty = (document.getElementById('de-specialty')?.value||'').trim();
  const fee       = parseFloat(document.getElementById('de-fee')?.value)||0;
  const rxUrl     = (document.getElementById('de-rxurl')?.value||'').trim();
  if (!nameBn || !nameEn) { alert('Bengali Name এবং English Name আবশ্যক।'); return; }
  doctorStore = loadDoctors();
  if (!_editingDoctorId) {
    // Add new doctor — full enterprise entity
    const newDoc = {
      id: 'd' + Date.now(),
      name: nameEn, nameBn, nameEn,
      qualifications: qual, specialty, room,
      chamberName: nameEn + ' Chamber', chamberNumber: room || '—',
      consultationFee: fee, dailyLimit: 50, avgConsultTime: 8,
      prescriptionSoftwareUrl: rxUrl || 'https://digitalrxpro.com',
      status: 'available', active: true
    };
    doctorStore.push(newDoc);
    logAction('user','👨‍⚕️','Doctor added', `${nameBn} (${nameEn})${room ? ' · ' + room : ''}`);
    showToast('✓ Doctor added — Dropdown এ দেখা যাবে।', 'success');
  } else {
    const d = doctorStore.find(x => x.id === _editingDoctorId);
    if (!d) return;
    Object.assign(d, { name: nameEn, nameBn, nameEn, qualifications: qual, specialty, room,
      consultationFee: fee || d.consultationFee,
      prescriptionSoftwareUrl: rxUrl || d.prescriptionSoftwareUrl });
    // Sync currentDoctor if it's the one being edited
    if (currentDoctor && currentDoctor.id === _editingDoctorId) {
      currentDoctor = { ...currentDoctor, name: nameEn, nameBn, nameEn, qualifications: qual, specialty, room,
        consultationFee: fee || currentDoctor.consultationFee,
        prescriptionSoftwareUrl: rxUrl || currentDoctor.prescriptionSoftwareUrl };
      updateDoctorChip();
    }
    logAction('user','✏️','Doctor updated', `${nameBn} (${nameEn})`);
    showToast('✓ Doctor updated.', 'success');
  }
  saveDoctors(doctorStore);
  closeModal('modal-doctor-edit');
  render();
}

function toggleDoctorActive(id) {
  doctorStore = loadDoctors();
  const d = doctorStore.find(x => x.id === id);
  if (!d) return;
  d.active = !d.active;
  saveDoctors(doctorStore);
  const bn = d.nameBn || d.name;
  logAction('user', d.active ? '✅' : '🚫', d.active ? 'Doctor activated' : 'Doctor deactivated', bn);
  showToast(`✓ ${bn} ${d.active ? 'activated' : 'deactivated'}`, 'info');
  render();
}

function deleteDoctor(id) {
  doctorStore = loadDoctors();
  const d = doctorStore.find(x => x.id === id);
  if (!d) return;
  if (!confirm(`"${d.nameBn || d.name}" delete করবেন? এই Doctor-এর সাথে assigned সব user-এর assignment clear হবে।`)) return;
  // Remove from doctorStore
  doctorStore = doctorStore.filter(x => x.id !== id);
  saveDoctors(doctorStore);
  // Clear assignedDoctorId from any users assigned to this doctor
  userStore = loadUsers();
  let changed = false;
  userStore.forEach(u => { if (u.assignedDoctorId === id) { u.assignedDoctorId = null; changed = true; } });
  if (changed) saveUsers(userStore);
  logAction('user','🗑','Doctor deleted', `${d.nameBn || d.name} removed.`);
  showToast('✓ Doctor deleted.', 'info');
  render();
}

function resetDayData() {
  if (!confirm('সত্যিই Reset করবেন? সব patient data মুছে যাবে।')) return;
  patients.length=0; patientReferences.length=0; nextToken=1; consultStartTimestamps={};
  logAction('modify','🗑','Day reset','All patient data cleared for new session.');
  syncState(); updateNavBadges(); showToast('✓ Day reset','info'); render();
}

/// UPDATED SECTION — Export system: patients CSV, audit CSV, mobile/follow-up export
function exportPatientsCSV() {
  const h=['Token','Name','Age','Gender','Phone','Type','Source','Status','Payment','Fee','Paid','Due','Doctor','Date','Added','Arrived','Called','Consult Start','Consult End','Completed','Notes'];
  const rows=patients.map(p=>[p.token,p.name,p.age,p.gender,p.phone||'',p.type,p.source,p.status,p.payStatus||'unpaid',p.fee||0,p.paid||0,(p.fee||0)-(p.paid||0),currentDoctor?.name||'',currentDate,p.addedAt||'',p.arrived_at||'',p.called_at||'',p.consultation_started_at||'',p.consultation_ended_at||'',p.completed_at||'',(p.notes||'').replace(/,/g,'·')]);
  downloadCSV(`patients_${currentDate.replace(/-/g,'')}.csv`,[h,...rows]);
  showToast('✓ Patients exported','success');
}
function exportAuditCSV() {
  const h=['Time','Action','Detail','By','Reason','Type'];
  const rows=auditLog.map(a=>[a.time,a.action,a.detail,a.by,a.reason||'',a.type]);
  downloadCSV(`audit_${currentDate.replace(/-/g,'')}.csv`,[h,...rows]);
  showToast('✓ Audit exported','success');
}

/// UPDATED SECTION — exportMobileCSV: patient mobile numbers for follow-up calls & SMS (Fix #8)
function exportMobileCSV() {
  const eligible = patients.filter(p => p.phone && p.phone.trim());
  if (!eligible.length) { showToast('No patients with phone numbers','warning'); return; }
  const h = ['Name','Phone','Token','Visit Type','Visit Date','Doctor','Status','Notes'];
  const rows = eligible.map(p => [
    p.name, p.phone, p.token, p.type, currentDate,
    currentDoctor?.name||'', p.status,
    (p.notes||'').replace(/,/g,'·')
  ]);
  downloadCSV(`followup_mobile_${currentDate.replace(/-/g,'')}.csv`,[h,...rows]);
  showToast(`✓ ${eligible.length} mobile numbers exported`,'success');
}

/// UPDATED SECTION — Copy all mobile numbers to clipboard (Fix #8)
function copyAllMobiles() {
  const eligible = patients.filter(p => p.phone && p.phone.trim());
  if (!eligible.length) { showToast('No phone numbers found','warning'); return; }
  const text = eligible.map(p => p.phone.trim()).join('\n');
  navigator.clipboard?.writeText(text).then(()=>{
    showToast(`✓ ${eligible.length} mobile numbers copied to clipboard`,'success');
  }).catch(()=>{
    // Fallback
    const el = document.createElement('textarea');
    el.value = text; document.body.appendChild(el); el.select();
    document.execCommand('copy'); document.body.removeChild(el);
    showToast(`✓ ${eligible.length} numbers copied`,'success');
  });
}

/// UPDATED SECTION — WhatsApp click-to-chat for single patient (Fix #8)
function openWhatsApp(phone, name) {
  const cleaned = phone.replace(/[^0-9]/g,'');
  const bd = cleaned.startsWith('0') ? '880' + cleaned.slice(1) : cleaned;
  const msg = encodeURIComponent(`আসসালামু আলাইকুম ${name},\nআপনার পরবর্তী সিরিয়ালের জন্য যোগাযোগ করুন।\n— ${currentDoctor?.nameBn||currentDoctor?.name||'Doctor'}`);
  window.open(`https://wa.me/${bd}?text=${msg}`, '_blank', 'noopener');
}

/// UPDATED SECTION — Export mobile list as Excel-compatible format (Fix #8)
function exportMobileExcel() {
  const eligible = patients.filter(p => p.phone && p.phone.trim());
  if (!eligible.length) { showToast('No phone numbers found','warning'); return; }
  // Excel-compatible HTML table (opens in Excel)
  const rows = eligible.map(p =>
    `<tr><td>${p.token}</td><td>${p.name}</td><td>${p.phone}</td><td>${p.type}</td><td>${p.status}</td><td>${currentDate}</td><td>${currentDoctor?.name||''}</td></tr>`
  ).join('');
  const html = `<html><head><meta charset="UTF-8"></head><body><table><tr><th>Token</th><th>Name</th><th>Phone</th><th>Type</th><th>Status</th><th>Date</th><th>Doctor</th></tr>${rows}</table></body></html>`;
  const blob = new Blob(['\uFEFF' + html], {type:'application/vnd.ms-excel;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mobile_list_${currentDate.replace(/-/g,'')}.xls`;
  a.click(); URL.revokeObjectURL(a.href);
  showToast(`✓ ${eligible.length} records exported to Excel`,'success');
}

function downloadCSV(name,rows) {
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'})); a.download=name; a.click(); URL.revokeObjectURL(a.href);
}

/// UPDATED SECTION — Recall Patient Feature (Fix #5)
// Opens modal to search completed/noshow patients and re-add to active queue
function openRecallModal() {
  filterRecallPatients();
  openModal('modal-recall');
}
function filterRecallPatients() {
  const q = (document.getElementById('recall-search')?.value || '').toLowerCase();
  const eligible = patients.filter(p => ['completed','noshow','cancelled'].includes(p.status));
  const filtered = q ? eligible.filter(p => (p.name||'').toLowerCase().includes(q) || (p.phone||'').includes(q)) : eligible;
  const list = document.getElementById('recall-list');
  if (!list) return;
  if (filtered.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);font-size:12px">কোনো recall-যোগ্য রোগী নেই</div>`;
    return;
  }
  list.innerHTML = filtered.slice(0, 20).map(p => {
    const pi = getPriorityInfo(p.type);
    return `<div class="recall-item" onclick="recallPatient(${p.token})">
      <div class="ri-token">${p.token}</div>
      <div class="ri-info">
        <div class="ri-name">${p.name}</div>
        <div class="ri-meta">📞 ${p.phone||'—'} · ${p.age||'?'}${p.gender} · ${pi.label} · Status: ${p.status}</div>
        <div class="ri-meta">Prev. added: ${p.addedAt||'—'} · via ${p.addedBy||'—'}</div>
      </div>
      <button class="btn btn-arrive" style="font-size:11px;padding:6px 10px;flex-shrink:0">🔄 Recall</button>
    </div>`;
  }).join('');
}
function recallPatient(originalToken) {
  const orig = patients.find(p => p.token === originalToken);
  if (!orig) { showToast('Patient not found','error'); return; }
  if (!['completed','noshow','cancelled'].includes(orig.status)) {
    showToast('এই patient এখনো queue-এ আছেন','warning'); return;
  }
  const max = getSchedule(currentDoctor?.id||'d1', currentDate).maxPatients || 50;
  if (getActiveCount() >= max) { showToast('🔴 Serial full — আর add করা যাবে না','error'); return; }

  // Create a new queue entry for the recalled patient — engine allocates next available token
  const newToken = getNextAvailableToken();
  nextToken = Math.max(nextToken, newToken + 1);
  const recalled = {
    ...orig,
    token: newToken,
    status: 'waiting',
    type: 'followup',

    // ── SCHEMA v2: Recall-specific fields ──
    slotType: 'normal',            // recall is normal priority in queue
    isReservedSlot: false,
    reservedBy: null,
    reservedUntil: null,
    registrationSource: 'referral', // recalled = internal referral
    registeredBy: currentUser?.username || 'system',
    registeredByName: currentUser?.name || getActorName(),
    registeredByRole: currentUser?.role || 'unknown',

    addedAt: nowTime(),
    addedAtISO: new Date().toISOString(),
    addedBy: getActorName(),
    source: 'recall',
    arrived_at: null, called_at: null,
    consultation_started_at: null, consultation_ended_at: null, completed_at: null,
    fee: orig.fee || 0, paid: 0, payStatus: 'unpaid',
    notes: `Recalled from token #${originalToken}. ${orig.notes||''}`.trim(),
    recalledFrom: originalToken,
    _schemaVersion: 2,
  };
  patients.push(recalled);
  logAction('modify','🔄','Patient recalled',`${orig.name} recalled as #${newToken} (was #${originalToken})`);
  syncState(); updateNavBadges();
  closeModal('modal-recall');
  showToast(`✓ ${orig.name} recalled — Token #${newToken}`,'success');
  switchTab('queue');
}

/// UPDATED SECTION — Performance Analytics (Fix #3) — Proper enterprise analytics
function getReceptionPerformance() {
  // Uses registeredByName (v2) with fallback to addedBy (v1 legacy)
  const bySource = {};
  patients.forEach(p => {
    const key = p.registeredByName || p.addedBy || p.source || 'Unknown';
    if (!bySource[key]) bySource[key] = { total:0, emergency:0, followup:0, docref:0, recall:0 };
    bySource[key].total++;
    if (p.type === 'emergency') bySource[key].emergency++;
    if (p.type === 'followup' || p.source === 'followup') bySource[key].followup++;
    if (p.type === 'docref') bySource[key].docref++;
    if (p.source === 'recall' || p.recalledFrom) bySource[key].recall++;
  });
  return bySource;
}

// ── SCHEMA v2: slotType + registrationSource analytics helpers ──
function getSlotTypeStats() {
  const stats = { normal:0, reserved:0, doctor_priority:0, emergency:0 };
  patients.forEach(p => {
    const t = p.slotType || 'normal';
    stats[t] = (stats[t] || 0) + 1;
  });
  return stats;
}
function getRegistrationSourceStats() {
  const stats = { walkin:0, phone:0, online:0, referral:0, desk:0 };
  patients.forEach(p => {
    const s = p.registrationSource || 'desk';
    stats[s] = (stats[s] || 0) + 1;
  });
  return stats;
}

// ── SCHEMA v2: getPatientSchemaInfo — debug/audit helper ──
// Returns a summary of schema versions present in current session
function getPatientSchemaInfo() {
  const v1 = patients.filter(p => !p._schemaVersion || p._schemaVersion < 2).length;
  const v2 = patients.filter(p => p._schemaVersion >= 2).length;
  return { v1_legacy: v1, v2_enhanced: v2, total: patients.length };
}

// ═══════════════════════════════════════════════════
// /// UPDATED SECTION — BILLING SYSTEM
// ═══════════════════════════════════════════════════
let _billingToken = null;

function openBillingModal(token) {
  const p = patients.find(x => x.token === token);
  if (!p) return;
  _billingToken = token;
  document.getElementById('billing-modal-title').textContent = `💳 #${token} — ${p.name}`;
  const fee = p.fee || 0;
  const paid = p.paid || 0;
  const due = fee - paid;
  document.getElementById('billing-modal-body').innerHTML = `
    <div class="receipt-preview" style="margin-bottom:12px">
      <div class="receipt-row"><span>Patient</span><strong>${p.name}</strong></div>
      <div class="receipt-row"><span>Token</span><strong>#${p.token}</strong></div>
      <div class="receipt-row"><span>Type</span><strong>${p.type}</strong></div>
    </div>
    <div class="form-group">
      <label class="form-label">Consultation Fee (৳) *</label>
      <input type="number" class="form-input" id="b-fee" value="${fee}" min="0" placeholder="e.g. 500" />
    </div>
    <div class="form-group">
      <label class="form-label">Amount Paid (৳)</label>
      <input type="number" class="form-input" id="b-paid" value="${paid}" min="0" placeholder="e.g. 500" oninput="updateBillingCalc()" />
    </div>
    <div class="form-group">
      <label class="form-label">Payment Status</label>
      <select class="form-select" id="b-status">
        <option value="unpaid" ${(p.payStatus||'unpaid')==='unpaid'?'selected':''}>❌ Unpaid</option>
        <option value="paid" ${p.payStatus==='paid'?'selected':''}>✅ Paid</option>
        <option value="partial" ${p.payStatus==='partial'?'selected':''}>⚠️ Partial</option>
        <option value="waived" ${p.payStatus==='waived'?'selected':''}>🎁 Waived</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Payment Method</label>
      <div class="choice-grid cg-4">
        ${['Cash','bKash','Nagad','Card'].map(m=>`<div class="choice-btn ${(p.payMethod||'Cash')===m?'sel':''}" onclick="this.parentElement.querySelectorAll('.choice-btn').forEach(b=>b.classList.remove('sel'));this.classList.add('sel');document.getElementById('b-method').value='${m}'">${m}</div>`).join('')}
      </div>
      <input type="hidden" id="b-method" value="${p.payMethod||'Cash'}" />
    </div>
    <div id="billing-calc" style="margin-top:8px"></div>
  `;
  updateBillingCalc();
  document.getElementById('billing-modal-btns').innerHTML = `
    <button class="btn btn-primary" onclick="saveBilling()" style="flex:1">💾 Save Payment</button>
    <button class="btn btn-secondary" onclick="closeModal('modal-billing')" style="flex:1">Cancel</button>
  `;
  openModal('modal-billing');
}

function updateBillingCalc() {
  const fee = parseFloat(document.getElementById('b-fee')?.value) || 0;
  const paid = parseFloat(document.getElementById('b-paid')?.value) || 0;
  const due = fee - paid;
  const el = document.getElementById('billing-calc');
  if (!el) return;
  el.innerHTML = `<div class="receipt-preview">
    <div class="receipt-row"><span>Fee</span><span>৳ ${fee.toFixed(2)}</span></div>
    <div class="receipt-row"><span>Paid</span><span style="color:var(--green)">৳ ${paid.toFixed(2)}</span></div>
    <div class="receipt-row"><span>Due</span><strong style="color:${due>0?'var(--red)':due<0?'var(--amber)':'var(--green)'}">৳ ${Math.abs(due).toFixed(2)} ${due<0?'(Over-paid)':due===0?'(Cleared)':'(Due)'}</strong></div>
  </div>`;
}

function saveBilling() {
  const p = patients.find(x => x.token === _billingToken);
  if (!p) return;
  p.fee = parseFloat(document.getElementById('b-fee').value) || 0;
  p.paid = parseFloat(document.getElementById('b-paid').value) || 0;
  p.payStatus = document.getElementById('b-status').value;
  p.payMethod = document.getElementById('b-method').value;
  logAction('modify','💳','Billing updated',`#${p.token} ${p.name} — Fee: ৳${p.fee}, Paid: ৳${p.paid}, Status: ${p.payStatus}`);
  syncState(); closeModal('modal-billing');
  showToast(`✓ Billing saved — ৳${p.paid} / ৳${p.fee}`,'success');
  render();
}

function getPayBadge(p) {
  if (!p.fee && !p.payStatus) return '';
  const st = p.payStatus||'unpaid';
  const map = { paid:'pay-paid', unpaid:'pay-unpaid', partial:'pay-partial', waived:'pay-paid' };
  const lbl = { paid:'✅ Paid', unpaid:'❌ Unpaid', partial:'⚠️ Partial', waived:'🎁 Waived' };
  return `<span class="${map[st]||'pay-unpaid'}" onclick="openBillingModal(${p.token})" style="cursor:pointer">${lbl[st]||'Unpaid'}</span>`;
}

// ═══════════════════════════════════════════════════
// /// UPDATED SECTION — QUEUE SEARCH
// ═══════════════════════════════════════════════════
let _queueSearch = '';

function renderQueueSearchBar() {
  return `<div class="queue-search-bar">
    <input type="text" class="queue-search-input" placeholder="🔍 রোগীর নাম বা মোবাইল নম্বর দিয়ে খুঁজুন..." value="${_queueSearch}" oninput="_queueSearch=this.value;render()" />
    ${_queueSearch ? `<button class="btn btn-secondary" style="font-size:11px;padding:7px 12px;flex-shrink:0" onclick="_queueSearch='';render()">✕ Clear</button>` : ''}
  </div>`;
}

function filterBySearch(arr) {
  if (!_queueSearch) return arr;
  const q = _queueSearch.toLowerCase();
  return arr.filter(p => (p.name||'').toLowerCase().includes(q) || (p.phone||'').includes(q));
}

// ═══════════════════════════════════════════════════
// /// UPDATED SECTION — CALLING SYSTEM (Audio + Banner)
// ═══════════════════════════════════════════════════
let _lastCalledToken = null;
let _callingBannerTimer = null;

/// UPDATED SECTION — Bangla Number Conversion & Announcement System (Fix #7)
const BANGLA_DIGITS = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
const BANGLA_WORDS = ['শূন্য','এক','দুই','তিন','চার','পাঁচ','ছয়','সাত','আট','নয়','দশ',
  'এগারো','বারো','তেরো','চৌদ্দ','পনেরো','ষোলো','সতেরো','আঠারো','উনিশ','বিশ',
  'একুশ','বাইশ','তেইশ','চব্বিশ','পঁচিশ','ছাব্বিশ','সাতাশ','আঠাশ','উনত্রিশ','ত্রিশ',
  'একত্রিশ','বত্রিশ','তেত্রিশ','চৌত্রিশ','পঁয়ত্রিশ','ছত্রিশ','সাতত্রিশ','আটত্রিশ','উনচল্লিশ','চল্লিশ',
  'একচল্লিশ','বিয়াল্লিশ','তেতাল্লিশ','চৌচল্লিশ','পঁয়তাল্লিশ','ছেচল্লিশ','সাতচল্লিশ','আটচল্লিশ','উনপঞ্চাশ','পঞ্চাশ',
  'একান্ন','বায়ান্ন','তিপান্ন','চুয়ান্ন','পঞ্চান্ন','ছাপান্ন','সাতান্ন','আটান্ন','উনষাট','ষাট',
  'একষট্টি','বাষট্টি','তেষট্টি','চৌষট্টি','পঁয়ষট্টি','ছেষট্টি','সাতষট্টি','আটষট্টি','উনসত্তর','সত্তর',
  'একাত্তর','বাহাত্তর','তেহাত্তর','চুয়াত্তর','পঁচাত্তর','ছিয়াত্তর','সাতাত্তর','আটাত্তর','উননব্বই','আশি',
  'একাশি','বিরাশি','তিরাশি','চুরাশি','পঁচাশি','ছিয়াশি','সাতাশি','আটাশি','উননব্বই','নব্বই',
  'একানব্বই','বিরানব্বই','তিরানব্বই','চুরানব্বই','পঁচানব্বই','ছিয়ানব্বই','সাতানব্বই','আটানব্বই','নিরানব্বই','একশত'];

function toBengaliDigit(n) {
  return String(n).split('').map(c => BANGLA_DIGITS[parseInt(c)] || c).join('');
}
function toBengaliWord(n) {
  if (n >= 0 && n <= 100) return BANGLA_WORDS[n];
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  if (hundreds > 0 && remainder === 0) return BANGLA_WORDS[hundreds] + ' শত';
  if (hundreds > 0) return BANGLA_WORDS[hundreds] + ' শত ' + (BANGLA_WORDS[remainder] || toBengaliDigit(remainder));
  return toBengaliDigit(n);
}
function makeBanglaAnnouncement(token, name, isEmergency, doctorNameBn) {
  const tokenBn = toBengaliDigit(token);
  const wordBn  = toBengaliWord(token);
  if (isEmergency) {
    return `জরুরি রোগী! টোকেন নম্বর ${tokenBn}, দয়া করে দ্রুত ডাক্তারের কক্ষে আসুন।`;
  }
  return `টোকেন নম্বর ${tokenBn} (${wordBn}), রোগী ${name}, দয়া করে ${doctorNameBn ? doctorNameBn + '-এর ' : ''}কক্ষে আসুন।`;
}
function speakBanglaAnnouncement(text, isEmergency) {
  try {
    speechSynthesis.cancel();
    // Try Bengali voice first
    const voices = speechSynthesis.getVoices();
    const bnVoice = voices.find(v => v.lang.startsWith('bn') || v.lang.startsWith('hi'));
    const utt = new SpeechSynthesisUtterance(text);
    if (bnVoice) { utt.voice = bnVoice; utt.lang = 'bn-BD'; }
    else { utt.lang = 'bn-BD'; }
    utt.rate = isEmergency ? 1.1 : 0.85;
    utt.volume = 0.95;
    speechSynthesis.speak(utt);
  } catch(e) {
    // TTS not available — silent
  }
}

function triggerCallingBanner(token, name, isEmergency) {
  _lastCalledToken = token;
  const docBn = currentDoctor?.nameBn || currentDoctor?.name || '';
  const annoText = makeBanglaAnnouncement(token, name, isEmergency, docBn);
  // Inject/update calling banner at top of main
  let banner = document.getElementById('calling-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'calling-banner';
    banner.className = 'call-banner';
    const main = document.getElementById('main-content');
    if (main) main.prepend(banner);
  }
  banner.innerHTML = `
    <div class="call-banner-token">${token}</div>
    <div class="call-banner-text">
      <div class="call-banner-bn bn">${annoText}</div>
      <div class="call-banner-en" style="font-family:var(--font)">Token ${token} — ${name} — Please come in</div>
    </div>
    <button onclick="document.getElementById('calling-banner')?.remove()" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;cursor:pointer;font-family:var(--font)">✕</button>
  `;
  if (_callingBannerTimer) clearTimeout(_callingBannerTimer);
  _callingBannerTimer = setTimeout(() => { document.getElementById('calling-banner')?.remove(); }, 10000);
  speakBanglaAnnouncement(annoText, isEmergency);
}

setInterval(() => {
  const ce=document.getElementById('live-clock');
  if (ce) ce.textContent=new Date().toLocaleTimeString('en-BD');
  const inCons=patients.find(p=>p.status==='incons');
  if (inCons&&consultStartTimestamps[inCons.token]) {
    const d=Date.now()-consultStartTimestamps[inCons.token];
    const t1=document.getElementById('live-timer'), t2=document.getElementById('doc-timer');
    if(t1) t1.textContent=formatDuration(d);
    if(t2) t2.textContent=formatDuration(d);
  }
}, 1000);

// ═══════════════════════════════════════════════════
// CROSS-TAB SYNC — storage event listener
// Uses soft render (no location.reload) to preserve form state
// ═══════════════════════════════════════════════════
window.addEventListener('storage', function(e) {
  if (e.key && e.key.includes('mq_reserved_v1__')) {
    _syncReservedSlots();
    if (['queue','entry','doctor'].includes(currentTab)) {
      syncState();
      render();
    }
  }
  if (e.key === _offlineKey(currentDate, currentDoctor?.id)) {
    syncState();
    if (currentTab !== 'display') {
      render();
    }
  }
});

// ═══════════════════════════════════════════════════
// TOKEN AVAILABILITY HELPER
// ═══════════════════════════════════════════════════
function isTokenAvailable(token) {
  // Check: no active patient with this token
  const collision = patients.find(p =>
    p.token === token &&
    !['completed','noshow','cancelled'].includes(p.status)
  );
  if (collision) return false;
  // Check: not a reserved slot
  const sch = getSchedule(currentDoctor?.id||'d1', currentDate);
  if (sch.reservedInterval && sch.reservedInterval > 0 && token % sch.reservedInterval === 0) return false;
  return true;
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
document.getElementById('login-username')?.focus();


// ══════════════════════════════════════════════════════
// PWA SERVICE WORKER REGISTRATION
// Moved here from inline HTML to ensure DOM is ready
// and correct scope for GitHub Pages subdirectory
// Repo: zakir-rana/mediqueue-next
// ══════════════════════════════════════════════════════
(function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function() {
    // GitHub Pages path: scope must match repository subdirectory
    navigator.serviceWorker.register('./service-worker.js', { scope: './' })
      .then(function(reg) {
        console.log('[PWA] Service worker registered, scope:', reg.scope);

        // Detect SW update and notify user
        reg.addEventListener('updatefound', function() {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', function() {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New SW installed — prompt user to refresh
              const banner = document.createElement('div');
              banner.id = 'sw-update-banner';
              banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a56e8;color:#fff;padding:12px 20px;border-radius:12px;font-size:13px;font-weight:700;z-index:4000;display:flex;align-items:center;gap:10px;box-shadow:0 8px 32px rgba(26,86,232,0.4);white-space:nowrap;font-family:var(--font)';
              banner.innerHTML = '🔄 New version available! <button onclick="applySwUpdate()" style="background:#fff;color:#1a56e8;border:none;padding:6px 14px;border-radius:8px;font-weight:800;cursor:pointer;font-size:12px;font-family:var(--font)">Update Now</button> <button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:11px">✕</button>';
              document.body.appendChild(banner);
              window._pendingSWWorker = newWorker;
            }
          });
        });
      })
      .catch(function(err) {
        console.warn('[PWA] Service worker registration failed:', err);
      });

    // Listen for controller change (after skipWaiting) → reload page to get fresh content
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function() {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
})();

function applySwUpdate() {
  if (window._pendingSWWorker) {
    window._pendingSWWorker.postMessage({ type: 'SKIP_WAITING' });
  }
  document.getElementById('sw-update-banner')?.remove();
}

// ── PWA Install prompt (beforeinstallprompt) ──────────
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Show install button if it exists in UI
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'flex';
});

window.addEventListener('appinstalled', function() {
  _deferredInstallPrompt = null;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'none';
  showToast && showToast('✅ App installed successfully!', 'success');
});

function triggerPWAInstall() {
  if (!_deferredInstallPrompt) {
    showToast && showToast('Install prompt not available — try from browser menu', 'info');
    return;
  }
  _deferredInstallPrompt.prompt();
  _deferredInstallPrompt.userChoice.then(function(result) {
    if (result.outcome === 'accepted') {
      showToast && showToast('✅ App being installed...', 'success');
    }
    _deferredInstallPrompt = null;
  });
}
