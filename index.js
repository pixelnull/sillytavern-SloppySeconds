// ============================================================================
// SloppySeconds — Entry Point
// ============================================================================
// Post-generation prose refiner that detects and rewrites AI "slop".
// This file handles initialization, event wiring, and the auto-refine handler.
// All logic is decomposed into src/ modules.

import { chat } from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { getSettings } from './settings.js';
import {
    processingMessageId, setProcessingMessageId,
    pendingRefine, setPendingRefine,
    chatGeneration, incrementChatGeneration,
    setObsidianPatternsLoaded,
    resetSessionStats,
    isStreaming, setIsStreaming,
} from './src/state.js';
import { refineMessage, undoRefinement, selectiveRevert } from './src/refine.js';
import { loadSettingsUI, bindSettingsEvents } from './src/settings-ui.js';
import { registerSlashCommands } from './src/commands.js';
import { injectBadgesOnLoad, showFindingsPopup } from './src/ui.js';

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-SloppySeconds',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        loadSettingsUI();
        bindSettingsEvents();
        registerSlashCommands();

        // Post-generation hook: auto-refine
        const autoRefineHandler = async (messageId, source) => {
            const settings = getSettings();
            if (settings.debugMode) {
                console.log(`[SloppySeconds] Auto-refine event (${source}) for messageId:`, messageId,
                    { enabled: settings.enabled, autoRefine: settings.autoRefine, processingMessageId });
            }
            if (!settings.enabled || !settings.autoRefine) return;
            if (processingMessageId !== null) return;

            // Feature 4: Group chat support — respect refineGroupMessages setting
            if (selected_group && settings.refineGroupMessages === 'none') {
                if (settings.debugMode) console.log('[SloppySeconds] Skipping — group chat refinement disabled');
                return;
            }

            const message = chat[messageId];
            if (!message || message.is_user) return;
            if (message.extra?.sloppy_seconds) return; // Already refined

            await refineMessage(messageId);
        };

        // Feature 7: Track streaming state to avoid refining incomplete messages
        if (event_types.STREAM_TOKEN_RECEIVED) {
            eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
                if (!isStreaming) setIsStreaming(true);
            });
        }

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
            if (type === 'first_message') return; // Skip character greetings
            // Feature 7: Skip during streaming — GENERATION_ENDED will handle it
            if (isStreaming) {
                if (getSettings().debugMode) console.log('[SloppySeconds] Skipping CHARACTER_MESSAGE_RENDERED during stream — will use GENERATION_ENDED');
                return;
            }
            autoRefineHandler(messageId, 'CHARACTER_MESSAGE_RENDERED').catch(err => console.error('[SloppySeconds] Auto-refine error:', err));
        });

        // Fallback: GENERATION_ENDED fires when the stop button is hidden
        // (covers streaming swipes/continues where CHARACTER_MESSAGE_RENDERED
        // may be skipped on error paths). ST emits chat.length as the argument.
        eventSource.on(event_types.GENERATION_ENDED, (numMessages) => {
            setIsStreaming(false); // Feature 7: Reset streaming flag
            const lastIdx = (typeof numMessages === 'number' ? numMessages : chat.length) - 1;
            if (lastIdx < 0) return;
            if (!chat[lastIdx]?.is_user) {
                autoRefineHandler(lastIdx, 'GENERATION_ENDED').catch(err => console.error('[SloppySeconds] Auto-refine error:', err));
            }
        });

        // Clear stale data on swipe so the new message can be re-analyzed
        eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
            const message = chat[messageId];
            if (message?.extra?.sloppy_seconds) {
                delete message.extra.sloppy_seconds;
            }
            $(`.mes[mesid="${messageId}"] .ss_result_badge`).remove();
        });

        // Re-inject badges on chat load
        eventSource.on(event_types.CHAT_CHANGED, () => {
            setObsidianPatternsLoaded(false); // Reload patterns on chat change
            incrementChatGeneration();         // Invalidate in-flight refinements
            setProcessingMessageId(null);      // C1: Clear lock so new chat isn't stuck
            if (pendingRefine) {
                clearTimeout(pendingRefine.timer);
                setPendingRefine(null);
            }
            resetSessionStats();
            $('.ss_result_badge').remove();     // Clear all stale badges
            setTimeout(injectBadgesOnLoad, 300);
        });

        // Click handler for result badges — resolve by send_date key, not mesid
        $(document).on('click', '.ss_result_badge.ss_has_fixes', async function () {
            const msgKey = $(this).data('ss-key');
            if (!msgKey) return;
            // B16: Handle both numeric and string send_date formats
            const numKey = Number(msgKey);
            const idx = chat.findIndex(m => isNaN(numKey) ? m?.send_date === String(msgKey) : m?.send_date === numKey);
            if (idx < 0) return;
            // B21: Capture chatGeneration to detect chat switch during popup
            const genAtClick = chatGeneration;
            // B1: Custom buttons use result 10=Undo All, 11=Revert Unchecked (avoids OK collision)
            // B6: showFindingsPopup returns {result, uncheckedIndices} to capture checkbox state before popup closes
            const popupResult = await showFindingsPopup(idx);
            // B21: Bail if chat changed while popup was open
            if (chatGeneration !== genAtClick) {
                toastr.warning('Chat changed — action cancelled', 'SloppySeconds');
                return;
            }
            // B21: Re-resolve index in case array shifted during popup
            const freshIdx = isNaN(numKey)
                ? chat.findIndex(m => m?.send_date === String(msgKey))
                : chat.findIndex(m => m?.send_date === numKey);
            if (freshIdx < 0) return;
            if (popupResult?.result === 10) {
                await undoRefinement(freshIdx);
            } else if (popupResult?.result === 11) {
                // B6: Checkbox state captured before popup closed
                const uncheckedIndices = popupResult.uncheckedIndices || [];
                if (uncheckedIndices.length > 0) {
                    await selectiveRevert(freshIdx, uncheckedIndices);
                } else {
                    toastr.info('All findings are checked — nothing to revert', 'SloppySeconds');
                }
            }
        });

        console.log('[SloppySeconds] Client extension initialized');
    } catch (err) {
        console.error('[SloppySeconds] Initialization failed:', err);
    }
});
