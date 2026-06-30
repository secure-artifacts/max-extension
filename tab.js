(function () {
  "use strict";

  const SESSIONS_KEY = "max_attendance_sessions";
  const CURRENT_KEY = "max_attendance_current";
  const SELF_FALLBACK_ID = "__self__";

  function el(id) { return document.getElementById(id); }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h > 0) return h + " 小时 " + m + " 分";
    if (m > 0) return m + " 分 " + s + " 秒";
    return s + " 秒";
  }

  function fmtMinutes(ms) {
    if (ms < 0) ms = 0;
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    if (min < 1) return sec + " 秒";
    if (sec === 0) return min + " 分钟";
    return min + " 分钟 " + sec + " 秒";
  }

  function fmtClock(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function fmtDateTime(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + fmtClock(ts);
  }

  function isSelfPerson(p, myUserId) {
    const uid = p.userId || "";
    return !!(p.isSelf || uid === SELF_FALLBACK_ID || (myUserId && uid === myUserId));
  }

  function personLabel(p, myUserId) {
    const uid = p.userId || p.name || "";
    const isSelf = isSelfPerson(p, myUserId);
    const name = p.name && p.name !== uid && p.name !== "我" ? p.name : "";
    if (isSelf) return name ? "我 · " + name : "我";
    if (name) return name;
    if (uid && uid !== SELF_FALLBACK_ID) return uid;
    return "未知用户";
  }

  function personIdLine(p, myUserId) {
    const uid = p.userId || "";
    if (uid && uid !== SELF_FALLBACK_ID) return "ID: " + uid;
    if (myUserId) return "ID: " + myUserId;
    return "ID: 识别中…";
  }

  function personTimeInfo(p) {
    const ms = p.ms != null ? p.ms : (p.totalMs || 0);
    const intervals = Array.isArray(p.intervals) ? p.intervals : [];
    let joinTs = p.firstSeen || null;
    let leaveTs = null;

    if (intervals.length) {
      joinTs = intervals[0].join || joinTs;
      const last = intervals[intervals.length - 1];
      if (p.online) {
        leaveTs = null;
      } else {
        leaveTs = last.leave || p.lastSeen || null;
      }
    } else if (p.online) {
      joinTs = p.curJoin || p.firstSeen || null;
      leaveTs = null;
    } else {
      joinTs = p.firstSeen || p.curJoin || null;
      leaveTs = p.lastSeen || null;
    }

    return {
      join: joinTs,
      leave: leaveTs,
      online: !!p.online,
      totalMs: ms,
      totalMin: fmtMinutes(ms)
    };
  }

  function sortPeople(people, myUserId) {
    return (people || []).slice().sort(function (a, b) {
      const aSelf = !!(a.isSelf || (myUserId && a.userId === myUserId));
      const bSelf = !!(b.isSelf || (myUserId && b.userId === myUserId));
      if (aSelf !== bSelf) return aSelf ? -1 : 1;
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      return (b.ms != null ? b.ms : b.totalMs || 0) - (a.ms != null ? a.ms : a.totalMs || 0);
    });
  }

  function createAvatarEl(p, myUserId) {
    const label = personLabel(p, myUserId);
    const wrap = document.createElement("div");
    wrap.className = "row-avatar-wrap";

    if (p.avatar) {
      const img = document.createElement("img");
      img.className = "row-avatar";
      img.alt = label;
      img.referrerPolicy = "no-referrer";
      img.src = p.avatar;
      img.addEventListener("error", function () {
        img.remove();
        const fb = document.createElement("div");
        fb.className = "row-avatar row-avatar-fallback" + (isSelfPerson(p, myUserId) ? " self-fb" : "");
        fb.textContent = avatarInitial(label, isSelfPerson(p, myUserId));
        wrap.appendChild(fb);
      });
      wrap.appendChild(img);
    } else {
      const fb = document.createElement("div");
      fb.className = "row-avatar row-avatar-fallback" + (isSelfPerson(p, myUserId) ? " self-fb" : "");
      fb.textContent = avatarInitial(label, isSelfPerson(p, myUserId));
      wrap.appendChild(fb);
    }
    return wrap;
  }

  function avatarInitial(label, isSelf) {
    if (isSelf) return "我";
    const t = String(label || "?").replace(/^我\s*·?\s*/, "").trim();
    return (t.charAt(0) || "?").toUpperCase();
  }

  function renderPersonRow(p, myUserId) {
    const info = personTimeInfo(p);
    const row = document.createElement("div");
    row.className = "row" + (isSelfPerson(p, myUserId) ? " self" : "") +
      (p.online ? " online" : "");

    const body = document.createElement("div");
    body.className = "row-body";

    body.appendChild(createAvatarEl(p, myUserId));

    const main = document.createElement("div");
    main.className = "row-main";

    const nameEl = document.createElement("div");
    nameEl.className = "row-name";
    nameEl.textContent = personLabel(p, myUserId);

    const idEl = document.createElement("div");
    idEl.className = "row-id";
    idEl.textContent = personIdLine(p, myUserId);

    const timesEl = document.createElement("div");
    timesEl.className = "row-times";

    const joinEl = document.createElement("div");
    joinEl.className = "row-time-line";
    joinEl.innerHTML = "<span class=\"row-time-label\">上线</span> " + fmtClock(info.join);

    const leaveEl = document.createElement("div");
    leaveEl.className = "row-time-line";
    leaveEl.innerHTML = "<span class=\"row-time-label\">下线</span> " +
      (info.online ? "<span class=\"row-online-tag\">在线中</span>" : fmtClock(info.leave));

    timesEl.appendChild(joinEl);
    timesEl.appendChild(leaveEl);

    const durEl = document.createElement("div");
    durEl.className = "row-dur";
    durEl.textContent = "共 " + info.totalMin;

    main.appendChild(nameEl);
    main.appendChild(idEl);
    main.appendChild(timesEl);
    main.appendChild(durEl);
    body.appendChild(main);
    row.appendChild(body);
    return row;
  }

  function render() {
    chrome.storage.local.get([SESSIONS_KEY, CURRENT_KEY], function (d) {
      const cur = d[CURRENT_KEY];
      const list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
      const statusEl = el("statusText");
      const timeEl = el("callTime");
      const box = el("peopleList");

      box.innerHTML = "";

      if (cur && cur.running && cur.start) {
        const myUserId = cur.myUserId || null;
        const people = sortPeople(cur.people, myUserId);
        statusEl.textContent = "通话进行中 · " + people.length + " 人";
        timeEl.textContent = fmtDuration(Date.now() - cur.start);

        if (!people.length) {
          const hint = document.createElement("div");
          hint.className = "empty";
          hint.textContent = "正在识别参会者…";
          box.appendChild(hint);
          return;
        }

        people.forEach(function (p) {
          box.appendChild(renderPersonRow(p, myUserId));
        });
        return;
      }

      const last = list[0];
      if (!last) {
        statusEl.textContent = "未在通话中";
        timeEl.textContent = "—";
        const hint = document.createElement("div");
        hint.className = "empty";
        hint.textContent = "打开 MAX 网页版加入通话后，点击扩展图标即可在此查看每人上线时长。";
        box.appendChild(hint);
        return;
      }

      const myUserId = (cur && cur.myUserId) || null;
      const people = sortPeople(last.people, myUserId);
      statusEl.textContent = last.end
        ? "上次通话 · " + fmtDateTime(last.start)
        : "上次通话 · 进行中";
      timeEl.textContent = fmtDuration((last.end || Date.now()) - last.start);

      if (!people.length) {
        const hint = document.createElement("div");
        hint.className = "empty";
        hint.textContent = "该次通话未记录到参会者";
        box.appendChild(hint);
        return;
      }

      people.forEach(function (p) {
        box.appendChild(renderPersonRow(p, myUserId));
      });
    });
  }

  el("clearAllBtn").addEventListener("click", function () {
    if (!confirm("确定清空全部通话出勤记录吗？此操作不可恢复。")) return;
    chrome.storage.local.get(CURRENT_KEY, function (d) {
      const myUserId = d[CURRENT_KEY] && d[CURRENT_KEY].myUserId;
      chrome.storage.local.set({
        [SESSIONS_KEY]: [],
        [CURRENT_KEY]: { running: false, myUserId: myUserId || null }
      }, render);
    });
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[SESSIONS_KEY] || changes[CURRENT_KEY]) render();
  });

  render();
  setInterval(render, 1000);
})();
