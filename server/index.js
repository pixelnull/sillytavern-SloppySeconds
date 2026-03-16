const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { obsidianRequest, encodeVaultPath } = require('./core/obsidian');

const info = {
    id: 'sloppy-seconds',
    name: 'SloppySeconds',
    description: 'Post-generation prose refiner with AI slop detection via Claude Sonnet with extended thinking',
};

// ============================================================================
// Claude Proxy Helpers (with thinking support)
// ============================================================================

/**
 * Call the claude-code-proxy with an Anthropic Messages API request.
 * Supports extended thinking via the `thinking` parameter.
 * @param {string} proxyUrl - Base URL of the proxy (e.g. http://localhost:42069)
 * @param {string} model - Model identifier
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {number} maxTokens - Max tokens for response
 * @param {number} [thinkingBudget=0] - Extended thinking budget (0 = disabled)
 * @param {number} [timeout=60000] - Request timeout in ms
 * @returns {Promise<{text: string, usage: object}>}
 */
function callProxy(proxyUrl, model, systemPrompt, userMessage, maxTokens, thinkingBudget = 0, timeout = 60000) {
    return new Promise((resolve, reject) => {
        const url = new URL(proxyUrl.replace(/\/+$/, '') + '/v1/messages');

        const body = {
            model: model,
            max_tokens: maxTokens,
            system: [{ type: 'text', text: systemPrompt }],
            messages: [{ role: 'user', content: userMessage }],
        };

        // Add extended thinking if budget > 0
        if (thinkingBudget > 0) {
            body.thinking = {
                type: 'enabled',
                budget_tokens: thinkingBudget,
            };
        }

        const payload = JSON.stringify(body);

        // Force IPv4 for localhost to avoid ::1 ECONNREFUSED issues
        const hostname = (url.hostname === 'localhost') ? '127.0.0.1' : url.hostname;

        const options = {
            hostname: hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(payload),
            },
        };

        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Proxy returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                }
                try {
                    const parsed = JSON.parse(data);

                    if (parsed.error) {
                        return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                    }

                    // With thinking enabled, content is an array of blocks.
                    // Extract the text block (skip thinking blocks).
                    let text = '';
                    if (Array.isArray(parsed.content)) {
                        const textBlock = parsed.content.find(b => b.type === 'text');
                        text = textBlock?.text || '';
                    } else {
                        // Fallback for non-thinking responses
                        text = parsed.content?.[0]?.text || '';
                    }

                    const usage = parsed.usage || { input_tokens: 0, output_tokens: 0 };
                    resolve({ text, usage });
                } catch (e) {
                    reject(new Error(`Failed to parse proxy response: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(timeout, () => {
            req.destroy(new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`));
        });
        try {
            req.write(payload);
            req.end();
        } catch (e) {
            req.destroy();
            reject(new Error(`Failed to send proxy request: ${e.message}`));
        }
    });
}

// ============================================================================
// Plugin Init
// ============================================================================

async function init(router) {
    const express = require('express');
    router.use(express.json({ limit: '5mb' }));

    /**
     * POST /test - Test connection to the Claude proxy
     */
    router.post('/test', async (req, res) => {
        try {
            const { proxyUrl, model } = req.body;

            if (!proxyUrl || !model) {
                return res.status(400).json({ ok: false, error: 'Missing proxyUrl or model' });
            }

            const result = await callProxy(
                proxyUrl,
                model,
                'You are a test endpoint. Respond with exactly: {"status":"ok"}',
                'Test connection. Respond with exactly: {"status":"ok"}',
                32,
                0,     // no thinking for test
                10000, // short timeout
            );

            return res.json({ ok: true, response: result.text.substring(0, 100) });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /analyze - Send prose to AI for slop detection with thinking support
     */
    router.post('/analyze', async (req, res) => {
        try {
            const { proxyUrl, model, systemPrompt, userMessage, maxTokens, thinkingBudget, timeout } = req.body;

            if (!proxyUrl || !model || !systemPrompt || !userMessage) {
                return res.status(400).json({ ok: false, error: 'Missing required fields: proxyUrl, model, systemPrompt, userMessage' });
            }

            const proxyTimeout = Math.min(Math.max(timeout || 60000, 5000), 120000);
            const result = await callProxy(
                proxyUrl,
                model,
                systemPrompt,
                userMessage,
                maxTokens || 4096,
                thinkingBudget || 0,
                proxyTimeout,
            );

            // Try to parse the response as JSON
            let parsed = null;
            try {
                parsed = JSON.parse(result.text.trim());
            } catch {
                // Try extracting from markdown fences
                const fenceMatch = result.text.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (fenceMatch) {
                    try {
                        parsed = JSON.parse(fenceMatch[1].trim());
                    } catch { /* fall through */ }
                }
            }

            if (!parsed) {
                console.warn('[SloppySeconds] AI returned non-JSON response:', result.text.substring(0, 300));
                return res.json({ ok: false, error: 'AI returned invalid response format', raw: result.text.substring(0, 500), usage: result.usage });
            }

            return res.json({
                ok: true,
                findings: parsed.findings || [],
                newPatterns: parsed.newPatterns || [],
                summary: parsed.summary || '',
                usage: result.usage,
            });
        } catch (err) {
            console.error('[SloppySeconds] Analyze error:', err.message);
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /read-patterns - Read the slop patterns file from Obsidian vault
     */
    router.post('/read-patterns', async (req, res) => {
        try {
            const { port, apiKey, filename } = req.body;

            if (!port || !apiKey || !filename) {
                return res.status(400).json({ ok: false, error: 'Missing port, apiKey, or filename' });
            }

            const normalizedFile = path.normalize(filename).replace(/\\/g, '/');
            if (normalizedFile.startsWith('..') || path.isAbsolute(normalizedFile) || normalizedFile.includes('/../')) {
                return res.status(400).json({ ok: false, error: 'Invalid filename: path traversal not allowed' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(normalizedFile)}`,
                accept: 'text/markdown',
            });

            if (result.status === 200) {
                return res.json({ ok: true, content: result.data });
            }

            if (result.status === 404) {
                return res.json({ ok: true, content: null }); // File doesn't exist yet
            }

            return res.json({ ok: false, error: `HTTP ${result.status}` });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /write-patterns - Write/update the slop patterns file in Obsidian vault
     */
    router.post('/write-patterns', async (req, res) => {
        try {
            const { port, apiKey, filename, content } = req.body;

            if (!port || !apiKey || !filename || content === undefined) {
                return res.status(400).json({ ok: false, error: 'Missing required fields (port, apiKey, filename, content)' });
            }

            const normalizedWrite = path.normalize(filename).replace(/\\/g, '/');
            if (normalizedWrite.startsWith('..') || path.isAbsolute(normalizedWrite) || normalizedWrite.includes('/../')) {
                return res.status(400).json({ ok: false, error: 'Invalid filename: path traversal not allowed' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(normalizedWrite)}`,
                method: 'PUT',
                body: content,
                contentType: 'text/markdown',
                accept: 'text/markdown',
            });

            if (result.status === 200 || result.status === 204) {
                return res.json({ ok: true });
            }

            return res.json({ ok: false, error: `HTTP ${result.status}` });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /obsidian-test - Test connection to Obsidian REST API
     */
    router.post('/obsidian-test', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port) {
                return res.status(400).json({ error: 'Missing port' });
            }

            const result = await obsidianRequest({
                port,
                apiKey: apiKey || '',
                path: '/',
            });

            if (result.status === 200) {
                const serverInfo = JSON.parse(result.data);
                return res.json({
                    ok: true,
                    authenticated: serverInfo.authenticated || false,
                });
            }

            return res.json({ ok: false, error: `HTTP ${result.status}` });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    console.log('[SloppySeconds] Server plugin initialized');
}

async function exit() {
    console.log('[SloppySeconds] Server plugin shutting down');
}

module.exports = { info, init, exit };
