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

  // ---------- P&L Pro subscription gate (on-device StoreKit; native only) ----------
  function initPaywall() {
    var pw = document.getElementById("pw-overlay");
    if (!pw) return;
    var SK = P.StoreKit;
    if (!SK) return;                    // plugin absent → don't trap the user (fail open)

    var html = document.documentElement;
    function show() { pw.hidden = false; html.style.overflow = "hidden"; }
    function hide() { pw.hidden = true; html.style.overflow = ""; }
    function gate(active) { active ? hide() : show(); }
    function openUrl(u) {
      try { if (P.Browser && P.Browser.open) { P.Browser.open({ url: u }); return; } } catch (e) {}
      try { window.open(u, "_system"); } catch (e) { try { window.open(u, "_blank"); } catch (e2) {} }
    }

    // Show the paywall up front; reveal the app only once an active entitlement is confirmed.
    show();

    var subBtn = document.getElementById("pw-subscribe");
    if (subBtn) subBtn.addEventListener("click", function () {
      if (window.nativeTap) window.nativeTap("MEDIUM");
      var label = subBtn.textContent; subBtn.disabled = true; subBtn.textContent = "Starting…";
      SK.purchase().then(function (r) {
        subBtn.disabled = false; subBtn.textContent = label;
        if (r && r.active) gate(true);
      }).catch(function () { subBtn.disabled = false; subBtn.textContent = label; });
    });

    var restoreBtn = document.getElementById("pw-restore");
    if (restoreBtn) restoreBtn.addEventListener("click", function () {
      SK.restore().then(function (r) {
        if (r && r.active) gate(true);
        else alert("No active subscription was found for this Apple Account.");
      }).catch(function () { alert("Couldn't restore right now. Please try again."); });
    });

    var termsBtn = document.getElementById("pw-terms");
    if (termsBtn) termsBtn.addEventListener("click", function () { openUrl("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/"); });
    var privBtn = document.getElementById("pw-privacy");
    if (privBtn) privBtn.addEventListener("click", function () { openUrl("https://finance-apps-ac.github.io/pnl-journal/privacy.html"); });

    // Keep price copy in sync with the App Store; drop "free trial" wording if the user isn't eligible.
    try {
      SK.getProduct().then(function (p) {
        if (!p) return;
        var priceEl = document.getElementById("pw-price"),
            trialEl = document.getElementById("pw-trial"),
            cta = document.getElementById("pw-subscribe");
        if (priceEl && p.displayPrice) priceEl.textContent = "then " + p.displayPrice + "/month";
        if (p.introEligible === false) {
          if (trialEl) trialEl.textContent = (p.displayPrice || "$2.99") + "/month";
          if (priceEl) priceEl.textContent = "billed monthly";
          if (cta) cta.textContent = "Subscribe";
        }
      }).catch(function () {});
    } catch (e) {}

    // Live updates (renewals / Ask-to-Buy approvals / expiry) + re-check on foreground.
    try { SK.addListener("entitlementChanged", function (d) { gate(!!(d && d.active)); }); } catch (e) {}
    function check() { SK.checkEntitlement().then(function (r) { gate(!!(r && r.active)); }).catch(function () {}); }
    check();
    if (P.App) { try { P.App.addListener("appStateChange", function (s) { if (s && s.isActive) check(); }); } catch (e) {} }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPaywall);
  else initPaywall();
})();
