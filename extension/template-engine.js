/**
 * template-engine.js -- Lightweight template renderer
 * Context: Shared (used by popup.js and debug.js)
 * Design: Replaces {{placeholders}} and handles {{#if field}}...{{/if}}
 *         conditionals. No dependencies. Operates on plain strings.
 */

var TemplateEngine = (function () {
  "use strict";

  /**
   * Render a template string with the given data object.
   *
   * Supported syntax:
   *   {{key}}              -- replaced with data[key], or "" if missing
   *   {{#if key}}...{{/if}} -- block included only if data[key] is truthy
   *
   * @param {string} template - The template string
   * @param {Object} data - Key-value pairs for substitution
   * @returns {string} Rendered output
   */
  function render(template, data) {
    if (!template) return "";
    data = data || {};

    // Process conditionals: {{#if key}}content{{/if}}
    var result = template.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      function (match, key, content) {
        return data[key] ? content : "";
      }
    );

    // Replace placeholders: {{key}}
    result = result.replace(
      /\{\{(\w+)\}\}/g,
      function (match, key) {
        return data[key] !== undefined && data[key] !== null ? data[key] : "";
      }
    );

    // Clean up multiple consecutive blank lines (from removed conditionals)
    result = result.replace(/\n{3,}/g, "\n\n");

    return result.trim();
  }

  /**
   * Build the full message from scraped data using templates from config.
   *
   * @param {Object} skill - Skill object with .prefix
   * @param {Object} scraped - Scraped page data
   * @param {string} promptTemplate - The main prompt template
   * @param {string} wrongChoiceTemplate - Template for wrong choice addendum
   * @returns {string} The complete message to paste into Claude
   */
  function buildMessage(skill, scraped, promptTemplate, wrongChoiceTemplate, addonSettings) {
    addonSettings = addonSettings || {};
    // Build the answer choices text
    var allAnswers = "";
    var includeExpl = addonSettings.includeChoiceExplanations && addonSettings.allChoices;
    var answerKeys = Object.keys(scraped.answers || {});
    if (answerKeys.length > 0) {
      allAnswers = answerKeys.map(function (letter) {
        var a = scraped.answers[letter];
        var marker = a.isCorrect ? " (CORRECT)" : "";
        var line = letter + ". " + a.text + marker;
        if (includeExpl && a.explanation) {
          line += "\n   Explanation: " + a.explanation;
        }
        return line;
      }).join("\n");
    }

    // Build the correct answer text
    var correctAnswer = "";
    if (scraped.correctAnswer) {
      correctAnswer = scraped.correctAnswer.letter + ". " + scraped.correctAnswer.text;
    }

    // Build the wrong choice section (only if toggle is on)
    var wrongChoiceSection = "";
    if (addonSettings.wrongChoice && scraped.userWrongChoice && wrongChoiceTemplate) {
      wrongChoiceSection = render(wrongChoiceTemplate, {
        wrongChoice: scraped.userWrongChoice.letter + ". " + scraped.userWrongChoice.text,
        wrongExplanation: scraped.userWrongChoice.explanation || "",
      });
    }

    // Build prompt addons based on toggle settings
    var addons = [];
    var C = typeof CONFIG !== "undefined" ? CONFIG : {};
    if (addonSettings.stemClues) {
      addons.push(C.PROMPT_ADDON_STEM_CLUES || "");
    }
    if (addonSettings.allChoices) {
      addons.push(C.PROMPT_ADDON_ALL_CHOICES_ANALYSIS || "");
    }
    var promptAddons = addons.join("\n\n");

    // Render the main template
    return render(promptTemplate, {
      skillPrefix: skill.prefix,
      questionNum: scraped.questionNum || "",
      question: scraped.question || "",
      attendingTip: scraped.attendingTip || "",
      promptAddons: promptAddons,
      correctAnswer: correctAnswer,
      explanation: scraped.explanation || "",
      allAnswers: allAnswers,
      wrongChoiceSection: wrongChoiceSection,
    });
  }

  /**
   * Load addon toggle settings from chrome.storage.local.
   * Returns defaults if storage is unavailable.
   */
  function loadAddonSettings(callback) {
    var C = typeof CONFIG !== "undefined" ? CONFIG : {};
    var keys = [
      C.STORAGE_KEY_ADDON_STEM_CLUES || "addonStemClues",
      C.STORAGE_KEY_ADDON_WRONG_CHOICE || "addonWrongChoice",
      C.STORAGE_KEY_ADDON_ALL_CHOICES || "addonAllChoices",
      C.STORAGE_KEY_INCLUDE_CHOICE_EXPLANATIONS || "includeChoiceExplanations",
    ];
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.get(keys, function (result) {
        callback({
          stemClues: result[keys[0]] !== undefined ? result[keys[0]] : (C.DEFAULT_ADDON_STEM_CLUES !== undefined ? C.DEFAULT_ADDON_STEM_CLUES : true),
          wrongChoice: result[keys[1]] !== undefined ? result[keys[1]] : (C.DEFAULT_ADDON_WRONG_CHOICE !== undefined ? C.DEFAULT_ADDON_WRONG_CHOICE : true),
          allChoices: result[keys[2]] !== undefined ? result[keys[2]] : (C.DEFAULT_ADDON_ALL_CHOICES !== undefined ? C.DEFAULT_ADDON_ALL_CHOICES : false),
          includeChoiceExplanations: result[keys[3]] !== undefined ? result[keys[3]] : (C.DEFAULT_INCLUDE_CHOICE_EXPLANATIONS !== undefined ? C.DEFAULT_INCLUDE_CHOICE_EXPLANATIONS : false),
        });
      });
    } else {
      callback({
        stemClues: C.DEFAULT_ADDON_STEM_CLUES !== undefined ? C.DEFAULT_ADDON_STEM_CLUES : true,
        wrongChoice: C.DEFAULT_ADDON_WRONG_CHOICE !== undefined ? C.DEFAULT_ADDON_WRONG_CHOICE : true,
        allChoices: C.DEFAULT_ADDON_ALL_CHOICES !== undefined ? C.DEFAULT_ADDON_ALL_CHOICES : false,
        includeChoiceExplanations: C.DEFAULT_INCLUDE_CHOICE_EXPLANATIONS !== undefined ? C.DEFAULT_INCLUDE_CHOICE_EXPLANATIONS : false,
      });
    }
  }

  return {
    render: render,
    buildMessage: buildMessage,
    loadAddonSettings: loadAddonSettings,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TemplateEngine;
}
