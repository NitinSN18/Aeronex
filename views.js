/* Aeronex view router: each nav item opens its own screen (no long scroll). The hardware dock stays visible in every view. */
(() => {
  "use strict";
  const views = [...document.querySelectorAll(".view")];
  const links = [...document.querySelectorAll("#links a[href^='#']")];
  function route() {
    const id = (location.hash || "#home").slice(1) || "home";
    let view = views.find((v) => v.dataset.view === id), target = null;
    if (!view) { target = document.getElementById(id); view = target && target.closest(".view"); }
    if (!view) view = views.find((v) => v.dataset.view === "home");
    const name = view.dataset.view;
    views.forEach((v) => { v.hidden = v !== view; });
    document.body.dataset.view = name;
    links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + name));
    if (target) target.scrollIntoView(); else window.scrollTo({ top: 0, behavior: "instant" });
    window.dispatchEvent(new CustomEvent("aeronex:view", { detail: name }));
  }
  addEventListener("hashchange", route);
  route();
})();
