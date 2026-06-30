(function () {
  "use strict";

  const SESSIONS_KEY = "max_attendance_sessions";
  const CURRENT_KEY = "max_attendance_current";
  const OPTIONS_KEY = "max_attendance_options";
  const DEFAULT_OPTIONS = {
    maxSessions: 200,
    retentionDays: 90,
    customSelectors: [],
    debugMode: false,
    scanIntervalMs: 3000
  };

  const el = function (id) { return document.getElementById(id); };
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function fmt(ms) {
    if (ms < 0) ms = 0;
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
  }
  function fmtMin(ms) {
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    if (min === 0) return sec + " 秒";
    return min + " 分" + (sec ? sec + "秒" : "");
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function fmtClock(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  let cache = [];
  let options = Object.assign({}, DEFAULT_OPTIONS);
  const openIds = new Set();

  function pruneSessionsList(list) {
    let out = list.slice();
    const days = options.retentionDays | 0;
    if (days > 0) {
      const cut = Date.now() - days * 86400000;
      out = out.filter(function (s) { return (s.start || 0) >= cut; });
    }
    const max = options.maxSessions | 0;
    if (max > 0 && out.length > max) out.length = max;
    return out;
  }

  function loadOptions(cb) {
    chrome.storage.local.get(OPTIONS_KEY, function (d) {
      options = Object.assign({}, DEFAULT_OPTIONS, d[OPTIONS_KEY] || {});
      el("optMaxSessions").value = options.maxSessions;
      el("optRetentionDays").value = options.retentionDays;
      el("optScanMs").value = options.scanIntervalMs;
      el("optDebug").checked = !!options.debugMode;
      el("optSelectors").value = (options.customSelectors || []).join("\n");
      if (cb) cb();
    });
  }

  function saveOptions() {
    options = {
      maxSessions: Math.max(10, Math.min(500, parseInt(el("optMaxSessions").value, 10) || 200)),
      retentionDays: Math.max(0, parseInt(el("optRetentionDays").value, 10) || 0),
      scanIntervalMs: Math.max(1000, Math.min(30000, parseInt(el("optScanMs").value, 10) || 3000)),
      debugMode: el("optDebug").checked,
      customSelectors: el("optSelectors").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean)
    };
    chrome.storage.local.set({ [OPTIONS_KEY]: options }, function () {
      alert("设置已保存");
      render();
    });
  }

  function updatePerson(sessionId, userId, patch) {
    chrome.storage.local.get(SESSIONS_KEY, function (d) {
      let list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
      const si = list.findIndex(function (s) { return s.id === sessionId; });
      if (si < 0) return;
      const people = list[si].people || [];
      const pi = people.findIndex(function (p) { return (p.userId || p.name) === userId; });
      if (pi < 0) return;
      Object.assign(people[pi], patch);
      list[si].people = people;
      chrome.storage.local.set({ [SESSIONS_KEY]: list }, render);
    });
  }

  function totalDuration(s) {
    if (s.end) return s.end - s.start;
    return Date.now() - s.start;
  }

  function render() {
    chrome.storage.local.get(SESSIONS_KEY, function (d) {
      let list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
      list = pruneSessionsList(list);
      if (list.length !== (d[SESSIONS_KEY] || []).length) {
        chrome.storage.local.set({ [SESSIONS_KEY]: list });
      }
      cache = list;

      let peopleCount = 0;
      list.forEach(function (s) { peopleCount += (s.people || []).length; });
      el("statSessions").textContent = String(list.length);
      el("statPeople").textContent = String(peopleCount);

      const box = el("sessions");
      box.innerHTML = "";
      if (!list.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.innerHTML =
          "暂无记录。<br />打开 MAX 网页版加入通话后，插件会从网络/DOM 读取<strong>用户 ID</strong>并记录在线时长。";
        box.appendChild(e);
        return;
      }

      list.forEach(function (s) {
        box.appendChild(renderSession(s));
      });
    });
  }

  function renderSession(s) {
    const people = (s.people || []).slice().sort(function (a, b) {
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      return b.totalMs - a.totalMs;
    });
    const onlineN = people.filter(function (p) { return p.online; }).length;
    const ongoing = !s.end;

    const wrap = document.createElement("div");
    wrap.className = "session" + (openIds.has(s.id) ? " open" : "");

    const head = document.createElement("div");
    head.className = "session-head";

    const info = document.createElement("div");
    info.className = "session-info";
    const date = document.createElement("div");
    date.className = "session-date";
    date.textContent = fmtDate(s.start) + " " + fmtClock(s.start) +
      (s.end ? " – " + fmtClock(s.end) : "");
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = "时长 " + fmt(totalDuration(s)) + " · " + people.length + " 人";
    info.appendChild(date);
    info.appendChild(meta);

    const right = document.createElement("div");
    right.className = "session-right";
    if (ongoing) {
      const live = document.createElement("span");
      live.className = "session-live";
      live.textContent = "● 进行中 " + onlineN;
      right.appendChild(live);
    } else {
      const cnt = document.createElement("span");
      cnt.className = "session-count";
      cnt.textContent = people.length + " 人";
      right.appendChild(cnt);
    }
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "\u25B6";
    right.appendChild(chev);

    head.appendChild(info);
    head.appendChild(right);
    head.addEventListener("click", function () {
      if (openIds.has(s.id)) openIds.delete(s.id);
      else openIds.add(s.id);
      wrap.classList.toggle("open");
    });

    const plist = document.createElement("div");
    plist.className = "people";
    if (!people.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.style.padding = "12px";
      e.textContent = "未记录到参会者";
      plist.appendChild(e);
    } else {
      people.forEach(function (p) {
        const uid = p.userId || p.name || "—";
        const row = document.createElement("div");
        row.className = "person" + (p.online ? " on" : "");
        const dot = document.createElement("span");
        dot.className = "pdot";
        const nm = document.createElement("span");
        nm.className = "pname";
        const label = p.name && p.name !== uid ? uid + " · " + p.name : uid;
        nm.textContent = label + (p.note ? " 📝" : "");
        nm.title = "用户ID: " + uid + "\n双击编辑姓名/备注";
        nm.addEventListener("dblclick", function (ev) {
          ev.stopPropagation();
          const newName = prompt("编辑姓名（留空则仅显示 ID）", p.name !== uid ? p.name : "");
          if (newName === null) return;
          const note = prompt("备注（可选）", p.note || "");
          if (note === null) return;
          updatePerson(s.id, uid, {
            name: newName.trim() || uid,
            note: note.trim(),
            nameLocked: true
          });
        });
        const min = document.createElement("span");
        min.className = "pmin";
        min.textContent = fmtMin(p.totalMs);
        row.appendChild(dot);
        row.appendChild(nm);
        row.appendChild(min);
        plist.appendChild(row);
      });
    }

    wrap.appendChild(head);
    wrap.appendChild(plist);
    return wrap;
  }

  function refreshLive() {
    chrome.storage.local.get(CURRENT_KEY, function (d) {
      const cur = d[CURRENT_KEY];
      const timeEl = el("liveTime");
      const statusEl = el("liveStatus");
      const onlineEl = el("statOnline");
      if (cur && cur.running && cur.start) {
        timeEl.textContent = fmt(Date.now() - cur.start);
        timeEl.classList.add("active");
        const online = (cur.people || []).filter(function (p) { return p.online; }).length;
        onlineEl.textContent = String(online);
        statusEl.textContent = (cur.source === "manual" ? "手动记录中" : "通话中") +
          (cur.detect ? " · " + cur.detect : "");
      } else {
        timeEl.textContent = "00:00";
        timeEl.classList.remove("active");
        onlineEl.textContent = "0";
        statusEl.textContent = "空闲";
      }
    });
  }

  el("clearBtn").addEventListener("click", function () {
    if (!confirm("确定清空所有通话与出勤记录吗？")) return;
    chrome.storage.local.set({ [SESSIONS_KEY]: [] }, render);
  });

  el("calibBtn").addEventListener("click", function () {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { cmd: "calibrate" }, function () {
        void chrome.runtime.lastError;
        window.close();
      });
    });
  });

  el("settingsBtn").addEventListener("click", function () {
    el("settingsPanel").open = !el("settingsPanel").open;
  });

  el("saveSettingsBtn").addEventListener("click", saveOptions);

  el("privacyLink").addEventListener("click", function (e) {
    e.preventDefault();
    alert(
      "隐私说明\n\n" +
      "• 本插件仅在 max.ru / web.max.ru 运行\n" +
      "• 收集：用户 ID、显示姓名、上线/下线时间、在线时长\n" +
      "• 存储：全部保存在本机 chrome.storage.local，不上传服务器\n" +
      "• 权限：storage（本地存储）+ 指定网站访问权\n" +
      "• 你可随时导出 CSV 或清空全部记录"
    );
  });

  el("exportBtn").addEventListener("click", function () {
    if (!cache.length) { alert("没有可导出的记录。"); return; }
    const rows = [["通话开始", "通话结束", "用户ID", "姓名", "备注", "在线时长(分钟)", "在线时长", "首次出现", "最后出现"]];
    cache.forEach(function (s) {
      const sStart = new Date(s.start).toLocaleString();
      const sEnd = s.end ? new Date(s.end).toLocaleString() : "进行中";
      (s.people || []).forEach(function (p) {
        const uid = p.userId || p.name || "";
        const name = (p.name && p.name !== uid) ? p.name : "";
        rows.push([
          sStart, sEnd,
          String(uid).replace(/[,\n]/g, " "),
          String(name).replace(/[,\n]/g, " "),
          String(p.note || "").replace(/[,\n]/g, " "),
          (p.totalMs / 60000).toFixed(1),
          fmt(p.totalMs),
          p.firstSeen ? new Date(p.firstSeen).toLocaleTimeString() : "",
          p.lastSeen ? new Date(p.lastSeen).toLocaleTimeString() : ""
        ]);
      });
    });
    const csv = "\uFEFF" + rows.map(function (r) { return r.join(","); }).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "max-attendance.csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[SESSIONS_KEY]) render();
    if (changes[CURRENT_KEY]) refreshLive();
    if (changes[OPTIONS_KEY]) loadOptions();
  });

  loadOptions(function () {
    render();
    refreshLive();
  });
  setInterval(refreshLive, 1000);
})();
