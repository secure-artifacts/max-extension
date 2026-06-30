// Runs in the PAGE context (not the isolated content-script world).
// 1) Hooks RTCPeerConnection to know when a call is actually connected.
// 2) Hooks WebSocket / fetch / XHR to read participant data straight from the
//    call's own network traffic (no DOM clicking / calibration needed).
(function () {
  "use strict";

  const TAG = "MAXCT";

  function post(type, extra) {
    try {
      window.postMessage(Object.assign({ __maxct: true, source: TAG, type }, extra || {}), "*");
    } catch (_) {}
  }

  function debugOn() {
    try {
      return localStorage.getItem("maxct_debug") === "1";
    } catch (_) {
      return false;
    }
  }

  // ====================================================================
  // 1) WebRTC: detect when a call is connected.
  // ====================================================================
  (function hookRTC() {
    const OrigPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!OrigPC) return;
    const live = new Set();

    function emit() {
      post("pc-count", { count: live.size });
    }

    function track(pc) {
      function evaluate() {
        const s = pc.connectionState || pc.iceConnectionState || "";
        if (s === "connected" || s === "completed") {
          if (!live.has(pc)) { live.add(pc); emit(); }
        } else if (s === "failed" || s === "closed" || s === "disconnected") {
          if (live.has(pc)) { live.delete(pc); emit(); }
        }
      }
      pc.addEventListener("connectionstatechange", evaluate);
      pc.addEventListener("iceconnectionstatechange", evaluate);
      const origClose = pc.close.bind(pc);
      pc.close = function () {
        if (live.has(pc)) { live.delete(pc); emit(); }
        return origClose();
      };
    }

    class PatchedPC extends OrigPC {
      constructor() {
        super(...arguments);
        try { track(this); } catch (_) {}
      }
    }
    try {
      Object.getOwnPropertyNames(OrigPC).forEach(function (n) {
        if (!(n in PatchedPC)) {
          try { PatchedPC[n] = OrigPC[n]; } catch (_) {}
        }
      });
    } catch (_) {}
    window.RTCPeerConnection = PatchedPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PatchedPC;
  })();

  // ====================================================================
  // 2) Participant registry built from network messages.
  // ====================================================================
  const NAME_KEYS = ["displayname", "display_name", "fullname", "full_name",
    "name", "firstname", "first_name", "title", "nick", "nickname", "contactname"];
  const ID_KEYS = ["id", "userid", "user_id", "uid", "peerid", "peer_id",
    "memberid", "member_id", "accountid", "account_id", "contactid", "contact_id"];
  const ROSTER_KEY = /(participant|members?|roster|attendee|peers?|callusers?|conference|presence)/i;
  const TYPE_KEYS = ["event", "type", "op", "opcode", "action", "cmd",
    "command", "method", "kind", "eventtype", "event_type", "state"];
  const JOIN_RE = /(join|added|enter|connected|invite|online|present|active)/i;
  const LEAVE_RE = /(leave|left|removed|exit|disconnect|hang|kick|offline|gone|ended)/i;

  // id -> { name, ts }
  const registry = new Map();
  let dirty = false;

  function looksLikeUserId(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 1 || t.length > 64) return false;
    if (/^[0-9]+$/.test(t)) return true;
    if (/^[0-9a-f]{8,}$/i.test(t)) return true;
    if (/^[0-9a-f-]{8,}$/i.test(t)) return true;
    return false;
  }

  function extractId(low) {
    for (const k of ID_KEYS) {
      const v = low[k];
      if (v != null && looksLikeUserId(String(v))) return String(v).trim();
    }
    return null;
  }

  function looksLikeName(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 1 || t.length > 60) return false;
    if (/^[0-9]+$/.test(t)) return false;
    if (/^[0-9a-f]{16,}$/i.test(t)) return false; // hex id
    if (/^[0-9a-f-]{30,}$/i.test(t)) return false; // uuid
    if (/^https?:\/\//i.test(t)) return false;
    return /[\p{L}]/u.test(t); // has a letter
  }

  function personFrom(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const low = {};
    for (const k in o) {
      try { low[k.toLowerCase()] = o[k]; } catch (_) {}
    }
    const id = extractId(low);
    if (!id) return null;

    let name = null;
    const fn = low.firstname || low.first_name;
    const ln = low.lastname || low.last_name;
    if (looksLikeName(fn) || looksLikeName(ln)) {
      name = [fn, ln].filter(looksLikeName).join(" ").trim();
    }
    if (!name) {
      for (const k of NAME_KEYS) {
        if (looksLikeName(low[k])) { name = String(low[k]).trim(); break; }
      }
    }
    return { id: id, name: (name || id).slice(0, 60) };
  }

  function eventType(o) {
    for (const k of TYPE_KEYS) {
      const v = o[k];
      if (typeof v === "string") return v;
    }
    return "";
  }

  // Walk a parsed message and apply changes to the registry.
  function ingest(obj, depth) {
    if (depth > 7 || !obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (const it of obj) ingest(it, depth + 1);
      return;
    }

    const t = eventType(obj);
    const isLeave = t && LEAVE_RE.test(t) && !JOIN_RE.test(t);
    const isJoin = t && JOIN_RE.test(t) && !LEAVE_RE.test(t);

    // roster arrays under participant-ish keys -> authoritative-ish snapshot
    for (const k in obj) {
      let v;
      try { v = obj[k]; } catch (_) { continue; }
      if (Array.isArray(v) && ROSTER_KEY.test(k)) {
        const persons = [];
        for (const it of v) {
          const p = personFrom(it);
          if (p) persons.push(p);
          else if (typeof it === "object" && it) ingest(it, depth + 2);
        }
        if (persons.length) {
          applySnapshot(persons);
        }
      }
    }

    // single-person join/leave event
    const self = personFrom(obj);
    if (self) {
      if (isLeave) removePerson(self);
      else addPerson(self); // join or generic presence
    } else if (isLeave) {
      // leave event without a full person object: try to find an id
      const low = {};
      for (const k in obj) { try { low[k.toLowerCase()] = obj[k]; } catch (_) {} }
      for (const k of ID_KEYS) {
        if (low[k] != null) { removeById(String(low[k])); break; }
      }
    }

    // recurse
    for (const k in obj) {
      let v;
      try { v = obj[k]; } catch (_) { continue; }
      if (v && typeof v === "object") ingest(v, depth + 1);
    }
  }

  function addPerson(p) {
    const cur = registry.get(p.id);
    if (!cur || cur.name !== p.name) dirty = true;
    registry.set(p.id, { name: p.name, ts: Date.now() });
  }
  function removePerson(p) { removeById(p.id); }
  function removeById(id) {
    if (registry.has(id)) { registry.delete(id); dirty = true; }
  }
  function applySnapshot(persons) {
    // Replace the set with this roster (covers apps that resend full lists).
    const ids = new Set(persons.map(function (p) { return p.id; }));
    let changed = false;
    for (const id of Array.from(registry.keys())) {
      if (!ids.has(id)) { registry.delete(id); changed = true; }
    }
    for (const p of persons) {
      const cur = registry.get(p.id);
      if (!cur || cur.name !== p.name) changed = true;
      registry.set(p.id, { name: p.name, ts: Date.now() });
    }
    if (changed) dirty = true;
  }

  function tryParse(data) {
    if (typeof data !== "string") return null;
    const s = data.trim();
    if (!s || (s[0] !== "{" && s[0] !== "[")) return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  function handleData(data, src) {
    const obj = tryParse(data);
    if (!obj) return;
    if (debugOn()) {
      try {
        console.log("[MAXCT:" + src + "]", JSON.stringify(obj).slice(0, 1500));
      } catch (_) {}
    }
    try { ingest(obj, 0); } catch (_) {}
  }

  // Emit registry changes (debounced) to the content script.
  setInterval(function () {
    if (!dirty) return;
    dirty = false;
    const participants = [];
    registry.forEach(function (v, id) {
      participants.push({ id: id, name: v.name || id });
    });
    post("net-participants", { participants: participants });
  }, 1000);

  // ---- WebSocket hook ----
  (function hookWS() {
    const Orig = window.WebSocket;
    if (!Orig) return;
    class PatchedWS extends Orig {
      constructor() {
        super(...arguments);
        try {
          this.addEventListener("message", function (ev) {
            try { handleData(ev.data, "ws"); } catch (_) {}
          });
        } catch (_) {}
      }
    }
    try {
      Object.getOwnPropertyNames(Orig).forEach(function (n) {
        if (!(n in PatchedWS)) {
          try { PatchedWS[n] = Orig[n]; } catch (_) {}
        }
      });
    } catch (_) {}
    window.WebSocket = PatchedWS;
  })();

  // ---- fetch hook ----
  (function hookFetch() {
    const orig = window.fetch;
    if (!orig) return;
    window.fetch = function () {
      const p = orig.apply(this, arguments);
      try {
        p.then(function (res) {
          try {
            res.clone().text().then(function (t) { handleData(t, "fetch"); }).catch(function () {});
          } catch (_) {}
        }).catch(function () {});
      } catch (_) {}
      return p;
    };
  })();

  // ---- XHR hook ----
  (function hookXHR() {
    const OrigXHR = window.XMLHttpRequest;
    if (!OrigXHR) return;
    const open = OrigXHR.prototype.open;
    const send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function () {
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.send = function () {
      try {
        this.addEventListener("load", function () {
          try {
            const ct = this.getResponseHeader && this.getResponseHeader("content-type");
            if (ct && ct.indexOf("json") === -1 && this.responseType && this.responseType !== "text") return;
            const t = this.responseText;
            if (t) handleData(t, "xhr");
          } catch (_) {}
        });
      } catch (_) {}
      return send.apply(this, arguments);
    };
  })();

  post("inject-ready");
})();
