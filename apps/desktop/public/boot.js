// Before the first paint: theme, contrast and motion from the stored settings, so a dark app never
// flashes white. The same resolution as @uwusuite/design's bootScript(); the settings sit under
// `state` because the store persists through zustand. A file of its own, because the CSP allows no
// inline script.
(function () {
  try {
    var stored = JSON.parse(localStorage.getItem("uwumail.settings") || "{}");
    var s = (stored && stored.state) || {};
    var m = function (q) {
      return matchMedia(q).matches;
    };
    var r = document.documentElement;
    var t = s.theme || "system";
    r.dataset.theme = t === "system" ? (m("(prefers-color-scheme: dark)") ? "dark" : "light") : t;
    var c = s.contrast || "system";
    r.dataset.contrast = c === "system" ? (m("(prefers-contrast: more)") ? "high" : "normal") : c;
    var o = s.motion || "system";
    r.dataset.motion =
      o === "system" ? (m("(prefers-reduced-motion: reduce)") ? "reduced" : "full") : o === "on" ? "full" : "reduced";
  } catch (e) {}
})();
