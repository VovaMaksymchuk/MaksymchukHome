// Pure computations — no DOM, no Firebase. Testable in Node.
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ---------- time helpers (local time of the device; phone is in Kyiv) ----------
export const pad = (n) => String(n).padStart(2, "0");

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(dayStart, n) {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function hhmm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDur(ms, { short = false } = {}) {
  if (ms == null || !isFinite(ms)) return "—";
  const m = Math.round(Math.abs(ms) / MIN);
  if (m < 1) return "<1 хв";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h === 0) return `${mm} хв`;
  if (short) return mm ? `${h}:${pad(mm)}` : `${h} год`;
  return mm ? `${h} год ${mm} хв` : `${h} год`;
}

export function fmtHours(ms) {
  if (ms == null) return "—";
  const h = ms / HOUR;
  if (h < 1) return `${Math.round(ms / MIN)} хв`;
  return `${h.toLocaleString("uk-UA", { maximumFractionDigits: 1 })} год`;
}

export function relDay(ts, now) {
  const diff = Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
  if (diff === 0) return "сьогодні";
  if (diff === -1) return "вчора";
  if (diff === 1) return "завтра";
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

// ---------- intervals ----------
export function mergeIntervals(list) {
  const a = list
    .filter((x) => x && x.e > x.s)
    .map((x) => ({ ...x }))
    .sort((x, y) => x.s - y.s);
  const out = [];
  for (const it of a) {
    const last = out[out.length - 1];
    if (last && it.s <= last.e) {
      last.e = Math.max(last.e, it.e);
      if (it.possible === false) last.possible = false;
    } else out.push(it);
  }
  return out;
}

export function clip(list, a, b) {
  return list
    .map((x) => ({ ...x, s: Math.max(x.s, a), e: Math.min(x.e, b) }))
    .filter((x) => x.e > x.s);
}

export const total = (list) => list.reduce((acc, x) => acc + (x.e - x.s), 0);

export function overlap(A, B) {
  let sum = 0;
  for (const a of A)
    for (const b of B) sum += Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s));
  return sum;
}

// ---------- grid events → outages ----------
// events: [{ts: ms, on: bool}] in any order. Returns [{s, e, ongoing}]
export function outagesFromEvents(events, now) {
  const ev = [...events].filter((x) => x && isFinite(x.ts)).sort((a, b) => a.ts - b.ts);
  const out = [];
  let cur = null;
  let last = null;
  for (const x of ev) {
    if (x.on === last) continue; // duplicate state
    if (!x.on) cur = { s: x.ts };
    else if (cur) {
      cur.e = x.ts;
      out.push(cur);
      cur = null;
    }
    last = x.on;
  }
  if (cur) out.push({ ...cur, e: now, ongoing: true });
  return out;
}

export function lastEvent(events) {
  let best = null;
  for (const x of events) if (!best || x.ts > best.ts) best = x;
  return best;
}

// ---------- schedule ----------
const POSSIBLE_RE = /можлив|possible|ймовір|сір|grey|gray/i;

export function normalizeEvents(raw) {
  const arr = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
  return arr
    .filter((x) => x && isFinite(x.s) && isFinite(x.e) && x.e > x.s)
    .map((x) => ({ s: +x.s, e: +x.e, t: x.t || "", possible: POSSIBLE_RE.test(x.t || "") }))
    .sort((a, b) => a.s - b.s);
}

// Planned intervals for a given day: past days → frozen day snapshot,
// today/future → latest schedule (most current).
export function plannedForDay(dayStart, schedule, now) {
  const key = dayKey(dayStart);
  const todayKey = dayKey(now);
  const days = schedule?.days || {};
  let src;
  if (key < todayKey && days[key]) src = days[key].events;
  else src = schedule?.latest?.events;
  const hasData = key < todayKey ? !!days[key] || coversDay(schedule?.latest, dayStart) : !!schedule?.latest;
  return { list: clip(normalizeEvents(src), dayStart, addDays(dayStart, 1)), hasData };
}

function coversDay(latest, dayStart) {
  // latest covers from yesterday 00:00, so it also tells about yesterday
  if (!latest?.updated) return false;
  return latest.updated - dayStart < 2 * DAY;
}

export function plannedRange(a, b, schedule, now) {
  const out = [];
  let hasAny = false;
  for (let d = startOfDay(a); d < b; d = addDays(d, 1)) {
    const p = plannedForDay(d, schedule, now);
    hasAny = hasAny || p.hasData;
    out.push(...p.list);
  }
  return { list: mergeIntervals(clip(out, a, b)), hasData: hasAny };
}

export function scheduleNow(schedule, now) {
  const ev = mergeIntervals(normalizeEvents(schedule?.latest?.events));
  const current = ev.find((x) => x.s <= now && now < x.e) || null;
  const next = ev.find((x) => x.s > now) || null;
  return { current, next, events: ev };
}

// For each actual outage — was it planned? how far off?
export function classifyOutage(o, planned) {
  const dur = o.e - o.s;
  let best = null;
  let bestOv = 0;
  for (const p of planned) {
    const ov = Math.max(0, Math.min(o.e, p.e) - Math.max(o.s, p.s));
    if (ov > bestOv) {
      bestOv = ov;
      best = p;
    }
  }
  const planned_ = best && bestOv / Math.max(dur, 1) >= 0.5;
  return {
    planned: !!planned_,
    plan: planned_ ? best : null,
    startDelta: planned_ ? o.s - best.s : null,
    endDelta: planned_ && !o.ongoing ? o.e - best.e : null,
  };
}

// Jaccard similarity of planned vs actual time in a window
export function planAccuracy(planned, actual, a, b) {
  const P = clip(planned, a, b);
  const A = clip(actual, a, b);
  const inter = overlap(P, A);
  const union = total(P) + total(A) - inter;
  if (union <= 0) return null;
  return inter / union;
}

// ---------- battery ----------
export function batteryEstimate(live, cfg) {
  const soc = num(live?.bat?.soc);
  const p = num(live?.bat?.p);
  if (soc == null) return null;
  const kwh = (soc / 100) * cfg.batteryKWh;
  const usableKwh = Math.max(0, ((soc - cfg.reserveSoc) / 100) * cfg.batteryKWh);
  let state = "idle";
  let eta = null;
  if (p != null && p < -30) {
    state = "discharge";
    eta = (usableKwh * 1000 / -p) * HOUR;
  } else if (p != null && p > 30) {
    state = "charge";
    eta = (((100 - soc) / 100) * cfg.batteryKWh * 1000 / p) * HOUR;
  }
  return { soc, kwh, usableKwh, p, state, eta };
}

export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// ---------- history ----------
// raw: { 'YYYY-MM-DD': { '<sec>': {soc, load, bp, g} } } → sorted [{t, soc, load, bp, g}]
export function flattenHistory(raw) {
  const out = [];
  for (const day of Object.values(raw || {}))
    for (const [sec, v] of Object.entries(day || {}))
      out.push({ t: +sec * 1000, soc: num(v.soc), load: num(v.load), bp: num(v.bp), g: num(v.g) });
  return out.sort((a, b) => a.t - b.t);
}

// ---------- stats ----------
export function outageStats(outages, planned, now) {
  const today = startOfDay(now);
  const week = addDays(today, -6);
  const todayList = clip(outages, today, now);
  const weekList = clip(outages, week, now);
  const startedThisWeek = outages.filter((o) => o.e > week);
  const longest = startedThisWeek.reduce((m, o) => Math.max(m, o.e - o.s), 0);
  const avg = startedThisWeek.length ? total(startedThisWeek) / startedThisWeek.length : null;
  const plannedPast = clip(planned.list, week, now);
  const accuracy = planned.hasData ? planAccuracy(plannedPast, weekList, week, now) : null;
  const unplanned = startedThisWeek.filter((o) => !classifyOutage(o, planned.list).planned).length;
  return {
    today: total(todayList),
    week: total(weekList),
    weekCount: startedThisWeek.length,
    longest,
    avg,
    accuracy,
    unplanned,
    plannedWeek: total(plannedPast),
  };
}

// ---------- PIN lockout (mirror of database.rules.json → pin_guard) ----------
// The server rules are the real enforcement; this only predicts the next
// allowed write and drives the UI countdown.
export const PIN = { maxTries: 3, baseLockMs: 60_000, maxLockMs: 86_400_000, forgiveMs: 3_600_000 };

export function pinGuardNext(g, now) {
  if (!g || g.n == null) return { n: 1, lockMs: PIN.baseLockMs };
  if (g.n >= PIN.maxTries) {
    const until = g.ts + g.lockMs;
    if (now < until + 1000) return { locked: true, until }; // +1 s margin for clock skew
    return { n: 1, lockMs: Math.min(g.lockMs * 2, PIN.maxLockMs) };
  }
  if (now - g.ts > PIN.forgiveMs) return { n: 1, lockMs: g.lockMs };
  return { n: g.n + 1, lockMs: g.lockMs };
}

export function pinStatus(g, now) {
  if (!g || g.n == null) return { locked: false, left: PIN.maxTries };
  if (g.n >= PIN.maxTries) {
    const until = g.ts + g.lockMs;
    if (now < until + 1000) return { locked: true, until, left: 0 };
    return { locked: false, left: PIN.maxTries, nextLockMs: Math.min(g.lockMs * 2, PIN.maxLockMs) };
  }
  if (now - g.ts > PIN.forgiveMs) return { locked: false, left: PIN.maxTries };
  return { locked: false, left: PIN.maxTries - g.n };
}

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
