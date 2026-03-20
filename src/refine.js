// ============================================================================
// Refinement Pipeline
// ============================================================================

import {
    chat,
    saveChatConditional,
    updateMessageBlock,
} from '../../../../script.js';
import { getSettings } from '../settings.js';
import {
    processingMessageId, setProcessingMessageId,
    lastProcessedTimestamp, setLastProcessedTimestamp,
    chatGeneration,
    pendingRefine, setPendingRefine,
    sessionStats,
    obsidianPatternsLoaded,
} from './state.js';
import { analyzeText } from './ai.js';
import { loadObsidianPatterns, appendObsidianPatterns } from './patterns.js';
import { showProcessingIndicator, showResultBadge } from './ui.js';

/**
 * Refine a specific message by detecting and replacing slop.
 * @param {number} messageId
 * @param {boolean} [isManual=false] - True when triggered by slash command or UI button
 */
const MAX_RETRIES = 2;
const RETRY_DELAYS = [3000, 8000]; // Exponential backoff

/**
 * Check if an error is transient (worth retrying).
 */
function isTransientError(err) {
    const msg = err.message || '';
    return msg.includes('timed out') || msg.includes('429') || msg.includes('500') ||
        msg.includes('502') || msg.includes('503') || msg.includes('504') ||
        msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
}

export async function refineMessage(messageId, isManual = false, _retryCount = 0) {
    const settings = getSettings();
    let message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    if (!message.mes?.trim()) return; // Skip empty messages

    // Guard: already processing
    if (processingMessageId !== null) {
        if (isManual) toastr.info('Already processing another message — please wait', 'SloppySeconds');
        else if (settings.debugMode) console.log('[SloppySeconds] Skipped — already processing message', processingMessageId);
        return;
    }

    // Guard: rate limit (2s cooldown) — queue for retry instead of dropping
    const cooldownRemaining = 2000 - (Date.now() - lastProcessedTimestamp);
    if (cooldownRemaining > 0) {
        if (isManual) {
            toastr.info('Cooldown active — try again in a moment', 'SloppySeconds');
            return;
        }
        // C3/C4: Queue for retry using send_date as stable key
        if (pendingRefine) clearTimeout(pendingRefine.timer);
        const pendingSendDate = message.send_date;
        const pendingGen = chatGeneration;
        setPendingRefine({
            messageId,
            sendDate: pendingSendDate,
            timer: setTimeout(() => {
                setPendingRefine(null);
                // C4: Bail if chat changed since queuing
                if (pendingGen !== chatGeneration) return;
                // C4: Re-lookup by send_date instead of stale index
                const idx = pendingSendDate
                    ? chat.findIndex(m => m?.send_date === pendingSendDate)
                    : messageId;
                if (idx < 0) return;
                const msg = chat[idx];
                if (msg && !msg.is_user && !msg.is_system && !msg.extra?.sloppy_seconds) {
                    refineMessage(idx);
                }
            }, cooldownRemaining + 100),
        });
        if (settings.debugMode) console.log(`[SloppySeconds] Queued message ${messageId} for retry in ${cooldownRemaining}ms`);
        return;
    }

    setProcessingMessageId(messageId);
    const originalText = message.mes;
    const messageSendDate = message.send_date; // C2: Stable key for re-validation after async gaps
    const gen = chatGeneration; // Capture — checked after async AI call
    const originalMesId = messageId; // B7: Preserve for spinner cleanup on index shift

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

        // Bail if chat changed while we were waiting for AI
        if (gen !== chatGeneration) {
            if (settings.debugMode) console.log('[SloppySeconds] Chat changed during refinement — discarding results');
            showProcessingIndicator(originalMesId, false); // B7: Use original index for cleanup
            return;
        }

        // C2: Re-validate message identity — index may have shifted during async gap
        if (!chat[messageId] || chat[messageId].send_date !== messageSendDate) {
            const newIdx = messageSendDate ? chat.findIndex(m => m?.send_date === messageSendDate) : -1;
            if (newIdx < 0) {
                if (settings.debugMode) console.log('[SloppySeconds] Message no longer exists — discarding results');
                showProcessingIndicator(originalMesId, false); // B7: Use original index for cleanup
                return;
            }
            showProcessingIndicator(originalMesId, false); // B7: Clean up spinner at original position
            messageId = newIdx;
            message = chat[messageId];
            showProcessingIndicator(messageId, true); // B7: Re-add at new position
        }

        // B2: Detect content change (swipe, edit, etc.) during async AI call
        if (message.mes !== originalText && !message.extra?.sloppy_seconds?.original) {
            if (settings.debugMode) console.log('[SloppySeconds] Message content changed during refinement (swipe/edit) — discarding results');
            showProcessingIndicator(messageId, false);
            return;
        }

        sessionStats.messagesProcessed++;

        // H3: Append new patterns before early returns so they're never lost
        if (result.newPatterns && result.newPatterns.length > 0) {
            appendObsidianPatterns(result.newPatterns).catch(err => console.warn('[SloppySeconds] Pattern append failed:', err.message));
        }

        if (!result.findings || result.findings.length === 0) {
            // Clean message — mark as processed to prevent GENERATION_ENDED double-trigger
            sessionStats.cleanMessages++;
            message.extra = message.extra || {};
            message.extra.sloppy_seconds = { findings: [], summary: result.summary || 'Clean', original: null, applied: 0, timestamp: Date.now() };
            showProcessingIndicator(messageId, false);
            showResultBadge(messageId, 0);
            await saveChatConditional();
            if (settings.debugMode) {
                console.log(`[SloppySeconds] Message ${messageId}: clean (${result.summary})`);
            }
            return;
        }

        // Apply replacements — locate all positions first, then apply in
        // reverse order so earlier replacements don't shift later indices.
        let text = originalText;
        let appliedCount = 0;

        // Feature 15: Split findings by confidence threshold
        const threshold = settings.autoApplyThreshold ?? 0.7;
        const confidentFindings = result.findings.filter(f => {
            if (!f.original || !f.replacement) return false;
            const conf = typeof f.confidence === 'number' ? f.confidence : 1.0;
            if (conf < threshold) {
                f._applied = false;
                f._lowConfidence = true;
                return false;
            }
            return true;
        });

        // Pre-locate each finding's position independently (handles out-of-order AI responses),
        // then sort by document position to resolve duplicates in forward order.
        const withPositions = confidentFindings
            .map(f => ({ finding: f, idx: text.indexOf(f.original) }))
            .filter(item => item.idx !== -1);
        withPositions.sort((a, b) => a.idx - b.idx);

        // Deduplicate overlapping matches — walk forward, skip any that overlap a prior match
        const located = [];
        let consumedUntil = 0;
        for (const item of withPositions) {
            if (item.idx < consumedUntil) {
                // Re-search from after last consumed position (handles duplicate substrings)
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

        // Mark findings that weren't in withPositions (no match at all)
        for (const finding of result.findings) {
            if (finding._applied === undefined) {
                finding._applied = false;
                if (settings.debugMode) {
                    console.warn(`[SloppySeconds] Finding not found in text: "${(finding.original || '').substring(0, 50)}..."`);
                }
            }
        }

        // Sort by position descending so replacements don't shift each other
        located.sort((a, b) => b.idx - a.idx);

        for (const { idx, finding } of located) {
            text = text.substring(0, idx) + finding.replacement + text.substring(idx + finding.original.length);
            appliedCount++;
        }

        if (appliedCount === 0) {
            // All findings missed — mark as processed to prevent double-trigger
            // B5+B9: Strip internal flags here too
            const missedFindings = result.findings.map(({ _applied, _lowConfidence, ...rest }) => ({
                ...rest,
                applied: !!_applied,
                lowConfidence: !!_lowConfidence,
            }));
            message.extra = message.extra || {};
            message.extra.sloppy_seconds = { findings: missedFindings, summary: 'All findings missed', original: null, applied: 0, timestamp: Date.now() };
            showProcessingIndicator(messageId, false);
            showResultBadge(messageId, 0);
            await saveChatConditional();
            if (settings.debugMode) {
                console.warn('[SloppySeconds] All findings missed (0 applied)');
            }
            return;
        }

        // Store original for undo and update message.
        // Preserve the true original if this is a re-refinement (don't overwrite with intermediate text).
        message.extra = message.extra || {};
        const trueOriginal = message.extra.sloppy_seconds?.original || originalText;
        // B5+B9: Strip internal flags, persist explicit `applied` boolean for popup rendering
        const cleanFindings = result.findings.map(({ _applied, _lowConfidence, ...rest }) => ({
            ...rest,
            applied: !!_applied,
            lowConfidence: !!_lowConfidence,
        }));
        message.extra.sloppy_seconds = {
            findings: cleanFindings,
            summary: result.summary,
            original: trueOriginal,
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

        if (settings.debugMode) {
            console.log(`[SloppySeconds] Message ${messageId}: ${appliedCount}/${result.findings.length} fixes applied. ${result.summary}`);
        }

        toastr.success(`Fixed ${appliedCount} slop pattern${appliedCount !== 1 ? 's' : ''}`, 'SloppySeconds');
    } catch (err) {
        console.error('[SloppySeconds] Refinement error:', err);

        // Feature 13: Retry with exponential backoff for transient errors
        if (_retryCount < MAX_RETRIES && isTransientError(err) && !isManual) {
            const delay = RETRY_DELAYS[_retryCount] || 8000;
            if (settings.debugMode) console.log(`[SloppySeconds] Transient error, retrying in ${delay}ms (attempt ${_retryCount + 1}/${MAX_RETRIES})`);
            showProcessingIndicator(originalMesId, false); // B7: Use original index
            setProcessingMessageId(null);
            setLastProcessedTimestamp(Date.now());
            setTimeout(() => {
                if (chatGeneration === gen) { // Only retry if chat hasn't changed
                    // B3: Re-resolve by send_date instead of using stale numeric index
                    const retryIdx = messageSendDate
                        ? chat.findIndex(m => m?.send_date === messageSendDate)
                        : messageId;
                    if (retryIdx >= 0) {
                        refineMessage(retryIdx, false, _retryCount + 1).catch(e => console.error('[SloppySeconds] Retry error:', e));
                    }
                }
            }, delay);
            return; // Don't mark as failed yet — retrying
        }

        sessionStats.messagesFailed++;
        // Mark as processed to prevent double-trigger from GENERATION_ENDED
        if (message) {
            message.extra = message.extra || {};
            message.extra.sloppy_seconds = { findings: [], summary: `Error: ${err.message}`, original: null, applied: 0, timestamp: Date.now() };
        }
        showProcessingIndicator(originalMesId, false); // B7: Use original index
        // Feature 6: Detailed error with context and suggestions
        const mode = settings.connectionMode;
        const model = settings.model || 'unknown';
        const timeoutSec = Math.round((settings.timeout || 60000) / 1000);
        let suggestion = '';
        if (err.message.includes('timed out')) {
            suggestion = `\nTry: increase timeout (currently ${timeoutSec}s), disable thinking budget, or switch connection mode.`;
        } else if (err.message.includes('CORS proxy')) {
            suggestion = '\nTry: set enableCorsProxy: true in config.yaml and restart ST.';
        } else if (err.message.includes('non-JSON')) {
            suggestion = `\nTry: switch to a different model or connection mode. Current: ${mode}/${model}.`;
        } else if (err.message.includes('No connection profile')) {
            suggestion = '\nTry: select a profile in SloppySeconds settings.';
        }
        toastr.warning(`Refinement failed (${mode}, ${model}): ${err.message}${suggestion}`, 'SloppySeconds', { timeOut: 8000 });
    } finally {
        // C1: Guarantee lock release even if catch block throws
        try {
            setProcessingMessageId(null);
            setLastProcessedTimestamp(Date.now());
        } catch { /* lock release must not throw */ }
    }
}

/**
 * Undo the last refinement on a message.
 * @param {number} messageId
 */
export async function undoRefinement(messageId) {
    if (processingMessageId === messageId) {
        toastr.warning('Cannot undo while this message is being refined', 'SloppySeconds');
        return;
    }

    // H2: Clear pending retry for this message so undo isn't immediately reversed
    if (pendingRefine && pendingRefine.messageId === messageId) {
        clearTimeout(pendingRefine.timer);
        setPendingRefine(null);
    }

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

/**
 * Feature 9: Selectively revert specific findings by index.
 * Replaces the AI's replacement back with the original substring for unchecked findings.
 * @param {number} messageId
 * @param {number[]} findingIndices - Indices into the findings array to revert
 */
export async function selectiveRevert(messageId, findingIndices) {
    const message = chat[messageId];
    const data = message?.extra?.sloppy_seconds;
    if (!data?.findings || !data.original) {
        toastr.info('No refinement data to revert', 'SloppySeconds');
        return;
    }

    let text = message.mes;
    let revertCount = 0;

    for (const idx of findingIndices) {
        const finding = data.findings[idx];
        if (!finding?.original || !finding?.replacement) continue;
        // Replace the AI's replacement back with the original
        const pos = text.indexOf(finding.replacement);
        if (pos !== -1) {
            text = text.substring(0, pos) + finding.original + text.substring(pos + finding.replacement.length);
            finding.reverted = true; // B10: Mark as reverted so popup shows correct state
            revertCount++;
        }
    }

    if (revertCount === 0) {
        toastr.info('No changes to revert (replacements not found in current text)', 'SloppySeconds');
        return;
    }

    message.mes = text;
    data.applied = Math.max(0, (data.applied || 0) - revertCount);

    // Re-render
    updateMessageBlock(messageId, message);
    showResultBadge(messageId, data.applied);
    await saveChatConditional();

    toastr.info(`Reverted ${revertCount} fix${revertCount !== 1 ? 'es' : ''} (${data.applied} remaining)`, 'SloppySeconds');
}
