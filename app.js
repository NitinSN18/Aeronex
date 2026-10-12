/* Aeronex landing: animated sky, live public snapshot, scroll reveals. No dependencies. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const CATS = [ // CPCB AQI bands
    { max: 50, name: "Good", c: "#00b050" }, { max: 100, name: "Satisfactory", c: "#92d050" },
    { max: 200, name: "Moderate", c: "#ffc000" }, { max: 300, name: "Poor", c: "#ff7c00" },
    { max: 400, name: "Very Poor", c: "#ff0000" }, { max: 9999, name: "Severe", c: "#a00000" },
  ];
  const cat = (v) => CATS.find((x) => v <= x.max);

  /* ---------- basic sign-in: name + password ----------
     NOTE: this runs in the browser only, so it is a simple gate, not real security.
     Edit USERS to add or change accounts. */
  const USERS = [{ name: "admin", password: "aeronex" }];
  const SESSION_KEY = "aeronex.user";
  let me = null;                           // signed-in name, or null
  try { me = localStorage.getItem(SESSION_KEY); } catch { me = null; }
  const navAuth = $("#navAuth"), modal = $("#loginModal");
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderAuth() {
    if (me) {
      navAuth.innerHTML = `<span class="nav-chip"><i></i>${esc(me)}</span><button class="btn-out" id="btnOut" type="button">Sign out</button>`;
      $("#btnOut").addEventListener("click", signOut);
    } else {
      navAuth.innerHTML = `<a class="btn btn-primary nav-cta" href="#" data-login>Sign in</a>`;
    }
    $$("[data-login]").forEach((el) => {
      if (el.id === "mobAuth") { el.textContent = me ? "Sign out" : "Sign in"; return; }
      if (!navAuth.contains(el)) el.hidden = !!me;      // page buttons disappear once signed in
    });
  }
  function signOut() { me = null; try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } renderAuth(); }

  function openLogin() {
    $("#inErr").textContent = ""; modal.hidden = false; document.body.style.overflow = "hidden";
    setTimeout(() => $("#inUser").focus(), 30);
  }
  function closeLogin() { modal.hidden = true; document.body.style.overflow = ""; }
  $("#lmClose").addEventListener("click", closeLogin);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeLogin(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeLogin(); });

  $("#formIn").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#inUser").value.trim(), pass = $("#inPass").value;
    const ok = USERS.find((u) => u.name.toLowerCase() === name.toLowerCase() && u.password === pass);
    if (!ok) { $("#inErr").textContent = "Wrong name or password."; return; }
    me = ok.name; try { localStorage.setItem(SESSION_KEY, me); } catch { /* ignore */ }
    $("#inPass").value = ""; closeLogin(); renderAuth();
  });

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-login]");
    if (!el) return;
    e.preventDefault();
    links.classList.remove("open");
    if (me) { if (el.id === "mobAuth") signOut(); return; }
    openLogin();
  });
  renderAuth();
  if (!me && new URLSearchParams(location.search).get("login")) openLogin();

  /* ---------- navbar ---------- */
  const nav = $("#nav"), burger = $("#burger"), links = $("#links");
  const onScroll = () => nav.classList.toggle("solid", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
  burger.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    burger.setAttribute("aria-expanded", open);
  });
  links.addEventListener("click", (e) => { if (e.target.tagName === "A") { links.classList.remove("open"); burger.setAttribute("aria-expanded", false); } });
  /* ---------- scroll reveal (staggered inside grids) ---------- */
  $$(".cards,.zones,.steps,.two,.stat-strip").forEach((g) => $$(".reveal", g).forEach((el, i) => el.style.setProperty("--d", i * 0.08 + "s")));
  const rev = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); rev.unobserve(e.target); } }), { threshold: 0.12 });
  $$(".reveal").forEach((el) => (reduce ? el.classList.add("in") : rev.observe(el)));

  /* ---------- animated sky: drifting particles that react to the pointer, tinted by city AQI ---------- */
  const cv = $("#sky"), cx = cv.getContext("2d");
  let W = 0, H = 0, dots = [], tint = [94, 234, 212], mouse = { x: -999, y: -999 };
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2), r = cv.getBoundingClientRect();
    W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(150, (W * H) / 11000));
    dots = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H, r: 0.8 + Math.random() * 2.8,
      vx: 0.12 + Math.random() * 0.45, vy: (Math.random() - 0.5) * 0.14, a: 0.25 + Math.random() * 0.5, p: Math.random() * 6.28,
    }));
  };
  addEventListener("resize", resize); resize();
  cv.parentElement.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  cv.parentElement.addEventListener("pointerleave", () => (mouse = { x: -999, y: -999 }));
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const setTint = (c) => { tint = hex(c); };
  let t0 = 0, visible = true;
  new IntersectionObserver((e) => (visible = e[0].isIntersecting)).observe(cv);
  const frame = (t) => {
    requestAnimationFrame(frame);
    if (!visible) return;
    cx.clearRect(0, 0, W, H);
    const [R, G, B] = tint;
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy + Math.sin(t / 1800 + d.p) * 0.12;
      const dx = d.x - mouse.x, dy = d.y - mouse.y, dist = Math.hypot(dx, dy);
      if (dist < 110) { d.x += (dx / dist) * 1.6; d.y += (dy / dist) * 1.6; }   // particles scatter away from the cursor
      if (d.x > W + 10) { d.x = -10; d.y = Math.random() * H; }
      if (d.y < -10) d.y = H + 10; if (d.y > H + 10) d.y = -10;
      cx.beginPath(); cx.arc(d.x, d.y, d.r, 0, 6.283);
      cx.fillStyle = `rgba(${R},${G},${B},${d.a * (0.7 + 0.3 * Math.sin(t / 900 + d.p))})`; cx.fill();
    }
    for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {  // faint links between near particles
      const a = dots[i], b = dots[j], dd = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (dd < 8100) { cx.strokeStyle = `rgba(${R},${G},${B},${0.13 * (1 - dd / 8100)})`; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke(); }
    }
  };
  if (!reduce) requestAnimationFrame(frame);

  /* ---------- number tween ---------- */
  const tween = (el, to, ms = 1100) => {
    const from = parseFloat(el.dataset.v || "0") || 0; el.dataset.v = to;
    if (reduce || isNaN(to)) { el.textContent = to; return; }
    const s = performance.now();
    const step = (n) => { const k = Math.min(1, (n - s) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };

  /* ---------- live public snapshot ---------- */
  const zonesEl = $("#zones");
  zonesEl.innerHTML = Array.from({ length: 6 }, () => `<div class="zone skel reveal"><h3>Loading&hellip;</h3><div class="row"><span class="aqi">--</span></div><div class="bar"><i></i></div></div>`).join("");
  $$(".zone", zonesEl).forEach((z, i) => { z.style.setProperty("--d", i * 0.08 + "s"); rev.observe(z); });

  const setGauge = (v) => {
    const arc = $("#gArc"), c = cat(v), frac = Math.min(1, v / 500);
    arc.style.setProperty("--gc", c.c); $(".gauge-card").style.setProperty("--gc", c.c);
    arc.style.strokeDashoffset = 528 * (1 - frac);
    tween($("#gNum"), v); $("#gCat").textContent = c.name; setTint(c.c);
  };

  /* shared with live.js: zone cards can come from the backend OR from the browser-side reference feed */
  const AX = (window.Aeronex = window.Aeronex || {});
  function renderZoneCards(zones) {
    zonesEl.innerHTML = zones.map((z, i) => {
      const c = z.aqi != null ? cat(z.aqi) : null;
      const sub = z.note || (z.pm25 != null ? "PM2.5 ~ " + z.pm25.toFixed(0) + " µg/m³ (smoothed)" : "No reading yet");
      return `<article class="zone reveal in" style="--zc:${c ? c.c : "#cbd5e1"};--d:${i * 0.06}s">
        <h3>${esc(z.name)}</h3>
        <div class="row"><span class="aqi" data-v="0" data-t="${z.aqi ?? ""}">${z.aqi ?? "--"}</span>${c ? `<span class="cat">${c.name}</span>` : ""}</div>
        <div class="bar"><i data-w="${z.aqi != null ? Math.min(100, (z.aqi / 500) * 100) : 0}"></i></div>
        <small>${esc(sub)}</small></article>`;
    }).join("");
    requestAnimationFrame(() => {
      $$(".zone .bar i", zonesEl).forEach((b) => (b.style.width = b.dataset.w + "%"));
      $$(".zone .aqi", zonesEl).forEach((a) => a.dataset.t && tween(a, +a.dataset.t));
    });
  }
  AX.cat = cat; AX.setGauge = setGauge; AX.renderZoneCards = renderZoneCards; AX.backend = null;

  async function refresh() {
    let s;
    try {
      const r = await fetch("/v1/public/summary", { cache: "no-store" });
      if (!r.ok) throw new Error("backend " + r.status);
      s = await r.json();
    } catch { return offline(); }
    AX.backend = true;
    if (s.city.aqi_avg != null) { setGauge(s.city.aqi_avg); $("#gFoot").textContent = "Average of " + s.zones.filter((z) => z.aqi != null).length + " zones - indicative, prototype sensors"; }
    else { $("#gCat").textContent = "waiting for data"; }
    renderZoneCards(s.zones);
    $("#stOnline").textContent = s.network.online + " / " + s.network.devices;
    $("#stWorst").textContent = s.city.worst_zone ? s.city.worst_aqi : "--";
    $("#stWorst").nextElementSibling.textContent = s.city.worst_zone ? "highest: " + s.city.worst_zone.split(" ")[0] : "highest zone right now";
  }
  function offline() {
    AX.backend = false;                       // no backend: live.js fills the cards from the Open-Meteo reference feed
    if (AX.onOffline) AX.onOffline();
    else { $("#gCat").textContent = "live feed offline"; $("#gFoot").textContent = "Start the backend to see live values"; }
  }
  refresh(); setInterval(refresh, 15000);
})();
