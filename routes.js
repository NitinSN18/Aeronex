/* Aeronex bus-route demo: three routes into JNTU with moving buses that carry the sensor node.
   Road geometry: OSRM public routing (falls back to straight lines offline). Everything the buses "read" is SIMULATED,
   except the bus you attach the live ESP32 to, which shows the board's real gas readings. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const AX = (window.Aeronex = window.Aeronex || {});
  const U = AX.util; if (!U) return;
  const { aqiFrom, cpcb, num, esc, getJson, ZONES } = U;

  const JNTU = { name: "JNTU Hyderabad", lat: 17.4937, lon: 78.3914 };            // approximate campus location
  const ROUTES = [
    { id: "A", name: "Gachibowli to JNTU", color: "#38bdf8", from: { name: "Gachibowli", lat: 17.4401, lon: 78.3489 }, via: [{ lat: 17.4435, lon: 78.3772 }], speed: 24, cong: [[0.30, 700, 0.8], [0.62, 900, 0.6]] },
    { id: "B", name: "RGI Airport to JNTU", color: "#f59e0b", from: { name: "RGI Airport", lat: 17.2403, lon: 78.4294 }, via: [], speed: 34, cong: [[0.15, 1500, 0.5], [0.85, 900, 0.9]] },
    { id: "C", name: "Miyapur to JNTU", color: "#a78bfa", from: { name: "Miyapur", lat: 17.4969, lon: 78.3573 }, via: [], speed: 22, cong: [[0.50, 500, 1.0]] },
  ];
  const SAMPLE_M = 100, MAX_SEGS = 2500, rad = Math.PI / 180;
  let map = null, started = false, running = true, scale = 30, buses = [], trail = null, hotLayer = null, segs = [], cells = new Map();
  let stats = { samples: 0, hot: 0, sum: 0, n: 0 }, attach = "", lastT = Date.now(), tickN = 0;

  const km = (a, b) => { const x = Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const clamp = (v) => Math.max(0, Math.min(4095, v));

  async function loadRoute(r) {
    const pts = [r.from, ...r.via, JNTU];
    try {
      const j = await getJson(`https://router.project-osrm.org/route/v1/driving/${pts.map((p) => p.lon + "," + p.lat).join(";")}?overview=full&geometries=geojson`);
      r.path = j.routes[0].geometry.coordinates.map(([lo, la]) => [la, lo]); r.road = true;
    } catch { r.path = pts.map((p) => [p.lat, p.lon]); r.road = false; }
    r.cum = [0];
    for (let i = 1; i < r.path.length; i++) r.cum.push(r.cum[i - 1] + km(r.path[i - 1], r.path[i]) * 1000);
    r.len = r.cum[r.cum.length - 1];
    r.hot = r.cong.map(([f, w, h]) => ({ at: f * r.len, w, h }));
  }
  function posAt(r, d) {
    const c = r.cum; let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
    const t = (d - c[lo]) / Math.max(1e-6, c[hi] - c[lo]), a = r.path[lo], b = r.path[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /* ---------- simulated field: model PM2.5 near the point, plus rush hour and congestion bumps along the route ---------- */
  function basePm(lat, lon) {
    const z = AX.ref && AX.ref.zones; if (!z) return 55;
    let best = null, bd = 1e9;
    z.forEach((q) => { const d = (q.lat - lat) ** 2 + (q.lon - lon) ** 2; if (d < bd && q.pm25 != null) { bd = d; best = q; } });
    return best ? best.pm25 : 55;
  }
  function simReading(b, lat, lon, d) {
    let bump = 0; b.r.hot.forEach((c) => { bump += c.h * Math.exp(-0.5 * ((d - c.at) / c.w) ** 2); });
    const ist = new Date(Date.now() + 19800000), hr = ist.getUTCHours() + ist.getUTCMinutes() / 60;
    const g = (h, mu, s) => Math.exp(-0.5 * ((h - mu) / s) ** 2), rush = Math.max(g(hr, 9, 1.4), g(hr, 18.5, 1.8));
    const noise = (Math.abs(Math.sin(stats.samples * 12.9898 + b.r.len) * 43758.5453) % 1) - 0.5;
    const pm25 = Math.max(8, basePm(lat, lon) * (0.85 + 0.3 * rush) * (1 + bump) * (1 + 0.08 * noise)), pm10 = pm25 * (1.7 + 0.5 * bump);
    return { pm25, pm10, aqi: aqiFrom(pm25, pm10), mq135: clamp(1000 + pm25 * 5), mq2: clamp(800 + pm25 * 3.2), mq9: clamp(900 + pm25 * 4.2 + bump * 700) };
  }
  function liveReading() {
    const r = AX.hwLast && AX.hwLast(); if (!r) return null;
    return { live: true, mq135: r[2], mq2: r[3], mq9: r[4], status: AX.hwStatus().s };
  }
  const liveColor = (rd) => {
    const th = parseFloat($("#hwThresh").value) || 2500, m = Math.max(rd.mq135 || 0, rd.mq2 || 0, rd.mq9 || 0) / th;
    return m >= 1 ? "#ff0000" : m >= 0.8 ? "#ff7c00" : m >= 0.6 ? "#ffc000" : "#00b050";
  };

  function hotspot(lat, lon, aqi) {
    stats.sum += aqi; stats.n++;
    const k = Math.round(lat / 0.002) + "," + Math.round(lon / 0.002);
    let c = cells.get(k); if (!c) { c = { s: 0, n: 0, f: false }; cells.set(k, c); }
    c.s += aqi; c.n++;
    if (!c.f && c.n >= 4 && stats.n > 60 && c.s / c.n >= 1.3 * (stats.sum / stats.n)) {
      c.f = true; stats.hot++;
      L.circle([lat, lon], { radius: 260, color: "#ff0000", weight: 2, fillColor: "#ff0000", fillOpacity: 0.2 }).addTo(hotLayer)
        .bindTooltip(`Hotspot candidate · avg AQI ${Math.round(c.s / c.n)} (simulated)`);
    }
  }
  function sample(b) {
    const [lat, lon] = posAt(b.r, b.lastS);
    const live = b.r.id === attach ? liveReading() : null;
    const rd = live || simReading(b, lat, lon, b.lastS);
    stats.samples++; b.reading = rd;
    const col = live ? liveColor(live) : cpcb(rd.aqi).c;
    if (b.prev) {
      segs.push(L.polyline([b.prev, [lat, lon]], { color: col, weight: 6, opacity: 0.92, lineCap: "round" }).addTo(trail));
      if (segs.length > MAX_SEGS) trail.removeLayer(segs.shift());
    }
    b.prev = [lat, lon];
    if (!live) hotspot(lat, lon, rd.aqi);
  }

  function tick() {
    const now = Date.now(), dt = Math.min(1, (now - lastT) / 1000); lastT = now;
    if (!started || !running || document.body.dataset.view !== "routes") return;
    buses.forEach((b) => {
      b.t += dt;
      const v = (b.r.speed * (0.7 + 0.5 * (0.5 + 0.5 * Math.sin(b.t / (8 + (b.r.len % 5)))))) / 3.6;
      b.kmh = v * 3.6;
      b.d += b.dir * v * dt * scale;
      if (b.d >= b.r.len) { b.d = b.r.len; b.dir = -1; }
      if (b.d <= 0) { b.d = 0; b.dir = 1; }
      let guard = 0;
      while (Math.abs(b.d - b.lastS) >= SAMPLE_M && guard++ < 60) { b.lastS += Math.sign(b.d - b.lastS) * SAMPLE_M; sample(b); }
      b.marker.setLatLng(posAt(b.r, b.d));
      const rd = b.reading;
      b.marker.setTooltipContent(`Bus ${b.r.id}` + (rd ? (rd.live ? " · live ESP32" : ` · AQI ${Math.round(rd.aqi)}`) : ""));
    });
    if (++tickN % 2 === 0) paint();
  }

  function paint() {
    $("#busCards").innerHTML = "<h3>Buses</h3>" + buses.map((b) => {
      const rd = b.reading; let txt = "Waiting for the first reading...";
      if (rd && rd.live) txt = `MQ-135 <b>${num(rd.mq135, 0)}</b> · MQ-2 <b>${num(rd.mq2, 0)}</b> · MQ-9 <b>${num(rd.mq9, 0)}</b> ADC (${esc(rd.status.toLowerCase())}). No PM sensor, so no AQI.`;
      else if (rd) txt = `AQI <b>${Math.round(rd.aqi)}</b> (${cpcb(rd.aqi).name}) · PM2.5 ${Math.round(rd.pm25)} · MQ-9 ${Math.round(rd.mq9)} <em>(simulated)</em>`;
      const live = b.r.id === attach;
      return `<div class="bus-card" style="--c:${b.r.color}"><div class="bc-h"><span class="bc-id">${b.r.id}</span><b>${esc(b.r.name)}</b>${live ? '<em class="bc-live">LIVE ESP32</em>' : ""}</div>
        <div class="bc-bar"><i style="width:${(100 * b.d / b.r.len).toFixed(0)}%"></i></div>
        <div class="bc-r">${b.dir > 0 ? "heading to JNTU" : "heading back"} · ${b.kmh.toFixed(0)} km/h · ${(b.d / 1000).toFixed(1)} of ${(b.r.len / 1000).toFixed(1)} km</div>
        <div class="bc-v">${txt}</div></div>`;
    }).join("");
    const total = buses.reduce((a, b) => a + b.r.len, 0) / 1000;
    $("#routeStats").innerHTML = `<h3>Coverage</h3><ul class="cov">
      <li>Road covered by 3 routes: <b>${total.toFixed(0)} km</b> one way</li>
      <li>Readings collected: <b>${stats.samples}</b> (one every ~100 m)</li>
      <li>Hotspot candidates: <b>${stats.hot}</b></li>
      <li>Fixed pins in the same area: <b>${ZONES.length}</b></li></ul>
      <small>Hotspots use the same idea as the ML hotspot module: a road cell is flagged when it stays well above the city level over repeated passes. Simplified here and run on simulated readings.</small>`;
  }

  async function start() {
    if (started) return;
    if (!window.L) { $("#routeMap").innerHTML = '<p class="muted" style="padding:20px">The route map needs internet (Leaflet and map tiles).</p>'; return; }
    started = true;
    map = L.map("routeMap", { scrollWheelZoom: false }).setView([17.40, 78.40], 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    $("#rtNote").textContent = "Loading road routes...";
    await Promise.all(ROUTES.map(loadRoute));
    trail = L.layerGroup().addTo(map); hotLayer = L.layerGroup().addTo(map);
    ZONES.forEach((z) => L.circleMarker([z.lat, z.lon], { radius: 6, color: "#475569", weight: 2, fillColor: "#cbd5e1", fillOpacity: 1 }).addTo(map).bindTooltip("Fixed zone point: " + z.name));
    const all = [];
    ROUTES.forEach((r) => {
      L.polyline(r.path, { color: r.color, weight: 3, opacity: 0.55, dashArray: "6 8" }).addTo(map);
      L.circleMarker(r.path[0], { radius: 7, color: "#06202b", weight: 3, fillColor: r.color, fillOpacity: 1 }).addTo(map).bindTooltip(r.from.name, { permanent: true, direction: "bottom", className: "stop-tip" });
      all.push(...r.path);
    });
    L.circleMarker([JNTU.lat, JNTU.lon], { radius: 10, color: "#06202b", weight: 3, fillColor: "#ef4444", fillOpacity: 1 }).addTo(map).bindTooltip(JNTU.name + " (destination)", { permanent: true, direction: "top", className: "stop-tip" });
    map.fitBounds(all, { padding: [30, 30] });
    buses = ROUTES.map((r, i) => {
      const d = r.len * [0.04, 0.30, 0.12][i];
      return { r, d, lastS: d, dir: 1, t: i * 7, kmh: r.speed, prev: null, reading: null,
        marker: L.marker(posAt(r, d), { icon: L.divIcon({ className: "bus-pin", html: `<div style="--c:${r.color}">${r.id}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 800 })
          .addTo(map).bindTooltip("Bus " + r.id, { permanent: true, direction: "right", offset: [14, 0], className: "bus-tip" }) };
    });
    $("#rtNote").textContent = ROUTES.every((r) => r.road) ? "" : "Road geometry could not be loaded, so routes are drawn as approximate straight lines.";
    paint();
  }

  function reset() {
    if (!trail) return;
    trail.clearLayers(); hotLayer.clearLayers(); segs = []; cells = new Map(); stats = { samples: 0, hot: 0, sum: 0, n: 0 };
    buses.forEach((b) => { b.lastS = b.d; b.prev = null; b.reading = null; });
    paint();
  }
  $("#rtPlay").addEventListener("click", () => { running = !running; $("#rtPlay").textContent = running ? "Pause" : "Play"; lastT = Date.now(); });
  $("#rtSpeed").addEventListener("change", (e) => { scale = +e.target.value; });
  $("#rtAttach").addEventListener("change", (e) => { attach = e.target.value; if (attach && !(AX.hwLast && AX.hwLast())) $("#rtNote").textContent = "No ESP32 reading yet. Connect the USB port in the Hardware view (the bar at the bottom shows its status)."; else if (started) $("#rtNote").textContent = ""; });
  $("#rtReset").addEventListener("click", reset);
  window.addEventListener("aeronex:view", (e) => {
    if (e.detail !== "routes") return;
    lastT = Date.now();
    if (!started) start(); else setTimeout(() => map && map.invalidateSize(), 50);
  });
  setInterval(tick, 250);
})();
