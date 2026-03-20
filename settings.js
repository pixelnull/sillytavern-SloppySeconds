import { extension_settings } from '../../../extensions.js';

export const MODULE_NAME = 'sloppy_seconds';

export const SETTINGS_VERSION = 2; // Bump when adding new default slopPatterns

export const defaultSettings = {
    settingsVersion: SETTINGS_VERSION,
    enabled: false,
    autoRefine: true,

    // Connection
    connectionMode: 'proxy',        // 'proxy' | 'profile'
    proxyUrl: 'http://localhost:42069',
    profileId: '',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 16384,
    thinkingBudget: 10000,
    timeout: 60000,

    // Obsidian
    obsidianEnabled: false,
    obsidianPort: 27123,
    obsidianApiKey: '',
    patternFile: 'SloppySeconds/Slop Patterns.md',

    // Patterns
    slopPatterns: [
        'a testament to',
        'the silence stretched',
        'a dance of',
        'eyes that held',
        'the weight of',
        'sending shivers',
        'a symphony of',
        'the air crackled',
        'pupils blown wide',
        'ministrations',
        'orbs',
        'delicate fingers',
        'lithe form',
        'couldn\'t help but',
        'found herself',
        'found himself',
        'a wave of',
        'something akin to',
    ],
    customPatterns: '',             // Newline-separated textarea

    // Behavior
    contextAiMessages: 5,           // Number of prior AI messages to include as context (1-20)
    showCleanBadges: true,          // Show "clean" badges on messages with no slop
    systemPrompt: '',               // Empty = default
    debugMode: false,

    // Confidence
    autoApplyThreshold: 0.7,        // Findings below this confidence are shown but not auto-applied (0.0-1.0)

    // Pattern Categories (all enabled by default)
    enabledCategories: {
        'cliche': true,
        'purple-prose': true,
        'hedging': true,
        'repetition': true,
        'cross-message': true,
        'tell-not-show': true,
        'ai-signature': true,
    },

    // Group Chat
    refineGroupMessages: 'all',     // 'all' | 'none' — whether to refine in group chats
};

export const DEFAULT_SYSTEM_PROMPT = `You are a prose quality editor for creative fiction. Your job is to identify and surgically fix "slop" — specific categories of bad AI-generated writing — while preserving the author's voice, style, tone, and all narrative content.

## What is "slop"?

Slop is machine-generated prose that sounds generic, repetitive, or artificially dramatic. It falls into these categories:

**1. Dead metaphors & cliches** — Phrases so overused they've lost all meaning:
"a testament to", "a dance of", "a symphony of", "the weight of [abstract noun]", "the air crackled with", "silence stretched between them", "sending shivers down", "eyes that held [emotion]", "the world seemed to [verb]"

**2. Purple prose & melodrama** — Overwrought descriptions that add noise, not meaning:
"pupils blown wide", "breath hitched", "ministrations", "delicate fingers", "lithe form", "orbs" (for eyes), "tresses" (for hair), "alabaster skin", "the room seemed to hold its breath"

**3. Filler & hedging** — Words that dilute instead of describe:
"seemed to", "appeared to", "couldn't help but", "found herself [verb]ing", "a sense of", "something akin to", "it was as if", "in a way that was almost"

**4. Echo/repetition** — The same word, phrase structure, or sentence pattern used multiple times in close proximity. Especially: starting consecutive sentences the same way, repeating a character's name excessively, or recycling the same descriptor.

**5. Cross-message repetition** — Phrases, constructions, or metaphor vehicles repeated across multiple AI messages. You will receive prior AI messages as context — compare them against the target message. Flag any phrase or structural pattern that appears in BOTH the context messages AND the target. This is the most important category because it reveals the AI's habitual tics.

**6. Tell-not-show emotional labels** — Naming the emotion instead of showing it:
"she felt a surge of anger", "fear gripped him", "a wave of sadness washed over", "determination filled her eyes"

**7. AI-signature constructions** — Patterns that specifically mark text as AI-generated:
"[noun] that spoke of [abstract]", "[action], [emotion] evident in every [noun]", "the [noun] hung heavy", "[verb]ing with an intensity that..."

You will receive a prose passage, a list of known slop patterns, and recent AI messages as context for cross-message comparison.

## Rules
- Only flag text that genuinely degrades the prose. Not every metaphor is bad — flag the DEAD ones.
- Minimal intervention. Fix the bad phrase, keep everything around it. Do NOT rephrase sentences that are merely "okay."
- Replacements should match the tone and register of the surrounding text. Don't inject a literary style into casual dialogue, or vice versa.
- **Dialogue vs. narrative awareness:** Distinguish between dialogue (text in quotes) and narrative prose. Apply lighter standards to dialogue — hedging, colloquialisms, repetition, and informal patterns are natural in speech. Focus refinement on narrative prose and action descriptions.
- **Intentional rhetoric:** Anaphora (deliberate repeated line starts), epistrophe (deliberate repeated line ends), and character-specific catchphrases are intentional rhetoric — do NOT flag these. Only flag repetition that appears accidental, lazy, or habitual.
- Preserve paragraph structure, formatting, and all markdown exactly.
- If you discover NEW slop patterns not in the provided list, include them in newPatterns.
- When in doubt, leave it alone. False negatives are better than false positives.

## Response format (JSON only):
{
  "findings": [
    {
      "original": "exact substring from the text",
      "replacement": "improved version",
      "pattern": "which slop category or pattern",
      "explanation": "1-sentence craft reason why this is slop and why the replacement is better",
      "confidence": 0.95
    }
  ],
  "newPatterns": ["newly discovered pattern phrase"],
  "summary": "Brief description of changes"
}

For each finding:
- **explanation**: Brief (1 sentence) writing craft reason why this is slop. Helps the user learn. Example: "Dead metaphor — 'the weight of' has lost all meaning through overuse."
- **confidence**: 0.0-1.0 how certain you are this is slop vs. intentional style. 1.0 = definitely slop. 0.5 = ambiguous, might be intentional. Use lower confidence for dialogue, character voice, and context-dependent patterns.

If no slop found: { "findings": [], "newPatterns": [], "summary": "Clean." }`;

/**
 * Get extension settings, initializing defaults if needed.
 * @returns {object}
 */
export function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = value;
        }
    }
    // B8: Guard against corrupted slopPatterns (non-array from manual settings edit)
    if (!Array.isArray(s.slopPatterns)) {
        s.slopPatterns = [...defaultSettings.slopPatterns];
    }
    // Migrate: merge new default patterns added in newer versions
    if ((s.settingsVersion || 0) < SETTINGS_VERSION) {
        const existing = new Set(s.slopPatterns.map(p => typeof p === 'string' ? p.toLowerCase() : ''));
        for (const p of defaultSettings.slopPatterns) {
            if (!existing.has(p.toLowerCase())) {
                s.slopPatterns.push(p);
            }
        }
        s.settingsVersion = SETTINGS_VERSION;
    }
    return s;
}
