/**
 * scraper.js -- AMBOSS page content scraper
 * Context: Injected into AMBOSS tabs via chrome.scripting.executeScript
 * Design: The last expression in this file is the scrape result, which
 *         executeScript captures as the InjectionResult.result value.
 *         Uses selectors from CONFIG (injected as a prior file).
 */

// Wrap in a block to avoid polluting global scope, but NOT an IIFE
// (executeScript captures the last evaluated expression of the file)
(function () {
  var C = typeof CONFIG !== "undefined" ? CONFIG : {};

  function getPageState() {
    if (document.querySelector(C.AMBOSS_CORRECT_MARKER_SELECTOR || '[data-e2e-test-id*="Correct"]')) {
      return "answered";
    }
    if (document.querySelector('[data-e2e-test-id="answer-theme-unanswered"]')) {
      return "unanswered";
    }
    return "unknown";
  }

  var result = {
    question: null,
    answers: {},
    correctAnswer: null,
    userWrongChoice: null,
    explanation: null,
    attendingTip: null,
    pageState: getPageState(),
    url: window.location.href,
    questionId: null,
  };

  // Parse URL for question ID
  var urlMatch = window.location.href.match(
    C.AMBOSS_URL_PATTERN || /next\.amboss\.com\/([a-z]{2})\/(?:questions|review)\/([^/]+)\/(\d+)/
  );
  if (urlMatch) {
    result.questionId = urlMatch[2] + ":" + urlMatch[3];
  }

  // Question text
  var article = document.querySelector(C.AMBOSS_QUESTION_SELECTOR || "article");
  if (article) {
    result.question = article.innerText.trim();
  }

  // Answer choices
  var letters = C.AMBOSS_ANSWER_LETTERS || ["a", "b", "c", "d", "e", "f"];
  var answerPrefix = C.AMBOSS_ANSWER_SELECTOR_PREFIX || '[data-e2e-test-id="answer-';
  var answerContentSel = C.AMBOSS_ANSWER_CONTENT_SELECTOR || '[class*="answerContent"] p';
  var correctSel = C.AMBOSS_CORRECT_MARKER_SELECTOR || '[data-e2e-test-id*="Correct"]';

  letters.forEach(function (letter) {
    var btn = document.querySelector(answerPrefix + letter + '"]');
    if (!btn) return;
    var textEl = btn.querySelector(answerContentSel);
    var isCorrect = !!btn.closest(correctSel);
    result.answers[letter.toUpperCase()] = {
      text: textEl ? textEl.innerText.trim() : "",
      isCorrect: isCorrect,
    };
    if (isCorrect) {
      result.correctAnswer = {
        letter: letter.toUpperCase(),
        text: textEl ? textEl.innerText.trim() : "",
      };
    }
  });

  // User's first wrong choice (if they got it wrong)
  var wrongChoiceWrapper = document.querySelector(
    C.AMBOSS_USER_WRONG_CHOICE_SELECTOR || '[data-e2e-test-id="answer-theme-userFirstAttemptIncorrect"]'
  );
  if (wrongChoiceWrapper) {
    // Find the actual answer button (answer-a through answer-f), not answer-row or other elements
    var wrongBtn = null;
    letters.forEach(function (letter) {
      if (!wrongBtn) {
        var candidate = wrongChoiceWrapper.querySelector(answerPrefix + letter + '"]');
        if (candidate) wrongBtn = candidate;
      }
    });
    if (wrongBtn) {
      var wrongLetter = (wrongBtn.getAttribute("data-e2e-test-id") || "").replace("answer-", "").toUpperCase();
      var wrongTextEl = wrongBtn.querySelector(answerContentSel);
      result.userWrongChoice = {
        letter: wrongLetter,
        text: wrongTextEl ? wrongTextEl.innerText.trim() : "",
      };
    }

    // Get the explanation for the wrong choice
    var wrongExplContainer = document.querySelector(
      C.AMBOSS_WRONG_CHOICE_EXPLANATION_SELECTOR || '[class*="incorrectFirstExplanation"]'
    );
    if (wrongExplContainer) {
      var wrongExplContent = wrongExplContainer.querySelector(
        C.AMBOSS_EXPLANATION_CONTENT_SELECTOR || '[class*="explanationContent"]'
      );
      if (wrongExplContent) {
        // Use textContent instead of innerText because the explanation
        // is inside a collapsed/hidden div (height:0, display:none)
        // and innerText respects CSS visibility, returning empty/truncated text
        result.userWrongChoice.explanation = wrongExplContent.textContent.trim();
      }
    }
  }

  // Explanation (for the correct answer)
  var explContainer = document.querySelector(
    C.AMBOSS_EXPLANATION_CONTAINER_SELECTOR || '[data-e2e-test-id="answerExplanation"]'
  );
  if (explContainer) {
    var explContent = explContainer.querySelector(
      C.AMBOSS_EXPLANATION_CONTENT_SELECTOR || '[class*="explanationContent"]'
    );
    if (explContent) {
      result.explanation = explContent.innerText.trim();
    }
  }

  // Attending tip
  var hintArticle = document.querySelector(C.AMBOSS_HINT_SELECTOR || 'article[class*="hintText"]');
  if (hintArticle) {
    result.attendingTip = hintArticle.innerText.trim();
  } else {
    var fallback = document.querySelector(C.AMBOSS_HINT_FALLBACK_SELECTOR || '[class*="extraExplanationText"]');
    if (fallback) {
      var tipContent = fallback.querySelector('[class*="explanationContent"]');
      if (tipContent) {
        result.attendingTip = tipContent.innerText.trim();
      }
    }
  }

  return result;
})();
