(function () {
  "use strict";

  const SESSIONS_KEY = "max_attendance_sessions";
  const CURRENT_KEY = "max_attendance_current";

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
  const openIds = new Set();

  function totalDuration(s) {
    if (s.end) return s.end - s.start;
    return Date.now() - s.start;
  }

  function render() {
    chrome.storage.local.get(SESSIONS_KEY, function (d) {
      const list = Array.isArray(d[SESSIONS_KEY]) ? d[SESSIONS_KEY] : [];
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
          "暂无记录。<br />打开 MAX 网页版加入通话后，点击悬浮窗的「校准名单」并点一位参会者，即可自动记录每个人的在线时长。";
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
      e.textContent = "未记录到参会者（可能未校准名单）";
      plist.appendChild(e);
    } else {
      people.forEach(function (p) {
        const row = document.createElement("div");
        row.className = "person" + (p.online ? " on" : "");
        const dot = document.createElement("span");
        dot.className = "pdot";
        const nm = document.createElement("span");
        nm.className = "pname";
        nm.textContent = p.name;
        nm.title = p.name;
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

  // ---- actions ----------------------------------------------------------
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

  el("exportBtn").addEventListener("click", function () {
    if (!cache.length) { alert("没有可导出的记录。"); return; }
    const rows = [["通话开始", "通话结束", "参会者", "在线时长(分钟)", "在线时长", "首次出现", "最后出现"]];
    cache.forEach(function (s) {
      const sStart = new Date(s.start).toLocaleString();
      const sEnd = s.end ? new Date(s.end).toLocaleString() : "进行中";
      (s.people || []).forEach(function (p) {
        rows.push([
          sStart, sEnd,
          (p.name || "").replace(/[,\n]/g, " "),
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
  });

  render();
  refreshLive();
  setInterval(refreshLive, 1000);
})();
