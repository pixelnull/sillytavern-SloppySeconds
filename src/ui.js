// ============================================================================
// UI Indicators & Helpers
// ============================================================================

import { chat } from '../../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';

/**
 * Find the last AI message matching an optional predicate.
 * @param {function} [predicate] - Extra filter (receives message, index). Defaults to any AI message.
 * @returns {{index: number, message: object}|null}
 */
export function findLastAiMessage(predicate) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && !msg.is_user && !msg.is_system) {
            if (!predicate || predicate(msg, i)) return { index: i, message: msg };
        }
    }
    return null;
}

/**
 * Build findings popup HTML.
 * @param {string} title - Popup heading text
 * @param {Array} findings - Array of finding objects
 * @param {string} summary - Summary text
 * @param {Object} [options]
 * @param {string[]} [options.newPatterns] - Newly discovered patterns to display
 * @param {boolean} [options.showAppliedStatus=false] - Show applied/unapplied markers
 * @returns {string} HTML string
 */
export function buildFindingsHtml(title, findings, summary, options = {}) {
    let html = `<h3>SloppySeconds — ${escapeHtml(title)}</h3>`;
    html += `<p><em>${escapeHtml(summary)}</em></p><hr>`;

    for (let i = 0; i < findings.length; i++) {
        const finding = findings[i];
        // B5: Use persisted `applied`/`lowConfidence` fields (or legacy `_applied`/`_lowConfidence` for compat)
        const notApplied = options.showAppliedStatus && (finding.applied === false || finding._applied === false);
        const isLowConf = finding.lowConfidence || finding._lowConfidence;
        const isReverted = finding.reverted; // B10
        const dimmed = notApplied || isLowConf || isReverted;
        const wasApplied = !notApplied && !isLowConf && !isReverted;
        html += `<div class="ss_finding"${dimmed ? ' style="opacity: 0.6;"' : ''}>`;

        // Feature 9: Checkbox for selective revert (only for applied findings in review mode)
        if (options.showAppliedStatus && wasApplied && finding.original && finding.replacement) {
            html += `<label class="checkbox_label ss_finding_check" style="margin-bottom: 4px;"><input type="checkbox" class="checkbox ss_revert_check" data-idx="${i}" checked> <small>Keep this fix</small></label>`;
        }

        // Pattern + confidence badge
        const conf = typeof finding.confidence === 'number' ? finding.confidence : null;
        const confBadge = conf !== null ? ` <span class="ss_conf_badge" style="color: ${conf >= 0.8 ? '#4caf50' : conf >= 0.5 ? '#ff9800' : '#f44336'}">(${Math.round(conf * 100)}%)</span>` : '';
        html += `<div class="ss_finding_pattern"><strong>Pattern:</strong> ${escapeHtml(finding.pattern || 'unknown')}${confBadge}`;
        if (notApplied && !isLowConf && !isReverted) html += ' <em>(not found in text)</em>';
        if (isLowConf) html += ' <em>(below confidence threshold — not applied)</em>';
        if (isReverted) html += ' <em>(reverted by user)</em>';
        html += `</div>`;

        html += `<div class="ss_finding_original"><strong>Original:</strong> <del>${escapeHtml(finding.original)}</del></div>`;
        html += `<div class="ss_finding_replacement"><strong>${dimmed ? 'Suggestion' : 'Replacement'}:</strong> <ins>${escapeHtml(finding.replacement)}</ins></div>`;

        // Feature 12: Writing craft explanation
        if (finding.explanation) {
            html += `<div class="ss_finding_explanation" style="font-size: 0.85em; opacity: 0.7; margin-top: 4px; font-style: italic;">💡 ${escapeHtml(finding.explanation)}</div>`;
        }

        html += `</div><hr>`;
    }

    if (options.newPatterns && options.newPatterns.length > 0) {
        html += `<h4>New patterns discovered:</h4>`;
        html += options.newPatterns.map(p => `<div>• ${escapeHtml(p)}</div>`).join('');
    }

    return html;
}

/**
 * Show/hide processing spinner on a message.
 */
export function showProcessingIndicator(messageId, show) {
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
 * Uses message.send_date as a stable key so badge clicks resolve correctly
 * even after message deletion/reorder shifts array indices.
 */
export function showResultBadge(messageId, fixCount) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    mesEl.find('.ss_result_badge').remove();

    const message = chat[messageId];
    const msgKey = message?.send_date || messageId;

    if (fixCount > 0) {
        // B15: Use jQuery .attr() to safely set data attribute (avoids HTML injection from string dates)
        const badge = $('<div class="ss_result_badge ss_has_fixes" title="Click to view changes"></div>')
            .attr('data-ss-key', msgKey)
            .text(`${fixCount} fix${fixCount !== 1 ? 'es' : ''}`);
        mesEl.find('.mes_buttons').append(badge);
    } else if (getSettings().showCleanBadges) {
        mesEl.find('.mes_buttons').append('<div class="ss_result_badge ss_clean" title="No slop found">clean</div>');
    }
}

/**
 * Show a popup with the findings detail for a message.
 * Returns {result, uncheckedIndices} so callers can handle undo/revert.
 * B6: Captures checkbox state BEFORE the popup closes to avoid reading stale DOM.
 * @param {number} messageId
 * @returns {Promise<{result: number, uncheckedIndices: number[]}|null>}
 */
export async function showFindingsPopup(messageId) {
    const message = chat[messageId];
    const data = message?.extra?.sloppy_seconds;
    if (!data) return null;

    const title = `${data.applied} fix${data.applied !== 1 ? 'es' : ''}`;
    let html = buildFindingsHtml(title, data.findings, data.summary, { showAppliedStatus: true });

    // Feature 2: Before/After diff view
    if (data.original && data.applied > 0) {
        html += buildDiffHtml(data.original, message.mes, data.findings);
    }

    // B1: Use okButton='Close' so the default OK button doesn't collide with Undo All.
    // Custom buttons use result values 10/11 to avoid any collision with POPUP_RESULT constants.
    const popupOptions = { wide: true, okButton: 'Close' };

    // Feature 1: Undo button + Feature 9: Selective revert button
    if (data.original) {
        popupOptions.customButtons = [
            { text: 'Undo All', result: 10, classes: ['menu_button'] },
        ];
        // Only show selective revert if there were applied findings
        if (data.applied > 1) {
            popupOptions.customButtons.push(
                { text: 'Revert Unchecked', result: 11, classes: ['menu_button'] },
            );
        }
    }

    // B6: Capture checkbox state synchronously on button click, before popup close animation
    let capturedUnchecked = [];
    const origResult = await callGenericPopup(html, POPUP_TYPE.TEXT, '', popupOptions);

    // B6: Read checkboxes immediately after button click resolves (popup still in DOM)
    if (origResult === 11) {
        $('.ss_revert_check').each(function () {
            if (!$(this).is(':checked')) {
                const idx = parseInt($(this).data('idx'), 10);
                if (!isNaN(idx)) capturedUnchecked.push(idx);
            }
        });
    }

    return { result: origResult, uncheckedIndices: capturedUnchecked };
}

/**
 * Build a collapsible before/after diff section for the findings popup.
 * @param {string} originalText - The original text before refinement
 * @param {string} refinedText - The text after refinement
 * @param {Array} findings - Array of finding objects
 * @returns {string} HTML string
 */
function buildDiffHtml(originalText, refinedText, findings) {
    // Highlight changes in the original text
    let highlightedOriginal = escapeHtml(originalText);
    let highlightedRefined = escapeHtml(refinedText);

    // Sort findings by original length descending to avoid partial matches on shorter substrings
    const sortedFindings = [...findings]
        .filter(f => f.original && f.replacement)
        .sort((a, b) => b.original.length - a.original.length);

    for (const f of sortedFindings) {
        const escapedOriginal = escapeHtml(f.original);
        const escapedReplacement = escapeHtml(f.replacement);
        // B13: Use replaceAll to highlight ALL occurrences, not just the first
        // B14: Use function replacer to avoid $ replacement pattern interpretation
        highlightedOriginal = highlightedOriginal.replaceAll(
            escapedOriginal,
            () => `<span class="ss_diff_removed">${escapedOriginal}</span>`,
        );
        highlightedRefined = highlightedRefined.replaceAll(
            escapedReplacement,
            () => `<span class="ss_diff_added">${escapedReplacement}</span>`,
        );
    }

    return `
        <div class="ss_diff_section">
            <details>
                <summary><strong>Full Before/After Diff</strong></summary>
                <div class="ss_diff_container">
                    <div class="ss_diff_pane">
                        <div class="ss_diff_label">Original</div>
                        <div class="ss_diff_text">${highlightedOriginal}</div>
                    </div>
                    <div class="ss_diff_pane">
                        <div class="ss_diff_label">Refined</div>
                        <div class="ss_diff_text">${highlightedRefined}</div>
                    </div>
                </div>
            </details>
        </div>`;
}

/**
 * Inject result badges on chat load for previously refined messages.
 */
export function injectBadgesOnLoad() {
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sloppy_seconds) {
            showResultBadge(i, chat[i].extra.sloppy_seconds.applied || 0);
        }
    }
}
