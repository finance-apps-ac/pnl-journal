/* © 2026 Anna Cardoso. All rights reserved.
   i18n.js - shared language layer for Budget, P&L and Tradeology.
   The app keeps writing English. This file swaps every English text node, placeholder,
   title and aria-label for the chosen language as it appears on screen (MutationObserver),
   so render code does not change. Dictionaries live in lang.js: window.I18N_DICT = { pt: {...}, ru: {...} }.
   Keys are the exact English text (trimmed). "{0}", "{1}" in a key match any text, and the
   matched parts are translated too when the dictionary knows them (e.g. month names).
   Anything inside translate="no" or .notranslate is left alone (user content, brand names). */
(function () {
  "use strict";
  var KEY = "app.lang";
  var D = window.I18N_DICT || {};
  var NAMES = { auto: "Auto", en: "English", pt: "Português", ru: "Русский", es: "Español", de: "Deutsch", fr: "Français", ja: "日本語", ko: "한국어" };
  var ORDER = ["auto", "en", "pt", "ru", "es", "de", "fr", "ja", "ko"];   // a language shows in the picker only when this app has its dictionary
  var ATTRS = ["placeholder", "title", "aria-label"];
  var pref = "auto";
  try { pref = localStorage.getItem(KEY) || "auto"; } catch (e) {}

  function resolve(p) {
    if (p && p !== "auto") return (p === "en" || D[p]) ? p : "en";
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
    for (var i = 0; i < list.length; i++) {
      var c = String(list[i] || "").slice(0, 2).toLowerCase();
      if (c === "en") return "en";
      if (D[c]) return c;
    }
    return "en";
  }
  var lang = resolve(pref);

  /* exact map + pattern list per language */
  var cache = {};
  function table(l) {
    if (cache[l]) return cache[l];
    var src = D[l] || {}, exact = Object.create(null), pats = [];
    Object.keys(src).forEach(function (k) {
      if (/\{\d+\}/.test(k)) {
        var re = "^" + k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\d+)\}/g, "([\\s\\S]+?)") + "$";
        var pre = k.slice(0, k.indexOf("{")), suf = k.slice(k.lastIndexOf("}") + 1);
        pats.push({ re: new RegExp(re), out: src[k], pre: pre, suf: suf });
      } else exact[k] = src[k];
    });
    pats.sort(function (a, b) { return b.re.source.length - a.re.source.length; });
    // index patterns by their first / last 3 literal characters so a lookup tests a handful, not thousands
    var idx = Object.create(null), any = [];
    pats.forEach(function (p, i) {
      p.i = i;
      if (p.pre.length >= 3) (idx["p" + p.pre.slice(0, 3)] = idx["p" + p.pre.slice(0, 3)] || []).push(p);
      else if (p.suf.length >= 3) (idx["s" + p.suf.slice(-3)] = idx["s" + p.suf.slice(-3)] || []).push(p);
      else any.push(p);
    });
    return (cache[l] = { exact: exact, pats: pats, idx: idx, any: any, memo: Object.create(null), memoN: 0 });
  }

  var LETTER = /[A-Za-z]/;
  function tr(s, l) {
    l = l || lang;
    if (l === "en" || !s || !LETTER.test(s)) return s;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), core = m[2];
    var t = table(l), out = t.exact[core];
    if (out == null && core.indexOf("\u00a0") >= 0) { core = core.replace(/\u00a0/g, " "); out = t.exact[core]; }   // "Win&nbsp;rate"
    if (out == null && window.I18N_CONTENT && Object.prototype.hasOwnProperty.call(window.I18N_CONTENT, core)) out = window.I18N_CONTENT[core];   // lesson titles shown by app code
    if (out == null && core in t.memo) out = t.memo[core];
    else if (out == null) {
      var cand = (t.idx["p" + core.slice(0, 3)] || []).concat(t.idx["s" + core.slice(-3)] || [], t.any);
      if (cand.length > 1) cand.sort(function (a, b) { return a.i - b.i; });
      for (var i = 0; i < cand.length; i++) {
        var mm = cand[i].re.exec(core);
        if (mm) {
          out = cand[i].out.replace(/\{(\d+)(?:\|(\w+))?\}/g, function (_, n, mod) {
            var g = mm[+n + 1], x = null;
            if (mod && mod !== "l") x = t.exact[mod + ":" + g];   // e.g. {0|gen} uses "gen:January" (Russian genitive)
            if (x == null) x = t.exact[g];
            if (x == null && window.I18N_CONTENT && Object.prototype.hasOwnProperty.call(window.I18N_CONTENT, g)) x = window.I18N_CONTENT[g];   // e.g. a lesson title inside "Continue: {0}"
            if (x == null) x = g;
            return mod === "l" ? x.toLowerCase() : x;
          });
          break;
        }
      }
      if (t.memoN++ > 20000) { t.memo = Object.create(null); t.memoN = 0; }
      t.memo[core] = out == null ? null : out;
    }
    if (out == null) { if (window.__I18N_COLLECT) window.__I18N_COLLECT(core); return s; }
    return m[1] + out + m[3];
  }

  function skip(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      var tg = e.tagName;
      if (tg === "SCRIPT" || tg === "STYLE" || tg === "TEXTAREA") return true;
      if (e.getAttribute("translate") === "no" || (e.classList && e.classList.contains("notranslate"))) return true;
    }
    return false;
  }

  /* text nodes remember their English source, so switching language works without a reload */
  function doText(n) {
    var v = n.nodeValue;
    if (n.parentNode && n.parentNode.closest && n.parentNode.closest("[data-i18n-html]")) return;   // whole sentence handled by doHtml
    if (!v || !LETTER.test(v) && !n.__i18nSrc) return;
    if (n.__i18nOut !== v) n.__i18nSrc = v;          // the app wrote new English text
    var src = n.__i18nSrc, out = tr(src);
    var key = n.parentNode && n.parentNode.getAttribute && n.parentNode.getAttribute("data-i18n");
    if (key) { var k = lang === "en" ? null : table(lang).exact[key]; out = k == null ? src : k; }
    if (out !== v) { n.__i18nOut = out; n.nodeValue = out; } else n.__i18nOut = v;
  }
  function doHtml(el) {
    if (document.readyState === "loading") return;   // the parser may still be adding its children; done at DOMContentLoaded
    var k = el.getAttribute("data-i18n-html");
    if (el.__i18nHtml == null) el.__i18nHtml = el.innerHTML;
    var v = lang === "en" ? null : table(lang).exact[k];
    var want = v == null ? el.__i18nHtml : v;
    if (el.innerHTML !== want) el.innerHTML = want;
  }
  function doAttrs(el) {
    if (el.hasAttribute("data-i18n-html")) doHtml(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var v = el.getAttribute(a), sk = "__i18n_" + a;
      if (!el[sk] || el[sk].out !== v) el[sk] = { src: v };
      var out = tr(el[sk].src);
      el[sk].out = out;
      if (out !== v) el.setAttribute(a, out);
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (root.parentNode && !skip(root.parentNode)) doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && skip(root)) return;
    if (root.nodeType === 1) doAttrs(root);
    var w = document.createTreeWalker(root, 5 /* element + text */, {
      acceptNode: function (x) {
        if (x.nodeType === 1) return skip(x) ? 2 /* reject subtree */ : 1;
        return 1;
      }
    });
    var x;
    while ((x = w.nextNode())) { if (x.nodeType === 3) doText(x); else doAttrs(x); }
  }

  var busy = false;
  var mo = new MutationObserver(function (recs) {
    if (busy || lang === "en" && !window.__I18N_COLLECT) return;
    busy = true;
    try {
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (r.type === "childList") { for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]); }
        else if (r.type === "characterData") { if (r.target.parentNode && !skip(r.target.parentNode)) doText(r.target); }
        else if (r.type === "attributes" && !skip(r.target)) doAttrs(r.target);
      }
    } finally { busy = false; }
  });
  function start() {
    document.documentElement.lang = lang;
    busy = true; try { walk(document.body || document.documentElement); } finally { busy = false; }
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    hookSettings();
  }

  function set(p) {
    pref = p || "auto";
    try { if (pref === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch (e) {}
    var nl = resolve(pref);
    lang = nl; document.documentElement.lang = lang;
    busy = true; try { walk(document.body); } finally { busy = false; }
    highlight();
    try { window.dispatchEvent(new CustomEvent("i18n:change", { detail: { lang: lang } })); } catch (e) {}
    location.reload();
  }

  /* Settings: add a Language picker right under Appearance (Dark / Light / Auto). */
  function highlight() {
    var seg = document.getElementById("set-lang");
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-l") === pref); });
  }
  function addPicker() {
    if (document.getElementById("set-lang")) return;
    // Budget / P&L: Settings section #set-app-sec. Tradeology: right after its theme switch #setTheme.
    var app = document.getElementById("set-app-sec"), anchor = app ? null : document.getElementById("setTheme");
    if (!app && !anchor) return;
    var lblCls = app ? "set-lbl" : "set-k", segCls = app ? "set-seg" : "seg",
        segCss = app ? "display:grid;grid-template-columns:repeat(3,1fr)" : "margin:0;display:flex;flex-wrap:wrap";
    var avail = ORDER.filter(function (k) { return k === "auto" || k === "en" || D[k]; });
    var box = document.createElement("div");
    box.id = "set-lang-wrap";
    box.innerHTML = '<div class="' + lblCls + '" style="margin-top:16px">Language</div>' +
      '<div class="' + segCls + '" id="set-lang" style="' + segCss + '">' +
      avail.map(function (k) {
        return '<button data-l="' + k + '"' + (k === "auto" ? "" : ' translate="no"') + '>' + NAMES[k] + "</button>";
      }).join("") + "</div>";
    if (window.I18N_CURRENCY) {
      box.innerHTML += '<div class="' + lblCls + '" style="margin-top:16px">Currency</div>' +
        '<div class="' + segCls + '" id="set-cur" style="' + segCss + '">' +
        CURS.map(function (c) { return '<button data-c="' + c + '"' + (c === "auto" ? "" : ' translate="no"') + '>' + (c === "auto" ? "Auto" : CSYM[c] + " " + c) + "</button>"; }).join("") +
        "</div>";
    }
    if (app) app.appendChild(box); else anchor.parentNode.insertBefore(box, anchor.nextSibling);
    box.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button[data-l]");
      if (b) set(b.getAttribute("data-l"));
      var c = e.target.closest && e.target.closest("button[data-c]");
      if (c) setCur(c.getAttribute("data-c"));
    });
    highlight(); curHighlight();
  }
  function hookSettings() {
    addPicker();
    document.addEventListener("DOMContentLoaded", addPicker);
    new MutationObserver(function () { if (!document.getElementById("set-lang")) addPicker(); })
      .observe(document.body, { childList: true });
  }

  /* demo data and starter categories in the chosen language */
  function trData(o, fields) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(function (x) { trData(x, fields); }); return; }
    Object.keys(o).forEach(function (k) {
      if (fields.indexOf(k) >= 0 && typeof o[k] === "string") o[k] = tr(o[k]);
      else if (typeof o[k] === "object") trData(o[k], fields);
    });
  }

  /* Currency (display only, amounts are never converted). Apps that want it set window.I18N_CURRENCY = true
     before this file loads (Budget). "auto" follows the phone's region: Brazil R$, Russia ₽, euro countries €, UK £, Japan ¥, Korea ₩, else $.
     Yen and won have no cents, so they always show whole amounts. */
  var CKEY = "app.currency", CURS = ["auto", "USD", "EUR", "BRL", "RUB", "GBP", "JPY", "KRW"];
  var CSYM = { USD: "$", EUR: "€", BRL: "R$", RUB: "₽", GBP: "£", JPY: "¥", KRW: "₩" };
  var EURO = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" ");
  var curPref = "auto";
  try { curPref = localStorage.getItem(CKEY) || "auto"; } catch (e) {}
  function regionCur() {
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en-US"];
    for (var i = 0; i < list.length; i++) {
      var parts = String(list[i] || "").split("-"), lg = (parts[0] || "").toLowerCase(), rg = "";
      for (var j = 1; j < parts.length; j++) if (/^[A-Za-z]{2}$/.test(parts[j])) { rg = parts[j].toUpperCase(); break; }
      if (rg === "BR") return "BRL"; if (rg === "RU") return "RUB"; if (rg === "GB") return "GBP"; if (rg === "JP") return "JPY"; if (rg === "KR") return "KRW";
      if (EURO.indexOf(rg) >= 0) return "EUR"; if (rg) return "USD";
      if (lg === "ru") return "RUB"; if (lg === "pt") return "BRL"; if (lg === "ja") return "JPY"; if (lg === "ko") return "KRW"; if (lg === "de" || lg === "es" || lg === "fr" || lg === "it" || lg === "nl") return "EUR";
      if (lg === "en") return "USD";
    }
    return "USD";
  }
  var currency = !window.I18N_CURRENCY ? "USD" : (curPref !== "auto" && CSYM[curPref] ? curPref : regionCur());
  var fmtCache = {};
  /* number locale: Spanish with euros reads like Spain ("4200 €"), Spanish with dollars like Latin America ("$4,200") */
  function numLoc() { return lang === "en" ? "en-US" : lang === "es" ? (currency === "EUR" ? "es-ES" : "es-419") : lang; }
  function fmt(digits) {
    if (currency === "JPY" || currency === "KRW") digits = 0;
    var k = currency + digits;
    if (!fmtCache[k]) {
      var loc = numLoc(), o = { style: "currency", currency: currency, minimumFractionDigits: digits, maximumFractionDigits: digits };
      if (currency === "USD" && /^(es|fr|ja|ko)$/.test(lang)) o.currencyDisplay = "narrowSymbol";   // "$", not "US$" / "$US"
      try { fmtCache[k] = new Intl.NumberFormat(loc, o); }
      catch (e) {
        try { delete o.currencyDisplay; fmtCache[k] = new Intl.NumberFormat(loc, o); }
        catch (e2) { fmtCache[k] = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }); }
      }
    }
    return fmtCache[k];
  }
  function setCur(c) {
    curPref = c || "auto";
    try { if (curPref === "auto") localStorage.removeItem(CKEY); else localStorage.setItem(CKEY, curPref); } catch (e) {}
    curHighlight();
    try { window.dispatchEvent(new CustomEvent("i18n:change", { detail: { currency: curPref } })); } catch (e) {}
    location.reload();
  }
  function curHighlight() {
    var seg = document.getElementById("set-cur");
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-c") === curPref); });
  }

  /* Lesson content (Tradeology): window.I18N_CONTENT = { "<English string>": "<translation>" } from content/i18n/<lang>.js.
     Swaps every matching string inside the loaded content data, so lessons render translated from the start.
     Keyed by the English text, so an edited English sentence simply stays English until it is translated again. */
  function applyContent(root) {
    var map = window.I18N_CONTENT;
    if (!map || lang === "en" || !root) return 0;
    var seen = typeof WeakSet === "function" ? new WeakSet() : null, n = 0;
    (function go(o, depth) {
      if (!o || typeof o !== "object" || depth > 14) return;
      if (seen) { if (seen.has(o)) return; seen.add(o); }
      if (o.nodeType || o === window) return;
      var keys = Object.keys(o);
      for (var i = 0; i < keys.length; i++) {
        var v; try { v = o[keys[i]]; } catch (e) { continue; }
        if (typeof v === "string") { var t = Object.prototype.hasOwnProperty.call(map, v) ? map[v] : null; if (typeof t === "string" && t !== v) { try { o[keys[i]] = t; n++; } catch (e) {} } }
        else if (v && typeof v === "object") go(v, depth + 1);
      }
    })(root, 0);
    return n;
  }

  window.I18N = {
    applyContent: applyContent,
    get currency() { return currency; }, get sym() { return CSYM[currency] || "$"; }, get loc() { return numLoc(); },
    fmt: fmt, setCurrency: setCur,
    get lang() { return lang; }, get pref() { return pref; },
    t: function (s) { return tr(s); },
    /* a comma list from the dictionary, e.g. list("__dow") -> ["D","S","T",...]; null in English */
    list: function (k) { var x = lang !== "en" && D[lang] && D[lang][k]; return x ? x.split(",") : null; }, set: set, walk: walk, trData: trData, names: NAMES,
    /* date order with an already translated month name: Japanese/Korean write year, month, day ("2026年11月19日", "2026년 11월 19일"),
       the other non-English languages day first ("19 Nov 2026") */
    ym: function (y, mon) { return lang === "ja" ? y + "年" + mon : lang === "ko" ? y + "년 " + mon : mon + " " + y; },
    dm: function (d, mon) { return lang === "ja" ? mon + d + "日" : lang === "ko" ? mon + " " + d + "일" : d + " " + mon; },
    dmy: function (d, mon, y) { return lang === "ja" ? y + "年" + mon + d + "日" : lang === "ko" ? y + "년 " + mon + " " + d + "일" : d + " " + mon + " " + y; }
  };
  if (window.DEMO_SEED && lang !== "en") trData(window.DEMO_SEED, ["name", "note", "notes", "shift"]);
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  document.addEventListener("DOMContentLoaded", function () {
    busy = true;
    try { Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-html]"), function (el) { if (!skip(el)) doHtml(el); }); }
    finally { busy = false; }
  });
})();
