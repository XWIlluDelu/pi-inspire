/* Trace workbench prototype — interaction wiring.
   No dependencies, no network. All state is presentation-only. */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;

  function $(id) { return doc.getElementById(id); }

  /* ---------- theme ---------- */
  var themeToggle = $("theme-toggle");
  themeToggle.addEventListener("click", function () {
    var dark = root.getAttribute("data-theme") !== "dark";
    root.setAttribute("data-theme", dark ? "dark" : "light");
    themeToggle.setAttribute("aria-pressed", String(dark));
    themeToggle.setAttribute("aria-label", dark ? "切换到浅色主题" : "切换到深色主题");
  });

  /* ---------- tool plate expand / collapse ---------- */
  var toolToggle = $("tool-toggle");
  toolToggle.addEventListener("click", function () {
    var plate = toolToggle.closest(".plate");
    var expanded = toolToggle.getAttribute("aria-expanded") === "true";
    toolToggle.setAttribute("aria-expanded", String(!expanded));
    toolToggle.setAttribute("aria-label", expanded ? "展开工具详情" : "折叠工具详情");
    plate.classList.toggle("plate--collapsed", expanded);
  });

  /* ---------- search rail (reserved row, never overlays) ---------- */
  var searchRail = $("search-rail");
  var searchButton = $("search-button");
  var searchClose = $("search-close");
  var searchInput = $("search-input");

  function openSearch() {
    if (!searchRail.hidden) return;
    searchRail.hidden = false;
    searchButton.setAttribute("aria-expanded", "true");
    searchInput.focus();
  }
  function closeSearch() {
    if (searchRail.hidden) return;
    searchRail.hidden = true;
    searchButton.setAttribute("aria-expanded", "false");
    searchButton.focus();
  }
  searchButton.setAttribute("aria-expanded", "false");
  searchButton.setAttribute("aria-controls", "search-rail");
  searchButton.addEventListener("click", openSearch);
  searchClose.addEventListener("click", closeSearch);

  searchInput.addEventListener("input", function () {
    $("search-count").textContent = searchInput.value.trim() ? "3 / 3" : "0 / 0";
  });

  /* ---------- settings overlay ---------- */
  var settingsButton = $("settings-button");
  var settingsDialog = $("settings-dialog");
  var settingsScrim = $("settings-scrim");
  var settingsClose = $("settings-close");

  function openSettings() {
    settingsDialog.hidden = false;
    settingsScrim.hidden = false;
    settingsClose.focus();
  }
  function closeSettings() {
    if (settingsDialog.hidden) return;
    settingsDialog.hidden = true;
    settingsScrim.hidden = true;
    settingsButton.focus();
  }
  settingsButton.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  settingsScrim.addEventListener("click", closeSettings);

  /* focus containment inside the dialog */
  settingsDialog.addEventListener("keydown", function (event) {
    if (event.key !== "Tab") return;
    var focusables = settingsDialog.querySelectorAll(
      "button, select, input, textarea, [tabindex]:not([tabindex='-1'])"
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  /* theme select mirrors the toggle for coherence */
  $("f-theme").addEventListener("change", function (event) {
    var value = event.target.value;
    var dark = value === "深色" || (value === "跟随系统" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    themeToggle.setAttribute("aria-pressed", String(dark));
  });

  /* ---------- navigation drawer (narrow viewports) ---------- */
  var nav = $("nav");
  var navToggle = $("nav-toggle");
  var navClose = $("nav-close");
  var navScrim = $("nav-scrim");

  function openNav() {
    nav.classList.add("is-open");
    navScrim.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
    navToggle.setAttribute("aria-label", "关闭导航");
  }
  function closeNav() {
    if (!nav.classList.contains("is-open")) return;
    nav.classList.remove("is-open");
    navScrim.hidden = true;
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "打开导航");
  }
  navToggle.addEventListener("click", function () {
    if (nav.classList.contains("is-open")) closeNav(); else openNav();
  });
  /* in-drawer close restores focus to the opener */
  navClose.addEventListener("click", function () {
    closeNav();
    navToggle.focus();
  });
  navScrim.addEventListener("click", closeNav);
  nav.addEventListener("click", function (event) {
    if (event.target.closest(".ledger__row") && window.innerWidth < 900) closeNav();
  });

  /* ---------- resources pane ---------- */
  var pane = $("pane");
  var paneToggle = $("pane-toggle");
  /* below the three-column floor the pane starts closed so it never
     covers the conversation it belongs to */
  if (window.innerWidth < 1180) {
    pane.hidden = true;
    paneToggle.setAttribute("aria-expanded", "false");
  }
  paneToggle.addEventListener("click", function () {
    var open = pane.hidden;
    pane.hidden = !open;
    paneToggle.setAttribute("aria-expanded", String(open));
  });

  var modes = Array.prototype.slice.call(doc.querySelectorAll(".mode"));
  var panels = {
    files: $("pane-files"),
    changes: $("pane-changes"),
    history: $("pane-history")
  };
  function selectMode(name) {
    modes.forEach(function (mode) {
      var active = mode.getAttribute("data-mode") === name;
      mode.classList.toggle("is-active", active);
      mode.setAttribute("aria-selected", String(active));
    });
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
  }
  modes.forEach(function (mode) {
    mode.addEventListener("click", function () {
      selectMode(mode.getAttribute("data-mode"));
    });
  });
  /* git summary opens the Changes mode, per workbench spec */
  $("git-summary").addEventListener("click", function () {
    pane.hidden = false;
    paneToggle.setAttribute("aria-expanded", "true");
    selectMode("changes");
  });

  /* ---------- Escape closes topmost overlay ---------- */
  doc.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (!settingsDialog.hidden) { closeSettings(); return; }
    if (!searchRail.hidden) { closeSearch(); return; }
    closeNav();
  });

  /* ---------- copy actions (local, no network) ---------- */
  Array.prototype.forEach.call(doc.querySelectorAll(".code__copy"), function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.closest(".code").querySelector("pre");
      var done = function () {
        btn.textContent = "已复制";
        setTimeout(function () { btn.textContent = "复制"; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code.textContent).then(done, done);
      } else {
        done();
      }
    });
  });
})();
