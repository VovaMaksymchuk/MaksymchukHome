// Data layer: Firebase Realtime Database.
import { firebaseConfig } from "./config.js";
import { dayKey, startOfDay, addDays, pinGuardNext, pinStatus } from "./logic.js";

const SDK = "https://www.gstatic.com/firebasejs/12.18.0";

// state shape handed to UI
export const emptyState = () => ({
  live: null,
  events: [],      // [{ts, on}]
  schedule: null,  // {latest:{updated, source, events}, days:{key:{events}}}
  history: {},     // {day: {sec: {...}}}
  switches: {},    // {<roomId>: {on, ts}}
  climate: {},     // {<id>: {current, target, mode, ts}}
  sensors: { leak: {}, smoke: {} }, // {<id>: {alarm, ts}}
  dtek: null,      // {end, restore, address:{status, active, reason, start, end}, ts}
  batteries: {},   // {<id>: {label, pct}}
  weather: null,   // {cond, t, hum, wind, tmax, tmin, precip, ts}
  serverOffset: 0,
  loaded: { live: false, events: false, schedule: false, history: false, smart: false },
});

// ============================ Firebase ============================
// Access paths:
//   • Google account listed in access/viewers/<uid>
//   • simple password (PIN): anonymous Firebase user + correct hash in pin_try/<uid>,
//     with a server-enforced lockout (see database.rules.json → pin_guard)
export async function connectFirebase({ onAuth, onState, onGuard, onError }) {
  const [{ initializeApp }, authMod, dbMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-database.js`),
  ]);
  const {
    getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
    getRedirectResult, signInAnonymously, signOut, browserLocalPersistence, setPersistence,
  } = authMod;
  const {
    getDatabase, ref, onValue, query, orderByKey, startAt, limitToLast, get, update, set, remove, serverTimestamp,
  } = dbMod;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  getRedirectResult(auth).catch((e) => onError?.(e));

  let serverOffset = 0;
  onValue(ref(db, ".info/serverTimeOffset"), (s) => (serverOffset = s.val() || 0));
  const serverNow = () => Date.now() + serverOffset;

  let unsubs = [];
  let guardUnsub = null;
  const stopAll = () => { unsubs.forEach((u) => u()); unsubs = []; stopGuard(); };
  const stopGuard = () => { guardUnsub?.(); guardUnsub = null; };

  const canRead = () => get(ref(db, "home/live")).then(() => true, () => false);

  function startSession(user) {
    stopAll();
    onAuth({ user, allowed: true });
    const st = emptyState();
    const emit = () => onState({ ...st });
    const sub = (q, fn, key) =>
      unsubs.push(onValue(q, (s) => { fn(s.val()); st.loaded[key] = true; emit(); }, (e) => onError?.(e)));

    sub(ref(db, ".info/serverTimeOffset"), (v) => (st.serverOffset = v || 0), "live");
    sub(ref(db, "home/live"), (v) => (st.live = v), "live");
    sub(query(ref(db, "home/grid_events"), limitToLast(400)), (v) => {
      st.events = Object.entries(v || {}).map(([sec, x]) => ({ ts: +sec * 1000, on: !!x.on }));
    }, "events");
    sub(ref(db, "home/schedule/latest"), (v) => {
      st.schedule = { ...(st.schedule || {}), latest: v };
    }, "schedule");
    sub(query(ref(db, "home/schedule/days"), limitToLast(14)), (v) => {
      st.schedule = { ...(st.schedule || {}), days: v || {} };
    }, "schedule");
    const since = dayKey(addDays(startOfDay(Date.now()), -1));
    sub(query(ref(db, "home/history"), orderByKey(), startAt(since)), (v) => (st.history = v || {}), "history");

    sub(ref(db, "home/switches"), (v) => (st.switches = v || {}), "smart");
    sub(ref(db, "home/climate"), (v) => (st.climate = v || {}), "smart");
    sub(ref(db, "home/sensors/leak"), (v) => (st.sensors = { ...st.sensors, leak: v || {} }), "smart");
    sub(ref(db, "home/sensors/smoke"), (v) => (st.sensors = { ...st.sensors, smoke: v || {} }), "smart");
    sub(ref(db, "home/dtek"), (v) => (st.dtek = v), "smart");
    sub(ref(db, "home/batteries"), (v) => (st.batteries = v || {}), "smart");
    sub(ref(db, "home/weather"), (v) => (st.weather = v), "smart");
  }

  // Команди для HA (вимикачі світла, уставка опалення) — HA читає home/commands,
  // виконує дію через Tuya і видаляє запис (див. ⚙️ smart_home.yaml).
  const setSwitch = (id, on) => set(ref(db, `home/commands/switches/${id}`), { on, ts: serverTimestamp() });
  // mode — необов'язково: "heat"/"off" для пристроїв, які можна вимкнути повністю (напр. тепла підлога).
  const setClimateTarget = (id, target, mode) =>
    set(ref(db, `home/commands/climate/${id}`), { target, ...(mode ? { mode } : {}), ts: serverTimestamp() });

  function showLogin(user) {
    stopAll();
    onAuth({ user, allowed: false, login: true });
    // live lockout status for the password form
    guardUnsub = onValue(ref(db, "pin_guard"), (s) => onGuard?.(s.val(), serverNow()), () => {});
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Silent anonymous session so the password form can read the lockout state.
      try { await signInAnonymously(auth); }
      catch (e) { stopAll(); onAuth({ user: null, login: true, pinUnavailable: true }); }
      return;
    }
    if (await canRead()) return startSession(user);
    if (user.isAnonymous) return showLogin(user);
    stopAll();
    onAuth({ user, allowed: false }); // Google account not in access/viewers
  });

  async function sha256hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Returns {ok:true} | {ok:false, locked, until, left}
  async function signInPin(pin) {
    let user = auth.currentUser;
    if (!user || !user.isAnonymous) user = (await signInAnonymously(auth)).user;
    const hash = await sha256hex(`${firebaseConfig.projectId}:${pin}`);

    for (let attempt = 0; attempt < 2; attempt++) {
      const g = (await get(ref(db, "pin_guard"))).val();
      const next = pinGuardNext(g, serverNow());
      if (next.locked) return { ok: false, locked: true, until: next.until, left: 0 };
      try {
        // Atomic: one counted attempt + the guess. Rules reject a guess without the count.
        await update(ref(db), {
          pin_guard: { n: next.n, lockMs: next.lockMs, ts: serverTimestamp() },
          [`pin_try/${user.uid}`]: hash,
        });
      } catch (e) {
        if (attempt === 0) continue; // someone else wrote pin_guard meanwhile — re-read once
        throw e;
      }
      if (await canRead()) {
        await set(ref(db, "pin_guard"), { n: 0, lockMs: 60000, ts: serverTimestamp() }).catch(() => {});
        startSession(user);
        return { ok: true };
      }
      const st = pinStatus({ n: next.n, lockMs: next.lockMs, ts: serverNow() }, serverNow());
      return { ok: false, ...st };
    }
  }

  return {
    signInPin,
    signInGoogle: async () => {
      const provider = new GoogleAuthProvider();
      try { await signInWithPopup(auth, provider); }
      catch (e) {
        if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code))
          await signInWithRedirect(auth, provider);
        else throw e;
      }
    },
    signOut: async () => {
      const u = auth.currentUser;
      if (u?.isAnonymous) await remove(ref(db, `pin_try/${u.uid}`)).catch(() => {});
      await signOut(auth);
    },
    serverNow,
    setSwitch,
    setClimateTarget,
  };
}
