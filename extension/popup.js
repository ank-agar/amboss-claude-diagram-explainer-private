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
  }

  // ── Settings ──
  function loadSettings() {
    chrome.storage.local.get(
      [C.STORAGE_KEY_OPEN_IN_BACKGROUND],
      function (result) {
        if (chrome.runtime.lastError) return;
        toggleBackground.checked =
          result[C.STORAGE_KEY_OPEN_IN_BACKGROUND] !== undefined
            ? result[C.STORAGE_KEY_OPEN_IN_BACKGROUND]
            : C.DEFAULT_OPEN_IN_BACKGROUND;
      }
    );
  }

  function bindEvents() {
    toggleBackground.addEventListener("change", function () {
      var obj = {};
      obj[C.STORAGE_KEY_OPEN_IN_BACKGROUND] = toggleBackground.checked;
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
        setStatus("ok", "AMBOSS Q" + match[3] + " detected");
        setButtonsEnabled(true);
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
                  setStatus("ok", "Sent to Claude!");
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

  // ── Start ──
  init();
})();
