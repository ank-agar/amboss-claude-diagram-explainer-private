/**
 * background.js -- Background service worker
 * Context: Background (persists after popup closes)
 * Design: Handles opening claude.ai tabs and coordinating injection,
 *         since the popup may close before the tab finishes loading.
 */

importScripts("config.js");

var C = CONFIG;

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type !== C.MSG_OPEN_AND_INJECT) return false;

  if (!msg.text || typeof msg.text !== "string") {
    sendResponse({ success: false, error: "Missing or invalid message text" });
    return false;
  }

  var openInBackground = !!msg.openInBackground;
  var messageText = msg.text;

  chrome.tabs.create(
    { url: C.CLAUDE_NEW_CHAT_URL, active: !openInBackground },
    function (newTab) {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }

      var tabId = newTab.id;
      var done = false;

      // Timeout: clean up if tab never finishes loading
      var timeoutId = setTimeout(function () {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(loadListener);
        sendResponse({ success: false, error: "Claude tab load timed out" });
      }, C.TAB_LOAD_TIMEOUT_MS);

      var loadListener = function (updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(loadListener);

        // Wait for claude.ai JS to initialize, then inject
        setTimeout(function () {
          chrome.tabs.sendMessage(
            tabId,
            { type: C.MSG_INJECT_AND_SUBMIT, text: messageText },
            function (response) {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                sendResponse(response || { success: false, error: "No response from injector" });
              }
            }
          );
        }, C.CLAUDE_INJECT_DELAY_MS);
      };

      chrome.tabs.onUpdated.addListener(loadListener);
    }
  );

  return true; // async response
});
