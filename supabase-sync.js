/* ===========================================================================
   Supabase auth + cross-device sync for the finance apps.
   Public-safe: uses only the anon/publishable key. Row Level Security keeps
   every customer's data private — this key can never read someone else's rows.

   Each app sets, BEFORE loading this file:
     window.SYNC_CONFIG = { app: 'pnl'|'budget', name: 'P&L', keys: [ ...localStorage keys... ] };
   =========================================================================== */
(function () {
  "use strict";

  var SUPABASE_URL = "https://vanpeuarngjygdgovuux.supabase.co";
  var SUPABASE_KEY = "sb_publishable_Aoek7FjmeL1taZqlqjT4eg_DjU_6jv1";

  var cfg  = window.SYNC_CONFIG || { app: "app", name: "App", keys: [] };
  var KEYS = cfg.keys || [];

  var sb = null;
  var currentUser = null;
  var recovering = false;     // true while handling a password-reset link
  var ready = false;          // true once the initial pull is done (gates pushes)
  var applyingRemote = false; // true while writing cloud data into localStorage
  var pushTimer = null;

  /* ---- 1. Install the localStorage hook SYNCHRONOUSLY (before the app runs) ---- */
  var origSet = window.localStorage.setItem.bind(window.localStorage);
  var origRemove = window.localStorage.removeItem.bind(window.localStorage);
  window.localStorage.setItem = function (k, v) {
    origSet(k, v);
    if (!applyingRemote && KEYS.indexOf(k) >= 0) schedulePush();
  };
  window.localStorage.removeItem = function (k) {
    origRemove(k);
    if (!applyingRemote && KEYS.indexOf(k) >= 0) schedulePush();
  };

  /* ---- 2. Cover the screen immediately so app data never flashes pre-login ---- */
  injectStyles();
  var overlay = buildOverlay();
  (document.body || document.documentElement).appendChild(overlay);
  showLoading();

  /* ---- 3. Load supabase-js, then boot ---- */
  loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", boot, function () {
    setMessage("Couldn't reach the sync service. Check your connection and reload.");
  });

  function boot() {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    // Live prices: the app calls this; the Twelve Data key stays server-side in the Edge Function.
    window.SyncPrices = {
      getQuotes: function (symbols) {
        if (!sb || !currentUser) return Promise.reject(new Error("not signed in"));
        return sb.functions.invoke("get-quotes", { body: { symbols: symbols } })
          .then(function (r) { if (r.error) throw r.error; return (r.data && r.data.prices) || {}; });
      }
    };
    // Arriving via a password-reset link? Show the "set new password" screen, not the app.
    recovering = /type=recovery/.test(window.location.hash || "");
    sb.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (recovering) { renderSetNewPassword(); return; }
      if (session) onLogin(session.user);
      else showLogin();
    });
    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === "PASSWORD_RECOVERY") { recovering = true; renderSetNewPassword(); return; }
      if (recovering) return;
      if (session && !currentUser) onLogin(session.user);
      else if (!session && currentUser) { currentUser = null; location.reload(); }
    });
    // Re-sync on every way of returning to the app. iOS suspends realtime in the background and
    // often restores the page from cache (bfcache) without re-running scripts, so poll all three:
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && ready) syncFromCloud();
    });
    window.addEventListener("pageshow", function (e) { if (e.persisted && ready) syncFromCloud(); });
    window.addEventListener("focus", function () { if (ready) syncFromCloud(); });
  }

  /* ---------------- sync core ---------------- */
  function gather() {
    var o = {};
    KEYS.forEach(function (k) { var v = origGet(k); if (v !== null) o[k] = v; });
    return o;
  }
  function origGet(k) { return window.localStorage.getItem(k); }
  function stateString() { return JSON.stringify(gather()); }

  function applyCloud(obj) {
    applyingRemote = true;
    KEYS.forEach(function (k) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k)) origSet(k, obj[k]);
    });
    applyingRemote = false;
  }
  function clearLocal() {
    applyingRemote = true;
    KEYS.forEach(function (k) { origRemove(k); });
    applyingRemote = false;
  }

  function pull() {
    return sb.from("user_data").select("data").eq("app", cfg.app).maybeSingle()
      .then(function (res) { return res.data ? res.data.data : null; });
  }
  function push() {
    if (!currentUser) return Promise.resolve();
    return sb.from("user_data").upsert(
      { user_id: currentUser.id, app: cfg.app, data: gather() },
      { onConflict: "user_id,app" }
    );
  }
  function schedulePush() {
    if (!ready) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(); }, 800);
  }

  // Order-independent fingerprint of the app state (Postgres reorders JSON keys).
  function canon(o) {
    o = o || {};
    return JSON.stringify(KEYS.map(function (k) { return (k in o) ? o[k] : null; }));
  }

  // Re-render the app in place with whatever is now in storage. No page reload — reloads are
  // unreliable on iOS Safari (it restores cached pages without re-running scripts).
  function rerender() {
    if (typeof window.__resyncApply === "function") { try { window.__resyncApply(); return; } catch (e) {} }
    location.reload();   // fallback if the app didn't expose the hook
  }

  // Pull the latest cloud state; if it differs from what's on screen, apply it and re-render.
  // Called on login and on every "returned to the app" signal.
  function syncFromCloud() {
    if (!currentUser) return Promise.resolve();
    return pull().then(function (cloud) {
      if (cloud && canon(cloud) !== canon(gather())) { applyCloud(cloud); rerender(); }
    }).catch(function () {});
  }

  function onLogin(user) {
    currentUser = user;
    showLoading();
    pull().then(function (cloud) {
      if (cloud && canon(cloud) !== canon(gather())) { applyCloud(cloud); rerender(); }
      else if (!cloud) push();        // first sign-in: seed the cloud from this device
      subscribeRealtime();
      ready = true;
      hideOverlay();
      showBadge(user.email);
    }).catch(function () {
      ready = true; hideOverlay(); showBadge(user.email);
    });
  }

  function subscribeRealtime() {
    sb.channel("sync_" + cfg.app)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "user_data", filter: "app=eq." + cfg.app },
        function (payload) {
          var cloud = payload["new"] && payload["new"].data;
          if (cloud && canon(cloud) !== canon(gather())) { applyCloud(cloud); rerender(); }
        })
      .subscribe();
  }

  /* ---------------- auth UI ---------------- */
  function doAuth(mode) {
    var email = (document.getElementById("sync-email").value || "").trim();
    var pw = document.getElementById("sync-pw").value || "";
    if (!email || !pw) { setError("Enter your email and password."); return; }
    if (pw.length < 6) { setError("Password must be at least 6 characters."); return; }
    setError(""); setBusy(true);
    var p = mode === "signup"
      ? sb.auth.signUp({ email: email, password: pw,
          options: { emailRedirectTo: window.location.origin + window.location.pathname } })
      : sb.auth.signInWithPassword({ email: email, password: pw });
    p.then(function (res) {
      setBusy(false);
      if (res.error) {
        var m = res.error.message || "";
        if (/not confirmed/i.test(m)) { renderConfirmPanel(email, false); return; }
        setError(m);
        return;
      }
      if (mode === "signup" && res.data.user && !res.data.session) {
        renderConfirmPanel(email, true);
        return;
      }
      // onAuthStateChange handles the logged-in case
    }).catch(function () { setBusy(false); setError("Something went wrong. Try again."); });
  }

  function logout() {
    clearLocal();                     // don't leave one customer's data for the next
    sb.auth.signOut().then(function () { location.reload(); });
  }

  /* ---------------- overlay / DOM ---------------- */
  function injectStyles() {
    var css = ""
      + "#sync-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;"
      + "background:#080D1A;color:#EAF2FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;}"
      + "@media (prefers-color-scheme: light){#sync-overlay{background:#F4F6FB;color:#0F1A2E;}}"
      + ":root[data-theme='light'] #sync-overlay{background:#F4F6FB;color:#0F1A2E;}"
      + ":root[data-theme='dark'] #sync-overlay{background:#080D1A;color:#EAF2FB;}"
      + "#sync-card{width:100%;max-width:360px;text-align:center;}"
      + "#sync-card h1{font-size:22px;margin:0 0 4px;font-weight:800;letter-spacing:-.01em;}"
      + "#sync-card p.sub{margin:0 0 22px;opacity:.6;font-size:14px;}"
      + "#sync-card input{width:100%;box-sizing:border-box;padding:13px 14px;margin:7px 0;border-radius:12px;"
      + "border:1px solid rgba(127,140,170,.35);background:rgba(127,140,170,.08);color:inherit;font-size:16px;}"
      + "#sync-card input:focus{outline:none;border-color:#2FD3E1;}"
      + "#sync-primary{width:100%;padding:13px;margin-top:12px;border:0;border-radius:12px;background:#2FD3E1;color:#04222A;"
      + "font-size:16px;font-weight:700;cursor:pointer;}"
      + "#sync-primary:disabled{opacity:.5;cursor:default;}"
      + "#sync-card .sync-pw-wrap{position:relative;margin:7px 0;}"
      + "#sync-card .sync-pw-wrap input{margin:0;padding-right:46px;}"
      + "#sync-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:transparent;"
      + "color:#8FA0BC;cursor:pointer;padding:6px;display:flex;align-items:center;justify-content:center;line-height:0;}"
      + "#sync-eye:hover,#sync-eye:focus{color:#2FD3E1;}"
      + "#sync-card .sync-big-emoji{font-size:38px;margin-bottom:8px;line-height:1;}"
      + "#sync-toggle{margin-top:16px;font-size:14px;opacity:.8;}"
      + "#sync-toggle a{color:#2FD3E1;cursor:pointer;font-weight:600;text-decoration:none;}"
      + "#sync-forgot{margin-top:10px;font-size:13px;}"
      + "#sync-forgot a{color:#8FA0BC;cursor:pointer;text-decoration:none;}"
      + "#sync-forgot a:hover{color:#2FD3E1;}"
      + "#sync-err{min-height:18px;margin-top:12px;font-size:13px;color:#FF7A8C;}"
      + "#sync-spin{width:34px;height:34px;border-radius:50%;border:3px solid rgba(127,140,170,.3);border-top-color:#2FD3E1;"
      + "animation:sync-rot 0.8s linear infinite;margin:0 auto;}"
      + "@keyframes sync-rot{to{transform:rotate(360deg)}}"
      + "#sync-badge{position:fixed;right:14px;bottom:14px;z-index:2147482000;display:flex;align-items:center;gap:8px;"
      + "background:rgba(20,30,50,.85);color:#EAF2FB;border:1px solid rgba(127,140,170,.3);border-radius:999px;"
      + "padding:7px 12px;font:600 12px -apple-system,sans-serif;backdrop-filter:blur(8px);}"
      + "@media (prefers-color-scheme: light){#sync-badge{background:rgba(255,255,255,.9);color:#0F1A2E;box-shadow:0 4px 14px rgba(16,24,40,.12);}}"
      + "#sync-badge button{border:0;background:none;color:#2FD3E1;font:600 12px -apple-system,sans-serif;cursor:pointer;padding:0;}"
      + "#sync-dot{width:7px;height:7px;border-radius:50%;background:#2FE79B;}";
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  }

  function buildOverlay() {
    var d = document.createElement("div");
    d.id = "sync-overlay";
    d.innerHTML =
      '<div id="sync-card">' +
        '<div id="sync-body"></div>' +
      '</div>';
    return d;
  }

  function showLoading() {
    document.getElementById("sync-body").innerHTML = '<div id="sync-spin"></div>';
    overlay.style.display = "flex";
  }

  var EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  var authMode = "login";
  function showLogin() {
    overlay.style.display = "flex";
    render();
    function render() {
      var isSignup = authMode === "signup";
      document.getElementById("sync-body").innerHTML =
        '<h1>' + esc(cfg.name) + '</h1>' +
        '<p class="sub">' + (isSignup ? "Create your account" : "Log in to sync across your devices") + '</p>' +
        '<input id="sync-email" type="email" autocomplete="email" placeholder="Email" />' +
        '<div class="sync-pw-wrap">' +
          '<input id="sync-pw" type="password" autocomplete="' + (isSignup ? "new-password" : "current-password") + '" placeholder="Password" />' +
          '<button type="button" id="sync-eye" aria-label="Show password" tabindex="-1">' + EYE + '</button>' +
        '</div>' +
        '<button id="sync-primary">' + (isSignup ? "Sign up" : "Log in") + '</button>' +
        '<div id="sync-err"></div>' +
        '<div id="sync-toggle">' +
          (isSignup ? "Already have an account? " : "New here? ") +
          '<a id="sync-swap">' + (isSignup ? "Log in" : "Create an account") + '</a>' +
        '</div>' +
        (isSignup ? '' : '<div id="sync-forgot"><a id="sync-forgot-link">Forgot password?</a></div>');
      document.getElementById("sync-primary").onclick = function () { doAuth(authMode); };
      document.getElementById("sync-swap").onclick = function () { authMode = isSignup ? "login" : "signup"; render(); };
      document.getElementById("sync-pw").onkeydown = function (e) { if (e.key === "Enter") doAuth(authMode); };
      var eye = document.getElementById("sync-eye");
      eye.onclick = function () {
        var pw = document.getElementById("sync-pw");
        if (pw.type === "password") { pw.type = "text"; eye.innerHTML = EYE_OFF; eye.setAttribute("aria-label", "Hide password"); }
        else { pw.type = "password"; eye.innerHTML = EYE; eye.setAttribute("aria-label", "Show password"); }
      };
      var forgot = document.getElementById("sync-forgot-link");
      if (forgot) forgot.onclick = function () { renderResetRequest((document.getElementById("sync-email").value || "").trim()); };
    }
  }

  // Shown after signup (justSignedUp=true) OR when login fails because the email isn't confirmed.
  function renderConfirmPanel(email, justSignedUp) {
    overlay.style.display = "flex";
    var lead = justSignedUp
      ? "Check your email to confirm your account. We sent a link to"
      : "Your email isn’t confirmed yet. We sent a link to";
    var tail = justSignedUp
      ? "Tap the link (check spam too) — you’ll be signed in automatically."
      : "Tap the link (check spam too), then come back and log in.";
    document.getElementById("sync-body").innerHTML =
      '<div class="sync-big-emoji">✉️</div>' +
      '<h1>Confirm your email</h1>' +
      '<p class="sub">' + lead + '<br><b>' + esc(email) + '</b><br>' + tail + '</p>' +
      '<button id="sync-primary">Resend the email</button>' +
      '<div id="sync-err"></div>' +
      // After signup we intentionally offer NO "log in" path — the user must confirm first.
      (justSignedUp ? '' : '<div id="sync-toggle"><a id="sync-back">Back to log in</a></div>');
    document.getElementById("sync-primary").onclick = function () { resendConfirm(email); };
    var back = document.getElementById("sync-back");
    if (back) back.onclick = function () { authMode = "login"; showLogin(); };
  }

  function resendConfirm(email) {
    setError(""); setBusy(true);
    sb.auth.resend({ type: "signup", email: email }).then(function (res) {
      setBusy(false);
      if (res.error) setError(res.error.message);
      else setInfo("Sent! Check your inbox and spam for the link.");
    }).catch(function () { setBusy(false); setError("Couldn't resend — try again in a moment."); });
  }

  // Step 1 of reset: ask for the email, send a reset link.
  function renderResetRequest(email) {
    overlay.style.display = "flex";
    document.getElementById("sync-body").innerHTML =
      '<h1>Reset your password</h1>' +
      '<p class="sub">Enter your email and we’ll send you a link to set a new password.</p>' +
      '<input id="sync-email" type="email" autocomplete="email" placeholder="Email" value="' + esc(email || "") + '" />' +
      '<button id="sync-primary">Send reset link</button>' +
      '<div id="sync-err"></div>' +
      '<div id="sync-toggle"><a id="sync-back">Back to log in</a></div>';
    document.getElementById("sync-primary").onclick = function () {
      resetRequest((document.getElementById("sync-email").value || "").trim());
    };
    document.getElementById("sync-back").onclick = function () { authMode = "login"; showLogin(); };
  }

  function resetRequest(email) {
    if (!email) { setError("Enter your email."); return; }
    setError(""); setBusy(true);
    sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname })
      .then(function (res) {
        setBusy(false);
        if (res.error) setError(res.error.message);
        else setInfo("Sent! Check your email for the reset link.");
      }).catch(function () { setBusy(false); setError("Couldn't send — try again in a moment."); });
  }

  // Step 2 of reset: shown after the user taps the emailed link (PASSWORD_RECOVERY).
  function renderSetNewPassword() {
    overlay.style.display = "flex";
    document.getElementById("sync-body").innerHTML =
      '<h1>Set a new password</h1>' +
      '<p class="sub">Choose a new password for your account.</p>' +
      '<div class="sync-pw-wrap">' +
        '<input id="sync-newpw" type="password" autocomplete="new-password" placeholder="New password" />' +
        '<button type="button" id="sync-eye" aria-label="Show password" tabindex="-1">' + EYE + '</button>' +
      '</div>' +
      '<button id="sync-primary">Update password</button>' +
      '<div id="sync-err"></div>';
    var eye = document.getElementById("sync-eye");
    eye.onclick = function () {
      var pw = document.getElementById("sync-newpw");
      if (pw.type === "password") { pw.type = "text"; eye.innerHTML = EYE_OFF; }
      else { pw.type = "password"; eye.innerHTML = EYE; }
    };
    document.getElementById("sync-primary").onclick = function () {
      var pw = document.getElementById("sync-newpw").value || "";
      if (pw.length < 6) { setError("Password must be at least 6 characters."); return; }
      setError(""); setBusy(true);
      sb.auth.updateUser({ password: pw }).then(function (res) {
        setBusy(false);
        if (res.error) { setError(res.error.message); return; }
        setInfo("Password updated! Signing you in…");
        recovering = false;
        try { history.replaceState(null, "", window.location.pathname); } catch (e) {}
        location.reload();
      }).catch(function () { setBusy(false); setError("Couldn't update — try again."); });
    };
  }

  function setError(m) { var e = document.getElementById("sync-err"); if (e) { e.textContent = m; e.style.color = ""; } }
  function setInfo(m) { var e = document.getElementById("sync-err"); if (e) { e.textContent = m; e.style.color = "#2FD3E1"; } }
  function setMessage(m) { document.getElementById("sync-body").innerHTML = '<p class="sub">' + esc(m) + '</p>'; }
  function setBusy(b) {
    var btn = document.getElementById("sync-primary");
    if (!btn) return;
    if (b) { btn.setAttribute("data-label", btn.textContent); btn.disabled = true; btn.textContent = "…"; }
    else { btn.disabled = false; var l = btn.getAttribute("data-label"); if (l) btn.textContent = l; }
  }
  function hideOverlay() { overlay.style.display = "none"; }

  function showBadge(email) {
    if (document.getElementById("sync-badge")) return;
    var b = document.createElement("div");
    b.id = "sync-badge";
    b.innerHTML = '<span id="sync-dot"></span><span>' + esc(email) + '</span><button id="sync-out">Log out</button>';
    document.body.appendChild(b);
    document.getElementById("sync-out").onclick = logout;
  }

  function loadScript(src, ok, err) {
    var s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = err;
    document.head.appendChild(s);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
})();
