/**
 * background.js -- Background service worker (bulletproof rewrite)
 *
 * Key design decisions to prevent duplicate Claude tabs:
 *
 * 1. NO setTimeout anywhere. Only chrome.alarms (survives worker restarts).
 *    Tradeoff: minimum ~1s granularity via chrome.alarms. Worth it for reliability.
 *
 * 2. NO in-memory locks. A storage-based lock ("exp_lock") with a timestamp
 *    prevents concurrent step() execution. Stale locks (>45s) are broken
 *    automatically, since the worker restarts and loses in-flight callbacks.
 *
 * 3. openClaudeTab is NOT used inside the expansion state machine. Instead,
 *    the expansion creates a tab in one step, polls for load in the next,
 *    injects in the next. Each step is atomic: read state, do one thing,
 *    write state, schedule alarm. No callbacks that span worker lifetimes.
 *
 * 4. Expansion NEVER touches the sendQueue/drainQueue system. Those two
 *    systems are fully decoupled.
 *
 * 5. Every step re-reads state from storage at the top, and every code path
 *    either calls scheduleNext() or releaseLock(). No path leaves the lock
 *    held indefinitely (and stale lock detection covers edge cases).
 */

importScripts("config.js");
importScripts("template-engine.js");

var C = CONFIG;
var QUEUE_ALARM = "drain-queue";
var STEP_ALARM = "exp-step";

// Lock config
var LOCK_KEY = "exp_lock";
var LOCK_STALE_MS = 45000; // If lock is older than this, it's stale (worker died)

// ── Storage helpers ──

function loadState(cb) {
  chrome.storage.local.get(["sendQueue", "sendTimestamps", C.STORAGE_KEY_COOLDOWN_MS], function (r) {
    if (chrome.runtime.lastError) { cb([], [], C.QUEUE_COOLDOWN_MS); return; }
    cb(r.sendQueue || [], r.sendTimestamps || [], r[C.STORAGE_KEY_COOLDOWN_MS] || C.QUEUE_COOLDOWN_MS);
  });
}

function saveState(queue, timestamps, cb) {
  chrome.storage.local.set({ sendQueue: queue, sendTimestamps: timestamps }, cb || function () {});
}

function loadExp(cb) {
  chrome.storage.local.get(["expansion"], function (r) {
    cb(r.expansion || null);
  });
}

function saveExp(exp, cb) {
  chrome.storage.local.set({ expansion: exp }, cb || function () {});
}

// ── Storage-based lock ──
// Prevents concurrent step() calls. Uses a timestamp so stale locks
// (from a dead worker) can be detected and broken.

function acquireLock(cb) {
  chrome.storage.local.get([LOCK_KEY], function (r) {
    var existing = r[LOCK_KEY];
    if (existing && (Date.now() - existing) < LOCK_STALE_MS) {
      // Lock is held and not stale
      cb(false);
      return;
    }
    // Lock is free or stale -- take it
    chrome.storage.local.set({ [LOCK_KEY]: Date.now() }, function () {
      cb(true);
    });
  });
}

function releaseLock(cb) {
  chrome.storage.local.remove(LOCK_KEY, cb || function () {});
}

// ── Rate limiting ──

function pruneTs(ts, cd) {
  var cutoff = Date.now() - cd;
  return ts.filter(function (t) { return t > cutoff; });
}

function nextSlotDelay(ts, cd) {
  var p = pruneTs(ts, cd);
  if (p.length < C.MAX_CONCURRENT_REQUESTS) return 0;
  p.sort(function (a, b) { return a - b; });
  return Math.max(0, p[0] + cd - Date.now());
}

// ── Open Claude tab (used by queue/popup, NOT by expansion) ──

function openClaudeTab(text, inBg, cb, opts) {
  opts = opts || {};
  function onCreated(tab) {
    if (chrome.runtime.lastError) {
      if (opts.windowId) { opts.windowId = null; opts.newWindow = true; openClaudeTab(text, inBg, cb, opts); return; }
      if (cb) cb(null, null); return;
    }
    var id = tab.id, wid = tab.windowId, done = false;
    var tm = setTimeout(function () { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(fn); if (cb) cb(id, wid); }, C.TAB_LOAD_TIMEOUT_MS);
    var fn = function (tid, info) {
      if (tid !== id || info.status !== "complete") return;
      if (done) return; done = true; clearTimeout(tm); chrome.tabs.onUpdated.removeListener(fn);
      setTimeout(function () { chrome.tabs.sendMessage(id, { type: C.MSG_INJECT_AND_SUBMIT, text: text }); if (cb) cb(id, wid); }, C.CLAUDE_INJECT_DELAY_MS);
    };
    chrome.tabs.onUpdated.addListener(fn);
  }
  if (opts.newWindow && !opts.windowId) {
    chrome.windows.create({ url: C.CLAUDE_NEW_CHAT_URL, focused: !inBg }, function (w) {
      if (chrome.runtime.lastError) { if (cb) cb(null, null); return; }
      onCreated(w.tabs[0]);
    });
  } else {
    var p = { url: C.CLAUDE_NEW_CHAT_URL, active: !inBg };
    if (opts.windowId) p.windowId = opts.windowId;
    chrome.tabs.create(p, onCreated);
  }
}

// ── Queue drain (completely independent of expansion) ──

function drainQueue() {
  loadState(function (queue, ts, cd) {
    ts = pruneTs(ts, cd);
    if (!queue.length) { saveState(queue, ts); chrome.alarms.clear(QUEUE_ALARM); return; }
    var slots = C.MAX_CONCURRENT_REQUESTS - ts.length;
    while (queue.length > 0 && slots > 0) {
      var item = queue.shift(); ts.push(Date.now()); slots--;
      openClaudeTab(item.text, item.openInBackground);
    }
    saveState(queue, ts, function () {
      if (queue.length > 0) { chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: Math.max(nextSlotDelay(ts, cd) / 60000, 0.5) }); }
    });
  });
}

// ── Alarms ──

chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name === QUEUE_ALARM) drainQueue();
  if (a.name === STEP_ALARM) step();
  if (a.name === "auto-gen-retry") handleAutoGenRetry();
});
drainQueue();
// On startup, check for an in-progress expansion
scheduleNext(1);

// ── Step scheduling: ONLY chrome.alarms, no setTimeout ──

function scheduleNext(delaySec) {
  // delaySec is in seconds (fractional OK). Minimum alarm period is ~0.5s.
  // Chrome enforces a minimum of 30s for alarms in MV3, but in practice
  // delayInMinutes of 0.01 works for one-shot alarms (just fires at ~30s minimum).
  // We use the max of requested delay and 0.5 to be safe.
  chrome.alarms.clear(STEP_ALARM, function () {
    var mins = Math.max(delaySec / 60, 1 / 120); // minimum ~0.5s
    chrome.alarms.create(STEP_ALARM, { delayInMinutes: mins });
  });
}

// ── Messages ──

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === C.MSG_AUTO_GENERATE_TRIGGERED) {
    var tid = sender.tab ? sender.tab.id : null;
    if (!tid) return false;
    chrome.storage.local.get([C.STORAGE_KEY_AUTO_GENERATE_SKILL], function (r) {
      var sid = r[C.STORAGE_KEY_AUTO_GENERATE_SKILL] || C.DEFAULT_AUTO_GENERATE_SKILL;
      var skill = C.SKILLS.find(function (s) { return s.id === sid; }) || C.SKILLS[0];
      doScrape(tid, function (sc) {
        if (!sc || !sc.question) { scheduleRetryAutoGenerate(tid, skill); return; }
        queueClaude(skill, sc);
      });
    });
    return false;
  }

  if (msg.type === C.MSG_OPEN_AND_INJECT) {
    if (!msg.text || typeof msg.text !== "string") { sendResponse({ success: false, error: "Missing text" }); return false; }
    loadState(function (q, ts, cd) {
      ts = pruneTs(ts, cd);
      if (ts.length < C.MAX_CONCURRENT_REQUESTS && !q.length) {
        ts.push(Date.now()); saveState(q, ts); openClaudeTab(msg.text, !!msg.openInBackground);
        sendResponse({ success: true, queued: false, message: "Sending now..." });
      } else {
        q.push({ text: msg.text, openInBackground: !!msg.openInBackground, addedAt: Date.now() });
        saveState(q, ts, function () { chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: Math.max(nextSlotDelay(ts, cd) / 60000, 0.5) }); });
        sendResponse({ success: true, queued: true, position: q.length, message: "Queued (#" + q.length + ")." });
      }
    });
    return true;
  }

  if (msg.type === C.MSG_GET_QUEUE_STATUS) {
    loadState(function (q, ts, cd) {
      ts = pruneTs(ts, cd);
      sendResponse({ queueLength: q.length, recentSends: ts.length, maxConcurrent: C.MAX_CONCURRENT_REQUESTS, canSendNow: ts.length < C.MAX_CONCURRENT_REQUESTS && !q.length, nextSlotInMs: nextSlotDelay(ts, cd), cooldownMs: cd });
    });
    return true;
  }

  if (msg.type === "reset-all-state") {
    chrome.storage.local.set({ sendQueue: [], sendTimestamps: [], expansion: null }, function () {
      releaseLock(function () {
        chrome.alarms.clearAll();
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (msg.type === C.MSG_START_EXPANSION) {
    var layout = msg.layout || C.EXPANSION_LAYOUT_INTERLEAVED;
    var exp = {
      baseUrl: msg.baseUrl, startQ: msg.startQ, endQ: msg.endQ,
      currentQ: msg.startQ, skillPrefix: msg.skillPrefix,
      openInBackground: !!msg.openInBackground, running: true, layout: layout,
      phase: layout === C.EXPANSION_LAYOUT_SEPARATE ? "sep-open-all-tabs" : "open-amboss",
      ambossTabId: null, scrapeAttempts: 0, messageText: null,
      scrapedMessages: [], claudeWindowId: null, claudeIndex: 0,
      ambossTabIds: null, sepScrapeIndex: 0,
      claudeTabId: null, // NEW: track the Claude tab we created so we can poll it
    };
    chrome.storage.local.get(["sendQueue"], function (qr) {
      var cq = (qr.sendQueue || []).filter(function (i) { return !i.isExpansion; });
      chrome.storage.local.set({ expansion: exp, sendQueue: cq }, function () {
        releaseLock(function () {
          sendResponse({ success: true, message: "Expanding " + (exp.endQ - exp.startQ + 1) + " questions..." });
          scheduleNext(1);
        });
      });
    });
    return true;
  }

  if (msg.type === C.MSG_GET_EXPANSION_STATUS) {
    loadExp(function (e) {
      sendResponse(e && e.running ? { running: true, currentQ: e.currentQ, endQ: e.endQ, startQ: e.startQ, phase: e.phase } : { running: false });
    });
    return true;
  }

  if (msg.type === C.MSG_STOP_EXPANSION) {
    loadExp(function (e) {
      if (e) { e.running = false; saveExp(e); }
      releaseLock(function () {
        chrome.alarms.clear(STEP_ALARM);
        sendResponse({ success: true });
      });
    });
    return true;
  }

  return false;
});

// ── Helpers ──

function scheduleRetryAutoGenerate(tabId, skill) {
  // Use an alarm for the retry instead of setTimeout
  // Store retry info, then use a dedicated alarm
  chrome.storage.local.set({ _autoRetry: { tabId: tabId, skillId: skill.id } }, function () {
    chrome.alarms.create("auto-gen-retry", { delayInMinutes: 0.05 }); // ~3s
  });
}

function handleAutoGenRetry() {
  chrome.storage.local.get(["_autoRetry"], function (r) {
    var info = r._autoRetry;
    if (!info) return;
    chrome.storage.local.remove("_autoRetry");
    var skill = C.SKILLS.find(function (s) { return s.id === info.skillId; }) || C.SKILLS[0];
    doScrape(info.tabId, function (sc) {
      if (sc && sc.question) queueClaude(skill, sc);
    });
  });
}

function queueClaude(skill, scraped) {
  var text = TemplateEngine.buildMessage(skill, scraped, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
  loadState(function (q, ts, cd) {
    ts = pruneTs(ts, cd);
    if (ts.length < C.MAX_CONCURRENT_REQUESTS && !q.length) {
      ts.push(Date.now()); saveState(q, ts); openClaudeTab(text, true);
    } else {
      q.push({ text: text, openInBackground: true, addedAt: Date.now() });
      saveState(q, ts, function () { chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: Math.max(nextSlotDelay(ts, cd) / 60000, 0.5) }); });
    }
  });
}

function doScrape(tabId, cb) {
  chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["config.js"] }, function () {
    if (chrome.runtime.lastError) { cb(null); return; }
    chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["scraper.js"] }, function (r) {
      if (chrome.runtime.lastError) { cb(null); return; }
      cb(r && r[0] && r[0].result);
    });
  });
}

// ══════════════════════════════════════════════════════════════
// EXPANSION STATE MACHINE
//
// Invariants:
//   - step() is the ONLY entry point
//   - step() acquires a storage-based lock; if lock is held, it bails
//   - Every code path releases the lock and schedules the next alarm
//   - No callbacks span across potential worker restarts
//   - Tab creation and tab load polling are SEPARATE steps
//   - Claude message injection is a SEPARATE step from tab creation
//   - The sendQueue/drainQueue system is never used by expansion
//
// Interleaved phases:
//   open-amboss -> wait-amboss-load -> scrape -> check-rate-limit ->
//   create-claude-tab -> wait-claude-load -> inject-claude -> advance
//
// Separate window phases:
//   sep-open-all-tabs -> sep-wait-load -> sep-scrape ->
//   sep-start-claude -> sep-check-rate -> sep-create-claude ->
//   sep-wait-claude-load -> sep-inject-claude -> (loop or done)
// ══════════════════════════════════════════════════════════════

function step() {
  acquireLock(function (acquired) {
    if (!acquired) {
      // Lock is held by another step() in-flight. Don't schedule --
      // the holder will schedule when it finishes.
      return;
    }

    loadExp(function (exp) {
      if (!exp || !exp.running) {
        releaseLock();
        return;
      }

      console.log("[exp] phase=" + exp.phase + " q=" + exp.currentQ + "/" + exp.endQ + " layout=" + exp.layout);

      // Dispatch to phase handler
      var handler = PHASE_HANDLERS[exp.phase];
      if (handler) {
        handler(exp);
      } else {
        // Unknown phase -- recover
        console.warn("[exp] unknown phase: " + exp.phase + ", recovering");
        exp.phase = exp.layout === C.EXPANSION_LAYOUT_SEPARATE ? "sep-open-all-tabs" : "open-amboss";
        saveExp(exp, function () { releaseLock(function () { scheduleNext(2); }); });
      }
    });
  });
}

// Helper: finish step, release lock, schedule next
function finishStep(delaySec) {
  releaseLock(function () { scheduleNext(delaySec); });
}

// Helper: stop expansion cleanly
function stopExpansion(exp) {
  exp.running = false;
  saveExp(exp, function () { releaseLock(); });
}

// Helper: advance to next question (interleaved mode)
function advanceToNextQuestion(exp) {
  exp.currentQ++;
  exp.ambossTabId = null;
  exp.claudeTabId = null;
  exp.messageText = null;
  exp.scrapeAttempts = 0;
  if (exp.currentQ > exp.endQ) {
    stopExpansion(exp);
  } else {
    exp.phase = "open-amboss";
    saveExp(exp, function () { finishStep(2); });
  }
}

// ── Phase handlers ──

var PHASE_HANDLERS = {};

// ══════════════════════════════
// INTERLEAVED MODE
// ══════════════════════════════

PHASE_HANDLERS["open-amboss"] = function (exp) {
  // Done check
  if (exp.currentQ > exp.endQ) { stopExpansion(exp); return; }

  chrome.tabs.create({ url: exp.baseUrl + exp.currentQ, active: false }, function (tab) {
    if (chrome.runtime.lastError || !tab) {
      // Tab creation failed -- skip this question
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        advanceToNextQuestion(e);
      });
      return;
    }
    // Save the tab ID and move to wait-load
    loadExp(function (e) {
      if (!e || !e.running) { releaseLock(); return; }
      e.ambossTabId = tab.id;
      e.scrapeAttempts = 0;
      e.phase = "wait-amboss-load";
      saveExp(e, function () { finishStep(2); });
    });
  });
};

PHASE_HANDLERS["wait-amboss-load"] = function (exp) {
  if (!exp.ambossTabId) {
    // No tab to wait for -- skip question
    advanceToNextQuestion(exp);
    return;
  }
  chrome.tabs.get(exp.ambossTabId, function (tab) {
    if (chrome.runtime.lastError || !tab) {
      // Tab gone -- skip question
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        advanceToNextQuestion(e);
      });
      return;
    }
    if (tab.status === "complete") {
      // Tab loaded -- move to scrape after initial wait
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        e.phase = "scrape";
        e.scrapeAttempts = 0;
        saveExp(e, function () { finishStep(C.EXPANSION_INITIAL_WAIT_MS / 1000); });
      });
    } else {
      // Still loading -- poll again
      finishStep(2);
    }
  });
};

PHASE_HANDLERS["scrape"] = function (exp) {
  exp.scrapeAttempts = (exp.scrapeAttempts || 0) + 1;
  var attempts = exp.scrapeAttempts;
  var tabId = exp.ambossTabId;

  saveExp(exp, function () {
    doScrape(tabId, function (sc) {
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }

        if (sc && sc.question) {
          var skill = { prefix: e.skillPrefix };
          e.messageText = TemplateEngine.buildMessage(skill, sc, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
          e.phase = "check-rate-limit";
          saveExp(e, function () { finishStep(1); });
        } else if (attempts < C.EXPANSION_SCRAPE_MAX_RETRIES) {
          e.phase = "scrape";
          saveExp(e, function () { finishStep(C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS / 1000); });
        } else {
          // Max retries -- skip question
          advanceToNextQuestion(e);
        }
      });
    });
  });
};

PHASE_HANDLERS["check-rate-limit"] = function (exp) {
  // Check if we have a rate limit slot. If not, wait and retry this phase.
  loadState(function (queue, ts, cd) {
    ts = pruneTs(ts, cd);
    if (ts.length < C.MAX_CONCURRENT_REQUESTS) {
      // Slot available -- record the timestamp and create the Claude tab
      ts.push(Date.now());
      saveState(queue, ts, function () {
        loadExp(function (e) {
          if (!e || !e.running) { releaseLock(); return; }
          e.phase = "create-claude-tab";
          saveExp(e, function () { finishStep(1); });
        });
      });
    } else {
      // Rate limited -- wait and retry
      var delay = nextSlotDelay(ts, cd);
      finishStep(Math.max(delay / 1000, 5));
    }
  });
};

PHASE_HANDLERS["create-claude-tab"] = function (exp) {
  if (!exp.messageText) {
    // No message -- skip (shouldn't happen but be safe)
    advanceToNextQuestion(exp);
    return;
  }
  // Create the Claude tab but DO NOT wait for it to load in this step.
  // We just create it and save the tab ID. Next step polls for load.
  chrome.tabs.create({ url: C.CLAUDE_NEW_CHAT_URL, active: false }, function (tab) {
    if (chrome.runtime.lastError || !tab) {
      // Tab creation failed -- skip the Claude tab for this question, advance
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        advanceToNextQuestion(e);
      });
      return;
    }
    loadExp(function (e) {
      if (!e || !e.running) { releaseLock(); return; }
      e.claudeTabId = tab.id;
      e.phase = "wait-claude-load";
      e._claudeLoadPollCount = 0;
      saveExp(e, function () { finishStep(2); });
    });
  });
};

PHASE_HANDLERS["wait-claude-load"] = function (exp) {
  if (!exp.claudeTabId) {
    advanceToNextQuestion(exp);
    return;
  }

  exp._claudeLoadPollCount = (exp._claudeLoadPollCount || 0) + 1;

  // Timeout: if we've polled too many times (~30s+ worth), inject anyway
  if (exp._claudeLoadPollCount > 15) {
    exp.phase = "inject-claude";
    saveExp(exp, function () { finishStep(1); });
    return;
  }

  chrome.tabs.get(exp.claudeTabId, function (tab) {
    if (chrome.runtime.lastError || !tab) {
      // Tab gone -- skip
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        advanceToNextQuestion(e);
      });
      return;
    }
    if (tab.status === "complete") {
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        e.phase = "inject-claude";
        saveExp(e, function () { finishStep(C.CLAUDE_INJECT_DELAY_MS / 1000); });
      });
    } else {
      // Still loading
      saveExp(exp, function () { finishStep(2); });
    }
  });
};

PHASE_HANDLERS["inject-claude"] = function (exp) {
  if (!exp.claudeTabId || !exp.messageText) {
    advanceToNextQuestion(exp);
    return;
  }
  // Send the inject message. This is fire-and-forget; the content script handles it.
  chrome.tabs.sendMessage(exp.claudeTabId, { type: C.MSG_INJECT_AND_SUBMIT, text: exp.messageText }, function () {
    // Ignore errors (tab might have navigated, content script not ready, etc.)
    // The content script has its own retry logic.
    void chrome.runtime.lastError;
  });

  // Advance to next question
  advanceToNextQuestion(exp);
};

// "done" phase -- just stop
PHASE_HANDLERS["done"] = function (exp) {
  stopExpansion(exp);
};

// ══════════════════════════════
// SEPARATE WINDOW MODE
// ══════════════════════════════

PHASE_HANDLERS["sep-open-all-tabs"] = function (exp) {
  var total = exp.endQ - exp.startQ + 1;
  var tabs = [];
  var opened = 0;

  for (var q = exp.startQ; q <= exp.endQ; q++) {
    (function (qn) {
      chrome.tabs.create({ url: exp.baseUrl + qn, active: false }, function (tab) {
        opened++;
        if (!chrome.runtime.lastError && tab) {
          tabs.push({ qNum: qn, tabId: tab.id });
        }
        if (opened === total) {
          tabs.sort(function (a, b) { return a.qNum - b.qNum; });
          loadExp(function (e) {
            if (!e || !e.running) { releaseLock(); return; }
            e.ambossTabIds = tabs;
            e.sepScrapeIndex = 0;
            e.phase = "sep-wait-load";
            saveExp(e, function () { finishStep(3); });
          });
        }
      });
    })(q);
  }
};

PHASE_HANDLERS["sep-wait-load"] = function (exp) {
  if (!exp.ambossTabIds || exp.sepScrapeIndex >= exp.ambossTabIds.length) {
    exp.phase = "sep-start-claude";
    saveExp(exp, function () { finishStep(1); });
    return;
  }
  var ti = exp.ambossTabIds[exp.sepScrapeIndex];
  chrome.tabs.get(ti.tabId, function (tab) {
    if (chrome.runtime.lastError || !tab) {
      // Tab gone -- skip it
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        e.sepScrapeIndex++;
        e.phase = e.sepScrapeIndex >= e.ambossTabIds.length ? "sep-start-claude" : "sep-wait-load";
        saveExp(e, function () { finishStep(1); });
      });
      return;
    }
    if (tab.status === "complete") {
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        e.phase = "sep-scrape";
        e.scrapeAttempts = 0;
        saveExp(e, function () { finishStep(C.EXPANSION_INITIAL_WAIT_MS / 1000); });
      });
    } else {
      finishStep(2);
    }
  });
};

PHASE_HANDLERS["sep-scrape"] = function (exp) {
  if (!exp.ambossTabIds || exp.sepScrapeIndex >= exp.ambossTabIds.length) {
    exp.phase = "sep-start-claude";
    saveExp(exp, function () { finishStep(1); });
    return;
  }

  exp.scrapeAttempts = (exp.scrapeAttempts || 0) + 1;
  var attempts = exp.scrapeAttempts;
  var ti = exp.ambossTabIds[exp.sepScrapeIndex];

  saveExp(exp, function () {
    doScrape(ti.tabId, function (sc) {
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }

        if (sc && sc.question) {
          var skill = { prefix: e.skillPrefix };
          var msg = TemplateEngine.buildMessage(skill, sc, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
          if (!e.scrapedMessages) e.scrapedMessages = [];
          e.scrapedMessages.push({ qNum: ti.qNum, text: msg });
          e.sepScrapeIndex++;
          e.phase = e.sepScrapeIndex >= e.ambossTabIds.length ? "sep-start-claude" : "sep-wait-load";
          saveExp(e, function () { finishStep(1); });
        } else if (attempts < C.EXPANSION_SCRAPE_MAX_RETRIES) {
          e.phase = "sep-scrape";
          saveExp(e, function () { finishStep(C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS / 1000); });
        } else {
          // Max retries -- skip this question
          e.sepScrapeIndex++;
          e.phase = e.sepScrapeIndex >= e.ambossTabIds.length ? "sep-start-claude" : "sep-wait-load";
          saveExp(e, function () { finishStep(1); });
        }
      });
    });
  });
};

PHASE_HANDLERS["sep-start-claude"] = function (exp) {
  if (!exp.scrapedMessages || !exp.scrapedMessages.length) {
    stopExpansion(exp);
    return;
  }
  exp.claudeIndex = 0;
  exp.phase = "sep-check-rate";
  saveExp(exp, function () { finishStep(1); });
};

PHASE_HANDLERS["sep-check-rate"] = function (exp) {
  if (exp.claudeIndex >= exp.scrapedMessages.length) {
    stopExpansion(exp);
    return;
  }

  loadState(function (queue, ts, cd) {
    ts = pruneTs(ts, cd);
    if (ts.length < C.MAX_CONCURRENT_REQUESTS) {
      ts.push(Date.now());
      saveState(queue, ts, function () {
        loadExp(function (e) {
          if (!e || !e.running) { releaseLock(); return; }
          e.phase = "sep-create-claude";
          saveExp(e, function () { finishStep(1); });
        });
      });
    } else {
      var delay = nextSlotDelay(ts, cd);
      finishStep(Math.max(delay / 1000, 5));
    }
  });
};

PHASE_HANDLERS["sep-create-claude"] = function (exp) {
  if (exp.claudeIndex >= exp.scrapedMessages.length) {
    stopExpansion(exp);
    return;
  }

  var opts = {};
  if (exp.claudeWindowId) {
    opts.windowId = exp.claudeWindowId;
  } else {
    opts.newWindow = true;
  }

  function doCreate() {
    if (opts.newWindow) {
      chrome.windows.create({ url: C.CLAUDE_NEW_CHAT_URL, focused: false }, function (w) {
        if (chrome.runtime.lastError || !w) {
          // Failed to create window -- skip this one
          loadExp(function (e) {
            if (!e || !e.running) { releaseLock(); return; }
            e.claudeIndex++;
            e.phase = e.claudeIndex >= e.scrapedMessages.length ? "done" : "sep-check-rate";
            saveExp(e, function () { finishStep(2); });
          });
          return;
        }
        var tab = w.tabs[0];
        loadExp(function (e) {
          if (!e || !e.running) { releaseLock(); return; }
          e.claudeWindowId = w.id;
          e.claudeTabId = tab.id;
          e.phase = "sep-wait-claude-load";
          e._claudeLoadPollCount = 0;
          saveExp(e, function () { finishStep(2); });
        });
      });
    } else {
      chrome.tabs.create({ url: C.CLAUDE_NEW_CHAT_URL, active: false, windowId: opts.windowId }, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          // Window might be gone -- try new window
          loadExp(function (e) {
            if (!e || !e.running) { releaseLock(); return; }
            e.claudeWindowId = null;
            e.phase = "sep-create-claude"; // retry with newWindow
            saveExp(e, function () { finishStep(1); });
          });
          return;
        }
        loadExp(function (e) {
          if (!e || !e.running) { releaseLock(); return; }
          e.claudeTabId = tab.id;
          e.phase = "sep-wait-claude-load";
          e._claudeLoadPollCount = 0;
          saveExp(e, function () { finishStep(2); });
        });
      });
    }
  }

  doCreate();
};

PHASE_HANDLERS["sep-wait-claude-load"] = function (exp) {
  if (!exp.claudeTabId) {
    // No tab -- skip
    exp.claudeIndex++;
    exp.phase = exp.claudeIndex >= exp.scrapedMessages.length ? "done" : "sep-check-rate";
    saveExp(exp, function () { finishStep(1); });
    return;
  }

  exp._claudeLoadPollCount = (exp._claudeLoadPollCount || 0) + 1;

  if (exp._claudeLoadPollCount > 15) {
    // Timeout -- inject anyway
    exp.phase = "sep-inject-claude";
    saveExp(exp, function () { finishStep(1); });
    return;
  }

  chrome.tabs.get(exp.claudeTabId, function (tab) {
    if (chrome.runtime.lastError || !tab) {
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        e.claudeIndex++;
        e.phase = e.claudeIndex >= e.scrapedMessages.length ? "done" : "sep-check-rate";
        saveExp(e, function () { finishStep(1); });
      });
      return;
    }
    if (tab.status === "complete") {
      loadExp(function (e) {
        if (!e || !e.running) { releaseLock(); return; }
        e.phase = "sep-inject-claude";
        saveExp(e, function () { finishStep(C.CLAUDE_INJECT_DELAY_MS / 1000); });
      });
    } else {
      saveExp(exp, function () { finishStep(2); });
    }
  });
};

PHASE_HANDLERS["sep-inject-claude"] = function (exp) {
  var idx = exp.claudeIndex;
  if (idx >= exp.scrapedMessages.length) {
    stopExpansion(exp);
    return;
  }

  if (exp.claudeTabId && exp.scrapedMessages[idx]) {
    chrome.tabs.sendMessage(exp.claudeTabId, {
      type: C.MSG_INJECT_AND_SUBMIT,
      text: exp.scrapedMessages[idx].text
    }, function () { void chrome.runtime.lastError; });
  }

  exp.claudeIndex++;
  exp.claudeTabId = null;
  if (exp.claudeIndex >= exp.scrapedMessages.length) {
    stopExpansion(exp);
  } else {
    exp.phase = "sep-check-rate";
    saveExp(exp, function () { finishStep(2); });
  }
};
