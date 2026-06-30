// Content script (isolated world).
// - Injects inject.js (WebRTC + network hooks).
// - Detects participants AUTOMATICALLY from the page (DOM) and from the call's
//   network traffic. No manual calibration needed (calibration stays as an
//   optional override).
// - One call = one session; auto-starts on connect, auto-ends on hangup, and
//   keeps recording even while the tab is in the background.
(function () {
  "use strict";

  const TAG = "MAXCT";
  const SESSIONS_KEY = "max_attendance_sessions";
  const CALIB_KEY = "max_attendance_calib";
  const CURRENT_KEY = "max_attendance_current";
  const UI_KEY = "max_call_ui";

  const GRACE_MS = 8000;
  const SCAN_MS = 2000;
  const MISS_SCANS = 2;
  const MIN_SESSION_MS = 3000;
  const MAX_SESSIONS = 200;
  const PERSIST_MS = 5000;
  const NET_TTL_MS = 20000;

  (function injectPageScript() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("inject.js");
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
      s.onload = function () { s.remove(); };
    } catch (e) {}
  })();

  function now() { return Date.now(); }

  // ---- state ------------------------------------------------------------
  let liveCount = 0;
  let running = false;
  let source = null; // 'auto' | 'manual'
  let session = null;
  let scanTimer = null, tickTimer = null, persistTimer = null, graceTimer = null;
  let ignoreAuto = false;
  let calib = null;
  let curSource = "—";

  let netNames = [];
  let netTs = 0;

  chrome.storage.local.get(CALIB_KEY, function (d) {
    if (d[CALIB_KEY]) calib = d[CALIB_KEY];
  });
  function saveCalib() {
    try { chrome.storage.local.set({ [CALIB_KEY]: calib }); } catch (_) {}
  }

  // ---- session lifecycle -----------------------------------------------
  function startSession(by) {
    if (running) return;
    running = true;
    source = by;
    session = {
      id: "s_" + now() + "_" + Math.random().toString(36).slice(2, 7),
      start: now(),
      url: location.href,
      title: document.title || "MAX 通话",
      people: {}
    };
    clearGrace();
    ui.setRunning(true, by);
    scanNow();
    scanTimer = setInterval(scanNow, SCAN_MS);
    tickTimer = setInterval(tick, 1000);
    persistTimer = setInterval(function () { persistSession(false); }, PERSIST_MS);
    writeCurrent();
    sendBg("call-start");
  }

  function endSession(save) {
    if (!running) return;
    const dur = now() - session.start;
    stopTimers();
    clearGrace();
    if (save && dur >= MIN_SESSION_MS) persistSession(true);
    else if (save) removeSession(session.id);
    running = false;
    source = null;
    session = null;
    ui.setRunning(false, null);
    ui.renderPeople([], 0, "—");
    writeCurrent();
    sendBg("call-end");
  }

  function stopTimers() {
    [scanTimer, tickTimer, persistTimer].forEach(function (t) { if (t) clearInterval(t); });
    scanTimer = tickTimer = persistTimer = null;
  }

  function scheduleGrace() {
    clearGrace();
    graceTimer = setTimeout(function () { graceTimer = null; endSession(true); }, GRACE_MS);
    ui.setReconnecting(true);
  }
  function clearGrace() {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    ui.setReconnecting(false);
  }

  function onCount(count) {
    liveCount = count;
    if (count > 0) {
      if (ignoreAuto) return;
      clearGrace();
      if (!running) startSession("auto");
    } else {
      ignoreAuto = false;
      if (running && source === "auto") scheduleGrace();
    }
  }

  // ---- detection helpers ------------------------------------------------
  function isVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function looksName(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 1 || t.length > 60) return false;
    if (/^[0-9]+$/.test(t)) return false;
    if (/^[0-9a-f-]{16,}$/i.test(t)) return false;
    if (/^https?:\/\//i.test(t)) return false;
    return /[\p{L}]/u.test(t);
  }

  function firstLine(el) {
    const text = (el.innerText || el.textContent || "").trim();
    if (!text) return "";
    const line = text.split("\n").map(function (s) { return s.trim(); }).filter(Boolean)[0] || "";
    return line.slice(0, 60);
  }

  // -- automatic DOM detection --
  let pidCounter = 0;
  function parentId(node) {
    if (!node.__maxctPid) {
      try {
        Object.defineProperty(node, "__maxctPid", {
          value: ++pidCounter, enumerable: false, configurable: true
        });
      } catch (_) { return node.tagName + Math.random(); }
    }
    return node.__maxctPid;
  }

  function findCallContainer() {
    const sel =
      '[class*="call" i],[class*="conference" i],[class*="video" i],' +
      '[class*="participant" i],[class*="member" i],[class*="meeting" i],' +
      '[class*="roster" i],[aria-label*="call" i],[id*="call" i]';
    let best = null, bestArea = 0, nodes;
    try { nodes = document.querySelectorAll(sel); } catch (_) { return null; }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!isVisible(n)) continue;
      const r = n.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = n; }
    }
    return best;
  }

  function autoDomScan() {
    const overlayRoot = document.getElementById("maxct-overlay");
    const root = findCallContainer() || document.body;
    if (!root) return null;
    let nodes;
    try { nodes = root.querySelectorAll("*"); } catch (_) { return null; }
    if (!nodes.length) return null;

    const groups = new Map();
    const limit = Math.min(nodes.length, 9000);
    for (let i = 0; i < limit; i++) {
      const el = nodes[i];
      const parent = el.parentElement;
      if (!parent) continue;
      if (overlayRoot && overlayRoot.contains(el)) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 14) continue;
      if (r.width > innerWidth * 0.92 && r.height > innerHeight * 0.92) continue;
      const sig = el.tagName + "|" + Array.from(el.classList).sort().join(".");
      const key = parentId(parent) + "#" + sig;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(el);
    }

    let best = null, bestScore = 0;
    groups.forEach(function (els) {
      if (els.length < 2) return;
      const names = [];
      const seen = new Set();
      els.forEach(function (el) {
        const nm = firstLine(el);
        if (nm && looksName(nm) && !seen.has(nm)) { seen.add(nm); names.push(nm); }
      });
      if (!names.length) return;
      const score = names.length + names.length / els.length;
      if (score > bestScore) { bestScore = score; best = names; }
    });
    return best && best.length ? new Set(best) : null;
  }

  // -- calibration (optional override) --
  function classTokens(el) { return el && el.classList ? Array.from(el.classList) : []; }
  function similarSiblingCount(el) {
    const parent = el.parentElement;
    if (!parent) return 0;
    const tag = el.tagName, cls = classTokens(el), kids = parent.children;
    let n = 0;
    for (let i = 0; i < kids.length; i++) {
      const ch = kids[i];
      if (ch.tagName !== tag) continue;
      if (cls.length) {
        if (cls.every(function (c) { return ch.classList.contains(c); })) n++;
      } else n++;
    }
    return n;
  }
  function computeTile(clicked) {
    let el = clicked, firstRepeat = null;
    for (let d = 0; el && d < 9; d++, el = el.parentElement) {
      if (similarSiblingCount(el) >= 2) {
        if (!firstRepeat) firstRepeat = el;
        if (classTokens(el).length) return el;
      }
    }
    return firstRepeat || clicked;
  }
  function pathFromTo(ancestor, node) {
    const path = [];
    let cur = node;
    while (cur && cur !== ancestor) {
      const p = cur.parentElement;
      if (!p) return null;
      path.unshift(Array.prototype.indexOf.call(p.children, cur));
      cur = p;
    }
    return cur === ancestor ? path : null;
  }
  function calibScan() {
    if (!calib) return null;
    let nodes;
    try { nodes = document.querySelectorAll(calib.tileTag || "*"); } catch (_) { return null; }
    const overlayRoot = document.getElementById("maxct-overlay");
    const present = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (overlayRoot && overlayRoot.contains(n)) continue;
      if (calib.tileClasses && calib.tileClasses.length) {
        if (!calib.tileClasses.every(function (c) { return n.classList.contains(c); })) continue;
      }
      if (!isVisible(n)) continue;
      let target = n;
      if (calib.namePath && calib.namePath.length) {
        for (let j = 0; j < calib.namePath.length; j++) {
          if (!target || !target.children) { target = null; break; }
          target = target.children[calib.namePath[j]];
        }
      }
      const nm = firstLine(target || n);
      if (nm) present.add(nm);
    }
    return present;
  }

  // ---- scan / reconcile -------------------------------------------------
  function netFresh() { return now() - netTs < NET_TTL_MS && netNames.length > 0; }

  function scanNow() {
    if (!running) return;
    let present = null, src = "—";

    if (calib) {
      const s = calibScan();
      if (s && s.size) { present = s; src = "校准名单"; }
    }
    if (!present) {
      const s = autoDomScan();
      if (s && s.size) { present = s; src = "自动·页面"; }
    }
    if (!present && netFresh()) {
      present = new Set(netNames);
      src = "自动·网络";
    }

    if (present) { reconcile(present); curSource = src; }
    else curSource = "未识别到参会者";

    ui.renderPeople(livePeople(), now() - session.start, curSource);
  }

  function reconcile(present) {
    const t = now();
    present.forEach(function (name) {
      let p = session.people[name];
      if (!p) {
        p = session.people[name] = {
          firstSeen: t, lastSeen: t, totalMs: 0,
          online: true, curJoin: t, miss: 0, intervals: []
        };
      } else {
        if (!p.online) { p.online = true; p.curJoin = t; }
        p.miss = 0; p.lastSeen = t;
      }
    });
    Object.keys(session.people).forEach(function (name) {
      const p = session.people[name];
      if (p.online && !present.has(name)) {
        p.miss++;
        if (p.miss >= MISS_SCANS) {
          p.online = false;
          const leave = p.lastSeen || t;
          p.intervals.push({ join: p.curJoin, leave: leave });
          p.totalMs += Math.max(0, leave - p.curJoin);
          p.curJoin = null;
        }
      }
    });
  }

  function livePeople() {
    if (!session) return [];
    const t = now();
    return Object.keys(session.people).map(function (name) {
      const p = session.people[name];
      let ms = p.totalMs;
      if (p.online && p.curJoin) ms += t - p.curJoin;
      return { name: name, ms: ms, online: p.online };
    }).sort(function (a, b) {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.ms - a.ms;
    });
  }

  function tick() {
    if (!running) return;
    ui.renderPeople(livePeople(), now() - session.start, curSource);
    writeCurrent();
    sendBg("call-tick", { text: badge(now() - session.start) });
  }

  // ---- persistence ------------------------------------------------------
  function serialize(finalize) {
    const t = now();
    const people = Object.keys(session.people).map(function (name) {
      const p = session.people[name];
      let total = p.totalMs;
      const intervals = p.intervals.slice();
      let online = p.online;
      if (p.online && p.curJoin) {
        total += t - p.curJoin;
        if (finalize) { intervals.push({ join: p.curJoin, leave: t }); online = false; }
      }
      return {
        name: name, totalMs: total, online: online && !finalize,
        firstSeen: p.firstSeen, lastSeen: p.lastSeen, intervals: intervals
      };
    });
    return {
      id: session.id, start: session.start, end: finalize ? t : null,
      url: session.url, title: session.title, people: people
    };
  }
  function persistSession(finalize) {
    if (!session) return;
    const rec = serialize(finalize);
    chrome.storage.local.get(SESSIONS_KEY, function (d) {
      let list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
      const idx = list.findIndex(function (s) { return s.id === rec.id; });
      if (idx >= 0) list[idx] = rec; else list.unshift(rec);
      if (list.length > MAX_SESSIONS) list.length = MAX_SESSIONS;
      chrome.storage.local.set({ [SESSIONS_KEY]: list });
    });
  }
  function removeSession(id) {
    chrome.storage.local.get(SESSIONS_KEY, function (d) {
      let list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
      list = list.filter(function (s) { return s.id !== id; });
      chrome.storage.local.set({ [SESSIONS_KEY]: list });
    });
  }
  function writeCurrent() {
    try {
      const payload = running
        ? { running: true, start: session.start, source: source,
            detect: curSource, people: livePeople() }
        : { running: false };
      chrome.storage.local.set({ [CURRENT_KEY]: payload });
    } catch (_) {}
  }
  function sendBg(type, extra) {
    try { chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {})); } catch (_) {}
  }

  // ---- formatting -------------------------------------------------------
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(ms) {
    if (ms < 0) ms = 0;
    const tot = Math.floor(ms / 1000);
    const h = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60), s = tot % 60;
    return (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
  }
  function badge(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return Math.floor(ms / 1000) + "s";
    if (m < 100) return m + "m";
    return "99+";
  }

  // ---- page messages ----------------------------------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__maxct !== true || d.source !== TAG) return;
    if (d.type === "pc-count") onCount(d.count | 0);
    else if (d.type === "net-participants") {
      netNames = Array.isArray(d.names) ? d.names : [];
      netTs = now();
    }
  });

  // ---- calibration picker (optional) -----------------------------------
  const picker = (function () {
    let active = false;
    function start() {
      if (active) return;
      active = true;
      document.documentElement.style.cursor = "crosshair";
      ui.setPickMode(true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
    }
    function stop() {
      active = false;
      document.documentElement.style.cursor = "";
      ui.setPickMode(false);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); stop(); } }
    function onClick(e) {
      const overlayRoot = document.getElementById("maxct-overlay");
      if (overlayRoot && overlayRoot.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const clicked = e.target;
      const tile = computeTile(clicked);
      const namePath = pathFromTo(tile, clicked) || [];
      calib = { tileTag: tile.tagName, tileClasses: classTokens(tile), namePath: namePath };
      saveCalib();
      stop();
      const s = calibScan();
      ui.flashCalibResult(s ? Array.from(s) : []);
      if (running) scanNow();
    }
    function clear() {
      calib = null;
      try { chrome.storage.local.remove(CALIB_KEY); } catch (_) {}
      ui.setTip("已清除校准，恢复全自动识别。");
      setTimeout(function () { ui.setTip(""); }, 4000);
      if (running) scanNow();
    }
    return { start: start, stop: stop, clear: clear, isActive: function () { return active; } };
  })();

  // ---- overlay UI -------------------------------------------------------
  const ui = (function () {
    let root, dotEl, statusEl, callTimeEl, countEl, srcEl, listEl, toggleBtn,
      calibBtn, body, collapsed = false, isRunning = false;

    function build() {
      if (root) return;
      root = document.createElement("div");
      root.id = "maxct-overlay";
      root.innerHTML =
        '<div class="maxct-head" id="maxct-head">' +
        '  <span class="maxct-dot" id="maxct-dot"></span>' +
        '  <span class="maxct-title">MAX 出勤记录</span>' +
        '  <span class="maxct-spacer"></span>' +
        '  <button class="maxct-mini" id="maxct-collapse" title="折叠/展开">—</button>' +
        '  <button class="maxct-mini" id="maxct-hide" title="隐藏">×</button>' +
        '</div>' +
        '<div class="maxct-body" id="maxct-body">' +
        '  <div class="maxct-meta">' +
        '    <span id="maxct-status">等待通话…</span>' +
        '    <span class="maxct-calltime" id="maxct-calltime">00:00</span>' +
        '  </div>' +
        '  <div class="maxct-countbar">' +
        '    <span id="maxct-count">在线 0 人</span>' +
        '    <span class="maxct-src" id="maxct-src">—</span>' +
        '  </div>' +
        '  <div class="maxct-list" id="maxct-list"></div>' +
        '  <div class="maxct-actions">' +
        '    <button class="maxct-btn" id="maxct-calib" title="自动识别不准时，手动点一位参会者来校准">手动校准</button>' +
        '    <button class="maxct-btn maxct-primary" id="maxct-toggle">开始</button>' +
        '  </div>' +
        '  <div class="maxct-tip" id="maxct-tip"></div>' +
        '</div>';

      dotEl = q("#maxct-dot");
      statusEl = q("#maxct-status");
      callTimeEl = q("#maxct-calltime");
      countEl = q("#maxct-count");
      srcEl = q("#maxct-src");
      listEl = q("#maxct-list");
      toggleBtn = q("#maxct-toggle");
      calibBtn = q("#maxct-calib");
      body = q("#maxct-body");

      q("#maxct-toggle").addEventListener("click", onToggle);
      q("#maxct-calib").addEventListener("click", onCalib);
      q("#maxct-calib").addEventListener("contextmenu", function (e) {
        e.preventDefault(); picker.clear();
      });
      q("#maxct-collapse").addEventListener("click", toggleCollapse);
      q("#maxct-hide").addEventListener("click", hide);

      makeDraggable(root, q("#maxct-head"));
      document.documentElement.appendChild(root);
      restoreUi();
      renderPeople([], 0, "—");
    }
    function q(s) { return root.querySelector(s); }

    function onToggle() {
      if (running) {
        if (source === "auto" && liveCount > 0) ignoreAuto = true;
        endSession(true);
      } else startSession("manual");
    }
    function onCalib() {
      if (picker.isActive()) picker.stop(); else picker.start();
    }
    function setPickMode(on) {
      if (!root) return;
      calibBtn.textContent = on ? "点一位参会者…(Esc)" : "手动校准";
      calibBtn.classList.toggle("maxct-warn", on);
      setTip(on ? "自动识别不准时才需要：点一下任意一位参会者的名字。右键此按钮可清除校准。" : "");
    }
    function flashCalibResult(sample) {
      const n = sample.length;
      setTip(n ? ("已按校准识别 " + n + " 位：" + sample.slice(0, 4).join("、") + (n > 4 ? " 等" : ""))
               : "未识别到，换个更靠近名字的位置再试。");
      setTimeout(function () { if (root) setTip(""); }, 6000);
    }
    function setTip(text) {
      if (!root) return;
      const tip = q("#maxct-tip");
      tip.textContent = text || "";
      tip.style.display = text ? "" : "none";
    }
    function setRunning(r, by) {
      isRunning = r;
      if (!root) return;
      dotEl.classList.toggle("on", r);
      toggleBtn.textContent = r ? "结束" : "开始";
      toggleBtn.classList.toggle("maxct-danger", r);
      toggleBtn.classList.toggle("maxct-primary", !r);
      statusEl.textContent = r ? (by === "auto" ? "通话中（自动）" : "手动记录中") : "等待通话…";
      if (!r) { callTimeEl.textContent = "00:00"; srcEl.textContent = "—"; }
    }
    function setReconnecting(on) {
      if (!root || !isRunning) return;
      statusEl.textContent = on ? "连接中断，确认中…"
        : (source === "auto" ? "通话中（自动）" : "手动记录中");
    }
    function renderPeople(people, callMs, src) {
      if (!root) return;
      callTimeEl.textContent = fmt(callMs || 0);
      const onlineN = people.filter(function (p) { return p.online; }).length;
      countEl.textContent = "在线 " + onlineN + " / 共 " + people.length + " 人";
      srcEl.textContent = src || "—";
      listEl.innerHTML = "";
      if (!people.length) {
        const e = document.createElement("div");
        e.className = "maxct-empty";
        e.textContent = running ? "正在识别参会者…" : "暂无参会者";
        listEl.appendChild(e);
        return;
      }
      people.forEach(function (p) {
        const row = document.createElement("div");
        row.className = "maxct-row" + (p.online ? " on" : "");
        const dot = document.createElement("span"); dot.className = "maxct-rdot";
        const nm = document.createElement("span"); nm.className = "maxct-rname";
        nm.textContent = p.name; nm.title = p.name;
        const tm = document.createElement("span"); tm.className = "maxct-rtime";
        tm.textContent = fmt(p.ms);
        row.appendChild(dot); row.appendChild(nm); row.appendChild(tm);
        listEl.appendChild(row);
      });
    }
    function toggleCollapse() {
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "";
      saveUi();
    }
    function hide() { if (root) root.style.display = "none"; }
    function show() { if (root) root.style.display = ""; }
    function saveUi() {
      try {
        const r = root.getBoundingClientRect();
        chrome.storage.local.set({ [UI_KEY]: { left: r.left, top: r.top, collapsed: collapsed } });
      } catch (_) {}
    }
    function restoreUi() {
      try {
        chrome.storage.local.get(UI_KEY, function (d) {
          const u = d[UI_KEY];
          if (!u) return;
          if (typeof u.left === "number") {
            root.style.left = Math.max(0, Math.min(u.left, innerWidth - 80)) + "px";
            root.style.top = Math.max(0, Math.min(u.top, innerHeight - 40)) + "px";
            root.style.right = "auto";
          }
          if (u.collapsed) { collapsed = true; body.style.display = "none"; }
        });
      } catch (_) {}
    }
    function makeDraggable(el, handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
      handle.addEventListener("mousedown", function (e) {
        if (e.target.classList.contains("maxct-mini")) return;
        drag = true;
        const r = el.getBoundingClientRect();
        ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
        el.style.right = "auto"; e.preventDefault();
      });
      addEventListener("mousemove", function (e) {
        if (!drag) return;
        el.style.left = Math.max(0, Math.min(ox + e.clientX - sx, innerWidth - 60)) + "px";
        el.style.top = Math.max(0, Math.min(oy + e.clientY - sy, innerHeight - 30)) + "px";
      });
      addEventListener("mouseup", function () { if (drag) { drag = false; saveUi(); } });
    }

    if (document.documentElement) build();
    else document.addEventListener("DOMContentLoaded", build);

    return {
      setRunning: setRunning, setReconnecting: setReconnecting,
      renderPeople: renderPeople, setPickMode: setPickMode,
      flashCalibResult: flashCalibResult, show: show, setTip: setTip
    };
  })();

  // ---- popup commands ---------------------------------------------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === "show-overlay") ui.show();
    else if (msg.cmd === "calibrate") picker.start();
    else if (msg.cmd === "clear-calib") picker.clear();
    else if (msg.cmd === "toggle-timer") {
      if (running) endSession(true); else startSession("manual");
    }
    return true;
  });

  writeCurrent();
})();
