/* ===========================================================================
   Supabase auth + cross-device sync for the finance apps.
   Public-safe: uses only the anon/publishable key. Row Level Security keeps
   every customer's data private — this key can never read someone else's rows.

   Each app sets, BEFORE loading this file:
     window.SYNC_CONFIG = { app: 'pnl'|'budget', name: 'P&L', keys: [ ...localStorage keys... ] };

   SYNC MODEL:
   - Ordering is by the SERVER's updated_at (stamped by Postgres on every write),
     never by any device's Date.now(). Device clocks drift — a phone slightly behind
     a laptop made the phone's writes look "older" and get ignored (one-directional
     sync). Comparing server timestamps removes that entirely.
   - Each device remembers the updated_at it currently mirrors (SEEN_KEY); "did the
     cloud change since I last saw it?" is a pure server-timestamp compare.
   - "Unsaved edits" is tracked with a DURABLE counter (REV vs PUSHED in localStorage),
     not an in-memory flag. iOS freezes/kills backgrounded tabs, so an in-memory flag was
     lost on reload and the phone would let the cloud overwrite an edit that never left the
     device (one-way "sync"). With a durable counter the reloaded phone still knows it owes
     a push and re-sends instead of being overwritten.
   - Pushes fire on a short debounce, on visibility-hidden / pagehide / blur, on a periodic
     safety timer, and via a keepalive beacon that survives the tab being torn down. logout()
     also flushes before wiping local. Belt and suspenders, because iOS is hostile to saves.
   =========================================================================== */
(function () {
  "use strict";

  var SUPABASE_URL = "https://vanpeuarngjygdgovuux.supabase.co";
  var SUPABASE_KEY = "sb_publishable_Aoek7FjmeL1taZqlqjT4eg_DjU_6jv1";

  var cfg  = window.SYNC_CONFIG || { app: "app", name: "App", keys: [] };
  var KEYS = cfg.keys || [];
  // The SERVER's updated_at that this device currently mirrors. Ordering is done by the
  // server clock (identical for every device) — never by Date.now(), which drifts between
  // a phone, a laptop and an Android and caused one-directional "sync".  (NOT an app data key.)
  var SEEN_KEY = "__sync_seen_" + cfg.app;
  // DURABLE "unsaved edits" tracking. REV bumps on every user edit; PUSHED is the rev last
  // confirmed in the cloud. Both live in localStorage, so an iOS tab that gets frozen/killed
  // mid-save still knows on reload that it owes the cloud a push — instead of quietly letting
  // the cloud overwrite the edit. hasUnpushed() === REV > PUSHED. (NOT app data keys.)
  var REV_KEY = "__sync_rev_" + cfg.app;
  var PUSHED_KEY = "__sync_pushedrev_" + cfg.app;
  var OWNER_KEY = "__sync_owner_" + cfg.app;   // which account the local data belongs to (isolation)

  var sb = null;
  var currentUser = null;
  var recovering = false;     // true while handling a password-reset link
  var ready = false;          // true once the initial pull is done (gates pushes)
  var applyingRemote = false; // true while writing cloud data into localStorage
  var pushTimer = null;
  var loggedInOnce = false;   // auth can fire the login twice — run it only once
  var realtimeSubscribed = false;
  var currentToken = null;    // cached access token, so the keepalive beacon can fire synchronously

  /* ---- 1. Install the localStorage hook SYNCHRONOUSLY (before the app runs) ---- */
  var origSet = window.localStorage.setItem.bind(window.localStorage);
  var origRemove = window.localStorage.removeItem.bind(window.localStorage);
  window.localStorage.setItem = function (k, v) {
    origSet(k, v);
    if (!applyingRemote && KEYS.indexOf(k) >= 0) onLocalEdit();
  };
  window.localStorage.removeItem = function (k) {
    origRemove(k);
    if (!applyingRemote && KEYS.indexOf(k) >= 0) onLocalEdit();
  };
  // A genuine user edit (only counts once the app is live — boot-time seeding is ignored,
  // otherwise a freshly-loaded empty device would look "dirty" and overwrite the cloud).
  function onLocalEdit() {
    if (!ready) return;
    origSet(REV_KEY, String(getRev() + 1));   // durably mark "there are unsaved edits"
    updatePendingBadge();
    schedulePush();
  }
  function getRev()    { var n = Number(origGet(REV_KEY));    return isNaN(n) ? 0 : n; }
  function getPushed() { var n = Number(origGet(PUSHED_KEY)); return isNaN(n) ? 0 : n; }
  function hasUnpushed() { return getRev() > getPushed(); }   // survives reloads — the real fix

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
      if (session) currentToken = session.access_token;
      if (recovering) { renderSetNewPassword(); return; }
      if (session) onLogin(session.user);
      else showLogin();
    });
    sb.auth.onAuthStateChange(function (ev, session) {
      if (session) currentToken = session.access_token;      // keep the beacon's token fresh
      if (ev === "PASSWORD_RECOVERY") { recovering = true; renderSetNewPassword(); return; }
      if (recovering) return;
      if (session && !currentUser) onLogin(session.user);
      else if (!session && currentUser) { currentUser = null; location.reload(); }
    });

    // ---- Critical for iOS: get the edit OUT before the tab is frozen/killed ----
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        forcePush();                       // normal push (may not finish before iOS freezes us)…
        beaconFlush();                     // …so ALSO fire a keepalive beacon that survives teardown
      } else if (document.visibilityState === "visible" && ready) {
        syncFromCloud();
      }
    });
    window.addEventListener("pagehide", function () { forcePush(); beaconFlush(); });
    window.addEventListener("blur",     function () { forcePush(); });   // switching tab/app on desktop
    // Also re-sync when returning from bfcache or focus
    window.addEventListener("pageshow", function (e) { if (e.persisted && ready) syncFromCloud(); });
    window.addEventListener("focus",    function () { if (ready) syncFromCloud(); });
    // Safety net: while the page is open, flush any lingering unsaved edit every few seconds.
    setInterval(function () {
      if (ready && currentUser && document.visibilityState === "visible" && hasUnpushed()) push();
    }, 4000);
  }

  // Last-ditch flush that survives the page being torn down (iOS backgrounding). Uses a raw
  // keepalive fetch — the normal supabase-js push does NOT set keepalive, so it can be cancelled
  // when the tab freezes. Best-effort: if it fails, the durable REV counter re-pushes on next load.
  function beaconFlush() {
    if (!currentUser || !currentToken || !hasUnpushed()) return;
    try {
      fetch(SUPABASE_URL + "/rest/v1/user_data?on_conflict=user_id,app", {
        method: "POST", keepalive: true,
        headers: {
          "apikey": SUPABASE_KEY, "Authorization": "Bearer " + currentToken,
          "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify({ user_id: currentUser.id, app: cfg.app, data: gather() })
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- sync core ---------------- */
  // Ordering rule: the CLOUD row carries a server-stamped `updated_at`. Each device remembers
  // the updated_at it currently mirrors (SEEN_KEY). "Has the cloud changed since I last saw it?"
  // is a pure string compare of server timestamps — no device clock is ever consulted, so phone,
  // laptop and Android all agree on who is newer.
  function gather() {
    var o = {};
    KEYS.forEach(function (k) {
      var v = origGet(k);
      if (v !== null) o[k] = v;
    });
    return o;
  }
  function origGet(k) { return window.localStorage.getItem(k); }
  function getSeen() { return origGet(SEEN_KEY); }
  function setSeen(ts) { if (ts) origSet(SEEN_KEY, String(ts)); }
  function getOwner() { return origGet(OWNER_KEY); }
  function setOwner(id) { if (id) origSet(OWNER_KEY, String(id)); }

  function applyCloud(data, updatedAt) {
    applyingRemote = true;
    // Replace every synced key: keys present in the cloud are written; keys the cloud no longer
    // has are removed, so a delete on one device propagates instead of lingering here.
    KEYS.forEach(function (k) {
      if (data && Object.prototype.hasOwnProperty.call(data, k)) origSet(k, data[k]);
      else origRemove(k);
    });
    if (updatedAt) origSet(SEEN_KEY, String(updatedAt));   // we now mirror this exact cloud version
    origSet(PUSHED_KEY, String(getRev()));                 // in sync with cloud → nothing left to push
    applyingRemote = false;
    updatePendingBadge();
  }
  function clearLocal() {
    applyingRemote = true;
    KEYS.forEach(function (k) { origRemove(k); });
    origRemove(SEEN_KEY); origRemove(REV_KEY); origRemove(PUSHED_KEY); origRemove(OWNER_KEY);  // reset all sync markers for the next person
    applyingRemote = false;
  }

  // pull() → { data, updated_at } or null
  function pull() {
    return sb.from("user_data").select("data,updated_at").eq("app", cfg.app).maybeSingle()
      .then(function (res) { return res.data || null; });
  }
  // push() writes local state up. It records which REV it sent, so success marks exactly that rev
  // as pushed (edits made DURING the request stay pending and push again).
  function push() {
    if (!currentUser) return Promise.resolve();
    var revSent = getRev();
    return sb.from("user_data").upsert(
      { user_id: currentUser.id, app: cfg.app, data: gather() },
      { onConflict: "user_id,app" }
    ).select("updated_at").maybeSingle().then(function (r) {
      if (r && !r.error) {
        if (getPushed() < revSent) origSet(PUSHED_KEY, String(revSent));  // confirmed in the cloud
        if (r.data && r.data.updated_at) setSeen(r.data.updated_at);
        updatePendingBadge();
      }
      if (DEBUG) dbgShow("PUSHED rev" + revSent + " — " + (r && r.error ? "ERROR " + JSON.stringify(r.error) : "OK, seen=" + (r.data && r.data.updated_at)) +
        " · " + new Date().toLocaleTimeString());
      return r;
    });
  }

  // Normal editing path: a short debounce batches rapid keystrokes but still saves fast.
  // (Short window + durable REV counter = an iOS freeze can't lose the edit.)
  function schedulePush() {
    if (!ready || !hasUnpushed()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; push(); }, 300);
  }

  // Used on hide / pagehide — cancel any pending debounce and push immediately,
  // but ONLY if this device actually has unpushed edits (never clobber a newer device).
  function forcePush() {
    if (!ready || !currentUser || !hasUnpushed()) return Promise.resolve();
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    return push();
  }

  // Order-independent fingerprint of the app state (only looks at KEYS).
  function canon(o) {
    o = o || {};
    return JSON.stringify(KEYS.map(function (k) { return (k in o) ? o[k] : null; }));
  }

  // The single decision used on login, on returning to the app, and on every realtime event.
  // Compares the server's updated_at (via SEEN_KEY) — no device clocks.
  function reconcile(row) {
    var local = gather();
    if (!row) {
      // No cloud row yet. Seed it if this device actually holds data (or has pending edits).
      if (hasUnpushed() || KEYS.some(function (k) { return origGet(k) !== null; })) return push();
      return Promise.resolve();
    }
    var cloudMoved = (row.updated_at !== getSeen());        // cloud changed since we last synced?
    var differs = (canon(row.data) !== canon(local));

    if (hasUnpushed()) {
      // This device has edits not yet confirmed in the cloud — even across an iOS reload, thanks to
      // the durable REV counter. They win: push them up instead of letting the cloud overwrite them.
      return push();
    }
    if (differs && !cloudMoved) {
      // Content is the source of truth: local differs from the cloud, but the cloud hasn't moved
      // since we last synced → this device holds changes the cloud never got (an edit the rev
      // counter missed, or one made under an older app version). Push them. This self-heals the
      // "invisible edit" case where hasUnpushed() is stale.
      return push();
    }
    if (differs && cloudMoved) {
      applyCloud(row.data, row.updated_at);                 // another device changed things → take it
      rerender();
      return Promise.resolve();
    }
    setSeen(row.updated_at);                                // already in sync → just record the marker
    return Promise.resolve();
  }

  /* ---------------- diagnostics (only active with ?debug in the URL) ---------------- */
  var DEBUG = /[?&#]debug/i.test(window.location.href);
  function dbgShow(text) {
    if (!DEBUG) return;
    var el = document.getElementById("sync-dbg");
    if (!el) {
      el = document.createElement("div"); el.id = "sync-dbg";
      el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483600;background:rgba(0,0,0,.92);" +
        "color:#4ADE80;font:11px/1.55 ui-monospace,Menlo,monospace;padding:10px 12px;white-space:pre-wrap;" +
        "border-bottom:2px solid #4ADE80;";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
  }
  function diag(label, row) {
    if (!DEBUG) return;
    var g = gather(), k = KEYS[0];
    var localLen = (g[k] || "").length;
    var cloudLen = (row && row.data && row.data[k]) ? String(row.data[k]).length : 0;
    dbgShow(
      "SYNC DEBUG · " + label + "\n" +
      "user: " + (currentUser ? currentUser.email : "—") + " · ready: " + ready + " · unpushed: " + hasUnpushed() + " (rev " + getRev() + "/" + getPushed() + ")\n" +
      "cloud row: " + (row ? "EXISTS" : "NONE") + " · cloud len: " + cloudLen + " · cloud updated_at: " + (row ? row.updated_at : "—") + "\n" +
      "here len: " + localLen + " · seen: " + getSeen() + "\n" +
      "cloud moved since seen: " + (row ? (row.updated_at !== getSeen()) : "n/a") + "\n" +
      "IN SYNC: " + (row && canon(row.data) === canon(g) ? "YES ✓" : "NO — DIFFERS ✗") + "\n" +
      new Date().toLocaleTimeString()
    );
  }

  // Re-render the app in place with whatever is now in storage. No page reload —
  // reloads are unreliable on iOS Safari (it restores cached pages without re-running scripts).
  function rerender() {
    if (typeof window.__resyncApply === "function") { try { window.__resyncApply(); return; } catch (e) {} }
    location.reload();   // fallback if the app didn't expose the hook
  }

  // Pull the latest cloud state and reconcile. Called on returning to the app (focus / foreground).
  function syncFromCloud() {
    if (!currentUser) return Promise.resolve();
    return pull().then(function (row) {
      diag("returned to app", row);
      return reconcile(row);
    }).catch(function (e) { dbgShow("resync pull FAILED: " + (e && e.message)); });
  }

  function onLogin(user) {
    if (loggedInOnce) return;       // auth events can fire this twice — run once
    loggedInOnce = true;
    currentUser = user;
    showLoading();
    var finish = function (row, note) {
      subscribeRealtime();
      ready = true;
      hideOverlay();
      showBadge(user.email);
      diag(note || "after login", row);
    };
    pull().then(function (row) {
      // ---- Account isolation ----
      // The login overlay blocks data entry while signed out, so ANY local data present at login was
      // left by a PREVIOUS session/user. Only trust it when it's tagged as THIS user's — otherwise
      // never let it seed a new account or overwrite another one (that would leak one person's data
      // into another). This is the fix for "a fresh signup shows the previous account's data".
      var owner = getOwner();
      var localHasData = hasUnpushed() || KEYS.some(function (k) { return origGet(k) !== null; });
      if ((owner && owner !== user.id) || (!owner && !row && localHasData)) {
        // Data from a DIFFERENT account, OR unidentified leftover about to seed a brand-new empty
        // account → discard it and load only THIS user's cloud data (clean start if none).
        clearLocal();
        setOwner(user.id);
        if (row) { applyCloud(row.data, row.updated_at); rerender(); }
        finish(row, "after login (isolated / clean start)");
        return;
      }
      // Same user as the data on this device (or legacy data with an existing cloud row) →
      // normal reconcile, which preserves this device's not-yet-pushed edits.
      setOwner(user.id);
      return reconcile(row).then(function () { finish(row); });
    }).catch(function (e) {
      ready = true; hideOverlay(); showBadge(user.email);
      dbgShow("login pull FAILED: " + (e && e.message));
    });
  }

  function subscribeRealtime() {
    if (realtimeSubscribed) return;   // subscribe exactly once — re-subscribing throws
    realtimeSubscribed = true;
    try {
      sb.channel("sync_" + cfg.app)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "user_data", filter: "app=eq." + cfg.app },
          function (payload) {
            var n = payload["new"];
            if (!n || !n.data) return;
            reconcile({ data: n.data, updated_at: n.updated_at });   // same server-clock logic
          })
        .subscribe();
    } catch (e) { /* realtime is best-effort; the foreground/focus re-pull covers gaps */ }
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
    // Flush any unsaved edit to the cloud and WAIT for it before wiping local + signing out —
    // otherwise a trade added seconds before logout (still in the 0.8s debounce) is lost forever.
    var finish = function () {
      clearLocal();                   // don't leave one customer's data for the next
      sb.auth.signOut().then(function () { location.reload(); });
    };
    if (hasUnpushed() || pushTimer) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      push().then(finish, finish);    // proceed whether the flush succeeds or fails
    } else {
      finish();
    }
  }

  // Permanently delete the account + all its data (App Store / Play Store requirement).
  // Two confirmations because it's irreversible. The actual delete happens server-side in the
  // "delete-account" Edge Function (only the service role can remove an auth user); functions.invoke
  // sends the user's own access token, so they can only ever delete themselves.
  function deleteAccount() {
    if (!sb || !currentUser) return;
    if (!window.confirm(
      "Permanently delete your account?\n\nThis erases your login and ALL of your " + (cfg.name || "app") +
      " data on every device. This cannot be undone."
    )) return;
    if (!window.confirm("Are you absolutely sure? There is no way to recover your data afterwards.")) return;

    var btn = document.getElementById("sync-delete");
    if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }

    sb.functions.invoke("delete-account", { body: {} }).then(function (r) {
      if (r.error) throw r.error;
      clearLocal();                     // wipe this device's copy
      return sb.auth.signOut();
    }).then(function () {
      alert("Your account and all your data have been permanently deleted.");
      location.reload();
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = "Delete account"; }
      alert("Sorry — we couldn't delete your account just now. Please try again, or email support@financelog.app.");
    });
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
      + "#sync-badge button:disabled{opacity:.5;cursor:default;}"
      + "#sync-delete{color:#8494ac !important;margin-left:2px;}"
      + "#sync-delete:hover{color:#FF5C72 !important;}"
      + "#sync-dot{width:7px;height:7px;border-radius:50%;background:#2FE79B;flex:none;}"
      // On phones the full pill (email + Log out + Delete) spans the form; collapse it to a small
      // dot+email corner pill and reveal the actions only on tap.
      + "@media (max-width:560px){"
      + "#sync-badge{max-width:calc(100vw - 28px);}"
      + "#sync-badge.sync-collapsed{cursor:pointer;}"
      + "#sync-badge.sync-collapsed>button,#sync-badge.sync-collapsed>#sync-pending{display:none;}"
      + "#sync-badge>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:56vw;}"
      + "}";
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
    b.innerHTML = '<span id="sync-dot"></span><span>' + esc(email) + '</span>' +
      '<button id="sync-out">Log out</button>' +
      '<button id="sync-delete" title="Permanently delete your account and data">Delete account</button>';
    document.body.appendChild(b);
    document.getElementById("sync-out").onclick = logout;
    document.getElementById("sync-delete").onclick = deleteAccount;
    // On phones, start collapsed (dot + email only); tapping the pill reveals Log out / Delete.
    if (window.matchMedia && window.matchMedia("(max-width:560px)").matches) {
      b.classList.add("sync-collapsed");
      b.addEventListener("click", function (e) {
        if (e.target.tagName === "BUTTON") return;   // let the action buttons do their thing
        b.classList.toggle("sync-collapsed");
      });
    }
    updatePendingBadge();
  }
  // Visible "• Pending" chip whenever this device holds edits not yet confirmed in the cloud.
  // Driven by the DURABLE counter (hasUnpushed), so it correctly stays lit across an iOS reload —
  // and doubles as a live diagnostic: if it never clears, the phone's push isn't getting through.
  function updatePendingBadge() {
    var badge = document.getElementById("sync-badge");
    if (!badge) return;
    var pending = document.getElementById("sync-pending");
    var dot = document.getElementById("sync-dot");
    if (currentUser && hasUnpushed()) {
      if (dot) dot.style.background = "#FFB020";                 // amber dot = unsaved
      if (!pending) {
        pending = document.createElement("span");
        pending.id = "sync-pending";
        pending.style.cssText = "color:#FFB020;font-weight:700;margin:0 4px;";
        pending.textContent = "• Pending";
        badge.insertBefore(pending, badge.querySelector("button"));
      }
    } else {
      if (dot) dot.style.background = "#2FE79B";                 // green dot = synced
      if (pending) pending.remove();
    }
  }

  function loadScript(src, ok, err) {
    var s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = err;
    document.head.appendChild(s);
  }
  function esc(s) { return String(s).replace(/[&<>"'/]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#47;" })[c]; }); }
})();
