import {
    getRequestHeaders,
    saveSettingsDebounced,
    saveChatConditional,
    chat,
    name2,
    updateMessageBlock,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { ConnectionManagerRequestService } from '../../shared.js';

const MODULE_NAME = 'sloppy_seconds';
const PLUGIN_BASE = '/api/plugins/sloppy-seconds';

// ============================================================================
// Default Settings
// ============================================================================

const defaultSettings = {
    enabled: false,
    autoRefine: true,

    // Connection
    connectionMode: 'proxy',        // 'proxy' | 'profile'
    proxyUrl: 'http://localhost:42069',
    profileId: '',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
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
    systemPrompt: '',               // Empty = default
    debugMode: false,
};

// ============================================================================
// Default System Prompt
// ============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are a prose quality editor for creative fiction. Your job is to identify and surgically fix "slop" — specific categories of bad AI-generated writing — while preserving the author's voice, style, tone, and all narrative content.

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
- Preserve paragraph structure, formatting, and all markdown exactly.
- If you discover NEW slop patterns not in the provided list, include them in newPatterns.
- When in doubt, leave it alone. False negatives are better than false positives.

## Response format (JSON only):
{
  "findings": [
    { "original": "exact substring from the text", "replacement": "improved version", "pattern": "which slop category or pattern" }
  ],
  "newPatterns": ["newly discovered pattern phrase"],
  "summary": "Brief description of changes"
}

If no slop found: { "findings": [], "newPatterns": [], "summary": "Clean." }`;

// ============================================================================
// Settings Helpers
// ============================================================================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    return extension_settings[MODULE_NAME];
}

// ============================================================================
// State
// ============================================================================

/** Currently processing message ID (null = idle) */
let processingMessageId = null;

/** Timestamp of last completed refinement (rate limiting) */
let lastProcessedTimestamp = 0;

/** Session stats */
const sessionStats = {
    messagesProcessed: 0,
    totalFindings: 0,
    totalTokens: 0,
    cleanMessages: 0,
};

/** Cached Obsidian patterns (loaded once, updated on new discoveries) */
let obsidianPatterns = [];
let obsidianPatternsLoaded = false;

// ============================================================================
// AI Connection
// ============================================================================

/**
 * Call AI via Connection Manager profile.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {number} maxTokens
 * @param {number} timeout
 * @returns {Promise<{text: string, usage: object}>}
 */
async function callViaProfile(systemPrompt, userMessage, maxTokens, timeout) {
    const settings = getSettings();
    const profileId = settings.profileId;
    if (!profileId) throw new Error('No connection profile selected.');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const result = await ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            maxTokens,
            {
                stream: false,
                signal: controller.signal,
                extractData: true,
                includePreset: false,
                includeInstruct: false,
            },
            settings.model ? { model: settings.model } : {},
        );

        return {
            text: result.content || '',
            // CMRS extractData mode doesn't expose usage; check for raw response shape
            usage: result.usage || { input_tokens: 0, output_tokens: 0 },
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Call AI via server plugin proxy (supports thinking).
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @returns {Promise<{ok: boolean, findings: Array, newPatterns: Array, summary: string, usage: object, error?: string}>}
 */
async function callViaProxy(systemPrompt, userMessage) {
    const settings = getSettings();

    const response = await fetch(`${PLUGIN_BASE}/analyze`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            proxyUrl: settings.proxyUrl,
            model: settings.model,
            systemPrompt: systemPrompt,
            userMessage: userMessage,
            maxTokens: settings.maxTokens,
            thinkingBudget: settings.thinkingBudget,
            timeout: settings.timeout,
        }),
    });

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Server returned HTTP ${response.status}: ${errBody.substring(0, 200)}`);
    }

    return await response.json();
}

/**
 * Build recent chat context from prior AI messages (for cross-message repetition detection).
 * Collects only AI messages, untruncated, walking backwards from the target.
 * @param {number} targetMessageId - The message being analyzed
 * @returns {string} Formatted chat context
 */
function buildChatContext(targetMessageId) {
    const settings = getSettings();
    const count = Math.max(1, Math.min(settings.contextAiMessages || 5, 20));

    const aiMessages = [];
    for (let i = targetMessageId - 1; i >= 0 && aiMessages.length < count; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user || msg.is_system) continue;
        aiMessages.push(`[${msg.name || name2} — message ${i}]:\n${msg.mes}`);
    }

    // Reverse so oldest is first (chronological order)
    aiMessages.reverse();
    return aiMessages.join('\n\n---\n\n');
}

/**
 * Analyze prose text for slop via the configured connection mode.
 * @param {string} proseText - The AI-generated text to analyze
 * @param {number} [messageId] - The message ID (for building chat context)
 * @returns {Promise<{findings: Array, newPatterns: Array, summary: string}>}
 */
async function analyzeText(proseText, messageId) {
    const settings = getSettings();
    const systemPrompt = settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

    // Build merged pattern list
    const allPatterns = getMergedPatterns();
    const patternList = allPatterns.map(p => `- ${p}`).join('\n');

    // Build context section
    let contextSection = '';
    if (messageId !== undefined && messageId > 0) {
        const chatContext = buildChatContext(messageId);
        if (chatContext) {
            contextSection = `## Recent Chat Context (for tone and repetition reference — do NOT analyze this, only analyze the Target Message below)\n${chatContext}\n\n`;
        }
    }

    const userMessage = `## Slop Patterns to Check\n${patternList}\n\n${contextSection}## Target Message to Evaluate\n${proseText}`;

    if (settings.connectionMode === 'profile') {
        // Profile mode — parse response client-side
        const result = await callViaProfile(systemPrompt, userMessage, settings.maxTokens, settings.timeout);

        let parsed = null;
        try {
            parsed = JSON.parse(result.text.trim());
        } catch {
            const fenceMatch = result.text.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (fenceMatch) {
                try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
            }
        }

        if (!parsed) {
            console.warn('[SloppySeconds] Profile mode returned non-JSON:', result.text.substring(0, 300));
            return { findings: [], newPatterns: [], summary: 'AI returned invalid response' };
        }

        sessionStats.totalTokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
        return {
            findings: parsed.findings || [],
            newPatterns: parsed.newPatterns || [],
            summary: parsed.summary || '',
        };
    }

    // Proxy mode — server plugin parses response
    const data = await callViaProxy(systemPrompt, userMessage);

    if (!data.ok) {
        throw new Error(data.error || 'Analysis failed');
    }

    sessionStats.totalTokens += (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
    return {
        findings: data.findings || [],
        newPatterns: data.newPatterns || [],
        summary: data.summary || '',
    };
}

// ============================================================================
// Pattern Management
// ============================================================================

/**
 * Get all slop patterns merged from: built-in defaults + custom user patterns + Obsidian vault patterns.
 * @returns {string[]}
 */
function getMergedPatterns() {
    const settings = getSettings();
    const patterns = new Set();

    // Built-in defaults
    for (const p of settings.slopPatterns) {
        if (p.trim()) patterns.add(p.trim().toLowerCase());
    }

    // Custom user patterns
    if (settings.customPatterns) {
        for (const line of settings.customPatterns.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) patterns.add(trimmed.toLowerCase());
        }
    }

    // Obsidian vault patterns
    for (const p of obsidianPatterns) {
        if (p.trim()) patterns.add(p.trim().toLowerCase());
    }

    return [...patterns];
}

/**
 * Load slop patterns from Obsidian vault.
 */
async function loadObsidianPatterns() {
    const settings = getSettings();
    if (!settings.obsidianEnabled) return;

    try {
        const response = await fetch(`${PLUGIN_BASE}/read-patterns`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
                filename: settings.patternFile,
            }),
        });

        const data = await response.json();
        if (!data.ok || !data.content) {
            obsidianPatterns = [];
            obsidianPatternsLoaded = true;
            return;
        }

        // Parse the markdown pattern list
        const lines = data.content.split('\n');
        const patterns = [];
        for (const line of lines) {
            const match = line.match(/^-\s+(.+?)(?:\s+\(discovered .+\))?$/);
            if (match) {
                patterns.push(match[1].trim().toLowerCase());
            }
        }

        obsidianPatterns = patterns;
        obsidianPatternsLoaded = true;
        if (settings.debugMode) {
            console.log(`[SloppySeconds] Loaded ${patterns.length} patterns from Obsidian`);
        }
    } catch (err) {
        console.warn('[SloppySeconds] Failed to load Obsidian patterns:', err.message);
    }
}

/**
 * Append newly discovered patterns to the Obsidian vault file.
 * @param {string[]} newPatterns
 */
async function appendObsidianPatterns(newPatterns) {
    const settings = getSettings();
    if (!settings.obsidianEnabled || newPatterns.length === 0) return;

    try {
        // Read current file
        const readResponse = await fetch(`${PLUGIN_BASE}/read-patterns`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
                filename: settings.patternFile,
            }),
        });
        const readData = await readResponse.json();

        const today = new Date().toISOString().split('T')[0];
        let content;

        if (readData.ok && readData.content) {
            // File exists — deduplicate and append
            const existingSet = new Set(
                readData.content.split('\n')
                    .map(l => l.match(/^-\s+(.+?)(?:\s+\(discovered .+\))?$/))
                    .filter(Boolean)
                    .map(m => m[1].trim().toLowerCase()),
            );
            const toAdd = newPatterns.filter(p => !existingSet.has(p.toLowerCase()));
            if (toAdd.length === 0) return;

            const newLines = toAdd.map(p => `- ${p} (discovered ${today})`).join('\n');

            if (readData.content.includes('## AI-Discovered')) {
                content = readData.content.trimEnd() + '\n' + newLines + '\n';
            } else {
                content = readData.content.trimEnd() + '\n\n## AI-Discovered\n' + newLines + '\n';
            }
        } else {
            // File doesn't exist — create it
            const builtInList = settings.slopPatterns.map(p => `- ${p}`).join('\n');
            const newLines = newPatterns.map(p => `- ${p} (discovered ${today})`).join('\n');
            content = `---\ntags:\n  - sloppy-seconds\n  - sloppy-seconds/patterns\nupdated: ${new Date().toISOString()}\n---\n# Slop Patterns\n\n## Built-in\n${builtInList}\n\n## AI-Discovered\n${newLines}\n`;
        }

        // Write back
        await fetch(`${PLUGIN_BASE}/write-patterns`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
                filename: settings.patternFile,
                content: content,
            }),
        });

        // Update local cache
        for (const p of newPatterns) {
            if (!obsidianPatterns.includes(p.toLowerCase())) {
                obsidianPatterns.push(p.toLowerCase());
            }
        }

        if (settings.debugMode) {
            console.log(`[SloppySeconds] Appended ${newPatterns.length} new patterns to Obsidian`);
        }
    } catch (err) {
        console.warn('[SloppySeconds] Failed to write Obsidian patterns:', err.message);
        toastr.warning('Failed to update Obsidian pattern list', 'SloppySeconds');
    }
}

/**
 * Seed the Obsidian pattern file with discovered patterns (from chat analysis).
 * Creates the file if it doesn't exist, preserves existing content if it does.
 */
async function seedObsidianPatterns() {
    const settings = getSettings();
    if (!settings.obsidianEnabled) {
        toastr.warning('Enable Obsidian integration first', 'SloppySeconds');
        return;
    }

    const discoveredPatterns = [
        // Structural Templates
        'the particular X of someone who Y',
        'the way X does/moves Y',
        'not X exactly, but Y',
        'something between X and Y',
        // Dead Metaphors (Pauses/Silence)
        'the silence stretched',
        'the word landed',
        'the question landed',
        'the room settled',
        'the hallway settled',
        'sat in the air',
        // Emotional Telling
        'caught it',
        'registered',
        'read the room',
        'something moved behind her eyes',
        'the body\'s delayed invoice',
        // Architecture Metaphor Overuse
        'the architecture of',
        'load-bearing',
        'two buildings by the same architect',
        // Character-Specific Tics
        'the ceremony taught her',
        'the ceremony couldn\'t reach',
        'ceremony as emotional processing',
        // Blood/Feeding Clichés
        'blood catching light like',
        'blood came away in sheets',
        // Nautical Empire Metaphor
        'the ship was righting',
        'the ship was listing',
    ];

    try {
        // Check if file already exists
        const readResponse = await fetch(`${PLUGIN_BASE}/read-patterns`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
                filename: settings.patternFile,
            }),
        });
        const readData = await readResponse.json();

        if (readData.ok && readData.content) {
            // File exists — only add patterns not already present
            const existingSet = new Set(
                readData.content.split('\n')
                    .map(l => l.match(/^-\s+(.+?)(?:\s+\(discovered .+\))?$/))
                    .filter(Boolean)
                    .map(m => m[1].trim().toLowerCase()),
            );
            const toAdd = discoveredPatterns.filter(p => !existingSet.has(p.toLowerCase()));

            if (toAdd.length === 0) {
                toastr.info('All patterns already exist in the file', 'SloppySeconds');
                return;
            }

            const today = new Date().toISOString().split('T')[0];
            const newLines = toAdd.map(p => `- ${p} (discovered ${today})`).join('\n');
            let content;

            if (readData.content.includes('## AI-Discovered')) {
                content = readData.content.trimEnd() + '\n' + newLines + '\n';
            } else {
                content = readData.content.trimEnd() + '\n\n## AI-Discovered\n' + newLines + '\n';
            }

            await fetch(`${PLUGIN_BASE}/write-patterns`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    port: settings.obsidianPort,
                    apiKey: settings.obsidianApiKey,
                    filename: settings.patternFile,
                    content: content,
                }),
            });

            toastr.success(`Added ${toAdd.length} new patterns to vault`, 'SloppySeconds');
        } else {
            // File doesn't exist — create it
            const today = new Date().toISOString().split('T')[0];
            const patternLines = discoveredPatterns.map(p => `- ${p}`).join('\n');
            const content = `---\ntags:\n  - sloppy-seconds\n  - sloppy-seconds/patterns\nupdated: ${today}\n---\n# Slop Patterns\n\n## Discovered\n${patternLines}\n`;

            await fetch(`${PLUGIN_BASE}/write-patterns`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    port: settings.obsidianPort,
                    apiKey: settings.obsidianApiKey,
                    filename: settings.patternFile,
                    content: content,
                }),
            });

            toastr.success(`Created pattern file with ${discoveredPatterns.length} patterns`, 'SloppySeconds');
        }

        // Reload patterns into cache
        obsidianPatternsLoaded = false;
        await loadObsidianPatterns();
    } catch (err) {
        toastr.error(`Failed to seed patterns: ${err.message}`, 'SloppySeconds');
    }
}

// ============================================================================
// Refinement Pipeline
// ============================================================================

/**
 * Refine a specific message by detecting and replacing slop.
 * @param {number} messageId
 */
async function refineMessage(messageId) {
    const settings = getSettings();
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    // Guard: already processing
    if (processingMessageId !== null) {
        if (settings.debugMode) console.log('[SloppySeconds] Skipped — already processing message', processingMessageId);
        return;
    }

    // Guard: rate limit (2s cooldown)
    if (Date.now() - lastProcessedTimestamp < 2000) {
        if (settings.debugMode) console.log('[SloppySeconds] Skipped — rate limited');
        return;
    }

    processingMessageId = messageId;
    const originalText = message.mes;

    try {
        // Show spinner
        showProcessingIndicator(messageId, true);

        // Load Obsidian patterns if not yet loaded
        if (settings.obsidianEnabled && !obsidianPatternsLoaded) {
            await loadObsidianPatterns();
        }

        if (settings.debugMode) {
            console.log(`[SloppySeconds] Analyzing message ${messageId} (${originalText.length} chars)`);
        }

        // Call AI
        const result = await analyzeText(originalText, messageId);
        sessionStats.messagesProcessed++;

        if (!result.findings || result.findings.length === 0) {
            // Clean message
            sessionStats.cleanMessages++;
            showProcessingIndicator(messageId, false);
            showResultBadge(messageId, 0);
            if (settings.debugMode) {
                console.log(`[SloppySeconds] Message ${messageId}: clean (${result.summary})`);
            }
            return;
        }

        // Apply replacements — locate all positions first, then apply in
        // reverse order so earlier replacements don't shift later indices.
        let text = originalText;
        let appliedCount = 0;

        const located = [];
        for (const finding of result.findings) {
            if (!finding.original || !finding.replacement) continue;
            const idx = text.indexOf(finding.original);
            if (idx !== -1) {
                located.push({ idx, finding });
            } else if (settings.debugMode) {
                console.warn(`[SloppySeconds] Finding not found in text: "${finding.original.substring(0, 50)}..."`);
            }
        }

        // Sort by position descending so replacements don't shift each other
        located.sort((a, b) => b.idx - a.idx);

        for (const { idx, finding } of located) {
            text = text.substring(0, idx) + finding.replacement + text.substring(idx + finding.original.length);
            appliedCount++;
        }

        if (appliedCount === 0) {
            // All findings missed — AI hallucinated the originals
            showProcessingIndicator(messageId, false);
            showResultBadge(messageId, 0);
            if (settings.debugMode) {
                console.warn('[SloppySeconds] All findings missed (0 applied)');
            }
            return;
        }

        // Store original for undo and update message
        message.extra = message.extra || {};
        message.extra.sloppy_seconds = {
            findings: result.findings,
            summary: result.summary,
            original: originalText,
            applied: appliedCount,
            timestamp: Date.now(),
        };

        message.mes = text;

        // Re-render using ST's standard message update
        updateMessageBlock(messageId, message);
        await saveChatConditional();

        sessionStats.totalFindings += appliedCount;

        // Update UI
        showProcessingIndicator(messageId, false);
        showResultBadge(messageId, appliedCount);

        // Append new patterns to Obsidian
        if (result.newPatterns && result.newPatterns.length > 0) {
            appendObsidianPatterns(result.newPatterns); // fire-and-forget
        }

        if (settings.debugMode) {
            console.log(`[SloppySeconds] Message ${messageId}: ${appliedCount}/${result.findings.length} fixes applied. ${result.summary}`);
        }

        toastr.success(`Fixed ${appliedCount} slop pattern${appliedCount !== 1 ? 's' : ''}`, 'SloppySeconds');
    } catch (err) {
        console.error('[SloppySeconds] Refinement error:', err);
        showProcessingIndicator(messageId, false);
        toastr.warning(`Refinement failed: ${err.message}`, 'SloppySeconds');
    } finally {
        processingMessageId = null;
        lastProcessedTimestamp = Date.now();
    }
}

/**
 * Undo the last refinement on a message.
 * @param {number} messageId
 */
async function undoRefinement(messageId) {
    const message = chat[messageId];
    if (!message?.extra?.sloppy_seconds?.original) {
        toastr.info('No refinement to undo on this message', 'SloppySeconds');
        return;
    }

    message.mes = message.extra.sloppy_seconds.original;
    delete message.extra.sloppy_seconds;

    // Re-render using ST's standard message update
    updateMessageBlock(messageId, message);

    // Remove badge
    $(`.mes[mesid="${messageId}"] .ss_result_badge`).remove();

    await saveChatConditional();
    toastr.info('Refinement undone', 'SloppySeconds');
}

// ============================================================================
// UI Indicators
// ============================================================================

/**
 * Show/hide processing spinner on a message.
 */
function showProcessingIndicator(messageId, show) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    if (show) {
        if (!mesEl.find('.ss_spinner').length) {
            mesEl.find('.mes_text').prepend('<div class="ss_spinner"><i class="fa-solid fa-spinner fa-spin"></i> Checking for slop...</div>');
        }
    } else {
        mesEl.find('.ss_spinner').remove();
    }
}

/**
 * Show a result badge on a message.
 */
function showResultBadge(messageId, fixCount) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    mesEl.find('.ss_result_badge').remove();

    if (fixCount > 0) {
        const badge = $(`<div class="ss_result_badge ss_has_fixes" title="Click to view changes">${fixCount} fix${fixCount !== 1 ? 'es' : ''}</div>`);
        mesEl.find('.mes_buttons').append(badge);
    } else {
        mesEl.find('.mes_buttons').append('<div class="ss_result_badge ss_clean" title="No slop found">clean</div>');
    }
}

/**
 * Show a popup with the findings detail for a message.
 */
function showFindingsPopup(messageId) {
    const message = chat[messageId];
    const data = message?.extra?.sloppy_seconds;
    if (!data) return;

    let html = `<h3>SloppySeconds — ${data.applied} fix${data.applied !== 1 ? 'es' : ''}</h3>`;
    html += `<p><em>${escapeHtml(data.summary)}</em></p><hr>`;

    for (const finding of data.findings) {
        html += `<div class="ss_finding">`;
        html += `<div class="ss_finding_pattern"><strong>Pattern:</strong> ${escapeHtml(finding.pattern || 'unknown')}</div>`;
        html += `<div class="ss_finding_original"><strong>Original:</strong> <del>${escapeHtml(finding.original)}</del></div>`;
        html += `<div class="ss_finding_replacement"><strong>Replacement:</strong> <ins>${escapeHtml(finding.replacement)}</ins></div>`;
        html += `</div><hr>`;
    }

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true });
}

/**
 * Inject result badges on chat load for previously refined messages.
 */
function injectBadgesOnLoad() {
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sloppy_seconds) {
            showResultBadge(i, chat[i].extra.sloppy_seconds.applied || 0);
        }
    }
}

// ============================================================================
// Settings UI
// ============================================================================

function loadSettingsUI() {
    const s = getSettings();

    $('#ss_enabled').prop('checked', s.enabled);
    $('#ss_auto_refine').prop('checked', s.autoRefine);
    $('#ss_connection_mode').val(s.connectionMode);
    $('#ss_proxy_url').val(s.proxyUrl);
    $('#ss_model').val(s.model);
    $('#ss_max_tokens').val(s.maxTokens);
    $('#ss_thinking_budget').val(s.thinkingBudget);
    $('#ss_timeout').val(s.timeout);
    $('#ss_obsidian_enabled').prop('checked', s.obsidianEnabled);
    $('#ss_obsidian_port').val(s.obsidianPort);
    $('#ss_obsidian_api_key').val(s.obsidianApiKey);
    $('#ss_pattern_file').val(s.patternFile);
    $('#ss_custom_patterns').val(s.customPatterns);
    $('#ss_context_ai_messages').val(s.contextAiMessages);
    $('#ss_system_prompt').val(s.systemPrompt);
    $('#ss_debug_mode').prop('checked', s.debugMode);

    updateConnectionVisibility();
    populateProfileDropdown();
}

function bindSettingsEvents() {
    // Checkboxes
    $('#ss_enabled').on('change', function () {
        getSettings().enabled = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#ss_auto_refine').on('change', function () {
        getSettings().autoRefine = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#ss_obsidian_enabled').on('change', function () {
        getSettings().obsidianEnabled = $(this).is(':checked');
        saveSettingsDebounced();
        obsidianPatternsLoaded = false; // Force reload
    });
    $('#ss_debug_mode').on('change', function () {
        getSettings().debugMode = $(this).is(':checked');
        saveSettingsDebounced();
    });

    // Connection mode
    $('#ss_connection_mode').on('change', function () {
        getSettings().connectionMode = $(this).val();
        saveSettingsDebounced();
        updateConnectionVisibility();
    });

    // Profile dropdown
    $('#ss_profile_select').on('change', function () {
        getSettings().profileId = $(this).val();
        saveSettingsDebounced();
    });

    // Text inputs
    const textFields = {
        '#ss_proxy_url': 'proxyUrl',
        '#ss_model': 'model',
        '#ss_obsidian_api_key': 'obsidianApiKey',
        '#ss_pattern_file': 'patternFile',
        '#ss_custom_patterns': 'customPatterns',
        '#ss_system_prompt': 'systemPrompt',
    };
    for (const [selector, key] of Object.entries(textFields)) {
        $(selector).on('input', function () {
            getSettings()[key] = $(this).val();
            saveSettingsDebounced();
        });
    }

    // Number inputs
    const numFields = {
        '#ss_max_tokens': 'maxTokens',
        '#ss_thinking_budget': 'thinkingBudget',
        '#ss_timeout': 'timeout',
        '#ss_obsidian_port': 'obsidianPort',
        '#ss_context_ai_messages': 'contextAiMessages',
    };
    for (const [selector, key] of Object.entries(numFields)) {
        $(selector).on('input', function () {
            const parsed = parseInt($(this).val(), 10);
            getSettings()[key] = isNaN(parsed) ? defaultSettings[key] : parsed;
            saveSettingsDebounced();
        });
    }

    // Test buttons
    $('#ss_test_proxy').on('click', testProxyConnection);
    $('#ss_test_obsidian').on('click', testObsidianConnection);
    $('#ss_seed_patterns').on('click', seedObsidianPatterns);

    // Analyze button
    $('#ss_analyze_btn').on('click', async function () {
        const btn = $(this);
        if (btn.hasClass('disabled')) return;

        const settings = getSettings();
        if (!settings.enabled) {
            toastr.warning('SloppySeconds is disabled', 'SloppySeconds');
            return;
        }

        // Find last AI message
        let targetId = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) { targetId = i; break; }
        }
        if (targetId < 0) {
            toastr.info('No AI message found', 'SloppySeconds');
            return;
        }

        btn.addClass('disabled');
        btn.find('span').text('Analyzing...');
        btn.find('i').removeClass('fa-magnifying-glass').addClass('fa-spinner fa-spin');

        try {
            if (settings.obsidianEnabled && !obsidianPatternsLoaded) {
                await loadObsidianPatterns();
            }

            const result = await analyzeText(chat[targetId].mes, targetId);

            if (!result.findings || result.findings.length === 0) {
                toastr.success('No slop detected — message is clean!', 'SloppySeconds');
                return;
            }

            let html = `<h3>SloppySeconds — ${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''} (detect only, not applied)</h3>`;
            html += `<p><em>${escapeHtml(result.summary)}</em></p><hr>`;

            for (const finding of result.findings) {
                html += `<div class="ss_finding">`;
                html += `<div class="ss_finding_pattern"><strong>Pattern:</strong> ${escapeHtml(finding.pattern || 'unknown')}</div>`;
                html += `<div class="ss_finding_original"><strong>Original:</strong> <del>${escapeHtml(finding.original)}</del></div>`;
                html += `<div class="ss_finding_replacement"><strong>Suggestion:</strong> <ins>${escapeHtml(finding.replacement)}</ins></div>`;
                html += `</div><hr>`;
            }

            if (result.newPatterns && result.newPatterns.length > 0) {
                html += `<h4>New patterns discovered:</h4>`;
                html += result.newPatterns.map(p => `<div>• ${escapeHtml(p)}</div>`).join('');
            }

            callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true });
        } catch (err) {
            toastr.warning(`Detection failed: ${err.message}`, 'SloppySeconds');
        } finally {
            btn.removeClass('disabled');
            btn.find('span').text('Analyze Last Message');
            btn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-magnifying-glass');
        }
    });
}

function updateConnectionVisibility() {
    const settings = getSettings();
    const isProfile = settings.connectionMode === 'profile';
    $('#ss_profile_row').toggle(isProfile);
    $('#ss_proxy_row').toggle(!isProfile);
    $('#ss_thinking_row').toggle(!isProfile); // Thinking only available in proxy mode
}

function populateProfileDropdown() {
    const select = document.getElementById('ss_profile_select');
    if (!select) return;

    const settings = getSettings();
    const currentId = settings.profileId;

    select.innerHTML = '<option value="">— Select a profile —</option>';
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            if (p.id === currentId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Connection Manager not available';
        opt.disabled = true;
        select.appendChild(opt);
    }
}

async function testProxyConnection() {
    const settings = getSettings();
    const statusEl = $('#ss_proxy_status');
    statusEl.text('Testing...').css('color', '');

    try {
        const response = await fetch(`${PLUGIN_BASE}/test`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                proxyUrl: settings.proxyUrl,
                model: settings.model,
            }),
        });

        if (!response.ok) {
            statusEl.text(`Server plugin not loaded (HTTP ${response.status}). Restart SillyTavern.`).css('color', '#f44336');
            return;
        }

        const data = await response.json();
        if (data.ok) {
            statusEl.text('Connected!').css('color', '#4caf50');
        } else {
            statusEl.text(`Failed: ${data.error}`).css('color', '#f44336');
        }
    } catch (err) {
        statusEl.text(`Error: ${err.message}`).css('color', '#f44336');
    }
}

async function testObsidianConnection() {
    const settings = getSettings();
    const statusEl = $('#ss_obsidian_status');
    statusEl.text('Testing...').css('color', '');

    try {
        const response = await fetch(`${PLUGIN_BASE}/obsidian-test`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
            }),
        });

        if (!response.ok) {
            statusEl.text(`Server plugin not loaded (HTTP ${response.status}). Restart SillyTavern.`).css('color', '#f44336');
            return;
        }

        const data = await response.json();
        if (data.ok) {
            statusEl.text(data.authenticated ? 'Connected & authenticated!' : 'Connected (not authenticated)').css('color', '#4caf50');
        } else {
            statusEl.text(`Failed: ${data.error}`).css('color', '#f44336');
        }
    } catch (err) {
        statusEl.text(`Error: ${err.message}`).css('color', '#f44336');
    }
}

// ============================================================================
// Slash Commands
// ============================================================================

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-refine',
        callback: async () => {
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('SloppySeconds is disabled', 'SloppySeconds');
                return '';
            }
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) {
                    await refineMessage(i);
                    return `Refined message ${i}`;
                }
            }
            toastr.info('No AI message found to refine', 'SloppySeconds');
            return '';
        },
        helpString: 'Manually trigger slop detection and refinement on the last AI message.',
        returns: 'Refinement result',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-detect',
        callback: async () => {
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('SloppySeconds is disabled', 'SloppySeconds');
                return '';
            }
            // Find last AI message
            let targetId = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) { targetId = i; break; }
            }
            if (targetId < 0) {
                toastr.info('No AI message found', 'SloppySeconds');
                return '';
            }

            toastr.info('Analyzing for slop...', 'SloppySeconds');

            // Load Obsidian patterns if needed
            if (settings.obsidianEnabled && !obsidianPatternsLoaded) {
                await loadObsidianPatterns();
            }

            try {
                const result = await analyzeText(chat[targetId].mes, targetId);

                if (!result.findings || result.findings.length === 0) {
                    toastr.success('No slop detected — message is clean!', 'SloppySeconds');
                    return 'Clean';
                }

                let html = `<h3>SloppySeconds — ${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''} (detect only, not applied)</h3>`;
                html += `<p><em>${escapeHtml(result.summary)}</em></p><hr>`;

                for (const finding of result.findings) {
                    html += `<div class="ss_finding">`;
                    html += `<div class="ss_finding_pattern"><strong>Pattern:</strong> ${escapeHtml(finding.pattern || 'unknown')}</div>`;
                    html += `<div class="ss_finding_original"><strong>Original:</strong> <del>${escapeHtml(finding.original)}</del></div>`;
                    html += `<div class="ss_finding_replacement"><strong>Suggestion:</strong> <ins>${escapeHtml(finding.replacement)}</ins></div>`;
                    html += `</div><hr>`;
                }

                if (result.newPatterns && result.newPatterns.length > 0) {
                    html += `<h4>New patterns discovered:</h4>`;
                    html += result.newPatterns.map(p => `<div>• ${escapeHtml(p)}</div>`).join('');
                }

                callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true });
                return `Detected ${result.findings.length} findings`;
            } catch (err) {
                toastr.warning(`Detection failed: ${err.message}`, 'SloppySeconds');
                return '';
            }
        },
        helpString: 'Detect slop in the last AI message without applying changes. Shows findings in a popup.',
        returns: 'Detection result',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-undo',
        callback: async () => {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i]?.extra?.sloppy_seconds?.original) {
                    await undoRefinement(i);
                    return `Undid refinement on message ${i}`;
                }
            }
            toastr.info('No refined message found to undo', 'SloppySeconds');
            return '';
        },
        helpString: 'Undo the last SloppySeconds refinement, restoring the original text.',
        returns: 'Undo result',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-status',
        callback: async () => {
            const allPatterns = getMergedPatterns();
            const html = `
                <h3>SloppySeconds — Session Stats</h3>
                <table>
                    <tr><td><strong>Messages processed:</strong></td><td>${sessionStats.messagesProcessed}</td></tr>
                    <tr><td><strong>Clean messages:</strong></td><td>${sessionStats.cleanMessages}</td></tr>
                    <tr><td><strong>Total fixes applied:</strong></td><td>${sessionStats.totalFindings}</td></tr>
                    <tr><td><strong>Tokens used:</strong></td><td>${sessionStats.totalTokens.toLocaleString()}</td></tr>
                    <tr><td><strong>Active patterns:</strong></td><td>${allPatterns.length}</td></tr>
                    <tr><td><strong>Obsidian patterns:</strong></td><td>${obsidianPatterns.length}</td></tr>
                </table>
            `;
            callGenericPopup(html, POPUP_TYPE.TEXT);
            return 'Displayed stats';
        },
        helpString: 'Show SloppySeconds session statistics.',
        returns: 'Stats popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-patterns',
        callback: async () => {
            const allPatterns = getMergedPatterns();
            const html = `
                <h3>SloppySeconds — Active Patterns (${allPatterns.length})</h3>
                <div style="max-height: 400px; overflow-y: auto; font-size: 0.9em;">
                    ${allPatterns.map(p => `<div style="padding: 2px 0;">• ${escapeHtml(p)}</div>`).join('')}
                </div>
            `;
            callGenericPopup(html, POPUP_TYPE.TEXT);
            return 'Displayed patterns';
        },
        helpString: 'Show all active slop patterns (built-in + custom + AI-discovered).',
        returns: 'Patterns popup',
    }));
}

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-SloppySeconds',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        loadSettingsUI();
        bindSettingsEvents();
        registerSlashCommands();

        // Post-generation hook: auto-refine
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
            const settings = getSettings();
            if (!settings.enabled || !settings.autoRefine) return;
            if (processingMessageId !== null) return;

            const message = chat[messageId];
            if (!message || message.is_user) return;
            if (message.extra?.sloppy_seconds) return; // Already refined

            await refineMessage(messageId);
        });

        // Re-inject badges on chat load
        eventSource.on(event_types.CHAT_CHANGED, () => {
            obsidianPatternsLoaded = false; // Reload patterns on chat change
            setTimeout(injectBadgesOnLoad, 100);
        });

        // Click handler for result badges (event delegation)
        $(document).on('click', '.ss_result_badge.ss_has_fixes', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            if (messageId !== undefined) showFindingsPopup(parseInt(messageId, 10));
        });

        console.log('[SloppySeconds] Client extension initialized');
    } catch (err) {
        console.error('[SloppySeconds] Initialization failed:', err);
    }
});
