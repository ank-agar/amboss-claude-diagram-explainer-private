/**
 * background.js -- Background service worker
 * Context: Background (persists via alarms, survives restarts)
 * Design: Rate-limits sends to respect Claude.ai's 3 concurrent limit.
 *         First 3 requests open+send immediately. Subsequent requests
 *         are queued in chrome.storage.local and drained via
 *         chrome.alarms (reliable across service worker restarts).
 *         Tabs are NOT opened until it's time to send.
 */

importScripts("config.js");

var C = CONFIG;
var ALARM_NAME = "drain-queue";

// ── State (always loaded from storage, never trusted in memory) ──

function loadState(callback) {
  chrome.storage.local.get(
    ["sendQueue", "sendTimestamps", C.STORAGE_KEY_COOLDOWN_MS],
    function (result) {
      if (chrome.runtime.lastError) {
        callback([], [], C.QUEUE_COOLDOWN_MS);
        return;
      }
      var queue = result.sendQueue || [];
      var timestamps = result.sendTimestamps || [];
      var cooldown = result[C.STORAGE_KEY_COOLDOWN_MS] || C.QUEUE_COOLDOWN_MS;
      callback(queue, timestamps, cooldown);
    }
  );
}

function saveState(queue, timestamps, callback) {
  chrome.storage.local.set(
    { sendQueue: queue, sendTimestamps: timestamps },
    callback || function () {}
  );
}

// ── Rate limiting ──

function pruneStaleSendTimestamps(timestamps, cooldownMs) {
  var cutoff = Date.now() - cooldownMs;
  return timestamps.filter(function (ts) { return ts > cutoff; });
}

function countActiveSlots(timestamps, cooldownMs) {
  return pruneStaleSendTimestamps(timestamps, cooldownMs).length;
}

function getNextSlotDelayMs(timestamps, cooldownMs) {
  var pruned = pruneStaleSendTimestamps(timestamps, cooldownMs);
  if (pruned.length < C.MAX_CONCURRENT_REQUESTS) return 0;
  pruned.sort(function (a, b) { return a - b; });
  var earliest = pruned[0];
  return Math.max(0, earliest + cooldownMs - Date.now());
}

// ── Open tab and send (only called when it's time) ──

function openAndSendNow(messageText, openInBackground) {
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

        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, {
            type: C.MSG_INJECT_AND_SUBMIT,
            text: messageText,
          });
        }, C.CLAUDE_INJECT_DELAY_MS);
      };

      chrome.tabs.onUpdated.addListener(loadListener);
    }
  );
}

// ── Queue drain (called by alarm or directly) ──

function drainQueue() {
  loadState(function (queue, timestamps, cooldownMs) {
    timestamps = pruneStaleSendTimestamps(timestamps, cooldownMs);

    if (queue.length === 0) {
      saveState(queue, timestamps);
      chrome.alarms.clear(ALARM_NAME);
      return;
    }

    var slotsAvailable = C.MAX_CONCURRENT_REQUESTS - timestamps.length;
    var sent = 0;

    while (queue.length > 0 && sent < slotsAvailable) {
      var item = queue.shift();
      timestamps.push(Date.now());
      openAndSendNow(item.text, item.openInBackground);
      sent++;
    }

    saveState(queue, timestamps, function () {
      if (queue.length > 0) {
        // Schedule alarm for when next slot opens
        var delayMs = getNextSlotDelayMs(timestamps, cooldownMs);
        var delayMin = Math.max(delayMs / 60000, 0.5); // alarms minimum is 0.5 min
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: delayMin });
      } else {
        chrome.alarms.clear(ALARM_NAME);
      }
    });
  });
}

// ── Alarm listener (wakes service worker to drain queue) ──
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM_NAME) {
    drainQueue();
  }
});

// ── Also drain on startup (in case service worker restarted) ──
drainQueue();

// ── Message handler ──
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === C.MSG_OPEN_AND_INJECT) {
    if (!msg.text || typeof msg.text !== "string") {
      sendResponse({ success: false, error: "Missing or invalid message text" });
      return false;
    }

    loadState(function (queue, timestamps, cooldownMs) {
      timestamps = pruneStaleSendTimestamps(timestamps, cooldownMs);
      var slotsAvailable = C.MAX_CONCURRENT_REQUESTS - timestamps.length;

      if (slotsAvailable > 0 && queue.length === 0) {
        // Send immediately
        timestamps.push(Date.now());
        openAndSendNow(msg.text, !!msg.openInBackground);
        saveState(queue, timestamps);
        sendResponse({ success: true, queued: false, message: "Sending now..." });
      } else {
        // Queue it
        queue.push({
          text: msg.text,
          openInBackground: !!msg.openInBackground,
          addedAt: Date.now(),
        });
        saveState(queue, timestamps, function () {
          // Ensure alarm is set
          var delayMs = getNextSlotDelayMs(timestamps, cooldownMs);
          var delayMin = Math.max(delayMs / 60000, 0.5);
          chrome.alarms.create(ALARM_NAME, { delayInMinutes: delayMin });
        });

        var delayMs = getNextSlotDelayMs(timestamps, cooldownMs);
        var waitMin = Math.ceil(delayMs / 60000);
        sendResponse({
          success: true,
          queued: true,
          position: queue.length,
          message: "Queued (#" + queue.length + "). Sends in ~" + waitMin + " min.",
        });
      }
    });
    return true; // async response
  }

  if (msg.type === C.MSG_GET_QUEUE_STATUS) {
    loadState(function (queue, timestamps, cooldownMs) {
      timestamps = pruneStaleSendTimestamps(timestamps, cooldownMs);
      var delayMs = getNextSlotDelayMs(timestamps, cooldownMs);
      sendResponse({
        queueLength: queue.length,
        recentSends: timestamps.length,
        maxConcurrent: C.MAX_CONCURRENT_REQUESTS,
        canSendNow: timestamps.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0,
        nextSlotInMs: delayMs,
        cooldownMs: cooldownMs,
      });
    });
    return true;
  }

  return false;
});
