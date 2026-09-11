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
  window.biometricLockEnabled = function () { try { return localStorage.getItem(LOCK_KEY) === "1"; } catch (e) { return false; } };  // default OFF — opt-in from Settings; never locks a new user or an App Review device
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
      B.verifyIdentity({ reason: "Unlock " + APP_NAME, title: APP_NAME, subtitle: "", description: "",
                         useFallback: true, fallbackTitle: "Use Passcode" })   // device passcode fallback so no one is ever trapped
        .then(hideVeil)
        .catch(function () { /* failed / cancelled — stay locked, user taps Unlock to retry (Face ID or passcode) */ });
    }).catch(function () { hideVeil(); });
  }

  if (!isNative) return;   // ---- everything below is native-only ----

  // Status bar: light glyphs on the dark brand background; branded splash then reveal.
  try { P.StatusBar && P.StatusBar.setStyle({ style: "DARK" }); } catch (e) {}
  try { P.StatusBar && P.StatusBar.setBackgroundColor({ color: "#080D1A" }); } catch (e) {}
  try { P.SplashScreen && P.SplashScreen.hide(); } catch (e) {}

  // ---------- Native CSV export: write a real .csv file, then hand it to the iOS Share sheet ----------
  // index.html calls this hook when it exists (native only). WKWebView can't download a blob, so we
  // write the file to the cache and share it (Save to Files / Mail / …).
  window.__exportCSVFile = function (name, csv) {
    var FS = P.Filesystem, Sh = P.Share;
    function shareText() { if (Sh && Sh.share) { try { Sh.share({ title: name, text: csv, dialogTitle: "Export " + name }); } catch (e) {} } }
    if (!FS || !FS.writeFile || !Sh || !Sh.share) { shareText(); return; }   // no Filesystem plugin → share text
    try {
      FS.writeFile({ path: name, data: csv, directory: "CACHE", encoding: "utf8" }).then(function (res) {
        var uri = res && res.uri;
        if (!uri) { shareText(); return; }
        Sh.share({ title: name, files: [uri], dialogTitle: "Export " + name }).catch(function () {});
      }).catch(function () { shareText(); });
    } catch (e) { shareText(); }
  };

  // ---------- Ask for an App Store rating at a genuine "win" moment (native only) ----------
  // index.html calls this after the user logs a trade. We wait until they're clearly engaged
  // (10+ logged entries) and then ask iOS ONCE; iOS itself decides whether to actually show the
  // prompt and caps it at 3/year, so we never nag. Never fired on launch or from a button.
  window.__maybeAskReview = function () {
    var SK = P.StoreKit;
    if (!SK || !SK.requestReview) return;                        // plugin/method absent → no-op
    var COUNT_KEY = "native.review.events", ASKED_KEY = "native.review.asked", THRESHOLD = 10;
    try {
      if (localStorage.getItem(ASKED_KEY) === "1") return;       // only ask once, ever
      var n = (parseInt(localStorage.getItem(COUNT_KEY), 10) || 0) + 1;
      localStorage.setItem(COUNT_KEY, String(n));
      if (n < THRESHOLD) return;                                 // not engaged enough yet
      localStorage.setItem(ASKED_KEY, "1");
      SK.requestReview().catch(function () {});                  // iOS decides whether to show it
    } catch (e) {}
  };

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
    var SK = P.StoreKit || P.PlayBilling;   // iOS → StoreKit, Android → Play Billing (same JS interface)
    if (!SK) return;                    // neither plugin present → don't trap the user (fail open)

    var html = document.documentElement;
    var appName = (window.SYNC_CONFIG && window.SYNC_CONFIG.app) || "pnl";
    function isDemoNow() { try { return localStorage.getItem("__demo_" + appName) === "1"; } catch (e) { return false; } }
    function show() { pw.hidden = false; html.style.overflow = "hidden"; }
    function hide() { pw.hidden = true; html.style.overflow = ""; }
    // Never trap someone who is just previewing the app with sample data (guest demo).
    function gate(active) { (active || isDemoNow()) ? hide() : show(); }
    function openUrl(u) {
      try { if (P.Browser && P.Browser.open) { P.Browser.open({ url: u }); return; } } catch (e) {}
      try { window.open(u, "_system"); } catch (e) { try { window.open(u, "_blank"); } catch (e2) {} }
    }

    // Show the paywall up front (unless the user is already previewing the demo); reveal the app
    // once an active entitlement — or a demo preview — is confirmed.
    gate(false);

    // "Just looking? Preview with sample data" — drop into the guest demo, no subscription needed.
    var previewBtn = document.getElementById("pw-preview");
    if (previewBtn) previewBtn.addEventListener("click", function () {
      if (window.nativeTap) window.nativeTap("LIGHT");
      try { if (window.__enterDemo) window.__enterDemo(); } catch (e) {}
      hide();
    });

    var subBtn = document.getElementById("pw-subscribe");
    if (subBtn) subBtn.addEventListener("click", function () {
      if (window.nativeTap) window.nativeTap("MEDIUM");
      var label = subBtn.textContent; subBtn.disabled = true; subBtn.textContent = "Starting…";
      // Tag the purchase with the signed-in account (if any); link after so web access unlocks too.
      SK.purchase({ accountToken: window.__financeUserId || null }).then(function (r) {
        if (r && r.active && window.__financeToken) { try { window.__linkSubscription(); } catch (e) {} }
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

  // ---------- Link the Apple subscription to the signed-in account (for web / cross-device access) ----------
  var FUNCTIONS_URL = "https://vanpeuarngjygdgovuux.supabase.co/functions/v1";
  window.__linkSubscription = function () {
    var SK = P.StoreKit;
    var token = window.__financeToken;
    if (!SK || !SK.syncTransaction || !token) return;
    try {
      SK.syncTransaction().then(function (r) {
        if (!r || !r.jws) return;                 // nothing active to claim
        fetch(FUNCTIONS_URL + "/sync-subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
          body: JSON.stringify({ jws: r.jws })
        }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  };
  // supabase-sync calls this when a user signs in / restores a session → claims the subscription.
  window.__onSignedIn = function (userId, token) {
    window.__financeUserId = userId; window.__financeToken = token;
    window.__linkSubscription();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPaywall);
  else initPaywall();
})();
