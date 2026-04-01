/**
 * background.js -- Background service worker
 * Context: Background (persists via one-shot alarms, survives restarts)
 * Design: Rate-limits sends to respect Claude.ai's 3 concurrent limit.
 *         Expansion uses a state machine driven by one-shot alarms
 *         (not periodic). Each step schedules the next alarm when done,
 *         preventing concurrent tick races entirely.
 */

importScripts("config.js");
importScripts("template-engine.js");

var C = CONFIG;
var QUEUE_ALARM = "drain-queue";
var EXPANSION_ALARM = "expansion-step";

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

function openClaudeTab(text, inBackground, callback, options) {
  options = options || {};

  function onTabCreated(tab) {
    if (chrome.runtime.lastError) {
      if (options.windowId) {
        // Window may have been closed -- retry in a new window
        options.windowId = null;
        options.newWindow = true;
        openClaudeTab(text, inBackground, callback, options);
        return;
      }
      if (callback) callback(null, null);
      return;
    }
    var tabId = tab.id;
    var windowId = tab.windowId;
    var done = false;

    var timeout = setTimeout(function () {
      if (done) return; done = true;
      chrome.tabs.onUpdated.removeListener(onLoad);
      if (callback) callback(tabId, windowId);
    }, C.TAB_LOAD_TIMEOUT_MS);

    var onLoad = function (id, info) {
      if (id !== tabId || info.status !== "complete") return;
      if (done) return; done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onLoad);
      setTimeout(function () {
        chrome.tabs.sendMessage(tabId, { type: C.MSG_INJECT_AND_SUBMIT, text: text });
        if (callback) callback(tabId, windowId);
      }, C.CLAUDE_INJECT_DELAY_MS);
    };
    chrome.tabs.onUpdated.addListener(onLoad);
  }

  if (options.newWindow && !options.windowId) {
    chrome.windows.create({ url: C.CLAUDE_NEW_CHAT_URL, focused: !inBackground }, function (win) {
      if (chrome.runtime.lastError) { if (callback) callback(null, null); return; }
      onTabCreated(win.tabs[0]);
    });
  } else {
    var props = { url: C.CLAUDE_NEW_CHAT_URL, active: !inBackground };
    if (options.windowId) props.windowId = options.windowId;
    chrome.tabs.create(props, onTabCreated);
  }
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
          // Resume expansion only if still running
          chrome.storage.local.get(["expansion"], function (r) {
            if (r.expansion && r.expansion.running) {
              advanceInterleaved(function () { scheduleExpansionStep(2000); });
            }
          });
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
  if (alarm.name === EXPANSION_ALARM) expansionStep();
});

drainQueue(); // on startup
// Also check if expansion was in progress on startup
scheduleExpansionStep(1000);

// ── Schedule next expansion step (one-shot, prevents concurrent ticks) ──

function scheduleExpansionStep(delayMs) {
  // Use setTimeout for short delays (<30s), alarm for longer
  if (delayMs < 30000) {
    setTimeout(expansionStep, delayMs);
  } else {
    chrome.alarms.create(EXPANSION_ALARM, { delayInMinutes: delayMs / 60000 });
  }
}

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
    var layout = msg.layout || C.EXPANSION_LAYOUT_INTERLEAVED;
    var exp = {
      baseUrl: msg.baseUrl, startQ: msg.startQ, endQ: msg.endQ,
      currentQ: msg.startQ, skillPrefix: msg.skillPrefix,
      openInBackground: !!msg.openInBackground, running: true,
      layout: layout,
      phase: layout === C.EXPANSION_LAYOUT_SEPARATE ? "sep-open-amboss" : "open-amboss",
      ambossTabId: null, scrapeAttempts: 0, messageText: null,
      scrapedMessages: [],
      claudeWindowId: null,
      claudeIndex: 0,
    };
    // Clear any queued expansion items from a previous expansion
    chrome.storage.local.get(["sendQueue"], function (qResult) {
      var cleanQueue = (qResult.sendQueue || []).filter(function (item) { return !item.isExpansion; });
      chrome.storage.local.set({ expansion: exp, sendQueue: cleanQueue }, function () {
      sendResponse({ success: true, message: "Expanding " + (exp.endQ - exp.startQ + 1) + " questions..." });
      scheduleExpansionStep(500);
      });
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

// ══════════════════════════════════════════
// ── EXPANSION STATE MACHINE ──
// One step at a time. Each step re-reads state from storage,
// does one operation, saves, and schedules the next step.
// No concurrent ticks possible because we use one-shot scheduling.
// ══════════════════════════════════════════

function expansionStep() {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp || !exp.running) return;
    if (exp.currentQ > exp.endQ && exp.phase !== "sep-start-claude" && exp.phase !== "sep-send-claude") {
      exp.running = false;
      chrome.storage.local.set({ expansion: exp });
      return;
    }

    // Guard: if phase is "busy", a previous async op is still in flight.
    // This can happen if the worker restarted mid-operation.
    // Recover by going back to a safe phase.
    if (exp.phase === "busy") {
      exp.phase = exp.layout === C.EXPANSION_LAYOUT_SEPARATE ? "sep-open-amboss" : "open-amboss";
      chrome.storage.local.set({ expansion: exp }, function () {
        scheduleExpansionStep(2000);
      });
      return;
    }

    // ══════════════════════════════
    // INTERLEAVED MODE
    // ══════════════════════════════

    if (exp.phase === "open-amboss") {
      exp.phase = "busy";
      chrome.storage.local.set({ expansion: exp }, function () {
        chrome.tabs.create({ url: exp.baseUrl + exp.currentQ, active: false }, function (tab) {
          if (chrome.runtime.lastError) {
            advanceInterleaved(function () { scheduleExpansionStep(1000); });
            return;
          }
          updateExpansion({ ambossTabId: tab.id, phase: "wait-load", scrapeAttempts: 0 }, function () {
            scheduleExpansionStep(2000);
          });
        });
      });
      return;
    }

    if (exp.phase === "wait-load") {
      chrome.tabs.get(exp.ambossTabId, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          advanceInterleaved(function () { scheduleExpansionStep(1000); });
          return;
        }
        if (tab.status === "complete") {
          updateExpansion({ phase: "scrape" }, function () {
            scheduleExpansionStep(C.EXPANSION_INITIAL_WAIT_MS);
          });
        } else {
          scheduleExpansionStep(2000);
        }
      });
      return;
    }

    if (exp.phase === "scrape") {
      exp.phase = "busy";
      exp.scrapeAttempts++;
      chrome.storage.local.set({ expansion: exp }, function () {
        doScrape(exp.ambossTabId, function (scraped) {
          if (scraped && scraped.question) {
            var skill = { prefix: exp.skillPrefix };
            var msg = TemplateEngine.buildMessage(skill, scraped, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
            updateExpansion({ messageText: msg, phase: "send-claude" }, function () {
              scheduleExpansionStep(500);
            });
          } else {
            handleScrapeRetry(exp, "open-amboss", function () {});
          }
        });
      });
      return;
    }

    if (exp.phase === "send-claude") {
      exp.phase = "busy";
      chrome.storage.local.set({ expansion: exp }, function () {
        loadState(function (queue, ts, cooldown) {
          ts = pruneTimestamps(ts, cooldown);
          if (ts.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0) {
            ts.push(Date.now());
            saveState(queue, ts);
            // Re-read messageText from storage (not stale closure)
            chrome.storage.local.get(["expansion"], function (r) {
              var e = r.expansion;
              if (!e || !e.running || !e.messageText) {
                scheduleExpansionStep(2000);
                return;
              }
              openClaudeTab(e.messageText, true, function () {
                advanceInterleaved(function () { scheduleExpansionStep(2000); });
              });
            });
          } else {
            // Queue it
            chrome.storage.local.get(["expansion"], function (r) {
              var e = r.expansion;
              if (!e || !e.messageText) return;
              queue.push({ text: e.messageText, openInBackground: true, addedAt: Date.now(), isExpansion: true });
              e.messageText = null;
              e.phase = "waiting-queue";
              chrome.storage.local.set({ expansion: e });
              saveState(queue, ts, function () {
                var d = Math.max(getNextSlotDelayMs(ts, cooldown) / 60000, 0.5);
                chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: d });
              });
            });
            // drainQueue will call scheduleExpansionStep when it sends the item
          }
        });
      });
      return;
    }

    if (exp.phase === "waiting-queue") {
      // drainQueue will resume us via scheduleExpansionStep
      // But schedule a safety check in case we missed it
      scheduleExpansionStep(15000);
      return;
    }

    // ══════════════════════════════
    // SEPARATE WINDOW MODE
    // Phase 1: Open all AMBOSS tabs + scrape
    // Phase 2: Open Claude window + send all
    // ══════════════════════════════

    if (exp.phase === "sep-open-amboss") {
      exp.phase = "busy";
      chrome.storage.local.set({ expansion: exp }, function () {
        chrome.tabs.create({ url: exp.baseUrl + exp.currentQ, active: false }, function (tab) {
          if (chrome.runtime.lastError) {
            advanceSepAmboss(function () { scheduleExpansionStep(1000); });
            return;
          }
          updateExpansion({ ambossTabId: tab.id, phase: "sep-wait-load", scrapeAttempts: 0 }, function () {
            scheduleExpansionStep(2000);
          });
        });
      });
      return;
    }

    if (exp.phase === "sep-wait-load") {
      chrome.tabs.get(exp.ambossTabId, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          advanceSepAmboss(function () { scheduleExpansionStep(1000); });
          return;
        }
        if (tab.status === "complete") {
          updateExpansion({ phase: "sep-scrape" }, function () {
            scheduleExpansionStep(C.EXPANSION_INITIAL_WAIT_MS);
          });
        } else {
          scheduleExpansionStep(2000);
        }
      });
      return;
    }

    if (exp.phase === "sep-scrape") {
      exp.phase = "busy";
      exp.scrapeAttempts++;
      chrome.storage.local.set({ expansion: exp }, function () {
        doScrape(exp.ambossTabId, function (scraped) {
          if (scraped && scraped.question) {
            // Store scraped message and advance to next AMBOSS question
            chrome.storage.local.get(["expansion"], function (r) {
              var e = r.expansion;
              if (!e || !e.running) return;
              var skill = { prefix: e.skillPrefix };
              var msg = TemplateEngine.buildMessage(skill, scraped, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
              if (!e.scrapedMessages) e.scrapedMessages = [];
              e.scrapedMessages.push({ qNum: e.currentQ, text: msg });
              e.currentQ++;
              e.phase = (e.currentQ > e.endQ) ? "sep-start-claude" : "sep-open-amboss";
              e.ambossTabId = null;
              chrome.storage.local.set({ expansion: e }, function () {
                scheduleExpansionStep(1000);
              });
            });
          } else {
            handleScrapeRetry(exp, "sep-open-amboss", function () {});
          }
        });
      });
      return;
    }

    if (exp.phase === "sep-start-claude") {
      chrome.storage.local.get(["expansion"], function (r) {
        var e = r.expansion;
        if (!e || !e.scrapedMessages || e.scrapedMessages.length === 0) {
          e.running = false;
          chrome.storage.local.set({ expansion: e });
          return;
        }
        e.claudeIndex = 0;
        e.phase = "sep-send-claude";
        chrome.storage.local.set({ expansion: e }, function () {
          scheduleExpansionStep(500);
        });
      });
      return;
    }

    if (exp.phase === "sep-send-claude") {
      // Re-read fresh state
      chrome.storage.local.get(["expansion"], function (r) {
        var e = r.expansion;
        if (!e || !e.running) return;
        if (e.claudeIndex >= e.scrapedMessages.length) {
          e.running = false;
          chrome.storage.local.set({ expansion: e });
          return;
        }

        e.phase = "busy";
        chrome.storage.local.set({ expansion: e }, function () {
          loadState(function (queue, ts, cooldown) {
            ts = pruneTimestamps(ts, cooldown);
            if (ts.length < C.MAX_CONCURRENT_REQUESTS && queue.length === 0) {
              ts.push(Date.now());
              saveState(queue, ts);

              // Re-read to get fresh claudeIndex and claudeWindowId
              chrome.storage.local.get(["expansion"], function (r2) {
                var e2 = r2.expansion;
                if (!e2 || !e2.running) return;

                var msgText = e2.scrapedMessages[e2.claudeIndex].text;
                var opts = {};
                if (e2.claudeWindowId) {
                  opts.windowId = e2.claudeWindowId;
                } else {
                  opts.newWindow = true;
                }

                openClaudeTab(msgText, true, function (tabId, windowId) {
                  chrome.storage.local.get(["expansion"], function (r3) {
                    var e3 = r3.expansion;
                    if (!e3 || !e3.running) return;
                    // Always update windowId (in case window was recreated)
                    if (windowId) e3.claudeWindowId = windowId;
                    e3.claudeIndex++;
                    e3.phase = "sep-send-claude";
                    chrome.storage.local.set({ expansion: e3 }, function () {
                      scheduleExpansionStep(2000);
                    });
                  });
                }, opts);
              });
            } else {
              // No slot -- wait for cooldown
              var delayMs = getNextSlotDelayMs(ts, cooldown);
              chrome.storage.local.get(["expansion"], function (r2) {
                var e2 = r2.expansion;
                if (!e2 || !e2.running) return;
                e2.phase = "sep-send-claude";
                chrome.storage.local.set({ expansion: e2 });
              });
              scheduleExpansionStep(Math.max(delayMs, 5000));
            }
          });
        });
      });
      return;
    }

    // Unknown/stuck phase -- recover
    var defaultPhase = exp.layout === C.EXPANSION_LAYOUT_SEPARATE ? "sep-open-amboss" : "open-amboss";
    exp.phase = defaultPhase;
    chrome.storage.local.set({ expansion: exp }, function () {
      scheduleExpansionStep(2000);
    });
  });
}

// ── Helpers ──

function doScrape(tabId, callback) {
  chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["config.js"] }, function () {
    if (chrome.runtime.lastError) { callback(null); return; }
    chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["scraper.js"] }, function (results) {
      if (chrome.runtime.lastError) { callback(null); return; }
      callback(results && results[0] && results[0].result);
    });
  });
}

function updateExpansion(fields, callback) {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp) { if (callback) callback(); return; }
    for (var key in fields) {
      if (fields.hasOwnProperty(key)) exp[key] = fields[key];
    }
    chrome.storage.local.set({ expansion: exp }, callback || function () {});
  });
}

function advanceInterleaved(callback) {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp) { if (callback) callback(); return; }
    exp.currentQ++;
    exp.phase = "open-amboss";
    exp.ambossTabId = null;
    exp.messageText = null;
    exp.scrapeAttempts = 0;
    if (exp.currentQ > exp.endQ) {
      exp.running = false;
    }
    chrome.storage.local.set({ expansion: exp }, callback || function () {});
  });
}

function advanceSepAmboss(callback) {
  chrome.storage.local.get(["expansion"], function (result) {
    var exp = result.expansion;
    if (!exp) { if (callback) callback(); return; }
    exp.currentQ++;
    exp.phase = (exp.currentQ > exp.endQ) ? "sep-start-claude" : "sep-open-amboss";
    exp.ambossTabId = null;
    exp.scrapeAttempts = 0;
    chrome.storage.local.set({ expansion: exp }, callback || function () {});
  });
}

function handleScrapeRetry(exp, fallbackPhase, callback) {
  chrome.storage.local.get(["expansion"], function (result) {
    var e = result.expansion;
    if (!e || !e.running) return;
    if (e.scrapeAttempts < C.EXPANSION_SCRAPE_MAX_RETRIES) {
      e.phase = exp.layout === C.EXPANSION_LAYOUT_SEPARATE ? "sep-scrape" : "scrape";
      chrome.storage.local.set({ expansion: e }, function () {
        scheduleExpansionStep(C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS);
      });
    } else {
      // Skip this question
      if (exp.layout === C.EXPANSION_LAYOUT_SEPARATE) {
        advanceSepAmboss(function () { scheduleExpansionStep(1000); });
      } else {
        advanceInterleaved(function () { scheduleExpansionStep(1000); });
      }
    }
  });
}
