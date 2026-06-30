// Content script — silent background recording (no page overlay UI).
// Injects inject.js, detects participants by user ID, manages sessions.
(function () {
  "use strict";

  const TAG = "MAXCT";
  const SESSIONS_KEY = "max_attendance_sessions";
  const CALIB_KEY = "max_attendance_calib";
  const CURRENT_KEY = "max_attendance_current";
  const OPTIONS_KEY = "max_attendance_options";
  const DEFAULT_OPTIONS = {
    maxSessions: 200,
    retentionDays: 90,
    customSelectors: [],
    debugMode: false,
    scanIntervalMs: 3000
  };

  const GRACE_MS = 4000;
  const GRACE_FAST_MS = 1200;
  const END_LOCK_MS = 3500;
  const SELF_FALLBACK_ID = "__self__";
  const SCAN_MS = 3000;
  const MISS_SCANS = 2;
  const MIN_SESSION_MS = 3000;
  const PERSIST_MS = 5000;
  const NET_TTL_MS = 20000;

  let options = Object.assign({}, DEFAULT_OPTIONS);
  let domDirty = true;
  let domObserver = null;
  let running = false;
  let source = null;
  let session = null;
  let scanTimer = null, tickTimer = null, persistTimer = null, graceTimer = null;
  let ignoreAuto = false;
  let calib = null;
  let curSource = "—";
  let netParticipants = [];
  let netTs = 0;
  let myUserId = null;
  let mediaActive = false;
  let mediaTs = 0;
  let callHintTs = 0;
  let liveCount = 0;
  let netAuthoritative = false;
  let callEndedTs = 0;
  let callEndedLockUntil = 0;
  let signalingConversationId = null;
  const nameCache = new Map();
  const avatarCache = new Map();

  function signalingTime(stamp, fallback) {
    if (stamp == null || stamp === 0) return fallback != null ? fallback : now();
    let s = Number(stamp);
    if (!isFinite(s) || s <= 0) return fallback != null ? fallback : now();
    if (s > 1e15) s = Math.floor(s / 1e6);
    else if (s > 1e12) s = Math.floor(s / 1e3);
    return s;
  }

  function now() { return Date.now(); }

  function loadOptions(cb) {
    chrome.storage.local.get(OPTIONS_KEY, function (d) {
      options = Object.assign({}, DEFAULT_OPTIONS, d[OPTIONS_KEY] || {});
      try {
        if (options.debugMode) localStorage.setItem("maxct_debug", "1");
        else localStorage.removeItem("maxct_debug");
      } catch (e) {}
      if (cb) cb();
    });
  }
  loadOptions();
  chrome.storage.local.get(CURRENT_KEY, function (d) {
    const cur = d[CURRENT_KEY];
    if (cur && cur.myUserId) setMyUserId(cur.myUserId);
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes[OPTIONS_KEY]) return;
    options = Object.assign({}, DEFAULT_OPTIONS, changes[OPTIONS_KEY].newValue || {});
    try {
      if (options.debugMode) localStorage.setItem("maxct_debug", "1");
      else localStorage.removeItem("maxct_debug");
    } catch (e) {}
  });

  function debugLog() {
    if (!options.debugMode) return;
    try { console.log.apply(console, ["[MAXCT]"].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  function startDomObserver() {
    if (domObserver) return;
    domObserver = new MutationObserver(function () { domDirty = true; });
    try {
      domObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch (e) { debugLog("MutationObserver failed", e); }
  }
  function stopDomObserver() {
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
  }

  function onMaxDomain() {
    return /(?:^|\.)max\.ru$/i.test(location.hostname || "");
  }

  function urlLooksLikeCall() {
    const href = location.href + " " + (location.pathname || "");
    if (/joincall|\/call|conference|meeting|room/i.test(href)) return true;
    return onMaxDomain();
  }

  function callActiveStrong() {
    if (liveCount > 0) return true;
    if (netAuthoritative && netFresh() && netParticipants.length > 0) return true;
    return false;
  }

  function callActiveWeak() {
    if (hasCallMedia()) return true;
    if (callHintFresh()) return true;
    if (mediaFresh() && onMaxDomain()) return true;
    if (running && detectCallDom() && (hasCallMedia() || callHintFresh())) return true;
    return false;
  }

  function isCallActive() {
    return callActiveStrong() || callActiveWeak();
  }

  function shouldStartRecording() {
    if (now() < callEndedLockUntil && liveCount === 0 && !hasCallMedia()) return false;
    return isCallActive();
  }

  function shouldKeepRecording() {
    if (callActiveStrong()) return true;
    if (running && hasCallMedia()) return true;
    if (running && mediaFresh() && onMaxDomain()) return true;
    if (running && callHintFresh() && (liveCount > 0 || hasCallMedia())) return true;
    return false;
  }

  function syncCallState() {
    if (running && source === "auto") {
      if (shouldKeepRecording()) {
        clearGrace();
        if (callActiveStrong()) callEndedLockUntil = 0;
      } else {
        scheduleGrace(GRACE_MS);
      }
      return;
    }

    if (!running && !ignoreAuto && shouldStartRecording()) {
      callEndedTs = 0;
      callEndedLockUntil = 0;
      startSession("auto");
    }
  }

  function detectActiveMedia() {
    try {
      const videos = document.querySelectorAll("video");
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        if (!isVisible(v)) continue;
        const stream = v.srcObject;
        if (stream && typeof stream.getTracks === "function") {
          const tracks = stream.getTracks();
          for (let j = 0; j < tracks.length; j++) {
            if (tracks[j].readyState === "live") return true;
          }
        }
        if (!v.paused && v.readyState >= 2 && v.videoWidth > 0) return true;
      }
    } catch (_) {}
    return false;
  }

  function detectCallDom() {
    const container = findCallContainer();
    if (!container) return false;
    const videos = container.querySelectorAll("video");
    for (let i = 0; i < videos.length; i++) {
      if (isVisible(videos[i])) return true;
    }
    const dom = autoDomScan();
    return !!(dom && dom.size >= 1);
  }

  function mediaFresh() {
    return mediaActive && now() - mediaTs < NET_TTL_MS;
  }

  function callHintFresh() {
    return callHintTs > 0 && now() - callHintTs < NET_TTL_MS;
  }

  function hasCallMedia() {
    return detectActiveMedia() || mediaFresh();
  }

  function onCallEnded(fromSignaling) {
    if (!fromSignaling && (detectActiveMedia() || mediaFresh())) return;
    callEndedTs = now();
    callEndedLockUntil = now() + END_LOCK_MS;
    netParticipants = [];
    netTs = 0;
    netAuthoritative = false;
    callHintTs = 0;
    signalingConversationId = null;
    mediaActive = false;
    mediaTs = 0;
    clearGrace();
    if (running && source === "auto") endSession(true);
  }

  chrome.storage.local.get(CALIB_KEY, function (d) {
    if (d[CALIB_KEY]) calib = d[CALIB_KEY];
  });
  function saveCalib() {
    try { chrome.storage.local.set({ [CALIB_KEY]: calib }); } catch (_) {}
  }

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
    curSource = "信令·WS";
    applyParticipantsFromNet();
    scanTimer = setInterval(function () {
      if (running) applyParticipantsFromNet();
    }, options.scanIntervalMs || SCAN_MS);
    tickTimer = setInterval(tick, 1000);
    persistTimer = setInterval(function () { persistSession(false); }, PERSIST_MS);
    writeCurrent();
    sendBg("call-start");
  }

  function endSession(save) {
    if (!running) return;
    const dur = now() - session.start;
    const endedId = session.id;
    stopTimers();
    clearGrace();
    if (save && dur >= MIN_SESSION_MS) persistSession(true);
    else if (save) removeSession(endedId);
    running = false;
    source = null;
    session = null;
    netParticipants = [];
    netTs = 0;
    netAuthoritative = false;
    callHintTs = 0;
    writeCurrent();
    sendBg("call-end");
  }

  function stopTimers() {
    [scanTimer, tickTimer, persistTimer].forEach(function (t) { if (t) clearInterval(t); });
    scanTimer = tickTimer = persistTimer = null;
    stopDomObserver();
  }

  function scheduleGrace(ms) {
    clearGrace();
    graceTimer = setTimeout(function () { graceTimer = null; endSession(true); }, ms || GRACE_MS);
  }
  function clearGrace() {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  }

  function cacheAvatar(userId, avatar) {
    if (!userId || !avatar) return;
    const url = String(avatar).trim();
    if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) return;
    avatarCache.set(String(userId), url.slice(0, 2048));
  }

  function resolveAvatar(userId, fallback) {
    const cached = avatarCache.get(String(userId));
    if (cached) return cached;
    if (fallback && /^https?:\/\//i.test(String(fallback))) return String(fallback);
    return null;
  }

  function applyAvatar(info, userId) {
    if (info.avatar) cacheAvatar(userId, info.avatar);
    return resolveAvatar(userId, info.avatar);
  }

  function cacheName(userId, name) {
    if (!userId || !name || !looksLikeUserId(String(userId))) return;
    const nm = String(name).trim();
    if (!looksName(nm) || nm === userId) return;
    nameCache.set(String(userId), nm.slice(0, 60));
  }

  function resolveName(userId, fallback) {
    const cached = nameCache.get(String(userId));
    if (cached) return cached;
    const fb = fallback || userId;
    if (fb && fb !== userId && looksName(String(fb))) return String(fb);
    return userId;
  }

  function upsertNetParticipant(p) {
    if (!p || !p.id) return;
    let found = false;
    netParticipants = netParticipants.map(function (cur) {
      if (cur && String(cur.id) === String(p.id)) {
        found = true;
        return Object.assign({}, cur, p);
      }
      return cur;
    });
    if (!found) netParticipants.push(p);
    netAuthoritative = true;
    netTs = now();
  }

  function removeNetParticipant(userId) {
    if (!userId) return;
    netParticipants = netParticipants.filter(function (p) {
      return p && String(p.id) !== String(userId);
    });
    netTs = now();
  }

  function markParticipantOffline(userId, leaveTs) {
    if (!running || !session || !userId) return;
    const p = session.people[userId];
    if (!p || !p.online) return;
    const t = leaveTs || now();
    p.online = false;
    if (p.curJoin) {
      p.intervals.push({ join: p.curJoin, leave: t });
      p.totalMs += Math.max(0, t - p.curJoin);
      p.curJoin = null;
    }
    p.lastSeen = t;
    writeCurrent();
  }

  function applyParticipantsFromNet() {
    if (!running || !netAuthoritative) return;
    const map = participantsMapFromNet(netParticipants);
    if (!map.size) return;
    reconcile(map);
    consolidateSelf(map);
    ensureSelfInSession();
    curSource = "信令·WS";
    writeCurrent();
  }

  function handleSignalingConnection(d) {
    callEndedLockUntil = 0;
    if (d.conversationId) signalingConversationId = d.conversationId;
    if (Array.isArray(d.participants)) {
      netParticipants = d.participants.slice();
      netAuthoritative = true;
      netTs = now();
      d.participants.forEach(function (p) {
        if (p && p.isSelf && p.id) setMyUserId(p.id);
      });
      if (!myUserId && d.participants.length === 1 && d.participants[0].id) {
        setMyUserId(d.participants[0].id);
      }
    }
    if (!running) startSession("auto");
    else applyParticipantsFromNet();
  }

  function handleMaxctMessage(d) {
    if (d.type === "signaling-connection") {
      handleSignalingConnection(d);
    } else if (d.type === "signaling-roster") {
      if (Array.isArray(d.participants)) {
        netParticipants = d.participants.slice();
        netAuthoritative = true;
        netTs = now();
      }
      if (running) applyParticipantsFromNet();
    } else if (d.type === "signaling-join") {
      if (d.participant) upsertNetParticipant(d.participant);
      if (!running) startSession("auto");
      else applyParticipantsFromNet();
    } else if (d.type === "signaling-leave") {
      const leaveTs = signalingTime(d.stamp, d.serverTime);
      if (d.userId) {
        removeNetParticipant(d.userId);
        markParticipantOffline(d.userId, leaveTs);
      }
    } else if (d.type === "signaling-call-end") {
      onCallEnded(true);
    } else if (d.type === "pc-count") {
      liveCount = d.count | 0;
    } else if (d.type === "call-ended") {
      onCallEnded(false);
    } else if (d.type === "call-media" && d.active) {
      mediaActive = true;
      mediaTs = now();
    } else if (d.type === "call-hint") {
      callHintTs = now();
    } else if (d.type === "name-hint") {
      if (d.id && d.name) cacheName(d.id, d.name);
      if (running) applyParticipantsFromNet();
    } else if (d.type === "profile-hint") {
      if (d.id && validUserId(d.id)) {
        if (d.name) cacheName(d.id, d.name);
        if (d.avatar) cacheAvatar(d.id, d.avatar);
        if (d.isSelf) setMyUserId(d.id);
      }
      if (running) applyParticipantsFromNet();
    } else if (d.type === "avatar-hint") {
      if (d.id && d.avatar) cacheAvatar(d.id, d.avatar);
      if (running) applyParticipantsFromNet();
    } else if (d.type === "net-participants") {
      if (Array.isArray(d.participants)) {
        netParticipants = d.participants;
        d.participants.forEach(function (p) {
          if (p && p.id && p.name) cacheName(p.id, p.name);
          if (p && p.id && p.avatar) cacheAvatar(p.id, p.avatar);
        });
      } else netParticipants = [];
      netAuthoritative = !!d.authoritative;
      netTs = now();
      if (d.authoritative && !running && netParticipants.length) startSession("auto");
      else if (running) applyParticipantsFromNet();
    } else if (d.type === "self-user") {
      if (d.name) cacheName(d.id, d.name);
      if (d.avatar) cacheAvatar(d.id, d.avatar);
      setMyUserId(d.id);
      if (running) applyParticipantsFromNet();
      else writeCurrent();
    } else if (d.type === "inject-ready") {
      /* signaling-driven; no DOM auto-start */
    }
  }

  function isVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function looksLikeUserId(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 1 || t.length > 64) return false;
    if (/^[0-9]+$/.test(t)) return true;
    if (/^[0-9a-f]{8,}$/i.test(t)) return true;
    if (/^[0-9a-f-]{8,}$/i.test(t)) return true;
    return false;
  }

  const ID_ATTRS = [
    "data-user-id", "data-userid", "data-uid",
    "data-member-id", "data-participant-id", "data-peer-id"
  ];

  function extractUserIdFromElement(el) {
    let cur = el;
    for (let d = 0; cur && d < 10; d++, cur = cur.parentElement) {
      for (let i = 0; i < ID_ATTRS.length; i++) {
        const v = cur.getAttribute && cur.getAttribute(ID_ATTRS[i]);
        if (v && looksLikeUserId(v)) return v.trim();
      }
      if (cur.id && looksLikeUserId(cur.id)) return cur.id.trim();
    }
    return null;
  }

  function isSelfElement(el) {
    let cur = el;
    for (let d = 0; cur && d < 10; d++, cur = cur.parentElement) {
      if (cur.getAttribute && (cur.getAttribute("data-self") !== null || cur.getAttribute("data-is-local") !== null)) {
        return true;
      }
      const cls = cur.classList ? Array.from(cur.classList) : [];
      for (let i = 0; i < cls.length; i++) {
        if (/local|self|own|me-player|is-me/i.test(cls[i])) return true;
      }
    }
    return false;
  }

  function extractDisplayNameFromElement(el) {
    if (!el) return "";
    const attrs = ["aria-label", "title", "data-name", "data-display-name", "data-username"];
    for (let i = 0; i < attrs.length; i++) {
      const v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v && looksName(v)) return v.trim().slice(0, 60);
    }
    const sel = "[class*='name' i],[class*='title' i],[class*='nick' i]";
    let nodes;
    try { nodes = el.querySelectorAll(sel); } catch (_) { nodes = []; }
    for (let i = 0; i < nodes.length; i++) {
      const t = firstLine(nodes[i]);
      if (looksName(t)) return t;
    }
    const line = firstLine(el);
    if (looksName(line) && !looksLikeUserId(line)) return line;
    return "";
  }

  function extractAvatarFromElement(el) {
    if (!el) return null;
    let cur = el;
    for (let d = 0; cur && d < 12; d++, cur = cur.parentElement) {
      const attrs = ["data-avatar", "data-avatar-url", "data-photo", "data-src", "data-image"];
      for (let i = 0; i < attrs.length; i++) {
        const v = cur.getAttribute && cur.getAttribute(attrs[i]);
        if (v && /^https?:\/\//i.test(v)) return v;
      }
      let imgs;
      try { imgs = cur.querySelectorAll("img[src], img[data-src]"); } catch (_) { imgs = []; }
      for (let i = 0; i < imgs.length; i++) {
        const src = imgs[i].currentSrc || imgs[i].src || imgs[i].getAttribute("data-src") || "";
        if (/^https?:\/\//i.test(src) && !/\.svg(\?|$)/i.test(src)) return src;
      }
      try {
        const bg = window.getComputedStyle(cur).backgroundImage;
        if (bg && bg.indexOf("url(") !== -1) {
          const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/i);
          if (m && m[1]) return m[1];
        }
      } catch (_) {}
    }
    return null;
  }

  function personInfoFromElement(el, uid) {
    const nm = extractDisplayNameFromElement(el) || firstLine(el);
    if (nm && looksName(nm)) cacheName(uid, nm);
    const avatar = extractAvatarFromElement(el);
    if (avatar) cacheAvatar(uid, avatar);
    return {
      name: resolveName(uid, nm || uid),
      avatar: resolveAvatar(uid, avatar),
      isSelf: uid === myUserId || isSelfElement(el)
    };
  }

  function validUserId(id) {
    return id != null && id !== "" && looksLikeUserId(String(id));
  }

  function scanSelfProfile() {
    try {
      const stores = [localStorage, sessionStorage];
      for (let s = 0; s < stores.length; s++) {
        const store = stores[s];
        if (!store) continue;
        for (let i = 0; i < store.length; i++) {
          let raw;
          try { raw = store.getItem(store.key(i)); } catch (_) { continue; }
          if (!raw || raw.length > 80000) continue;
          const idMatch = raw.match(/"(?:user_?id|userid|owner_?id|account_?id)"\s*:\s*"?(\d{5,})"?/i);
          if (idMatch && idMatch[1]) setMyUserId(idMatch[1]);
          if (raw[0] !== "{" && raw[0] !== "[") continue;
          try { walkStorageForSelf(JSON.parse(raw), 0); } catch (_) {}
        }
      }
    } catch (_) {}

    let nodes;
    try {
      nodes = document.querySelectorAll(
        "[data-self],[data-is-local],[data-is-me]," +
        "[class*='local' i],[class*='self' i],[class*='me-player' i]"
      );
    } catch (_) { nodes = []; }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const uid = extractUserIdFromElement(el);
      if (!uid) continue;
      setMyUserId(uid);
      personInfoFromElement(el, uid);
    }

    try {
      document.querySelectorAll("video").forEach(function (v) {
        if (!isVisible(v)) return;
        let cur = v.parentElement;
        for (let d = 0; cur && d < 10; d++, cur = cur.parentElement) {
          const uid = extractUserIdFromElement(cur);
          if (!uid) continue;
          if (isSelfElement(cur) || d <= 2) {
            setMyUserId(uid);
            personInfoFromElement(cur, uid);
          }
          break;
        }
      });
    } catch (_) {}

    try {
      document.querySelectorAll("[data-user-id],[data-userid],[data-participant-id]").forEach(function (el) {
        if (!isVisible(el)) return;
        const uid = extractUserIdFromElement(el);
        if (!uid) return;
        if (isSelfElement(el)) {
          setMyUserId(uid);
          personInfoFromElement(el, uid);
        }
      });
    } catch (_) {}
  }

  function walkStorageForSelf(obj, depth) {
    if (depth > 6 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) walkStorageForSelf(obj[i], depth + 1);
      return;
    }
    const low = {};
    for (const k in obj) { try { low[k.toLowerCase()] = obj[k]; } catch (_) {} }
    const selfKeys = ["isself", "isme", "self", "me", "islocal", "isowner", "iscurrentuser"];
    let isSelf = false;
    for (let i = 0; i < selfKeys.length; i++) {
      const v = low[selfKeys[i]];
      if (v === true || v === 1 || v === "true") { isSelf = true; break; }
    }
    if (isSelf) {
      const idKeys = ["userid", "user_id", "uid", "id", "accountid"];
      for (let i = 0; i < idKeys.length; i++) {
        const v = low[idKeys[i]];
        if (v != null && looksLikeUserId(String(v))) {
          setMyUserId(String(v));
          const nm = low.displayname || low.name || low.username || low.firstname;
          if (nm) cacheName(String(v), String(nm));
          break;
        }
      }
    }
    for (const k in obj) {
      let v;
      try { v = obj[k]; } catch (_) { continue; }
      if (v && typeof v === "object") walkStorageForSelf(v, depth + 1);
    }
  }

  function mergeSelfFallbackInto(next) {
    if (!session || next === SELF_FALLBACK_ID) return;
    const fb = session.people[SELF_FALLBACK_ID];
    if (!fb) return;
    let dst = session.people[next];
    if (!dst) {
      dst = Object.assign({}, fb, { userId: next, isSelf: true });
      session.people[next] = dst;
    } else {
      dst.isSelf = true;
      dst.userId = next;
      if (fb.firstSeen && dst.firstSeen) dst.firstSeen = Math.min(fb.firstSeen, dst.firstSeen);
      else if (fb.firstSeen) dst.firstSeen = fb.firstSeen;
      if (fb.lastSeen && dst.lastSeen) dst.lastSeen = Math.max(fb.lastSeen, dst.lastSeen);
      else if (fb.lastSeen) dst.lastSeen = fb.lastSeen;
      if (fb.online || dst.online) {
        dst.online = true;
        const joins = [fb.curJoin, dst.curJoin].filter(Boolean);
        if (joins.length) dst.curJoin = Math.min.apply(null, joins);
      }
      if (fb.avatar && !dst.avatar) dst.avatar = fb.avatar;
      dst.totalMs = Math.max(fb.totalMs || 0, dst.totalMs || 0);
      dst.intervals = (fb.intervals || []).concat(dst.intervals || []);
    }
    delete session.people[SELF_FALLBACK_ID];
  }

  function consolidateSelf(present) {
    if (!running || !session) return;

    if (validUserId(myUserId)) {
      mergeSelfFallbackInto(myUserId);
      return;
    }

    const realKeys = Object.keys(session.people).filter(function (k) {
      return k !== SELF_FALLBACK_ID && validUserId(k);
    });

    if (realKeys.length === 1 && session.people[SELF_FALLBACK_ID]) {
      setMyUserId(realKeys[0]);
      return;
    }

    if (realKeys.length === 1 && !session.people[SELF_FALLBACK_ID]) {
      const onlyId = realKeys[0];
      const solo = (present && present.size === 1) ||
        (netFresh() && netParticipants.length <= 1) ||
        liveCount <= 1;
      if (solo) setMyUserId(onlyId);
    }
  }

  function setMyUserId(id) {
    if (!validUserId(id)) return;
    const next = String(id);
    if (next === myUserId && running && session && !session.people[SELF_FALLBACK_ID]) {
      ensureSelfInSession();
      return;
    }
    myUserId = next;
    if (running && session) {
      mergeSelfFallbackInto(next);
      if (session.people[next]) {
        session.people[next].isSelf = true;
        session.people[next].userId = next;
        session.people[next].name = resolveName(next, session.people[next].name);
        session.people[next].avatar = resolveAvatar(next, session.people[next].avatar);
      }
      ensureSelfInSession();
    }
  }

  function ensureSelfInSession() {
    if (!running || !session) return;
    scanSelfProfile();
    const uid = validUserId(myUserId) ? myUserId : SELF_FALLBACK_ID;
    if (session.people[uid]) {
      session.people[uid].isSelf = true;
      session.people[uid].userId = uid;
      session.people[uid].name = resolveName(uid, session.people[uid].name);
      session.people[uid].avatar = resolveAvatar(uid, session.people[uid].avatar);
      return;
    }
    const t = now();
    session.people[uid] = {
      userId: uid, name: resolveName(uid, uid === SELF_FALLBACK_ID ? "我" : uid),
      avatar: resolveAvatar(uid, null), isSelf: true,
      nameLocked: false, note: "",
      firstSeen: t, lastSeen: t, totalMs: 0,
      online: true, curJoin: t, miss: 0, intervals: []
    };
  }

  function participantsMapFromNet(list) {
    const map = new Map();
    if (!Array.isArray(list)) return map;
    list.forEach(function (p) {
      if (!p || p.id == null) return;
      const id = String(p.id);
      if (!validUserId(id)) return;
      map.set(id, {
        name: resolveName(id, p.name || id),
        avatar: resolveAvatar(id, p.avatar),
        isSelf: !!(p.isSelf || (myUserId && id === myUserId))
      });
    });
    return map;
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
    return (text.split("\n").map(function (s) { return s.trim(); }).filter(Boolean)[0] || "").slice(0, 60);
  }

  let pidCounter = 0;
  function parentId(node) {
    if (!node.__maxctPid) {
      try {
        Object.defineProperty(node, "__maxctPid", { value: ++pidCounter, enumerable: false, configurable: true });
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
      if (!parent || !isVisible(el)) continue;
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
      const entries = new Map();
      els.forEach(function (el) {
        const uid = extractUserIdFromElement(el);
        if (!uid || entries.has(uid)) return;
        if (isSelfElement(el)) setMyUserId(uid);
        entries.set(uid, personInfoFromElement(el, uid));
      });
      if (!entries.size) return;
      const score = entries.size + entries.size / els.length;
      if (score > bestScore) { bestScore = score; best = entries; }
    });
    return best && best.size ? best : null;
  }

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
    const present = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (calib.tileClasses && calib.tileClasses.length) {
        if (!calib.tileClasses.every(function (c) { return n.classList.contains(c); })) continue;
      }
      if (!isVisible(n)) continue;
      const uid = extractUserIdFromElement(n);
      if (!uid) continue;
      let target = n;
      if (calib.namePath && calib.namePath.length) {
        for (let j = 0; j < calib.namePath.length; j++) {
          if (!target || !target.children) { target = null; break; }
          target = target.children[calib.namePath[j]];
        }
      }
      present.set(uid, personInfoFromElement(target || n, uid));
    }
    return present.size ? present : null;
  }

  function customSelectorScan() {
    const selectors = (options.customSelectors || []).filter(function (s) { return s && s.trim(); });
    if (!selectors.length) return null;
    const present = new Map();
    selectors.forEach(function (sel) {
      try {
        const nodes = document.querySelectorAll(sel.trim());
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          if (!isVisible(el)) continue;
          const uid = extractUserIdFromElement(el);
          if (!uid) continue;
          present.set(uid, personInfoFromElement(el, uid));
        }
      } catch (e) { debugLog("customSelectorScan error", sel, e); }
    });
    return present.size ? present : null;
  }

  function domConfirmScan() {
    const root = findCallContainer();
    if (!root) return null;
    const present = new Map();
    let nodes;
    try {
      nodes = root.querySelectorAll(
        "[data-user-id],[data-userid],[data-participant-id],[data-peer-id],[data-member-id]"
      );
    } catch (_) { return null; }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!isVisible(el)) continue;
      const uid = extractUserIdFromElement(el);
      if (!uid || present.has(uid)) continue;
      if (isSelfElement(el)) setMyUserId(uid);
      present.set(uid, personInfoFromElement(el, uid));
    }
    return present.size ? present : null;
  }

  function filterMapByDom(map, domMap) {
    if (!map || !domMap || !domMap.size) return null;
    const out = new Map();
    map.forEach(function (info, id) {
      if (info.isSelf || id === myUserId || domMap.has(id)) out.set(id, info);
    });
    return out.size ? out : null;
  }

  function soloNetMap(netMap) {
    if (!netMap || !netMap.size) return null;
    if (myUserId && netMap.has(myUserId)) {
      const only = new Map();
      only.set(myUserId, netMap.get(myUserId));
      return only;
    }
    if (netMap.size === 1) return netMap;
    return null;
  }
  function mergeParticipantMaps(sourceList) {
    const merged = new Map();
    let primary = "";
    sourceList.sort(function (a, b) { return b.weight - a.weight; });
    sourceList.forEach(function (src) {
      if (!src.map || !src.map.size) return;
      if (!primary) primary = src.label;
      src.map.forEach(function (info, id) {
        if (!merged.has(id)) {
          merged.set(id, {
            name: info.name || id,
            avatar: info.avatar || null,
            weight: src.weight,
            isSelf: !!(info.isSelf || id === myUserId)
          });
        } else {
          const cur = merged.get(id);
          if (src.weight >= cur.weight && info.name && info.name !== id) {
            cur.name = info.name;
            cur.weight = src.weight;
          }
          if (info.avatar) cur.avatar = info.avatar;
          if (info.isSelf || id === myUserId) cur.isSelf = true;
        }
      });
    });
    const labels = sourceList.filter(function (s) { return s.map && s.map.size; }).map(function (s) { return s.label; });
    let srcLabel = primary || "—";
    if (labels.length > 1) srcLabel = "融合·" + labels.slice(0, 2).join("+");
    return { map: merged.size ? merged : null, label: merged.size ? srcLabel : "未识别到用户 ID" };
  }

  function netFresh() {
    return now() - netTs < NET_TTL_MS && netParticipants.length > 0;
  }

  function scanNow() {
    applyParticipantsFromNet();
  }

  function reconcile(present) {
    const t = now();
    present.forEach(function (info, userId) {
      if (!validUserId(userId)) return;
      let p = session.people[userId];
      if (!p) {
        p = session.people[userId] = {
          userId: userId, name: resolveName(userId, info.name || userId),
          avatar: resolveAvatar(userId, info.avatar),
          isSelf: !!(info.isSelf || userId === myUserId),
          nameLocked: false, note: "",
          firstSeen: t, lastSeen: t, totalMs: 0,
          online: true, curJoin: t, miss: 0, intervals: []
        };
      } else {
        if (info.isSelf || userId === myUserId) p.isSelf = true;
        if (info.name && info.name !== userId) cacheName(userId, info.name);
        if (info.name && info.name !== userId && !p.nameLocked) p.name = resolveName(userId, info.name);
        if (info.avatar) cacheAvatar(userId, info.avatar);
        const av = resolveAvatar(userId, info.avatar || p.avatar);
        if (av) p.avatar = av;
        if (!p.online) { p.online = true; p.curJoin = t; }
        p.miss = 0; p.lastSeen = t;
      }
    });
    Object.keys(session.people).forEach(function (userId) {
      const p = session.people[userId];
      if (p.isSelf || userId === myUserId || userId === SELF_FALLBACK_ID) return;
      if (p.online && !present.has(userId)) {
        markParticipantOffline(userId, p.lastSeen || t);
      }
    });
  }

  function livePeople() {
    if (!session) return [];
    const t = now();
    return Object.keys(session.people).map(function (userId) {
      const p = session.people[userId];
      let ms = p.totalMs;
      if (p.online && p.curJoin) ms += t - p.curJoin;
      return {
        userId: userId, name: resolveName(userId, p.name || userId),
        avatar: resolveAvatar(userId, p.avatar),
        isSelf: !!(p.isSelf || userId === myUserId || userId === SELF_FALLBACK_ID),
        ms: ms, online: p.online,
        firstSeen: p.firstSeen, lastSeen: p.lastSeen, curJoin: p.curJoin,
        intervals: p.intervals ? p.intervals.slice() : []
      };
    }).sort(function (a, b) {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.ms - a.ms;
    });
  }

  function tick() {
    if (!running) return;
    writeCurrent();
    sendBg("call-tick", { text: badge(now() - session.start) });
  }

  function serialize(finalize) {
    const t = now();
    const people = Object.keys(session.people).map(function (userId) {
      const p = session.people[userId];
      let total = p.totalMs;
      const intervals = p.intervals.slice();
      let online = p.online;
      if (p.online && p.curJoin) {
        total += t - p.curJoin;
        if (finalize) { intervals.push({ join: p.curJoin, leave: t }); online = false; }
      }
      return {
        userId: userId, name: resolveName(userId, p.name || userId), note: p.note || "",
        avatar: resolveAvatar(userId, p.avatar),
        isSelf: !!(p.isSelf || userId === myUserId || userId === SELF_FALLBACK_ID),
        nameLocked: !!p.nameLocked, totalMs: total,
        online: online && !finalize,
        firstSeen: p.firstSeen, lastSeen: p.lastSeen, intervals: intervals
      };
    });
    return {
      id: session.id, start: session.start, end: finalize ? t : null,
      url: session.url, title: session.title, people: people
    };
  }

  function pruneSessionsList(list) {
    let out = list.slice();
    const days = options.retentionDays | 0;
    if (days > 0) out = out.filter(function (s) { return (s.start || 0) >= now() - days * 86400000; });
    const max = options.maxSessions | 0;
    if (max > 0 && out.length > max) out.length = max;
    return out;
  }

  function persistSession(finalize) {
    if (!session) return;
    const rec = serialize(finalize);
    chrome.storage.local.get(SESSIONS_KEY, function (d) {
      let list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
      const idx = list.findIndex(function (s) { return s.id === rec.id; });
      if (idx >= 0) list[idx] = rec; else list.unshift(rec);
      list = pruneSessionsList(list);
      chrome.storage.local.set({ [SESSIONS_KEY]: list });
    });
  }

  function removeSession(id) {
    chrome.storage.local.get(SESSIONS_KEY, function (d) {
      let list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
      chrome.storage.local.set({ [SESSIONS_KEY]: list.filter(function (s) { return s.id !== id; }) });
    });
  }

  function writeCurrent() {
    try {
      chrome.storage.local.set({
        [CURRENT_KEY]: running
          ? {
              running: true, start: session.start, source: source,
              detect: curSource, myUserId: myUserId, people: livePeople()
            }
          : { running: false, myUserId: myUserId }
      });
    } catch (_) {}
  }

  function sendBg(type, extra) {
    try { chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {})); } catch (_) {}
  }

  function badge(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return Math.floor(ms / 1000) + "s";
    if (m < 100) return m + "m";
    return "99+";
  }

  window.addEventListener("message", function (ev) {
    const d = ev.data;
    if (!d || d.__maxct !== true || d.source !== TAG) return;
    handleMaxctMessage(d);
  });

  setInterval(function () {
    if (running) writeCurrent();
  }, 1500);

  window.addEventListener("pagehide", function () {
    if (running && source === "auto") onCallEnded(true);
  });

  // Silent calibration (no page UI; triggered from popup)
  const picker = (function () {
    let active = false;
    function start() {
      if (active) return;
      active = true;
      document.documentElement.style.cursor = "crosshair";
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
    }
    function stop() {
      active = false;
      document.documentElement.style.cursor = "";
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); stop(); } }
    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const tile = computeTile(e.target);
      const uid = extractUserIdFromElement(tile);
      if (!uid) return;
      calib = { tileTag: tile.tagName, tileClasses: classTokens(tile), namePath: pathFromTo(tile, e.target) || [] };
      saveCalib();
      stop();
      if (running) scanNow();
    }
    function clear() {
      calib = null;
      try { chrome.storage.local.remove(CALIB_KEY); } catch (_) {}
      if (running) scanNow();
    }
    return { start: start, stop: stop, clear: clear };
  })();

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === "calibrate") picker.start();
    else if (msg.cmd === "clear-calib") picker.clear();
    else if (msg.cmd === "toggle-timer") {
      if (running) endSession(true); else startSession("manual");
    } else if (msg.cmd === "get-options") sendResponse({ options: options });
    return true;
  });

  writeCurrent();
})();
