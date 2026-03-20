// ============================================================================
// Slash Commands
// ============================================================================

import { chat } from '../../../../../script.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';
import { processingMessageId, setProcessingMessageId, chatGeneration, sessionStats, obsidianPatterns, obsidianPatternsLoaded } from './state.js';
import { refineMessage, undoRefinement } from './refine.js';
import { callViaProfile } from './ai.js';
import { callViaCorsBridge } from './proxy-api.js';
import { analyzeText } from './ai.js';
import { obsidianFetch } from './obsidian-api.js';
import { loadObsidianPatterns, getMergedPatterns } from './patterns.js';
import { findLastAiMessage, buildFindingsHtml } from './ui.js';

export function registerSlashCommands() {
    // Feature 8: /ss-refine accepts optional message index argument
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-refine',
        callback: async (_args, messageIndex) => {
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('SloppySeconds is disabled', 'SloppySeconds');
                return '';
            }

            let targetIdx;
            if (messageIndex && messageIndex.trim()) {
                targetIdx = parseInt(messageIndex.trim(), 10);
                if (isNaN(targetIdx) || targetIdx < 0 || targetIdx >= chat.length) {
                    toastr.warning(`Invalid message index: ${messageIndex}`, 'SloppySeconds');
                    return '';
                }
                const msg = chat[targetIdx];
                if (!msg || msg.is_user || msg.is_system) {
                    toastr.warning(`Message ${targetIdx} is not an AI message`, 'SloppySeconds');
                    return '';
                }
            } else {
                const target = findLastAiMessage();
                if (!target) {
                    toastr.info('No AI message found to refine', 'SloppySeconds');
                    return '';
                }
                targetIdx = target.index;
            }

            await refineMessage(targetIdx, true);
            return `Refined message ${targetIdx}`;
        },
        helpString: 'Manually trigger slop detection and refinement. Optionally pass a message index: /ss-refine 5',
        returns: 'Refinement result',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-detect',
        callback: async () => {
            if (processingMessageId !== null) {
                toastr.info('A refinement is in progress — please wait', 'SloppySeconds');
                return '';
            }
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('SloppySeconds is disabled', 'SloppySeconds');
                return '';
            }
            const target = findLastAiMessage();
            if (!target) {
                toastr.info('No AI message found', 'SloppySeconds');
                return '';
            }

            // B19: Acquire lock to prevent concurrent AI calls with auto-refine
            setProcessingMessageId(target.index);
            toastr.info('Analyzing for slop...', 'SloppySeconds');

            if (settings.obsidianEnabled && !obsidianPatternsLoaded) {
                await loadObsidianPatterns();
            }

            try {
                const result = await analyzeText(target.message.mes, target.index);

                if (!result.findings || result.findings.length === 0) {
                    toastr.success('No slop detected — message is clean!', 'SloppySeconds');
                    return 'Clean';
                }

                const title = `${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''} (detect only, not applied)`;
                const html = buildFindingsHtml(title, result.findings, result.summary, { newPatterns: result.newPatterns });
                callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true });
                return `Detected ${result.findings.length} findings`;
            } catch (err) {
                toastr.warning(`Detection failed: ${err.message}`, 'SloppySeconds');
                return '';
            } finally {
                setProcessingMessageId(null); // B19: Release lock
            }
        },
        helpString: 'Detect slop in the last AI message without applying changes. Shows findings in a popup.',
        returns: 'Detection result',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-undo',
        callback: async () => {
            const target = findLastAiMessage((msg) => !!msg.extra?.sloppy_seconds?.original);
            if (!target) {
                toastr.info('No refined message found to undo', 'SloppySeconds');
                return '';
            }
            await undoRefinement(target.index);
            return `Undid refinement on message ${target.index}`;
        },
        helpString: 'Undo the last SloppySeconds refinement, restoring the original text.',
        returns: 'Undo result',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-status',
        callback: async () => {
            const allPatterns = getMergedPatterns();
            // Feature 5: Cost & token dashboard
            const avgTokensPerMsg = sessionStats.messagesProcessed > 0
                ? Math.round(sessionStats.totalTokens / sessionStats.messagesProcessed)
                : 0;
            const costPerMillion = { input: 3, output: 15 }; // Sonnet pricing $/1M tokens
            const estimatedCost = (
                (sessionStats.inputTokens || 0) * costPerMillion.input / 1_000_000 +
                (sessionStats.outputTokens || 0) * costPerMillion.output / 1_000_000
            );
            const costStr = estimatedCost > 0 ? `$${estimatedCost.toFixed(4)}` : '—';
            // Feature 18: Failure rate
            const successRate = sessionStats.messagesProcessed > 0
                ? Math.round(((sessionStats.messagesProcessed - (sessionStats.messagesFailed || 0)) / sessionStats.messagesProcessed) * 100)
                : 100;
            const failColor = successRate < 80 ? '#f44336' : '#4caf50';

            const html = `
                <h3>SloppySeconds — Session Stats</h3>
                <table>
                    <tr><td><strong>Messages processed:</strong></td><td>${sessionStats.messagesProcessed}</td></tr>
                    <tr><td><strong>Clean messages:</strong></td><td>${sessionStats.cleanMessages}</td></tr>
                    <tr><td><strong>Total fixes applied:</strong></td><td>${sessionStats.totalFindings}</td></tr>
                    <tr><td><strong>Success rate:</strong></td><td style="color: ${failColor}">${successRate}% (${sessionStats.messagesFailed || 0} failed)</td></tr>
                    <tr><td colspan="2"><hr></td></tr>
                    <tr><td><strong>Tokens (input):</strong></td><td>${(sessionStats.inputTokens || 0).toLocaleString()}</td></tr>
                    <tr><td><strong>Tokens (output):</strong></td><td>${(sessionStats.outputTokens || 0).toLocaleString()}</td></tr>
                    <tr><td><strong>Tokens (total):</strong></td><td>${sessionStats.totalTokens.toLocaleString()}</td></tr>
                    <tr><td><strong>Avg tokens/message:</strong></td><td>${avgTokensPerMsg.toLocaleString()}</td></tr>
                    <tr><td><strong>Estimated cost:</strong></td><td>${costStr}</td></tr>
                    <tr><td colspan="2"><hr></td></tr>
                    <tr><td><strong>Active patterns:</strong></td><td>${allPatterns.length}</td></tr>
                    <tr><td><strong>Obsidian patterns:</strong></td><td>${obsidianPatterns.length}</td></tr>
                </table>
            `;
            callGenericPopup(html, POPUP_TYPE.TEXT);
            return 'Displayed stats';
        },
        helpString: 'Show SloppySeconds session statistics including token usage and cost.',
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

    // Feature 3: /ss-health — configuration health check
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-health',
        callback: async () => {
            const settings = getSettings();
            const checks = [];

            // Check 1: Extension enabled
            checks.push({
                name: 'Extension enabled',
                ok: settings.enabled,
                detail: settings.enabled ? 'Enabled' : 'Disabled — enable in settings',
            });

            // Check 2: AI connection
            let aiOk = false;
            let aiDetail = '';
            try {
                if (settings.connectionMode === 'profile') {
                    if (!settings.profileId) {
                        aiDetail = 'No profile selected';
                    } else {
                        await callViaProfile('Test. Respond ok.', 'Test.', 32, 10000);
                        aiOk = true;
                        aiDetail = `Profile connected`;
                    }
                } else {
                    await callViaCorsBridge(settings.proxyUrl, settings.model, 'Test. Respond ok.', 'Test.', 32, 0, 10000);
                    aiOk = true;
                    aiDetail = `Proxy connected (${settings.model})`;
                }
            } catch (err) {
                aiDetail = err.message;
            }
            checks.push({ name: `AI connection (${settings.connectionMode})`, ok: aiOk, detail: aiDetail });

            // Check 3: Token budget sanity
            const budgetOk = settings.thinkingBudget === 0 || settings.maxTokens > settings.thinkingBudget;
            checks.push({
                name: 'Token budget',
                ok: budgetOk,
                detail: budgetOk
                    ? `maxTokens=${settings.maxTokens}, thinking=${settings.thinkingBudget}`
                    : `thinkingBudget (${settings.thinkingBudget}) >= maxTokens (${settings.maxTokens}) — will auto-adjust but consider fixing`,
            });

            // Check 4: Obsidian (only if enabled)
            if (settings.obsidianEnabled) {
                let obsOk = false;
                let obsDetail = '';
                try {
                    const result = await obsidianFetch({
                        port: settings.obsidianPort,
                        apiKey: settings.obsidianApiKey,
                        path: '/',
                        timeout: 10000,
                    });
                    if (result.status === 200) {
                        let parsed;
                        try { parsed = JSON.parse(result.data); } catch { parsed = {}; }
                        obsOk = !!parsed.authenticated;
                        obsDetail = parsed.authenticated ? 'Connected & authenticated' : 'Connected but NOT authenticated — check API key';
                    } else {
                        obsDetail = `HTTP ${result.status}`;
                    }
                } catch (err) {
                    obsDetail = err.message;
                }
                checks.push({ name: 'Obsidian connection', ok: obsOk, detail: obsDetail });

                // Check 5: Pattern file path
                const pathOk = settings.patternFile && !settings.patternFile.startsWith('/') && !settings.patternFile.includes('..');
                checks.push({
                    name: 'Pattern file path',
                    ok: pathOk,
                    detail: pathOk ? settings.patternFile : 'Invalid path — must be relative, no ".."',
                });
            }

            // Check 6: Patterns loaded
            const patternsLoaded = getMergedPatterns().length;
            checks.push({
                name: 'Active patterns',
                ok: patternsLoaded > 0,
                detail: `${patternsLoaded} patterns loaded`,
            });

            const html = `
                <h3>SloppySeconds — Health Check</h3>
                <table style="width: 100%;">
                    ${checks.map(c => `
                        <tr>
                            <td style="padding: 4px 8px;">${c.ok ? '&#x2705;' : '&#x274C;'}</td>
                            <td style="padding: 4px 8px;"><strong>${escapeHtml(c.name)}</strong></td>
                            <td style="padding: 4px 8px; font-size: 0.9em; opacity: 0.8;">${escapeHtml(c.detail)}</td>
                        </tr>
                    `).join('')}
                </table>
            `;
            callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true });
            return checks.every(c => c.ok) ? 'All checks passed' : 'Some checks failed';
        },
        helpString: 'Run a configuration health check — validates AI connection, Obsidian, token budgets, and patterns.',
        returns: 'Health check result',
    }));

    // Feature 14: Batch refinement
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ss-batch',
        callback: async (_args, countStr) => {
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('SloppySeconds is disabled', 'SloppySeconds');
                return '';
            }

            const count = parseInt(countStr?.trim(), 10) || 5;
            // B4: Store send_date instead of indices to avoid stale index during long batch
            const targetDates = [];

            // Walk backwards to find unrefined AI messages
            for (let i = chat.length - 1; i >= 0 && targetDates.length < count; i--) {
                const msg = chat[i];
                if (msg && !msg.is_user && !msg.is_system && !msg.extra?.sloppy_seconds) {
                    targetDates.push(msg.send_date);
                }
            }

            if (targetDates.length === 0) {
                toastr.info('No unrefined AI messages found', 'SloppySeconds');
                return '';
            }

            // Process in chronological order (oldest first)
            targetDates.reverse();
            const batchGen = chatGeneration; // B4: Capture to detect chat switch mid-batch
            let attempted = 0;
            let processed = 0;
            let totalFixes = 0;

            toastr.info(`Batch refining ${targetDates.length} message${targetDates.length !== 1 ? 's' : ''}...`, 'SloppySeconds');

            for (const sendDate of targetDates) {
                // B4: Bail if chat changed mid-batch
                if (chatGeneration !== batchGen) {
                    toastr.warning('Chat changed — stopping batch', 'SloppySeconds');
                    break;
                }

                // B4: Re-resolve index by send_date before each iteration
                const idx = chat.findIndex(m => m?.send_date === sendDate);
                if (idx < 0 || chat[idx].extra?.sloppy_seconds) continue; // Already done or deleted

                attempted++;
                toastr.info(`Refining ${attempted}/${targetDates.length}...`, 'SloppySeconds', { timeOut: 2000 });

                try {
                    await refineMessage(idx, true);
                    // B11: Check if refinement actually ran (may bail on lock/cooldown)
                    const data = chat[idx]?.extra?.sloppy_seconds;
                    if (data) {
                        processed++;
                        if (data.applied > 0) totalFixes += data.applied;
                    }
                } catch (err) {
                    console.warn(`[SloppySeconds] Batch: message ${idx} failed:`, err.message);
                }

                // Rate limit: wait 2.5s between messages
                if (attempted < targetDates.length) {
                    await new Promise(r => setTimeout(r, 2500));
                }
            }

            const summaryHtml = `
                <h3>SloppySeconds — Batch Complete</h3>
                <p>Processed <strong>${processed}</strong> message${processed !== 1 ? 's' : ''}, applied <strong>${totalFixes}</strong> fix${totalFixes !== 1 ? 'es' : ''}.</p>
            `;
            callGenericPopup(summaryHtml, POPUP_TYPE.TEXT);
            return `Batch: ${processed} processed, ${totalFixes} fixes`;
        },
        helpString: 'Batch refine the last N unrefined AI messages. Default: 5. Usage: /ss-batch 10',
        returns: 'Batch result',
    }));
}
