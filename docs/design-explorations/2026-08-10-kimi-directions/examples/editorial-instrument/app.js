/* insπre — Editorial Instrument prototype interactions.
   Local state only; no network, no persistence, no build step. */
(function () {
  "use strict";

  var root = document.documentElement;
  var mqDrawer = window.matchMedia("(max-width: 899px)");

  /* ---------------- Theme toggle ---------------- */
  var themeToggle = document.getElementById("theme-toggle");

  function setTheme(theme) {
    root.setAttribute("data-theme", theme);
    var dark = theme === "dark";
    themeToggle.setAttribute("aria-pressed", String(dark));
    themeToggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }

  themeToggle.addEventListener("click", function () {
    setTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });

  /* ---------------- Tool execution plate ---------------- */
  var toolToggle = document.getElementById("tool-toggle");
  toolToggle.addEventListener("click", function () {
    toolToggle.setAttribute(
      "aria-expanded",
      toolToggle.getAttribute("aria-expanded") === "true" ? "false" : "true"
    );
  });

  /* ---------------- Reserved search rail ---------------- */
  var searchButton = document.getElementById("search-button");
  var searchClose = document.getElementById("search-close");
  var searchRail = document.getElementById("search-rail");
  var searchInput = document.getElementById("search-input");

  function openSearch() {
    searchRail.hidden = false;
    searchButton.setAttribute("aria-expanded", "true");
    searchInput.focus();
    searchInput.select();
  }

  function closeSearch() {
    searchRail.hidden = true;
    searchButton.setAttribute("aria-expanded", "false");
    searchButton.focus();
  }

  searchButton.addEventListener("click", function () {
    if (searchRail.hidden) openSearch();
  });
  searchClose.addEventListener("click", closeSearch);

  /* ---------------- Settings overlay ---------------- */
  var settingsButton = document.getElementById("settings-button");
  var settingsClose = document.getElementById("settings-close");
  var settingsOverlay = document.getElementById("settings-overlay");
  var settingsDialog = settingsOverlay.querySelector(".dialog");
  var settingsOpener = null;

  function openSettings() {
    settingsOpener = document.activeElement;
    settingsOverlay.hidden = false;
    settingsClose.focus();
  }

  function closeSettings() {
    settingsOverlay.hidden = true;
    if (settingsOpener && typeof settingsOpener.focus === "function") {
      settingsOpener.focus();
    }
    settingsOpener = null;
  }

  settingsButton.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  settingsOverlay.querySelector("[data-close-settings]").addEventListener("click", closeSettings);

  /* Contain Tab within the dialog while it is open. */
  settingsDialog.addEventListener("keydown", function (event) {
    if (event.key !== "Tab") return;
    var focusables = settingsDialog.querySelectorAll(
      'button, select, a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  /* ---------------- Navigation drawer ---------------- */
  var nav = document.getElementById("nav");
  var navToggle = document.getElementById("nav-toggle");
  var navClose = document.getElementById("nav-close");
  var navScrim = document.getElementById("nav-scrim");

  function openNav() {
    nav.classList.add("nav--open");
    navScrim.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
    navToggle.setAttribute("aria-label", "Close navigation");
    navClose.focus();
  }

  function closeNav() {
    nav.classList.remove("nav--open");
    navScrim.hidden = true;
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open navigation");
    navToggle.focus();
  }

  navToggle.addEventListener("click", function () {
    if (nav.classList.contains("nav--open")) closeNav();
    else openNav();
  });
  navClose.addEventListener("click", closeNav);
  navScrim.addEventListener("click", closeNav);

  /* Leaving the drawer breakpoint clears transient drawer state. */
  mqDrawer.addEventListener("change", function (event) {
    if (!event.matches && nav.classList.contains("nav--open")) {
      nav.classList.remove("nav--open");
      navScrim.hidden = true;
      navToggle.setAttribute("aria-expanded", "false");
    }
  });

  /* ---------------- Context pane ---------------- */
  var resourcesToggle = document.getElementById("resources-toggle");
  var ctx = document.getElementById("ctx");
  var ctxClose = document.getElementById("ctx-close");

  function setCtx(open) {
    ctx.hidden = !open;
    resourcesToggle.setAttribute("aria-expanded", String(open));
    resourcesToggle.classList.toggle("icon-btn--active", open);
  }

  resourcesToggle.addEventListener("click", function () {
    setCtx(ctx.hidden);
  });
  ctxClose.addEventListener("click", function () {
    setCtx(false);
    resourcesToggle.focus();
  });

  /* Context pane mode tabs */
  var modes = Array.prototype.slice.call(document.querySelectorAll(".ctx__mode"));
  var panels = Array.prototype.slice.call(document.querySelectorAll(".ctx__body"));
  modes.forEach(function (mode) {
    mode.addEventListener("click", function () {
      modes.forEach(function (m) {
        var active = m === mode;
        m.classList.toggle("ctx__mode--active", active);
        m.setAttribute("aria-selected", String(active));
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.getAttribute("data-panel") !== mode.getAttribute("data-mode");
      });
    });
  });

  /* ---------------- Escape: close the topmost local surface ---------------- */
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (!settingsOverlay.hidden) {
      closeSettings();
    } else if (!searchRail.hidden) {
      closeSearch();
    } else if (nav.classList.contains("nav--open")) {
      closeNav();
    }
  });

  /* ---------------- Composer deck ---------------- */
  var deck = document.getElementById("deck");
  var deckInput = document.getElementById("deck-input");
  var sendButton = deck.querySelector(".deck__send");

  function autogrow() {
    deckInput.style.height = "auto";
    deckInput.style.height = Math.min(deckInput.scrollHeight, window.innerHeight * 0.3) + "px";
  }

  deckInput.addEventListener("input", autogrow);
  autogrow();

  deck.addEventListener("submit", function (event) {
    event.preventDefault();
    /* Prototype: no live Pi runtime behind the deck. */
    deckInput.value = "";
    autogrow();
    deckInput.focus();
  });

  deckInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      deck.requestSubmit();
    }
  });

  /* Keep the send action truthful about empty input. */
  function syncSend() {
    sendButton.disabled = deckInput.value.trim().length === 0;
  }
  deckInput.addEventListener("input", syncSend);
  syncSend();
})();
