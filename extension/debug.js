/**
 * debug.js -- Debug page logic
 * Context: Extension page (chrome-extension://id/debug.html)
 * Design: Provides individual and batch tests for every component,
 *         plus a copy-to-clipboard report for sharing with developers.
 */

(function () {
  "use strict";

  var C = CONFIG;

  var logEl = document.getElementById("log");

  // ── Logging ──
  function log(label, text, type) {
    type = type || "data";
    var now = new Date();
    var ts = now.toLocaleTimeString("en-US", { hour12: false }) +
      "." + String(now.getMilliseconds()).padStart(3, "0");

    var entry = document.createElement("div");

    var timePart = document.createElement("span");
    timePart.className = "log-time";
    timePart.textContent = "[" + ts + "] ";
    entry.appendChild(timePart);

    var labelPart = document.createElement("span");
    labelPart.className = "log-label";
    labelPart.textContent = label + ": ";
    entry.appendChild(labelPart);

    var textPart = document.createElement("span");
    textPart.className = "log-" + type;
    textPart.textContent = text;
    entry.appendChild(textPart);

    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function truncate(str, max) {
    max = max || 500;
    if (!str) return "(empty/null)";
    return str.length <= max ? str : str.substring(0, max) + "... [" + str.length + " total]";
  }

  // ── Find AMBOSS tab ──
  function findAmbossTab(callback) {
    chrome.tabs.query({ url: "https://next.amboss.com/*" }, function (tabs) {
      if (chrome.runtime.lastError) {
        callback(null, chrome.runtime.lastError.message);
        return;
      }
      if (!tabs || tabs.length === 0) {
        callback(null, "No AMBOSS tabs open");
        return;
      }
      callback(tabs[0], null);
    });
  }

  // ── Scrape AMBOSS tab ──
  function scrapeAmbossTab(callback) {
    findAmbossTab(function (tab, err) {
      if (err) { callback(null, err); return; }

      // Inject config first, then scraper separately to avoid result index ambiguity
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ["config.js"] },
        function () {
          if (chrome.runtime.lastError) {
            callback(null, "Config inject: " + chrome.runtime.lastError.message);
            return;
          }
          chrome.scripting.executeScript(
            { target: { tabId: tab.id }, files: ["scraper.js"] },
            function (results) {
              if (chrome.runtime.lastError) {
                callback(null, chrome.runtime.lastError.message);
                return;
              }
              var data = results && results[0] && results[0].result;
              callback(data, data ? null : "Scraper returned no data");
            }
          );
        }
      );
    });
  }

  // Message building is now handled by buildMessageTextDebug() + TemplateEngine

  // ── Individual test handlers ──
  var testHandlers = {
    "scrape-question": function () {
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Question", "FAIL: " + err, "err"); return; }
        log("Question", data.question ? truncate(data.question, 800) : "NOT FOUND", data.question ? "ok" : "err");
      });
    },

    "scrape-answers": function () {
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Answers", "FAIL: " + err, "err"); return; }
        var keys = Object.keys(data.answers);
        if (keys.length === 0) { log("Answers", "No answer choices found", "warn"); return; }
        keys.forEach(function (l) {
          var a = data.answers[l];
          log("Answer " + l, truncate(a.text, 200) + (a.isCorrect ? " [CORRECT]" : ""), a.isCorrect ? "ok" : "data");
        });
      });
    },

    "scrape-correct": function () {
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Correct", "FAIL: " + err, "err"); return; }
        if (data.correctAnswer) {
          log("Correct", data.correctAnswer.letter + ". " + truncate(data.correctAnswer.text, 200), "ok");
        } else {
          log("Correct", "Not available (answer the question first?)", "warn");
        }
      });
    },

    "scrape-explanation": function () {
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Explanation", "FAIL: " + err, "err"); return; }
        log("Explanation", data.explanation ? truncate(data.explanation, 800) : "Not found", data.explanation ? "ok" : "warn");
      });
    },

    "scrape-tip": function () {
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Tip", "FAIL: " + err, "err"); return; }
        log("Attending Tip", data.attendingTip ? truncate(data.attendingTip, 800) : "Not found on this page", data.attendingTip ? "ok" : "info");
      });
    },

    "scrape-all": function () {
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Full Scrape", "FAIL: " + err, "err"); return; }
        log("Scrape", "pageState = " + data.pageState, "info");
        log("Scrape", "questionId = " + data.questionId, data.questionId ? "ok" : "warn");
        log("Scrape", "question = " + (data.question ? data.question.length + " chars" : "null"), data.question ? "ok" : "err");
        log("Scrape", "answers = " + Object.keys(data.answers).length + " choices", Object.keys(data.answers).length > 0 ? "ok" : "err");
        log("Scrape", "correctAnswer = " + (data.correctAnswer ? data.correctAnswer.letter : "null"), data.correctAnswer ? "ok" : "warn");
        log("Scrape", "explanation = " + (data.explanation ? data.explanation.length + " chars" : "null"), data.explanation ? "ok" : "warn");
        log("Scrape", "attendingTip = " + (data.attendingTip ? data.attendingTip.length + " chars" : "null"), data.attendingTip ? "info" : "info");
        log("Scrape", "url = " + data.url, "data");
      });
    },

    "detect-tab": function () {
      log("Tab", "Searching for AMBOSS tabs...", "info");
      chrome.tabs.query({ url: "https://next.amboss.com/*" }, function (tabs) {
        if (!tabs || tabs.length === 0) {
          log("Tab", "No AMBOSS tabs found", "err");
          return;
        }
        tabs.forEach(function (tab, i) {
          log("Tab " + i, "id=" + tab.id + " url=" + tab.url, "ok");
        });
      });
    },

    "parse-url": function () {
      findAmbossTab(function (tab, err) {
        if (err) { log("URL", err, "err"); return; }
        var match = tab.url.match(C.AMBOSS_URL_PATTERN);
        if (match) {
          log("URL", "locale=" + match[1] + " session=" + match[2] + " q=" + match[3], "ok");
          log("URL", "questionId=" + match[2] + ":" + match[3], "ok");
          log("URL", "isReview=" + tab.url.includes("/review/"), "info");
        } else {
          log("URL", "Does not match AMBOSS question pattern: " + tab.url, "warn");
        }
      });
    },

    "claude-tab": function () {
      log("Claude", "Testing access to claude.ai...", "info");
      chrome.tabs.create({ url: C.CLAUDE_NEW_CHAT_URL, active: false }, function (tab) {
        if (chrome.runtime.lastError) {
          log("Claude", "Cannot open claude.ai: " + chrome.runtime.lastError.message, "err");
          return;
        }
        log("Claude", "Opened claude.ai tab (id=" + tab.id + ")", "ok");
        // Close it after a moment
        setTimeout(function () {
          chrome.tabs.remove(tab.id);
          log("Claude", "Closed test tab", "info");
        }, 3000);
      });
    },

    "preview-message": function () {
      var skill = C.SKILLS.find(function (s) { return s.id === "causal-explainer-brief-v2"; }) || C.SKILLS[0];
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Preview", "FAIL: " + err, "err"); return; }
        if (!data.question) { log("Preview", "No question to preview", "warn"); return; }
        var msg = buildMessageTextDebug(skill.prefix, data);
        log("Preview", "Skill: " + skill.label, "info");
        log("Preview", "Total length: " + msg.length + " chars", "info");
        log("Preview", truncate(msg, 5000), "data");
      });
    },

    "preview-flowchart": function () {
      var skill = C.SKILLS.find(function (s) { return s.id === "usmle-flowchart"; }) || C.SKILLS[1];
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Preview", "FAIL: " + err, "err"); return; }
        if (!data.question) { log("Preview", "No question to preview", "warn"); return; }
        var msg = buildMessageTextDebug(skill.prefix, data);
        log("Preview", "Skill: " + skill.label, "info");
        log("Preview", "Total length: " + msg.length + " chars", "info");
        log("Preview", truncate(msg, 5000), "data");
      });
    },

    "storage-dump": function () {
      chrome.storage.local.get(null, function (items) {
        if (chrome.runtime.lastError) { log("Storage", chrome.runtime.lastError.message, "err"); return; }
        var keys = Object.keys(items);
        log("Storage", keys.length + " key(s): " + keys.join(", "), "info");
        keys.forEach(function (k) {
          log("Storage", k + " = " + truncate(JSON.stringify(items[k]), 200), "data");
        });
      });
    },

    "storage-clear": function () {
      chrome.storage.local.clear(function () {
        log("Storage", "All settings cleared", "ok");
      });
    },

    "reset-queue": function () {
      chrome.runtime.sendMessage({ type: "reset-all-state" }, function (resp) {
        if (chrome.runtime.lastError) {
          log("Reset", "Error: " + chrome.runtime.lastError.message, "err");
          return;
        }
        log("Reset", "Queue, timestamps, and expansion state cleared", "ok");
      });
    },
  };

  // ── Bind test buttons ──
  document.querySelectorAll("[data-test]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var handler = testHandlers[btn.dataset.test];
      if (handler) handler();
    });
  });

  // ── Clear log ──
  document.getElementById("btn-clear-log").addEventListener("click", function () {
    logEl.textContent = "";
  });

  // ── Run All Tests ──
  document.getElementById("btn-run-all").addEventListener("click", function () {
    logEl.textContent = "";
    log("Run All", "Starting test suite...", "info");
    log("Run All", "Extension ID: " + chrome.runtime.id, "info");
    log("Run All", "Version: " + chrome.runtime.getManifest().version, "info");

    var tests = [];
    var idx = 0;

    // Test 1: AMBOSS tab
    tests.push(function (next) {
      log("Test 1/5", "AMBOSS tab detection", "info");
      findAmbossTab(function (tab, err) {
        if (err) { log("Test 1", "FAIL - " + err, "err"); }
        else { log("Test 1", "OK - tab=" + tab.id + " url=" + truncate(tab.url, 80), "ok"); }
        next();
      });
    });

    // Test 2: URL parsing
    tests.push(function (next) {
      log("Test 2/5", "URL parsing", "info");
      findAmbossTab(function (tab, err) {
        if (err) { log("Test 2", "SKIP - no tab", "warn"); next(); return; }
        var m = tab.url.match(C.AMBOSS_URL_PATTERN);
        if (m) { log("Test 2", "OK - qid=" + m[2] + ":" + m[3], "ok"); }
        else { log("Test 2", "FAIL - URL doesn't match pattern", "err"); }
        next();
      });
    });

    // Test 3: Scraping
    tests.push(function (next) {
      log("Test 3/5", "Page scraping", "info");
      scrapeAmbossTab(function (data, err) {
        if (err) { log("Test 3", "FAIL - " + err, "err"); next(); return; }
        log("Test 3", "question: " + (data.question ? data.question.length + " chars OK" : "MISSING"), data.question ? "ok" : "err");
        log("Test 3", "answers: " + Object.keys(data.answers).length + (Object.keys(data.answers).length > 0 ? " OK" : " MISSING"), Object.keys(data.answers).length > 0 ? "ok" : "err");
        log("Test 3", "correct: " + (data.correctAnswer ? data.correctAnswer.letter + " OK" : "n/a"), data.correctAnswer ? "ok" : "warn");
        log("Test 3", "explanation: " + (data.explanation ? data.explanation.length + " chars OK" : "n/a"), data.explanation ? "ok" : "warn");
        log("Test 3", "tip: " + (data.attendingTip ? data.attendingTip.length + " chars OK" : "none"), "info");
        log("Test 3", "state: " + data.pageState, "info");
        next();
      });
    });

    // Test 4: Message preview
    tests.push(function (next) {
      log("Test 4/5", "Message construction", "info");
      scrapeAmbossTab(function (data, err) {
        if (err || !data || !data.question) {
          log("Test 4", "SKIP - no scraped data", "warn");
          next();
          return;
        }
        C.SKILLS.forEach(function (skill) {
          var msg = buildMessageTextDebug(skill.prefix, data);
          log("Test 4", skill.id + ": " + msg.length + " chars, starts with: " + truncate(msg, 60), "ok");
        });
        next();
      });
    });

    // Test 5: Storage
    tests.push(function (next) {
      log("Test 5/5", "Storage", "info");
      chrome.storage.local.get(null, function (items) {
        var keys = Object.keys(items);
        log("Test 5", keys.length + " stored key(s)", "info");
        next();
      });
    });

    function runNext() {
      if (idx >= tests.length) {
        log("Run All", "Done! Click 'Copy Report' to share.", "ok");
        return;
      }
      tests[idx++](runNext);
    }
    runNext();
  });

  // ── Template editor ──
  var templateMain = document.getElementById("template-main");
  var templateWrong = document.getElementById("template-wrong");
  var btnSaveTemplates = document.getElementById("btn-save-templates");
  var btnResetTemplates = document.getElementById("btn-reset-templates");

  // Load current templates into the textareas
  chrome.storage.local.get(
    [C.STORAGE_KEY_PROMPT_TEMPLATE, C.STORAGE_KEY_WRONG_CHOICE_TEMPLATE],
    function (result) {
      if (chrome.runtime.lastError) return;
      templateMain.value = result[C.STORAGE_KEY_PROMPT_TEMPLATE] || C.PROMPT_TEMPLATE;
      templateWrong.value = result[C.STORAGE_KEY_WRONG_CHOICE_TEMPLATE] || C.WRONG_CHOICE_TEMPLATE;
    }
  );

  btnSaveTemplates.addEventListener("click", function () {
    var obj = {};
    obj[C.STORAGE_KEY_PROMPT_TEMPLATE] = templateMain.value;
    obj[C.STORAGE_KEY_WRONG_CHOICE_TEMPLATE] = templateWrong.value;
    chrome.storage.local.set(obj, function () {
      log("Templates", "Saved!", "ok");
    });
  });

  btnResetTemplates.addEventListener("click", function () {
    templateMain.value = C.PROMPT_TEMPLATE;
    templateWrong.value = C.WRONG_CHOICE_TEMPLATE;
    chrome.storage.local.remove(
      [C.STORAGE_KEY_PROMPT_TEMPLATE, C.STORAGE_KEY_WRONG_CHOICE_TEMPLATE],
      function () {
        log("Templates", "Reset to defaults", "ok");
      }
    );
  });

  // Update debug preview to use template engine
  function buildMessageTextDebug(prefix, scraped) {
    var skill = { prefix: prefix };
    var promptTpl = templateMain.value || C.PROMPT_TEMPLATE;
    var wrongTpl = templateWrong.value || C.WRONG_CHOICE_TEMPLATE;
    return TemplateEngine.buildMessage(skill, scraped, promptTpl, wrongTpl);
  }

  // ── Copy report ──
  document.getElementById("btn-copy-report").addEventListener("click", function () {
    var lines = [];
    logEl.querySelectorAll("div").forEach(function (el) {
      lines.push(el.textContent);
    });
    if (lines.length === 0) lines.push("(No log entries. Click 'Run All Tests' first.)");

    var header = "=== AMBOSS Diagram Maker Debug Report ===\n";
    header += "Date: " + new Date().toISOString() + "\n";
    header += "Extension ID: " + chrome.runtime.id + "\n";
    header += "Version: " + chrome.runtime.getManifest().version + "\n";
    header += "===========================================\n\n";

    navigator.clipboard.writeText(header + lines.join("\n")).then(function () {
      log("Clipboard", "Copied!", "ok");
    }).catch(function (err) {
      log("Clipboard", "Failed: " + err.message, "err");
    });
  });
})();
