/**
 * amboss-watcher.js -- Content script for AMBOSS question pages
 * Context: Runs on next.amboss.com pages
 * Design: Watches for the transition from unanswered to answered state
 *         (answer-theme-unanswered elements disappearing, replaced by
 *         Correct/Incorrect markers). When detected, checks if auto-generate
 *         is enabled and sends a message to the background worker to
 *         scrape and generate a diagram automatically.
 */

(function () {
  "use strict";

  var C = typeof CONFIG !== "undefined" ? CONFIG : {};
  var UNANSWERED_SEL = C.AMBOSS_UNANSWERED_SELECTOR || '[data-e2e-test-id="answer-theme-unanswered"]';
  var ANSWERED_SEL = C.AMBOSS_ANSWERED_SELECTOR || '[data-e2e-test-id*="Correct"], [data-e2e-test-id="answer-theme-answerOptionIncorrect"]';
  var MSG_TYPE = C.MSG_AUTO_GENERATE_TRIGGERED || "auto-generate-triggered";

  var hasTriggeredForUrl = null; // track which URL we've already triggered for
  var observer = null;

  function isUnanswered() {
    return document.querySelectorAll(UNANSWERED_SEL).length > 0;
  }

  function isAnswered() {
    return document.querySelectorAll(ANSWERED_SEL).length > 0;
  }

  function getCurrentQuestionId() {
    var match = window.location.href.match(
      /next\.amboss\.com\/([a-z]{2})\/(?:questions|review)\/([^/]+)\/(\d+)/
    );
    return match ? match[2] + ":" + match[3] : null;
  }

  function onAnswerDetected() {
    var qid = getCurrentQuestionId();
    if (!qid || hasTriggeredForUrl === qid) return;
    hasTriggeredForUrl = qid;

    // Check if auto-generate is enabled
    chrome.storage.local.get(
      [C.STORAGE_KEY_AUTO_GENERATE || "autoGenerate"],
      function (result) {
        if (chrome.runtime.lastError) return;
        var enabled = result[C.STORAGE_KEY_AUTO_GENERATE || "autoGenerate"];
        if (!enabled) return;

        // Send to background -- it will scrape this tab and queue the Claude send
        chrome.runtime.sendMessage({
          type: MSG_TYPE,
          url: window.location.href,
          questionId: qid,
        });
      }
    );
  }

  function startWatching() {
    // If already answered (e.g. review page), don't watch
    if (isAnswered()) return;

    // Watch the answer section for changes
    var answerSection = document.querySelector('section[aria-label="Answer Options"]');
    if (!answerSection) {
      // Answer section not rendered yet (SPA), try again soon
      setTimeout(startWatching, 2000);
      return;
    }

    observer = new MutationObserver(function () {
      if (isAnswered() && !isUnanswered()) {
        // Transition detected: was unanswered, now answered
        // Small delay to let AMBOSS render explanations
        setTimeout(onAnswerDetected, 1500);
        // Stop observing -- we only trigger once per question
        if (observer) observer.disconnect();
      }
    });

    observer.observe(answerSection, {
      attributes: true,
      attributeFilter: ["data-e2e-test-id", "class"],
      subtree: true,
      childList: true,
    });
  }

  // Handle SPA navigation (URL changes without page reload)
  var lastUrl = window.location.href;
  setInterval(function () {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      hasTriggeredForUrl = null;
      if (observer) observer.disconnect();
      // Wait for new page to render
      setTimeout(startWatching, 2000);
    }
  }, 500);

  // Start on initial load
  startWatching();
})();
