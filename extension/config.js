/**
 * config.js -- Centralized constants and configuration
 * Context: Shared (imported by popup, content scripts, debug page)
 * Design: All tunable values, string keys, and selectors live here.
 */

var CONFIG = CONFIG || {
  // ── Extension metadata ──
  VERSION: "2.0.0",

  // ── Claude.ai ──
  CLAUDE_NEW_CHAT_URL: "https://claude.ai/new",
  CLAUDE_INPUT_SELECTOR: '[contenteditable="true"]',
  CLAUDE_SEND_BUTTON_SELECTOR: 'button[aria-label="Send message"]',
  CLAUDE_SEND_BUTTON_FALLBACK_SELECTOR: 'button[type="submit"]',
  CLAUDE_INJECT_DELAY_MS: 1500,
  CLAUDE_SUBMIT_DELAY_MS: 300,

  // ── AMBOSS ──
  AMBOSS_URL_PATTERN: /next\.amboss\.com\/([a-z]{2})\/(?:questions|review)\/([^/]+)\/(\d+)/,
  AMBOSS_QUESTION_SELECTOR: "article",
  AMBOSS_ANSWER_SELECTOR_PREFIX: '[data-e2e-test-id="answer-',
  AMBOSS_ANSWER_CONTENT_SELECTOR: '[class*="answerContent"] p',
  AMBOSS_CORRECT_MARKER_SELECTOR: '[data-e2e-test-id*="Correct"]',
  AMBOSS_EXPLANATION_CONTAINER_SELECTOR: '[class*="correctAnswerExplanation"][data-e2e-test-id="answerExplanation"]',
  AMBOSS_EXPLANATION_CONTAINER_FALLBACK_SELECTOR: '[data-e2e-test-id="answerExplanation"]',
  AMBOSS_EXPLANATION_CONTENT_SELECTOR: '[class*="explanationContent"]',
  AMBOSS_HINT_SELECTOR: 'article[class*="hintText"]',
  AMBOSS_HINT_FALLBACK_SELECTOR: '[class*="extraExplanationText"]',
  AMBOSS_USER_WRONG_CHOICE_SELECTOR: '[data-e2e-test-id="answer-theme-userFirstAttemptIncorrect"]',
  AMBOSS_WRONG_CHOICE_EXPLANATION_SELECTOR: '[class*="incorrectFirstExplanation"]',
  AMBOSS_ANSWER_LETTERS: ["a", "b", "c", "d", "e", "f"],

  // ── Skills (slash command prefixes for claude.ai) ──
  SKILLS: [
    { id: "causal-explainer-brief-v2", label: "Causal Explainer (text + diagram)", prefix: "/causal-explainer-brief-v2 " },
    { id: "usmle-flowchart", label: "USMLE Flowchart (diagram only)", prefix: "/usmle-flowchart " },
  ],

  // ── Prompt template ──
  // Users can customize how scraped content is structured before sending.
  // Available placeholders: {{question}}, {{questionNum}}, {{attendingTip}},
  // {{correctAnswer}}, {{explanation}}, {{allAnswers}}, {{wrongChoiceSection}},
  // {{skillPrefix}}
  // Sections wrapped in {{#if field}}...{{/if}} are omitted when that field is empty.
  PROMPT_TEMPLATE: [
    "{{skillPrefix}}",
    "Question {{questionNum}}:",
    "{{question}}",
    "{{#if attendingTip}}",
    "Attending Tip:",
    "{{attendingTip}}",
    "{{/if}}",
    "{{#if correctAnswer}}",
    "Correct Answer: {{correctAnswer}}",
    "{{/if}}",
    "{{#if explanation}}",
    "Explanation:",
    "{{explanation}}",
    "{{/if}}",
    "{{#if allAnswers}}",
    "All Answer Choices:",
    "{{allAnswers}}",
    "{{/if}}",
    "{{#if wrongChoiceSection}}",
    "",
    "{{wrongChoiceSection}}",
    "{{/if}}",
  ].join("\n"),

  // Template for the wrong-choice addendum (used when user got it wrong)
  WRONG_CHOICE_TEMPLATE: "Also make a separate output/diagram for what this other choice is and why it's wrong: {{wrongChoice}}{{#if wrongExplanation}} and here's the official explanation of what it is/why it's wrong so you include that in your diagram/output as well: {{wrongExplanation}}{{/if}}",

  // ── Storage keys ──
  STORAGE_KEY_SELECTED_SKILL: "selectedSkill",
  STORAGE_KEY_OPEN_IN_BACKGROUND: "openInBackground",
  STORAGE_KEY_AUTO_GENERATE: "autoGenerate",
  STORAGE_KEY_AUTO_GENERATE_SKILL: "autoGenerateSkill",
  STORAGE_KEY_EXPANSION_LAYOUT: "expansionLayout",
  STORAGE_KEY_COOLDOWN_MS: "cooldownMs",
  STORAGE_KEY_PROMPT_TEMPLATE: "promptTemplate",
  STORAGE_KEY_WRONG_CHOICE_TEMPLATE: "wrongChoiceTemplate",

  // ── Defaults ──
  DEFAULT_SKILL_ID: "causal-explainer-brief-v2",
  DEFAULT_OPEN_IN_BACKGROUND: false,
  DEFAULT_AUTO_GENERATE: false,
  DEFAULT_AUTO_GENERATE_SKILL: "causal-explainer-brief-v2",

  // ── AMBOSS answer detection ──
  AMBOSS_UNANSWERED_SELECTOR: '[data-e2e-test-id="answer-theme-unanswered"]',
  AMBOSS_ANSWERED_SELECTOR: '[data-e2e-test-id*="Correct"], [data-e2e-test-id="answer-theme-answerOptionIncorrect"]',

  // ── Timing ──
  POPUP_AUTO_CLOSE_DELAY_MS: 1200,
  CLAUDE_WAIT_FOR_ELEMENT_TIMEOUT_MS: 15000,
  CLAUDE_WAIT_FOR_ELEMENT_INTERVAL_MS: 200,
  CLAUDE_SEND_RETRY_ATTEMPTS: 10,
  CLAUDE_SEND_RETRY_INTERVAL_MS: 500,
  TAB_LOAD_TIMEOUT_MS: 30000,

  // ── Rate limiting / queue ──
  MAX_CONCURRENT_REQUESTS: 3,
  QUEUE_COOLDOWN_MS: 330000, // 5.5 minutes -- wait after hitting the limit before sending next batch
  QUEUE_DRAIN_INTERVAL_MS: 5000, // check queue every 5 seconds

  // ── Tab expansion ──
  EXPANSION_INITIAL_WAIT_MS: 3000, // initial wait after tab reports "complete"
  EXPANSION_SCRAPE_RETRY_INTERVAL_MS: 2000, // retry scrape every 2s if content not ready
  EXPANSION_SCRAPE_MAX_RETRIES: 10, // max retries (total ~23s wait)
  EXPANSION_OVERHEAD_PER_QUESTION_MS: 15000, // ~15s overhead per question for time estimate
  EXPANSION_LAYOUT_INTERLEAVED: "interleaved",
  EXPANSION_LAYOUT_SEPARATE: "separate",

  // ── Message types ──
  MSG_SCRAPE_PAGE: "scrape-amboss-page",
  MSG_INJECT_AND_SUBMIT: "inject-and-submit",
  MSG_OPEN_AND_INJECT: "open-claude-and-inject",
  MSG_GET_QUEUE_STATUS: "get-queue-status",
  MSG_START_EXPANSION: "start-tab-expansion",
  MSG_GET_EXPANSION_STATUS: "get-expansion-status",
  MSG_STOP_EXPANSION: "stop-expansion",
  MSG_AUTO_GENERATE_TRIGGERED: "auto-generate-triggered",

  // ── Storage keys (queue) ──
  STORAGE_KEY_SEND_TIMESTAMPS: "sendTimestamps",
};

// Make available in both module and script contexts
if (typeof module !== "undefined" && module.exports) {
  module.exports = CONFIG;
}
