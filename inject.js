// Runs in the PAGE context (MAIN world).
// Listens to MAX / VK Calls Signaling WebSocket (videowebrtc.okcdn.ru/ws2).
(function () {
  "use strict";

  const TAG = "MAXCT";
  const SIGNALING_RE = /videowebrtc\.okcdn\.ru/i;

  function post(type, extra) {
    try {
      window.postMessage(Object.assign({ __maxct: true, source: TAG, type: type }, extra || {}), "*");
    } catch (_) {}
  }

  function debugOn() {
    try { return localStorage.getItem("maxct_debug") === "1"; } catch (_) { return false; }
  }

  function debugLog(ctx, obj) {
    if (!debugOn()) return;
    try { console.log("[MAXCT:" + ctx + "]", typeof obj === "string" ? obj : JSON.stringify(obj).slice(0, 2000)); } catch (_) {}
  }

  function isSignalingUrl(url) {
    return SIGNALING_RE.test(String(url || ""));
  }

  function wsUserId(url) {
    try { return new URL(String(url)).searchParams.get("userId"); } catch (_) { return null; }
  }

  function tryParse(data) {
    if (typeof data !== "string") return null;
    const s = data.trim();
    if (!s || s[0] !== "{") return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  /** Primary roster key: participant.id (NOT externalId.id). */
  function mapParticipant(p, selfId) {
    if (!p || p.id == null) return null;
    const id = String(p.id);
    const self = selfId && id === String(selfId);
    return {
      id: id,
      name: id,
      isSelf: self,
      avatar: null,
      state: p.state || null,
      peerId: p.peerId && p.peerId.id != null ? String(p.peerId.id) : null
    };
  }

  function rosterFromList(list, selfId) {
    const out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (p) {
      const m = mapParticipant(p, selfId);
      if (m) out.push(m);
    });
    return out;
  }

  function flushRoster(participants, authoritative) {
    post("net-participants", {
      participants: participants,
      authoritative: !!authoritative
    });
  }

  function handleSignaling(obj, ctx) {
    if (!obj || typeof obj !== "object") return;
    debugLog(ctx.dir, obj);

    const selfId = ctx.selfId;
    const stamp = obj.stamp;

    if (obj.notification === "connection" && obj.conversation) {
      const participants = rosterFromList(obj.conversation.participants, selfId);
      const serverTime = obj.conversationParams && obj.conversationParams.serverTime;
      post("signaling-connection", {
        conversationId: obj.conversation.id || null,
        stamp: stamp,
        serverTime: serverTime || null,
        participants: participants
      });
      flushRoster(participants, true);
      return;
    }

    if (obj.notification === "participant-joined" || obj.notification === "participant-added") {
      const p = mapParticipant(obj.participant, selfId);
      if (p) {
        post("signaling-join", { participant: p, stamp: stamp });
      }
      return;
    }

    if (obj.notification === "hungup") {
      const uid = obj.participantId != null ? String(obj.participantId) : null;
      post("signaling-leave", {
        userId: uid,
        stamp: stamp,
        reason: obj.reason || null,
        endCall: false
      });
      return;
    }

    if (obj.notification === "closed-conversation") {
      post("signaling-call-end", { stamp: stamp, reason: obj.reason || "closed", from: "notification" });
      return;
    }

    if (obj.command === "hangup") {
      post("signaling-call-end", {
        stamp: stamp,
        reason: obj.reason || "HUNGUP",
        from: "command"
      });
      return;
    }

    if (obj.type === "response" && obj.response === "hangup") {
      post("signaling-call-end", { stamp: stamp, from: "response" });
      return;
    }

    if (obj.type === "response" && obj.response === "get-participants" && Array.isArray(obj.participants)) {
      const participants = rosterFromList(obj.participants, selfId);
      post("signaling-roster", { participants: participants, stamp: stamp });
      flushRoster(participants, true);
    }
  }

  function attachSignalingSocket(ws, url) {
    if (!ws || ws.__maxctSignaling) return;
    ws.__maxctSignaling = true;
    const selfId = wsUserId(url);

    ws.addEventListener("message", function (ev) {
      const obj = tryParse(ev.data);
      if (obj) handleSignaling(obj, { selfId: selfId, dir: "in" });
    });

    const origSend = ws.send;
    ws.send = function (data) {
      const obj = tryParse(data);
      if (obj) handleSignaling(obj, { selfId: selfId, dir: "out" });
      return origSend.apply(ws, arguments);
    };
  }

  (function hookWebSocket() {
    const Orig = window.WebSocket;
    if (!Orig) return;

    function PatchedWebSocket(url, protocols) {
      const ws = protocols !== undefined
        ? new Orig(url, protocols)
        : new Orig(url);
      const href = typeof url === "string" ? url : (url && url.toString()) || "";
      if (isSignalingUrl(href)) attachSignalingSocket(ws, href);
      return ws;
    }

    PatchedWebSocket.prototype = Orig.prototype;
    try { Object.setPrototypeOf(PatchedWebSocket, Orig); } catch (_) {}
    try {
      Object.getOwnPropertyNames(Orig).forEach(function (n) {
        if (!(n in PatchedWebSocket)) {
          try { PatchedWebSocket[n] = Orig[n]; } catch (_) {}
        }
      });
    } catch (_) {}
    PatchedWebSocket.CONNECTING = Orig.CONNECTING;
    PatchedWebSocket.OPEN = Orig.OPEN;
    PatchedWebSocket.CLOSING = Orig.CLOSING;
    PatchedWebSocket.CLOSED = Orig.CLOSED;

    window.WebSocket = PatchedWebSocket;
  })();

  post("inject-ready");
})();
