/**
 * background.js -- Background service worker
 * Context: Background (persists after popup closes)
 * Design: Handles opening claude.ai tabs and coordinating injection.
 *         Rate limits sends to respect Claude.ai's 3 concurrent active
 *         tab limit. All tabs are opened and text pasted immediately,
 *         but "send" is delayed until the cooldown window allows it.
 *         Cooldowns stack per slot: if 3 are sent at T=0, the next 3
 *         can send at T+cooldown, the next 3 at T+2*cooldown, etc.
 */

importScripts("config.js");

var C = CONFIG;

// ── State ──
var sendTimestamps = []; // When each "send" was triggered

// Restore on startup
chrome.storage.session.get(["sendTimestamps"], function (result) {
  if (result.sendTimestamps) sendTimestamps = result.sendTimestamps;
});

function persistState() {
  chrome.storage.session.set({ sendTimestamps: sendTimestamps });
}

// ── Rate limiting ──
// Returns how many ms to wait before this request can send.
// The Nth request's send time = floor((N-1) / MAX_CONCURRENT) * cooldown + earliest_batch_start
function getDelayForNextSend(cooldownMs) {
  var max = C.MAX_CONCURRENT_REQUESTS;
  var now = Date.now();

  // Prune timestamps older than the maximum possible wait
  // (keep enough history to calculate stacking)
  var maxHistory = cooldownMs * 10;
  sendTimestamps = sendTimestamps.filter(function (ts) {
    return ts > now - maxHistory;
  });

  // Count how many sends are still within their cooldown window
  var activeSends = sendTimestamps.filter(function (ts) {
    return ts > now - cooldownMs;
  });

  if (activeSends.length < max) {
    // Slot available now
    return 0;
  }

  // Find the earliest timestamp in the active window -- that slot
  // will free up at earliest + cooldown
  activeSends.sort(function (a, b) { return a - b; });
  var earliestFree = activeSends[0] + cooldownMs;
  return Math.max(0, earliestFree - now);
}

// ── Open tab, paste immediately, schedule send ──
function openAndScheduleSend(messageText, openInBackground, sendDelayMs) {
  chrome.tabs.create(
    { url: C.CLAUDE_NEW_CHAT_URL, active: !openInBackground },
    function (newTab) {
      if (chrome.runtime.lastError) return;

      var tabId = newTab.id;
      var done = false;

      var timeoutId = setTimeout(function () {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(loadListener);
      }, C.TAB_LOAD_TIMEOUT_MS);

      var loadListener = function (updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(loadListener);

        // Wait for page JS to init, then inject text + schedule send
        setTimeout(function () {
          if (sendDelayMs <= 0) {
            // Send immediately
            chrome.tabs.sendMessage(tabId, {
              type: C.MSG_INJECT_AND_SUBMIT,
              text: messageText,
            });
          } else {
            // Paste text but don't submit yet
            chrome.tabs.sendMessage(tabId, {
              type: C.MSG_INJECT_AND_SUBMIT,
              text: messageText,
              delaySubmitMs: sendDelayMs,
            });
          }
        }, C.CLAUDE_INJECT_DELAY_MS);
      };

      chrome.tabs.onUpdated.addListener(loadListener);
    }
  );
}

// ── Message handler ──
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === C.MSG_OPEN_AND_INJECT) {
    if (!msg.text || typeof msg.text !== "string") {
      sendResponse({ success: false, error: "Missing or invalid message text" });
      return false;
    }

    // Load custom cooldown from storage
    chrome.storage.local.get([C.STORAGE_KEY_COOLDOWN_MS], function (result) {
      var cooldownMs = result[C.STORAGE_KEY_COOLDOWN_MS] || C.QUEUE_COOLDOWN_MS;
      var delayMs = getDelayForNextSend(cooldownMs);

      // Record this send timestamp (at the time it WILL send)
      sendTimestamps.push(Date.now() + delayMs);
      persistState();

      openAndScheduleSend(msg.text, !!msg.openInBackground, delayMs);

      if (delayMs <= 0) {
        sendResponse({ success: true, queued: false, message: "Sending now..." });
      } else {
        var waitMin = Math.ceil(delayMs / 60000);
        var waitSec = Math.ceil(delayMs / 1000);
        var timeStr = waitMin > 0 ? "~" + waitMin + " min" : waitSec + "s";
        sendResponse({
          success: true,
          queued: true,
          message: "Tab opened. Will send in " + timeStr + ".",
        });
      }
    });
    return true; // async response (storage read)
  }

  if (msg.type === C.MSG_GET_QUEUE_STATUS) {
    chrome.storage.local.get([C.STORAGE_KEY_COOLDOWN_MS], function (result) {
      var cooldownMs = result[C.STORAGE_KEY_COOLDOWN_MS] || C.QUEUE_COOLDOWN_MS;
      var delayMs = getDelayForNextSend(cooldownMs);
      sendResponse({
        recentSends: sendTimestamps.filter(function (ts) { return ts > Date.now() - cooldownMs; }).length,
        maxConcurrent: C.MAX_CONCURRENT_REQUESTS,
        canSendNow: delayMs <= 0,
        nextSlotInMs: delayMs,
        cooldownMs: cooldownMs,
      });
    });
    return true;
  }

  return false;
});
