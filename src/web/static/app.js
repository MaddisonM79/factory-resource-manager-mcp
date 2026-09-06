// FRM dashboard. Plain ES module, no build step. Data comes from /api/* on this host
// (Hanko session cookie), charts are uPlot (global from /vendor/uPlot.iife.min.js).

import { register } from "/vendor/hanko-elements.js";

// ---------------------------------------------------------------- state

const RANGES = [["1h", 3600], ["6h", 6 * 3600], ["24h", 24 * 3600], ["7d", 7 * 86400], ["30d", 30 * 86400]];
const TABS = [["overview", "Overview"], ["power", "Power"], ["emergency", "Emergency"], ["trains", "Trains"], ["production", "Production"], ["sites", "Sites"], ["gens", "Generators"], ["depot", "Depot"], ["sinks", "Sinks"], ["admin", "Admin"]];
const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
const STATES = ["running", "blocked", "starved", "unpowered", "paused", "unconfigured", "idle"];

const stored = (k, d) => { try { return localStorage.getItem("frm." + k) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem("frm." + k, v); } catch {} };

const state = {
  range: stored("range", "24h"),
  tz: stored("tz", "local"),
  tab: stored("tab", "overview"),
  status: null,
  latest: null,
  hanko: null,
  charts: [],          // live uPlot instances on the current tab, destroyed on re-render
  sel: {},             // per-tab selections (circuit group, item, site, ...)
};

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "hidden") n.hidden = !!v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
};
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------- formatting

const tzName = () => (state.tz === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone);
const fmtTime = (ts, opts = {}) => new Intl.DateTimeFormat(undefined, { timeZone: tzName(), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...opts }).format(new Date(ts * 1000));
const fmtNum = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const fmtMW = (v) => (v == null ? "–" : Math.abs(v) >= 1000 ? fmtNum(v / 1000, 2) + " GW" : fmtNum(v, 1) + " MW");
const fmtPct = (v) => (v == null ? "–" : fmtNum(v, 1) + "%");
const fmtEnergy = (mwh) => (mwh == null ? "–" : mwh >= 1e6 ? fmtNum(mwh / 1e6, 2) + " TWh" : mwh >= 1000 ? fmtNum(mwh / 1000, 2) + " GWh" : fmtNum(mwh, 0) + " MWh");
function fmtAge(s) {
  if (s == null) return "never";
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const fmtDur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h}:${String(m).padStart(2, "0")}`; };

// ---------------------------------------------------------------- api

class LoginRequired extends Error {}

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) throw new LoginRequired();
  const body = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw new Error(body.error ?? `${r.status}`);
  return body;
}

const window_ = () => { const to = Math.floor(Date.now() / 1000); const sec = RANGES.find((r) => r[0] === state.range)?.[1] ?? 86400; return { from: to - sec, to }; };
const seriesUrl = (path, extra = {}) => {
  const { from, to } = window_();
  const q = new URLSearchParams({ from, to, ...extra });
  return `${path}?${q}`;
};

// ---------------------------------------------------------------- series shaping

/** /api/series/* returns one Series or an array of them (one per epoch). Always an array, oldest first. */
const asSeriesList = (resp) => (Array.isArray(resp) ? resp : resp?.points ? [resp] : []).filter((s) => s.points?.length);

/**
 * Pivot Series[] into uPlot columns: xs plus one aligned column per (key, col).
 * Gaps and epoch boundaries become null rows so lines break there.
 */
function pivot(list, keyOf, cols) {
  const xs = new Set();
  const gaps = [];
  const epochs = [];
  for (const s of list) {
    for (const p of s.points) xs.add(Number(p.ts));
    for (const g of s.gaps ?? []) { gaps.push([Number(g.from), Number(g.to)]); xs.add(Number(g.from)); xs.add(Number(g.to)); }
  }
  for (let i = 1; i < list.length; i++) {
    const first = Math.min(...list[i].points.map((p) => Number(p.ts)));
    epochs.push({ ts: first, session: list[i].session, epoch: list[i].epoch });
    xs.add(first - 1);
  }
  const x = [...xs].sort((a, b) => a - b);
  const idx = new Map(x.map((v, i) => [v, i]));
  const keys = new Map(); // key -> { [col]: number[] }
  for (const s of list) for (const p of s.points) {
    const k = keyOf(p);
    let row = keys.get(k);
    if (!row) { row = {}; for (const c of cols) row[c] = new Array(x.length).fill(null); keys.set(k, row); }
    const i = idx.get(Number(p.ts));
    for (const c of cols) { const v = p[c]; row[c][i] = v == null ? null : Number(v); }
  }
  // Points inside a gap are impossible, but a sample at exactly the gap edge exists; null the interior.
  for (const [a, b] of gaps) for (let i = 0; i < x.length; i++) if (x[i] >= a && x[i] <= b) for (const row of keys.values()) for (const c of cols) row[c][i] = null;
  return { x, keys, gaps, epochs, res: list[0]?.res ?? "raw", thinned: list.some((s) => s.thinned_from) };
}

// ---------------------------------------------------------------- charts

/** Shaded gap bands + dashed epoch lines with the session name. */
function annotationsPlugin(get) {
  return {
    hooks: {
      draw: (u) => {
        const { ctx, bbox } = u;
        const { gaps, epochs } = get();
        ctx.save();
        ctx.fillStyle = cssVar("--gap");
        for (const [a, b] of gaps) {
          const x0 = Math.max(u.valToPos(a, "x", true), bbox.left);
          const x1 = Math.min(u.valToPos(b, "x", true), bbox.left + bbox.width);
          if (x1 > bbox.left && x0 < bbox.left + bbox.width) ctx.fillRect(x0, bbox.top, Math.max(2, x1 - x0), bbox.height);
        }
        ctx.strokeStyle = cssVar("--muted");
        ctx.fillStyle = cssVar("--muted");
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.font = "11px system-ui, sans-serif";
        for (const e of epochs) {
          const px = u.valToPos(e.ts, "x", true);
          if (px < bbox.left || px > bbox.left + bbox.width) continue;
          ctx.beginPath(); ctx.moveTo(px, bbox.top); ctx.lineTo(px, bbox.top + bbox.height); ctx.stroke();
          ctx.fillText(`epoch ${e.epoch}${e.session ? " · " + e.session : ""}`, px + 4, bbox.top + 12);
        }
        ctx.restore();
      },
    },
  };
}

/**
 * One line chart. series: [{ label, data, color?, dash? }], unit: axis suffix.
 * Colors are palette slots in fixed order; more than 8 series is a design smell, so we stop there.
 */
function lineChart(host, { x, series, unit = "", gaps = [], epochs = [], min = null, max = null, height = 240, fmt = (v) => fmtNum(v, 1) }) {
  host.replaceChildren();
  if (!x.length || !series.length) { host.append(el("div", { class: "chart-empty", text: "No samples in this range yet." })); return null; }
  const shown = series.slice(0, 8);
  const tz = tzName();
  const opts = {
    width: host.clientWidth || 600,
    height,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), tz),
    cursor: { x: true, y: false, drag: { x: true, y: false } },
    legend: { live: true },
    plugins: [annotationsPlugin(() => ({ gaps, epochs }))],
    scales: { x: { time: true }, y: { range: (u, lo, hi) => [min ?? Math.min(0, lo), max ?? (hi === lo ? hi + 1 : hi * 1.05)] } },
    axes: [
      { stroke: cssVar("--muted"), grid: { stroke: cssVar("--grid"), width: 1 }, ticks: { stroke: cssVar("--axis"), width: 1 } },
      { stroke: cssVar("--muted"), grid: { stroke: cssVar("--grid"), width: 1 }, ticks: { show: false }, values: (u, vals) => vals.map((v) => fmt(v) + unit),
        // Width from the widest label, so "40,000 MW" is never clipped.
        size: (u, values) => 14 + 7 * Math.max(3, ...(values ?? []).map((v) => String(v).length)) },
    ],
    series: [
      { value: (u, v) => (v == null ? "" : fmtTime(v, { second: "2-digit" })) },
      ...shown.map((s, i) => ({
        label: s.label, stroke: s.color ?? cssVar(SLOTS[i]), width: 2, dash: s.dash, spanGaps: false,
        points: { show: false },
        value: (u, v) => (v == null ? "–" : fmt(v) + unit),
      })),
    ],
  };
  const u = new uPlot(opts, [x, ...shown.map((s) => s.data)], host);
  const ro = new ResizeObserver(() => u.setSize({ width: host.clientWidth, height }));
  ro.observe(host);
  state.charts.push({ u, ro });
  return u;
}

function chartCard(title, hint) {
  const host = el("div", { class: "chart" });
  const card = el("div", { class: "card" }, el("h2", {}, title, hint ? el("span", { class: "hint", text: hint }) : null), host);
  return { card, host };
}
const resNote = (pv) => (pv.res === "hourly" ? "hourly averages" : "5-minute samples") + (pv.thinned ? ", thinned" : "") + (pv.gaps.length ? `, ${pv.gaps.length} outage${pv.gaps.length > 1 ? "s" : ""} shaded` : "");

function destroyCharts() { for (const c of state.charts) { c.ro.disconnect(); c.u.destroy(); } state.charts = []; }

// ---------------------------------------------------------------- tables

/** Sortable table. cols: [{ key, label, num?, render?(row) -> node|string, sort?(row) -> comparable }]. */
function table(rows, cols, { onRow, selected, initialSort, expand } = {}) {
  let sortKey = initialSort?.key ?? cols[0].key, dir = initialSort?.dir ?? 1;
  const wrap = el("div", { class: "tablewrap" });
  const render = () => {
    const c = cols.find((x) => x.key === sortKey);
    const val = c?.sort ?? ((r) => r[sortKey]);
    const sorted = [...rows].sort((a, b) => { const x = val(a), y = val(b); if (x == null) return 1; if (y == null) return -1; return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * dir; });
    const t = el("table", {},
      el("thead", {}, el("tr", {}, cols.map((col) => el("th", { class: col.num ? "num" : null, onclick: () => { if (sortKey === col.key) dir = -dir; else { sortKey = col.key; dir = col.num ? -1 : 1; } render(); } }, col.label + (sortKey === col.key ? (dir > 0 ? " ▲" : " ▼") : ""))))),
      el("tbody", {}, sorted.flatMap((r) => {
        const isSel = !!(selected && selected(r));
        const tr = el("tr", { class: isSel ? "sel" : null, onclick: onRow ? () => onRow(r) : null },
          cols.map((col) => { const v = col.render ? col.render(r) : r[col.key]; return el("td", { class: [col.num ? "num" : "", col.key === "name" || col.key === "item" ? "name" : "", col.wrap ? "wrap" : ""].join(" ").trim() || null, title: typeof v === "string" && v.length > 24 && !col.wrap ? v : null }, v ?? "–"); }));
        const drawer = isSel && expand ? expand(r) : null;
        return drawer ? [tr, el("tr", { class: "drawer" }, el("td", { colspan: String(cols.length) }, drawer))] : [tr];
      })),
    );
    wrap.replaceChildren(t);
  };
  render();
  return wrap;
}

const signed = (v, d = 1) => el("span", { class: v < 0 ? "neg" : v > 0 ? "pos" : null, text: (v > 0 ? "+" : "") + fmtNum(v, d) });

// ---------------------------------------------------------------- header / status

function renderStatus() {
  const s = state.status;
  const dot = $("#status-dot"), word = $("#status-word"), sub = $("#status-sub"), name = $("#session-name");
  dot.className = "dot";
  if (!s) { word.textContent = "Checking"; sub.textContent = "…"; return; }
  const samp = s.sampler ?? {};
  const age = samp.staleness_seconds;
  if (!s.reachable) {
    dot.classList.add("down"); word.textContent = "Unreachable"; name.textContent = "";
    sub.textContent = `${s.error ?? "FRM did not answer"} · last sample ${fmtAge(age)}${samp.gap ? " (gap)" : ""}`;
    return;
  }
  const sess = s.session ?? {};
  dot.classList.add(sess.paused ? "paused" : "running");
  word.textContent = sess.paused ? "Paused" : "Running";
  name.textContent = sess.name ?? "";
  const online = (s.players ?? []).filter((p) => p.online).map((p) => p.name);
  sub.textContent = [
    online.length ? `${online.length} online: ${online.join(", ")}` : "nobody online",
    sess.play_text ? `play ${sess.play_text}` : null,
    sess.days != null ? `day ${sess.days} ${sess.is_day ? "☀" : "☾"} ${String(sess.hours ?? 0).padStart(2, "0")}:${String(sess.minutes ?? 0).padStart(2, "0")}` : null,
    s.uobjects ? `objects ${fmtNum(s.uobjects.count)} (${fmtPct(s.uobjects.used_pct)} of pool)` : null,
    `sampler ${fmtAge(age)}${samp.gap ? " (gap)" : ""}`,
  ].filter(Boolean).join(" · ");
}

function renderControls() {
  const range = $("#range");
  range.replaceChildren(...RANGES.map(([k]) => el("button", { type: "button", "aria-pressed": String(state.range === k), onclick: () => { state.range = k; store("range", k); renderTab(); } }, k)));
  for (const b of $("#tz").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.tz === state.tz));
  $("#tabs").replaceChildren(...TABS.map(([k, label]) => el("button", { type: "button", role: "tab", "aria-selected": String(state.tab === k), onclick: () => { state.tab = k; store("tab", k); renderControls(); renderTab(); } }, label)));
}

// ---------------------------------------------------------------- tabs

const latestPower = () => state.latest?.power ?? [];
const groupLabel = (g) => `Circuit group ${g}`;
const busiestGroup = () => latestPower().reduce((best, r) => (best == null || Number(r.consumed_mw) > Number(best.consumed_mw) ? r : best), null)?.circuit_group;

async function tabOverview(main) {
  const L = state.latest ?? {}, S = state.status ?? {};
  const power = L.power ?? [], sites = L.sites ?? [], prod = L.prod ?? [], sinks = L.sinks ?? [];
  const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const cap = sum(power, "capacity_mw"), cons = sum(power, "consumed_mw"), maxc = sum(power, "max_consumed_mw");
  const batt = power.filter((r) => r.battery_pct != null).map((r) => Number(r.battery_pct));
  const machines = sum(sites, "machines"), running = sum(sites, "running");
  const deficits = prod.filter((r) => Number(r.consumed_per_min) > Number(r.produced_per_min) + 1e-6).length;
  const rs = sinks.find((r) => r.sink === "resource");
  const tile = (k, v, unit, d, cls) => el("div", { class: "tile" }, el("div", { class: "k", text: k }), el("div", { class: "v" }, v, unit ? el("small", { text: unit }) : null), d ? el("div", { class: "d " + (cls ?? ""), text: d }) : null);
  main.append(el("div", { class: "tiles" },
    tile("Game", S.reachable ? (S.session?.paused ? "Paused" : "Running") : "Down", "", S.reachable ? `${(S.players ?? []).filter((p) => p.online).length} online` : S.error?.slice(0, 60), S.reachable ? "ok" : "bad"),
    tile("Objects", S.uobjects ? fmtNum(S.uobjects.count) : "–", "", S.uobjects ? `${fmtPct(S.uobjects.used_pct)} of the engine's ${fmtNum(S.uobjects.capacity)} pool` : "no count from FRM", S.uobjects && S.uobjects.used_pct >= 90 ? "bad" : S.uobjects && S.uobjects.used_pct >= 75 ? "warn" : null),
    tile("Grid draw", fmtMW(cons), "", `of ${fmtMW(cap)} capacity · peak ${fmtMW(maxc)}`, maxc > cap ? "bad" : null),
    tile("Headroom", fmtMW(cap - cons), "", cap ? `${fmtPct(100 * (cap - cons) / cap)} free` : "no capacity", cap - maxc < 0 ? "bad" : null),
    tile("Battery", batt.length ? fmtPct(Math.min(...batt)) : "none", "", batt.length ? `${batt.length} circuit${batt.length > 1 ? "s" : ""} with storage` : ""),
    tile("Machines running", fmtNum(running), `/ ${fmtNum(machines)}`, machines ? `${fmtPct(100 * running / machines)} across ${sites.length} sites` : ""),
    tile("Item deficits", fmtNum(deficits), "", deficits ? "consuming more than producing" : "everything in balance", deficits ? "bad" : "ok"),
    tile("Coupons", rs ? fmtNum(rs.coupons) : "–", "", rs ? `${fmtNum(rs.points_per_min)} pts/min · ${fmtNum(rs.points_to_next)} to next` : "no sink samples"),
    tile("History", L.ts ? fmtTime(L.ts) : "–", "", L.ts ? `epoch ${L.epoch} · sampled ${fmtAge(L.staleness_seconds)}` : "no ticks yet", L.gap ? "bad" : null),
  ));
  const g = busiestGroup();
  const grid = el("div", { class: "grid" });
  main.append(grid);
  if (g != null) {
    const { card, host } = chartCard(`${groupLabel(g)} · MW`, "busiest circuit");
    grid.append(card);
    const pv = pivot(asSeriesList(await api(seriesUrl("/api/series/power", { group: g }))), () => "g", ["capacity_mw", "production_mw", "consumed_mw", "max_consumed_mw"]);
    const row = pv.keys.get("g");
    lineChart(host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: " MW", fmt: (v) => fmtNum(v, 0), series: row ? [
      { label: "Capacity", data: row.capacity_mw, color: cssVar("--s1") },
      { label: "Production", data: row.production_mw, color: cssVar("--s3") },
      { label: "Consumption", data: row.consumed_mw, color: cssVar("--s2") },
      { label: "Peak draw", data: row.max_consumed_mw, color: cssVar("--s4"), dash: [4, 4] },
    ] : [] });
    card.append(el("div", { class: "chart-note", text: resNote(pv) }));
  }
  grid.append(sitesCard(sites, true));
}

function stateBar(r) {
  const total = Number(r.machines) || 1;
  return el("div", { class: "bar" }, STATES.map((s) => { const n = Number(r[s] ?? 0); return n > 0 ? el("span", { class: "st-" + s, style: `width:${100 * n / total}%`, title: `${s}: ${n}` }) : null; }));
}
const stateLegend = () => el("div", { class: "legend" }, STATES.map((s) => el("span", {}, el("i", { class: "st-" + s }), s)));

function sitesCard(sites, compact) {
  const cols = [
    { key: "name", label: "Site", render: (r) => r.name ?? `unresolved (${fmtNum(r.center_x / 100)}, ${fmtNum(r.center_y / 100)})` },
    { key: "machines", label: "Machines", num: true },
    { key: "bar", label: "States", render: stateBar, sort: (r) => Number(r.running) / (Number(r.machines) || 1) },
    ...(compact ? [] : STATES.map((s) => ({ key: s, label: s, num: true }))),
    { key: "mw_draw", label: "MW", num: true, render: (r) => fmtNum(r.mw_draw, 0) },
    { key: "avg_productivity", label: "Prod. %", num: true, render: (r) => fmtPct(r.avg_productivity) },
  ];
  const card = el("div", { class: "card" }, el("h2", {}, "Sites", el("span", { class: "hint", text: "machines by state, newest tick" })), stateLegend());
  card.append(sites.length ? table(sites, cols, { initialSort: { key: "machines", dir: -1 }, onRow: compact ? (r) => { state.tab = "sites"; state.sel.site = r.site_id; store("tab", "sites"); renderControls(); renderTab(); } : null }) : el("div", { class: "chart-empty", text: "No site samples yet." }));
  return card;
}

async function tabPower(main) {
  const power = latestPower();
  if (!power.length) { main.append(el("div", { class: "empty", text: "No power samples yet." })); return; }
  if (state.sel.group == null || !power.some((r) => r.circuit_group === state.sel.group)) state.sel.group = busiestGroup();
  const bar = el("div", { class: "toolbar" }, el("span", { class: "muted", text: "Circuit group" }),
    el("div", { class: "seg" }, power.map((r) => el("button", { type: "button", "aria-pressed": String(r.circuit_group === state.sel.group), onclick: () => { state.sel.group = r.circuit_group; renderTab(); } }, `${r.circuit_group}`, r.fuse_tripped ? " ⚡" : ""))));
  main.append(bar);
  const now = power.find((r) => r.circuit_group === state.sel.group);
  main.append(el("div", { class: "tiles" },
    el("div", { class: "tile" }, el("div", { class: "k", text: "Capacity" }), el("div", { class: "v", text: fmtMW(now.capacity_mw) })),
    el("div", { class: "tile" }, el("div", { class: "k", text: "Consumption" }), el("div", { class: "v", text: fmtMW(now.consumed_mw) }), el("div", { class: "d", text: `peak ${fmtMW(now.max_consumed_mw)}` })),
    el("div", { class: "tile" }, el("div", { class: "k", text: "Production" }), el("div", { class: "v", text: fmtMW(now.production_mw) })),
    el("div", { class: "tile" }, el("div", { class: "k", text: "Battery" }), el("div", { class: "v", text: now.battery_pct == null ? "none" : fmtPct(now.battery_pct) }), now.battery_pct != null ? el("div", { class: "d", text: `in ${fmtMW(now.battery_in_mw)} · out ${fmtMW(now.battery_out_mw)}` }) : null),
    el("div", { class: "tile" }, el("div", { class: "k", text: "Fuse" }), el("div", { class: "v " + (Number(now.fuse_tripped) ? "neg" : ""), text: Number(now.fuse_tripped) ? "Tripped" : "OK" })),
  ));
  const grid = el("div", { class: "grid wide" });
  main.append(grid);
  const pv = pivot(asSeriesList(await api(seriesUrl("/api/series/power", { group: state.sel.group }))), () => "g", ["capacity_mw", "production_mw", "consumed_mw", "max_consumed_mw", "battery_pct", "battery_in_mw", "battery_out_mw"]);
  const row = pv.keys.get("g");
  const a = chartCard(`${groupLabel(state.sel.group)} · MW`); grid.append(a.card);
  lineChart(a.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: " MW", fmt: (v) => fmtNum(v, 0), series: row ? [
    { label: "Capacity", data: row.capacity_mw, color: cssVar("--s1") },
    { label: "Production", data: row.production_mw, color: cssVar("--s3") },
    { label: "Consumption", data: row.consumed_mw, color: cssVar("--s2") },
    { label: "Peak draw", data: row.max_consumed_mw, color: cssVar("--s4"), dash: [4, 4] },
  ] : [] });
  a.card.append(el("div", { class: "chart-note", text: resNote(pv) }));
  if (row && row.battery_pct.some((v) => v != null)) {
    const b = chartCard("Battery charge", "%"); grid.append(b.card);
    lineChart(b.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "%", min: 0, max: 100, height: 180, series: [{ label: "Charge", data: row.battery_pct, color: cssVar("--s1") }] });
    const c = chartCard("Battery flow", "MW in and out"); grid.append(c.card);
    lineChart(c.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: " MW", height: 180, fmt: (v) => fmtNum(v, 0), series: [
      { label: "Charging", data: row.battery_in_mw, color: cssVar("--s3") },
      { label: "Discharging", data: row.battery_out_mw, color: cssVar("--s2") },
    ] });
  }
}

/** Table on the left, chart of the selected row on the right. Shared by production and depot. */
async function pickerTab(main, { rows, cols, initialSort, selKey, idOf, label, searchKeys, seriesPath, cols2, seriesOf, unit, fmt, empty }) {
  if (!rows.length) { main.append(el("div", { class: "empty", text: empty })); return; }
  if (state.sel[selKey] == null || !rows.some((r) => idOf(r) === state.sel[selKey])) state.sel[selKey] = idOf([...rows].sort(initialSort.cmp)[0]);
  const search = el("input", { type: "search", placeholder: "filter…", value: state.sel[selKey + "_q"] ?? "" });
  const grid = el("div", { class: "grid" });
  const left = el("div", { class: "card" }, el("h2", {}, label, el("span", { class: "hint", text: "newest tick · click a row to chart it" })), el("div", { class: "toolbar" }, search));
  const right = el("div", { class: "card" });
  const host = el("div", { class: "chart" });
  const note = el("div", { class: "chart-note" });
  const rightTitle = el("h2");
  right.append(rightTitle, host, note);
  grid.append(left, right);
  main.append(grid);
  let tableEl = null;
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    state.sel[selKey + "_q"] = search.value;
    const shown = q ? rows.filter((r) => searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(q))) : rows;
    const t = table(shown, cols, { initialSort: { key: initialSort.key, dir: initialSort.dir }, selected: (r) => idOf(r) === state.sel[selKey], onRow: (r) => { state.sel[selKey] = idOf(r); draw(); chart(); } });
    if (tableEl) tableEl.replaceWith(t); else left.append(t);
    tableEl = t;
  };
  const chart = async () => {
    const id = state.sel[selKey];
    rightTitle.replaceChildren(String(id));
    right.classList.add("faded");
    try {
      const pv = pivot(asSeriesList(await api(seriesUrl(seriesPath(id)))), () => "k", cols2);
      const row = pv.keys.get("k");
      lineChart(host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit, fmt, series: row ? seriesOf(row, rows.find((r) => idOf(r) === id)) : [] });
      note.textContent = resNote(pv);
    } catch (e) { if (e instanceof LoginRequired) throw e; host.replaceChildren(el("div", { class: "chart-empty error", text: String(e.message) })); }
    right.classList.remove("faded");
  };
  search.addEventListener("input", draw);
  draw();
  await chart();
}

const tabProduction = (main) => pickerTab(main, {
  rows: state.latest?.prod ?? [], empty: "No production samples yet.",
  selKey: "item", idOf: (r) => r.item, label: "Items", searchKeys: ["item"],
  initialSort: { key: "balance", dir: 1, cmp: (a, b) => (a.produced_per_min - a.consumed_per_min) - (b.produced_per_min - b.consumed_per_min) },
  cols: [
    { key: "item", label: "Item" },
    { key: "produced_per_min", label: "Produced /min", num: true, render: (r) => fmtNum(r.produced_per_min, 1) },
    { key: "consumed_per_min", label: "Consumed /min", num: true, render: (r) => fmtNum(r.consumed_per_min, 1) },
    { key: "balance", label: "Balance", num: true, sort: (r) => r.produced_per_min - r.consumed_per_min, render: (r) => signed(r.produced_per_min - r.consumed_per_min) },
    { key: "max_prod", label: "Max prod", num: true, render: (r) => fmtNum(r.max_prod, 1) },
  ],
  seriesPath: (item) => `/api/series/prod/${encodeURIComponent(item)}`, cols2: ["produced_per_min", "consumed_per_min", "max_prod"], unit: "/min", fmt: (v) => fmtNum(v, 1),
  seriesOf: (row) => [
    { label: "Produced", data: row.produced_per_min, color: cssVar("--s3") },
    { label: "Consumed", data: row.consumed_per_min, color: cssVar("--s2") },
    { label: "Max production", data: row.max_prod, color: cssVar("--s1"), dash: [4, 4] },
  ],
});

const tabDepot = (main) => pickerTab(main, {
  rows: state.latest?.depot ?? [], empty: "No depot samples yet.",
  selKey: "depot", idOf: (r) => r.item, label: "Dimensional Depot", searchKeys: ["item"],
  initialSort: { key: "fill", dir: -1, cmp: (a, b) => (b.stock / (b.capacity || 1)) - (a.stock / (a.capacity || 1)) },
  cols: [
    { key: "item", label: "Item" },
    { key: "stock", label: "Stock", num: true, render: (r) => fmtNum(r.stock) },
    { key: "capacity", label: "Capacity", num: true, render: (r) => fmtNum(r.capacity) },
    { key: "fill", label: "Fill", sort: (r) => r.stock / (r.capacity || 1), render: (r) => { const p = 100 * r.stock / (r.capacity || 1); return el("div", { class: "fill" + (Number(r.is_full) ? " full" : ""), title: fmtPct(p) }, el("span", { style: `width:${Math.min(100, p)}%` })); } },
    { key: "is_full", label: "", render: (r) => (Number(r.is_full) ? el("span", { class: "badge full", text: "full" }) : "") },
  ],
  seriesPath: (item) => `/api/series/depot/${encodeURIComponent(item)}`, cols2: ["stock", "capacity"], unit: "", fmt: (v) => fmtNum(v, 0),
  seriesOf: (row) => [
    { label: "Stock", data: row.stock, color: cssVar("--s1") },
    { label: "Capacity", data: row.capacity, color: cssVar("--s4"), dash: [4, 4] },
  ],
});

async function tabSites(main) {
  const sites = state.latest?.sites ?? [];
  if (!sites.length) { main.append(el("div", { class: "empty", text: "No site samples yet." })); return; }
  const resolved = sites.filter((r) => r.site_id != null);
  if (state.sel.site == null || !resolved.some((r) => r.site_id === state.sel.site)) state.sel.site = resolved[0]?.site_id ?? null;
  const grid = el("div", { class: "grid wide" });
  main.append(grid);
  const card = el("div", { class: "card" }, el("h2", {}, "Sites", el("span", { class: "hint", text: "machines by state, newest tick · click a site to chart it" })), stateLegend());
  card.append(table(sites, [
    { key: "name", label: "Site", render: (r) => r.name ?? `unresolved (${fmtNum(r.center_x / 100)}, ${fmtNum(r.center_y / 100)})` },
    { key: "machines", label: "Machines", num: true },
    { key: "bar", label: "States", render: stateBar, sort: (r) => Number(r.running) / (Number(r.machines) || 1) },
    ...STATES.map((s) => ({ key: s, label: s, num: true })),
    { key: "mw_draw", label: "MW", num: true, render: (r) => fmtNum(r.mw_draw, 0) },
    { key: "avg_productivity", label: "Prod. %", num: true, render: (r) => fmtPct(r.avg_productivity) },
  ], { initialSort: { key: "machines", dir: -1 }, selected: (r) => r.site_id != null && r.site_id === state.sel.site, onRow: (r) => { if (r.site_id == null) return; state.sel.site = r.site_id; renderTab(); } }));
  grid.append(card);
  if (state.sel.site == null) return;
  const site = sites.find((r) => r.site_id === state.sel.site);
  const { card: c2, host } = chartCard(`${site?.name ?? "site " + state.sel.site} · machines by state`);
  grid.append(c2);
  const pv = pivot(asSeriesList(await api(seriesUrl(`/api/series/site/${state.sel.site}`))), () => "k", ["running", "blocked", "starved", "unpowered", "machines", "mw_draw"]);
  const row = pv.keys.get("k");
  lineChart(host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "", fmt: (v) => fmtNum(v, 0), series: row ? [
    { label: "Running", data: row.running, color: cssVar("--good") },
    { label: "Blocked", data: row.blocked, color: cssVar("--warning") },
    { label: "Starved", data: row.starved, color: cssVar("--serious") },
    { label: "Unpowered", data: row.unpowered, color: cssVar("--critical") },
    { label: "Total", data: row.machines, color: cssVar("--muted"), dash: [4, 4] },
  ] : [] });
  c2.append(el("div", { class: "chart-note", text: resNote(pv) }));
}

async function tabGens(main) {
  const gens = state.latest?.gens ?? [];
  if (!gens.length) { main.append(el("div", { class: "empty", text: "No generator samples yet." })); return; }
  const grid = el("div", { class: "grid wide" });
  main.append(grid);
  const card = el("div", { class: "card" }, el("h2", {}, "Generators", el("span", { class: "hint", text: "per fuel type and field, newest tick" })));
  card.append(table(gens, [
    { key: "name", label: "Field", render: (r) => r.name ?? `unresolved (${fmtNum(r.center_x / 100)}, ${fmtNum(r.center_y / 100)})` },
    { key: "fuel_type", label: "Fuel" },
    { key: "total", label: "Generators", num: true },
    { key: "fueled", label: "Fueled", num: true },
    { key: "dry", label: "Dry", num: true, render: (r) => el("span", { class: Number(r.dry) ? "neg" : null, text: fmtNum(r.dry) }) },
    { key: "capacity_mw", label: "Capacity", num: true, render: (r) => fmtMW(r.capacity_mw) },
    { key: "load_pct", label: "Load", num: true, render: (r) => fmtPct(r.load_pct) },
    { key: "waste", label: "Waste", num: true, render: (r) => (r.fuel_type === "Nuclear" ? el("span", { class: Number(r.waste) ? "neg" : null, text: fmtNum(r.waste) }) : "") },
  ], { initialSort: { key: "capacity_mw", dir: -1 } }));
  grid.append(card);
  const pv = pivot(asSeriesList(await api(seriesUrl("/api/series/gens"))), (p) => String(p.fuel_type), ["dry", "fueled", "capacity_mw", "load_pct", "waste"]);
  const a = chartCard("Dry generators", "map-wide, per fuel type"); grid.append(a.card);
  lineChart(a.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "", fmt: (v) => fmtNum(v, 0), height: 200, series: [...pv.keys].map(([k, row]) => ({ label: k, data: row.dry })) });
  const b = chartCard("Generator capacity", "map-wide, per fuel type"); grid.append(b.card);
  lineChart(b.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: " MW", fmt: (v) => fmtNum(v, 0), height: 200, series: [...pv.keys].map(([k, row]) => ({ label: k, data: row.capacity_mw })) });
  const c = chartCard("Generator load", "map-wide average, per fuel type"); grid.append(c.card);
  lineChart(c.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "%", min: 0, max: 100, fmt: (v) => fmtNum(v, 0), height: 200, series: [...pv.keys].map(([k, row]) => ({ label: k, data: row.load_pct })) });
  const nuke = pv.keys.get("Nuclear");
  if (nuke) {
    const d = chartCard("Nuclear waste", "items in generator output inventories"); grid.append(d.card);
    lineChart(d.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "", fmt: (v) => fmtNum(v, 0), height: 200, series: [{ label: "Waste", data: nuke.waste, color: cssVar("--s2") }] });
  }
  a.card.append(el("div", { class: "chart-note", text: resNote(pv) }));
}

async function tabSinks(main) {
  const grid = el("div", { class: "grid" });
  main.append(grid);
  const pv = pivot(asSeriesList(await api(seriesUrl("/api/series/sinks"))), (p) => String(p.sink), ["coupons", "points_per_min", "points_to_next"]);
  const label = (k) => (k === "resource" ? "AWESOME Sink" : k === "exploration" ? "Exploration sink" : k);
  const a = chartCard("Coupons"); grid.append(a.card);
  lineChart(a.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "", fmt: (v) => fmtNum(v, 0), series: [...pv.keys].map(([k, row]) => ({ label: label(k), data: row.coupons })) });
  const b = chartCard("Points per minute"); grid.append(b.card);
  lineChart(b.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "", fmt: (v) => fmtNum(v, 0), series: [...pv.keys].map(([k, row]) => ({ label: label(k), data: row.points_per_min })) });
  const c = chartCard("Points to next coupon"); grid.append(c.card);
  lineChart(c.host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "", fmt: (v) => fmtNum(v, 0), series: [...pv.keys].map(([k, row]) => ({ label: label(k), data: row.points_to_next })) });
  a.card.append(el("div", { class: "chart-note", text: resNote(pv) }));
}

// ---------------------------------------------------------------- emergency

async function tabEmergency(main) {
  const r = await api("/api/emergency");
  const modeText = { normal: "Normal: reserves off, ties on", "dark-restart": "Dark restart in progress: ties off, reserves on", mixed: "Mixed: some switches are not in their normal position", none: "No *-EMERGENCY-RESERVE or *-TIE switches found" }[r.mode] ?? r.mode;
  const banner = el("div", { class: "banner " + (r.ready ? "ok" : r.mode === "none" ? "" : "bad") },
    el("div", { class: "banner-word", text: r.ready ? "Ready" : r.mode === "none" ? "Not configured" : "Not ready" }),
    el("div", { class: "banner-sub", text: `${modeText} · threshold ${r.minChargePct}% · main grid is circuit group ${r.mainGroup ?? "?"}` }));
  main.append(banner);
  if (!r.switches.length) {
    main.append(el("div", { class: "card" }, el("h2", {}, "How to set it up"),
      el("p", { class: "muted", text: "Name a power switch <SITE>-EMERGENCY-RESERVE to mark the switch that gates a battery bank (off in normal operation), and <SITE>-TIE for the site's cut-off from the main grid (on in normal operation). This tab pairs them by site." }),
      r.otherSwitches.length ? el("p", { class: "muted small", text: `Other switches: ${r.otherSwitches.map((s) => `${s.name} (${s.isOn ? "closed" : "open"})`).join(", ")}` }) : null));
    return;
  }
  const grid = el("div", { class: "grid" });
  main.append(grid);
  const sw = (s, label) => {
    if (!s) return el("div", { class: "swrow missing" }, el("span", { class: "swname", text: label }), el("span", { class: "muted", text: "not present" }));
    const state = s.isOn ? "on" : "off";
    const good = s.isOn === s.expectedOn;
    return el("div", { class: "swrow" }, el("span", { class: "swname", text: s.name }),
      el("span", { class: "pill " + (good ? "ok" : "bad"), text: state }), el("span", { class: "muted small", text: `expected ${s.expectedOn ? "on" : "off"} · circuits ${s.primaryCircuit}/${s.secondaryCircuit}${!s.isOn && s.sidesJoined ? " · bypassed" : ""}` }));
  };
  for (const site of r.sites) {
    const res = site.reserve?.reserve ?? null;
    const card = el("div", { class: "card" + (site.ok ? "" : " card-bad") },
      el("h2", {}, site.site, el("span", { class: "pill " + (site.ok ? "ok" : "bad"), text: site.ok ? "ready" : `${site.issues.length} issue${site.issues.length > 1 ? "s" : ""}` })),
      sw(site.reserve, `${site.site}-EMERGENCY-RESERVE`), sw(site.tie, `${site.site}-TIE`));
    if (res) {
      const p = res.batteryPct ?? 0;
      card.append(el("div", { class: "battery" },
        el("div", { class: "k", text: `Reserve battery · circuit group ${res.group}` }),
        el("div", { class: "fill big" + (p < r.minChargePct ? " low" : "") }, el("span", { style: `width:${Math.min(100, p)}%` })),
        el("div", { class: "d" }, el("b", { text: `${fmtPct(res.batteryPct)} · ${fmtEnergy(res.storedMWh)}` }), ` of ${fmtEnergy(res.batteryMWh)}`,
          res.batteryInMW > 0 ? ` · charging ${fmtMW(res.batteryInMW)}${res.timeToFull ? ` (full in ${res.timeToFull})` : ""}` : "",
          res.batteryOutMW > 0 ? ` · discharging ${fmtMW(res.batteryOutMW)}${res.timeToEmpty ? ` (empty in ${res.timeToEmpty})` : ""}` : "",
          res.consumedMW > 0 ? ` · ${fmtMW(res.consumedMW)} load` : "", res.productionMW > 0 ? ` · ${fmtMW(res.productionMW)} generation` : "",
          res.fuseTripped ? " · FUSE TRIPPED" : "")));
    } else if (site.reserve?.isOn) {
      card.append(el("div", { class: "battery" }, el("div", { class: "d muted", text: "Switch is on, so the bank and the grid are one circuit; nothing is held back." })));
    }
    if (site.issues.length) card.append(el("ul", { class: "issues" }, site.issues.map((i) => el("li", { text: i }))));
    if (site.notes.length) card.append(el("ul", { class: "issues notes" }, site.notes.map((i) => el("li", { text: i }))));
    grid.append(card);
  }
  // History for each held-back reserve: the battery % of its circuit group.
  for (const site of r.sites) {
    const res = site.reserve?.reserve;
    if (!res) continue;
    const { card, host } = chartCard(`${site.site} reserve battery`, `circuit group ${res.group}`);
    grid.append(card);
    const pv = pivot(asSeriesList(await api(seriesUrl("/api/series/power", { group: res.group }))), () => "g", ["battery_pct", "battery_in_mw", "battery_out_mw"]);
    const row = pv.keys.get("g");
    lineChart(host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "%", min: 0, max: 100, height: 180, series: row ? [{ label: "Charge", data: row.battery_pct, color: cssVar("--s1") }] : [] });
    card.append(el("div", { class: "chart-note", text: resNote(pv) + " · group numbers change when the grid is rewired, so a long window may not be this bank" }));
  }
}

// ---------------------------------------------------------------- trains

const STATE_PILL = { moving: "ok", docked: "ok", stopped: "warn", derailed: "bad" };
const cargoText = (cargo, n = 2) => (cargo.length ? cargo.slice(0, n).map((c) => `${fmtNum(c.amount)} ${c.name}`).join(", ") + (cargo.length > n ? ` +${cargo.length - n}` : "") : "empty");
const dwell = (v, now) => { const end = v.departed_ts ?? now; return fmtDur(end - v.arrived_ts) + (v.departed_ts == null ? " (still docked)" : ""); };

function visitsTable(visits, now, { hideStation, hideTrain } = {}) {
  if (!visits.length) return el("div", { class: "chart-empty", text: "No dock visits in this range." });
  const cols = [
    { key: "arrived_ts", label: "Arrived", num: true, render: (v) => fmtTime(v.arrived_ts) },
    ...(hideStation ? [] : [{ key: "station", label: "Station" }]),
    ...(hideTrain ? [] : [{ key: "train", label: "Train" }]),
    { key: "dwell", label: "Dwell", num: true, sort: (v) => (v.departed_ts ?? now) - v.arrived_ts, render: (v) => dwell(v, now) },
    { key: "delta_cargo", label: "Cargo moved", num: true, render: (v) => (v.delta_cargo == null ? "–" : signed(v.delta_cargo, 0)) },
  ];
  return table(visits, cols, { initialSort: { key: "arrived_ts", dir: -1 } });
}

async function tabTrains(main) {
  const { from, to } = window_();
  const [r, vis] = await Promise.all([api("/api/trains"), api(`/api/visits?from=${from}&to=${to}`)]);
  const visits = vis.visits ?? [];
  const c = r.counts;
  const tile = (k, v, d, cls) => el("div", { class: "tile" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) }), d ? el("div", { class: "d " + (cls ?? ""), text: d }) : null);
  const withErrors = r.trains.filter((t) => t.errors.length);
  main.append(el("div", { class: "tiles" },
    tile("Trains", c.trains, `${c.moving} moving · ${c.docked} docked · ${c.stopped} stopped`),
    tile("Derailed", c.derailed, c.derailed ? "needs a visit" : "none", c.derailed ? "bad" : "ok"),
    tile("Stations", c.stations, `${c.platforms} freight platforms`),
    tile("Signals", c.signals ?? 0, c.signals ? `${c.signalsStop} at stop · ${c.invalidBlocks} invalid block${c.invalidBlocks === 1 ? "" : "s"}` : "none", c.invalidBlocks ? "bad" : null),
    tile("Dock visits", visits.length, `in the last ${state.range}`),
    tile("Errors", withErrors.length, withErrors.map((t) => t.name).slice(0, 3).join(", ") || "none", withErrors.length ? "bad" : "ok"),
  ));
  if (!r.trains.length && !r.stations.length) { main.append(el("div", { class: "empty", text: "No trains or stations in this save." })); return; }
  const currentNames = new Set(r.trains.map((t) => t.name));
  const section = (title, hint, node) => main.append(el("div", { class: "grid wide" }, el("div", { class: "card" }, el("h2", {}, title, el("span", { class: "hint", text: hint })), node)));
  const h3 = (t) => el("h3", { text: t });

  // ---- trains
  const trainDetail = (t) => {
    // History is keyed by the train's name at the time. A renamed train's old visits show up at its
    // stations under a name no current train has; attach those, labelled, rather than show nothing.
    let mine = visits.filter((v) => v.train === t.name);
    let renamedNote = null;
    if (!mine.length && t.timetable.length) {
      const orphans = visits.filter((v) => t.timetable.includes(v.station) && !currentNames.has(v.train));
      const names = [...new Set(orphans.map((v) => v.train))];
      if (names.length === 1) { mine = orphans; renamedNote = `visits recorded under the name ${names[0]}; the sampler keys history by train name, so a rename starts fresh`; }
    }
    return el("div", { class: "drawer-grid" },
      el("div", {}, el("div", { class: "muted small", text: `${t.status} · ${t.speed} km/h · ${t.locomotives} loco + ${t.cars - t.locomotives} cars · ${fmtNum(t.powerMW, 1)} MW · at ${t.location}` }),
        t.errors.length ? el("ul", { class: "issues" }, t.errors.map((e) => el("li", { text: e }))) : null,
        h3("Timetable"), el("ol", { class: "timetable" }, t.timetable.map((stop, i) => el("li", { class: i === t.timetableIndex ? "cur" : null }, el("a", { href: "#", onclick: (e) => { e.preventDefault(); state.sel.station = stop; renderTab(); } }, stop), i === t.timetableIndex ? el("span", { class: "pill ok", text: t.state === "docked" ? "here" : "next" }) : null))),
        h3(`Cargo · ${fmtPct(t.payloadPct)} of ${fmtNum(t.maxPayloadT)} t`), t.cargo.length ? el("ul", { class: "plain" }, t.cargo.map((x) => el("li", { text: `${fmtNum(x.amount)} ${x.name}` }))) : el("p", { class: "muted small", text: "empty" })),
      el("div", { class: "span2" }, h3(`Dock history · last ${state.range}`), renamedNote ? el("p", { class: "muted small", text: renamedNote }) : null, visitsTable(mine, r.now, { hideTrain: true })));
  };
  if (state.sel.train != null && !r.trains.some((t) => t.name === state.sel.train)) state.sel.train = null;
  const trainCols = [
    { key: "name", label: "Train" },
    { key: "state", label: "State", render: (t) => el("span", { class: "pill " + STATE_PILL[t.state], text: t.state }) },
    { key: "stop", label: "Stop", sort: (t) => t.nextStop ?? t.station ?? "", render: (t) => (t.state === "docked" ? `at ${t.station ?? "?"}` : `→ ${t.nextStop ?? t.station ?? "?"}`) },
    { key: "speed", label: "km/h", num: true },
    { key: "payloadPct", label: "Payload", num: true, render: (t) => fmtPct(t.payloadPct) },
    { key: "cargo", label: "Cargo", wrap: true, sort: (t) => t.cargo.reduce((n, x) => n + x.amount, 0), render: (t) => cargoText(t.cargo, 3) },
    { key: "errors", label: "Errors", wrap: true, sort: (t) => t.errors.length, render: (t) => (t.errors.length ? el("span", { class: "neg", text: t.errors.join("; ") }) : "") },
  ];
  section("Trains", "live · click a train to open it", table(r.trains, trainCols, { initialSort: { key: "name", dir: 1 }, selected: (t) => t.name === state.sel.train, onRow: (t) => { state.sel.train = state.sel.train === t.name ? null : t.name; renderTab(); }, expand: trainDetail }));

  // ---- stations
  const stationDetail = (st) => {
    const { card, host } = chartCard("Transfer rate per platform");
    card.className = "";
    (async () => {
      try {
        const pv = pivot(asSeriesList(await api(seriesUrl(`/api/series/station/${encodeURIComponent(st.name)}`))), (p) => String(p.platform), ["transfer_rate"]);
        lineChart(host, { x: pv.x, gaps: pv.gaps, epochs: pv.epochs, unit: "", height: 160, fmt: (v) => fmtNum(v, 2), series: [...pv.keys].map(([k, row]) => ({ label: `Platform ${Number(k) + 1}`, data: row.transfer_rate })) });
        card.append(el("div", { class: "chart-note", text: resNote(pv) }));
      } catch (e) { if (e instanceof LoginRequired) return showLogin(); host.replaceChildren(el("div", { class: "chart-empty error", text: String(e.message) })); }
    })();
    return el("div", { class: "drawer-grid" },
      el("div", { class: "span2" }, el("div", { class: "muted small", text: `${st.platforms.length} platforms · transfer ${fmtNum(st.transferRate, 2)} · at ${st.location}${st.fuseTripped ? " · FUSE TRIPPED" : ""}` }),
        h3("Platforms"), table(st.platforms, [
          { key: "index", label: "#", num: true, render: (p) => String(p.index + 1) },
          { key: "mode", label: "Mode" },
          { key: "status", label: "Status" },
          { key: "docking", label: "Docking" },
          { key: "stock", label: "Stock", num: true, render: (p) => fmtNum(p.stock) },
          { key: "inventory", label: "Items", wrap: true, sort: (p) => p.stock, render: (p) => cargoText(p.inventory) },
          { key: "transferRate", label: "Transfer", num: true, render: (p) => fmtNum(p.transferRate, 2) },
        ], { initialSort: { key: "index", dir: 1 } }),
        h3("Scheduled trains"), st.scheduled.length ? el("ul", { class: "plain" }, st.scheduled.map((n) => el("li", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); state.sel.train = n; renderTab(); } }, n)))) : el("p", { class: "muted small", text: "no train has this station on its timetable" })),
      el("div", { class: "span2" }, h3(`Dock history · last ${state.range}`), visitsTable(visits.filter((v) => v.station === st.name), r.now, { hideStation: true }), h3("Transfer rate per platform"), card));
  };
  if (state.sel.station != null && !r.stations.some((s) => s.name === state.sel.station)) state.sel.station = null;
  const stationCols = [
    { key: "name", label: "Station" },
    { key: "platforms", label: "Platforms", sort: (s) => s.platforms.length, render: (s) => s.platforms.map((p) => (p.mode === "load" ? "L" : "U")).join(" ") || "none" },
    { key: "stock", label: "Stock", num: true, render: (s) => fmtNum(s.stock) },
    { key: "top", label: "Items", wrap: true, sort: (s) => s.topItems[0]?.amount ?? 0, render: (s) => cargoText(s.topItems) },
    { key: "docked", label: "Docked", render: (s) => s.docked ?? "" },
    { key: "inbound", label: "Inbound", wrap: true, sort: (s) => s.inbound.length, render: (s) => s.inbound.join(", ") },
    { key: "scheduled", label: "Scheduled by", wrap: true, sort: (s) => s.scheduled.length, render: (s) => s.scheduled.join(", ") },
  ];
  section("Stations", "live · click a station to open it", table(r.stations, stationCols, { initialSort: { key: "name", dir: 1 }, selected: (s) => s.name === state.sel.station, onRow: (s) => { state.sel.station = state.sel.station === s.name ? null : s.name; renderTab(); }, expand: stationDetail }));

  // ---- signals: problems first (invalid blocks, then Stop aspects); the full list is collapsed behind a toggle
  const signals = r.signals ?? [];
  if (signals.length) {
    const problems = signals.filter((s) => !s.blockOk || s.aspect === "Stop");
    const ASPECT_PILL = { Clear: "ok", Dock: "ok", Stop: "warn", None: null };
    const signalCols = [
      { key: "id", label: "Signal" },
      { key: "kind", label: "Type" },
      { key: "aspect", label: "Aspect", render: (s) => el("span", { class: "pill " + (ASPECT_PILL[s.aspect] ?? ""), text: s.aspect }) },
      { key: "block", label: "Block", render: (s) => el("span", { class: s.blockOk ? null : "neg", text: s.block }) },
      { key: "location", label: "Location" },
    ];
    const showAll = state.sel.allSignals === true;
    const rows = showAll ? signals : problems;
    const toggle = el("button", { type: "button", class: "ghost small", onclick: () => { state.sel.allSignals = !showAll; renderTab(); } }, showAll ? `show problems only (${problems.length})` : `show all ${signals.length}`);
    section("Signals", problems.length ? `${problems.length} need attention · live` : "every block valid, nothing at stop · live",
      el("div", {}, toggle, rows.length ? table(rows, signalCols, { initialSort: { key: "block", dir: 1 } }) : el("div", { class: "chart-empty", text: "No signal problems." })));
  }
}

// ---------------------------------------------------------------- admin

/** A card that loads its own endpoint, so a slow origin check never holds up the D1 or KV sections. */
function lazyCard(title, hint, load) {
  const body = el("div", { class: "chart-empty", text: "Loading…" });
  const card = el("div", { class: "card" }, el("h2", {}, title, el("span", { class: "hint", text: hint })), body);
  const run = async () => {
    body.replaceChildren(el("div", { class: "chart-empty", text: "Loading…" }));
    try { const node = await load(); body.replaceChildren(node); }
    catch (e) { if (e instanceof LoginRequired) return showLogin(); body.replaceChildren(el("div", { class: "chart-empty error", text: String(e.message) })); }
  };
  run();
  return { card, reload: run };
}
const kv = (pairs) => el("dl", { class: "kv" }, pairs.filter((p) => p).flatMap(([k, v]) => [el("dt", { text: k }), el("dd", {}, v ?? "–")]));
const pill = (text, cls) => el("span", { class: "pill " + (cls ?? ""), text });
const confirmThen = async (message, fn, after) => { if (!window.confirm(message)) return; try { await fn(); } catch (e) { window.alert(e.message); } await after(); };
const del = (path) => api(path, { method: "DELETE" });
const send = (path, method, body) => api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fmtTs = (ts) => (ts == null ? "–" : fmtTime(ts, { year: "numeric" }));
const fmtBytes = (n) => (n == null ? "–" : n >= 1e6 ? fmtNum(n / 1e6, 1) + " M" : n >= 1e3 ? fmtNum(n / 1e3, 1) + " k" : fmtNum(n));

async function tabAdmin(main) {
  const tiles = el("div", { class: "tiles" });
  const grid = el("div", { class: "grid wide" });
  main.append(tiles, grid);
  const tile = (k, v, d, cls) => el("div", { class: "tile" }, el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) }), d ? el("div", { class: "d " + (cls ?? ""), text: d }) : null);

  // ---- origin and tunnel
  const origin = lazyCard("Origin and tunnel", "live: Access → tunnel → FRM", async () => {
    const r = await api("/api/admin/origin");
    tiles.replaceChildren(
      tile("Origin", r.reachable ? "Up" : "Down", r.reachable ? `${fmtNum(r.latency_ms)} ms round trip` : (r.error ?? "").slice(0, 70), r.reachable ? "ok" : "bad"),
      tile("FRM", r.frm.version ?? "–", r.frm.mods.length ? `${r.frm.mods.length} mods loaded` : (r.reachable ? "mod list unavailable" : "game down")),
      tile("Save", r.session?.name ?? "–", r.session ? `${r.session.paused ? "paused" : "running"} · day ${r.session.days} · ${r.session.play_text}` : ""),
    );
    const cols = [
      { key: "name", label: "Mod" }, { key: "smr", label: "SMR id" }, { key: "version", label: "Version" }, { key: "author", label: "Author" },
      { key: "requiredOnRemote", label: "Clients need it", render: (m) => (m.requiredOnRemote ? "yes" : "") },
    ];
    return el("div", {},
      kv([["Reachable", pill(r.reachable ? "yes" : "no", r.reachable ? "ok" : "bad")], ["Latency", `${fmtNum(r.latency_ms)} ms`], r.status ? ["HTTP status", String(r.status)] : null, r.error ? ["Error", el("span", { class: "neg", text: r.error })] : null, ["Checked", fmtTs(r.now)]]),
      r.frm.mods.length ? table(r.frm.mods, cols, { initialSort: { key: "name", dir: 1 } }) : null);
  });
  grid.append(origin.card);

  // ---- system
  const system = lazyCard("Worker configuration", "vars and gates", async () => {
    const r = await api("/api/admin/system");
    const cfg = r.config;
    return kv([
      ["MCP server", r.server_version],
      ["FRM origin", cfg.frm_base_url],
      ["MCP hosts", cfg.mcp_hosts.join(", ")],
      ["Dashboard host", cfg.dash_host],
      ["Hanko", cfg.hanko_api_url],
      ["Dashboard allow-list", cfg.allowed_emails.join(", ") || "(empty: nobody can sign in)"],
      ["Access service token", pill(cfg.access_token_set ? "set" : "missing", cfg.access_token_set ? "ok" : "bad")],
      ["Write tools", pill(cfg.write_enabled ? "ENABLED" : "disabled", cfg.write_enabled ? "warn" : "ok")],
      ["FRM API key", pill(cfg.api_key_set ? "set" : "not set", cfg.api_key_set ? "ok" : null)],
      ["Raw retention", `${fmtNum(r.retention.raw_seconds / 86400)} days · KV ring ${r.retention.ring_hours} h`],
    ]);
  });
  grid.append(system.card);

  // ---- sampler and history
  const sampler = lazyCard("Sampler and history", "KV state, D1 tables, epochs, gaps, rollup", async () => {
    const r = await api("/api/admin/sampler");
    const st = r.state, ring = r.ring, roll = r.rollup;
    const behind = roll.raw_rows_past_cutoff > 0;
    const tableCols = [
      { key: "table", label: "Table" }, { key: "rows", label: "Rows", num: true, render: (t) => fmtBytes(t.rows) },
      { key: "oldest", label: "Oldest", num: true, render: (t) => fmtTs(t.oldest) }, { key: "newest", label: "Newest", num: true, render: (t) => fmtTs(t.newest) },
    ];
    const epochCols = [
      { key: "epoch", label: "Epoch", num: true }, { key: "session", label: "Session" },
      { key: "first_ts", label: "First", num: true, render: (e) => fmtTs(e.first_ts) }, { key: "last_ts", label: "Last", num: true, render: (e) => fmtTs(e.last_ts) },
      { key: "ticks", label: "Ticks", num: true }, { key: "gaps", label: "Gaps", num: true, render: (e) => el("span", { class: e.gaps ? "neg" : null, text: fmtNum(e.gaps) }) },
    ];
    const gapCols = [{ key: "ts", label: "When", num: true, render: (g) => fmtTs(g.ts) }, { key: "epoch", label: "Epoch", num: true }, { key: "reason", label: "Reason", wrap: true }];
    return el("div", {},
      el("div", { class: "tiles" },
        tile("Last tick", ring.newest ? fmtAge(ring.staleness_seconds) : "–", ring.latest_is_gap ? "was a gap" : (ring.newest ? "good sample" : "no samples"), ring.latest_is_gap ? "bad" : (ring.staleness_seconds > 900 ? "bad" : "ok")),
        tile("Epoch", st.epoch, st.session ? `${st.session} · play ${fmtDur(st.playtime)}` : "no session yet"),
        tile("KV ring", ring.size, ring.oldest ? `since ${fmtTs(ring.oldest)} · ${ring.gaps} gap${ring.gaps === 1 ? "" : "s"}` : "empty"),
        tile("Open visits", st.visits, st.lastGood ? "last tick was good" : "last tick was a gap", st.lastGood ? "ok" : "bad"),
        tile("Rollup", roll.last_run ? fmtAge(r.now - roll.last_run.at) : "never", behind ? `${fmtNum(roll.raw_rows_past_cutoff)} raw rows past the cutoff` : "raw rows within retention", behind ? "bad" : "ok"),
      ),
      kv([["Raw cutoff", fmtTs(roll.cutoff)], ["Oldest raw tick", fmtTs(roll.oldest_raw_ts)], ["Newest hourly bucket", fmtTs(roll.newest_hourly_bucket)], ["Lookups seeded", st.seeded ? "yes" : "no (next live tick fills blank rows)"]]),
      el("h3", { text: "D1 tables" }), table(r.tables, tableCols, { initialSort: { key: "table", dir: 1 } }),
      el("h3", { text: "Epochs" }), r.epochs.length ? table(r.epochs, epochCols, { initialSort: { key: "epoch", dir: -1 } }) : el("p", { class: "muted small", text: "no ticks yet" }),
      el("h3", { text: `Recent gaps (${r.gaps.length})` }), r.gaps.length ? table(r.gaps, gapCols, { initialSort: { key: "ts", dir: -1 } }) : el("p", { class: "muted small", text: "none recorded" }));
  });
  grid.append(sampler.card);

  // ---- auth and connectors
  const oauth = lazyCard("Connectors (OAuth)", "clients, grants, live tokens · MCP host", async () => {
    const r = await api("/api/admin/oauth");
    const me = await api("/api/me").catch(() => null);
    const clientCols = [
      { key: "clientName", label: "Client", render: (c) => c.clientName ?? el("span", { class: "muted", text: "(unnamed)" }) },
      { key: "clientId", label: "Id" },
      { key: "registrationDate", label: "Registered", num: true, render: (c) => fmtTs(c.registrationDate) },
      { key: "redirectUris", label: "Redirects", wrap: true, render: (c) => c.redirectUris.join(", ") },
      { key: "grants", label: "Grants", num: true },
      { key: "act", label: "", render: (c) => el("button", { type: "button", class: "danger small", onclick: (e) => { e.stopPropagation(); confirmThen(`Delete client ${c.clientName ?? c.clientId} and revoke its ${c.grants} grant(s)? The connector will have to register again.`, () => del(`/api/admin/oauth/clients/${encodeURIComponent(c.clientId)}`), oauth.reload); } }, "Delete") },
    ];
    const grantCols = [
      { key: "clientName", label: "Client", render: (g) => g.clientName ?? g.clientId },
      { key: "userId", label: "User" },
      { key: "createdAt", label: "Granted", num: true, render: (g) => fmtTs(g.createdAt) },
      { key: "expiresAt", label: "Expires", num: true, render: (g) => (g.expiresAt ? fmtTs(g.expiresAt) : "never") },
      { key: "tokens", label: "Live tokens", num: true, render: (g) => (g.tokens ? `${g.tokens} · until ${fmtTs(g.latestTokenExpiry)}` : "0") },
      { key: "scope", label: "Scope", wrap: true, render: (g) => g.scope.join(" ") },
      { key: "act", label: "", render: (g) => el("button", { type: "button", class: "danger small", onclick: (e) => { e.stopPropagation(); confirmThen(`Revoke this grant for ${g.clientName ?? g.clientId}? Its tokens stop working immediately.`, () => del(`/api/admin/oauth/grants/${encodeURIComponent(g.userId)}/${encodeURIComponent(g.id)}`), oauth.reload); } }, "Revoke") },
    ];
    return el("div", {},
      el("div", { class: "tiles" },
        tile("Clients", r.clients.length, "registered via /register"),
        tile("Grants", r.grants.length, `${r.grants.filter((g) => g.tokens).length} with live tokens`),
        tile("Tokens", r.tokens, "access + refresh, unexpired"),
        tile("This session", me?.email ?? "–", "Hanko · dashboard host", "ok"),
      ),
      el("h3", { text: "Clients" }), r.clients.length ? table(r.clients, clientCols, { initialSort: { key: "registrationDate", dir: -1 } }) : el("p", { class: "muted small", text: "none" }),
      el("h3", { text: "Grants" }), r.grants.length ? table(r.grants, grantCols, { initialSort: { key: "createdAt", dir: -1 } }) : el("p", { class: "muted small", text: "none" }));
  });
  grid.append(oauth.card);

  // ---- lookups
  for (const [tableName, label, hint] of [["sites", "Sites", "cluster centers for site_samples"], ["fields", "Generator fields", "cluster centers for gen_samples"]]) {
    const card = lazyCard(label, `${hint} · blank coordinates are filled by the next live tick`, async () => {
      const rows = await api(`/api/lookup/${tableName}`);
      const numIn = (v, ph) => el("input", { type: "number", step: "1", value: v ?? "", placeholder: ph, class: "inline" });
      const rowEl = (r) => {
        const name = el("input", { type: "text", value: r.name, class: "inline name" });
        const x = numIn(r.x, "x"), y = numIn(r.y, "y"), z = numIn(r.z, "z");
        const save = async () => {
          const body = { name: name.value };
          for (const [k, i] of [["x", x], ["y", y], ["z", z]]) body[k] = i.value === "" ? null : Number(i.value);
          try { await send(`/api/lookup/${tableName}/${r.id}`, "PATCH", body); await card.reload(); } catch (e) { window.alert(e.message); }
        };
        return el("div", { class: "lookup-row" }, el("span", { class: "muted small", text: `#${r.id}` }), name, x, y, z,
          el("button", { type: "button", class: "small", onclick: save }, "Save"),
          el("button", { type: "button", class: "ghost small", title: "clear coordinates so the sampler re-seeds this row", onclick: () => confirmThen(`Clear the coordinates of ${r.name}? The next live tick assigns it the largest unclaimed cluster.`, () => send(`/api/lookup/${tableName}/${r.id}`, "PATCH", { x: null, y: null, z: null }), card.reload) }, "Clear"));
      };
      const newName = el("input", { type: "text", placeholder: "new row name", class: "inline name" });
      const add = el("div", { class: "lookup-row add" }, el("span", { class: "muted small", text: "new" }), newName,
        el("button", { type: "button", class: "small", onclick: async () => { if (!newName.value.trim()) return; try { await send(`/api/lookup/${tableName}`, "POST", { name: newName.value.trim() }); await card.reload(); } catch (e) { window.alert(e.message); } } }, "Add"));
      return el("div", { class: "lookup" }, el("div", { class: "lookup-row head" }, el("span", { text: "id" }), el("span", { text: "name" }), el("span", { text: "x (cm)" }), el("span", { text: "y (cm)" }), el("span", { text: "z (cm)" }), el("span"), el("span")), rows.map(rowEl), add);
    });
    grid.append(card.card);
  }

  // ---- game (read-only)
  const game = lazyCard("Game", "live · session, players, switches, chat · read-only until the write path lands", async () => {
    const r = await api("/api/admin/game?chat=50");
    const s = r.session ?? {};
    const errs = Object.entries(r.errors ?? {});
    const switchCols = [
      { key: "name", label: "Switch" }, { key: "isOn", label: "State", render: (w) => pill(w.isOn ? "on" : "off", w.isOn ? "ok" : null) },
      { key: "priority", label: "Priority", num: true }, { key: "primary", label: "Primary group", num: true }, { key: "secondary", label: "Secondary group", num: true }, { key: "location", label: "Location" },
    ];
    const chatCols = [{ key: "time", label: "Time", render: (m) => String(m.time ?? "") }, { key: "sender", label: "From" }, { key: "type", label: "Type" }, { key: "message", label: "Message", wrap: true }];
    const playerCols = [{ key: "name", label: "Player" }, { key: "online", label: "Online", render: (p) => pill(p.online ? "online" : "offline", p.online ? "ok" : null) }, { key: "health", label: "HP", num: true }, { key: "dead", label: "Dead", render: (p) => (p.dead ? "yes" : "") }, { key: "location", label: "Location" }];
    return el("div", {},
      errs.length ? el("ul", { class: "issues" }, errs.map(([k, v]) => el("li", { text: `${k}: ${v}` }))) : null,
      kv([
        ["Session", s.SessionName], ["State", s.IsPaused ? pill("paused", "warn") : pill("running", "ok")], ["Play time", s.TotalPlayDurationText],
        ["Day", s.PassedDays != null ? `${s.PassedDays} · ${s.IsDay ? "day" : "night"} ${String(s.Hours ?? 0).padStart(2, "0")}:${String(s.Minutes ?? 0).padStart(2, "0")} · ${s.DayLength}/${s.NightLength} min` : null],
        ["Since last death", s.NumberOfDaysSinceLastDeath != null ? `${s.NumberOfDaysSinceLastDeath} days` : null],
        ["Objects", r.uobjects ? `${fmtNum(r.uobjects.count)} of ${fmtNum(r.uobjects.capacity)} (${fmtPct(100 * r.uobjects.count / r.uobjects.capacity)})` : null],
        ["Game options", s.NodeRando ? `nodes ${s.NodeRando} · purity ${s.NodePurity} · elevator ×${s.SpaceElevatorCost} · recipes ×${s.RecipeCost} · power ×${s.PowerCost}` : null],
      ]),
      el("h3", { text: "Players" }), r.players.length ? table(r.players, playerCols, { initialSort: { key: "name", dir: 1 } }) : el("p", { class: "muted small", text: "none" }),
      el("h3", { text: `Power switches (${r.switches.length})` }), r.switches.length ? table(r.switches, switchCols, { initialSort: { key: "name", dir: 1 } }) : el("p", { class: "muted small", text: "none" }),
      el("h3", { text: "Chat" }), r.chat.length ? table(r.chat, chatCols, { initialSort: { key: "time", dir: -1 } }) : el("p", { class: "muted small", text: "no messages" }));
  });
  grid.append(game.card);
}

const RENDER = { overview: tabOverview, power: tabPower, emergency: tabEmergency, trains: tabTrains, production: tabProduction, sites: tabSites, gens: tabGens, depot: tabDepot, sinks: tabSinks, admin: tabAdmin };

let renderSeq = 0;
async function renderTab() {
  const seq = ++renderSeq;
  const main = $("#main");
  main.classList.add("faded");
  destroyCharts();
  const next = el("div");
  try {
    await RENDER[state.tab]?.(next);
    if (seq !== renderSeq) return;
    main.replaceChildren(...next.childNodes);
  } catch (e) {
    if (e instanceof LoginRequired) { showLogin(); return; }
    console.error(e);
    main.replaceChildren(el("div", { class: "empty error", text: `Failed to load: ${e.message}` }));
  } finally {
    main.classList.remove("faded");
  }
}

// ---------------------------------------------------------------- loading

async function refreshStatus() {
  try { state.status = await api("/api/status"); } catch (e) { if (e instanceof LoginRequired) return showLogin(); state.status = { reachable: false, error: e.message, sampler: {} }; }
  renderStatus();
}

async function refreshAll() {
  $("#refresh").disabled = true;
  try {
    const [status, latest] = await Promise.all([api("/api/status").catch((e) => { if (e instanceof LoginRequired) throw e; return { reachable: false, error: e.message, sampler: {} }; }), api("/api/latest")]);
    state.status = status; state.latest = latest;
    renderStatus();
    await renderTab();
  } catch (e) {
    if (e instanceof LoginRequired) showLogin(); else $("#main").replaceChildren(el("div", { class: "empty error", text: `Failed to load: ${e.message}` }));
  } finally { $("#refresh").disabled = false; }
}

// ---------------------------------------------------------------- auth

// The <hanko-auth> element starts WebAuthn conditional mediation (the browser's passkey
// autofill prompt) the moment it exists, even inside a hidden overlay. So it is only created
// when a login is actually needed and removed again once the session is good; a page refresh
// with a valid cookie never instantiates it and never asks for the passkey.
function showLogin() {
  const mount = $("#hanko-mount");
  if (!mount.querySelector("hanko-auth")) mount.replaceChildren(el("hanko-auth"));
  $("#login").hidden = false; $("#logout").hidden = true;
}
function hideLogin() { $("#hanko-mount").replaceChildren(); $("#login").hidden = true; $("#logout").hidden = false; }

async function bootAuth() {
  const { hanko_api } = await api("/config");
  const { hanko } = await register(hanko_api, { cookieSameSite: "lax" });
  state.hanko = hanko;
  hanko.onSessionCreated(() => { hideLogin(); refreshAll(); });
  hanko.onSessionExpired(() => showLogin());
  hanko.onUserLoggedOut(() => showLogin());
  $("#logout").addEventListener("click", async () => { try { await hanko.logout(); } catch {} showLogin(); });
  try { await api("/api/me"); hideLogin(); return true; }
  catch (e) {
    if (e instanceof LoginRequired) { showLogin(); return false; }
    // 403: signed in to Hanko, but not on the allow-list.
    showLogin(); const err = $("#login-error"); err.textContent = e.message; err.hidden = false; return false;
  }
}

// ---------------------------------------------------------------- main

$("#tz").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.tz = b.dataset.tz; store("tz", state.tz); renderControls(); renderStatus(); renderTab(); });
$("#refresh").addEventListener("click", refreshAll);
renderControls();
renderStatus();
if (await bootAuth()) await refreshAll();
setInterval(() => { if ($("#login").hidden) refreshStatus(); }, 60_000);
