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
importScripts("template-engine.js");

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
// callback(tabId) is called once the Claude tab has loaded and injection has been sent

function openAndSendNow(messageText, openInBackground, callback) {
  chrome.tabs.create(
    { url: C.CLAUDE_NEW_CHAT_URL, active: !openInBackground },
    function (newTab) {
      if (chrome.runtime.lastError) {
        if (callback) callback(null);
        return;
      }

      var tabId = newTab.id;
      var done = false;

      var timeoutId = setTimeout(function () {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(loadListener);
        if (callback) callback(tabId);
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
          if (callback) callback(tabId);
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
      if (item.isExpansion) {
        // For expansion items, resume expansion after tab opens
        openAndSendNow(item.text, item.openInBackground, function () {
          advanceExpansion();
        });
      } else {
        openAndSendNow(item.text, item.openInBackground);
      }
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

  // ── Tab Expansion: start batch generation ──
  if (msg.type === C.MSG_START_EXPANSION) {
    var expansion = {
      baseUrl: msg.baseUrl,
      startQ: msg.startQ,
      endQ: msg.endQ,
      currentQ: msg.startQ,
      skillPrefix: msg.skillPrefix,
      skillId: msg.skillId,
      openInBackground: !!msg.openInBackground,
      running: true,
    };

    chrome.storage.local.set({ expansion: expansion }, function () {
      var count = expansion.endQ - expansion.startQ + 1;
      sendResponse({
        success: true,
        message: "Expanding " + count + " questions (Q" + expansion.startQ + "-Q" + expansion.endQ + ")...",
      });
      processNextExpansionQuestion();
    });
    return true;
  }

  if (msg.type === C.MSG_GET_EXPANSION_STATUS) {
    chrome.storage.local.get(["expansion"], function (result) {
      var exp = result.expansion;
      if (!exp || !exp.running) {
        sendResponse({ running: false });
      } else {
        sendResponse({
          running: true,
          currentQ: exp.currentQ,
          endQ: exp.endQ,
          startQ: exp.startQ,
          total: exp.endQ - exp.startQ + 1,
          done: exp.currentQ - exp.startQ,
        });
      }
    });
    return true;
  }

  if (msg.type === C.MSG_STOP_EXPANSION) {
    chrome.storage.local.get(["expansion"], function (result) {
      if (result.expansion) {
        result.expansion.running = false;
        chrome.storage.local.set({ expansion: result.expansion });
      }
      chrome.alarms.clear("expansion-next");
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});

// ── Tab Expansion: process one question at a time ──

var EXPANSION_ALARM = "expansion-next";

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === EXPANSION_ALARM) {
    processNextExpansionQuestion();
  }
});

function processNextExpansionQuestion() {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running || exp.currentQ > exp.endQ) {
      // Done
      if (exp) {
        exp.running = false;
        chrome.storage.local.set({ expansion: exp });
      }
      return;
    }

    var questionUrl = exp.baseUrl + exp.currentQ;
    var questionNum = exp.currentQ;

    // Step 1: Open the AMBOSS question tab
    chrome.tabs.create(
      { url: questionUrl, active: false },
      function (ambossTab) {
        if (chrome.runtime.lastError) {
          scheduleNextExpansion();
          return;
        }

        // Step 2: Wait for it to load
        var done = false;
        var timeoutId = setTimeout(function () {
          if (done) return;
          done = true;
          chrome.tabs.onUpdated.removeListener(listener);
          // Skip this question, move on
          advanceExpansion();
        }, C.TAB_LOAD_TIMEOUT_MS);

        var listener = function (tabId, changeInfo) {
          if (tabId !== ambossTab.id || changeInfo.status !== "complete") return;
          if (done) return;
          done = true;
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);

          // Step 3: Wait for SPA to render, then scrape with retries
          setTimeout(function () {
            scrapeWithRetry(ambossTab.id, C.EXPANSION_SCRAPE_MAX_RETRIES, function (scraped) {
              if (!scraped || !scraped.question) {
                // Give up on this question, advance
                advanceExpansion();
                return;
              }
              var skill = { prefix: exp.skillPrefix };
              var messageText = buildExpansionMessage(skill, scraped);
              queueClaudeTabForExpansion(messageText);
            });
          }, C.EXPANSION_INITIAL_WAIT_MS);
        };

        chrome.tabs.onUpdated.addListener(listener);
      }
    );
  });
}

/**
 * Scrape an AMBOSS tab with retries. AMBOSS is an SPA so the question
 * content may not be rendered when the page reports "complete".
 * Retries every EXPANSION_SCRAPE_RETRY_INTERVAL_MS until content appears.
 */
function scrapeWithRetry(tabId, retriesLeft, callback) {
  chrome.scripting.executeScript(
    { target: { tabId: tabId }, files: ["config.js"] },
    function () {
      if (chrome.runtime.lastError) {
        if (retriesLeft > 0) {
          setTimeout(function () { scrapeWithRetry(tabId, retriesLeft - 1, callback); }, C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS);
        } else {
          callback(null);
        }
        return;
      }

      chrome.scripting.executeScript(
        { target: { tabId: tabId }, files: ["scraper.js"] },
        function (results) {
          if (chrome.runtime.lastError) {
            if (retriesLeft > 0) {
              setTimeout(function () { scrapeWithRetry(tabId, retriesLeft - 1, callback); }, C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS);
            } else {
              callback(null);
            }
            return;
          }

          var scraped = results && results[0] && results[0].result;
          if (scraped && scraped.question) {
            callback(scraped);
          } else if (retriesLeft > 0) {
            setTimeout(function () { scrapeWithRetry(tabId, retriesLeft - 1, callback); }, C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS);
          } else {
            callback(null);
          }
        }
      );
    }
  );
}

/**
 * Queue a Claude tab send for expansion. If a slot is available, opens
 * and sends immediately, then advances. If not, queues it and sets an
 * alarm -- the expansion will resume when the queue drains.
 */
function queueClaudeTabForExpansion(messageText) {
  loadState(function (queue, timestamps, cooldownMs) {
    timestamps = pruneStaleSendTimestamps(timestamps, cooldownMs);
    var slotsAvailable = C.MAX_CONCURRENT_REQUESTS - timestamps.length;

    if (slotsAvailable > 0 && queue.length === 0) {
      // Send immediately, advance after tab opens
      timestamps.push(Date.now());
      saveState(queue, timestamps);
      openAndSendNow(messageText, true, function () {
        advanceExpansion();
      });
    } else {
      // Queue it. The expansion will NOT advance until this item drains.
      // Tag it so drainQueue knows to resume expansion after sending it.
      queue.push({
        text: messageText,
        openInBackground: true,
        addedAt: Date.now(),
        isExpansion: true,
      });
      saveState(queue, timestamps, function () {
        var delayMs = getNextSlotDelayMs(timestamps, cooldownMs);
        var delayMin = Math.max(delayMs / 60000, 0.5);
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: delayMin });
      });
      // Don't advance -- drainQueue will call advanceExpansion when it sends this item
    }
  });
}

function buildExpansionMessage(skill, scraped) {
  // Use the template engine with default templates
  // (custom templates could be loaded from storage if needed)
  return TemplateEngine.buildMessage(
    skill, scraped, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE
  );
}

function advanceExpansion() {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) return;

    exp.currentQ++;
    chrome.storage.local.set({ expansion: exp }, function () {
      if (exp.currentQ > exp.endQ) {
        // All done
        exp.running = false;
        chrome.storage.local.set({ expansion: exp });
        return;
      }

      // Process the next question immediately.
      // It will open the AMBOSS tab, scrape, then call queueClaudeTabForExpansion
      // which handles waiting for queue slots if needed.
      processNextExpansionQuestion();
    });
  });
}
