/* Aeronex live layer
   1. ESP32 hardware readings over USB (Web Serial). Always visible: panel + sticky dock, and kept in localStorage.
   2. Open-Meteo air quality + weather as a clearly labelled reference feed (no API key).
   3. Leaflet map of Hyderabad zones plus the hardware node (offline SVG fallback if Leaflet can't load). */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const AX = (window.Aeronex = window.Aeronex || {});

  /* ---------- config ---------- */
  const NODE = { id: "ZONE_HITEC_01", lat: 17.4485, lon: 78.3832 };
  const ZONES = [
    { name: "HITEC City - Madhapur", lat: 17.4435, lon: 78.3772 },
    { name: "Gachibowli - Financial District", lat: 17.4401, lon: 78.3489 },
    { name: "Kukatpally - KPHB", lat: 17.4948, lon: 78.3996 },
    { name: "Secunderabad", lat: 17.4399, lon: 78.4983 },
    { name: "Banjara Hills - Jubilee Hills", lat: 17.4126, lon: 78.4482 },
    { name: "Charminar - Old City", lat: 17.3616, lon: 78.4747 },
  ];
  const WARM_MS = 120000;                     // MQ heaters: treat first 2 min of board uptime as warm-up
  const KEY = "aeronex.hw.v1";
  const HEADER = ["timestamp_ms", "mq135_raw_adc", "mq2_raw_adc", "mq9_raw_adc", "dht11_temperature_c", "dht11_humidity_percent", "bmp180_temperature_c", "pressure_hpa", "altitude_m"];
  // row = [receivedAt, ms, mq135, mq2, mq9, temp, hum, bmpT, pressure, altitude]; f.i is the CSV index (1..8) so row index = f.i + 1
  const FIELDS = [
    { k: "mq135", i: 1, n: "MQ-135 air quality", u: "ADC", d: 0, gas: 1, s: "MQ-135" },
    { k: "mq2", i: 2, n: "MQ-2 smoke / LPG", u: "ADC", d: 0, gas: 1, s: "MQ-2" },
    { k: "mq9", i: 3, n: "MQ-9 CO / methane", u: "ADC", d: 0, gas: 1, s: "MQ-9" },
    { k: "temp", i: 4, n: "DHT11 temperature", u: "°C", d: 1, s: "Temp" },
    { k: "hum", i: 5, n: "DHT11 humidity", u: "%", d: 0, s: "RH" },
    { k: "bmpt", i: 6, n: "BMP temperature", u: "°C", d: 1, s: "BMP" },
    { k: "pres", i: 7, n: "Pressure", u: "hPa", d: 1, s: "Press" },
    { k: "alt", i: 8, n: "Altitude (from pressure)", u: "m", d: 0, s: "Alt" },
  ];
  const GAS = FIELDS.filter((f) => f.gas);
  const HELP = {
    normal: "Normal: values only, no alerts.",
    warning: "Warning: banner and beep when a gas sensor reaches the alert level.",
    silent: "Silent: values only, alerts and sound muted.",
  };

  /* ---------- CPCB AQI from PM (reference feed only; never from MQ proxies) ---------- */
  const IL = [0, 50, 100, 200, 300, 400], IH = [50, 100, 200, 300, 400, 500];
  const LO25 = [0, 30, 60, 90, 120, 250], HI25 = [30, 60, 90, 120, 250, 380];
  const LO10 = [0, 50, 100, 250, 350, 430], HI10 = [50, 100, 250, 350, 430, 510];
  const sub = (v, LO, HI) => {
    if (v == null || Number.isNaN(v)) return null;
    v = Math.max(0, v);
    for (let i = 0; i < 6; i++) if (v <= HI[i]) return Math.round(IL[i] + ((IH[i] - IL[i]) * (v - LO[i])) / (HI[i] - LO[i]));
    return 500;
  };
  const CATS = [
    { max: 50, name: "Good", c: "#00b050" }, { max: 100, name: "Satisfactory", c: "#92d050" },
    { max: 200, name: "Moderate", c: "#ffc000" }, { max: 300, name: "Poor", c: "#ff7c00" },
    { max: 400, name: "Very Poor", c: "#ff0000" }, { max: 9999, name: "Severe", c: "#a00000" },
  ];
  const cpcb = (v) => CATS.find((x) => v <= x.max) || CATS[5];
  const WX = (c) => c === 0 ? "Clear" : c <= 3 ? "Partly cloudy" : c <= 48 ? "Fog" : c <= 57 ? "Drizzle" : c <= 67 ? "Rain" : c <= 77 ? "Snow" : c <= 82 ? "Showers" : c >= 95 ? "Thunderstorm" : "Cloudy";

  /* ---------- helpers ---------- */
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (x, d) => (x == null || Number.isNaN(x) ? "--" : Number(x).toFixed(d));
  const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + " s" : s < 5400 ? Math.round(s / 60) + " min" : Math.round(s / 3600) + " h"; };
  const clamp = (v) => Math.max(0, Math.min(4095, v));

  const getJson = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  const aqiFrom = (p25, p10) => (p25 == null && p10 == null ? null : Math.max(sub(p25, LO25, HI25) || 0, sub(p10, LO10, HI10) || 0));
  AX.util = { aqiFrom, cpcb, num, esc, WX, getJson, ZONES, NODE, sub };

  /* ---------- state (restored from the last session so readings never disappear) ---------- */
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { saved = {}; }
  let rows = Array.isArray(saved.rows) ? saved.rows : [];
  let mode = HELP[saved.mode] ? saved.mode : "normal";
  let portInfo = saved.portInfo || null;
  let port = null, reader = null, writer = null, connected = false, opening = false, keepReading = false, userClosed = false;
  let lastSave = 0, lastBeep = 0, audio = null, nSinceDraw = 0;
  const last = () => (rows.length ? rows[rows.length - 1] : null);
  const thresh = () => parseFloat($("#hwThresh").value) || 2500;

  /* ---------- build static pieces ---------- */
  $("#hwGrid").innerHTML = FIELDS.map((f) =>
    `<div class="hw-tile" id="ht_${f.k}"><div class="k">${f.n}</div><div class="v"><span id="hv_${f.k}">--</span> <small>${f.u}</small></div><div class="s" id="hs_${f.k}">${f.gas ? "smoothed (median of 5): --" : "&nbsp;"}</div></div>`).join("");
  $("#dockVals").innerHTML = FIELDS.filter((f) => f.k !== "bmpt" && f.k !== "alt").map((f) => `<span><b>${f.s}</b> <span id="dv_${f.k}">--</span><em>${f.u}</em></span>`).join("");
  if (saved.baud) $("#hwBaud").value = saved.baud;
  if (saved.thresh) $("#hwThresh").value = saved.thresh;

  const hasSerial = "serial" in navigator;
  if (!hasSerial) {
    $("#hwUnsupported").hidden = false;
    $("#hwConnect").disabled = true; $("#dockConnect").disabled = true;
  }

  function save(force) {
    if (!force && Date.now() - lastSave < 5000) return;
    lastSave = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify({ rows: rows.slice(-400), mode, baud: $("#hwBaud").value, thresh: $("#hwThresh").value, portInfo })); } catch { /* storage full or blocked */ }
  }
  addEventListener("beforeunload", () => save(true));

  /* ---------- connection status ---------- */
  function status() {
    const r = last(), a = r ? Date.now() - r[0] : null;
    if (connected) {
      if (a != null && a <= 10000) return { c: "live", t: "Live: ESP32 streaming over USB", s: "LIVE" };
      return { c: "stale", t: "Connected, waiting for data" + (a != null ? " (last reading " + ago(a) + " ago)" : ""), s: "NO DATA" };
    }
    return r ? { c: "off", t: "Board offline: showing stored reading from " + ago(a) + " ago", s: "STORED " + ago(a) } : { c: "off", t: "Not connected: no readings yet", s: "OFFLINE" };
  }
  const isLive = () => status().c === "live";
  const setMsg = (t) => { $("#hwMsg").textContent = t || ""; };

  function setControls() {
    $("#hwConnect").disabled = connected || !hasSerial; $("#dockConnect").disabled = connected || !hasSerial;
    $("#dockConnect").hidden = connected;
    $("#hwDisconnect").disabled = !connected; $("#hwBaud").disabled = connected;
    $$("[data-hwmode]").forEach((b) => (b.disabled = !connected));
  }

  /* ---------- open / read / close ---------- */
  async function openPort(p, silent) {
    if (opening || connected) return;
    opening = true; userClosed = false;
    const baud = parseInt($("#hwBaud").value, 10) || 115200;
    try {
      await p.open({ baudRate: baud });
      port = p; connected = true; keepReading = true;
      try { const i = p.getInfo(); portInfo = { usbVendorId: i.usbVendorId, usbProductId: i.usbProductId }; } catch { /* ignore */ }
      writer = p.writable.getWriter();
      setMsg(""); setControls(); renderAll(); save(true);
      readLoop();
    } catch (e) {
      if (!silent) setMsg(/open|busy|access|denied/i.test(e.message) ? "Could not open the port. Close the Arduino Serial Monitor and any Python script using it, then try again." : "Could not open the port: " + e.message);
    } finally { opening = false; }
  }
  async function connectClick() {
    if (!hasSerial) return;
    try { await openPort(await navigator.serial.requestPort(), false); }
    catch (e) { if (e.name !== "NotFoundError") setMsg("Port selection failed: " + e.message); }
  }
  async function autoConnect() {
    if (!hasSerial || connected || opening || userClosed) return;
    try {
      const ports = await navigator.serial.getPorts();
      if (!ports.length) return;
      const same = portInfo && ports.find((x) => { const i = x.getInfo(); return i.usbVendorId === portInfo.usbVendorId && i.usbProductId === portInfo.usbProductId; });
      await openPort(same || ports[0], true);
    } catch { /* ignore */ }
  }
  async function closePort() {
    userClosed = true; keepReading = false;
    try { if (reader) await reader.cancel(); } catch { /* ignore */ }
  }
  async function readLoop() {
    const dec = new TextDecoder(); let buf = "";
    while (port && port.readable && keepReading) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) { handleLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
          if (buf.length > 4000) buf = "";
        }
      } catch (e) { setMsg("Read error: " + e.message); }
      finally { reader.releaseLock(); reader = null; }
    }
    try { if (writer) { writer.releaseLock(); writer = null; } } catch { /* ignore */ }
    try { await port.close(); } catch { /* ignore */ }
    port = null; connected = false; setControls(); renderAll(); save(true);
    if (!userClosed) setTimeout(autoConnect, 3000);        // unplugged or reset: keep trying quietly
  }
  if (hasSerial) {
    navigator.serial.addEventListener("connect", () => setTimeout(autoConnect, 600));
    navigator.serial.addEventListener("disconnect", () => { keepReading = false; try { reader && reader.cancel(); } catch { /* ignore */ } setMsg("USB device unplugged. Showing the last stored reading."); });
  }

  function handleLine(line) {
    if (!line) return;
    const lg = $("#hwLog"); lg.textContent += line + "\n";
    if (lg.textContent.length > 12000) lg.textContent = lg.textContent.slice(-8000);
    lg.scrollTop = lg.scrollHeight;
    if (line.startsWith("CSV_DATA,")) {
      const v = line.slice(9).split(",");
      if (v.length !== HEADER.length) return;
      const n = v.map((x) => { const f = parseFloat(x); return x.trim() === "" || Number.isNaN(f) ? null : f; });
      rows.push([Date.now(), ...n]);
      if (rows.length > 20000) rows.splice(0, rows.length - 20000);
      save(false); nSinceDraw++;
      renderValues(); renderFlags(); renderStatus();
      if (nSinceDraw >= 3 || rows.length < 5) { nSinceDraw = 0; renderHeavy(); }
    } else if (line.startsWith("MODE_SET,")) {
      const m = line.split(",")[1]; if (HELP[m]) { mode = m; paintMode(); save(true); }
    }
  }

  /* ---------- modes ---------- */
  function paintMode() {
    $$("[data-hwmode]").forEach((b) => b.classList.toggle("on", b.dataset.hwmode === mode));
    $("#hwModeHelp").textContent = HELP[mode];
  }
  $$("[data-hwmode]").forEach((b) => b.addEventListener("click", async () => {
    if (!writer) { setMsg("Connect the USB port first."); return; }
    try { await writer.write(new TextEncoder().encode("MODE," + b.dataset.hwmode + "\n")); mode = b.dataset.hwmode; paintMode(); save(true); renderValues(); }
    catch (e) { setMsg("Could not send the mode: " + e.message); }
  }));
  function beep() {
    if (Date.now() - lastBeep < 3000) return; lastBeep = Date.now();
    try { audio = audio || new AudioContext(); const o = audio.createOscillator(); o.frequency.value = 880; o.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.25); } catch { /* ignore */ }
  }

  /* ---------- rendering: values, status, flags ---------- */
  function renderValues() {
    const r = last(), live = isLive(), th = thresh(), hot = [];
    FIELDS.forEach((f) => {
      const v = r ? r[f.i + 1] : null;
      $("#hv_" + f.k).textContent = num(v, f.d);
      if (f.gas) $("#hs_" + f.k).textContent = "smoothed (median of 5): " + num(med(rows.slice(-5).map((x) => x[f.i + 1])), 0);
      const over = live && mode === "warning" && f.gas && v != null && v >= th;
      $("#ht_" + f.k).classList.toggle("alarm", over);
      if (over) hot.push(f.s);
      const d = $("#dv_" + f.k); if (d) d.textContent = num(v, f.d);
    });
    const b = $("#hwBanner");
    if (hot.length) { b.style.display = "block"; b.textContent = "High gas reading: " + hot.join(", ") + " (alert level " + th + " ADC)"; beep(); } else b.style.display = "none";
    $("#hwDock").classList.toggle("alarm", hot.length > 0);
    updateMapHW();
  }
  function renderStatus() {
    const st = status();
    ["#hwState", "#dockState"].forEach((id) => { $(id).className = "hw-state " + st.c; });
    $("#hwStateTxt").textContent = st.t; $("#dockTxt").textContent = st.s;
    $("#hwCount").textContent = rows.length + " readings kept";
    $("#hwDownload").disabled = $("#hwClear").disabled = rows.length === 0;
  }
  function renderFlags() {
    const r = last(), fl = [];
    if (!r) fl.push(["warn", "No readings yet"]);
    else {
      const st = status();
      fl.push([st.c === "live" ? "ok" : st.c === "stale" ? "warn" : "bad", st.c === "live" ? "Fresh data" : st.c === "stale" ? "Stale data" : "Stored data, not live"]);
      if (r[1] != null && connected) fl.push(r[1] < WARM_MS ? ["warn", "MQ warm-up: " + Math.ceil((WARM_MS - r[1]) / 1000) + " s left"] : ["ok", "MQ warmed up"]);
      if ([2, 3, 4].some((c) => r[c] == null || r[c] <= 0 || r[c] >= 4095)) fl.push(["bad", "Gas ADC at 0 or 4095 (check wiring)"]);
      if (r[5] == null || r[6] == null) fl.push(["warn", "DHT11 reading missing"]);
      if (r[8] == null || r[8] < 300 || r[8] > 1100) fl.push(["warn", "BMP pressure implausible or missing"]);
      fl.push(["", "Raw values are never modified"]);
    }
    $("#hwFlags").innerHTML = fl.map(([c, t]) => `<span class="flag ${c}">${t}</span>`).join("");
  }

  /* ---------- gas-proxy outlook + source hint (PDF phase-1 methods; proxy indices only) ---------- */
  function trend(col) {
    const now = Date.now();
    const pts = rows.filter((r) => now - r[0] <= 30 * 60000 && r[1] != null && r[1] >= WARM_MS && r[col] != null);
    if (pts.length < 20) return { n: pts.length };
    const t1 = pts[pts.length - 1][0], span = (t1 - pts[0][0]) / 60000;
    if (span < 5) return { n: pts.length, span };
    const xs = pts.map((r) => (r[0] - t1) / 60000), ys = pts.map((r) => r[col]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
    const slope = sxx ? sxy / sxx : 0;
    return { n: pts.length, span, slope, cur: med(ys.slice(-5)) };
  }
  function renderForecast() {
    const el = $("#hwFc"); let ok = 0, maxN = 0, maxSpan = 0;
    if (!isLive()) { el.innerHTML = `<p class="hw-note">The outlook pauses while the board is offline, so it never projects from old data.</p>`; return; }
    const body = GAS.map((f) => {
      const t = trend(f.i + 1); maxN = Math.max(maxN, t.n || 0); maxSpan = Math.max(maxSpan, t.span || 0);
      if (t.cur == null) return `<tr><td>${f.s}</td><td colspan="3">needs about 5 min of warmed-up data</td></tr>`;
      ok++;
      const p = (h) => Math.round(clamp(t.cur + t.slope * h));
      return `<tr><td>${f.s}</td><td>${Math.round(t.cur)} / ${p(15)}</td><td>${Math.round(t.cur)} / ${p(30)}</td><td>${Math.round(t.cur)} / ${p(60)}</td></tr>`;
    }).join("");
    const conf = ok && maxN >= 120 && maxSpan >= 20 ? "Medium" : "Low";
    el.innerHTML = `<table class="hw-t"><thead><tr><th>Index (ADC)</th><th>+15 min</th><th>+30 min</th><th>+60 min</th></tr></thead><tbody>${body}</tbody></table>
      <p class="hw-note">Each cell: persistence / linear trend over the last 30 min. Confidence: <b>${ok ? conf : "none yet"}</b>${ok ? " (no held-out evaluation yet, so never High)" : ""}. Proxy indices, not concentrations.</p>`;
  }
  function renderSource() {
    const el = $("#hwSrc"), now = Date.now();
    const recent = rows.filter((r) => r[1] != null && r[1] >= WARM_MS);
    const base = recent.filter((r) => now - r[0] > 2 * 60000 && now - r[0] <= 30 * 60000);
    if (!connected || recent.length < 5 || base.length < 20) {
      el.innerHTML = `<b>Insufficient evidence.</b> Needs a warmed-up live stream and at least a few minutes of baseline.`; return;
    }
    const rise = {};
    GAS.forEach((f) => { const b = med(base.map((r) => r[f.i + 1])), c = med(recent.slice(-5).map((r) => r[f.i + 1])); rise[f.k] = c != null && b != null && c - b >= Math.max(150, 0.2 * b); });
    let txt;
    if (rise.mq2 && rise.mq135) txt = "<b>Probable smoke / combustion signature</b> (MQ-2 and MQ-135 rose together).";
    else if (rise.mq9) txt = "<b>Probable traffic / combustion signature</b> (MQ-9 rose).";
    else if (rise.mq2 || rise.mq135) txt = "<b>Insufficient evidence.</b> One gas proxy is above its baseline.";
    else txt = "<b>No elevated gas-proxy signal</b> against the last 30 min baseline.";
    el.innerHTML = txt + `<p class="hw-note">A hypothesis from MQ proxies only. This node has no PM sensor, so dust cannot be assessed and nothing here is chemical proof.</p>`;
  }

  /* ---------- chart ---------- */
  function drawChart() {
    const c = $("#hwChart"), W = c.clientWidth, H = c.clientHeight; if (!W) return;
    const dpr = window.devicePixelRatio || 1; c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.font = "11px system-ui,sans-serif"; g.fillStyle = "#a9c9d4";
    const pts = rows.slice(-240);
    if (pts.length < 2) { g.fillText("The chart appears after two readings.", 12, 24); return; }
    const th = thresh(), mx = Math.max(th + 200, ...pts.flatMap((p) => [p[2] || 0, p[3] || 0, p[4] || 0]));
    const L = 40, B = 20, T = 26, y = (v) => H - B - ((H - B - T) * v) / mx;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0], x = (t) => L + ((W - L - 8) * (t - t0)) / Math.max(1, t1 - t0);
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const v = (mx * i) / 4; g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W, y(v)); g.stroke(); g.fillStyle = "#a9c9d4"; g.fillText(Math.round(v), 4, y(v) + 4); }
    g.strokeStyle = "#ff7c00"; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(L, y(th)); g.lineTo(W, y(th)); g.stroke(); g.setLineDash([]);
    const S = [[2, "#5eead4", "MQ-135"], [3, "#fbbf24", "MQ-2"], [4, "#a5b4fc", "MQ-9"]];
    S.forEach(([col, color]) => { g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); pts.forEach((p, i) => { const X = x(p[0]), Y = y(p[col] || 0); i ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.stroke(); });
    let lx = L + 6; S.forEach(([, color, name]) => { g.fillStyle = color; g.fillRect(lx, 8, 12, 3); g.fillStyle = "#e6f6fb"; g.fillText(name, lx + 17, 13); lx += 84; });
    const tf = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    g.fillStyle = "#a9c9d4"; g.fillText(tf(t0), L, H - 5); g.textAlign = "right"; g.fillText(tf(t1), W - 4, H - 5); g.textAlign = "left";
  }

  /* ---------- sensor vs reference ---------- */
  function renderCmp() {
    const el = $("#hwCmp"), z = AX.ref && AX.ref.zones[0], r = last();
    if (!z) { el.innerHTML = `<p class="hw-note">Reference weather is not loaded yet (needs internet).</p>`; return; }
    const line = (name, sv, rv, d, u) => {
      if (sv == null || rv == null) return "";
      const diff = sv - rv;
      return `<tr><td>${name}</td><td>${num(sv, d)} ${u}</td><td>${num(rv, d)} ${u}</td><td>${diff > 0 ? "+" : ""}${diff.toFixed(d)}</td></tr>`;
    };
    const body = r ? line("Temperature (DHT11)", r[5], z.temp, 1, "°C") + line("Temperature (BMP)", r[7], z.temp, 1, "°C") + line("Humidity (DHT11)", r[6], z.hum, 0, "%") + line("Pressure (BMP)", r[8], z.pres, 1, "hPa") : "";
    el.innerHTML = body ? `<table class="hw-t"><thead><tr><th></th><th>Your sensor</th><th>Open-Meteo</th><th>Diff</th></tr></thead><tbody>${body}</tbody></table>
      <p class="hw-note">Open-Meteo is a model value for HITEC City, not a collocated reference monitor. Use it as a sanity check only.</p>` : `<p class="hw-note">Waiting for a sensor reading to compare.</p>`;
  }

  function renderHeavy() { drawChart(); renderForecast(); renderSource(); renderCmp(); }
  function renderAll() { paintMode(); setControls(); renderValues(); renderStatus(); renderFlags(); renderHeavy(); }

  /* ---------- buttons ---------- */
  $("#hwConnect").addEventListener("click", connectClick);
  $("#dockConnect").addEventListener("click", connectClick);
  $("#hwDisconnect").addEventListener("click", closePort);
  $("#hwThresh").addEventListener("input", () => { renderValues(); drawChart(); save(true); });
  $("#hwDownload").addEventListener("click", () => {
    const csv = HEADER.join(",") + "\n" + rows.map((r) => r.slice(1).map((v) => (v == null ? "" : v)).join(",")).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "aeronex_log_" + new Date().toISOString().replace(/[:.]/g, "-") + ".csv";
    a.click(); URL.revokeObjectURL(a.href);
  });
  $("#hwClear").addEventListener("click", () => { rows = []; save(true); renderAll(); });
  addEventListener("resize", () => drawChart());

  /* ---------- Leaflet map (offline SVG fallback) ---------- */
  let map = null, zoneMarks = [], zoneCircles = [], hwMark = null;
  const pin = (z) => { const c = z && z.aqi != null ? cpcb(z.aqi).c : "#94a3b8"; return L.divIcon({ className: "aq-wrap", html: `<div class="aq-pin" style="--c:${c}">${z && z.aqi != null ? z.aqi : "--"}</div>`, iconSize: [40, 40], iconAnchor: [20, 20] }); };
  function zonePopup(z) {
    const c = z.aqi != null ? cpcb(z.aqi) : null;
    return `<b>${esc(z.name)}</b><br>${c ? `AQI ${z.aqi} (${c.name})` : "No reading"}<br>PM2.5 ${num(z.pm25, 0)} · PM10 ${num(z.pm10, 0)} µg/m³<br>NO₂ ${num(z.no2, 0)} · O₃ ${num(z.o3, 0)} µg/m³<br>${num(z.temp, 1)} °C · ${num(z.hum, 0)} % · wind ${num(z.wind, 0)} km/h<br><small>Open-Meteo model, indicative.</small>`;
  }
  function hwText() { const r = last(); return r ? `MQ135 ${num(r[2], 0)} · MQ2 ${num(r[3], 0)} · MQ9 ${num(r[4], 0)}` : "ESP32: no reading yet"; }
  function hwPopup() {
    const r = last(); if (!r) return `<b>${NODE.id}</b><br>No reading yet`;
    return `<b>${NODE.id}</b> (${esc(status().s)})<br>MQ-135 ${num(r[2], 0)} · MQ-2 ${num(r[3], 0)} · MQ-9 ${num(r[4], 0)} ADC<br>${num(r[5], 1)} °C · ${num(r[6], 0)} % · ${num(r[8], 1)} hPa<br><small>Gas values are proxy indices, not concentrations.</small>`;
  }
  function initMap() {
    const el = $("#mapEl"); if (!el) return;
    if (!window.L) { drawOfflineMap(); return; }
    map = L.map(el, { scrollWheelZoom: false }).setView([17.43, 78.44], 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    zoneCircles = ZONES.map((z) => L.circle([z.lat, z.lon], { radius: 2500, color: "#94a3b8", weight: 2, fillColor: "#94a3b8", fillOpacity: 0.22 }).addTo(map).bindTooltip(esc(z.name) + ": loading"));
    zoneMarks = ZONES.map((z) => L.marker([z.lat, z.lon], { icon: pin(null) }).addTo(map).bindPopup(esc(z.name) + "<br>Loading..."));
    hwMark = L.marker([NODE.lat, NODE.lon], { icon: L.divIcon({ className: "hw-pin", html: "<i></i>", iconSize: [22, 22] }), zIndexOffset: 500 })
      .addTo(map).bindTooltip(hwText(), { permanent: true, direction: "top", offset: [0, -12], className: "hw-tip" }).bindPopup(hwPopup());
    AX.map = map;
    setTimeout(() => map.invalidateSize(), 500);
  }
  function updateMapHW() {
    if (hwMark) { hwMark.setTooltipContent(hwText()); hwMark.setPopupContent(hwPopup()); }
    else if (!window.L) drawOfflineMap();
  }
  function updateMapZones() {
    if (!AX.ref) return;
    if (map) AX.ref.zones.forEach((z, i) => { zoneMarks[i].setIcon(pin(z)); zoneMarks[i].setPopupContent(zonePopup(z));
      const c = z.aqi != null ? cpcb(z.aqi) : null;
      zoneCircles[i].setStyle({ color: c ? c.c : "#94a3b8", fillColor: c ? c.c : "#94a3b8" });
      zoneCircles[i].setTooltipContent(esc(z.name) + ": AQI " + (z.aqi != null ? z.aqi : "--"));
    });
    else drawOfflineMap();
  }
  function drawOfflineMap() {
    const el = $("#mapEl"); if (!el || window.L) return;
    const W = 700, H = 480, la0 = 17.33, la1 = 17.53, lo0 = 78.30, lo1 = 78.56;
    const X = (lo) => 30 + ((lo - lo0) / (lo1 - lo0)) * (W - 60), Y = (la) => H - 30 - ((la - la0) / (la1 - la0)) * (H - 60);
    const zs = (AX.ref ? AX.ref.zones : ZONES).map((z) => {
      const c = z.aqi != null ? cpcb(z.aqi).c : "#94a3b8";
      return `<g><circle cx="${X(z.lon)}" cy="${Y(z.lat)}" r="20" fill="${c}" stroke="#06202b" stroke-width="2"/><text x="${X(z.lon)}" y="${Y(z.lat) + 5}" text-anchor="middle" font-size="13" font-weight="700" fill="#06202b">${z.aqi != null ? z.aqi : "--"}</text><text x="${X(z.lon)}" y="${Y(z.lat) + 38}" text-anchor="middle" font-size="12" fill="#0f2a35">${esc(z.name.split(" - ")[0])}</text></g>`;
    }).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Offline schematic map of Hyderabad zones" style="width:100%;height:100%;background:#e6f3f6"><text x="14" y="22" font-size="12" fill="#5b7480">Offline schematic: map tiles need internet</text>${zs}<g><circle cx="${X(NODE.lon)}" cy="${Y(NODE.lat)}" r="9" fill="#5eead4" stroke="#06202b" stroke-width="3"/><text x="${X(NODE.lon) + 14}" y="${Y(NODE.lat) - 12}" font-size="12" font-weight="700" fill="#06202b">${esc(hwText())}</text></g></svg>`;
  }

  /* ---------- Open-Meteo reference feed ---------- */
  function renderWx() {
    const el = $("#wx"), z = AX.ref && AX.ref.zones[0];
    if (!z) { el.innerHTML = `<h3>Weather</h3><p class="hw-note" style="color:var(--muted)">${AX.refError || "Loading..."}</p>`; return; }
    el.innerHTML = `<h3>Weather, HITEC City</h3>
      <div class="wx-main"><b>${num(z.temp, 0)}°C</b><span>${WX(z.code)}</span></div>
      <ul class="wx-list"><li>Feels like <b>${num(z.feels, 0)}°C</b></li><li>Humidity <b>${num(z.hum, 0)}%</b></li><li>Wind <b>${num(z.wind, 0)} km/h</b></li><li>Pressure <b>${num(z.pres, 0)} hPa</b></li>
      <li>PM2.5 <b>${num(z.pm25, 0)}</b> · PM10 <b>${num(z.pm10, 0)}</b> µg/m³</li></ul>
      <small>Updated ${new Date(AX.ref.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · Open-Meteo</small>`;
  }
  async function loadReference() {
    const lat = ZONES.map((z) => z.lat).join(","), lon = ZONES.map((z) => z.lon).join(",");
    try {
      const [aq, wx] = await Promise.all([
        getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,nitrogen_dioxide,ozone&timezone=auto`),
        getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,surface_pressure,weather_code&timezone=auto`),
      ]);
      const A = [].concat(aq), W = [].concat(wx);
      const zones = ZONES.map((z, i) => {
        const a = (A[i] || {}).current || {}, w = (W[i] || {}).current || {};
        const pm25 = a.pm2_5 ?? null, pm10 = a.pm10 ?? null;
        const aqi = aqiFrom(pm25, pm10);
        return { ...z, pm25, pm10, no2: a.nitrogen_dioxide ?? null, o3: a.ozone ?? null, aqi, temp: w.temperature_2m ?? null, feels: w.apparent_temperature ?? null, hum: w.relative_humidity_2m ?? null, wind: w.wind_speed_10m ?? null, pres: w.surface_pressure ?? null, code: w.weather_code ?? 3 };
      });
      AX.ref = { zones, at: Date.now() }; AX.refError = null;
      updateMapZones(); renderWx(); renderCmp(); applyFallback();
    } catch (e) {
      AX.refError = "Reference weather and AQI could not be loaded (" + e.message + "). Hardware readings are unaffected.";
      renderWx();
    }
  }
  function applyFallback() {                         // only when the Aeronex backend is not answering
    if (AX.backend === true || !AX.ref || !AX.renderZoneCards || AX.renderedAt === AX.ref.at) return;
    AX.renderedAt = AX.ref.at;
    const zs = AX.ref.zones;
    AX.renderZoneCards(zs.map((z) => ({ name: z.name, aqi: z.aqi, note: z.pm25 != null ? `PM2.5 ${z.pm25.toFixed(0)} · PM10 ${num(z.pm10, 0)} µg/m³ · Open-Meteo model` : "No reference reading" })));
    const v = zs.filter((z) => z.aqi != null);
    if (v.length) {
      AX.setGauge(Math.round(v.reduce((a, z) => a + z.aqi, 0) / v.length));
      $("#gFoot").textContent = "Average of " + v.length + " zones · Open-Meteo model with CPCB bands, indicative";
      const w = v.reduce((a, b) => (b.aqi > a.aqi ? b : a));
      $("#stWorst").textContent = w.aqi; $("#stWorst").nextElementSibling.textContent = "highest: " + w.name.split(" ")[0];
    }
  }
  AX.onOffline = () => { if (AX.ref) applyFallback(); else { $("#gCat").textContent = "loading reference data"; $("#gFoot").textContent = "No backend found; using Open-Meteo reference values"; } };

  function tickStats() {
    if (AX.backend === true) return;
    const n = $("#stNodes"), o = $("#stOnline"); if (!n || !o) return;
    n.textContent = "1"; o.textContent = (isLive() ? 1 : 0) + " / 1";
  }

  AX.hwLast = last; AX.hwStatus = status;
  window.addEventListener("aeronex:view", (e) => {       // hidden views have no size, so redraw when one opens
    if (e.detail === "hardware") renderHeavy();
    if (e.detail === "map" && map) setTimeout(() => map.invalidateSize(), 50);
  });

  /* ---------- start ---------- */
  initMap(); renderWx(); renderAll(); loadReference();
  setInterval(loadReference, 10 * 60000);
  setInterval(() => { renderStatus(); renderFlags(); renderValues(); tickStats(); }, 1000);
  setInterval(renderHeavy, 15000);
  autoConnect();
  if (!saved.rows || !saved.rows.length) setMsg(hasSerial ? "Click Connect USB port and choose the entry labelled COM9." : "");
})();
