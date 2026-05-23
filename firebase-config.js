// ══════════════════════════════════════════════════════
// MediQueue Pro — Firebase Configuration & Data Layer
// Status: PREPARED — Firebase is NOT yet active.
// Current backend: Supabase (see app.js SUPABASE CONFIG section)
//
// This file establishes the abstraction layer so that
// migrating from Supabase to Firebase requires only:
//   1. Setting FIREBASE_ENABLED = true
//   2. Filling in the firebaseConfig object below
//   3. Removing / disabling the Supabase script tag in index.html
//
// ALL app code should call StorageAdapter methods, NOT
// Supabase or Firebase directly, after migration.
// ══════════════════════════════════════════════════════

// ── FIREBASE CONFIG (fill when ready) ─────────────────
const FIREBASE_CONFIG = {
  apiKey:            "REPLACE_WITH_FIREBASE_API_KEY",
  authDomain:        "REPLACE.firebaseapp.com",
  projectId:         "REPLACE_PROJECT_ID",
  storageBucket:     "REPLACE.appspot.com",
  messagingSenderId: "REPLACE_SENDER_ID",
  appId:             "REPLACE_APP_ID",
  measurementId:     "REPLACE_MEASUREMENT_ID",    // optional
  databaseURL:       "https://REPLACE-default-rtdb.firebaseio.com", // Realtime DB
};

// ── TOGGLE ─────────────────────────────────────────────
// Set to true ONLY after filling FIREBASE_CONFIG above
// and including the Firebase SDK scripts in index.html.
const FIREBASE_ENABLED = false;

// ══════════════════════════════════════════════════════
// STORAGE ADAPTER — Abstract Data Layer
//
// Provides a uniform API regardless of backend.
// Swap implementation by changing FIREBASE_ENABLED toggle.
// All methods return Promises.
// ══════════════════════════════════════════════════════

const StorageAdapter = (() => {
  // ── INTERNAL: Supabase implementation ──────────────
  // These delegate to the _supa client defined in app.js
  // NOTE: _supa must be initialised before StorageAdapter is used.

  const _supabase = {
    async loadSession(isoDate, doctorId) {
      if (typeof _supa === 'undefined') throw new Error('Supabase not initialised');
      return window._supaLoadSession(isoDate, doctorId);
    },

    async saveSession(isoDate, doctorId, stateObj) {
      if (typeof _supa === 'undefined') throw new Error('Supabase not initialised');
      window.scheduleWrite(isoDate, doctorId, stateObj);
    },

    async logAudit(entry) {
      if (typeof _supa === 'undefined') return;
      return window.supaLogAudit(entry);
    },

    async loadAudit(isoDate) {
      if (typeof _supa === 'undefined') return [];
      return window.supaLoadAudit(isoDate);
    },

    subscribeToSession(isoDate, doctorId, callback) {
      // Supabase polling is handled inside app.js via startPolling()
      // This stub exists for interface completeness
      if (typeof window.startPolling === 'function') {
        window.startPolling(isoDate, doctorId, callback);
      }
      return () => {
        if (typeof window.stopPolling === 'function') window.stopPolling();
      };
    },
  };

  // ── INTERNAL: Firebase Realtime Database implementation ──
  const _firebase = {
    _db: null,
    _auth: null,

    _init() {
      if (this._db) return;
      // Requires Firebase SDK loaded globally
      if (typeof firebase === 'undefined') {
        throw new Error('Firebase SDK not loaded');
      }
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      this._db   = firebase.database();
      this._auth = firebase.auth();
    },

    _sessionPath(isoDate, doctorId) {
      // e.g. sessions/20250523/d1
      const day = isoDate.replace(/-/g, '');
      return `sessions/${day}/${doctorId || '_shared'}`;
    },

    _auditPath(isoDate) {
      const day = isoDate.replace(/-/g, '');
      return `audit/${day}`;
    },

    async loadSession(isoDate, doctorId) {
      this._init();
      const path = this._sessionPath(isoDate, doctorId);
      const snap = await this._db.ref(path).once('value');
      return snap.val() || null;
    },

    async saveSession(isoDate, doctorId, stateObj) {
      this._init();
      const path = this._sessionPath(isoDate, doctorId);
      await this._db.ref(path).update({
        ...stateObj,
        updated_at: firebase.database.ServerValue.TIMESTAMP,
      });
    },

    async logAudit(entry) {
      this._init();
      const path = this._auditPath(entry.isoDate || new Date().toISOString().slice(0, 10));
      await this._db.ref(path).push({
        ...entry,
        _server_ts: firebase.database.ServerValue.TIMESTAMP,
      });
    },

    async loadAudit(isoDate) {
      this._init();
      const path = this._auditPath(isoDate);
      const snap = await this._db.ref(path)
        .orderByChild('_ts')
        .limitToLast(500)
        .once('value');
      const data = snap.val() || {};
      return Object.values(data)
        .sort((a, b) => (b._ts || 0) - (a._ts || 0));
    },

    subscribeToSession(isoDate, doctorId, callback) {
      this._init();
      const path = this._sessionPath(isoDate, doctorId);
      const ref  = this._db.ref(path);
      const handler = (snap) => {
        const data = snap.val();
        if (data) callback(data);
      };
      ref.on('value', handler);
      // Return unsubscribe function
      return () => ref.off('value', handler);
    },
  };

  // ── PUBLIC API ──────────────────────────────────────
  const impl = FIREBASE_ENABLED ? _firebase : _supabase;

  return {
    /**
     * Load a session by date + doctorId.
     * Returns session data object or null if not found.
     */
    async loadSession(isoDate, doctorId) {
      try {
        return await impl.loadSession(isoDate, doctorId);
      } catch (err) {
        console.error('[StorageAdapter] loadSession failed:', err);
        return null;
      }
    },

    /**
     * Save/update a session.
     * stateObj: { patients, next_token, doctor_status, consult_ts, ref_meta }
     */
    async saveSession(isoDate, doctorId, stateObj) {
      try {
        return await impl.saveSession(isoDate, doctorId, stateObj);
      } catch (err) {
        console.error('[StorageAdapter] saveSession failed:', err);
      }
    },

    /**
     * Append an audit log entry.
     */
    async logAudit(entry) {
      try {
        return await impl.logAudit(entry);
      } catch (err) {
        console.error('[StorageAdapter] logAudit failed:', err);
      }
    },

    /**
     * Load audit log for a date (descending order).
     */
    async loadAudit(isoDate) {
      try {
        return await impl.loadAudit(isoDate);
      } catch (err) {
        console.error('[StorageAdapter] loadAudit failed:', err);
        return [];
      }
    },

    /**
     * Subscribe to real-time session updates.
     * callback(data) is called when remote data changes.
     * Returns an unsubscribe function.
     */
    subscribeToSession(isoDate, doctorId, callback) {
      try {
        return impl.subscribeToSession(isoDate, doctorId, callback);
      } catch (err) {
        console.error('[StorageAdapter] subscribeToSession failed:', err);
        return () => {};
      }
    },

    /**
     * Returns which backend is currently active.
     */
    get backend() {
      return FIREBASE_ENABLED ? 'firebase' : 'supabase';
    },

    /**
     * Returns true if Firebase is enabled and configured.
     */
    get isFirebase() {
      return FIREBASE_ENABLED;
    },
  };
})();

// ══════════════════════════════════════════════════════
// LOCAL STORAGE WRAPPER
// Centralises all localStorage keys — makes future
// migration to IndexedDB or Firebase Local Persistence easy.
// ══════════════════════════════════════════════════════

const LocalStore = {
  KEYS: {
    USERS:        'mq_users_v1',
    DOCTORS:      'mq_doctors_v1',
    SCHEDULE:     'mq_schedule_v1',
    APP_SETTINGS: 'mq_app_settings_v1',
    OFFLINE_PFX:  'mq_offline_v2__',
    RESERVED_PFX: 'mq_reserved_v1__',
  },

  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[LocalStore] get failed:', key, e);
      return null;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Quota exceeded or private browsing
      console.error('[LocalStore] set failed:', key, e);
      return false;
    }
  },

  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('[LocalStore] remove failed:', key, e);
    }
  },

  /**
   * Purge all MediQueue Pro keys from localStorage.
   * Used on Reset Day Data.
   */
  purgeAll() {
    const mqKeys = Object.keys(localStorage).filter((k) => k.startsWith('mq_'));
    mqKeys.forEach((k) => localStorage.removeItem(k));
    console.log('[LocalStore] purged', mqKeys.length, 'keys');
  },

  /**
   * Purge only offline session mirrors (safe to clear without data loss).
   */
  purgeOfflineMirrors() {
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith(this.KEYS.OFFLINE_PFX)
    );
    keys.forEach((k) => localStorage.removeItem(k));
    console.log('[LocalStore] purged', keys.length, 'offline mirrors');
  },

  /**
   * Return total localStorage usage estimate in KB.
   */
  usageKB() {
    let total = 0;
    for (let k in localStorage) {
      if (Object.prototype.hasOwnProperty.call(localStorage, k)) {
        total += (localStorage[k].length + k.length) * 2; // UTF-16
      }
    }
    return (total / 1024).toFixed(1);
  },
};

// Expose globally for app.js to optionally use
window.StorageAdapter = StorageAdapter;
window.LocalStore     = LocalStore;
window.FIREBASE_ENABLED = FIREBASE_ENABLED;

// ── MIGRATION GUIDE ────────────────────────────────────
// When ready to migrate to Firebase:
//
// 1. Create Firebase project at console.firebase.google.com
// 2. Enable Realtime Database (or Firestore — update _firebase impl above)
// 3. Enable Anonymous Auth (for offline-safe sessions) or use custom auth
// 4. Copy API keys into FIREBASE_CONFIG above
// 5. Set FIREBASE_ENABLED = true
// 6. Add Firebase SDK scripts to index.html (before app.js):
//    <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-app-compat.js"></script>
//    <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-database-compat.js"></script>
//    <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-auth-compat.js"></script>
//    <script src="firebase-config.js"></script>
// 7. Remove or disable the Supabase <script> tag in index.html
// 8. Remove the Supabase-specific code block in app.js (clearly marked)
//
// All StorageAdapter.loadSession / .saveSession / .subscribeToSession calls
// in app.js will route to Firebase automatically.
