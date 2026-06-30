// Service worker: badge during calls + open attendance tab on icon click.
const TAB_PAGE = "tab.html";

chrome.action.onClicked.addListener(function () {
  const url = chrome.runtime.getURL(TAB_PAGE);
  chrome.tabs.query({ url: url }, function (tabs) {
    if (chrome.runtime.lastError) {
      chrome.tabs.create({ url: url });
      return;
    }
    if (tabs && tabs.length) {
      const tab = tabs[0];
      chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: url });
    }
  });
});

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || !msg.type) return;
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return;

  if (msg.type === "call-start") {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: "#36d399" });
    chrome.action.setBadgeText({ tabId: tabId, text: "0s" });
  } else if (msg.type === "call-tick") {
    chrome.action.setBadgeText({ tabId: tabId, text: msg.text || "•" });
  } else if (msg.type === "call-end") {
    chrome.action.setBadgeText({ tabId: tabId, text: "" });
  }
});

// Clean the badge when a tab finishes loading a fresh page.
chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === "loading") {
    chrome.action.setBadgeText({ tabId: tabId, text: "" });
  }
});
