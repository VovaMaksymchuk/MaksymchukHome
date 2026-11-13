import { settings, firebaseConfig, rooms, climateDevices, sensorGroups } from "./config.js";
import { connectFirebase, demoState } from "./data.js";
import {
  MIN, HOUR, DAY, hhmm, fmtDur, fmtHours, relDay, startOfDay, addDays, dayKey,
  outagesFromEvents, lastEvent, scheduleNow, plannedForDay, plannedRange, clip,
  classifyOutage, batteryEstimate, flattenHistory, outageStats, num,
  PIN, pinGuardNext, pinStatus, fmtCountdown,
} from "./logic.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (v, d = 0) => (v == null ? "—" : Number(v).toLocaleString("uk-UA", { maximumFractionDigits: d, minimumFractionDigits: d }));

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo") || firebaseConfig.apiKey.startsWith("YOUR_");

let state = null;
let api = null;
let ui = { day: 0, logPage: 0, panel: "status" }; // panel: активна вкладка (стан/світло/електрика)
const chartData = new Map();

// =============================== boot ===============================
async function boot() {
  $("#pin-input").inputMode = settings.pinKeyboard === "text" ? "text" : "numeric";
  if (DEMO) {
    if (params.get("demo") === "login") { api = demoLoginApi(); showScreen("login"); updatePinUI(); return; }
    return startDemo();
  }
  showScreen("loading");
  try {
    api = await connectFirebase({
      onAuth: ({ user, allowed, login, pinUnavailable }) => {
        if (allowed) return showApp();
        if (login) {
          $("#pin-form").hidden = !!pinUnavailable;
          if (pinUnavailable) $("#pin-status").textContent = "Вхід за паролем недоступний — увімкни Anonymous у Firebase Authentication.";
          showScreen("login");
          return updatePinUI();
        }
        $("#uid").textContent = user.uid;
        $("#who").textContent = user.email || user.uid;
        showScreen("noaccess");
      },
      onState: (s) => { state = s; scheduleRender(); },
      onGuard: (g) => { pinGuard = g; updatePinUI(); },
      onError: (e) => {
        // PIN changed / access revoked while the page was open → back to login
        if (/permission/i.test(e?.code || e?.message || "")) return location.reload();
        toast(e.message || String(e));
      },
    });
  } catch (e) {
    toast("Не вдалось завантажити Firebase: " + e.message);
  }
}

async function fetchRealSchedule() {
  try {
    const r = await fetch("./schedule-5.2.json", { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function startDemo() {
  const t0 = params.get("now") ? +params.get("now") : Date.now();
  const shift = Date.now() - t0;
  const real = await fetchRealSchedule();
  state = demoState(t0, real);
  state.serverOffset = -shift; // lets ?now= freeze the demo clock
  showApp();
  render();
}

// ---------- password (PIN) login ----------
let pinGuard = null;
let pinMsg = "";
let pinBusy = false;
let pinTick = 0;

const triesWord = (n) => (n === 1 ? "залишилась 1 спроба" : `залишилось ${n} спроби`);

function updatePinUI() {
  const box = $("#pin-status"), inp = $("#pin-input"), btn = $("#pin-submit");
  if (!box || $("#pin-form").hidden) return;
  const t = api?.serverNow ? api.serverNow() : Date.now();
  const st = pinStatus(pinGuard, t);
  inp.disabled = btn.disabled = st.locked || pinBusy;
  clearTimeout(pinTick);
  if (st.locked) {
    box.className = "pin-status small is-locked";
    box.innerHTML = `Забагато невдалих спроб.<br>Спробуй через <span class="countdown">${fmtCountdown(st.until - t)}</span> або увійди через Google.`;
    pinTick = setTimeout(updatePinUI, 1000);
    return;
  }
  box.className = "pin-status small";
  const left = st.left < PIN.maxTries ? triesWord(st.left) : "";
  box.textContent = pinMsg ? `${pinMsg}${left ? " " + left[0].toUpperCase() + left.slice(1) + "." : ""}` : left ? left[0].toUpperCase() + left.slice(1) : "";
  if (!pinBusy && document.activeElement !== inp && !$("[data-screen=login]").hidden) inp.focus({ preventScroll: true });
}

async function submitPin(pin) {
  if (pinBusy || !pin) return;
  pinBusy = true; pinMsg = ""; updatePinUI();
  $("#pin-submit").textContent = "Перевіряю…";
  try {
    const r = await api.signInPin(pin);
    if (r.ok) { pinMsg = ""; return; }
    pinMsg = r.locked ? "" : "Невірний пароль.";
    if (r.locked && !pinStatus(pinGuard, api.serverNow()).locked) pinGuard = { n: PIN.maxTries, ts: r.until - 60_000, lockMs: 60_000 };
    const inp = $("#pin-input");
    inp.value = "";
    inp.setAttribute("aria-invalid", "true");
    setTimeout(() => inp.removeAttribute("aria-invalid"), 600);
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    pinBusy = false;
    $("#pin-submit").textContent = "Увійти";
    updatePinUI();
  }
}

// Demo of the login screen: ?demo=login, password 1234 (lockout is local only)
function demoLoginApi() {
  let g = null;
  return {
    serverNow: () => Date.now(),
    signInPin: async (pin) => {
      await new Promise((r) => setTimeout(r, 350));
      const t = Date.now();
      const nx = pinGuardNext(g, t);
      if (nx.locked) return { ok: false, locked: true, until: nx.until };
      g = { n: nx.n, lockMs: nx.lockMs, ts: t };
      if (pin === "1234") { g = null; pinGuard = null; startDemo(); return { ok: true }; }
      pinGuard = g;
      return { ok: false, ...pinStatus(g, t) };
    },
    signInGoogle: async () => startDemo(),
    signOut: async () => { location.search = "?demo=login"; },
  };
}

function showScreen(name) {
  for (const el of document.querySelectorAll("[data-screen]")) el.hidden = el.dataset.screen !== name;
}
function showApp() {
  showScreen("app");
  $("#demo-badge").hidden = !DEMO;
}

let raf = 0;
function scheduleRender() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(render);
}

const now = () => Date.now() + (state?.serverOffset || 0);

// =============================== render ===============================
function render() {
  if (!state) return;
  const t = now();
  const live = state.live;
  const outages = outagesFromEvents(state.events, t);
  const sched = scheduleNow(state.schedule, t);
  const planned7 = plannedRange(addDays(startOfDay(t), -6), addDays(startOfDay(t), 2), state.schedule, t);
  const bat = live ? batteryEstimate(live, settings) : null;
  const stale = !live || (t - (live.ts || 0)) / 1000 > settings.staleAfterSec;
  const gridOn = live?.grid?.on ?? (lastEvent(state.events)?.on ?? null);

  renderHeader(live, stale, t);
  renderPanels();
  renderHero({ live, gridOn, outages, sched, bat, stale, t });
  renderFlow({ live, gridOn, bat });
  renderClimate(state.climate);
  renderSensors(state.sensors);
  renderSwitches(state.switches);
  renderBattery(bat, live);
  renderInverter(live, gridOn);
  renderTimeline(outages, t);
  renderCharts(outages, t);
  renderStats(outageStats(outages, planned7, t));
  renderLog(outages, planned7.list, t);
  renderFooter(t);
}

// ---------- вкладки ----------
function renderPanels() {
  for (const tab of document.querySelectorAll(".tabbar [role=tab]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.panel === ui.panel));
  }
  for (const panel of document.querySelectorAll("main[data-panel]")) {
    panel.hidden = panel.dataset.panel !== ui.panel;
  }
}

function renderHeader(live, stale, t) {
  $("#title").textContent = settings.title;
  const chip = $("#live-chip");
  if (!live) { chip.className = "chip chip--muted"; chip.textContent = "очікую дані"; return; }
  const age = t - live.ts;
  chip.className = stale ? "chip chip--warn" : "chip chip--ok";
  chip.innerHTML = stale
    ? `<span class="pulse off"></span>офлайн · ${fmtDur(age)}`
    : `<span class="pulse"></span>наживо · ${Math.max(0, Math.round(age / 1000))} с`;
  $("#stale-banner").hidden = !stale;
  if (stale) $("#stale-banner").textContent =
    `Home Assistant не надсилав дані ${fmtDur(age)}. Показую останній відомий стан.`;
}

function renderHero({ live, gridOn, outages, sched, bat, t }) {
  const el = $("#hero");
  if (gridOn == null) {
    el.className = "card hero";
    el.innerHTML = `<div class="hero__status">Очікую дані з Home Assistant…</div>`;
    return;
  }
  const last = lastEvent(state.events);
  const since = last && last.on === gridOn ? last.ts : null;
  let main = "", sub = "", verdict = "";

  if (gridOn) {
    main = since ? fmtDur(t - since) : "";
    const n = sched.next;
    sub = since ? `з ${hhmm(since)}${relDay(since, t) !== "сьогодні" ? " " + relDay(since, t) : ""}` : "";
    if (n) {
      verdict = `<div class="hero__next">
        <span class="tag ${n.possible ? "tag--possible" : "tag--plan"}">${n.possible ? "можливе" : "за графіком"}</span>
        Наступне відключення <b>${relDay(n.s, t) === "сьогодні" ? "" : relDay(n.s, t) + " "}${hhmm(n.s)}–${hhmm(n.e)}</b>
        <span class="muted">· через ${fmtDur(n.s - t)}</span></div>`;
    } else if (state.schedule?.latest) {
      verdict = `<div class="hero__next muted">Відключень за графіком найближчим часом немає</div>`;
    } else {
      verdict = `<div class="hero__next muted">Графік відключень ще не надходив</div>`;
    }
  } else {
    main = since ? fmtDur(t - since) : "";
    sub = since ? `з ${hhmm(since)}${relDay(since, t) !== "сьогодні" ? " " + relDay(since, t) : ""}` : "";
    const cur = sched.current;
    let planLine;
    if (cur) {
      planLine = `За графіком увімкнуть о <b>${hhmm(cur.e)}</b> <span class="muted">· ще ${fmtDur(cur.e - t)}</span>`;
    } else if (sched.next && sched.next.s - t < 30 * MIN) {
      planLine = `Раніше за графіком (план з ${hhmm(sched.next.s)})`;
    } else {
      planLine = `<span class="tag tag--unplanned">позапланове</span> у графіку зараз відключення немає`;
    }
    let batLine = "";
    if (bat?.state === "discharge" && bat.eta != null) {
      const enough = cur ? bat.eta > cur.e - t : null;
      batLine = `<div class="hero__bat ${enough === false ? "is-bad" : ""}">
        ${enough === false ? "⚠️" : "🔋"} Заряду вистачить на <b>~${fmtDur(bat.eta)}</b>
        <span class="muted">при ${nf(-bat.p)} Вт${enough === true ? " — з запасом до увімкнення" : enough === false ? " — може не вистачити до увімкнення" : ""}</span></div>`;
    }
    verdict = `<div class="hero__next">${planLine}</div>${batLine}`;
  }

  el.className = `card hero ${gridOn ? "hero--on" : "hero--off"}`;
  el.innerHTML = `
    <div class="hero__status"><span class="status-dot"></span>${gridOn ? "Світло є" : "Світла немає"}</div>
    <div class="hero__big">${main || "&nbsp;"}</div>
    <div class="hero__since muted">${sub}</div>
    ${verdict}`;
}

// ---------- energy flow diagram: без прямокутників, лише іконки + лінії ----------
// Місто й Батарея зліва одне над одним (підпис над/під лінією, біля іконки), Дім справа
// (підпис під іконкою). ViewBox 0 0 300 190.
const FLOW = {
  grid: { cx: 40, cy: 54, size: 54 },
  bat: { cx: 40, cy: 146, size: 54 },
  home: { cx: 268, cy: 100, size: 68 },
};
// Пряма ділянка → короткий плавний поворот (не суцільна дуга на всю довжину) → пряма ділянка.
function elbowPath(x1, y1, x2, y2, r = 20) {
  const bx = (x1 + x2) / 2;
  return `M${x1},${y1} L${bx - r},${y1} C${bx},${y1} ${bx},${y2} ${bx + r},${y2} L${x2},${y2}`;
}
// Дві окремі лінії заходять у лампочку на різній висоті (не зливаються в одну точку)
const homeX = FLOW.home.cx - FLOW.home.size / 2;
FLOW.gridHome = elbowPath(FLOW.grid.cx + FLOW.grid.size / 2, FLOW.grid.cy, homeX, FLOW.home.cy - 10);
FLOW.batHome = elbowPath(FLOW.bat.cx + FLOW.bat.size / 2, FLOW.bat.cy, homeX, FLOW.home.cy + 10);
FLOW.gridBat = `M${FLOW.grid.cx},${FLOW.grid.cy + FLOW.grid.size / 2} L${FLOW.bat.cx},${FLOW.bat.cy - FLOW.bat.size / 2}`;

function flowDur(w) {
  // більша потужність → швидша «кулька»
  return Math.max(0.5, Math.min(3, 2400 / Math.max(1, Math.abs(w))));
}

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// дві кульки по черзі (зсув на пів-періоду) — враження безперервного потоку.
// #flow перемальовується повністю кожні 20с (і при кожному пакеті з HA) — звичайний
// begin="0s" тоді щоразу смикав кульку на старт. Прив'язуємо фазу до реального часу
// (Date.now()), щоб щойно створений <animateMotion> виглядав як продовження попереднього.
function flowBalls(path, color, dur) {
  if (reduceMotion()) return "";
  const d = Number(dur); // dur приходить як рядок (toFixed) з flowEdge — рахувати лише числом
  const now = Date.now() / 1000;
  const ball = (offset) => {
    const phase = (((now + offset) % d) + d) % d;
    return `
    <circle r="4" class="flow__ball" style="--flow-color:${color}">
      <animateMotion dur="${d}s" begin="${(-phase).toFixed(3)}s" repeatCount="indefinite" path="${path}"/>
    </circle>`;
  };
  return ball(0) + ball(d / 2);
}

function flowEdge(path, { active, color, watts }) {
  const dur = flowDur(watts).toFixed(2);
  const style = active ? `--flow-color:${color}` : "";
  const balls = active ? flowBalls(path, color, dur) : "";
  return `<path d="${path}" class="flow__edge ${active ? "is-active" : ""}" style="${style}"/>${balls}`;
}

// Іконки (svgrepo.com) нормалізовані до боксу 24×24 через вкладений <g scale>,
// щоб зовнішній transform у flowBoxRow/flowBoxCol був однаковий для всіх трьох.
const FLOW_ICONS = {
  grid: `<g transform="scale(0.046875)" style="fill:currentColor;stroke:none">
    <path d="M453.785,116.364h-23.273c-6.982,0-11.636,4.655-11.636,11.636s4.655,11.636,11.636,11.636h23.273c6.982,0,11.636-4.655,11.636-11.636S460.767,116.364,453.785,116.364z"/>
    <path d="M453.785,162.909h-23.273c-6.982,0-11.636,4.655-11.636,11.636s4.655,11.636,11.636,11.636h23.273c6.982,0,11.636-4.655,11.636-11.636S460.767,162.909,453.785,162.909z"/>
    <path d="M81.422,116.364H58.149c-6.982,0-11.636,4.655-11.636,11.636s4.655,11.636,11.636,11.636h23.273c6.982,0,11.636-4.655,11.636-11.636S88.404,116.364,81.422,116.364z"/>
    <path d="M81.422,162.909H58.149c-6.982,0-11.636,4.655-11.636,11.636s4.655,11.636,11.636,11.636h23.273c6.982,0,11.636-4.655,11.636-11.636S88.404,162.909,81.422,162.909z"/>
    <path d="M458.44,70.982L307.167,1.164C306.004,0,303.676,0,302.513,0h-93.091c-1.164,0-3.491,0-4.655,1.164L53.495,70.982c-4.655,2.327-8.145,8.145-6.982,12.8c1.164,5.818,5.818,9.309,11.636,9.309h125.673l-55.855,315.345c-1.164,5.818,3.491,12.8,9.309,13.964c1.164,0,1.164,0,2.327,0c5.818,0,10.473-3.491,11.636-9.309l13.964-82.618l164.073,121.018c2.327,1.164,4.655,2.327,6.982,2.327c3.491,0,6.982-1.164,9.309-4.655c3.491-4.655,2.327-12.8-2.327-16.291l-67.491-50.036l70.982-52.364l23.273,134.982H162.876l66.327-48.873c4.655-3.491,5.818-11.636,2.327-16.291s-11.636-5.818-16.291-2.327l-90.764,67.491H93.058c-3.491,0-5.818,1.164-8.146,3.491L61.64,492.218c-4.655,4.655-4.655,11.636,0,16.291c4.655,4.655,11.636,4.655,16.291,0l19.782-19.782h316.509l19.782,19.782c2.327,2.327,5.818,3.491,8.145,3.491s5.818-1.164,8.145-3.491c4.655-4.655,4.655-11.636,0-16.291l-23.273-23.273c-2.327-2.327-4.655-3.491-8.145-3.491h-25.6L328.113,93.091h125.673c5.818,0,10.473-3.491,11.636-9.309C466.585,77.964,464.258,73.309,458.44,70.982z M342.076,303.709l-86.109,65.164l-73.309-54.691L228.04,281.6c4.655-3.491,6.982-10.473,2.327-16.291c-3.491-5.818-10.473-6.982-16.291-2.327l-41.891,30.255l13.964-81.455l121.018,86.109c2.327,1.164,4.655,2.327,6.982,2.327c3.491,0,6.982-1.164,9.309-4.655c3.491-4.655,2.327-12.8-2.327-16.291l-45.382-32.582l50.036-36.073L342.076,303.709z M303.676,165.236L273.422,140.8l33.745-27.927l12.8,73.309l-65.164,46.545l-50.036-36.073l23.273-18.618c4.655-3.491,5.818-11.636,1.164-16.291s-11.636-5.818-16.291-1.164l-22.109,17.455l11.636-65.164l86.109,70.982c2.327,2.327,4.655,2.327,6.982,2.327c3.491,0,6.982-1.164,9.309-4.655C308.331,176.873,308.331,168.727,303.676,165.236z M325.785,69.818l-2.327-13.964c-1.164-5.818-6.982-10.473-13.964-9.309c-5.818,1.164-10.473,6.982-9.309,13.964l1.164,9.309h-57.018c-6.982,0-11.636,4.655-11.636,11.636s4.655,11.636,11.636,11.636h51.2l-39.564,32.582l-47.709-39.564l4.655-26.764c1.164-5.818-3.491-11.636-9.309-12.8s-12.8,3.491-13.964,9.309l-2.327,13.964h-1.164h-74.473l101.236-46.545h88.436l101.236,46.545H325.785z"/>
  </g>`,
  battery: `<g transform="scale(0.046875)" style="fill:currentColor;stroke:none">
    <path d="M290.909,151.273h-23.273V128c0-6.982-4.655-11.636-11.636-11.636s-11.636,4.655-11.636,11.636v23.273h-23.273c-6.982,0-11.636,4.655-11.636,11.636c0,6.982,4.655,11.636,11.636,11.636h23.273v23.273c0,6.982,4.655,11.636,11.636,11.636s11.636-4.655,11.636-11.636v-23.273h23.273c6.982,0,11.636-4.655,11.636-11.636C302.545,155.927,297.891,151.273,290.909,151.273z"/>
    <path d="M290.909,384h-69.818c-6.982,0-11.636,4.655-11.636,11.636c0,6.982,4.655,11.636,11.636,11.636h69.818c6.982,0,11.636-4.655,11.636-11.636C302.545,388.655,297.891,384,290.909,384z"/>
    <path d="M349.091,46.545h-34.909V11.636C314.182,4.655,309.527,0,302.545,0h-93.091c-6.982,0-11.636,4.655-11.636,11.636s4.655,11.636,11.636,11.636h81.455v34.909c0,6.982,4.655,11.636,11.636,11.636h46.545c6.982,0,11.636,4.655,11.636,11.636v395.636c0,6.982-4.655,11.636-11.636,11.636H162.909c-6.982,0-11.636-4.655-11.636-11.636V81.455c0-6.982,4.655-11.636,11.636-11.636H256c6.982,0,11.636-4.655,11.636-11.636S262.982,46.545,256,46.545h-93.091C143.127,46.545,128,61.673,128,81.455v395.636C128,496.873,143.127,512,162.909,512h186.182C368.873,512,384,496.873,384,477.091V81.455C384,61.673,368.873,46.545,349.091,46.545z"/>
  </g>`,
  home: `<g transform="scale(0.046776)" style="fill:currentColor;stroke:none">
    <path d="M256.582,0c-89.6,0-162.909,73.309-162.909,162.909c0,51.2,22.109,97.745,60.509,126.836c20.945,16.291,31.418,37.236,32.582,66.327c-6.982,5.818-11.636,13.964-11.636,23.273c0,6.982,2.327,12.8,5.818,17.455c-3.491,4.655-5.818,10.473-5.818,17.455c0,6.982,2.327,12.8,5.818,17.455c-3.491,4.655-5.818,10.473-5.818,17.455c0,16.291,12.8,29.091,29.091,29.091h9.309l9.309,26.764c1.164,4.655,5.818,8.145,10.473,8.145h46.545c4.655,0,9.309-3.491,10.473-8.145l9.309-26.764h9.309c16.291,0,29.091-12.8,29.091-29.091c0-6.982-2.327-12.8-5.818-17.455c3.491-4.655,5.818-10.473,5.818-17.455c0-6.982-2.327-12.8-5.818-17.455c3.491-4.655,5.818-10.473,5.818-17.455c0-16.291-12.8-29.091-29.091-29.091h-40.727V232.727c0-6.982-4.655-11.636-11.636-11.636s-11.636,4.655-11.636,11.636v128c0,6.982,4.655,11.636,11.636,11.636h52.364c3.491,0,5.818,2.327,5.818,5.818S312.436,384,308.945,384c-6.982,0-11.636,4.655-11.636,11.636c0,6.982,4.655,11.636,11.636,11.636c3.491,0,5.818,2.327,5.818,5.818s-2.327,5.818-5.818,5.818h-52.364c-6.982,0-11.636,4.655-11.636,11.636s4.655,11.636,11.636,11.636h52.364c3.491,0,5.818,2.327,5.818,5.818s-2.327,5.818-5.818,5.818H204.218c-3.491,0-5.818-2.327-5.818-5.818s2.327-5.818,5.818-5.818c6.982,0,11.636-4.655,11.636-11.636s-4.655-11.636-11.636-11.636c-3.491,0-5.818-2.327-5.818-5.818s2.327-5.818,5.818-5.818h64c6.982,0,11.636-4.655,11.636-11.636c0-6.982-4.655-11.636-11.636-11.636h-64c-3.491,0-5.818-2.327-5.818-5.818s2.327-5.818,5.818-5.818c6.982,0,11.636-4.655,11.636-11.636c0-4.655-2.327-8.145-5.818-10.473c-2.327-34.909-16.291-61.673-41.891-80.291c-32.582-24.436-51.2-64-51.2-107.055c0-76.8,62.836-139.636,139.636-139.636s139.636,62.836,139.636,139.636c0,43.055-18.618,83.782-51.2,107.055c-18.618,13.964-30.255,31.418-37.236,52.364c-2.327,5.818,1.164,12.8,8.145,13.964c5.818,2.327,12.8-1.164,13.964-8.146c4.655-16.291,13.964-30.255,29.091-40.727c38.4-26.764,60.509-74.473,60.509-124.509C419.491,73.309,346.182,0,256.582,0z M275.2,477.091l-3.491,11.636h-30.255l-3.491-11.636H275.2z"/>
    <path d="M291.491,128c-25.6,0-46.545,20.945-46.545,46.545c0,12.8-10.473,23.273-23.273,23.273c-12.8,0-23.273-10.473-23.273-23.273s10.473-23.273,23.273-23.273c6.982,0,11.636-4.655,11.636-11.636S228.655,128,221.673,128c-25.6,0-46.545,20.945-46.545,46.545c0,25.6,20.945,46.545,46.545,46.545c25.6,0,46.545-20.945,46.545-46.545c0-12.8,10.473-23.273,23.273-23.273c12.8,0,23.273,10.473,23.273,23.273s-10.473,23.273-23.273,23.273c-6.982,0-11.636,4.655-11.636,11.636c0,6.982,4.655,11.636,11.636,11.636c25.6,0,46.545-20.945,46.545-46.545C338.036,148.945,317.091,128,291.491,128z"/>
  </g>`,
};

// Іконки кімнат для плиток "Світло" (svgrepo.com), той самий 512→24 бокс, що й FLOW_ICONS.
const ROOM_ICONS = {
  office: `<g transform="scale(0.046875)" style="fill:currentColor;stroke:none">
    <path d="M307.86,74.668h-2.862c-5.925,0-10.73,4.804-10.73,10.73s4.804,10.73,10.73,10.73h2.862c5.925,0,10.73-4.804,10.73-10.73 S313.785,74.668,307.86,74.668z"/>
    <path d="M443.77,190.817h-37.919c-5.925,0-10.73,4.804-10.73,10.73v58.842c0,15.977-10.534,29.537-25.022,34.104V85.398V53.305 C370.1,23.912,346.191,0,316.805,0h-121.61C165.808,0,141.9,23.912,141.9,53.305v32.093v209.095 c-14.487-4.568-25.022-18.128-25.022-34.104v-58.842c0-5.926-4.804-10.73-10.73-10.73H68.23c-5.926,0-10.73,4.804-10.73,10.73 s4.804,10.73,10.73,10.73h27.189v48.112c0,31.546,25.664,57.211,57.211,57.211h73.863v79.4h-21.824 c-31.614,0-57.831,23.497-62.136,53.941c-4.62,1.509-8.856,4.086-12.394,7.623c-5.908,5.908-9.162,13.766-9.162,22.127 c0,17.264,14.04,31.309,31.299,31.309c8.36,0,16.221-3.258,22.138-9.173c5.908-5.909,9.161-13.771,9.161-22.136 c0-8.359-3.253-16.217-9.162-22.127c-2.986-2.985-6.468-5.291-10.26-6.846c3.755-18.938,20.493-33.26,40.516-33.26h32.554h8.047 v32.818c-4.238,1.544-8.127,4.009-11.419,7.299c-5.901,5.919-9.15,13.772-9.15,22.115c0,17.264,14.04,31.309,31.299,31.309 c8.359,0,16.221-3.258,22.135-9.172c5.916-5.915,9.174-13.777,9.174-22.138c0-8.354-3.258-16.212-9.173-22.127 c-3.284-3.284-7.17-5.745-11.407-7.288v-32.818h8.047h32.554c19.979,0,36.688,14.259,40.494,33.133 c-3.921,1.556-7.524,3.907-10.601,6.984c-5.901,5.919-9.151,13.773-9.151,22.115c0,17.264,14.041,31.309,31.299,31.309 c8.358,0,16.22-3.258,22.148-9.184c5.901-5.919,9.15-13.776,9.15-22.126c0-8.342-3.249-16.196-9.162-22.128 c-3.443-3.442-7.548-5.976-12.024-7.5c-4.254-30.503-30.497-54.064-62.153-54.064h-21.824v-28.97h73.863 c5.925,0,10.73-4.804,10.73-10.73s-4.805-10.73-10.73-10.73h-73.863v-28.97h73.863c31.546,0,57.211-25.664,57.211-57.211v-48.112 h27.189c5.925,0,10.73-4.804,10.73-10.73S449.695,190.817,443.77,190.817z M159.238,487.652c-1.862,1.863-4.335,2.887-6.963,2.887 c-5.425,0-9.839-4.419-9.839-9.85c0-2.628,1.021-5.097,2.877-6.952c1.862-1.863,4.335-2.887,6.962-2.887 c2.628,0,5.101,1.026,6.961,2.886c1.855,1.855,2.878,4.324,2.878,6.952C162.115,483.326,161.094,485.798,159.238,487.652z M352.409,473.739c1.862-1.862,4.334-2.887,6.961-2.887s5.101,1.026,6.952,2.876c1.861,1.867,2.886,4.34,2.886,6.964 c0.001,2.63-1.025,5.106-2.875,6.961c-1.863,1.863-4.336,2.888-6.964,2.888c-5.426,0-9.839-4.419-9.839-9.85 C349.531,478.068,350.557,475.595,352.409,473.739z M262.961,487.653c-1.862,1.862-4.334,2.887-6.961,2.887 c-5.425,0-9.839-4.419-9.839-9.85c0-2.622,1.026-5.096,2.877-6.952c1.862-1.863,4.335-2.887,6.963-2.887s5.1,1.026,6.963,2.887 c1.86,1.862,2.886,4.331,2.886,6.952C265.85,483.318,264.823,485.791,262.961,487.653z M247.953,396.999v-79.4h16.095v79.4 H247.953z M274.777,296.14h-37.554h-72.672c1.988-8.794,6.42-16.872,12.952-23.411c9.12-9.12,21.245-14.143,34.141-14.143h88.713 c22.93,0,42.183,16.074,47.08,37.554H274.777z M348.64,74.668h-5.73c-5.925,0-10.73,4.804-10.73,10.73s4.805,10.73,10.73,10.73 h5.73v160.492c-12.543-12.057-29.557-19.493-48.284-19.493h-88.713c-18.15,0-35.23,6.904-48.284,19.446V96.127h104.711 c5.925,0,10.73-4.804,10.73-10.73s-4.805-10.73-10.73-10.73H163.36V53.305c0-17.56,14.281-31.846,31.835-31.846h121.61 c17.554,0,31.835,14.286,31.835,31.846V74.668z"/>
  </g>`,
  bedroom: `<g transform="scale(0.046875)" style="fill:currentColor;stroke:none">
    <path d="M469.343,53.383H42.657C19.136,53.383,0,72.513,0,96.025v163.863v68.257v60.596v55.421 c0,7.982,6.472,14.455,14.455,14.455h69.76c7.984,0,14.455-6.473,14.455-14.455v-40.966h314.659v40.966 c0,7.982,6.472,14.455,14.455,14.455h69.76c7.984,0,14.455-6.473,14.455-14.455v-55.421v-60.596v-68.257V96.025 C512,72.513,492.864,53.383,469.343,53.383z M69.76,429.707H28.91v-26.511h40.85V429.707z M84.215,374.286H28.91v-31.686h288.524 c7.984,0,14.455-6.473,14.455-14.455s-6.472-14.455-14.455-14.455H28.91v-53.802c0-13.08,10.64-23.721,23.721-23.721h28.982 h145.953h56.866h145.953h28.982c13.08,0,23.721,10.64,23.721,23.721v53.802h-64.716c-7.984,0-14.455,6.473-14.455,14.455 s6.472,14.455,14.455,14.455h64.716v31.686h-55.305H84.215z M96.069,207.259v-24.342c0-16.524,13.442-29.965,29.965-29.965h57.112 c16.524-0.001,29.965,13.442,29.965,29.965v24.342H96.069z M298.888,207.259v-24.342c0-16.524,13.442-29.965,29.965-29.965h57.112 c16.524-0.001,29.965,13.442,29.965,29.965v24.342H298.888z M483.09,429.707h-40.85v-26.511h40.85V429.707z M483.09,212.912 c-7.132-3.617-15.192-5.655-23.721-5.655h-14.527v-24.342c0-32.465-26.411-58.876-58.876-58.876h-57.112 c-32.463,0-58.876,26.411-58.876,58.876v24.342h-27.956v-24.342c0-32.465-26.411-58.876-58.876-58.876h-57.112 c-32.463,0-58.876,26.411-58.876,58.876v24.342H52.631c-8.529,0-16.589,2.038-23.721,5.655V96.025 c0-7.572,6.167-13.732,13.747-13.732h426.686c7.58,0,13.747,6.161,13.747,13.732V212.912z"/>
    <path d="M371.034,313.69h-7.589c-7.984,0-14.455,6.473-14.455,14.455s6.472,14.455,14.455,14.455h7.589 c7.984,0,14.455-6.473,14.455-14.455S379.017,313.69,371.034,313.69z"/>
  </g>`,
  living: `<g transform="scale(0.046875)" style="fill:currentColor;stroke:none">
    <path d="M394.585,188.895H279.962h-47.936H117.44c-6.616,0-11.981,5.364-11.981,11.981s5.365,11.981,11.981,11.981h102.607 v208.482c0,6.617,5.365,11.981,11.981,11.981h47.936c6.616,0,11.981-5.364,11.981-11.981V212.857h102.64 c6.616,0,11.981-5.364,11.981-11.981S401.201,188.895,394.585,188.895z M267.981,409.358h-23.974V212.857h23.974V409.358z"/>
    <path d="M501.513,78.775c-6.557-0.821-12.556,3.826-13.383,10.391l-0.563,4.472c-0.826,6.566,3.827,12.557,10.392,13.383 c0.508,0.064,1.011,0.095,1.511,0.095c5.95,0,11.11-4.429,11.872-10.486l0.563-4.473 C512.731,85.592,508.079,79.601,501.513,78.775z"/>
    <path d="M496.432,119.175c-6.567-0.822-12.556,3.827-13.383,10.392L465.487,269.18h-77.097c-22.575,0-40.939,18.366-40.939,40.939 v9.98v101.24c0,6.617,5.365,11.981,11.981,11.981s11.981-5.364,11.981-11.981V332.08h92.661v89.259 c0,6.617,5.365,11.981,11.981,11.981c6.616,0,11.981-5.364,11.981-11.981v-101.24v-38.187l18.787-149.353 C507.65,125.993,502.996,120.002,496.432,119.175z M464.075,308.118h-92.544c0.993-8.423,8.175-14.976,16.86-14.976h75.684 V308.118z"/>
    <path d="M123.61,269.18H46.513L23.87,89.167c-0.824-6.564-6.809-11.218-13.383-10.392C3.923,79.601-0.731,85.592,0.095,92.158 l23.869,189.754v38.187v101.24c0,6.617,5.365,11.981,11.981,11.981c6.616,0,11.981-5.364,11.981-11.981V332.08h92.661v89.259 c0,6.617,5.365,11.981,11.981,11.981c6.616,0,11.981-5.364,11.981-11.981v-101.24v-9.98 C164.549,287.545,146.184,269.18,123.61,269.18z M47.926,308.118v-14.976h75.684c8.685,0,15.866,6.554,16.86,14.976H47.926z"/>
  </g>`,
  hallway: `<g transform="scale(0.046875)" style="fill:currentColor;stroke:none">
    <path d="M417.423,91.063c-6.475,0-11.725,5.251-11.725,11.725v3.909c0,6.475,5.251,11.725,11.725,11.725 s11.725-5.251,11.725-11.725v-3.909C429.149,96.313,423.898,91.063,417.423,91.063z"/>
    <path d="M417.423,77.774c6.475,0,11.725-5.251,11.725-11.725V52.377C429.149,23.496,405.652,0,376.771,0H256H135.229 c-28.881,0-52.377,23.496-52.377,52.377v313.454v91.458c0,6.475,5.249,11.725,11.725,11.725h14.27v31.26 c0,6.475,5.249,11.725,11.725,11.725h40.652c6.476,0,11.725-5.251,11.725-11.725v-31.26h166.102v31.26 c0,6.475,5.251,11.725,11.725,11.725h40.652c6.475,0,11.725-5.251,11.725-11.725v-31.26h14.27c6.475,0,11.725-5.251,11.725-11.725 v-91.458V140.701c0-6.475-5.251-11.725-11.725-11.725s-11.725,5.251-11.725,11.725v213.405h-34.985H267.725V23.451h109.046 c15.95,0,28.927,12.975,28.927,28.926v13.672C405.698,72.524,410.948,77.774,417.423,77.774z M106.302,52.377 c0-15.951,12.977-28.926,28.927-28.926h109.046v330.655H106.302V52.377z M149.498,488.549h-17.201v-19.534h17.201V488.549z M379.703,488.549h-17.201v-19.534h17.201V488.549z M370.713,377.557h34.985v68.007h-14.27h-40.652H161.224h-40.652h-14.27 v-68.007H370.713z"/>
    <path d="M283.754,399.835h-55.508c-6.476,0-11.725,5.251-11.725,11.725c0,6.475,5.249,11.725,11.725,11.725h55.508 c6.475,0,11.725-5.251,11.725-11.725C295.479,405.086,290.229,399.835,283.754,399.835z"/>
    <path d="M211.444,177.053h-14.07c-6.476,0-11.725,5.251-11.725,11.725c0,6.475,5.249,11.725,11.725,11.725h14.07 c6.476,0,11.725-5.251,11.725-11.725C223.169,182.304,217.919,177.053,211.444,177.053z"/>
    <path d="M315.213,177.053h-14.07c-6.475,0-11.725,5.251-11.725,11.725c0,6.475,5.251,11.725,11.725,11.725h14.07 c6.475,0,11.725-5.251,11.725-11.725C326.938,182.304,321.688,177.053,315.213,177.053z"/>
  </g>`,
};

// Фірмові кольори потоку (завжди ці, незалежно від теми) — лінія фарбується кольором
// ДЖЕРЕЛА, з якого тече струм (мережа тягне й «своє» ребро до дому, і заряд батареї).
const FLOW_COLOR = { grid: "#61AAE9", bat: "#E5B138", home: "#7ECD5F" };

// 999 Вт і менше — у ватах, від 1000 — у кВт з одним знаком після коми.
function fmtW(w) {
  if (w == null) return "—";
  return Math.abs(w) >= 1000 ? nf(w / 1000, 1) + " кВт" : nf(w) + " Вт";
}

// "525 Вт" / "69%" → число звичайним розміром + одиниця меншим (.flow__unit, ~2/3)
function valueMarkup(text) {
  const m = /^(.*?)(\s?(?:Вт|кВт|%))$/.exec(text);
  if (!m) return esc(text);
  return `${esc(m[1])}<tspan class="flow__unit">${esc(m[2])}</tspan>`;
}

// Місто/Батарея: іконка, підпис(и) над/під лінією, одразу праворуч від іконки
// (вирівнювання вліво). Назва вузла — вище іконки (Місто) або нижче (Батарея),
// завжди білим. Числа — впритул до іконки.
function flowNodeLeft({ cx, cy, size }, { iconColor, textColor, icon, above, below, label, labelPos = "above" }) {
  const ix = cx - size / 2, iy = cy - size / 2;
  const tx = cx + size / 2 + 5;
  const t = (text, y) => text == null ? "" : `<text x="${tx}" y="${y}" class="flow__value" style="text-anchor:start; fill:${textColor}">${valueMarkup(text)}</text>`;
  const labelY = labelPos === "above" ? cy - size / 2 - 8 : cy + size / 2 + 17;
  const lbl = `<text x="${cx}" y="${labelY}" class="flow__caption">${esc(label)}</text>`;
  return `<g class="flow__icon" style="color:${iconColor}" transform="translate(${ix},${iy}) scale(${size / 24})">${FLOW_ICONS[icon]}</g>${t(above, cy - 12)}${t(below, cy + 27)}${lbl}`;
}

// Дім: іконка, значення під нею по центру, підпис ще нижче — без фону/рамки.
// Дім: назва вище іконки (білим), іконка, значення під нею по центру.
function flowNodeBelow({ cx, cy, size }, { iconColor, textColor, icon, value, label }) {
  const ix = cx - size / 2, iy = cy - size / 2;
  return `
    <text x="${cx}" y="${cy - size / 2 - 8}" class="flow__caption">${esc(label)}</text>
    <g class="flow__icon" style="color:${iconColor}" transform="translate(${ix},${iy}) scale(${size / 24})">${FLOW_ICONS[icon]}</g>
    <text x="${cx}" y="${cy + size / 2 + 26}" class="flow__value" style="fill:${textColor}">${valueMarkup(value)}</text>`;
}

function renderFlow({ live, gridOn, bat }) {
  const el = $("#flow");
  if (gridOn == null) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;

  const apt = num(live?.apt?.p);
  const soc = bat?.soc;
  const charging = bat?.state === "charge" ? bat.p : null;
  const discharging = bat?.state === "discharge" ? -bat.p : null;
  const batActive = (charging != null && charging > 5) || (discharging != null && discharging > 5);

  const homeOn = apt != null && apt > 5;
  const gridHomeOn = gridOn && homeOn;
  const batHomeOn = !gridOn && homeOn;
  const gridBatOn = charging != null && charging > 5;

  // неактивний вузол — сіра іконка (текст лишається білим/сірим окремо нижче)
  const gridIconColor = gridOn ? FLOW_COLOR.grid : "var(--text-muted)";
  const batIconColor = batActive ? FLOW_COLOR.bat : "var(--text-muted)";
  const homeIconColor = homeOn ? FLOW_COLOR.home : "var(--text-muted)";
  const muted = "var(--text-muted)", white = "var(--text-primary)";

  const ariaBits = [
    gridHomeOn && `мережа живить дім, ${nf(apt)} Вт`,
    batHomeOn && `батарея живить дім, ${nf(apt)} Вт`,
    gridBatOn && `мережа заряджає батарею, ${nf(charging)} Вт`,
  ].filter(Boolean).join("; ") || "немає активних потоків";

  const batBelow = charging > 5 ? fmtW(charging) : discharging > 5 ? fmtW(discharging) : null;

  el.innerHTML = `
    <svg class="flow" viewBox="0 0 300 204" role="img" aria-label="Схема потоку енергії: ${esc(ariaBits)}">
      ${flowEdge(FLOW.gridHome, { active: gridHomeOn, color: FLOW_COLOR.grid, watts: apt })}
      ${flowEdge(FLOW.batHome, { active: batHomeOn, color: FLOW_COLOR.bat, watts: apt })}
      ${flowEdge(FLOW.gridBat, { active: gridBatOn, color: FLOW_COLOR.grid, watts: charging })}
      ${flowNodeLeft(FLOW.grid, { iconColor: gridIconColor, textColor: gridOn ? white : muted, icon: "grid", label: "Місто", labelPos: "above", above: gridOn ? fmtW(apt || 0) : "0 Вт" })}
      ${flowNodeLeft(FLOW.bat, { iconColor: batIconColor, textColor: white, icon: "battery", label: "Батарея", labelPos: "below", above: soc == null ? "—" : nf(soc) + "%", below: batBelow })}
      ${flowNodeBelow(FLOW.home, { iconColor: homeIconColor, textColor: homeOn ? white : muted, icon: "home", label: "Дім", value: apt == null ? "—" : fmtW(apt) })}
    </svg>`;
}

// ---------- розумний будинок: опалення, датчики, вимикачі ----------
function renderClimate(climate) {
  const el = $("#climate");
  if (!el) return;
  el.innerHTML = `
    <h2 class="card__title">Температура в квартирі</h2>
    <div class="climatelist">
      ${climateDevices.map((c) => {
        const d = climate?.[c.id];
        const isOff = c.toggle && d?.mode === "off";
        const powerIcon = `<button class="climate__power ${isOff ? "" : "is-on"}" data-climate-toggle="${c.id}" data-on="${!isOff}" aria-pressed="${!isOff}" aria-label="${isOff ? "Увімкнути" : "Вимкнути"} ${esc(c.label.toLowerCase())}">
            <svg viewBox="-2 0 19 19"><path d="M7.498 17.1a7.128 7.128 0 0 1-.98-.068 7.455 7.455 0 0 1-1.795-.483 7.26 7.26 0 0 1-3.028-2.332A7.188 7.188 0 0 1 .73 12.52a7.304 7.304 0 0 1 .972-7.128 7.221 7.221 0 0 1 1.387-1.385 1.03 1.03 0 0 1 1.247 1.638 5.176 5.176 0 0 0-.993.989 5.313 5.313 0 0 0-.678 1.181 5.23 5.23 0 0 0-.348 1.292 5.22 5.22 0 0 0 .326 2.653 5.139 5.139 0 0 0 .69 1.212 5.205 5.205 0 0 0 .992.996 5.257 5.257 0 0 0 1.178.677 5.37 5.37 0 0 0 1.297.35 5.075 5.075 0 0 0 1.332.008 5.406 5.406 0 0 0 1.32-.343 5.289 5.289 0 0 0 2.211-1.682 5.18 5.18 0 0 0 1.02-2.465 5.2 5.2 0 0 0 .01-1.336 5.315 5.315 0 0 0-.343-1.318 5.195 5.195 0 0 0-.695-1.222 5.134 5.134 0 0 0-.987-.989 1.03 1.03 0 1 1 1.24-1.643 7.186 7.186 0 0 1 1.384 1.386 7.259 7.259 0 0 1 .97 1.706 7.413 7.413 0 0 1 .473 1.827 7.296 7.296 0 0 1-4.522 7.65 7.476 7.476 0 0 1-1.825.471 7.203 7.203 0 0 1-.89.056zM7.5 9.613a1.03 1.03 0 0 1-1.03-1.029V2.522a1.03 1.03 0 0 1 2.06 0v6.062a1.03 1.03 0 0 1-1.03 1.03z"/></svg>
          </button>`;
        if (isOff) {
          return `<div class="climate__row climate__row--off">
            ${powerIcon}
            <span class="climate__off-label">Увімкнути ${esc(c.label.toLowerCase())}</span>
          </div>`;
        }
        return `<div class="climate__row">
          ${c.toggle ? powerIcon : `<span class="climate__power-spacer" aria-hidden="true"></span>`}
          <span class="climate__big">${d?.current == null ? "—" : nf(d.current, 1)}<span class="unit">°</span></span>
          <span class="climate__label">${esc(c.label)}</span>
          <div class="climate__target">
            <button class="climate__btn" data-climate-dec="${c.id}" aria-label="Знизити ціль">−</button>
            <span class="climate__val">${d?.target == null ? "—" : nf(d.target, 1) + "°"}</span>
            <button class="climate__btn" data-climate-inc="${c.id}" aria-label="Підвищити ціль">+</button>
          </div>
        </div>`;
      }).join("")}
    </div>`;
}

function renderSensors(sensors) {
  const el = $("#sensors");
  if (!el) return;
  const row = (groupLabel, list, data) => list.map((s) => {
    const alarm = !!data?.[s.id]?.alarm;
    return `<div class="sensor__row ${alarm ? "is-alarm" : ""}">
      <span class="sensor__dot"></span>
      <span class="sensor__label">${groupLabel} · ${esc(s.label)}</span>
      <span class="sensor__state">${alarm ? "⚠️ Увага" : "норма"}</span>
    </div>`;
  }).join("");
  el.innerHTML = `
    <h2 class="card__title">Датчики</h2>
    <div class="sensorlist">${row("Дим", sensorGroups.smoke, sensors?.smoke)}${row("Протікання", sensorGroups.leak, sensors?.leak)}</div>`;
}

// Великі плитки 2-в-ряд, уся плитка клікабельна (як у Apple HomeKit).
function renderSwitches(switches) {
  const el = $("#switches");
  if (!el) return;
  el.innerHTML = `
    <h2 class="card__title">Світло</h2>
    <div class="hk-grid">
      ${rooms.map((r) => {
        const on = !!switches?.[r.id]?.on;
        return `<button type="button" class="hk-tile ${on ? "is-on" : ""}" data-switch-toggle="${r.id}" data-on="${on}" aria-pressed="${on}">
          <svg class="hk-tile__icon" viewBox="0 0 24 24">${ROOM_ICONS[r.id] || FLOW_ICONS.home}</svg>
          <span class="hk-tile__label">${esc(r.label)}</span>
          <span class="hk-tile__state">${on ? "Увімкнено" : "Вимкнено"}</span>
        </button>`;
      }).join("")}
    </div>`;
}

function socLevel(soc) {
  if (soc == null) return "na";
  if (soc < 15) return "crit";
  if (soc < 30) return "warn";
  return "ok";
}

function renderBattery(bat, live) {
  const el = $("#battery");
  const soc = bat?.soc;
  const r = 52, c = 2 * Math.PI * r;
  const frac = soc == null ? 0 : Math.max(0, Math.min(1, soc / 100));
  const lvl = socLevel(soc);
  const stateTxt = !bat ? "—" : bat.state === "charge" ? "Заряджається" : bat.state === "discharge" ? "Розряджається" : "Очікування";
  const pTxt = bat?.p == null ? "" : `${bat.p > 0 ? "+" : bat.p < 0 ? "−" : ""}${nf(Math.abs(bat.p))} Вт`;
  const etaTxt = !bat?.eta ? "" : bat.state === "charge" ? `до 100% ~${fmtDur(bat.eta)}` : `до ${settings.reserveSoc}% ~${fmtDur(bat.eta)}`;
  el.innerHTML = `
    <h2 class="card__title">Батарея</h2>
    <div class="bat">
      <svg class="ring ring--${lvl}" viewBox="0 0 120 120" role="img" aria-label="Заряд ${soc ?? "невідомо"}%">
        <circle class="ring__track" cx="60" cy="60" r="${r}"/>
        <circle class="ring__fill" cx="60" cy="60" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - frac)}" transform="rotate(-90 60 60)"/>
        <text x="60" y="58" class="ring__val">${soc == null ? "—" : nf(soc)}<tspan class="ring__unit">%</tspan></text>
        <text x="60" y="80" class="ring__sub">${bat ? nf(bat.kwh, 1) + " кВт·год" : ""}</text>
      </svg>
      <div class="bat__info">
        <div class="bat__state bat__state--${bat?.state || "idle"}">${bat?.state === "charge" ? "↑" : bat?.state === "discharge" ? "↓" : "·"} ${stateTxt}</div>
        <div class="bat__power">${pTxt || "&nbsp;"}</div>
        <div class="muted small">${etaTxt}</div>
        ${lvl === "crit" || lvl === "warn" ? `<div class="tag tag--${lvl}">${lvl === "crit" ? "критично низький" : "низький заряд"}</div>` : ""}
      </div>
    </div>
    <dl class="kv">
      <div><dt>Напруга</dt><dd>${nf(num(live?.bat?.v), 1)} В</dd></div>
      <div><dt>Струм</dt><dd>${nf(num(live?.bat?.a), 1)} А</dd></div>
      <div><dt>Темп.</dt><dd>${nf(num(live?.bat?.t), 0)}°</dd></div>
    </dl>`;
}

const MODES = { line: "Мережа", grid: "Мережа", utility: "Мережа", battery: "Батарея", standby: "Очікування", fault: "Аварія", bypass: "Байпас", "power on": "Старт" };
function modeLabel(m) {
  if (!m || m === "unknown" || m === "unavailable") return "—";
  const k = String(m).toLowerCase();
  for (const [key, v] of Object.entries(MODES)) if (k.includes(key)) return v;
  return m;
}

function renderInverter(live, gridOn) {
  const el = $("#inverter");
  const p = num(live?.out?.p);
  const pct = num(live?.out?.pct) ?? (p != null ? (p / settings.inverterW) * 100 : null);
  const lvl = pct == null ? "ok" : pct > 90 ? "crit" : pct > 70 ? "warn" : "ok";
  const fault = live?.inv?.fault;
  const hasFault = fault && !["0", "none", "unknown", "unavailable", "No fault", "Normal", ""].includes(String(fault));
  el.innerHTML = `
    <h2 class="card__title">Інвертор <span class="muted">· ${esc(modeLabel(live?.inv?.mode))}</span></h2>
    <div class="load">
      <div class="load__val">${nf(p)}<span class="unit"> Вт</span></div>
      <div class="muted small">навантаження ${pct == null ? "" : "· " + nf(pct) + "% від " + nf(settings.inverterW / 1000, 1) + " кВт"}</div>
      <div class="meter meter--${lvl}" role="meter" aria-valuenow="${pct ?? 0}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.min(100, pct ?? 0)}%"></span></div>
      ${gridOn ? `<div class="muted small">Квартира живиться напряму з мережі.</div>` : ""}
    </div>
    <dl class="kv kv--2">
      <div><dt>Вихід</dt><dd>${nf(num(live?.out?.v))} В · ${nf(num(live?.out?.hz), 1)} Гц</dd></div>
      <div><dt>Повна потужн.</dt><dd>${nf(num(live?.out?.va))} ВА</dd></div>
      <div><dt>Мережа</dt><dd>${nf(num(live?.grid?.v))} В · ${nf(num(live?.grid?.hz), 1)} Гц</dd></div>
      <div><dt>Темп. інвертора</dt><dd>${nf(num(live?.inv?.t))}°</dd></div>
    </dl>
    ${hasFault ? `<div class="tag tag--crit">Помилка: ${esc(fault)}</div>` : ""}`;
}

// ---------- timeline: plan vs fact for a day ----------
function renderTimeline(outages, t) {
  const el = $("#timeline");
  const d0 = addDays(startOfDay(t), ui.day);
  const d1 = addDays(d0, 1);
  const plan = plannedForDay(d0, state.schedule, t);
  const fact = clip(outages, d0, d1);
  const pos = (x) => ((x - d0) / DAY) * 100;
  const bar = (it, cls, label) =>
    `<button class="tl__bar ${cls}" style="left:${pos(it.s)}%;width:${Math.max(0.6, pos(it.e) - pos(it.s))}%"
      data-detail="${esc(label)}" aria-label="${esc(label)}"></button>`;
  const planBars = plan.list.map((p) =>
    bar(p, p.possible ? "tl__bar--possible" : "tl__bar--plan", `${p.possible ? "Можливе" : "План"}: ${hhmm(p.s)}–${p.e >= d1 ? "24:00" : hhmm(p.e)} · ${fmtDur(p.e - p.s)}`)).join("");
  const factBars = fact.map((o) => bar(o, "tl__bar--fact", `Факт: ${hhmm(o.s)}–${o.ongoing && o.e >= t ? "зараз" : o.e >= d1 ? "24:00" : hhmm(o.e)} · ${fmtDur(o.e - o.s)}`)).join("");
  const nowMark = ui.day === 0 ? `<div class="tl__now" style="left:${pos(t)}%"><span>${hhmm(t)}</span></div>` : "";
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) =>
    `<span style="left:${(h / 24) * 100}%">${h % 6 === 0 ? pad2(h) : ""}</span>`).join("");
  const grid = [3, 6, 9, 12, 15, 18, 21].map((h) => `<i style="left:${(h / 24) * 100}%"></i>`).join("");

  const planTotal = plan.list.reduce((a, x) => a + x.e - x.s, 0);
  const factTotal = fact.reduce((a, x) => a + x.e - x.s, 0);
  const tabs = [[-1, "Вчора"], [0, "Сьогодні"], [1, "Завтра"]]
    .map(([v, l]) => `<button role="tab" aria-selected="${ui.day === v}" data-day="${v}">${l}</button>`).join("");

  // rows of the day list
  const rows = [];
  for (const p of plan.list) {
    const matches = fact.filter((o) => Math.min(o.e, p.e) - Math.max(o.s, p.s) > 0);
    const status = p.e <= t ? (matches.length ? "відбулось" : "не вимикали") : p.s <= t ? "зараз" : "очікується";
    let factTxt = "";
    if (matches.length) {
      const m = matches[0];
      const ds = Math.round((m.s - p.s) / MIN);
      factTxt = `факт ${hhmm(m.s)}–${m.ongoing ? "…" : hhmm(m.e)} <span class="muted">(${ds >= 0 ? "+" : "−"}${Math.abs(ds)} хв)</span>`;
    }
    rows.push(`<li><span class="sw sw--${p.possible ? "possible" : "plan"}"></span>
      <b>${hhmm(p.s)}–${p.e >= d1 ? "24:00" : hhmm(p.e)}</b>
      <span class="muted">${p.possible ? "можливе" : "план"} · ${status}</span>
      ${factTxt ? `<div class="li__sub">${factTxt}</div>` : ""}</li>`);
  }
  for (const o of fact) {
    if (plan.list.some((p) => Math.min(o.e, p.e) - Math.max(o.s, p.s) > 0)) continue;
    rows.push(`<li><span class="sw sw--fact"></span><b>${hhmm(o.s)}–${o.ongoing ? "зараз" : hhmm(o.e)}</b>
      <span class="tag tag--unplanned">позапланове</span> <span class="muted">${fmtDur(o.e - o.s)}</span></li>`);
  }

  el.innerHTML = `
    <div class="card__head">
      <h2 class="card__title">Відключення</h2>
      <div class="seg" role="tablist">${tabs}</div>
    </div>
    <div class="tl">
      <div class="tl__row"><div class="tl__label">План</div><div class="tl__track">${grid}${planBars}${nowMark}</div></div>
      <div class="tl__row"><div class="tl__label">Факт</div><div class="tl__track">${grid}${ui.day <= 0 ? factBars : ""}${nowMark}</div></div>
      <div class="tl__axis"><div class="tl__label"></div><div class="tl__ticks">${ticks}</div></div>
    </div>
    <div class="tl__detail muted small" id="tl-detail">${plan.hasData ? "Торкнись смуги, щоб побачити час" : "Немає даних графіка за цей день"}</div>
    <div class="legend">
      <span><i class="sw sw--plan"></i>План ${planTotal ? fmtHours(planTotal) : ""}</span>
      <span><i class="sw sw--possible"></i>Можливе</span>
      ${ui.day <= 0 ? `<span><i class="sw sw--fact"></i>Факт ${factTotal ? fmtHours(factTotal) : ""}</span>` : ""}
    </div>
    ${rows.length ? `<ul class="daylist">${rows.join("")}</ul>` : ""}
    ${state.schedule?.latest?.updated ? `<div class="muted small">Графік оновлено ${relDay(state.schedule.latest.updated, t)} о ${hhmm(state.schedule.latest.updated)} · ${esc(state.schedule.latest.source || "")}</div>` : ""}`;
}
const pad2 = (h) => String(h).padStart(2, "0");

// ---------- charts ----------
function renderCharts(outages, t) {
  const pts = flattenHistory(state.history);
  const from = t - settings.historyHours * HOUR;
  const data = pts.filter((p) => p.t >= from);
  const off = clip(outages, from, t);
  $("#charts").innerHTML = `
    <h2 class="card__title">Останні ${settings.historyHours} год</h2>
    ${chartBlock("soc", "Заряд батареї, %", data, "soc", { min: 0, max: 100, color: "var(--series-1)", fmt: (v) => nf(v) + "%", from, to: t, off, ticks: [0, 50, 100] })}
    ${chartBlock("load", "Навантаження інвертора, Вт", data, "load", { min: 0, color: "var(--series-2)", fmt: (v) => nf(v) + " Вт", from, to: t, off })}
    <div class="legend"><span><i class="sw sw--offband"></i>Без світла</span></div>`;
  bindChart("soc");
  bindChart("load");
}

function niceMax(v) {
  if (!v || v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function chartBlock(id, title, data, key, o) {
  const W = Math.max(280, Math.round(($("#charts")?.clientWidth || 340) - 32));
  const H = 120, padL = 36, padR = 8, padT = 8, padB = 20;
  const vals = data.map((d) => d[key]).filter((v) => v != null);
  const max = o.max ?? niceMax(Math.max(...vals, 0) * 1.1);
  const min = o.min ?? 0;
  const x = (tt) => padL + ((tt - o.from) / (o.to - o.from)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const ticks = o.ticks || [0, max / 2, max];
  let path = "", area = "", started = false, prevT = null;
  const gap = 15 * MIN;
  for (const d of data) {
    if (d[key] == null) { started = false; continue; }
    const cmd = !started || (prevT && d.t - prevT > gap) ? "M" : "L";
    path += `${cmd}${x(d.t).toFixed(1)},${y(d[key]).toFixed(1)}`;
    started = true; prevT = d.t;
  }
  const valid = data.filter((d) => d[key] != null);
  if (valid.length > 1) {
    area = `M${x(valid[0].t).toFixed(1)},${y(min)}` + valid.map((d) => `L${x(d.t).toFixed(1)},${y(d[key]).toFixed(1)}`).join("") + `L${x(valid.at(-1).t).toFixed(1)},${y(min)}Z`;
  }
  const bands = o.off.map((b) => `<rect class="offband" x="${x(b.s)}" y="${padT}" width="${Math.max(1, x(b.e) - x(b.s))}" height="${H - padT - padB}"/>`).join("");
  const xt = [];
  for (let h = Math.ceil(o.from / (6 * HOUR)) * 6 * HOUR; h <= o.to; h += 6 * HOUR) xt.push(h);
  const lastV = valid.at(-1);
  chartData.set(id, { data: valid, key, x, y, W, H, padL, padR, fmt: o.fmt, from: o.from, to: o.to });
  return `
  <figure class="chart" id="chart-${id}">
    <figcaption>${title}${lastV ? ` <b>${o.fmt(lastV[key])}</b>` : ""}</figcaption>
    <div class="chart__wrap">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="--c:${o.color}" role="img" aria-label="${esc(title)}">
        ${bands}
        ${ticks.map((v) => `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end">${v >= 1000 ? nf(v / 1000, v % 1000 ? 1 : 0) + "k" : nf(v)}</text>`).join("")}
        ${xt.map((h) => `<text class="axis" x="${x(h)}" y="${H - 5}" text-anchor="middle">${hhmm(h)}</text>`).join("")}
        <path class="area" d="${area}"/>
        <path class="line" d="${path}"/>
        ${lastV ? `<circle class="enddot" cx="${x(lastV.t)}" cy="${y(lastV[key])}" r="4"/>` : ""}
        <g class="cross" hidden><line class="cross__line" y1="${padT}" y2="${H - padB}"/><circle class="cross__dot" r="4"/></g>
        <rect class="hit" x="${padL}" y="0" width="${W - padL - padR}" height="${H}"/>
      </svg>
      <div class="tip" hidden></div>
    </div>
    ${valid.length ? "" : `<div class="muted small">Ще немає історії — HA пише точку раз на 5 хв</div>`}
  </figure>`;
}

function bindChart(id) {
  const fig = $(`#chart-${id}`);
  const cd = chartData.get(id);
  if (!fig || !cd || !cd.data.length) return;
  const svg = fig.querySelector("svg"), cross = fig.querySelector(".cross"), tip = fig.querySelector(".tip");
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * cd.W;
    const tt = cd.from + ((px - cd.padL) / (cd.W - cd.padL - cd.padR)) * (cd.to - cd.from);
    let best = cd.data[0];
    for (const d of cd.data) if (Math.abs(d.t - tt) < Math.abs(best.t - tt)) best = d;
    const cx = cd.x(best.t), cy = cd.y(best[cd.key]);
    cross.hidden = false;
    cross.querySelector("line").setAttribute("x1", cx);
    cross.querySelector("line").setAttribute("x2", cx);
    const dot = cross.querySelector("circle");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
    tip.hidden = false;
    tip.innerHTML = `<b>${cd.fmt(best[cd.key])}</b><span>${hhmm(best.t)}${best.g === 0 ? " · без світла" : ""}</span>`;
    const left = (cx / cd.W) * r.width;
    tip.style.left = `${Math.min(Math.max(left, 50), r.width - 50)}px`;
  };
  const leave = () => { cross.hidden = true; tip.hidden = true; };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", leave);
}

// ---------- stats ----------
function renderStats(s) {
  const acc = s.accuracy == null ? "—" : `${Math.round(s.accuracy * 100)}%`;
  $("#stats").innerHTML = `
    <h2 class="card__title">Статистика</h2>
    <div class="tiles">
      <div class="tile"><div class="tile__label">Без світла сьогодні</div><div class="tile__value">${fmtHours(s.today)}</div></div>
      <div class="tile"><div class="tile__label">За 7 днів</div><div class="tile__value">${fmtHours(s.week)}</div>
        <div class="tile__sub">${s.weekCount} відкл. · сер. ${fmtDur(s.avg, { short: true })}</div></div>
      <div class="tile"><div class="tile__label">Найдовше за тиждень</div><div class="tile__value">${s.longest ? fmtDur(s.longest, { short: true }) : "—"}</div></div>
      <div class="tile"><div class="tile__label">Збіг з графіком</div><div class="tile__value">${acc}</div>
        <div class="tile__sub">${s.unplanned ? `${s.unplanned} позапланових` : "позапланових немає"}</div></div>
    </div>`;
}

// ---------- log ----------
const LOG_PAGE_SIZE = 5;

function pluralOutage(n) {
  const n10 = n % 10, n100 = n % 100;
  if (n100 >= 11 && n100 <= 14) return "відключень";
  if (n10 === 1) return "відключення";
  if (n10 >= 2 && n10 <= 4) return "відключення";
  return "відключень";
}

// Групує відключення за календарним днем — один запис у журналі на день,
// з переліком окремих проміжків усередині.
function groupOutagesByDay(outages) {
  const byDay = new Map();
  for (const o of outages) {
    const k = dayKey(o.s);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(o);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)); // новіші дні зверху
}

function renderLog(outages, planned, t) {
  const days = groupOutagesByDay(outages);
  const totalPages = Math.max(1, Math.ceil(days.length / LOG_PAGE_SIZE));
  ui.logPage = Math.min(Math.max(0, ui.logPage), totalPages - 1);
  const page = days.slice(ui.logPage * LOG_PAGE_SIZE, ui.logPage * LOG_PAGE_SIZE + LOG_PAGE_SIZE);

  const dayRow = ([key, list]) => {
    const sorted = [...list].reverse(); // новіші зверху в межах дня
    const totalMs = sorted.reduce((a, o) => a + (Math.min(o.e, t) - o.s), 0);
    const items = sorted.map((o) => {
      const c = classifyOutage(o, planned);
      const dev = c.planned
        ? [c.startDelta != null ? `почали ${fmtDelta(c.startDelta)}` : "", c.endDelta != null ? `дали ${fmtDelta(c.endDelta)}` : ""].filter(Boolean).join(", ")
        : "";
      return `<div class="log__item">
        <b>${hhmm(o.s)} → ${o.ongoing ? "зараз" : hhmm(o.e)}</b>
        <span class="log__dur">${fmtDur(o.e - o.s)}</span>
        <span class="tag ${c.planned ? "tag--plan" : "tag--unplanned"}">${c.planned ? "за графіком" : "позапланове"}</span>
        ${dev ? `<span class="muted small">${dev}</span>` : ""}
      </div>`;
    }).join("");
    return `<li>
      <div class="log__main"><span class="log__day">${relDay(sorted[0].s, t)}</span>
        <span class="muted small">${list.length} ${pluralOutage(list.length)} · ${fmtDur(totalMs)}</span></div>
      <div class="log__items">${items}</div>
    </li>`;
  };

  const pager = totalPages > 1 ? `
    <div class="log__pager">
      <button class="btn btn--sm" data-log-page="prev" ${ui.logPage === 0 ? "disabled" : ""}>← Новіші</button>
      <span class="muted small">${ui.logPage + 1} / ${totalPages}</span>
      <button class="btn btn--sm" data-log-page="next" ${ui.logPage >= totalPages - 1 ? "disabled" : ""}>Старіші →</button>
    </div>` : "";

  $("#log").innerHTML = `
    <h2 class="card__title">Журнал відключень</h2>
    ${days.length ? `<ul class="log">${page.map(dayRow).join("")}</ul>${pager}` : `<div class="muted">Ще не зафіксовано жодного відключення.</div>`}`;
}
function fmtDelta(ms) {
  const m = Math.round(ms / MIN);
  if (Math.abs(m) < 3) return "вчасно";
  return m > 0 ? `на ${fmtDur(ms)} пізніше` : `на ${fmtDur(-ms)} раніше`;
}

function renderFooter(t) {
  $("#footer-time").textContent = `Оновлено ${hhmm(t)}`;
}

// =============================== events ===============================
document.addEventListener("click", (e) => {
  const panelTab = e.target.closest(".tabbar [role=tab]");
  if (panelTab) { ui.panel = panelTab.dataset.panel; render(); return; }
  const tab = e.target.closest("[data-day]");
  if (tab) { ui.day = +tab.dataset.day; render(); return; }
  const logPage = e.target.closest("[data-log-page]");
  if (logPage) { ui.logPage += logPage.dataset.logPage === "next" ? 1 : -1; render(); return; }
  const climateInc = e.target.closest("[data-climate-inc]");
  if (climateInc) { adjustClimate(climateInc.dataset.climateInc, 0.5); return; }
  const climateDec = e.target.closest("[data-climate-dec]");
  if (climateDec) { adjustClimate(climateDec.dataset.climateDec, -0.5); return; }
  const climateToggle = e.target.closest("[data-climate-toggle]");
  if (climateToggle) { toggleClimate(climateToggle.dataset.climateToggle, climateToggle.dataset.on !== "true"); return; }
  const swTile = e.target.closest("[data-switch-toggle]");
  if (swTile) { sendSwitch(swTile.dataset.switchToggle, swTile.dataset.on !== "true"); return; }
  const bar = e.target.closest(".tl__bar");
  if (bar) { $("#tl-detail").textContent = bar.dataset.detail; return; }
  if (e.target.closest("#btn-google")) api?.signInGoogle().catch((er) => toast(er.message));
  if (e.target.closest("[data-signout]")) { if (DEMO && params.get("demo") !== "login") location.search = ""; else api?.signOut(); }
  if (e.target.closest("#btn-copy-uid")) navigator.clipboard?.writeText($("#uid").textContent).then(() => toast("UID скопійовано"));
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "pin-form") return;
  e.preventDefault();
  submitPin(new FormData(e.target).get("pin"));
});
document.addEventListener("input", (e) => {
  if (e.target.id === "pin-input" && pinMsg) { pinMsg = ""; updatePinUI(); }
});

// ---------- розумний будинок: команди ----------
// У демо немає живого HA — міняємо стан локально й одразу перемальовуємо.
// На бою HA сам підхопить команду з home/commands і повернe підтверджений стан.
function sendSwitch(id, on) {
  if (!state) return;
  if (DEMO) { state.switches = { ...state.switches, [id]: { on, ts: now() } }; render(); return; }
  api?.setSwitch(id, on).catch((e) => toast(e.message || String(e)));
}
function adjustClimate(id, delta) {
  if (!state) return;
  const cur = state.climate?.[id]?.target ?? 22;
  const target = Math.round((cur + delta) * 2) / 2; // крок 0.5°
  if (DEMO) { state.climate = { ...state.climate, [id]: { ...state.climate[id], target, ts: now() } }; render(); return; }
  api?.setClimateTarget(id, target).catch((e) => toast(e.message || String(e)));
}
// Повне ввімк./вимк. (напр. тепла підлога) — окремо від уставки температури.
function toggleClimate(id, on) {
  if (!state) return;
  const target = state.climate?.[id]?.target ?? 22;
  const mode = on ? "heat" : "off";
  if (DEMO) { state.climate = { ...state.climate, [id]: { ...state.climate[id], mode, ts: now() } }; render(); return; }
  api?.setClimateTarget(id, target, mode).catch((e) => toast(e.message || String(e)));
}

let resizeT = 0;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(render, 150); });
setInterval(() => state && render(), 20_000);   // keep "N хв тому" fresh
document.addEventListener("visibilitychange", () => !document.hidden && render());

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4000);
}

boot();
