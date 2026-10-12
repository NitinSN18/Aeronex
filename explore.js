/* Aeronex explore layer
   1. Click anywhere on the map (or search a PIN / place) for AQI, PIN code, district and weather.
   2. City heatmap (interpolated AQI grid) as its own view and as a map overlay.
   3. Hourly AQI forecast view.
   Data: Open-Meteo (air quality, weather), OpenStreetMap Nominatim (place names, PIN codes). All indicative model values. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const AX = (window.Aeronex = window.Aeronex || {});
  const U = AX.util; if (!U) return;
  const { aqiFrom, cpcb, num, esc, WX, getJson, ZONES, NODE } = U;
  const AQ = "https://air-quality-api.open-meteo.com/v1/air-quality";
  const FC = "https://api.open-meteo.com/v1/forecast";
  const NOM = "https://nominatim.openstreetmap.org";
  const km = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const HEALTH = {
    "Good": "Minimal impact.",
    "Satisfactory": "May cause minor breathing discomfort to sensitive people.",
    "Moderate": "May cause breathing discomfort to people with lung disease such as asthma, and discomfort to people with heart disease, children and older adults.",
    "Poor": "May cause breathing discomfort to most people on prolonged exposure, and discomfort to people with heart disease.",
    "Very Poor": "May cause respiratory illness on prolonged exposure.",
    "Severe": "May cause respiratory impact even on healthy people, and serious health impacts on people with lung or heart disease.",
  };

  /* =====================================================================
     1. Place lookup
     ===================================================================== */
  let token = 0, lastRev = 0, placeMarker = null, hist = [];
  const placeEl = $("#place"), msgEl = $("#placeMsg");
  const msg = (t) => { msgEl.textContent = t || ""; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function lookup(lat, lon, hint) {
    const my = ++token;
    if (AX.map && window.L) {
      if (placeMarker) placeMarker.setLatLng([lat, lon]);
      else placeMarker = L.circleMarker([lat, lon], { radius: 9, color: "#06202b", weight: 3, fillColor: "#ffffff", fillOpacity: 1 }).addTo(AX.map);
    }
    placeEl.innerHTML = `<h3>Selected place</h3><p class="muted">Looking up ${lat.toFixed(4)}, ${lon.toFixed(4)}...</p>`;
    const [aq, wx, geo] = await Promise.allSettled([
      getJson(`${AQ}?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide&timezone=auto`),
      getJson(`${FC}?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`),
      (async () => { const w = 1100 - (Date.now() - lastRev); if (w > 0) await sleep(w); lastRev = Date.now(); return getJson(`${NOM}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1&accept-language=en`); })(),
    ]);
    if (my !== token) return;                                   // a newer click replaced this one
    const a = aq.status === "fulfilled" ? aq.value.current || {} : null;
    const w = wx.status === "fulfilled" ? wx.value.current || {} : {};
    const g = geo.status === "fulfilled" ? geo.value : null, ad = (g && g.address) || {};
    const name = ad.neighbourhood || ad.suburb || ad.city_district || ad.village || ad.town || ad.city || ad.county || hint || (g && g.name) || "Unnamed location";
    const district = ad.state_district || ad.county || ad.city || "";
    const pin = ad.postcode || "";
    const sub = [pin ? "PIN " + pin : "PIN not available here", district, ad.state].filter(Boolean).map(esc).join(" · ");
    if (!a) { placeEl.innerHTML = `<h3>Selected place</h3><div class="pl-name">${esc(name)}</div><div class="pl-sub">${sub}</div><p class="muted">Air-quality data could not be loaded. Check your internet connection and try again.</p>`; return; }
    const pm25 = a.pm2_5 ?? null, pm10 = a.pm10 ?? null, aqi = aqiFrom(pm25, pm10), c = aqi != null ? cpcb(aqi) : null;
    const dom = aqi == null ? "" : (U.sub(pm25, [0, 30, 60, 90, 120, 250], [30, 60, 90, 120, 250, 380]) || 0) >= (U.sub(pm10, [0, 50, 100, 250, 350, 430], [50, 100, 250, 350, 430, 510]) || 0) ? "PM2.5" : "PM10";
    const d = km(lat, lon, NODE.lat, NODE.lon), r = AX.hwLast && AX.hwLast();
    const node = `Nearest hardware node <b>${NODE.id}</b> is ${d.toFixed(1)} km away` + (r ? ` · MQ-135 ${num(r[2], 0)} ADC (${esc(AX.hwStatus().s.toLowerCase())})` : "") + ".";
    placeEl.innerHTML = `<h3>Selected place</h3>
      <div class="pl-name">${esc(name)}</div><div class="pl-sub">${sub}</div>
      <div class="pl-aqi" style="--c:${c ? c.c : "#94a3b8"}"><b>${aqi ?? "--"}</b><span>${c ? c.name : "No data"}</span></div>
      ${c ? `<p class="pl-health">${HEALTH[c.name]}${dom ? " Driven by " + dom + "." : ""}</p>` : ""}
      <table class="pl-t"><tbody>
        <tr><td>PM2.5</td><td>${num(pm25, 0)} µg/m³</td><td>PM10</td><td>${num(pm10, 0)} µg/m³</td></tr>
        <tr><td>NO₂</td><td>${num(a.nitrogen_dioxide, 0)} µg/m³</td><td>O₃</td><td>${num(a.ozone, 0)} µg/m³</td></tr>
        <tr><td>SO₂</td><td>${num(a.sulphur_dioxide, 0)} µg/m³</td><td>CO</td><td>${num(a.carbon_monoxide, 0)} µg/m³</td></tr></tbody></table>
      <p class="pl-wx">${num(w.temperature_2m, 1)} °C · ${num(w.relative_humidity_2m, 0)} % · wind ${num(w.wind_speed_10m, 0)} km/h · ${WX(w.weather_code ?? 3)}</p>
      <p class="pl-near">${node}</p>
      <small>Model estimate (Open-Meteo / CAMS). The model grid is tens of km wide, so nearby places often match. Indicative, not an official reading.</small>`;
    AX.selected = { name, lat, lon };
    hist = [{ name, lat, lon, aqi, c: c ? c.c : "#94a3b8" }, ...hist.filter((h) => Math.abs(h.lat - lat) > 0.002 || Math.abs(h.lon - lon) > 0.002)].slice(0, 6);
    renderHist();
    window.dispatchEvent(new Event("aeronex:place"));
  }
  AX.lookup = lookup;

  function renderHist() {
    $("#placeHist").innerHTML = hist.map((h, i) => `<button type="button" data-h="${i}"><i style="--c:${h.c}"></i>${esc(h.name)} <b>${h.aqi ?? "--"}</b></button>`).join("");
  }
  $("#placeHist").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-h]"); if (!b) return;
    const h = hist[+b.dataset.h]; if (AX.map) AX.map.flyTo([h.lat, h.lon], 13); lookup(h.lat, h.lon, h.name);
  });

  async function search(q) {
    q = q.trim(); if (!q) return;
    msg("Searching...");
    let r = [];
    const pinQ = /^\d{6}$/.test(q);
    try {
      if (pinQ) r = await getJson(`${NOM}/search?format=jsonv2&postalcode=${q}&country=India&limit=1&accept-language=en`);
      if (!r.length) r = await getJson(`${NOM}/search?format=jsonv2&q=${encodeURIComponent(q + (/india/i.test(q) ? "" : ", India"))}&countrycodes=in&limit=1&accept-language=en`);
    } catch (e) { msg("Search failed (" + e.message + "). Try again in a few seconds."); return; }
    if (!r.length) { msg("No match found. Try a 6-digit PIN code or a place name."); return; }
    msg("");
    const p = r[0], lat = +p.lat, lon = +p.lon;
    if (AX.map) AX.map.flyTo([lat, lon], pinQ ? 14 : 12);
    lookup(lat, lon, pinQ ? "PIN " + q : (p.display_name || q).split(",")[0]);
  }
  $("#placeForm").addEventListener("submit", (e) => { e.preventDefault(); search($("#placeQ").value); });
  $("#distChips").addEventListener("click", (e) => { const b = e.target.closest("button[data-q]"); if (b) { $("#placeQ").value = b.textContent; search(b.dataset.q); } });
  if (AX.map) AX.map.on("click", (e) => lookup(e.latlng.lat, e.latlng.lng));
  else msg("The map needs internet. You can still search a PIN code or place once you're online.");

  /* =====================================================================
     2. Heatmap: a lattice of Open-Meteo points, bilinearly interpolated
     ===================================================================== */
  const BB = { la0: 17.20, la1: 17.65, lo0: 78.20, lo1: 78.65 }, N = 7, CELLS = 44;
  let grid = null, overlay = null, hmGeom = null;

  async function loadGrid() {
    const la = [], lo = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { la.push((BB.la0 + ((BB.la1 - BB.la0) * i) / (N - 1)).toFixed(3)); lo.push((BB.lo0 + ((BB.lo1 - BB.lo0) * j) / (N - 1)).toFixed(3)); }
    try {
      const A = [].concat(await getJson(`${AQ}?latitude=${la.join(",")}&longitude=${lo.join(",")}&current=pm2_5,pm10&timezone=auto`));
      const v = A.map((x) => { const c = (x || {}).current || {}; return aqiFrom(c.pm2_5 ?? null, c.pm10 ?? null); });
      const ok = v.filter((x) => x != null); if (!ok.length) throw new Error("no data");
      const avg = Math.round(ok.reduce((a, b) => a + b, 0) / ok.length);
      grid = { v: v.map((x) => (x == null ? avg : x)), min: Math.min(...ok), max: Math.max(...ok), avg, at: Date.now() };
      drawHeat(); updateOverlay();
    } catch (e) { $("#hmNote").textContent = "Heatmap data could not be loaded (" + e.message + "). Check your internet connection."; }
  }
  const gv = (i, j) => grid.v[Math.max(0, Math.min(N - 1, i)) * N + Math.max(0, Math.min(N - 1, j))];
  function sample(la, lo) {                                  // bilinear AQI + uncertainty (0 at a sample, ~0.7 mid-cell)
    const fi = ((la - BB.la0) / (BB.la1 - BB.la0)) * (N - 1), fj = ((lo - BB.lo0) / (BB.lo1 - BB.lo0)) * (N - 1);
    const i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
    const v = gv(i, j) * (1 - ti) * (1 - tj) + gv(i + 1, j) * ti * (1 - tj) + gv(i, j + 1) * (1 - ti) * tj + gv(i + 1, j + 1) * ti * tj;
    const u = Math.min(1, Math.hypot(Math.min(ti, 1 - ti), Math.min(tj, 1 - tj)) / 0.7071);
    return { v, u };
  }
  function drawHeat() {
    const c = $("#hmCanvas"), W = c.clientWidth; if (!W || !grid) return;
    const H = Math.round(Math.min(560, Math.max(320, W * 0.62))), dpr = window.devicePixelRatio || 1;
    c.style.height = H + "px"; c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const L = 58, R = 92, T = 12, B = 42, pw = W - L - R, ph = H - T - B, fade = $("#hmFade").checked;
    hmGeom = { L, T, pw, ph };
    g.fillStyle = "#0b2f3d"; g.fillRect(L, T, pw, ph);
    const cw = pw / CELLS, ch = ph / CELLS;
    for (let r = 0; r < CELLS; r++) for (let q = 0; q < CELLS; q++) {
      const la = BB.la1 - ((r + 0.5) / CELLS) * (BB.la1 - BB.la0), lo = BB.lo0 + ((q + 0.5) / CELLS) * (BB.lo1 - BB.lo0);
      const s = sample(la, lo), col = cpcb(s.v).c;
      g.globalAlpha = fade ? 0.95 - 0.55 * s.u : 0.95; g.fillStyle = col; g.fillRect(L + q * cw, T + r * ch, cw + 0.6, ch + 0.6);
    }
    g.globalAlpha = 1;
    g.font = "11px system-ui,sans-serif"; g.fillStyle = "#a9c9d4"; g.strokeStyle = "rgba(255,255,255,.18)"; g.lineWidth = 1;
    for (let k = 0; k <= 5; k++) {
      const la = BB.la1 - ((BB.la1 - BB.la0) * k) / 5, lo = BB.lo0 + ((BB.lo1 - BB.lo0) * k) / 5, y = T + (ph * k) / 5, x = L + (pw * k) / 5;
      g.fillText(la.toFixed(2), 8, y + 4); g.fillText(lo.toFixed(2), x - 14, T + ph + 16);
      g.beginPath(); g.moveTo(L - 4, y); g.lineTo(L, y); g.moveTo(x, T + ph); g.lineTo(x, T + ph + 4); g.stroke();
    }
    g.fillText("longitude", L + pw / 2 - 24, H - 6);
    g.save(); g.translate(12, T + ph / 2 + 24); g.rotate(-Math.PI / 2); g.fillText("latitude", 0, 0); g.restore();
    const px = (lo) => L + ((lo - BB.lo0) / (BB.lo1 - BB.lo0)) * pw, py = (la) => T + ((BB.la1 - la) / (BB.la1 - BB.la0)) * ph;
    ZONES.forEach((z) => { g.fillStyle = "#fff"; g.strokeStyle = "#06202b"; g.lineWidth = 2; g.beginPath(); g.arc(px(z.lon), py(z.lat), 4.5, 0, 6.283); g.fill(); g.stroke(); g.fillStyle = "#e6f6fb"; g.fillText(z.name.split(" - ")[0], px(z.lon) + 8, py(z.lat) + 4); });
    g.fillStyle = "#5eead4"; g.strokeStyle = "#06202b"; g.beginPath(); g.arc(px(NODE.lon), py(NODE.lat), 6, 0, 6.283); g.fill(); g.stroke();
    g.fillStyle = "#5eead4"; g.fillText("ESP32 node", px(NODE.lon) + 10, py(NODE.lat) - 8);
    // legend
    const bands = [[0, 50, "#00b050"], [50, 100, "#92d050"], [100, 200, "#ffc000"], [200, 300, "#ff7c00"], [300, 400, "#ff0000"], [400, 500, "#a00000"]], lx = W - R + 26, ly = T + 18, lh = ph - 36;
    g.fillStyle = "#a9c9d4"; g.fillText("AQI", lx - 2, T + 8);
    bands.forEach(([a, b, col]) => { const y1 = ly + lh - (lh * b) / 500, y0 = ly + lh - (lh * a) / 500; g.fillStyle = col; g.fillRect(lx, y1, 14, y0 - y1 + 0.5); g.fillStyle = "#a9c9d4"; g.fillText(b, lx + 20, y1 + 4); });
    $("#hmStats").textContent = `Lowest ${grid.min} · average ${grid.avg} · highest ${grid.max}`;
    $("#hmNote").textContent = `${N * N} model points interpolated (bilinear) over the Hyderabad area. The model grid is coarse, so neighbouring cells look alike; faded cells are further from a sampled point. Data as of ${new Date(grid.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. An estimate, not a measurement.`;
  }
  $("#hmFade").addEventListener("change", () => { drawHeat(); updateOverlay(); });
  const tip = $("#hmTip");
  $("#hmCanvas").addEventListener("mousemove", (e) => {
    if (!grid || !hmGeom) return;
    const b = e.target.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, { L, T, pw, ph } = hmGeom;
    if (x < L || x > L + pw || y < T || y > T + ph) { tip.hidden = true; return; }
    const lo = BB.lo0 + ((x - L) / pw) * (BB.lo1 - BB.lo0), la = BB.la1 - ((y - T) / ph) * (BB.la1 - BB.la0), s = sample(la, lo), c = cpcb(s.v);
    tip.hidden = false; tip.style.left = Math.min(x + 14, b.width - 190) + "px"; tip.style.top = y + 14 + "px";
    tip.innerHTML = `<b>AQI ${Math.round(s.v)}</b> · ${c.name}<br>${la.toFixed(3)}, ${lo.toFixed(3)}<br>Uncertainty: ${s.u < 0.25 ? "low" : s.u < 0.6 ? "medium" : "high"}`;
  });
  $("#hmCanvas").addEventListener("mouseleave", () => { tip.hidden = true; });
  addEventListener("resize", () => { if (document.body.dataset.view === "heatmap") drawHeat(); });

  // heat layer on the Leaflet map (same grid, one pixel per cell, smoothed by the browser)
  function updateOverlay() {
    if (!AX.map || !window.L || !grid) return;
    const cv = document.createElement("canvas"); cv.width = cv.height = 64;
    const g = cv.getContext("2d"), fade = $("#hmFade").checked;
    for (let r = 0; r < 64; r++) for (let q = 0; q < 64; q++) {
      const la = BB.la1 - ((r + 0.5) / 64) * (BB.la1 - BB.la0), lo = BB.lo0 + ((q + 0.5) / 64) * (BB.lo1 - BB.lo0), s = sample(la, lo);
      g.globalAlpha = fade ? 0.95 - 0.5 * s.u : 0.95; g.fillStyle = cpcb(s.v).c; g.fillRect(q, r, 1, 1);
    }
    let url; try { url = cv.toDataURL("image/png"); } catch { return; }
    if (overlay) AX.map.removeLayer(overlay);
    overlay = L.imageOverlay(url, [[BB.la0, BB.lo0], [BB.la1, BB.lo1]], { opacity: 0.5, interactive: false });
    if ($("#mapHeat").checked) overlay.addTo(AX.map);
  }
  $("#mapHeat").addEventListener("change", () => { if (!overlay || !AX.map) return; if ($("#mapHeat").checked) overlay.addTo(AX.map); else AX.map.removeLayer(overlay); });

  /* =====================================================================
     3. Forecast
     ===================================================================== */
  let hours = [], nowIdx = 0;
  const places = () => [...(AX.selected ? [{ name: "Selected: " + AX.selected.name, lat: AX.selected.lat, lon: AX.selected.lon }] : []), ...ZONES];
  function fillPlaces() {
    const sel = $("#fcPlace"), prev = sel.value, list = places();
    sel.innerHTML = list.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
    if (prev && sel.options[prev]) sel.value = prev;
  }
  async function loadFc() {
    const p = places()[+$("#fcPlace").value || 0]; if (!p) return;
    $("#fcInfo").textContent = "Loading...";
    try {
      const j = await getJson(`${AQ}?latitude=${p.lat}&longitude=${p.lon}&hourly=pm2_5,pm10&past_days=2&forecast_days=2&timezone=auto`);
      const off = (j.utc_offset_seconds || 0) * 1000, h = j.hourly;
      hours = h.time.map((t, i) => ({ t, utc: Date.parse(t + "Z") - off, aqi: aqiFrom(h.pm2_5[i] ?? null, h.pm10[i] ?? null) }));
      nowIdx = 0; hours.forEach((x, i) => { if (x.utc <= Date.now()) nowIdx = i; });
      $("#fcInfo").textContent = "Model forecast for " + p.name;
      renderFc();
    } catch (e) { $("#fcInfo").textContent = "Forecast could not be loaded (" + e.message + ")."; }
  }
  function renderFc() {
    const at = (k) => hours[nowIdx + k], next = hours.slice(nowIdx, nowIdx + 25).filter((x) => x.aqi != null);
    const card = (label, x) => { const c = x && x.aqi != null ? cpcb(x.aqi) : null; return `<div class="fc-card" style="--c:${c ? c.c : "#94a3b8"}"><span>${label}</span><b>${x && x.aqi != null ? x.aqi : "--"}</b><em>${c ? c.name : "no data"}</em></div>`; };
    let extra = "";
    if (next.length) {
      const pk = next.reduce((a, b) => (b.aqi > a.aqi ? b : a)), lo = next.reduce((a, b) => (b.aqi < a.aqi ? b : a)), tm = (x) => x.t.slice(11, 16);
      extra = `<div class="fc-card wide"><span>Next 24 h</span><b>Peak ${pk.aqi} at ${tm(pk)}</b><em>Cleanest ${lo.aqi} at ${tm(lo)}</em></div>`;
    }
    $("#fcCards").innerHTML = card("Now", at(0)) + card("In 3 h", at(3)) + card("In 6 h", at(6)) + card("In 12 h", at(12)) + card("In 24 h", at(24)) + extra;
    drawFc();
  }
  function drawFc() {
    const c = $("#fcChart"), W = c.clientWidth, H = c.clientHeight; if (!W || !hours.length) return;
    const dpr = window.devicePixelRatio || 1; c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const L = 38, B = 24, T = 14, vals = hours.map((x) => x.aqi || 0), mx = Math.max(100, ...vals) * 1.1, bw = (W - L - 6) / hours.length;
    const y = (v) => H - B - ((H - B - T) * v) / mx;
    g.font = "11px system-ui,sans-serif"; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const v = (mx * i) / 4; g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W, y(v)); g.stroke(); g.fillStyle = "#a9c9d4"; g.fillText(Math.round(v), 4, y(v) + 4); }
    hours.forEach((x, i) => { if (x.aqi == null) return; g.globalAlpha = i <= nowIdx ? 0.55 : 0.95; g.fillStyle = cpcb(x.aqi).c; g.fillRect(L + i * bw + 0.5, y(x.aqi), Math.max(1, bw - 1), H - B - y(x.aqi)); });
    g.globalAlpha = 1;
    hours.forEach((x, i) => { if (x.t.slice(11, 13) % 12 === 0 && x.t.slice(14, 16) === "00") { g.fillStyle = "#a9c9d4"; g.fillText(x.t.slice(5, 10) + " " + x.t.slice(11, 16), L + i * bw - 20, H - 6); } });
    const nx = L + (nowIdx + 0.5) * bw; g.strokeStyle = "#fff"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(nx, T); g.lineTo(nx, H - B); g.stroke(); g.setLineDash([]); g.fillStyle = "#fff"; g.fillText("now", nx + 4, T + 8);
  }
  $("#fcPlace").addEventListener("change", loadFc);
  addEventListener("resize", () => { if (document.body.dataset.view === "forecast") drawFc(); });
  window.addEventListener("aeronex:place", fillPlaces);

  /* ---------- view hooks + start ---------- */
  window.addEventListener("aeronex:view", (e) => {
    if (e.detail === "heatmap") { if (grid) setTimeout(drawHeat, 30); else loadGrid(); }
    if (e.detail === "forecast") { fillPlaces(); if (!hours.length) loadFc(); else setTimeout(drawFc, 30); }
  });
  fillPlaces(); loadGrid(); setInterval(loadGrid, 15 * 60000);
})();
