// ============================================================================
// AI Connection & Analysis
// ============================================================================

import { chat, name2 } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { getSettings, DEFAULT_SYSTEM_PROMPT } from '../settings.js';
import { sessionStats } from './state.js';
import { callViaCorsBridge } from './proxy-api.js';
import { getMergedPatterns } from './patterns.js';

/**
 * Call AI via Connection Manager profile.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {number} maxTokens
 * @param {number} timeout
 * @returns {Promise<{text: string, usage: object}>}
 */
export async function callViaProfile(systemPrompt, userMessage, maxTokens, timeout) {
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
        // Don't override model in profile mode — let the profile's configured model be used.
        // Only send reasoning overrides for OpenAI-compatible backends.
        const overrides = {};
        if (settings.thinkingBudget > 0) {
            try {
                const profile = ConnectionManagerRequestService.getProfile(profileId);
                const api = profile?.api?.toLowerCase() || '';
                if (api.includes('openai') || api.includes('openrouter') || api.includes('makersuite')) {
                    overrides.include_reasoning = true;
                    overrides.reasoning_effort = 'high';
                }
            } catch { /* profile lookup failed — skip overrides */ }
        }

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
            overrides,
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
 * Call AI via CORS proxy (supports thinking). Parses AI JSON response client-side.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @returns {Promise<{ok: boolean, findings: Array, newPatterns: Array, summary: string, usage: object}>}
 */
export async function callViaProxy(systemPrompt, userMessage) {
    const settings = getSettings();

    const { text, usage } = await callViaCorsBridge(
        settings.proxyUrl,
        settings.model,
        systemPrompt,
        userMessage,
        settings.maxTokens,
        settings.thinkingBudget,
        settings.timeout,
    );

    // Parse AI response JSON
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
        }
        // M8: Include truncated response text for debugging
        if (!parsed) throw new Error(`AI returned non-JSON response: ${text.substring(0, 120)}`);
    }

    return {
        ok: true,
        findings: parsed.findings || [],
        newPatterns: parsed.newPatterns || [],
        summary: parsed.summary || '',
        usage,
    };
}

/**
 * Build recent chat context from prior AI messages (for cross-message repetition detection).
 * Collects only AI messages, untruncated, walking backwards from the target.
 * @param {number} targetMessageId - The message being analyzed
 * @returns {string} Formatted chat context
 */
export function buildChatContext(targetMessageId) {
    if (targetMessageId < 1) return ''; // L3: No context for first or negative message
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
export async function analyzeText(proseText, messageId) {
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

    // Feature 10: Inform AI about disabled categories
    let categoryNote = '';
    if (settings.enabledCategories) {
        const disabled = Object.entries(settings.enabledCategories)
            .filter(([, enabled]) => !enabled)
            .map(([cat]) => cat);
        if (disabled.length > 0) {
            categoryNote = `\n\n## Disabled Categories (DO NOT flag these)\n${disabled.join(', ')}\n`;
        }
    }

    const userMessage = `## Slop Patterns to Check\n${patternList}${categoryNote}\n\n${contextSection}## Target Message to Evaluate\n${proseText}`;

    if (settings.connectionMode === 'profile') {
        // Profile mode — parse response client-side
        const result = await callViaProfile(systemPrompt, userMessage, settings.maxTokens, settings.timeout);

        // H4: Accumulate tokens before parse validation so failures still count
        const profileIn = result.usage?.input_tokens || 0;
        const profileOut = result.usage?.output_tokens || 0;
        sessionStats.totalTokens += profileIn + profileOut;
        sessionStats.inputTokens += profileIn;
        sessionStats.outputTokens += profileOut;

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
            toastr.warning('AI returned non-JSON response (profile mode). Check model compatibility.', 'SloppySeconds');
            return { findings: [], newPatterns: [], summary: 'AI returned invalid response' };
        }
        return {
            findings: parsed.findings || [],
            newPatterns: parsed.newPatterns || [],
            summary: parsed.summary || '',
        };
    }

    // Proxy mode — CORS bridge + client-side JSON parsing
    const data = await callViaProxy(systemPrompt, userMessage);

    const proxyIn = data.usage?.input_tokens || 0;
    const proxyOut = data.usage?.output_tokens || 0;
    sessionStats.totalTokens += proxyIn + proxyOut;
    sessionStats.inputTokens += proxyIn;
    sessionStats.outputTokens += proxyOut;
    return {
        findings: data.findings || [],
        newPatterns: data.newPatterns || [],
        summary: data.summary || '',
    };
}
