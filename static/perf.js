const bps = v => v >= 1048576 ? (v / 1048576).toFixed(1) + " MB/s" : v >= 1024 ? (v / 1024).toFixed(0) + " KB/s" : v + " B/s";
const size = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : (n / 1048576).toFixed(0) + " MB";
const pct = v => v.toFixed(0) + "%";
const last = a => a.length ? a[a.length - 1] : 0;
const RES = {
  cpu: {name: "CPU", keys: ["cpu"], max: 100, fmt: pct, labels: ["Utilization"]},
  mem: {name: "Memory", keys: ["mem"], max: 100, fmt: pct, labels: ["In use"]},
  disk: {name: "Disk", keys: ["dr", "dw"], fmt: bps, labels: ["Read", "Write"]},
  net: {name: "Network", keys: ["rx", "tx"], fmt: bps, labels: ["Download", "Upload"]},
};
let sel = "cpu", P = null, built = false;
const perfChart = makeChart($("d-chart"));

function draw(svg, lists, H, max) {
  const m = max || Math.max(10240, ...lists.flat()) * 1.1, step = 600 / 149;
  svg.innerHTML = lists.map((l, i) => {
    const off = (150 - l.length) * step;
    const pts = l.map((v, j) => (off + j * step).toFixed(1) + "," + (H - v / m * H).toFixed(1)).join(" ");
    return l.length > 1 ? '<polyline class="line s' + i + '" points="' + pts + '"/>' : "";
  }).join("");
  return m;
}

function build() {
  $("res").replaceChildren(...Object.entries(RES).map(([k, r]) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.id = "r-" + k; b.setAttribute("aria-pressed", k === sel);
    b.innerHTML = r.name + "<small></small><svg viewBox=\"0 0 600 32\" preserveAspectRatio=\"none\" aria-hidden=\"true\"></svg>";
    b.onclick = () => { sel = k; renderPerf(); };
    li.append(b); return li;
  }));
  built = true;
}

function facts(k) {
  const m = P.mem, h = P.hist;
  if (k === "cpu") return [["Utilization", pct(last(h.cpu))], ["Load average", P.load.map(x => x.toFixed(2)).join("  ")], ["Cores", P.cores.length]];
  if (k === "mem") return [["In use", size(m.total - m.avail)], ["Available", size(m.avail)], ["Cached", size(m.cached)],
    ["Total", size(m.total)], ["Swap used", size(m.swap_total - m.swap_free) + " of " + size(m.swap_total)]];
  if (k === "disk") return [["Device", P.disk || "not found"], ["Read", bps(last(h.dr))], ["Write", bps(last(h.dw))]];
  return [["Download", bps(last(h.rx))], ["Upload", bps(last(h.tx))]];
}

function renderPerf() {
  if (!built) build();
  const h = P.hist, r = RES[sel];
  for (const [k, x] of Object.entries(RES)) {
    const b = $("r-" + k);
    b.setAttribute("aria-pressed", k === sel);
    b.querySelector("small").textContent = x.keys.map(key => x.fmt(last(h[key]))).join(" / ");
    draw(b.querySelector("svg"), x.keys.map(key => h[key]), 32, x.max);
  }
  $("d-title").textContent = r.name;
  perfChart.draw(r.keys.map((key, i) => ({vals: h[key], label: r.labels[i]})),
    r.max ? {lo: 0, hi: r.max, fmt: pct, yTitle: r.name + " (%)"} : {zero: true, min: 10240, fmt: bps, yTitle: r.name + " (per second)"});
  $("d-scale").textContent = r.keys.length > 1 ? "Blue is " + r.labels[0].toLowerCase() + ", orange is " + r.labels[1].toLowerCase() + "." : "";
  $("d-scale").hidden = !$("d-scale").textContent;
  $("d-facts").replaceChildren(...facts(sel).flatMap(([a, b]) => {
    const dt = document.createElement("dt"), dd = document.createElement("dd"), w = document.createElement("div");
    dt.textContent = a; dd.textContent = b; w.append(dt, dd); return [w];
  }));
  $("cores").replaceChildren(...(sel === "cpu" ? P.cores.map((c, i) => {
    const d = document.createElement("div");
    d.innerHTML = "<span><span>Core " + i + "</span><span>" + pct(c) + "</span></span><i><b style=\"width:" + c + "%\"></b></i>";
    return d;
  }) : []));
}

async function perfPoll() { P = await api("api/perf"); renderPerf(); }

let rows = [], sortK = "cpu", sortDir = -1;
function drawProcs() {
  const q = $("q").value.toLowerCase();
  const list = rows.filter(x => !q || x.name.toLowerCase().includes(q) || x.user.toLowerCase().includes(q))
    .sort((a, b) => (typeof a[sortK] === "string" ? a[sortK].localeCompare(b[sortK]) : a[sortK] - b[sortK]) * sortDir).slice(0, 60);
  $("pbody").replaceChildren(...list.map(x => {
    const tr = document.createElement("tr");
    [[x.name], [x.user], [x.cpu.toFixed(1) + "%", 1], [size(x.mem), 1], [x.pid, 1]].forEach(([v, n]) => {
      const td = document.createElement("td"); td.textContent = v; if (n) td.className = "n"; tr.append(td);
    });
    return tr;
  }));
}
async function procPoll() { rows = await api("api/procs"); drawProcs(); }

document.querySelectorAll("th button").forEach(b => b.onclick = () => {
  sortDir = sortK === b.dataset.k ? -sortDir : (b.dataset.k === "name" || b.dataset.k === "user" ? 1 : -1);
  sortK = b.dataset.k;
  document.querySelectorAll("th").forEach(th => th.setAttribute("aria-sort", "none"));
  b.parentElement.setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
  drawProcs();
});
$("q").oninput = drawProcs;
$("t-performance").onclick = () => show("performance");
$("t-processes").onclick = () => show("processes");
setInterval(() => { if (tab === "performance" || tab === "processes") poll(); }, 2000);
