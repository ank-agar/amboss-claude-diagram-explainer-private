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
  function buildMessage(skill, scraped, promptTemplate, wrongChoiceTemplate) {
    // Build the answer choices text
    var allAnswers = "";
    var answerKeys = Object.keys(scraped.answers || {});
    if (answerKeys.length > 0) {
      allAnswers = answerKeys.map(function (letter) {
        var a = scraped.answers[letter];
        var marker = a.isCorrect ? " (CORRECT)" : "";
        return letter + ". " + a.text + marker;
      }).join("\n");
    }

    // Build the correct answer text
    var correctAnswer = "";
    if (scraped.correctAnswer) {
      correctAnswer = scraped.correctAnswer.letter + ". " + scraped.correctAnswer.text;
    }

    // Build the wrong choice section
    var wrongChoiceSection = "";
    if (scraped.userWrongChoice && wrongChoiceTemplate) {
      wrongChoiceSection = render(wrongChoiceTemplate, {
        wrongChoice: scraped.userWrongChoice.letter + ". " + scraped.userWrongChoice.text,
        wrongExplanation: scraped.userWrongChoice.explanation || "",
      });
    }

    // Render the main template
    return render(promptTemplate, {
      skillPrefix: skill.prefix,
      question: scraped.question || "",
      attendingTip: scraped.attendingTip || "",
      correctAnswer: correctAnswer,
      explanation: scraped.explanation || "",
      allAnswers: allAnswers,
      wrongChoiceSection: wrongChoiceSection,
    });
  }

  return {
    render: render,
    buildMessage: buildMessage,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TemplateEngine;
}
