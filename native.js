/* native.js — turns on native-only features when the app runs inside the Capacitor
   shell (iOS / Android). On the plain web (GitHub Pages) every path is a safe no-op,
   so the same file ships to both the website and the app stores unchanged.

   Features (the "does more than a webpage" signals Apple's Guideline 4.2 looks for):
     • Face ID / Touch ID / biometric app-lock  (opt-in, remembered per device)
     • Haptic feedback on key actions           (window.nativeTap)
     • Native share sheet                        (window.nativeShare)
     • Themed status bar + branded splash screen
*/
(function () {
  "use strict";

  var Cap = window.Capacitor;
  var isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  var P = (Cap && Cap.Plugins) || {};
  var APP_NAME = (window.SYNC_CONFIG && window.SYNC_CONFIG.name) || document.title || "This app";

  // ---------- Haptics: a light tap on primary actions (available app-wide) ----------
  window.nativeTap = function (style) {
    if (!isNative || !P.Haptics) return;
    try { P.Haptics.impact({ style: style || "LIGHT" }); } catch (e) {}
  };

  // ---------- Native share sheet (falls back to the Web Share API in a browser) ----------
  window.canNativeShare = function () { return (isNative && !!P.Share) || !!navigator.share; };
  window.nativeShare = function (opts) {
    try {
      if (isNative && P.Share) return P.Share.share(opts);
      if (navigator.share) return navigator.share(opts);
    } catch (e) {}
  };

  // ---------- Biometric app-lock ----------
  var LOCK_KEY = "native.biometric.lock";
  window.biometricLockEnabled = function () { try { return localStorage.getItem(LOCK_KEY) !== "0"; } catch (e) { return false; } };  // default ON
  window.biometricLockSupported = function () { return isNative && !!P.NativeBiometric; };
  window.setBiometricLock = function (on) {
    try { localStorage.setItem(LOCK_KEY, on ? "1" : "0"); } catch (e) {}
    if (on) tryUnlock();                 // prompt right away so the toggle feels responsive
    else hideVeil();
  };

  function showVeil() {
    if (document.getElementById("native-lock")) return;
    var v = document.createElement("div");
    v.id = "native-lock";
    v.setAttribute("role", "dialog");
    v.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:#080D1A;color:#EAF2FB;" +
      "display:flex;align-items:center;justify-content:center;font:600 15px -apple-system,system-ui,sans-serif;";
    v.innerHTML =
      "<div style='text-align:center;padding:24px'>" +
        "<div style='font-size:40px;line-height:1;margin-bottom:14px'>🔒</div>" +
        "<div style='opacity:.7;margin-bottom:18px'>" + APP_NAME + " is locked</div>" +
        "<button id='native-unlock' style='background:#2FD3E1;color:#04222A;border:0;border-radius:12px;" +
          "padding:12px 26px;font:600 15px -apple-system,system-ui,sans-serif;cursor:pointer'>Unlock</button>" +
      "</div>";
    document.body.appendChild(v);
    document.getElementById("native-unlock").onclick = tryUnlock;
  }
  function hideVeil() { var v = document.getElementById("native-lock"); if (v) v.remove(); }

  function tryUnlock() {
    var B = P.NativeBiometric;
    if (!B) { hideVeil(); return; }                       // plugin absent → never trap the user
    B.isAvailable().then(function (r) {
      if (!r || !r.isAvailable) { hideVeil(); return; }   // no Face ID enrolled → let them in
      B.verifyIdentity({ reason: "Unlock " + APP_NAME, title: APP_NAME, subtitle: "", description: "" })
        .then(hideVeil)
        .catch(function () { /* failed / cancelled — stay locked, user taps Unlock to retry */ });
    }).catch(function () { hideVeil(); });
  }

  if (!isNative) return;   // ---- everything below is native-only ----

  // Status bar: light glyphs on the dark brand background; branded splash then reveal.
  try { P.StatusBar && P.StatusBar.setStyle({ style: "DARK" }); } catch (e) {}
  try { P.StatusBar && P.StatusBar.setBackgroundColor({ color: "#080D1A" }); } catch (e) {}
  try { P.SplashScreen && P.SplashScreen.hide(); } catch (e) {}

  // Lock on cold start, and whenever the app returns from the background. Going to the
  // background drops the veil immediately so account data isn't shown in the app switcher.
  if (window.biometricLockEnabled()) { showVeil(); tryUnlock(); }
  if (P.App) {
    try {
      P.App.addListener("appStateChange", function (s) {
        if (!window.biometricLockEnabled()) return;
        if (s && s.isActive) tryUnlock(); else showVeil();
      });
    } catch (e) {}
  }
})();
