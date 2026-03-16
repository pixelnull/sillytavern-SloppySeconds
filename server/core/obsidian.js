/**
 * SloppySeconds — Obsidian REST API Helpers (CommonJS)
 * Adapted from DeepLore Enhanced's shared core.
 */

const http = require('node:http');

/**
 * Makes an HTTP request to the Obsidian Local REST API.
 * @param {object} options
 * @param {number} options.port - Obsidian REST API port
 * @param {string} options.apiKey - Bearer token
 * @param {string} options.path - API path (e.g. /vault/)
 * @param {string} [options.method='GET'] - HTTP method
 * @param {string} [options.accept='application/json'] - Accept header
 * @param {string|null} [options.body=null] - Request body
 * @param {string|null} [options.contentType=null] - Content-Type header
 * @returns {Promise<{status: number, data: string}>}
 */
function obsidianRequest({ port, apiKey, path, method = 'GET', accept = 'application/json', body = null, contentType = null }) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': accept,
        };

        if (body !== null && contentType) {
            headers['Content-Type'] = contentType;
            headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: path,
            method: method,
            headers: headers,
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode, data: data });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        if (body !== null) {
            req.write(body);
        }

        req.end();
    });
}

/**
 * Encode a vault path for use in the Obsidian REST API URL.
 * Encodes each path segment individually to preserve slashes.
 * @param {string} vaultPath - Path like "SloppySeconds/Slop Patterns.md"
 * @returns {string} URL-encoded path
 */
function encodeVaultPath(vaultPath) {
    return vaultPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

module.exports = { obsidianRequest, encodeVaultPath };
