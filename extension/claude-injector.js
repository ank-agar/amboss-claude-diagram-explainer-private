/**
 * claude-injector.js -- Content script for claude.ai
 * Context: Runs on claude.ai pages
 * Design: Listens for messages containing text to inject into the
 *         ProseMirror chat input, then submits. Uses multiple injection
 *         strategies and retries the send button (which may be disabled
 *         until ProseMirror registers the content, especially in
 *         background tabs).
 */

(function () {
  "use strict";

  var C = typeof CONFIG !== "undefined" ? CONFIG : {};
  var INPUT_SEL = C.CLAUDE_INPUT_SELECTOR || '[contenteditable="true"]';
  var SEND_SEL = C.CLAUDE_SEND_BUTTON_SELECTOR || 'button[aria-label="Send message"]';
  var SEND_FALLBACK_SEL = C.CLAUDE_SEND_BUTTON_FALLBACK_SELECTOR || 'button[type="submit"]';
  var SUBMIT_DELAY = C.CLAUDE_SUBMIT_DELAY_MS || 300;
  var WAIT_TIMEOUT = C.CLAUDE_WAIT_FOR_ELEMENT_TIMEOUT_MS || 15000;
  var WAIT_INTERVAL = C.CLAUDE_WAIT_FOR_ELEMENT_INTERVAL_MS || 200;
  var SEND_RETRIES = C.CLAUDE_SEND_RETRY_ATTEMPTS || 10;
  var SEND_RETRY_MS = C.CLAUDE_SEND_RETRY_INTERVAL_MS || 500;
  var MSG_TYPE = C.MSG_INJECT_AND_SUBMIT || "inject-and-submit";

  /**
   * Wait for an element matching a selector to appear in the DOM.
   */
  function waitForElement(selector, timeoutMs, intervalMs) {
    timeoutMs = timeoutMs || WAIT_TIMEOUT;
    intervalMs = intervalMs || WAIT_INTERVAL;
    return new Promise(function (resolve, reject) {
      var el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      var elapsed = 0;
      var timer = setInterval(function () {
        elapsed += intervalMs;
        var found = document.querySelector(selector);
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (elapsed >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timeout waiting for: " + selector));
        }
      }, intervalMs);
    });
  }

  /**
   * Inject text into ProseMirror editor using multiple strategies.
   * Returns the input element for later use.
   */
  function injectText(inputEl, text) {
    inputEl.focus();

    // Strategy 1: DataTransfer-based paste (most ProseMirror-compatible)
    try {
      var dt = new DataTransfer();
      dt.setData("text/plain", text);
      var pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      inputEl.dispatchEvent(pasteEvent);
    } catch (e) {
      // DataTransfer constructor may not support setData in all browsers
    }

    return delay(150).then(function () {
      if (inputEl.textContent.trim()) return; // paste worked

      // Strategy 2: beforeinput event (ProseMirror's native handler)
      inputEl.focus();
      inputEl.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
      }));

      return delay(150);
    }).then(function () {
      if (inputEl.textContent.trim()) return; // inputEvent worked

      // Strategy 3: execCommand (deprecated but still works in some browsers)
      inputEl.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);

      return delay(150);
    }).then(function () {
      if (inputEl.textContent.trim()) return; // execCommand worked

      // Strategy 4: Clipboard API write + execCommand paste
      return navigator.clipboard.writeText(text).then(function () {
        inputEl.focus();
        document.execCommand("paste", false, null);
      }).catch(function () {
        // Last resort: set innerHTML (ProseMirror won't track this,
        // but at least the user can see the text and manually submit)
        var p = document.createElement("p");
        p.textContent = text;
        inputEl.innerHTML = "";
        inputEl.appendChild(p);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  }

  /**
   * Try to find and click an enabled send button.
   * Returns the result object or null if no enabled button found.
   */
  function trySend() {
    // Primary: aria-label
    var btn = document.querySelector(SEND_SEL);
    if (btn && !btn.disabled) {
      btn.click();
      return { success: true, method: "aria-label" };
    }

    // Fallback: submit button
    btn = document.querySelector(SEND_FALLBACK_SEL);
    if (btn && !btn.disabled) {
      btn.click();
      return { success: true, method: "submit-button" };
    }

    // Heuristic: enabled button with SVG near the input/composer area
    var buttons = document.querySelectorAll("button:not([disabled])");
    for (var i = buttons.length - 1; i >= 0; i--) {
      var candidate = buttons[i];
      if (candidate.querySelector("svg") &&
          candidate.closest("form, [class*='input'], [class*='composer']")) {
        candidate.click();
        return { success: true, method: "heuristic" };
      }
    }

    return null; // not found yet
  }

  /**
   * Retry clicking send until the button becomes enabled.
   * Background tabs may take longer for ProseMirror to process input.
   */
  function clickSendWithRetry(retriesLeft) {
    retriesLeft = retriesLeft !== undefined ? retriesLeft : SEND_RETRIES;

    return new Promise(function (resolve) {
      var result = trySend();
      if (result) {
        resolve(result);
        return;
      }

      if (retriesLeft <= 0) {
        resolve({
          success: false,
          error: "Send button not enabled after retries. Text is in the input -- press Enter to submit manually.",
        });
        return;
      }

      setTimeout(function () {
        clickSendWithRetry(retriesLeft - 1).then(resolve);
      }, SEND_RETRY_MS);
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Main: inject text and submit.
   */
  function injectAndSubmit(text) {
    return waitForElement(INPUT_SEL)
      .then(function (inputEl) {
        return injectText(inputEl, text);
      })
      .then(function () {
        return delay(SUBMIT_DELAY);
      })
      .then(function () {
        return clickSendWithRetry(SEND_RETRIES);
      })
      .catch(function (err) {
        return { success: false, error: err.message };
      });
  }

  // Listen for injection requests
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type !== MSG_TYPE) return false;

    if (!msg.text || typeof msg.text !== "string") {
      sendResponse({ success: false, error: "Invalid message: missing text" });
      return false;
    }

    injectAndSubmit(msg.text).then(function (result) {
      sendResponse(result);
    });
    return true; // async response
  });
})();
