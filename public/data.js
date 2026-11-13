// Data layer: Firebase Realtime Database (real) or generated mock (demo).
import { firebaseConfig, rooms, climateDevices, sensorGroups } from "./config.js";
import { DAY, HOUR, MIN, dayKey, startOfDay, addDays, pinGuardNext, pinStatus } from "./logic.js";

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

// Real DTEK КРЕМ graphic for the apartment's subqueue, when available (see
// schedule-5.2.json + tools/fetch_dtek_schedule); falls back to a synthetic
// rotating pattern for any day it doesn't cover.
function parseHHMM(dayStart, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return dayStart + h * HOUR + (m || 0) * MIN;
}

// ============================ Demo ============================
// Deterministic-ish mock: three days of planned outages, actual outages that
// drift from the plan, one unplanned outage, and 5-minute history. `real`
// (parsed schedule-5.2.json) overrides the synthetic plan for days it covers.
export function demoState(now = Date.now(), real = null) {
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const today = startOfDay(now);
  const plan = {}; // key → events
  const patterns = [
    [[0, 4], [8, 12], [16, 20]],
    [[2, 6], [10, 14], [18, 22]],
    [[4, 8], [12, 16], [20, 24]],
  ];
  const realDays = real?.days || {};
  const latest = [];
  let usedReal = false;
  for (let d = -6; d <= 1; d++) {
    const ds = addDays(today, d);
    const key = dayKey(ds);
    const realEvs = realDays[key];
    let evs;
    if (realEvs) {
      usedReal = true;
      evs = realEvs.map((r) => {
        const s = parseHHMM(ds, r.start);
        let e = parseHHMM(ds, r.end);
        if (e <= s) e += DAY; // overnight block (e.g. 23:30–00:30)
        return { s, e, t: r.t || "Відключення" };
      });
    } else {
      const pat = patterns[(d + 9) % 3];
      evs = pat.map(([a, b], i) => ({
        s: ds + a * HOUR,
        e: ds + b * HOUR,
        t: i === 2 && d >= 0 ? "Можливе відключення" : "Відключення",
      }));
    }
    plan[key] = { updated: ds, events: evs };
    if (d >= -1) latest.push(...evs);
  }

  // actual outages: planned with jitter (non-"possible" ones mostly happen)
  const actual = [];
  for (let d = -6; d <= 0; d++) {
    for (const p of plan[dayKey(addDays(today, d))].events) {
      if (p.t.startsWith("Можливе") && rnd() < 0.5) continue;
      const s = p.s + Math.round((rnd() * 25 - 5) * MIN);
      const e = p.e + Math.round((rnd() * 40 - 15) * MIN);
      if (s < now) actual.push({ s, e: Math.min(e, now + DAY) });
    }
  }
  // one unplanned outage yesterday
  actual.push({ s: addDays(today, -1) + 9.2 * HOUR, e: addDays(today, -1) + 10.35 * HOUR });
  actual.sort((a, b) => a.s - b.s);

  const events = [];
  for (const o of actual) {
    events.push({ ts: o.s, on: false });
    if (o.e < now) events.push({ ts: o.e, on: true });
  }
  const isOff = (t) => actual.some((o) => o.s <= t && t < Math.min(o.e, now + 1));

  // history: simulate battery
  const history = {};
  let soc = 100;
  let load = 450;
  const step = 5 * MIN;
  const from = addDays(today, -1);
  let last = null;
  for (let t = from; t <= now; t += step) {
    load = Math.max(180, Math.min(1400, load + (rnd() - 0.5) * 160));
    const off = isOff(t);
    let bp;
    if (off) {
      bp = -load;
      soc = Math.max(10, soc - (load * (step / HOUR)) / 5120 * 100);
    } else {
      bp = soc < 99.5 ? 1500 : 0;
      soc = Math.min(100, soc + (bp * (step / HOUR)) / 5120 * 100);
    }
    const k = dayKey(t);
    (history[k] ||= {})[Math.floor(t / 1000)] = {
      soc: Math.round(soc), load: off ? Math.round(load) : 0, bp: Math.round(bp), g: off ? 0 : 1,
    };
    last = { off, load, soc, bp };
  }

  const off = last.off;
  const live = {
    ts: now - 7000,
    grid: { on: !off, v: off ? 0 : 228.4, hz: off ? 0 : 50.0 },
    out: { v: 230.1, hz: 50.0, p: off ? Math.round(last.load) : 0, va: off ? Math.round(last.load * 1.12) : 0, pct: off ? Math.round(last.load / 62) : 0 },
    // окремий лічильник на всю квартиру (планується, ще не в HA — див. CLAUDE.md TODO):
    // при світлі АВР живить квартиру напряму, інвертор лише підзаряджає батарею,
    // тож апаратно це інший датчик, і при увімкненій мережі з apt.p ≠ out.p.
    apt: { p: Math.round(last.load) },
    bat: { soc: Math.round(last.soc), v: 51.2 + last.soc / 100 * 2.6, a: +(last.bp / 52.4).toFixed(1), p: Math.round(last.bp), t: 24.5 },
    inv: { mode: off ? "Battery" : "Line", t: off ? 41 : 33, fault: "0" },
  };

  // розумний будинок: демо-стан (вимикачі/клімат/датчики) — тестові дані,
  // поки HA не пише у home/switches|climate|sensors насправді.
  const switches = {};
  rooms.forEach((r, i) => (switches[r.id] = { on: i % 2 === 0, ts: now }));
  const climate = {};
  climateDevices.forEach((c, i) => {
    const target = c.id === "floor" ? 24 : 22;
    climate[c.id] = { current: target - 0.5 - i * 0.3, target, mode: "heat", ts: now };
  });
  const sensors = { leak: {}, smoke: {} };
  sensorGroups.leak.forEach((s) => (sensors.leak[s.id] = { alarm: false, ts: now }));
  sensorGroups.smoke.forEach((s) => (sensors.smoke[s.id] = { alarm: false, ts: now }));

  return {
    ...emptyState(),
    live,
    events: events.map((e) => ({ ...e, ts: Math.floor(e.ts / 1000) * 1000 })),
    schedule: {
      latest: {
        updated: usedReal && real?.updated ? Date.parse(real.updated) : now - 12 * MIN,
        source: usedReal ? real.source || `ДТЕК КРЕМ, черга ${real.queue || ""}` : "calendar.demo",
        events: latest,
      },
      days: plan,
    },
    history,
    switches,
    climate,
    sensors,
    loaded: { live: true, events: true, schedule: true, history: true, smart: true },
  };
}
