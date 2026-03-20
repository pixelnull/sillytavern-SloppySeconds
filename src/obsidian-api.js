// ============================================================================
// Client-Side Obsidian REST API Helpers
// ============================================================================

/**
 * URL-encode each path segment individually to preserve `/` separators.
 * @param {string} vaultPath
 * @returns {string}
 */
export function encodeVaultPath(vaultPath) {
    return vaultPath.split('/').map(s => encodeURIComponent(s)).join('/');
}

/**
 * Reject any path that tries to escape the vault root.
 * @param {string} p
 * @returns {string} Normalized path
 */
export function validateVaultPath(p) {
    const normalized = p.replace(/\\/g, '/');
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized.endsWith('/..') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
        throw new Error('Invalid vault path');
    }
    return normalized;
}

/**
 * Direct browser → Obsidian REST API fetch (no server plugin needed).
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.apiKey
 * @param {string} opts.path - API path (e.g. '/vault/MyFile.md')
 * @param {string} [opts.method='GET']
 * @param {string} [opts.accept='application/json']
 * @param {string|null} [opts.body=null]
 * @param {string|null} [opts.contentType=null]
 * @param {number} [opts.timeout=30000]
 * @returns {Promise<{status: number, data: string}>}
 */
export async function obsidianFetch({ port, apiKey, path, method = 'GET', accept = 'application/json', body = null, contentType = null, timeout = 30000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const headers = { 'Authorization': `Bearer ${apiKey}`, 'Accept': accept };
        if (body && contentType) headers['Content-Type'] = contentType;
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method, headers, body: body ?? undefined, signal: controller.signal,
        });
        const data = await response.text();
        return { status: response.status, data };
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Obsidian request timed out');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
