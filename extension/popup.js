/**
 * popup.js -- Main popup logic
 * Context: Extension popup (opened when user clicks extension icon)
 * Design: Scrapes the active AMBOSS tab, then delegates tab creation
 *         and injection to the background service worker (which survives
 *         popup close).
 */

(function () {
  "use strict";

  var C = CONFIG;

  // ── DOM refs ──
  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var skillButtonsContainer = document.getElementById("skill-buttons");
  var toggleBackground = document.getElementById("toggle-background");
  var toggleAutoGenerate = document.getElementById("toggle-auto-generate");
  var autoGenerateSkillRow = document.getElementById("auto-generate-skill-row");
  var autoGenerateSkillSelect = document.getElementById("auto-generate-skill");
  var selectCooldown = document.getElementById("select-cooldown");
  var queueInfo = document.getElementById("queue-info");
  var openDebugLink = document.getElementById("open-debug");

  // ── State ──
  var ambossTabId = null;
  var isAmbossPage = false;

  // ── Init ──
  function init() {
    loadSettings();
    renderSkillButtons();
    detectAmbossTab();
    bindEvents();
    updateQueueStatus();
  }

  // ── Settings ──
  function loadSettings() {
    chrome.storage.local.get(
      [C.STORAGE_KEY_OPEN_IN_BACKGROUND, C.STORAGE_KEY_COOLDOWN_MS, C.STORAGE_KEY_AUTO_GENERATE, C.STORAGE_KEY_AUTO_GENERATE_SKILL],
      function (result) {
        if (chrome.runtime.lastError) return;
        toggleBackground.checked =
          result[C.STORAGE_KEY_OPEN_IN_BACKGROUND] !== undefined
            ? result[C.STORAGE_KEY_OPEN_IN_BACKGROUND]
            : C.DEFAULT_OPEN_IN_BACKGROUND;
        if (result[C.STORAGE_KEY_COOLDOWN_MS]) {
          selectCooldown.value = String(result[C.STORAGE_KEY_COOLDOWN_MS]);
        }
        // Auto-generate
        var autoOn = result[C.STORAGE_KEY_AUTO_GENERATE] !== undefined
          ? result[C.STORAGE_KEY_AUTO_GENERATE]
          : C.DEFAULT_AUTO_GENERATE;
        toggleAutoGenerate.checked = autoOn;
        autoGenerateSkillRow.classList.toggle("hidden", !autoOn);
        if (result[C.STORAGE_KEY_AUTO_GENERATE_SKILL]) {
          autoGenerateSkillSelect.value = result[C.STORAGE_KEY_AUTO_GENERATE_SKILL];
        }
      }
    );

    // Populate auto-generate skill dropdown
    C.SKILLS.forEach(function (skill) {
      var opt = document.createElement("option");
      opt.value = skill.id;
      opt.textContent = skill.label;
      if (skill.id === C.DEFAULT_AUTO_GENERATE_SKILL) opt.selected = true;
      autoGenerateSkillSelect.appendChild(opt);
    });
  }

  function bindEvents() {
    toggleBackground.addEventListener("change", function () {
      var obj = {};
      obj[C.STORAGE_KEY_OPEN_IN_BACKGROUND] = toggleBackground.checked;
      chrome.storage.local.set(obj);
    });

    selectCooldown.addEventListener("change", function () {
      var obj = {};
      obj[C.STORAGE_KEY_COOLDOWN_MS] = parseInt(selectCooldown.value, 10);
      chrome.storage.local.set(obj);
    });

    toggleAutoGenerate.addEventListener("change", function () {
      var obj = {};
      obj[C.STORAGE_KEY_AUTO_GENERATE] = toggleAutoGenerate.checked;
      chrome.storage.local.set(obj);
      autoGenerateSkillRow.classList.toggle("hidden", !toggleAutoGenerate.checked);
    });

    autoGenerateSkillSelect.addEventListener("change", function () {
      var obj = {};
      obj[C.STORAGE_KEY_AUTO_GENERATE_SKILL] = autoGenerateSkillSelect.value;
      chrome.storage.local.set(obj);
    });

    openDebugLink.addEventListener("click", function (e) {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
    });
  }

  // ── Skill icon map ──
  var SKILL_ICONS = {
    "causal-explainer-brief-v2": "\uD83E\uDDE0",
    "usmle-flowchart": "\uD83D\uDCC8"
  };

  // ── Render skill buttons ──
  function renderSkillButtons() {
    C.SKILLS.forEach(function (skill) {
      var btn = document.createElement("button");
      btn.className = "skill-btn";
      btn.disabled = true;
      btn.dataset.skillId = skill.id;

      var icon = document.createElement("span");
      icon.className = "skill-icon";
      icon.textContent = SKILL_ICONS[skill.id] || "\u2728";

      var content = document.createElement("span");
      content.className = "skill-content";

      var label = document.createElement("span");
      label.className = "skill-label";
      label.textContent = skill.label;

      var hint = document.createElement("span");
      hint.className = "skill-hint";
      hint.textContent = skill.prefix.trim();

      content.appendChild(label);
      content.appendChild(hint);
      btn.appendChild(icon);
      btn.appendChild(content);
      btn.addEventListener("click", function () {
        handleSkillClick(skill);
      });

      skillButtonsContainer.appendChild(btn);
    });
  }

  function setButtonsEnabled(enabled) {
    var buttons = skillButtonsContainer.querySelectorAll(".skill-btn");
    buttons.forEach(function (btn) {
      btn.disabled = !enabled;
    });
  }

  // ── Detect if current tab is AMBOSS ──
  function detectAmbossTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
        setStatus("err", "No active tab found");
        return;
      }

      var tab = tabs[0];
      var match = tab.url && tab.url.match(C.AMBOSS_URL_PATTERN);

      if (match) {
        ambossTabId = tab.id;
        isAmbossPage = true;

        // Check queue status and show it
        chrome.runtime.sendMessage({ type: C.MSG_GET_QUEUE_STATUS }, function (status) {
          if (chrome.runtime.lastError || !status) {
            setStatus("ok", "AMBOSS Q" + match[3] + " detected");
          } else if (status.queueLength > 0) {
            var waitMin = Math.ceil(status.nextSlotInMs / 60000);
            setStatus("ok", "Q" + match[3] + " | " + status.queueLength + " queued, next in ~" + waitMin + "m");
          } else {
            setStatus("ok", "AMBOSS Q" + match[3] + " detected");
          }
          setButtonsEnabled(true);
        });
      } else {
        setStatus("warn", "Not on an AMBOSS question page");
        setButtonsEnabled(false);
      }
    });
  }

  function setStatus(type, text) {
    statusDot.className = "dot " + type;
    statusText.textContent = text;
    var statusBar = document.getElementById("status-bar");
    statusBar.className = "status-" + type;
  }

  // ── Main flow: skill button clicked ──
  function handleSkillClick(skill) {
    if (!isAmbossPage || !ambossTabId) return;

    setStatus("ok", "Scraping page...");
    setButtonsEnabled(false);

    // Step 1: Inject config.js first, then scraper.js separately
    // (avoids ambiguity about which result index has the scrape data)
    chrome.scripting.executeScript(
      { target: { tabId: ambossTabId }, files: ["config.js"] },
      function () {
        if (chrome.runtime.lastError) {
          setStatus("err", "Config inject failed: " + chrome.runtime.lastError.message);
          setButtonsEnabled(true);
          return;
        }

        chrome.scripting.executeScript(
          { target: { tabId: ambossTabId }, files: ["scraper.js"] },
          function (results) {
            if (chrome.runtime.lastError) {
              setStatus("err", "Scrape failed: " + chrome.runtime.lastError.message);
              setButtonsEnabled(true);
              return;
            }

            var scraped = results && results[0] && results[0].result;
            if (!scraped || !scraped.question) {
              setStatus("err", "No question content found");
              setButtonsEnabled(true);
              return;
            }

            // Step 2: Load templates and build the message text
            loadTemplates(function () {
            var messageText = buildMessageText(skill, scraped);

            // Step 3: Delegate to background worker (survives popup close)
            setStatus("ok", "Opening Claude...");
            chrome.runtime.sendMessage(
              {
                type: C.MSG_OPEN_AND_INJECT,
                text: messageText,
                openInBackground: toggleBackground.checked,
              },
              function (response) {
                if (chrome.runtime.lastError) return;
                if (response && response.success) {
                  if (response.queued) {
                    setStatus("ok", response.message);
                  } else {
                    setStatus("ok", "Sending now...");
                  }
                  setTimeout(function () { window.close(); }, C.POPUP_AUTO_CLOSE_DELAY_MS);
                } else if (response) {
                  setStatus("err", response.error || "Unknown error");
                  setButtonsEnabled(true);
                }
              }
            );
            }); // end loadTemplates
          }
        );
      }
    );
  }

  // ── Build the claude.ai message using template engine ──
  // Templates can be customized via storage; falls back to CONFIG defaults
  var cachedPromptTemplate = null;
  var cachedWrongChoiceTemplate = null;

  function loadTemplates(callback) {
    if (cachedPromptTemplate !== null) {
      callback();
      return;
    }
    chrome.storage.local.get(
      [C.STORAGE_KEY_PROMPT_TEMPLATE, C.STORAGE_KEY_WRONG_CHOICE_TEMPLATE],
      function (result) {
        if (chrome.runtime.lastError) { /* use defaults */ }
        cachedPromptTemplate = result[C.STORAGE_KEY_PROMPT_TEMPLATE] || C.PROMPT_TEMPLATE;
        cachedWrongChoiceTemplate = result[C.STORAGE_KEY_WRONG_CHOICE_TEMPLATE] || C.WRONG_CHOICE_TEMPLATE;
        callback();
      }
    );
  }

  function buildMessageText(skill, scraped) {
    return TemplateEngine.buildMessage(
      skill, scraped, cachedPromptTemplate, cachedWrongChoiceTemplate
    );
  }

  // ── Queue Status ──
  function updateQueueStatus() {
    chrome.runtime.sendMessage({ type: C.MSG_GET_QUEUE_STATUS }, function (status) {
      if (chrome.runtime.lastError || !status) {
        queueInfo.textContent = "Unable to fetch queue status";
        return;
      }

      var parts = [];

      if (status.queueLength > 0) {
        parts.push(status.queueLength + " item" + (status.queueLength > 1 ? "s" : "") + " queued");
      }

      if (status.recentSends > 0) {
        parts.push(status.recentSends + "/" + status.maxConcurrent + " slots used");
      }

      if (status.nextSlotInMs > 0) {
        var mins = Math.ceil(status.nextSlotInMs / 60000);
        parts.push("next slot in ~" + mins + " min");
      }

      var cooldownMin = (status.cooldownMs / 60000).toFixed(1).replace(/\.0$/, "");
      parts.push("cooldown: " + cooldownMin + " min");

      if (parts.length === 1) {
        // Only cooldown, nothing active
        queueInfo.textContent = "Idle. Cooldown set to " + cooldownMin + " min.";
        queueInfo.className = "";
      } else {
        queueInfo.textContent = parts.join("  ·  ");
        queueInfo.className = status.queueLength > 0 ? "has-items" : "";
      }
    });

    // Also check expansion status
    chrome.runtime.sendMessage({ type: C.MSG_GET_EXPANSION_STATUS }, function (expStatus) {
      if (chrome.runtime.lastError || !expStatus || !expStatus.running) return;
      var done = expStatus.currentQ - expStatus.startQ;
      var total = expStatus.endQ - expStatus.startQ + 1;
      var current = queueInfo.textContent;
      queueInfo.textContent = "Expanding: Q" + expStatus.currentQ + " (" + done + "/" + total + " done, phase: " + expStatus.phase + ")  ·  " + current;
      queueInfo.className = "has-items";
    });
  }

  // ── Tab Expansion ──
  var expansionPanel = document.getElementById("expansion-panel");
  var expandStart = document.getElementById("expand-start");
  var expandEnd = document.getElementById("expand-end");
  var expandSkill = document.getElementById("expand-skill");
  var expandLayout = document.getElementById("expand-layout");
  var expandBtn = document.getElementById("expand-btn");
  var expandBtnLabel = document.getElementById("expand-btn-label");
  var expandBtnHint = document.getElementById("expand-btn-hint");
  var expansionEstimate = document.getElementById("expansion-estimate");

  var sessionInfo = null; // { baseUrl, sessionTotal, questionNum, isReview }

  function initExpansionPanel(scraped) {
    if (!scraped.sessionTotal || !scraped.baseUrl || scraped.sessionTotal <= 1) return;

    sessionInfo = {
      baseUrl: scraped.baseUrl,
      sessionTotal: scraped.sessionTotal,
      questionNum: parseInt(scraped.questionNum, 10),
      isReview: scraped.isReview,
    };

    // Populate start dropdown
    expandStart.innerHTML = "";
    for (var i = 1; i <= sessionInfo.sessionTotal; i++) {
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i;
      if (i === sessionInfo.questionNum) opt.selected = true;
      expandStart.appendChild(opt);
    }

    // Populate end dropdown (includes "To end" option)
    expandEnd.innerHTML = "";
    var endAll = document.createElement("option");
    endAll.value = "end";
    endAll.textContent = "End (" + sessionInfo.sessionTotal + ")";
    endAll.selected = true;
    expandEnd.appendChild(endAll);
    for (var j = 1; j <= sessionInfo.sessionTotal; j++) {
      var opt2 = document.createElement("option");
      opt2.value = j;
      opt2.textContent = j;
      expandEnd.appendChild(opt2);
    }

    // Populate skill dropdown
    expandSkill.innerHTML = "";
    C.SKILLS.forEach(function (skill) {
      var opt3 = document.createElement("option");
      opt3.value = skill.id;
      opt3.textContent = skill.label;
      expandSkill.appendChild(opt3);
    });

    // Load saved layout preference
    chrome.storage.local.get([C.STORAGE_KEY_EXPANSION_LAYOUT], function (result) {
      if (result[C.STORAGE_KEY_EXPANSION_LAYOUT]) {
        expandLayout.value = result[C.STORAGE_KEY_EXPANSION_LAYOUT];
      }
    });
    expandLayout.addEventListener("change", function () {
      var obj = {};
      obj[C.STORAGE_KEY_EXPANSION_LAYOUT] = expandLayout.value;
      chrome.storage.local.set(obj);
    });

    updateExpansionEstimate();
    expandBtn.disabled = false;
    expandBtnHint.textContent = "Opens each question + Claude tab in order";
    expansionPanel.classList.remove("hidden");

    // Warn if not review page
    if (!sessionInfo.isReview) {
      expandBtnHint.textContent = "Warning: not a review page. Unanswered questions may lack explanations.";
    }

    expandStart.addEventListener("change", updateExpansionEstimate);
    expandEnd.addEventListener("change", updateExpansionEstimate);
    expandLayout.addEventListener("change", updateExpansionEstimate);

    expandBtn.addEventListener("click", function () {
      if (!sessionInfo) return;

      var startQ = parseInt(expandStart.value, 10);
      var endQ = expandEnd.value === "end" ? sessionInfo.sessionTotal : parseInt(expandEnd.value, 10);

      if (endQ < startQ) {
        setStatus("err", "End question must be >= start");
        return;
      }

      var selectedSkill = C.SKILLS.find(function (s) { return s.id === expandSkill.value; });
      if (!selectedSkill) return;

      var chosenLayout = expandLayout.value;
      setStatus("ok", "Starting " + chosenLayout + " batch...");
      expandBtn.disabled = true;

      chrome.runtime.sendMessage({
        type: C.MSG_START_EXPANSION,
        baseUrl: sessionInfo.baseUrl,
        startQ: startQ,
        endQ: endQ,
        skillId: selectedSkill.id,
        skillPrefix: selectedSkill.prefix,
        openInBackground: toggleBackground.checked,
        layout: chosenLayout,
      }, function (response) {
        if (chrome.runtime.lastError) return;
        if (response && response.success) {
          setStatus("ok", response.message || "Expansion started!");
          setTimeout(function () { window.close(); }, C.POPUP_AUTO_CLOSE_DELAY_MS);
        } else {
          setStatus("err", (response && response.error) || "Failed to start");
          expandBtn.disabled = false;
        }
      });
    });
  }

  function updateExpansionEstimate() {
    if (!sessionInfo) return;

    var startQ = parseInt(expandStart.value, 10);
    var endQ = expandEnd.value === "end" ? sessionInfo.sessionTotal : parseInt(expandEnd.value, 10);
    var count = Math.max(0, endQ - startQ + 1);

    if (count <= 0) {
      expansionEstimate.textContent = "";
      expandBtnLabel.textContent = "Generate All";
      return;
    }

    var layoutLabel = expandLayout.value === C.EXPANSION_LAYOUT_SEPARATE ? " (separate window)" : " (same window)";
    expandBtnLabel.textContent = "Generate " + count + " Question" + (count > 1 ? "s" : "") + layoutLabel;

    // Time estimate: first 3 are immediate, then batches of 3 with cooldown
    chrome.runtime.sendMessage({ type: C.MSG_GET_QUEUE_STATUS }, function (status) {
      var cooldownMs = (status && status.cooldownMs) || C.QUEUE_COOLDOWN_MS;
      var batches = Math.ceil(count / C.MAX_CONCURRENT_REQUESTS);
      var overheadMs = count * C.EXPANSION_OVERHEAD_PER_QUESTION_MS;
      var cooldownTotal = Math.max(0, batches - 1) * cooldownMs;
      var totalMs = overheadMs + cooldownTotal;

      var totalMin = Math.ceil(totalMs / 60000);
      if (totalMin < 1) totalMin = 1;

      var finishTime = new Date(Date.now() + totalMs);
      var finishStr = finishTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

      expansionEstimate.textContent = "~" + totalMin + " min total. Done by ~" + finishStr + ".";
    });
  }

  // After scraping in detectAmbossTab, also init the expansion panel
  function tryScrapeForExpansion() {
    if (!ambossTabId) return;
    chrome.scripting.executeScript(
      { target: { tabId: ambossTabId }, files: ["config.js"] },
      function () {
        if (chrome.runtime.lastError) return;
        chrome.scripting.executeScript(
          { target: { tabId: ambossTabId }, files: ["scraper.js"] },
          function (results) {
            if (chrome.runtime.lastError) return;
            var data = results && results[0] && results[0].result;
            if (data && data.sessionTotal) {
              initExpansionPanel(data);
            }
          }
        );
      }
    );
  }

  // ── Start ──
  init();
  // Scrape for expansion panel after a small delay (let popup render first)
  setTimeout(tryScrapeForExpansion, 200);
})();
