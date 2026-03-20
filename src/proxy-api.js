// ============================================================================
// Client-Side CORS Proxy AI Caller
// ============================================================================

/**
 * Call an AI proxy through ST's built-in CORS proxy at /proxy/:url(*).
 * Requires enableCorsProxy: true in config.yaml.
 * @param {string} proxyUrl - The AI proxy base URL (e.g. http://localhost:42069)
 * @param {string} model
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {number} maxTokens
 * @param {number} [thinkingBudget=0]
 * @param {number} [timeout=60000]
 * @returns {Promise<{text: string, usage: object}>}
 */
export async function callViaCorsBridge(proxyUrl, model, systemPrompt, userMessage, maxTokens, thinkingBudget = 0, timeout = 60000) {
    const targetUrl = `${proxyUrl.replace(/\/+$/, '')}/v1/messages`;
    // Encode FULL URL to prevent Express collapsing :// to :/
    const corsUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    // Anthropic requires max_tokens > budget_tokens when thinking is enabled
    if (thinkingBudget > 0 && maxTokens <= thinkingBudget) {
        maxTokens = thinkingBudget + 4096;
    }

    const body = {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [{ role: 'user', content: userMessage }],
    };
    if (thinkingBudget > 0) {
        body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(corsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2024-10-22' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 404 && errorText.includes('CORS proxy is disabled')) {
                throw new Error('ST CORS proxy is disabled. Set enableCorsProxy: true in config.yaml and restart ST.');
            }
            throw new Error(`Proxy returned HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        }

        const parsed = await response.json();
        if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));

        // H5: Explicit check for missing content before parsing
        if (!parsed.content) {
            throw new Error(`AI response missing 'content' field. Keys: ${Object.keys(parsed).join(', ')}`);
        }

        // Handle thinking mode (content is array of blocks)
        let text;
        if (Array.isArray(parsed.content)) {
            const textBlock = parsed.content.find(b => b.type === 'text');
            text = textBlock?.text || '';
        } else {
            text = typeof parsed.content === 'string' ? parsed.content : '';
        }

        return { text, usage: parsed.usage || { input_tokens: 0, output_tokens: 0 } };
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
