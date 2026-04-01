/**
 * background.js -- Background service worker
 * Context: Background (persists via alarms, survives restarts)
 * Design: Rate-limits sends to respect Claude.ai's 3 concurrent limit.
 *         Expansion uses an alarm-driven state machine with a "busy"
 *         guard to prevent race conditions from overlapping ticks.
 */

importScripts("config.js");
importScripts("template-engine.js");

var C = CONFIG;
var QUEUE_ALARM = "drain-queue";
var EXPANSION_ALARM = "expansion-tick";

// ── State (always from storage) ──

function loadState(callback) {
  chrome.storage.local.get(
    ["sendQueue", "sendTimestamps", C.STORAGE_KEY_COOLDOWN_MS],
    function (result) {
      if (chrome.runtime.lastError) { callback([], [], C.QUEUE_COOLDOWN_MS); return; }
      callback(result.sendQueue || [], result.sendTimestamps || [], result[C.STORAGE_KEY_COOLDOWN_MS] || C.QUEUE_COOLDOWN_MS);
    }
  );
}

function saveState(queue, timestamps, cb) {
  chrome.storage.local.set({ sendQueue: queue, sendTimestamps: timestamps }, cb || function () {});
}

// ── Rate limiting ──

function pruneTimestamps(ts, cooldown) {
  var cutoff = Date.now() - cooldown;
  return ts.filter(function (t) { return t > cutoff; });
}

function getNextSlotDelayMs(ts, cooldown) {
  var pruned = pruneTimestamps(ts, cooldown);
  if (pruned.length < C.MAX_CONCURRENT_REQUESTS) return 0;
  pruned.sort(function (a, b) { return a - b; });
  return Math.max(0, pruned[0] + cooldown - Date.now());
}

// ── Open Claude tab ──

function openClaudeTab(text, inBackground, callback) {
  chrome.tabs.create({ url: C.CLAUDE_NEW_CHAT_URL, active: !inBackground }, function (tab) {
    if (chrome.runtime.lastError) { if (callback) callback(null); return; }
    var tabId = tab.id;
    var done = false;

    var timeout = setTimeout(function () {
      if (done) return; done = true;
      chrome.tabs.onUpdated.removeListener(onLoad);
      if (callback) callback(tabId);
    }, C.TAB_LOAD_TIMEOUT_MS);

    var onLoad = function (id, info) {
      if (id !== tabId || info.status !== "complete") return;
      if (done) return; done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onLoad);
      setTimeout(function () {
        chrome.tabs.sendMessage(tabId, { type: C.MSG_INJECT_AND_SUBMIT, text: text });
        if (callback) callback(tabId);
      }, C.CLAUDE_INJECT_DELAY_MS);
    };
    chrome.tabs.onUpdated.addListener(onLoad);
  });
}

// ── Queue drain ──

function drainQueue() {
  loadState(function (queue, ts, cooldown) {
    ts = pruneTimestamps(ts, cooldown);
    if (queue.length === 0) { saveState(queue, ts); chrome.alarms.clear(QUEUE_ALARM); return; }

    var slots = C.MAX_CONCURRENT_REQUESTS - ts.length;
    while (queue.length > 0 && slots > 0) {
      var item = queue.shift();
      ts.push(Date.now());
      slots--;
      if (item.isExpansion) {
        openClaudeTab(item.text, true, function () {
          // Expansion item sent -- unblock the expansion state machine
          setExpansionPhase("open-amboss-next");
        });
      } else {
        openClaudeTab(item.text, item.openInBackground);
      }
    }

    saveState(queue, ts, function () {
      if (queue.length > 0) {
        var delay = Math.max(getNextSlotDelayMs(ts, cooldown) / 60000, 0.5);
        chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: delay });
      }
    });
  });
}

// ── Alarms ──

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === QUEUE_ALARM) drainQueue();
  if (alarm.name === EXPANSION_ALARM) {
    expansionLoopRunning = false;
    runExpansionLoop();
  }
});

drainQueue(); // on startup

// ── Messages ──

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === C.MSG_OPEN_AND_INJECT) {
    if (!msg.text || typeof msg.text !== "string") {
      sendResponse({ success: false, error: "Missing message text" }); return false;
    }
    loadState(function (queue, ts, cooldown) {
      ts = pruneTimestamps(ts, cooldown);
      if (ts.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0) {
        ts.push(Date.now());
        saveState(queue, ts);
        openClaudeTab(msg.text, !!msg.openInBackground);
        sendResponse({ success: true, queued: false, message: "Sending now..." });
      } else {
        queue.push({ text: msg.text, openInBackground: !!msg.openInBackground, addedAt: Date.now() });
        saveState(queue, ts, function () {
          var d = Math.max(getNextSlotDelayMs(ts, cooldown) / 60000, 0.5);
          chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: d });
        });
        sendResponse({ success: true, queued: true, position: queue.length,
          message: "Queued (#" + queue.length + "). Sends in ~" + Math.ceil(getNextSlotDelayMs(ts, cooldown) / 60000) + " min." });
      }
    });
    return true;
  }

  if (msg.type === C.MSG_GET_QUEUE_STATUS) {
    loadState(function (queue, ts, cooldown) {
      ts = pruneTimestamps(ts, cooldown);
      sendResponse({
        queueLength: queue.length, recentSends: ts.length,
        maxConcurrent: C.MAX_CONCURRENT_REQUESTS,
        canSendNow: ts.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0,
        nextSlotInMs: getNextSlotDelayMs(ts, cooldown), cooldownMs: cooldown,
      });
    });
    return true;
  }

  if (msg.type === "reset-all-state") {
    chrome.storage.local.set({ sendQueue: [], sendTimestamps: [], expansion: null }, function () {
      chrome.alarms.clearAll();
      sendResponse({ success: true });
    });
    return true;
  }

  // ── Expansion messages ──

  if (msg.type === C.MSG_START_EXPANSION) {
    var exp = {
      baseUrl: msg.baseUrl, startQ: msg.startQ, endQ: msg.endQ,
      currentQ: msg.startQ, skillPrefix: msg.skillPrefix,
      openInBackground: !!msg.openInBackground, running: true,
      phase: "open-amboss", ambossTabId: null, scrapeAttempts: 0, messageText: null,
    };
    chrome.storage.local.set({ expansion: exp, sendTimestamps: [] }, function () {
      sendResponse({ success: true, message: "Expanding " + (exp.endQ - exp.startQ + 1) + " questions..." });
      chrome.alarms.create(EXPANSION_ALARM, { periodInMinutes: 0.5 });
      runExpansionLoop();
    });
    return true;
  }

  if (msg.type === C.MSG_GET_EXPANSION_STATUS) {
    chrome.storage.local.get(["expansion"], function (result) {
      var e = result.expansion;
      sendResponse(e && e.running ? { running: true, currentQ: e.currentQ, endQ: e.endQ, startQ: e.startQ, phase: e.phase } : { running: false });
    });
    return true;
  }

  if (msg.type === C.MSG_STOP_EXPANSION) {
    setExpansionPhase("stopped", function () {
      chrome.alarms.clear(EXPANSION_ALARM);
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});

// ── Expansion helpers ──

function setExpansionPhase(phase, callback) {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp) { if (callback) callback(); return; }
    if (phase === "stopped") { exp.running = false; }
    else if (phase === "open-amboss-next") {
      // Advance to next question and reset to open-amboss
      exp.currentQ++;
      exp.phase = "open-amboss";
      exp.ambossTabId = null;
      exp.messageText = null;
      exp.scrapeAttempts = 0;
    } else {
      exp.phase = phase;
    }
    chrome.storage.local.set({ expansion: exp }, callback || function () {});
  });
}

// ── Expansion loop (fast setTimeout with alarm safety net) ──

var expansionLoopRunning = false;

function runExpansionLoop() {
  if (expansionLoopRunning) return;
  expansionLoopRunning = true;
  expansionStep();
}

function expansionStep() {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) {
      expansionLoopRunning = false;
      chrome.alarms.clear(EXPANSION_ALARM);
      return;
    }
    if (exp.currentQ > exp.endQ) {
      exp.running = false;
      chrome.storage.local.set({ expansion: exp });
      expansionLoopRunning = false;
      chrome.alarms.clear(EXPANSION_ALARM);
      return;
    }

    // If phase is "busy", an async operation is in progress. Just wait.
    if (exp.phase === "busy") {
      setTimeout(expansionStep, 3000);
      return;
    }

    // ── OPEN AMBOSS TAB ──
    if (exp.phase === "open-amboss") {
      // Set busy FIRST (sync write) to prevent duplicate ticks
      exp.phase = "busy";
      chrome.storage.local.set({ expansion: exp }, function () {
        var url = exp.baseUrl + exp.currentQ;
        chrome.tabs.create({ url: url, active: false }, function (tab) {
          if (chrome.runtime.lastError) {
            // Skip this question
            setExpansionPhase("open-amboss-next", function () {
              setTimeout(expansionStep, 1000);
            });
            return;
          }
          chrome.storage.local.get(["expansion"], function (r) {
            var e = r.expansion;
            if (!e || !e.running) { expansionLoopRunning = false; return; }
            e.ambossTabId = tab.id;
            e.phase = "wait-load";
            e.scrapeAttempts = 0;
            chrome.storage.local.set({ expansion: e }, function () {
              setTimeout(expansionStep, 2000);
            });
          });
        });
      });
      return;
    }

    // ── WAIT FOR TAB TO LOAD ──
    if (exp.phase === "wait-load") {
      chrome.tabs.get(exp.ambossTabId, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          setExpansionPhase("open-amboss-next", function () { setTimeout(expansionStep, 1000); });
          return;
        }
        if (tab.status === "complete") {
          exp.phase = "scrape";
          chrome.storage.local.set({ expansion: exp }, function () {
            // Wait for SPA to render
            setTimeout(expansionStep, C.EXPANSION_INITIAL_WAIT_MS);
          });
        } else {
          setTimeout(expansionStep, 2000);
        }
      });
      return;
    }

    // ── SCRAPE ──
    if (exp.phase === "scrape") {
      exp.phase = "busy";
      exp.scrapeAttempts++;
      chrome.storage.local.set({ expansion: exp }, function () {
        chrome.scripting.executeScript(
          { target: { tabId: exp.ambossTabId }, files: ["config.js"] },
          function () {
            if (chrome.runtime.lastError) { handleScrapeFailure(); return; }
            chrome.scripting.executeScript(
              { target: { tabId: exp.ambossTabId }, files: ["scraper.js"] },
              function (results) {
                if (chrome.runtime.lastError) { handleScrapeFailure(); return; }
                var scraped = results && results[0] && results[0].result;
                if (scraped && scraped.question) {
                  // Success! Build message and go to claude phase
                  var skill = { prefix: exp.skillPrefix };
                  var msg = TemplateEngine.buildMessage(skill, scraped, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
                  chrome.storage.local.get(["expansion"], function (r) {
                    var e = r.expansion;
                    if (!e || !e.running) { expansionLoopRunning = false; return; }
                    e.messageText = msg;
                    e.phase = "send-claude";
                    chrome.storage.local.set({ expansion: e }, function () {
                      setTimeout(expansionStep, 500);
                    });
                  });
                } else {
                  handleScrapeFailure();
                }
              }
            );
          }
        );
      });
      return;
    }

    // ── SEND TO CLAUDE ──
    if (exp.phase === "send-claude") {
      exp.phase = "busy";
      chrome.storage.local.set({ expansion: exp }, function () {
        loadState(function (queue, ts, cooldown) {
          ts = pruneTimestamps(ts, cooldown);
          if (ts.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0) {
            // Slot available -- open Claude tab now
            ts.push(Date.now());
            saveState(queue, ts);
            openClaudeTab(exp.messageText, true, function () {
              // Claude tab opened -- advance to next question
              setExpansionPhase("open-amboss-next", function () {
                setTimeout(expansionStep, 2000);
              });
            });
          } else {
            // No slot -- queue it with expansion flag
            queue.push({ text: exp.messageText, openInBackground: true, addedAt: Date.now(), isExpansion: true });
            // Clear messageText so we don't re-queue
            chrome.storage.local.get(["expansion"], function (r) {
              var e = r.expansion;
              if (!e) return;
              e.messageText = null;
              e.phase = "waiting-queue";
              chrome.storage.local.set({ expansion: e });
            });
            saveState(queue, ts, function () {
              var d = Math.max(getNextSlotDelayMs(ts, cooldown) / 60000, 0.5);
              chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: d });
            });
            // The expansion will resume when drainQueue sends this item
            // and calls setExpansionPhase("open-amboss-next")
            // Keep the loop alive to detect when it resumes
            setTimeout(expansionStep, 5000);
          }
        });
      });
      return;
    }

    // ── WAITING FOR QUEUE TO DRAIN ──
    if (exp.phase === "waiting-queue") {
      // Just wait -- drainQueue will set phase to "open-amboss-next" when it sends
      setTimeout(expansionStep, 5000);
      return;
    }

    // Unknown phase -- reset
    exp.phase = "open-amboss";
    chrome.storage.local.set({ expansion: exp }, function () {
      setTimeout(expansionStep, 1000);
    });
  });
}

function handleScrapeFailure() {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) { expansionLoopRunning = false; return; }

    if (exp.scrapeAttempts < C.EXPANSION_SCRAPE_MAX_RETRIES) {
      exp.phase = "scrape";
      chrome.storage.local.set({ expansion: exp }, function () {
        setTimeout(expansionStep, C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS);
      });
    } else {
      // Give up, skip to next
      setExpansionPhase("open-amboss-next", function () {
        setTimeout(expansionStep, 1000);
      });
    }
  });
}
