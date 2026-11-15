/* © 2026 Anna Cardoso. All rights reserved.
   P&L broker CSV import (Nov 2026): reads a broker's trade-history CSV and turns it into plain fills
   { date:"YYYY-MM-DD", time:"HH:MM:SS", symbol, side:"buy"|"sell", qty, price, fees, key }.
   Pure functions, no DOM: index.html replays the fills through the normal buy/sell engine.
   Presets: Robinhood, Schwab, Fidelity, Interactive Brokers (Flex query), Webull, plus a generic
   template and a manual column mapper for any other broker. Columns are found by header name, never position. */
(function (root) {
  "use strict";

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text || "").replace(/^﻿/, "");
    var rows = [], row = [], f = "", q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.map(function (r) { return r.map(function (x) { return x.trim(); }); })
               .filter(function (r) { return r.some(function (x) { return x !== ""; }); });
  }
  var norm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };

  // ---------- values ----------
  function num(s) {
    if (s == null) return NaN; s = String(s).trim(); if (!s) return NaN;
    var neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /^\$-/.test(s);
    var v = parseFloat(s.replace(/[()$,\s]/g, "").replace(/^-/, "").replace(/^\+/, ""));
    return isNaN(v) ? NaN : (neg ? -v : v);
  }
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  function date(s) {               // → { d:"YYYY-MM-DD", t:"HH:MM:SS" } or null
    s = String(s || "").trim(); if (!s) return null;
    s = s.split(/\s+as of\s+/i)[0];
    var m, d = null, t = "00:00:00";
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[;\s,T]+(\d{2}):?(\d{2}):?(\d{2}))?/))) { d = m[1] + "-" + m[2] + "-" + m[3]; if (m[4]) t = m[4] + ":" + m[5] + ":" + m[6]; }
    else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) { d = m[1] + "-" + pad(+m[2]) + "-" + pad(+m[3]); if (m[4]) t = pad(+m[4]) + ":" + m[5] + ":" + (m[6] || "00"); }
    else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i))) {
      var y = +m[3]; if (y < 100) y += 2000; d = y + "-" + pad(+m[1]) + "-" + pad(+m[2]);
      if (m[4]) { var h = +m[4]; if (m[7]) { var pm = /pm/i.test(m[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; } t = pad(h) + ":" + m[5] + ":" + (m[6] || "00"); }
    }
    if (!d) return null;
    var chk = new Date(d + "T00:00:00Z"); if (isNaN(chk)) return null;
    return { d: d, t: t };
  }
  var cleanSym = function (s) { return String(s || "").trim().toUpperCase().replace(/^\$/, ""); };
  var looksStock = function (s) { return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s); };   // options/OCC symbols and blanks are skipped

  // ---------- presets ----------
  // each: find(headerNorms) → score; then row(get) → fill | {skip:reason} | null (ignored row: dividends, transfers…)
  var PRESETS = {
    robinhood: {
      name: "Robinhood", sig: ["transcode"], need: ["activitydate", "instrument", "transcode", "quantity", "price"],
      row: function (g) {
        var code = g("transcode").toUpperCase(); if (code !== "BUY" && code !== "SELL") return /^(BTO|STC|STO|BTC|OEXP|OASGN)$/.test(code) ? { skip: "option" } : null;
        return { when: g("activitydate"), symbol: g("instrument"), side: code.toLowerCase(), qty: num(g("quantity")), price: num(g("price")), fees: 0 };
      }
    },
    schwab: {
      name: "Charles Schwab", sig: ["date", "action", "feescomm"], need: ["date", "action", "symbol", "quantity", "price", "feescomm"],
      row: function (g) {
        var a = g("action").toLowerCase(), side = null;
        if (a === "buy" || a === "reinvest shares") side = "buy"; else if (a === "sell") side = "sell";
        else if (a === "sell short" || a === "buy to cover") return { skip: "short" };
        else if (/to open|to close/.test(a)) return { skip: "option" };
        if (!side) return null;
        return { when: g("date"), symbol: g("symbol"), side: side, qty: Math.abs(num(g("quantity"))), price: num(g("price")), fees: Math.abs(num(g("feescomm"))) || 0 };
      }
    },
    fidelity: {
      name: "Fidelity", sig: ["rundate", "action"], need: ["rundate", "action", "symbol", "quantity"],
      row: function (g) {
        var a = g("action").toUpperCase(), side = /YOU BOUGHT|REINVESTMENT/.test(a) ? "buy" : /YOU SOLD/.test(a) ? "sell" : null;
        if (!side) return null;
        if (/SHORT/.test(a) || /COVER/.test(a)) return { skip: "short" };
        if (/OPENING TRANSACTION|CLOSING TRANSACTION|CALL|PUT/.test(a) && /\d/.test(g("symbol"))) return { skip: "option" };
        var fees = (Math.abs(num(g("commission"))) || 0) + (Math.abs(num(g("fees"))) || 0);
        return { when: g("rundate"), symbol: g("symbol"), side: side, qty: Math.abs(num(g("quantity"))), price: num(g("price")), fees: fees };
      }
    },
    ibkr: {
      name: "Interactive Brokers", sig: ["buysell", "tradeprice"], need: ["symbol", "buysell", "quantity", "tradeprice"],
      row: function (g) {
        var cat = g("assetcategory").toUpperCase(); if (cat && cat !== "STK") return { skip: "option" };
        var bs = g("buysell").toUpperCase(), side = bs.indexOf("BUY") === 0 ? "buy" : bs.indexOf("SELL") === 0 ? "sell" : null; if (!side) return null;
        var oc = g("openclose").toUpperCase(); if ((side === "sell" && oc === "O") || (side === "buy" && oc === "C")) return { skip: "short" };
        return { when: g("datetime") || g("tradedate"), symbol: g("symbol"), side: side, qty: Math.abs(num(g("quantity"))), price: num(g("tradeprice")), fees: Math.abs(num(g("ibcommission"))) || 0 };
      }
    },
    webull: {
      name: "Webull", sig: ["side", "status"], need: ["symbol", "side", "status"],
      row: function (g) {
        if (g("status") && !/filled/i.test(g("status"))) return null;
        var s = g("side").toLowerCase(), side = s === "buy" ? "buy" : s === "sell" ? "sell" : (s === "short" || s === "sell short" || s === "buy to cover") ? "short" : null;
        if (side === "short") return { skip: "short" }; if (!side) return null;
        var q = num(g("filled")); if (isNaN(q)) q = num(g("totalqty"));
        var p = num(g("avgprice")); if (isNaN(p)) p = num(g("price"));
        return { when: g("filledtime") || g("placedtime"), symbol: g("symbol"), side: side, qty: Math.abs(q), price: p, fees: 0 };
      }
    },
    generic: {
      name: "P&L template", need: ["date", "symbol", "side", "qty", "price"],
      row: function (g) {
        var s = g("side").toLowerCase(), side = /^(buy|b|bot|bought|long|buy to open)$/.test(s) ? "buy" : /^(sell|s|sld|sold|sell to close)$/.test(s) ? "sell" : null; if (!side) return null;
        var when = g("date") + (g("time") ? " " + g("time") : "");
        return { when: when, symbol: g("symbol"), side: side, qty: Math.abs(num(g("qty"))), price: num(g("price")), fees: Math.abs(num(g("fees"))) || 0 };
      }
    }
  };
  var ALIAS = {   // header aliases → the preset's column names
    feescomm: ["feescomm", "feescommissions", "commission", "commissions"], tradedate: ["tradedate", "date"], datetime: ["datetime", "dateandtime"],
    filledtime: ["filledtime", "filltime"], avgprice: ["avgprice", "averageprice", "avgfillprice", "fillprice"], totalqty: ["totalqty", "quantity", "qty"],
    filled: ["filled", "filledqty", "filledquantity"], buysell: ["buysell", "buyorsell"], openclose: ["openclose", "opencloseindicator"],
    commission: ["commission", "commission$"], fees: ["fees", "fees$"], price: ["price", "price$"], quantity: ["quantity", "qty"],
    qty: ["qty", "quantity", "shares"], side: ["side", "action", "buysell", "type"], symbol: ["symbol", "ticker", "instrument"], date: ["date", "tradedate", "rundate"]
  };

  // the header row: the first row that holds every column one preset needs (skips Schwab/Fidelity preambles)
  function findHeader(rows) {
    var best = null;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var hs = rows[i].map(norm);
      Object.keys(PRESETS).forEach(function (k) {
        var P = PRESETS[k]; if (!P.need.every(function (n) { return colIndex(hs, n) >= 0; })) return;
        if (P.sig && !P.sig.every(function (n) { return hs.indexOf(n) >= 0; })) return;   // each broker's own header words, matched exactly
        var score = P.need.length * 10 + (P.sig ? 100 : 0);
        if (!best || score > best.score) best = { i: i, preset: k, score: score };
      });
      if (best) return best;
    }
    return null;
  }
  function colIndex(hs, name) {
    var i = hs.indexOf(name); if (i >= 0) return i;
    var al = ALIAS[name] || []; for (var j = 0; j < al.length; j++) { i = hs.indexOf(al[j]); if (i >= 0) return i; }
    return -1;
  }

  // text → { broker, preset, header, fills[], skipped:{option,short,bad}, ignored, needMapping? }
  function read(text, opts) {
    opts = opts || {};
    var rows = parseCSV(text); if (!rows.length) return { error: "empty" };
    var h = opts.mapping ? { i: opts.headerRow || 0, preset: "map" } : findHeader(rows);
    if (!h) return { needMapping: true, header: rows[0], rows: rows };
    var hs = rows[h.i].map(norm), P = h.preset === "map" ? null : PRESETS[h.preset];
    var out = { broker: P ? P.name : "Your columns", preset: h.preset, fills: [], skipped: { option: 0, short: 0, bad: 0 }, ignored: 0 };
    for (var r = h.i + 1; r < rows.length; r++) {
      var row = rows[r]; if (row.length < 2) { out.ignored++; continue; }
      var get = function (name) { var k = h.preset === "map" ? opts.mapping[name] : colIndex(hs, name); return k == null || k < 0 ? "" : (row[k] || ""); };
      var x = P ? P.row(get) : PRESETS.generic.row(get);
      if (!x) { out.ignored++; continue; }
      if (x.skip) { out.skipped[x.skip]++; continue; }
      var sym = cleanSym(x.symbol), dt = date(x.when);
      if (!looksStock(sym)) { out.skipped.option++; continue; }
      if (!dt || !(x.qty > 0) || !(x.price >= 0) || isNaN(x.price)) { out.skipped.bad++; continue; }
      out.fills.push({ date: dt.d, time: dt.t, symbol: sym, side: x.side, qty: +x.qty.toFixed(6), price: +x.price.toFixed(6), fees: +(x.fees || 0).toFixed(2) });
    }
    // chronological (brokers export newest first); on the same second buys go before sells
    out.fills.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time) || (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1); });
    // dedupe key: same day, symbol, side, qty and price; repeats within one file get #2, #3 so real duplicates survive
    var seen = {};
    out.fills.forEach(function (f) { var k = [f.date, f.symbol, f.side, f.qty, f.price].join("|"); seen[k] = (seen[k] || 0) + 1; f.key = k + "#" + seen[k]; });
    return out;
  }

  var TEMPLATE = "Date,Time,Symbol,Side,Qty,Price,Fees\n2026-11-03,09:41:10,ABCD,Buy,100,50.25,0\n2026-11-05,14:02:44,ABCD,Sell,100,52.10,0\n";
  root.PNLImport = { read: read, parseCSV: parseCSV, num: num, date: date, presets: Object.keys(PRESETS), names: Object.keys(PRESETS).map(function (k) { return PRESETS[k].name; }), TEMPLATE: TEMPLATE };
  if (typeof module !== "undefined") module.exports = root.PNLImport;
})(typeof window !== "undefined" ? window : globalThis);
