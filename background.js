// Service worker: shows a per-tab badge while a call is being timed.
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
