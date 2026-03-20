// ============================================================================
// Pattern Management
// ============================================================================

import { getSettings } from '../settings.js';
import {
    obsidianPatterns, obsidianPatternsLoaded,
    setObsidianPatterns, setObsidianPatternsLoaded,
} from './state.js';
import { obsidianFetch, encodeVaultPath, validateVaultPath } from './obsidian-api.js';

/**
 * Get all slop patterns merged from: built-in defaults + custom user patterns + Obsidian vault patterns.
 * @returns {string[]}
 */
export function getMergedPatterns() {
    const settings = getSettings();
    const patterns = new Set();

    // Built-in defaults (B22: guard against non-string entries from settings corruption)
    for (const p of settings.slopPatterns) {
        if (typeof p === 'string' && p.trim()) patterns.add(p.trim().toLowerCase());
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

// B20: Deduplicate concurrent loadObsidianPatterns calls
let _loadPromise = null;

/**
 * Load slop patterns from Obsidian vault.
 */
export async function loadObsidianPatterns() {
    // B20: Return existing in-flight promise to prevent duplicate requests + wipe race
    if (_loadPromise) return _loadPromise;
    _loadPromise = _doLoadObsidianPatterns().finally(() => { _loadPromise = null; });
    return _loadPromise;
}

async function _doLoadObsidianPatterns() {
    const settings = getSettings();
    if (!settings.obsidianEnabled) return;

    try {
        const safePath = validateVaultPath(settings.patternFile);
        const result = await obsidianFetch({
            port: settings.obsidianPort,
            apiKey: settings.obsidianApiKey,
            path: '/vault/' + encodeVaultPath(safePath),
            accept: 'text/markdown',
        });

        if (result.status === 404) {
            // File doesn't exist yet — not an error, but allow retry on next chat change
            setObsidianPatterns([]);
            setObsidianPatternsLoaded(true);
            return;
        }

        if (result.status !== 200) {
            // H1: Don't lock on transient errors — allow retry on next refinement
            console.warn(`[SloppySeconds] Obsidian read failed: HTTP ${result.status}`);
            setObsidianPatterns([]);
            return;
        }

        // Parse the markdown pattern list
        const lines = result.data.split('\n');
        const patterns = [];
        for (const line of lines) {
            const match = line.match(/^\s*[-*]\s+(.+)$/);
            if (match) {
                // Strip "(discovered YYYY-MM-DD)" suffix if present
                const raw = match[1].replace(/\s+\(discovered\s\d{4}-\d{2}-\d{2}\)\s*$/, '');
                patterns.push(raw.trim().toLowerCase());
            }
        }

        setObsidianPatterns(patterns);
        setObsidianPatternsLoaded(true);
        if (settings.debugMode) {
            console.log(`[SloppySeconds] Loaded ${patterns.length} patterns from Obsidian`);
        }
    } catch (err) {
        console.warn('[SloppySeconds] Failed to load Obsidian patterns:', err.message);
        // H1: Set loaded flag on thrown exceptions to prevent infinite retry spam.
        // Will be reset on next CHAT_CHANGED or Obsidian toggle, allowing natural retry.
        setObsidianPatternsLoaded(true);
    }
}

// B12: Serialize concurrent append calls to prevent read-modify-write TOCTOU
let _appendLock = null;

/**
 * Append newly discovered patterns to the Obsidian vault file.
 * @param {string[]} newPatterns
 */
export async function appendObsidianPatterns(newPatterns) {
    // B23: Filter null/empty entries from AI response
    const validPatterns = newPatterns.filter(p => typeof p === 'string' && p.trim());
    if (validPatterns.length === 0) return;
    // B12: Wait for any in-flight append to complete before starting
    while (_appendLock) await _appendLock;
    _appendLock = _doAppendObsidianPatterns(validPatterns).finally(() => { _appendLock = null; });
    return _appendLock;
}

async function _doAppendObsidianPatterns(newPatterns) {
    const settings = getSettings();
    if (!settings.obsidianEnabled || newPatterns.length === 0) return;

    try {
        const safePath = validateVaultPath(settings.patternFile);
        const encodedPath = '/vault/' + encodeVaultPath(safePath);

        // Read current file
        const readResult = await obsidianFetch({
            port: settings.obsidianPort,
            apiKey: settings.obsidianApiKey,
            path: encodedPath,
            accept: 'text/markdown',
        });

        const today = new Date().toISOString().split('T')[0];
        let content;

        if (readResult.status === 200 && readResult.data) {
            // File exists — deduplicate and append
            const existingSet = new Set(
                readResult.data.split('\n')
                    .map(l => l.match(/^\s*[-*]\s+(.+)$/))
                    .filter(Boolean)
                    .map(m => m[1].replace(/\s+\(discovered\s\d{4}-\d{2}-\d{2}\)\s*$/, '').trim().toLowerCase()),
            );
            // M2: Normalize to lowercase before appending to prevent case-variant duplicates
            const toAdd = newPatterns
                .map(p => p.toLowerCase())
                .filter(p => !existingSet.has(p));
            if (toAdd.length === 0) return;

            const newLines = toAdd.map(p => `- ${p} (discovered ${today})`).join('\n');

            if (readResult.data.includes('## AI-Discovered')) {
                content = readResult.data.trimEnd() + '\n' + newLines + '\n';
            } else {
                content = readResult.data.trimEnd() + '\n\n## AI-Discovered\n' + newLines + '\n';
            }
        } else {
            // File doesn't exist — create it
            const builtInList = settings.slopPatterns.map(p => `- ${p}`).join('\n');
            const newLines = newPatterns.map(p => `- ${p} (discovered ${today})`).join('\n');
            content = `---\ntags:\n  - sloppy-seconds\n  - sloppy-seconds/patterns\nupdated: ${today}\n---\n# Slop Patterns\n\n## Built-in\n${builtInList}\n\n## AI-Discovered\n${newLines}\n`;
        }

        // Write back
        const writeResult = await obsidianFetch({
            port: settings.obsidianPort,
            apiKey: settings.obsidianApiKey,
            path: encodedPath,
            method: 'PUT',
            body: content,
            contentType: 'text/markdown',
            accept: 'text/markdown',
        });

        if (writeResult.status !== 200 && writeResult.status !== 201 && writeResult.status !== 204) {
            console.warn(`[SloppySeconds] Pattern write failed: HTTP ${writeResult.status}`);
            return;
        }

        // Update local cache only after confirmed write
        const currentPatterns = [...obsidianPatterns];
        for (const p of newPatterns) {
            if (!currentPatterns.includes(p.toLowerCase())) {
                currentPatterns.push(p.toLowerCase());
            }
        }
        setObsidianPatterns(currentPatterns);

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
export async function seedObsidianPatterns() {
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
        const safePath = validateVaultPath(settings.patternFile);
        const encodedPath = '/vault/' + encodeVaultPath(safePath);

        // Check if file already exists
        const readResult = await obsidianFetch({
            port: settings.obsidianPort,
            apiKey: settings.obsidianApiKey,
            path: encodedPath,
            accept: 'text/markdown',
        });

        if (readResult.status === 200 && readResult.data) {
            // File exists — only add patterns not already present
            const existingSet = new Set(
                readResult.data.split('\n')
                    .map(l => l.match(/^\s*[-*]\s+(.+)$/))
                    .filter(Boolean)
                    .map(m => m[1].replace(/\s+\(discovered\s\d{4}-\d{2}-\d{2}\)\s*$/, '').trim().toLowerCase()),
            );
            const toAdd = discoveredPatterns.filter(p => !existingSet.has(p.toLowerCase()));

            if (toAdd.length === 0) {
                toastr.info('All patterns already exist in the file', 'SloppySeconds');
                return;
            }

            const today = new Date().toISOString().split('T')[0];
            const newLines = toAdd.map(p => `- ${p} (discovered ${today})`).join('\n');
            let content;

            if (readResult.data.includes('## AI-Discovered')) {
                content = readResult.data.trimEnd() + '\n' + newLines + '\n';
            } else {
                content = readResult.data.trimEnd() + '\n\n## AI-Discovered\n' + newLines + '\n';
            }

            const writeResult = await obsidianFetch({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
                path: encodedPath,
                method: 'PUT',
                body: content,
                contentType: 'text/markdown',
                accept: 'text/markdown',
            });

            if (writeResult.status !== 200 && writeResult.status !== 201 && writeResult.status !== 204) { // B18: Accept 201
                toastr.error(`Failed to write patterns: HTTP ${writeResult.status}`, 'SloppySeconds');
                return;
            }

            toastr.success(`Added ${toAdd.length} new patterns to vault`, 'SloppySeconds');
        } else {
            // File doesn't exist — create it
            const today = new Date().toISOString().split('T')[0];
            const patternLines = discoveredPatterns.map(p => `- ${p}`).join('\n');
            const content = `---\ntags:\n  - sloppy-seconds\n  - sloppy-seconds/patterns\nupdated: ${today}\n---\n# Slop Patterns\n\n## Discovered\n${patternLines}\n`;

            const writeResult = await obsidianFetch({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
                path: encodedPath,
                method: 'PUT',
                body: content,
                contentType: 'text/markdown',
                accept: 'text/markdown',
            });

            if (writeResult.status !== 200 && writeResult.status !== 201 && writeResult.status !== 204) { // B18: Accept 201
                toastr.error(`Failed to create pattern file: HTTP ${writeResult.status}`, 'SloppySeconds');
                return;
            }

            toastr.success(`Created pattern file with ${discoveredPatterns.length} patterns`, 'SloppySeconds');
        }

        // Reload patterns into cache
        setObsidianPatternsLoaded(false);
        await loadObsidianPatterns();
    } catch (err) {
        toastr.error(`Failed to seed patterns: ${err.message}`, 'SloppySeconds');
    }
}
