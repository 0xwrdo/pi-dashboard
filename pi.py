#!/usr/bin/env python3
"""pi: web dashboard for a Raspberry Pi 5. Standard library only.

Runs as root (sysfs writes), listens on localhost only. Put Nginx with auth in front.
Layout: /pi/pi.py, /pi/static/*, saved state in /var/lib/pi/state.json
"""
import collections, concurrent.futures as cf, glob, json, os, signal, subprocess, threading, time, pwd
import urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = "/var/lib/pi/state.json"
HOST, PORT = "127.0.0.1", 8090
SAFE_LIMIT_C = 80.0  # in manual mode, hand the fan back to the kernel above this
ZONE = "/sys/class/thermal/thermal_zone0"
CPUFREQ = "/sys/devices/system/cpu/cpu0/cpufreq"
SITES = [  # (label, hostname Nginx answers to)
    ("Portfolio", "raunakkushwaha.tech"),
    ("Guide", "guide.raunakkushwaha.me"),
    ("Spices PnC", "spicespnc.raunakkushwaha.me"),
    ("Pizza demo", "pizza.raunakkushwaha.me"),
    ("Ankit", "ankitaadarsh.me"),
]
SERVICES = ["nginx", "cloudflared", "pi"]
PROFILES = {"quiet": ("powersave", None), "balanced": ("ondemand", None), "turbo": ("performance", 50)}
STATIC = {"/": ("index.html", "text/html"), "/app.css": ("app.css", "text/css"),
          "/app.js": ("app.js", "text/javascript"),
          "/perf.js": ("perf.js", "text/javascript")}

lock = threading.Lock()
state = {"mode": "auto", "percent": 0, "notice": "", "profile": "balanced"}
live = {"cpu": 0.0, "throttle": [], "hist": collections.deque(maxlen=150)}
site_cache = {"at": 0, "data": None}


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def write(path, value):
    with open(path, "w") as f:
        f.write(str(value))


FAN = next((d for d in glob.glob("/sys/class/hwmon/hwmon*") if read(d + "/name") == "pwmfan"), None)


def temperature():
    raw = read(ZONE + "/temp")
    return int(raw) / 1000 if raw else None


def cpu_times():
    v = list(map(int, read("/proc/stat").split("\n")[0].split()[1:]))
    return v[3] + v[4], sum(v)  # idle+iowait, total


def memory():
    m = {l.split(":")[0]: int(l.split()[1]) for l in read("/proc/meminfo", "").split("\n") if l}
    return m.get("MemTotal", 0) * 1024, (m.get("MemTotal", 0) - m.get("MemAvailable", 0)) * 1024


def throttle_flags():
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=2).stdout
        bits = int(out.split("=")[1], 16)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    names = {0: "Undervoltage now", 1: "Clock capped now", 2: "Throttled now", 3: "Temperature limit now",
             16: "Undervoltage since boot", 18: "Throttled since boot"}
    return [n for b, n in names.items() if bits >> b & 1]


def set_auto(notice=""):
    # The kernel only changes the fan when the temperature crosses a step, so start it at the right speed first.
    t = temperature() or 0
    write(FAN + "/pwm1_enable", 1)
    write(FAN + "/pwm1", 255 if t >= 75 else 178 if t >= 67.5 else 128 if t >= 60 else 77 if t >= 50 else 0)
    write(FAN + "/pwm1_enable", 2)  # 2 = kernel thermal control
    state.update(mode="auto", notice=notice)


def set_manual(percent):
    percent = max(0, min(100, int(percent)))
    write(FAN + "/pwm1_enable", 1)  # 1 = manual
    write(FAN + "/pwm1", round(percent * 255 / 100))
    state.update(mode="manual", percent=percent, notice="")


def governor_for(name):
    avail = (read(CPUFREQ + "/scaling_available_governors") or "").split()
    want = PROFILES[name][0]
    return want if want in avail else ("schedutil" if "schedutil" in avail else None)


def set_profile(name):
    gov, fan = PROFILES[name]
    gov = governor_for(name)
    if gov:
        for p in glob.glob("/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_governor"):
            write(p, gov)
    if FAN:
        set_manual(fan) if fan else set_auto()
    state["profile"] = name
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    write(STATE_FILE, json.dumps({"profile": name}))


def sampler():
    idle0, total0 = cpu_times()
    n = 0
    while True:
        time.sleep(2)
        idle1, total1 = cpu_times()
        with lock:
            live["cpu"] = round(100 * (1 - (idle1 - idle0) / max(1, total1 - total0)), 1)
            t = temperature()
            if t is not None:
                live["hist"].append(round(t, 1))
            n += 1
            if n % 5 == 1:
                live["throttle"] = throttle_flags()
            if FAN and state["mode"] == "manual":
                try:
                    if t is not None and t >= SAFE_LIMIT_C:
                        set_auto("Reached %d °C, so the fan is back on automatic." % SAFE_LIMIT_C)
                    else:  # re-apply in case the kernel changed the speed
                        write(FAN + "/pwm1", round(state["percent"] * 255 / 100))
                except OSError:
                    pass
            elif FAN and state["mode"] == "auto" and t is not None and t >= 60 and read(FAN + "/fan1_input") == "0":
                try:
                    set_auto(state["notice"])  # fan stopped while hot: restart it
                except OSError:
                    pass
        idle0, total0 = idle1, total1


def snapshot():
    total, used = memory()
    pwm = read(FAN + "/pwm1") if FAN else None
    rpm = read(FAN + "/fan1_input") if FAN else None
    freq = read(CPUFREQ + "/scaling_cur_freq")
    with lock:
        return {
            "temp": temperature(), "cpu": live["cpu"], "load": os.getloadavg()[0],
            "mem_total": total, "mem_used": used,
            "mhz": int(freq) // 1000 if freq else None,
            "uptime": int(float(read("/proc/uptime", "0").split()[0])),
            "rpm": int(rpm) if rpm else None,
            "percent": round(int(pwm) / 255 * 100) if pwm else None,
            "mode": state["mode"], "notice": state["notice"], "profile": state["profile"],
            "fan_found": FAN is not None, "limit": SAFE_LIMIT_C,
            "throttle": live["throttle"], "hist": list(live["hist"]),
        }


PAGE_SIZE, CLK, NCPU = os.sysconf("SC_PAGE_SIZE"), os.sysconf("SC_CLK_TCK"), os.cpu_count() or 1
perf = {k: collections.deque(maxlen=150) for k in ("cpu", "mem", "dr", "dw", "rx", "tx")}
perf_now = {"cores": []}
prev_procs = {"t": 0, "ticks": {}}
DISK = next((d for d in ("nvme0n1", "mmcblk0", "sda") if os.path.exists("/sys/block/" + d)), None)


def counters():
    cores = []
    for l in read("/proc/stat").split("\n"):
        if l.startswith("cpu") and l[3].isdigit():
            v = list(map(int, l.split()[1:]))
            cores.append((v[3] + v[4], sum(v)))
    dr = dw = rx = tx = 0
    for l in read("/proc/diskstats", "").split("\n"):
        f = l.split()
        if DISK and len(f) > 9 and f[2] == DISK:
            dr, dw = int(f[5]) * 512, int(f[9]) * 512
    for l in read("/proc/net/dev", "").split("\n")[2:]:
        if ":" in l and l.split(":")[0].strip() != "lo":
            v = l.split(":")[1].split()
            rx, tx = rx + int(v[0]), tx + int(v[8])
    return cores, dr, dw, rx, tx


def perf_sampler():
    prev, t0 = counters(), time.time()
    while True:
        time.sleep(2)
        cur, now = counters(), time.time()
        cores = [round(100 * (1 - (c[0] - p[0]) / max(1, c[1] - p[1])), 1) for c, p in zip(cur[0], prev[0])]
        total, used = memory()
        with lock:
            perf["cpu"].append(round(sum(cores) / max(1, len(cores)), 1))
            perf["mem"].append(round(100 * used / max(1, total), 1))
            for k, i in (("dr", 1), ("dw", 2), ("rx", 3), ("tx", 4)):
                perf[k].append(round(max(0, cur[i] - prev[i]) / (now - t0)))
            perf_now["cores"] = cores
        prev, t0 = cur, now


def perf_snapshot():
    m = {l.split(":")[0]: int(l.split()[1]) * 1024 for l in read("/proc/meminfo", "").split("\n") if l}
    with lock:
        return {"hist": {k: list(v) for k, v in perf.items()}, "cores": perf_now["cores"], "disk": DISK,
                "load": os.getloadavg(),
                "mem": {"total": m.get("MemTotal", 0), "avail": m.get("MemAvailable", 0), "cached": m.get("Cached", 0),
                        "swap_total": m.get("SwapTotal", 0), "swap_free": m.get("SwapFree", 0)}}


def procs():
    now = time.time()
    dt, cur, rows = max(0.5, now - prev_procs["t"]), {}, []
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            st = read("/proc/%s/stat" % p)
            rp = st.rindex(")")
            f = st[rp + 2:].split()
            ticks = int(f[11]) + int(f[12])
            cur[p] = ticks
            uid = os.stat("/proc/" + p).st_uid
            try:
                user = pwd.getpwuid(uid).pw_name
            except KeyError:
                user = str(uid)
            cpu = (ticks - prev_procs["ticks"].get(p, ticks)) / CLK / dt * 100 / NCPU
            rows.append({"pid": int(p), "name": st[st.index("(") + 1:rp], "user": user,
                         "cpu": round(cpu, 1), "mem": int(f[21]) * PAGE_SIZE})
        except (OSError, ValueError, IndexError, AttributeError):
            continue
    prev_procs.update(t=now, ticks=cur)
    return rows


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def check_site(site):
    label, host = site
    start = time.time()
    try:
        req = urllib.request.Request("http://127.0.0.1/", headers={"Host": host})
        with OPENER.open(req, timeout=3) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except OSError:
        return {"name": label, "host": host, "up": False, "code": None, "ms": None}
    return {"name": label, "host": host, "up": code < 500, "code": code, "ms": round((time.time() - start) * 1000)}


def service_state(name):
    out = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True).stdout.strip()
    return {"name": name, "up": out == "active", "state": out or "unknown"}


def sites():
    if time.time() - site_cache["at"] > 10:  # keep repeated refreshes cheap
        with cf.ThreadPoolExecutor(8) as ex:
            data = {"sites": list(ex.map(check_site, SITES)), "services": list(ex.map(service_state, SERVICES))}
        site_cache.update(at=time.time(), data=data)
    return site_cache["data"]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/status":
            self._send(200, json.dumps(snapshot()))
        elif self.path == "/api/sites":
            self._send(200, json.dumps(sites()))
        elif self.path == "/api/perf":
            self._send(200, json.dumps(perf_snapshot()))
        elif self.path == "/api/procs":
            self._send(200, json.dumps(procs()))
        elif self.path in STATIC:
            name, ctype = STATIC[self.path]
            with open(os.path.join(BASE, "static", name), "rb") as f:
                self._send(200, f.read(), ctype)
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path not in ("/api/fan", "/api/profile"):
            return self._send(404, "not found", "text/plain")
        try:
            size = min(int(self.headers.get("Content-Length", 0)), 4096)
            body = json.loads(self.rfile.read(size) or b"{}")
            with lock:
                if self.path == "/api/profile":
                    if body.get("name") not in PROFILES:
                        return self._send(400, "unknown profile", "text/plain")
                    set_profile(body["name"])
                elif FAN is None:
                    return self._send(503, "no PWM fan found", "text/plain")
                elif body.get("mode") == "auto":
                    set_auto()
                elif body.get("mode") == "manual":
                    set_manual(body.get("percent", 0))
                else:
                    return self._send(400, "mode must be auto or manual", "text/plain")
            self._send(200, json.dumps({"ok": True}))
        except (ValueError, OSError) as e:
            self._send(500, str(e), "text/plain")

    def log_message(self, *args):
        pass


def main():
    signal.signal(signal.SIGTERM, lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))
    saved = json.loads(read(STATE_FILE, "{}") or "{}").get("profile")
    if saved in PROFILES:
        with lock:
            set_profile(saved)
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=perf_sampler, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with lock:
            if FAN:
                set_auto()  # always leave the fan under kernel control


if __name__ == "__main__":
    main()
