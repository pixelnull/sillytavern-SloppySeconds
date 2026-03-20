// ============================================================================
// SloppySeconds — Unit Tests
// ============================================================================
// Run: node tests.mjs
// Custom test framework — no external dependencies.

import { encodeVaultPath, validateVaultPath } from './src/obsidian-api.js';

// ============================================================================
// Test Runner
// ============================================================================

let passed = 0;
let failed = 0;
let currentTest = '';

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

function assertEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    Expected: ${e}`);
        console.error(`    Actual:   ${a}`);
    }
}

function assertThrows(fn, message) {
    try {
        fn();
        failed++;
        console.error(`  FAIL: ${message} (did not throw)`);
    } catch {
        passed++;
    }
}

function test(name, fn) {
    currentTest = name;
    try {
        fn();
        console.log(`  PASS: ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ERROR: ${name} — ${err.message}`);
    }
}

// ============================================================================
// Inline Re-implementations of Pure Logic
// ============================================================================
// These functions replicate the core logic from the extension modules
// without SillyTavern imports, so we can test them in pure Node.

/**
 * Replicate getMergedPatterns logic (from src/patterns.js)
 */
function getMergedPatternsLogic(slopPatterns, customPatterns, obsidianPatterns) {
    const patterns = new Set();
    for (const p of slopPatterns) {
        if (typeof p === 'string' && p.trim()) patterns.add(p.trim().toLowerCase());
    }
    if (customPatterns) {
        for (const line of customPatterns.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) patterns.add(trimmed.toLowerCase());
        }
    }
    for (const p of obsidianPatterns) {
        if (p.trim()) patterns.add(p.trim().toLowerCase());
    }
    return [...patterns];
}

/**
 * Replicate confidence filtering logic (from src/refine.js)
 */
function filterByConfidence(findings, threshold) {
    const confident = [];
    for (const f of findings) {
        if (!f.original || !f.replacement) continue;
        const conf = typeof f.confidence === 'number' ? f.confidence : 1.0;
        if (conf < threshold) {
            f._applied = false;
            f._lowConfidence = true;
        } else {
            confident.push(f);
        }
    }
    return confident;
}

/**
 * Replicate text replacement logic (from src/refine.js)
 */
function applyReplacements(text, findings) {
    const withPositions = findings
        .map(f => ({ finding: f, idx: text.indexOf(f.original) }))
        .filter(item => item.idx !== -1);
    withPositions.sort((a, b) => a.idx - b.idx);

    const located = [];
    let consumedUntil = 0;
    for (const item of withPositions) {
        if (item.idx < consumedUntil) {
            const retryIdx = text.indexOf(item.finding.original, consumedUntil);
            if (retryIdx !== -1) {
                located.push({ idx: retryIdx, finding: item.finding });
                item.finding._applied = true;
                consumedUntil = retryIdx + item.finding.original.length;
            } else {
                item.finding._applied = false;
            }
        } else {
            located.push(item);
            item.finding._applied = true;
            consumedUntil = item.idx + item.finding.original.length;
        }
    }

    // Mark unmatched
    for (const f of findings) {
        if (f._applied === undefined) f._applied = false;
    }

    located.sort((a, b) => b.idx - a.idx);
    let result = text;
    for (const { idx, finding } of located) {
        result = result.substring(0, idx) + finding.replacement + result.substring(idx + finding.original.length);
    }

    return { text: result, appliedCount: located.length };
}

/**
 * Replicate findings cleanup logic (B5+B9 from src/refine.js)
 */
function cleanFindings(findings) {
    return findings.map(({ _applied, _lowConfidence, ...rest }) => ({
        ...rest,
        applied: !!_applied,
        lowConfidence: !!_lowConfidence,
    }));
}

/**
 * Replicate selective revert logic (from src/refine.js)
 */
function selectiveRevertLogic(text, findings, indices) {
    let result = text;
    let revertCount = 0;
    for (const idx of indices) {
        const finding = findings[idx];
        if (!finding?.original || !finding?.replacement) continue;
        const pos = result.indexOf(finding.replacement);
        if (pos !== -1) {
            result = result.substring(0, pos) + finding.original + result.substring(pos + finding.replacement.length);
            finding.reverted = true;
            revertCount++;
        }
    }
    return { text: result, revertCount };
}

/**
 * Replicate settings migration logic (from settings.js)
 */
function migrateSettings(s, defaults, targetVersion) {
    if (!Array.isArray(s.slopPatterns)) {
        s.slopPatterns = [...defaults.slopPatterns];
    }
    if ((s.settingsVersion || 0) < targetVersion) {
        const existing = new Set(s.slopPatterns.map(p => typeof p === 'string' ? p.toLowerCase() : ''));
        for (const p of defaults.slopPatterns) {
            if (!existing.has(p.toLowerCase())) {
                s.slopPatterns.push(p);
            }
        }
        s.settingsVersion = targetVersion;
    }
    return s;
}

/**
 * Replicate buildChatContext logic (from src/ai.js)
 */
function buildChatContextLogic(chat, targetMessageId, count) {
    if (targetMessageId < 1) return '';
    const aiMessages = [];
    for (let i = targetMessageId - 1; i >= 0 && aiMessages.length < count; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user || msg.is_system) continue;
        aiMessages.push(`[${msg.name || 'AI'} — message ${i}]:\n${msg.mes}`);
    }
    aiMessages.reverse();
    return aiMessages.join('\n\n---\n\n');
}

// ============================================================================
// Tests: encodeVaultPath
// ============================================================================

console.log('\n=== encodeVaultPath ===');

test('encodeVaultPath: simple path', () => {
    assertEqual(encodeVaultPath('folder/file.md'), 'folder/file.md', 'simple path preserved');
});

test('encodeVaultPath: path with spaces', () => {
    assertEqual(encodeVaultPath('My Folder/My File.md'), 'My%20Folder/My%20File.md', 'spaces encoded');
});

test('encodeVaultPath: preserves slashes', () => {
    assertEqual(encodeVaultPath('a/b/c/d.md'), 'a/b/c/d.md', 'slashes preserved');
});

test('encodeVaultPath: special characters', () => {
    const result = encodeVaultPath('folder/file (1).md');
    // Node's encodeURIComponent doesn't encode parentheses (RFC 3986 unreserved)
    assert(result === 'folder/file%20(1).md', 'spaces encoded, parens preserved');
});

test('encodeVaultPath: unicode characters', () => {
    const result = encodeVaultPath('日本語/ファイル.md');
    assert(result.includes('/'), 'slash preserved in unicode path');
    assert(!result.includes('日'), 'unicode chars encoded');
});

// ============================================================================
// Tests: validateVaultPath
// ============================================================================

console.log('\n=== validateVaultPath ===');

test('validateVaultPath: valid relative path', () => {
    assertEqual(validateVaultPath('folder/file.md'), 'folder/file.md', 'simple path returned');
});

test('validateVaultPath: normalizes backslashes', () => {
    assertEqual(validateVaultPath('folder\\subfolder\\file.md'), 'folder/subfolder/file.md', 'backslashes normalized');
});

test('validateVaultPath: rejects parent traversal (starts with ..)', () => {
    assertThrows(() => validateVaultPath('../secret.md'), 'should reject ..');
});

test('validateVaultPath: rejects parent traversal (contains /../)', () => {
    assertThrows(() => validateVaultPath('folder/../../../etc/passwd'), 'should reject /../');
});

test('validateVaultPath: rejects parent traversal (ends with /..)', () => {
    assertThrows(() => validateVaultPath('folder/..'), 'should reject trailing /..');
});

test('validateVaultPath: rejects absolute path (drive letter)', () => {
    assertThrows(() => validateVaultPath('C:\\Windows\\system32'), 'should reject drive letter');
});

test('validateVaultPath: rejects absolute path (leading slash)', () => {
    assertThrows(() => validateVaultPath('/etc/passwd'), 'should reject leading slash');
});

test('validateVaultPath: allows dots in filenames', () => {
    assertEqual(validateVaultPath('folder/v0.3.1-notes.md'), 'folder/v0.3.1-notes.md', 'dots in filenames ok');
});

// ============================================================================
// Tests: Pattern Merging
// ============================================================================

console.log('\n=== getMergedPatterns ===');

test('mergePatterns: combines built-in and custom', () => {
    const result = getMergedPatternsLogic(['a testament to', 'orbs'], 'custom pattern\nmy phrase', []);
    assert(result.includes('a testament to'), 'has built-in');
    assert(result.includes('custom pattern'), 'has custom');
    assert(result.includes('my phrase'), 'has custom 2');
});

test('mergePatterns: deduplicates case-insensitive', () => {
    const result = getMergedPatternsLogic(['Orbs', 'ORBS', 'orbs'], '', []);
    const orbsCount = result.filter(p => p === 'orbs').length;
    assertEqual(orbsCount, 1, 'single orbs entry');
});

test('mergePatterns: skips empty and whitespace', () => {
    const result = getMergedPatternsLogic(['  ', '', 'valid'], '\n\n', []);
    assertEqual(result.length, 1, 'only valid pattern');
    assertEqual(result[0], 'valid', 'correct pattern');
});

test('mergePatterns: includes obsidian patterns', () => {
    const result = getMergedPatternsLogic(['built-in'], '', ['from obsidian']);
    assert(result.includes('from obsidian'), 'obsidian pattern included');
});

test('mergePatterns: B22 — handles non-string entries gracefully', () => {
    const result = getMergedPatternsLogic([42, null, undefined, 'valid', { bad: true }], '', []);
    assertEqual(result, ['valid'], 'only string entries');
});

test('mergePatterns: custom patterns split by newlines', () => {
    const result = getMergedPatternsLogic([], 'line1\nline2\nline3', []);
    assertEqual(result.length, 3, 'three custom patterns');
});

// ============================================================================
// Tests: Confidence Filtering
// ============================================================================

console.log('\n=== Confidence Filtering ===');

test('confidence: filters below threshold', () => {
    const findings = [
        { original: 'a', replacement: 'b', confidence: 0.9 },
        { original: 'c', replacement: 'd', confidence: 0.3 },
        { original: 'e', replacement: 'f', confidence: 0.7 },
    ];
    const confident = filterByConfidence(findings, 0.7);
    assertEqual(confident.length, 2, 'two findings pass threshold');
    assert(findings[1]._lowConfidence === true, 'low confidence flagged');
    assert(findings[1]._applied === false, 'low confidence not applied');
});

test('confidence: defaults to 1.0 when missing', () => {
    const findings = [{ original: 'x', replacement: 'y' }];
    const confident = filterByConfidence(findings, 0.7);
    assertEqual(confident.length, 1, 'no confidence defaults to 1.0');
});

test('confidence: skips findings without original/replacement', () => {
    const findings = [
        { original: 'a', replacement: 'b', confidence: 0.9 },
        { original: '', replacement: 'b', confidence: 0.9 },
        { original: 'a', replacement: '', confidence: 0.9 },
    ];
    const confident = filterByConfidence(findings, 0.5);
    assertEqual(confident.length, 1, 'only complete findings pass');
});

test('confidence: threshold 0 passes everything', () => {
    const findings = [
        { original: 'a', replacement: 'b', confidence: 0.01 },
        { original: 'c', replacement: 'd', confidence: 0.0 },
    ];
    // 0.0 < 0 is false, so it passes
    const confident = filterByConfidence(findings, 0);
    assertEqual(confident.length, 2, 'all pass at threshold 0');
});

// ============================================================================
// Tests: Text Replacement
// ============================================================================

console.log('\n=== Text Replacement ===');

test('replacement: basic single replacement', () => {
    const findings = [{ original: 'a testament to', replacement: 'showed' }];
    const { text, appliedCount } = applyReplacements('It was a testament to her skill.', findings);
    assertEqual(text, 'It was showed her skill.', 'correct replacement');
    assertEqual(appliedCount, 1, 'one applied');
    assert(findings[0]._applied === true, 'marked as applied');
});

test('replacement: multiple non-overlapping', () => {
    const findings = [
        { original: 'orbs', replacement: 'eyes' },
        { original: 'lithe', replacement: 'slender' },
    ];
    const { text, appliedCount } = applyReplacements('Her orbs gazed at his lithe form.', findings);
    assertEqual(text, 'Her eyes gazed at his slender form.', 'both replaced');
    assertEqual(appliedCount, 2, 'two applied');
});

test('replacement: finding not in text', () => {
    const findings = [{ original: 'nonexistent phrase', replacement: 'whatever' }];
    const { text, appliedCount } = applyReplacements('Hello world.', findings);
    assertEqual(text, 'Hello world.', 'text unchanged');
    assertEqual(appliedCount, 0, 'zero applied');
    assert(findings[0]._applied === false, 'marked not applied');
});

test('replacement: overlapping matches deduplicated', () => {
    const findings = [
        { original: 'the weight of', replacement: 'carrying' },
        { original: 'weight of the', replacement: 'heavy' },
    ];
    const { text, appliedCount } = applyReplacements('She felt the weight of the world.', findings);
    // First match wins; second overlaps and retries from after
    assert(appliedCount >= 1, 'at least one applied');
});

test('replacement: duplicate substrings handled', () => {
    const findings = [
        { original: 'the', replacement: 'a' },
        { original: 'the', replacement: 'a' },
    ];
    const { text } = applyReplacements('the cat and the dog', findings);
    assertEqual(text, 'a cat and a dog', 'both occurrences replaced');
});

test('replacement: preserves surrounding text exactly', () => {
    const findings = [{ original: 'bad', replacement: 'good' }];
    const original = '  spaces  bad  preserved  ';
    const { text } = applyReplacements(original, findings);
    assertEqual(text, '  spaces  good  preserved  ', 'whitespace preserved');
});

// ============================================================================
// Tests: Findings Cleanup (B5+B9)
// ============================================================================

console.log('\n=== Findings Cleanup ===');

test('cleanFindings: strips internal flags, adds explicit booleans', () => {
    const findings = [
        { original: 'a', replacement: 'b', pattern: 'test', _applied: true, _lowConfidence: false },
        { original: 'c', replacement: 'd', pattern: 'test2', _applied: false, _lowConfidence: true },
    ];
    const clean = cleanFindings(findings);
    assertEqual(clean[0].applied, true, 'applied preserved');
    assertEqual(clean[0].lowConfidence, false, 'lowConfidence preserved');
    assertEqual(clean[0]._applied, undefined, '_applied stripped');
    assertEqual(clean[0]._lowConfidence, undefined, '_lowConfidence stripped');
    assertEqual(clean[1].applied, false, 'not-applied preserved');
    assertEqual(clean[1].lowConfidence, true, 'lowConfidence true preserved');
});

test('cleanFindings: handles undefined flags', () => {
    const findings = [{ original: 'a', replacement: 'b', pattern: 'test' }];
    const clean = cleanFindings(findings);
    assertEqual(clean[0].applied, false, 'undefined _applied → false');
    assertEqual(clean[0].lowConfidence, false, 'undefined _lowConfidence → false');
});

test('cleanFindings: preserves all other fields', () => {
    const findings = [{ original: 'a', replacement: 'b', pattern: 'test', confidence: 0.9, explanation: 'reason', _applied: true }];
    const clean = cleanFindings(findings);
    assertEqual(clean[0].original, 'a', 'original preserved');
    assertEqual(clean[0].replacement, 'b', 'replacement preserved');
    assertEqual(clean[0].confidence, 0.9, 'confidence preserved');
    assertEqual(clean[0].explanation, 'reason', 'explanation preserved');
});

// ============================================================================
// Tests: Selective Revert (B10)
// ============================================================================

console.log('\n=== Selective Revert ===');

test('selectiveRevert: reverts specified findings', () => {
    const text = 'She showed her skill and demonstrated her eyes.';
    const findings = [
        { original: 'a testament to', replacement: 'showed' },
        { original: 'orbs', replacement: 'eyes' },
    ];
    // Revert finding index 1 (eyes → orbs)
    const { text: result, revertCount } = selectiveRevertLogic(text, findings, [1]);
    assertEqual(result, 'She showed her skill and demonstrated her orbs.', 'only specified finding reverted');
    assertEqual(revertCount, 1, 'one reverted');
    assert(findings[1].reverted === true, 'B10: marked as reverted');
    assert(!findings[0].reverted, 'other finding not reverted');
});

test('selectiveRevert: handles replacement not found', () => {
    const text = 'No match here.';
    const findings = [{ original: 'foo', replacement: 'bar' }];
    const { revertCount } = selectiveRevertLogic(text, findings, [0]);
    assertEqual(revertCount, 0, 'nothing to revert');
});

test('selectiveRevert: handles invalid index', () => {
    const findings = [{ original: 'a', replacement: 'b' }];
    const { revertCount } = selectiveRevertLogic('b', findings, [5]);
    assertEqual(revertCount, 0, 'invalid index handled');
});

test('selectiveRevert: handles null finding', () => {
    const findings = [null, { original: 'a', replacement: 'b' }];
    const { revertCount } = selectiveRevertLogic('b', findings, [0, 1]);
    assertEqual(revertCount, 1, 'skips null, processes valid');
});

// ============================================================================
// Tests: Settings Migration (B8)
// ============================================================================

console.log('\n=== Settings Migration ===');

test('migration: B8 — resets corrupted slopPatterns (string)', () => {
    const defaults = { slopPatterns: ['pattern1', 'pattern2'] };
    const s = { slopPatterns: 'not an array', settingsVersion: 0 };
    const result = migrateSettings(s, defaults, 2);
    assert(Array.isArray(result.slopPatterns), 'slopPatterns is array');
    assert(result.slopPatterns.includes('pattern1'), 'has defaults');
});

test('migration: B8 — resets corrupted slopPatterns (null)', () => {
    const defaults = { slopPatterns: ['a'] };
    const s = { slopPatterns: null, settingsVersion: 0 };
    const result = migrateSettings(s, defaults, 2);
    assert(Array.isArray(result.slopPatterns), 'null → array');
});

test('migration: adds new default patterns', () => {
    const defaults = { slopPatterns: ['old', 'new'] };
    const s = { slopPatterns: ['old'], settingsVersion: 1 };
    const result = migrateSettings(s, defaults, 2);
    assert(result.slopPatterns.includes('old'), 'keeps existing');
    assert(result.slopPatterns.includes('new'), 'adds new');
    assertEqual(result.settingsVersion, 2, 'version updated');
});

test('migration: deduplicates case-insensitive', () => {
    const defaults = { slopPatterns: ['Orbs'] };
    const s = { slopPatterns: ['orbs'], settingsVersion: 1 };
    const result = migrateSettings(s, defaults, 2);
    assertEqual(result.slopPatterns.length, 1, 'no duplicate');
});

test('migration: skips if version already current', () => {
    const defaults = { slopPatterns: ['new'] };
    const s = { slopPatterns: ['old'], settingsVersion: 2 };
    const result = migrateSettings(s, defaults, 2);
    assertEqual(result.slopPatterns.length, 1, 'no migration needed');
    assert(!result.slopPatterns.includes('new'), 'new pattern not added');
});

// ============================================================================
// Tests: buildChatContext
// ============================================================================

console.log('\n=== buildChatContext ===');

test('chatContext: returns empty for first message', () => {
    const chat = [{ mes: 'Hello', is_user: false }];
    assertEqual(buildChatContextLogic(chat, 0, 5), '', 'no context for index 0');
});

test('chatContext: collects only AI messages', () => {
    const chat = [
        { mes: 'AI msg 1', is_user: false, name: 'Bot' },
        { mes: 'User msg', is_user: true, name: 'User' },
        { mes: 'AI msg 2', is_user: false, name: 'Bot' },
        { mes: 'Target', is_user: false, name: 'Bot' },
    ];
    const ctx = buildChatContextLogic(chat, 3, 5);
    assert(ctx.includes('AI msg 1'), 'includes first AI');
    assert(ctx.includes('AI msg 2'), 'includes second AI');
    assert(!ctx.includes('User msg'), 'excludes user');
    assert(!ctx.includes('Target'), 'excludes target');
});

test('chatContext: limits to count', () => {
    const chat = [
        { mes: 'Old', is_user: false, name: 'Bot' },
        { mes: 'Mid', is_user: false, name: 'Bot' },
        { mes: 'Recent', is_user: false, name: 'Bot' },
        { mes: 'Target', is_user: false, name: 'Bot' },
    ];
    const ctx = buildChatContextLogic(chat, 3, 2);
    assert(!ctx.includes('Old'), 'oldest excluded by count limit');
    assert(ctx.includes('Mid'), 'mid included');
    assert(ctx.includes('Recent'), 'recent included');
});

test('chatContext: chronological order (oldest first)', () => {
    const chat = [
        { mes: 'First', is_user: false, name: 'Bot' },
        { mes: 'Second', is_user: false, name: 'Bot' },
        { mes: 'Target', is_user: false, name: 'Bot' },
    ];
    const ctx = buildChatContextLogic(chat, 2, 5);
    const firstPos = ctx.indexOf('First');
    const secondPos = ctx.indexOf('Second');
    assert(firstPos < secondPos, 'oldest message comes first');
});

test('chatContext: skips system messages', () => {
    const chat = [
        { mes: 'System', is_user: false, is_system: true, name: 'System' },
        { mes: 'AI', is_user: false, name: 'Bot' },
        { mes: 'Target', is_user: false, name: 'Bot' },
    ];
    const ctx = buildChatContextLogic(chat, 2, 5);
    assert(!ctx.includes('System'), 'system message excluded');
    assert(ctx.includes('AI'), 'AI message included');
});

test('chatContext: handles negative index', () => {
    const chat = [{ mes: 'msg', is_user: false }];
    assertEqual(buildChatContextLogic(chat, -1, 5), '', 'negative index returns empty');
});

// ============================================================================
// Tests: Edge Cases & Bug Regression
// ============================================================================

console.log('\n=== Edge Cases & Bug Regression ===');

test('B23: appendObsidianPatterns filters null/empty (via pattern logic)', () => {
    // Simulate the B23 filter
    const input = ['valid', null, '', '  ', undefined, 42, 'also valid'];
    const filtered = input.filter(p => typeof p === 'string' && p.trim());
    assertEqual(filtered, ['valid', 'also valid'], 'only valid strings pass');
});

test('replacement: empty text returns unchanged', () => {
    const findings = [{ original: 'a', replacement: 'b' }];
    const { text, appliedCount } = applyReplacements('', findings);
    assertEqual(text, '', 'empty text unchanged');
    assertEqual(appliedCount, 0, 'nothing applied');
});

test('replacement: empty findings returns unchanged', () => {
    const { text, appliedCount } = applyReplacements('Hello world', []);
    assertEqual(text, 'Hello world', 'text unchanged');
    assertEqual(appliedCount, 0, 'nothing applied');
});

test('replacement: finding at start of text', () => {
    const findings = [{ original: 'The', replacement: 'A' }];
    const { text } = applyReplacements('The cat sat.', findings);
    assertEqual(text, 'A cat sat.', 'replacement at start');
});

test('replacement: finding at end of text', () => {
    const findings = [{ original: 'sat.', replacement: 'stood.' }];
    const { text } = applyReplacements('The cat sat.', findings);
    assertEqual(text, 'The cat stood.', 'replacement at end');
});

test('replacement: longer replacement than original', () => {
    const findings = [{ original: 'hi', replacement: 'hello there friend' }];
    const { text } = applyReplacements('Say hi to me.', findings);
    assertEqual(text, 'Say hello there friend to me.', 'longer replacement works');
});

test('replacement: shorter replacement than original', () => {
    const findings = [{ original: 'a very long original phrase', replacement: 'short' }];
    const { text } = applyReplacements('This is a very long original phrase here.', findings);
    assertEqual(text, 'This is short here.', 'shorter replacement works');
});

test('validateVaultPath: allows deeply nested paths', () => {
    assertEqual(validateVaultPath('a/b/c/d/e/f.md'), 'a/b/c/d/e/f.md', 'deep nesting ok');
});

test('validateVaultPath: allows dots in folder names', () => {
    assertEqual(validateVaultPath('v0.3.1/notes.md'), 'v0.3.1/notes.md', 'dots in folders ok');
});

test('mergePatterns: empty everything returns empty', () => {
    assertEqual(getMergedPatternsLogic([], '', []), [], 'empty in empty out');
});

test('cleanFindings: empty array returns empty', () => {
    assertEqual(cleanFindings([]), [], 'empty in empty out');
});

test('selectiveRevert: empty indices does nothing', () => {
    const { revertCount } = selectiveRevertLogic('text', [{ original: 'a', replacement: 'b' }], []);
    assertEqual(revertCount, 0, 'no indices no reverts');
});

// ============================================================================
// Results
// ============================================================================

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}`);
process.exit(failed > 0 ? 1 : 0);
