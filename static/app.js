const $ = id => document.getElementById(id);
const NOTES = {
  quiet: "Lowest clock speed, fan on automatic. Best when the Pi is mostly idle.",
  balanced: "Clock scales with load, fan on automatic. The default.",
  turbo: "Full clock speed and the fan held at 50%. Use it for heavy jobs.",
};
const TABS = ["dashboard", "performance", "processes", "sites"];
let dragging = false, tab = "dashboard";

async function api(url, body) {
  const r = await fetch(url, body && {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function say(msg) { $("notice").hidden = !msg; $("notice").textContent = msg || ""; }

async function send(el, body, url = "api/fan") {
  el.disabled = true; el.setAttribute("aria-busy", "true");
  try { await api(url, body); say(""); await poll(); }
  catch (e) { say("Could not apply the change: " + e.message); }
  finally { el.disabled = false; el.removeAttribute("aria-busy"); }
}

const gb = n => (n / 1073741824).toFixed(1);
function uptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m";
}

const niceStep = (range, n) => {
  const raw = (range || 1) / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const fact = (a, b) => {
  const w = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
  dt.textContent = a; dd.textContent = b; w.append(dt, dd); return w;
};

// Time-series chart drawn at the element's real pixel size, so text stays sharp at any screen size.
// series: [{vals, label}], one sample per 2 s, newest on the right, 5-minute window. Hover or touch for values.
function makeChart(svg) {
  const SPAN = 150, EVERY = 2;
  let args = null, hover = null;

  function render() {
    if (!args) return;
    const w = svg.clientWidth, h = svg.clientHeight;
    if (w < 120 || h < 100) return;
    const [series, o] = args, fmt = o.fmt || (v => v), fmtv = o.fmtv || fmt, wide = w >= 520;
    const all = series.flatMap(s => s.vals);
    let lo, hi;
    if (o.lo != null) { lo = o.lo; hi = o.hi; }
    else {
      const mn = all.length ? Math.min(...all) : 0, mx = all.length ? Math.max(...all) : 0;
      if (o.zero) { lo = 0; hi = Math.max(o.min || 1, mx) * 1.15; }
      else { const half = Math.max(mx - mn, o.minSpan || 10) * 0.65, c = (mn + mx) / 2; lo = c - half; hi = c + half; }
      const st = niceStep(hi - lo, 4);
      lo = Math.floor(lo / st) * st; hi = Math.ceil(hi / st) * st;
    }
    if (hi <= lo) hi = lo + 1;
    const yt = [], ys = niceStep(hi - lo, h < 240 ? 3 : 5);
    for (let k = Math.ceil(lo / ys - 1e-9); k * ys <= hi + 1e-9; k++) yt.push(+(k * ys).toFixed(6));
    const lw = Math.max(...yt.map(v => String(fmt(v)).length)) * 6.4;
    const ml = Math.ceil(lw) + 16 + (wide && o.yTitle ? 16 : 0), mr = 16, mt = 16, mb = wide ? 44 : 28;
    const pw = w - ml - mr, ph = h - mt - mb;
    if (pw < 60 || ph < 40) return;
    const sx = pw / SPAN, X = (i, n) => ml + pw - (n - 1 - i) * sx;
    const Y = v => mt + ph - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * ph;
    let g = "";

    for (const v of yt) {
      const y = Y(v).toFixed(1);
      g += `<line class="grid" x1="${ml}" x2="${ml + pw}" y1="${y}" y2="${y}"/><text class="tick" x="${ml - 8}" y="${+y + 4}" text-anchor="end">${fmt(v)}</text>`;
    }
    for (let k = 0; k <= 5; k++) {
      if (pw < 420 && k % 2) continue;
      const x = (ml + pw - k * 60 / EVERY * sx).toFixed(1);
      g += `<line class="grid v" x1="${x}" x2="${x}" y1="${mt}" y2="${mt + ph}"/><text class="tick" x="${x}" y="${mt + ph + 16}" text-anchor="${k === 5 ? "start" : "middle"}">${k ? "-" + k + "m" : "now"}</text>`;
    }
    if (wide) {
      if (o.yTitle) g += `<text class="axt" transform="translate(12 ${mt + ph / 2}) rotate(-90)" text-anchor="middle">${o.yTitle}</text>`;
      g += `<text class="axt" x="${ml + pw / 2}" y="${h - 6}" text-anchor="middle">Time (minutes ago)</text>`;
    }
    if (o.limit && o.limit.v > lo && o.limit.v < hi) {
      const y = Y(o.limit.v).toFixed(1);
      g += `<line class="limit" x1="${ml}" x2="${ml + pw}" y1="${y}" y2="${y}"/><text class="tick warn" x="${ml + pw - 6}" y="${y - 6}" text-anchor="end">${o.limit.label}</text>`;
    }
    series.forEach((s, j) => {
      const n = s.vals.length; if (n < 2) return;
      const pts = s.vals.map((v, i) => X(i, n).toFixed(1) + "," + Y(v).toFixed(1));
      if (o.area && j === 0) g += `<polygon class="area" points="${X(0, n).toFixed(1)},${mt + ph} ${pts.join(" ")} ${X(n - 1, n).toFixed(1)},${mt + ph}"/>`;
      g += `<polyline class="ln s${j}" points="${pts.join(" ")}"/>`;
    });

    const n = Math.max(0, ...series.map(s => s.vals.length));
    const back = hover == null ? -1 : Math.round((ml + pw - hover) / sx);
    if (back >= 0 && back < n) {
      const x = (ml + pw - back * sx).toFixed(1), secs = back * EVERY;
      const txt = [secs ? "-" + (secs >= 60 ? Math.floor(secs / 60) + "m " + secs % 60 + "s" : secs + "s") : "now"];
      g += `<line class="cross" x1="${x}" x2="${x}" y1="${mt}" y2="${mt + ph}"/>`;
      series.forEach((s, j) => {
        const v = s.vals[s.vals.length - 1 - back]; if (v == null) return;
        g += `<circle class="dot s${j}" cx="${x}" cy="${Y(v).toFixed(1)}" r="4"/>`;
        txt.push((s.label ? s.label + ": " : "") + fmtv(v));
      });
      const tw = Math.max(...txt.map(t => t.length)) * 6.8 + 16, th = txt.length * 16 + 10;
      let tx = +x + 12; if (tx + tw > w - 4) tx = +x - 12 - tw; tx = Math.max(ml + 4, tx);
      g += `<rect class="tip" x="${tx}" y="${mt + 6}" width="${tw}" height="${th}" rx="6"/>` +
        txt.map((t, k) => `<text class="tipt" x="${tx + 8}" y="${mt + 23 + k * 16}">${t}</text>`).join("");
    }
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.innerHTML = g;
  }

  const at = e => { hover = e.clientX - svg.getBoundingClientRect().left; render(); };
  const off = () => { hover = null; render(); };
  svg.addEventListener("pointermove", at); svg.addEventListener("pointerdown", at);
  svg.addEventListener("pointerleave", off); svg.addEventListener("pointercancel", off);
  new ResizeObserver(render).observe(svg);
  return {draw(series, o) { args = [series, o || {}]; render(); }};
}
const tempChart = makeChart($("chart"));

function render(s) {
  $("temp").textContent = s.temp == null ? "–" : s.temp.toFixed(1) + " °C";
  $("cpu").textContent = s.cpu.toFixed(0) + "%";
  $("mem").textContent = gb(s.mem_used) + " / " + gb(s.mem_total) + " GB";
  $("mhz").textContent = s.mhz == null ? "–" : (s.mhz / 1000).toFixed(2) + " GHz";
  $("uptime").textContent = uptime(s.uptime);
  tempChart.draw([{vals: s.hist, label: "Temp"}], {area: true, minSpan: 10, yTitle: "Temperature (°C)",
    fmt: t => (Number.isInteger(t) ? t : t.toFixed(1)) + "°", fmtv: t => t.toFixed(1) + " °C",
    limit: {v: s.limit, label: "Fan returns to automatic at " + s.limit + " °C"}});
  if (s.hist.length) {
    const hh = s.hist, f = t => t.toFixed(1) + " °C";
    $("t-facts").replaceChildren(fact("Now", f(hh[hh.length - 1])), fact("Average", f(hh.reduce((a, b) => a + b, 0) / hh.length)),
      fact("Lowest", f(Math.min(...hh))), fact("Highest", f(Math.max(...hh))));
  }

  document.querySelectorAll("#profiles button").forEach(b => b.setAttribute("aria-pressed", b.dataset.p === s.profile));
  $("profile-note").textContent = NOTES[s.profile] || "";

  $("m-auto").setAttribute("aria-pressed", s.mode === "auto");
  $("m-manual").setAttribute("aria-pressed", s.mode === "manual");
  $("slider").disabled = s.mode === "auto" || !s.fan_found;
  if (!dragging && s.percent != null) { $("slider").value = s.percent; $("pct").textContent = s.percent + "%"; }
  $("rpm").textContent = s.rpm == null ? "Fan speed unavailable." : s.rpm + " RPM";
  if (s.notice) say(s.notice);
  $("limit").textContent = s.fan_found
    ? "In manual mode the fan returns to automatic at " + s.limit + " °C."
    : "No PWM fan found. Check that the fan is plugged into the FAN header.";
  $("health").textContent = s.throttle == null ? "Throttling status is not available on this system."
    : s.throttle.length ? s.throttle.join(", ") + "." : "No undervoltage or throttling.";
}

function row(name, detail, up, label) {
  const li = document.createElement("li"), a = document.createElement("div"), b = document.createElement("span");
  a.textContent = name;
  if (detail) { const sm = document.createElement("small"); sm.textContent = detail; a.append(sm); }
  b.className = "state" + (up ? "" : " down"); b.textContent = label;
  li.append(a, b); return li;
}

function renderSites(d) {
  $("site-list").replaceChildren(...d.sites.map(s =>
    row(s.name, s.host, s.up, s.up ? "Up, " + s.ms + " ms" : s.code ? "Error " + s.code : "No response")));
  $("service-list").replaceChildren(...d.services.map(s => row(s.name, "", s.up, s.up ? "Running" : s.state)));
}

async function poll() {
  try {
    if (tab === "dashboard") render(await api("api/status"));
    else if (tab === "sites") renderSites(await api("api/sites"));
    else if (tab === "performance") await perfPoll();
    else await procPoll();
  } catch (e) { if (tab === "dashboard") say("Lost contact with the Pi: " + e.message); }
}

function show(name) {
  tab = name;
  for (const t of TABS) {
    $(t).hidden = t !== name;
    $("t-" + t).setAttribute("aria-selected", t === name);
  }
  poll();
}

$("t-dashboard").onclick = () => show("dashboard");
$("t-sites").onclick = () => show("sites");
document.querySelectorAll("#profiles button").forEach(b => b.onclick = () => send(b, {name: b.dataset.p}, "api/profile"));
$("m-auto").onclick = e => send(e.currentTarget, {mode: "auto"});
$("m-manual").onclick = e => send(e.currentTarget, {mode: "manual", percent: +$("slider").value});
$("slider").oninput = e => { dragging = true; $("pct").textContent = e.target.value + "%"; };
$("slider").onchange = async e => { await send(e.target, {mode: "manual", percent: +e.target.value}); dragging = false; };

poll();
setInterval(() => { if (tab === "dashboard") poll(); }, 2000);
setInterval(() => { if (tab === "sites") poll(); }, 10000);
