// ============================================================================
// Centralized Mutable State
// ============================================================================
// ES module pattern: state is exported as live bindings.
// Only this module can reassign `let` variables — external modules use setters.

/** Currently processing message ID (null = idle) */
export let processingMessageId = null;
export function setProcessingMessageId(v) { processingMessageId = v; }

/** Timestamp of last completed refinement (rate limiting) */
export let lastProcessedTimestamp = 0;
export function setLastProcessedTimestamp(v) { lastProcessedTimestamp = v; }

/** Increments on every CHAT_CHANGED — stale refinements check this before writing */
export let chatGeneration = 0;
export function incrementChatGeneration() { chatGeneration++; }

/** Queued message for retry after rate-limit cooldown */
export let pendingRefine = null;
export function setPendingRefine(v) { pendingRefine = v; }

/** Session stats */
export const sessionStats = {
    messagesProcessed: 0,
    totalFindings: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cleanMessages: 0,
    messagesFailed: 0,
};

export function resetSessionStats() {
    sessionStats.messagesProcessed = 0;
    sessionStats.totalFindings = 0;
    sessionStats.totalTokens = 0;
    sessionStats.inputTokens = 0;
    sessionStats.outputTokens = 0;
    sessionStats.cleanMessages = 0;
    sessionStats.messagesFailed = 0;
}

/** Whether a generation is currently streaming (guards against incomplete-message refinement) */
export let isStreaming = false;
export function setIsStreaming(v) { isStreaming = v; }

/** Cached Obsidian patterns (loaded once, updated on new discoveries) */
export let obsidianPatterns = [];
export function setObsidianPatterns(v) { obsidianPatterns = v; }

export let obsidianPatternsLoaded = false;
export function setObsidianPatternsLoaded(v) { obsidianPatternsLoaded = v; }
