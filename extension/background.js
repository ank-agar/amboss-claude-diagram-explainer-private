/**
 * background.js -- Background service worker
 * Context: Background (persists via alarms, survives restarts)
 * Design: Rate-limits sends to respect Claude.ai's 3 concurrent limit.
 *         All timing uses chrome.alarms (never setTimeout for delays >5s)
 *         because service workers get killed after ~30s of inactivity.
 */

importScripts("config.js");
importScripts("template-engine.js");

var C = CONFIG;
var QUEUE_ALARM = "drain-queue";
var EXPANSION_ALARM = "expansion-tick";

// ── State (always loaded from storage, never trusted in memory) ──

function loadState(callback) {
  chrome.storage.local.get(
    ["sendQueue", "sendTimestamps", C.STORAGE_KEY_COOLDOWN_MS],
    function (result) {
      if (chrome.runtime.lastError) {
        callback([], [], C.QUEUE_COOLDOWN_MS);
        return;
      }
      callback(
        result.sendQueue || [],
        result.sendTimestamps || [],
        result[C.STORAGE_KEY_COOLDOWN_MS] || C.QUEUE_COOLDOWN_MS
      );
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

function pruneTimestamps(timestamps, cooldownMs) {
  var cutoff = Date.now() - cooldownMs;
  return timestamps.filter(function (ts) { return ts > cutoff; });
}

function getNextSlotDelayMs(timestamps, cooldownMs) {
  var pruned = pruneTimestamps(timestamps, cooldownMs);
  if (pruned.length < C.MAX_CONCURRENT_REQUESTS) return 0;
  pruned.sort(function (a, b) { return a - b; });
  return Math.max(0, pruned[0] + cooldownMs - Date.now());
}

// ── Open Claude tab, inject, call back when done ──

function openClaudeTab(messageText, openInBackground, callback) {
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

// ── Queue: drain via alarm ──

function drainQueue() {
  loadState(function (queue, timestamps, cooldownMs) {
    timestamps = pruneTimestamps(timestamps, cooldownMs);

    if (queue.length === 0) {
      saveState(queue, timestamps);
      chrome.alarms.clear(QUEUE_ALARM);
      return;
    }

    var slotsAvailable = C.MAX_CONCURRENT_REQUESTS - timestamps.length;
    var sent = 0;

    while (queue.length > 0 && sent < slotsAvailable) {
      var item = queue.shift();
      timestamps.push(Date.now());
      if (item.isExpansion) {
        openClaudeTab(item.text, true, function () {
          advanceExpansion();
        });
      } else {
        openClaudeTab(item.text, item.openInBackground);
      }
      sent++;
    }

    saveState(queue, timestamps, function () {
      if (queue.length > 0) {
        var delayMs = getNextSlotDelayMs(timestamps, cooldownMs);
        var delayMin = Math.max(delayMs / 60000, 0.5);
        chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: delayMin });
      }
    });
  });
}

// ── Alarm listeners ──

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === QUEUE_ALARM) drainQueue();
  if (alarm.name === EXPANSION_ALARM) {
    // Safety net: restart the fast tick loop if it died
    expansionLoopActive = false;
    expansionTickLoop();
  }
});

// Drain on startup in case items were left
drainQueue();

// ── Message handler ──

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  // Single question send
  if (msg.type === C.MSG_OPEN_AND_INJECT) {
    if (!msg.text || typeof msg.text !== "string") {
      sendResponse({ success: false, error: "Missing message text" });
      return false;
    }

    loadState(function (queue, timestamps, cooldownMs) {
      timestamps = pruneTimestamps(timestamps, cooldownMs);

      if (timestamps.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0) {
        timestamps.push(Date.now());
        saveState(queue, timestamps);
        openClaudeTab(msg.text, !!msg.openInBackground);
        sendResponse({ success: true, queued: false, message: "Sending now..." });
      } else {
        queue.push({ text: msg.text, openInBackground: !!msg.openInBackground, addedAt: Date.now() });
        saveState(queue, timestamps, function () {
          var delayMs = getNextSlotDelayMs(timestamps, cooldownMs);
          var delayMin = Math.max(delayMs / 60000, 0.5);
          chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: delayMin });
        });
        var waitMin = Math.ceil(getNextSlotDelayMs(timestamps, cooldownMs) / 60000);
        sendResponse({ success: true, queued: true, position: queue.length, message: "Queued (#" + queue.length + "). Sends in ~" + waitMin + " min." });
      }
    });
    return true;
  }

  // Queue status
  if (msg.type === C.MSG_GET_QUEUE_STATUS) {
    loadState(function (queue, timestamps, cooldownMs) {
      timestamps = pruneTimestamps(timestamps, cooldownMs);
      sendResponse({
        queueLength: queue.length,
        recentSends: timestamps.length,
        maxConcurrent: C.MAX_CONCURRENT_REQUESTS,
        canSendNow: timestamps.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0,
        nextSlotInMs: getNextSlotDelayMs(timestamps, cooldownMs),
        cooldownMs: cooldownMs,
      });
    });
    return true;
  }

  // ── Tab Expansion ──

  if (msg.type === C.MSG_START_EXPANSION) {
    var exp = {
      baseUrl: msg.baseUrl,
      startQ: msg.startQ,
      endQ: msg.endQ,
      currentQ: msg.startQ,
      skillPrefix: msg.skillPrefix,
      openInBackground: !!msg.openInBackground,
      running: true,
      // State machine: "open-amboss" | "wait-scrape" | "wait-claude-slot" | "open-claude"
      phase: "open-amboss",
      ambossTabId: null,
      scrapeAttempts: 0,
      messageText: null,
    };

    // Clear any stale send timestamps before starting expansion
    chrome.storage.local.set({ expansion: exp, sendTimestamps: [] }, function () {
      var count = exp.endQ - exp.startQ + 1;
      sendResponse({ success: true, message: "Expanding " + count + " questions..." });
      // Chrome alarms minimum is 0.5 min. Use that, but also tick immediately
      // and keep worker alive with self-messaging during active expansion.
      chrome.alarms.create(EXPANSION_ALARM, { periodInMinutes: 0.5 });
      expansionTickLoop();
    });
    return true;
  }

  if (msg.type === C.MSG_GET_EXPANSION_STATUS) {
    chrome.storage.local.get(["expansion"], function (result) {
      var exp = result.expansion;
      sendResponse(exp && exp.running
        ? { running: true, currentQ: exp.currentQ, endQ: exp.endQ, startQ: exp.startQ, phase: exp.phase }
        : { running: false });
    });
    return true;
  }

  // Reset all queue/expansion state (for debugging)
  if (msg.type === "reset-all-state") {
    chrome.storage.local.set({
      sendQueue: [],
      sendTimestamps: [],
      expansion: null,
    }, function () {
      chrome.alarms.clearAll();
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === C.MSG_STOP_EXPANSION) {
    chrome.storage.local.get(["expansion"], function (result) {
      if (result.expansion) {
        result.expansion.running = false;
        chrome.storage.local.set({ expansion: result.expansion });
      }
      chrome.alarms.clear(EXPANSION_ALARM);
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});

// ── Expansion tick loop ──
// Chrome alarms have a 30s minimum period. For faster ticking during active
// expansion, we use a self-scheduling setTimeout loop. The 30s alarm acts as
// a safety net to restart the loop if the worker slept and killed the setTimeout.

var expansionLoopActive = false;

function expansionTickLoop() {
  if (expansionLoopActive) return;
  expansionLoopActive = true;
  doExpansionLoop();
}

function doExpansionLoop() {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) {
      expansionLoopActive = false;
      chrome.alarms.clear(EXPANSION_ALARM);
      return;
    }
    expansionTick();
    // Schedule next tick in 3 seconds. If the worker sleeps, the alarm
    // at 30s will call expansionTickLoop() to restart this.
    setTimeout(doExpansionLoop, 3000);
  });
}

// ── Expansion state machine ──
// Each tick reads the expansion state, does one step, saves, and returns.

function expansionTick() {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) {
      chrome.alarms.clear(EXPANSION_ALARM);
      return;
    }

    if (exp.currentQ > exp.endQ) {
      exp.running = false;
      chrome.storage.local.set({ expansion: exp });
      chrome.alarms.clear(EXPANSION_ALARM);
      return;
    }

    if (exp.phase === "open-amboss") {
      // Open the AMBOSS question tab
      var url = exp.baseUrl + exp.currentQ;
      chrome.tabs.create({ url: url, active: false }, function (tab) {
        if (chrome.runtime.lastError) {
          // Skip this question
          exp.currentQ++;
          chrome.storage.local.set({ expansion: exp });
          return;
        }
        exp.ambossTabId = tab.id;
        exp.phase = "wait-load";
        exp.scrapeAttempts = 0;
        chrome.storage.local.set({ expansion: exp });
      });
      return;
    }

    if (exp.phase === "wait-load") {
      // Check if the AMBOSS tab has loaded
      if (!exp.ambossTabId) {
        exp.phase = "open-amboss";
        chrome.storage.local.set({ expansion: exp });
        return;
      }
      chrome.tabs.get(exp.ambossTabId, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          // Tab gone, skip
          exp.currentQ++;
          exp.phase = "open-amboss";
          chrome.storage.local.set({ expansion: exp });
          return;
        }
        if (tab.status === "complete") {
          exp.phase = "scrape";
          chrome.storage.local.set({ expansion: exp });
        }
        // else: still loading, wait for next tick
      });
      return;
    }

    if (exp.phase === "scrape") {
      // Try to scrape the AMBOSS tab
      exp.scrapeAttempts++;
      chrome.storage.local.set({ expansion: exp });

      chrome.scripting.executeScript(
        { target: { tabId: exp.ambossTabId }, files: ["config.js"] },
        function () {
          if (chrome.runtime.lastError) {
            handleScrapeResult(exp, null);
            return;
          }
          chrome.scripting.executeScript(
            { target: { tabId: exp.ambossTabId }, files: ["scraper.js"] },
            function (results) {
              if (chrome.runtime.lastError) {
                handleScrapeResult(exp, null);
                return;
              }
              var scraped = results && results[0] && results[0].result;
              handleScrapeResult(exp, scraped);
            }
          );
        }
      );
      return;
    }

    if (exp.phase === "wait-claude-slot") {
      // Check if a queue slot is available
      loadState(function (queue, timestamps, cooldownMs) {
        timestamps = pruneTimestamps(timestamps, cooldownMs);
        if (timestamps.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0) {
          exp.phase = "open-claude";
          chrome.storage.local.set({ expansion: exp });
        }
        // else: wait for next tick (or queue alarm will also trigger)
      });
      return;
    }

    if (exp.phase === "open-claude") {
      // Open the Claude tab and send
      if (!exp.messageText) {
        // No message -- skip
        exp.currentQ++;
        exp.phase = "open-amboss";
        chrome.storage.local.set({ expansion: exp });
        return;
      }

      // Record the send timestamp
      loadState(function (queue, timestamps, cooldownMs) {
        timestamps = pruneTimestamps(timestamps, cooldownMs);
        timestamps.push(Date.now());
        saveState(queue, timestamps);

        openClaudeTab(exp.messageText, true, function () {
          // Claude tab opened and injected -- advance to next question
          exp.currentQ++;
          exp.phase = "open-amboss";
          exp.messageText = null;
          exp.ambossTabId = null;
          chrome.storage.local.set({ expansion: exp });
        });
      });
      return;
    }
  });
}

function handleScrapeResult(exp, scraped) {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) return;

    if (scraped && scraped.question) {
      // Scrape succeeded -- build message and move to Claude phase
      var skill = { prefix: exp.skillPrefix };
      exp.messageText = TemplateEngine.buildMessage(skill, scraped, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
      exp.phase = "wait-claude-slot";
      chrome.storage.local.set({ expansion: exp });
    } else if (exp.scrapeAttempts < C.EXPANSION_SCRAPE_MAX_RETRIES) {
      // Retry -- stay in "scrape" phase, next tick will try again
      exp.phase = "scrape";
      chrome.storage.local.set({ expansion: exp });
    } else {
      // Give up on this question, skip
      exp.currentQ++;
      exp.phase = "open-amboss";
      exp.messageText = null;
      chrome.storage.local.set({ expansion: exp });
    }
  });
}

function advanceExpansion() {
  // Called by drainQueue when an expansion item from the queue gets sent
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) return;
    exp.currentQ++;
    exp.phase = "open-amboss";
    exp.messageText = null;
    exp.ambossTabId = null;
    chrome.storage.local.set({ expansion: exp });
  });
}
