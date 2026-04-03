/**
 * background.js -- Background service worker
 * Context: Background (persists via alarms, survives restarts)
 * Design: Single-threaded expansion step function. Each call does ONE
 *         thing, saves state, and calls scheduleNext(). No concurrent
 *         execution possible because scheduleNext() always cancels any
 *         pending timer/alarm before creating a new one, and the step
 *         function has a simple boolean gate.
 */

importScripts("config.js");
importScripts("template-engine.js");

var C = CONFIG;
var QUEUE_ALARM = "drain-queue";
var STEP_ALARM = "exp-step";

// ── State (always from storage) ──

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

// ── Open Claude tab, call back when injection is sent ──

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

// ── Queue drain ──

function drainQueue() {
  loadState(function (queue, ts, cd) {
    ts = pruneTs(ts, cd);
    if (!queue.length) { saveState(queue, ts); chrome.alarms.clear(QUEUE_ALARM); return; }
    var slots = C.MAX_CONCURRENT_REQUESTS - ts.length;
    while (queue.length > 0 && slots > 0) {
      var item = queue.shift(); ts.push(Date.now()); slots--;
      if (item.isExpansion) {
        (function (txt) {
          openClaudeTab(txt, true, function () {
            loadExp(function (exp) {
              if (!exp || !exp.running) return;
              exp.currentQ++; exp.phase = "open-amboss"; exp.ambossTabId = null; exp.messageText = null; exp.scrapeAttempts = 0;
              if (exp.currentQ > exp.endQ) exp.running = false;
              saveExp(exp, function () { if (exp.running) scheduleNext(2000); });
            });
          });
        })(item.text);
      } else {
        openClaudeTab(item.text, item.openInBackground);
      }
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
});
drainQueue();
scheduleNext(2000); // check for in-progress expansion on startup

// ── Step scheduling: ONLY ONE pending step ever ──

var stepTimer = null;
var stepping = false;

function scheduleNext(ms) {
  stepping = false;
  if (stepTimer !== null) { clearTimeout(stepTimer); stepTimer = null; }
  chrome.alarms.clear(STEP_ALARM);
  if (ms < 25000) {
    stepTimer = setTimeout(function () { stepTimer = null; step(); }, ms);
  } else {
    chrome.alarms.create(STEP_ALARM, { delayInMinutes: Math.max(ms / 60000, 0.5) });
  }
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
        if (!sc || !sc.question) { setTimeout(function () { doScrape(tid, function (sc2) { if (sc2 && sc2.question) queueClaude(skill, sc2); }); }, 3000); return; }
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
    chrome.storage.local.set({ sendQueue: [], sendTimestamps: [], expansion: null }, function () { chrome.alarms.clearAll(); sendResponse({ success: true }); });
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
    };
    chrome.storage.local.get(["sendQueue"], function (qr) {
      var cq = (qr.sendQueue || []).filter(function (i) { return !i.isExpansion; });
      chrome.storage.local.set({ expansion: exp, sendQueue: cq }, function () {
        sendResponse({ success: true, message: "Expanding " + (exp.endQ - exp.startQ + 1) + " questions..." });
        scheduleNext(300);
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
      chrome.alarms.clear(STEP_ALARM);
      if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});

// ── Helpers ──

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

// ══════════════════════════════════════
// EXPANSION STATE MACHINE
// Single step() function. Always:
//   1. Acquire lock (stepping=true)
//   2. Read exp from storage
//   3. Do ONE thing
//   4. Save exp
//   5. Call scheduleNext() which releases lock
// Every code path MUST end in scheduleNext() or set stepping=false.
// ══════════════════════════════════════

function step() {
  if (stepping) return;
  stepping = true;

  loadExp(function (exp) {
    if (!exp || !exp.running) { stepping = false; return; }

    console.log("[exp] phase=" + exp.phase + " q=" + exp.currentQ + "/" + exp.endQ + " layout=" + exp.layout);

    // Done check
    if (exp.currentQ > exp.endQ && exp.phase !== "sep-start-claude" && exp.phase !== "sep-send-claude") {
      exp.running = false; saveExp(exp); stepping = false; return;
    }

    // ── INTERLEAVED: open-amboss ──
    if (exp.phase === "open-amboss") {
      chrome.tabs.create({ url: exp.baseUrl + exp.currentQ, active: false }, function (tab) {
        if (chrome.runtime.lastError) {
          loadExp(function (e) { if (!e || !e.running) { stepping = false; return; } e.currentQ++; e.phase = e.currentQ > e.endQ ? "done" : "open-amboss"; saveExp(e, function () { scheduleNext(1000); }); });
          return;
        }
        loadExp(function (e) { if (!e || !e.running) { stepping = false; return; } e.ambossTabId = tab.id; e.phase = "wait-load"; e.scrapeAttempts = 0; saveExp(e, function () { scheduleNext(2000); }); });
      });
      return;
    }

    // ── INTERLEAVED: wait-load ──
    if (exp.phase === "wait-load") {
      chrome.tabs.get(exp.ambossTabId, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          loadExp(function (e) { if (!e || !e.running) { stepping = false; return; } e.currentQ++; e.phase = e.currentQ > e.endQ ? "done" : "open-amboss"; saveExp(e, function () { scheduleNext(1000); }); });
          return;
        }
        if (tab.status === "complete") {
          loadExp(function (e) { if (!e) { stepping = false; return; } e.phase = "scrape"; saveExp(e, function () { scheduleNext(C.EXPANSION_INITIAL_WAIT_MS); }); });
        } else {
          scheduleNext(2000);
        }
      });
      return;
    }

    // ── INTERLEAVED: scrape ──
    if (exp.phase === "scrape") {
      exp.scrapeAttempts++;
      saveExp(exp, function () {
        doScrape(exp.ambossTabId, function (sc) {
          loadExp(function (e) {
            if (!e || !e.running) { stepping = false; return; }
            if (sc && sc.question) {
              var skill = { prefix: e.skillPrefix };
              e.messageText = TemplateEngine.buildMessage(skill, sc, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
              e.phase = "send-claude";
              saveExp(e, function () { scheduleNext(500); });
            } else if (e.scrapeAttempts < C.EXPANSION_SCRAPE_MAX_RETRIES) {
              e.phase = "scrape";
              saveExp(e, function () { scheduleNext(C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS); });
            } else {
              e.currentQ++; e.phase = e.currentQ > e.endQ ? "done" : "open-amboss"; e.scrapeAttempts = 0;
              saveExp(e, function () { scheduleNext(1000); });
            }
          });
        });
      });
      return;
    }

    // ── INTERLEAVED: send-claude ──
    if (exp.phase === "send-claude") {
      loadState(function (queue, ts, cd) {
        ts = pruneTs(ts, cd);
        if (ts.length < C.MAX_CONCURRENT_REQUESTS && !queue.length) {
          ts.push(Date.now()); saveState(queue, ts);
          loadExp(function (e) {
            if (!e || !e.running || !e.messageText) { stepping = false; return; }
            var txt = e.messageText;
            openClaudeTab(txt, true, function () {
              loadExp(function (e2) {
                if (!e2 || !e2.running) { stepping = false; return; }
                e2.currentQ++; e2.phase = e2.currentQ > e2.endQ ? "done" : "open-amboss";
                e2.ambossTabId = null; e2.messageText = null; e2.scrapeAttempts = 0;
                saveExp(e2, function () { scheduleNext(2000); });
              });
            });
          });
        } else {
          // Queue it -- drainQueue will advance the expansion
          loadExp(function (e) {
            if (!e || !e.messageText) { stepping = false; return; }
            queue.push({ text: e.messageText, openInBackground: true, addedAt: Date.now(), isExpansion: true });
            e.messageText = null; e.phase = "waiting-queue";
            saveExp(e, function () {
              saveState(queue, ts, function () {
                chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: Math.max(nextSlotDelay(ts, cd) / 60000, 0.5) });
                stepping = false; // drainQueue will call scheduleNext
              });
            });
          });
        }
      });
      return;
    }

    // ── INTERLEAVED: waiting-queue ──
    if (exp.phase === "waiting-queue") {
      // drainQueue will resume. Safety poll.
      scheduleNext(15000);
      return;
    }

    // ── INTERLEAVED: done ──
    if (exp.phase === "done") {
      exp.running = false; saveExp(exp); stepping = false; return;
    }

    // ══════════════════════════════
    // SEPARATE WINDOW MODE
    // ══════════════════════════════

    // ── SEP: open all tabs at once ──
    if (exp.phase === "sep-open-all-tabs") {
      var tabs = [], opened = 0, total = exp.endQ - exp.startQ + 1;
      for (var q = exp.startQ; q <= exp.endQ; q++) {
        (function (qn) {
          chrome.tabs.create({ url: exp.baseUrl + qn, active: false }, function (tab) {
            opened++;
            if (!chrome.runtime.lastError && tab) tabs.push({ qNum: qn, tabId: tab.id });
            if (opened === total) {
              tabs.sort(function (a, b) { return a.qNum - b.qNum; });
              loadExp(function (e) {
                if (!e || !e.running) { stepping = false; return; }
                e.ambossTabIds = tabs; e.sepScrapeIndex = 0; e.phase = "sep-wait-load";
                saveExp(e, function () { scheduleNext(3000); });
              });
            }
          });
        })(q);
      }
      return;
    }

    // ── SEP: wait for current tab to load ──
    if (exp.phase === "sep-wait-load") {
      if (!exp.ambossTabIds || exp.sepScrapeIndex >= exp.ambossTabIds.length) {
        exp.phase = "sep-start-claude"; saveExp(exp, function () { scheduleNext(500); }); return;
      }
      var ti = exp.ambossTabIds[exp.sepScrapeIndex];
      chrome.tabs.get(ti.tabId, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          loadExp(function (e) { if (!e) { stepping = false; return; } e.sepScrapeIndex++; e.phase = e.sepScrapeIndex >= e.ambossTabIds.length ? "sep-start-claude" : "sep-wait-load"; saveExp(e, function () { scheduleNext(1000); }); });
          return;
        }
        if (tab.status === "complete") {
          loadExp(function (e) { if (!e) { stepping = false; return; } e.phase = "sep-scrape"; e.scrapeAttempts = 0; saveExp(e, function () { scheduleNext(C.EXPANSION_INITIAL_WAIT_MS); }); });
        } else {
          scheduleNext(2000);
        }
      });
      return;
    }

    // ── SEP: scrape current tab ──
    if (exp.phase === "sep-scrape") {
      if (!exp.ambossTabIds || exp.sepScrapeIndex >= exp.ambossTabIds.length) {
        exp.phase = "sep-start-claude"; saveExp(exp, function () { scheduleNext(500); }); return;
      }
      exp.scrapeAttempts++;
      saveExp(exp, function () {
        var ti = exp.ambossTabIds[exp.sepScrapeIndex];
        doScrape(ti.tabId, function (sc) {
          loadExp(function (e) {
            if (!e || !e.running) { stepping = false; return; }
            if (sc && sc.question) {
              var skill = { prefix: e.skillPrefix };
              var msg = TemplateEngine.buildMessage(skill, sc, C.PROMPT_TEMPLATE, C.WRONG_CHOICE_TEMPLATE);
              if (!e.scrapedMessages) e.scrapedMessages = [];
              e.scrapedMessages.push({ qNum: ti.qNum, text: msg });
              e.sepScrapeIndex++;
              e.phase = e.sepScrapeIndex >= e.ambossTabIds.length ? "sep-start-claude" : "sep-wait-load";
              saveExp(e, function () { scheduleNext(500); });
            } else if (e.scrapeAttempts < C.EXPANSION_SCRAPE_MAX_RETRIES) {
              e.phase = "sep-scrape";
              saveExp(e, function () { scheduleNext(C.EXPANSION_SCRAPE_RETRY_INTERVAL_MS); });
            } else {
              e.sepScrapeIndex++;
              e.phase = e.sepScrapeIndex >= e.ambossTabIds.length ? "sep-start-claude" : "sep-wait-load";
              saveExp(e, function () { scheduleNext(1000); });
            }
          });
        });
      });
      return;
    }

    // ── SEP: start sending claude tabs ──
    if (exp.phase === "sep-start-claude") {
      loadExp(function (e) {
        if (!e || !e.scrapedMessages || !e.scrapedMessages.length) { e.running = false; saveExp(e); stepping = false; return; }
        e.claudeIndex = 0; e.phase = "sep-send-claude";
        saveExp(e, function () { scheduleNext(500); });
      });
      return;
    }

    // ── SEP: send one claude tab ──
    if (exp.phase === "sep-send-claude") {
      loadExp(function (e) {
        if (!e || !e.running) { stepping = false; return; }
        if (e.claudeIndex >= e.scrapedMessages.length) { e.running = false; saveExp(e); stepping = false; return; }

        loadState(function (queue, ts, cd) {
          ts = pruneTs(ts, cd);
          if (ts.length < C.MAX_CONCURRENT_REQUESTS && !queue.length) {
            ts.push(Date.now()); saveState(queue, ts);
            var txt = e.scrapedMessages[e.claudeIndex].text;
            var opts = {};
            if (e.claudeWindowId) opts.windowId = e.claudeWindowId; else opts.newWindow = true;
            openClaudeTab(txt, true, function (tabId, wid) {
              loadExp(function (e2) {
                if (!e2 || !e2.running) { stepping = false; return; }
                if (wid) e2.claudeWindowId = wid;
                e2.claudeIndex++; e2.phase = "sep-send-claude";
                saveExp(e2, function () { scheduleNext(2000); });
              });
            }, opts);
          } else {
            var delay = nextSlotDelay(ts, cd);
            e.phase = "sep-send-claude"; // stay in same phase
            saveExp(e, function () { scheduleNext(Math.max(delay, 5000)); });
          }
        });
      });
      return;
    }

    // ── Unknown phase: recover ──
    console.warn("[exp] unknown phase: " + exp.phase + ", recovering");
    exp.phase = exp.layout === C.EXPANSION_LAYOUT_SEPARATE ? "sep-open-all-tabs" : "open-amboss";
    saveExp(exp, function () { scheduleNext(2000); });
  });
}
