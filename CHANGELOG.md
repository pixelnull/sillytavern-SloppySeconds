# Changelog

## 0.3.1-alpha (2026-03-19)

### Bug Fixes (5-Paradigm Audit)
- **CRITICAL:** Default `thinkingBudget` (10000) exceeded `maxTokens` (4096) — Anthropic API rejected every thinking-enabled request. Fixed defaults to `maxTokens: 16384` and added runtime guard to auto-clamp.
- **CRITICAL:** Removed dead server plugin (`SillyTavern/plugins/SloppySeconds/`). Plugin ID was mixed-case (`SloppySeconds`) which failed ST's lowercase-only validation — plugin never loaded. All routes were dead code since v0.3.0 moved to CORS bridge.
- **Fixed:** `response.text()` consumed twice on 404 in CORS bridge — second read threw `TypeError` or returned empty string, losing error info
- **Fixed:** `CHAT_CHANGED` reset `processingMessageId` while refinement was in-flight, allowing the old `finally` block to clobber a new refinement's lock — removed premature reset, `chatGeneration` check handles it
- **Fixed:** Failed refinement didn't set `sloppy_seconds` marker — `GENERATION_ENDED` would re-trigger the same message, creating an infinite retry loop against broken proxies
- **Fixed:** Fence-fallback JSON.parse in `callViaProxy` not wrapped in try/catch — raw `SyntaxError` escaped instead of descriptive error
- **Fixed:** `callViaProfile()` sent OpenAI-specific `include_reasoning`/`reasoning_effort` overrides to all backends — now only applies to OpenAI-compatible profiles
- **Fixed:** Settings version drift — `slopPatterns` array was stuck at install-time values, new patterns added in updates never picked up. Added migration via `settingsVersion`.
- **Fixed:** Obsidian pattern regex truncated patterns containing parentheses — `(.+?)` stopped at first `(`. Now uses greedy match with explicit suffix stripping.
- **Fixed:** Stale badges persisted after swipe/regeneration — now listens for `MESSAGE_SWIPED` to clear `sloppy_seconds` data and badge DOM
- **Fixed:** `_applied` internal flag persisted to chat JSON — now stripped before saving
- **Fixed:** Clean/zero-applied messages not saved to disk — `sloppy_seconds` marker set in memory but `saveChatConditional()` not called, causing wasted re-analysis on reload
- **Fixed:** Spinner not removed when refinement discarded due to chat change during AI call
- **Fixed:** Inconsistent date formats in Obsidian frontmatter `updated` field — standardized to date-only
- **Fixed:** Number inputs displayed stale "abc" text when NaN — now resets to default value
- **Fixed:** `JSON.parse` in `testObsidianConnection` could throw confusing error on malformed 200 response
- **Fixed:** Path traversal validation missed trailing `/..` pattern
- **Fixed:** `GENERATION_ENDED` handler ignored emitted `chat.length` parameter, computed index independently

### Removed
- Deleted `SillyTavern/plugins/SloppySeconds/` server plugin entirely (dead code since v0.3.0)
- Removed unreachable `ok:false` check in `analyzeText` proxy path

## 0.3.0-alpha (2025-03-19)

### Breaking Changes
- **Removed server plugin dependency.** All communication is now client-side. The `server/` directory has been deleted — you can remove `SillyTavern/plugins/SloppySeconds/` entirely.
- Obsidian REST API calls now go directly from the browser (same pattern as DeepLore Enhanced).
- AI proxy calls now route through SillyTavern's built-in CORS proxy at `/proxy/:url(*)`.
- **Requires** `enableCorsProxy: true` in `config.yaml` for proxy AI connection mode. Profile mode is unaffected.

### Improvements
- Simplified installation — no more copying `server/` to `SillyTavern/plugins/`
- Eliminated server-side error handling surface — all errors are now client-side with clear user feedback
- CORS proxy disabled detection — shows specific error message directing user to enable it

---

## 0.2.0-alpha (2025-03-19)

### Bug Fixes (Round 1)
- **Fixed:** Badge click showing findings from wrong message after message deletion/reorder — badges now use stable `send_date` key instead of ephemeral array index
- **Fixed:** Chat corruption when switching chats during active AI refinement — added generation counter to discard stale results
- **Fixed:** Rate-limited messages permanently skipped with no retry — now queues and retries after cooldown
- **Fixed:** Profile mode silently swallowing non-JSON AI responses — now shows warning toast
- **Fixed:** Unhandled async errors in event listeners — added `.catch()` to prevent unhandled rejections
- **Fixed:** Badge injection timing unreliable on slow renders — increased delay and added explicit badge cleanup on chat change
- **Fixed:** Empty chat edge case in GENERATION_ENDED handler
- **Fixed:** README documenting wrong slash command names (`/refine*` → `/ss-*`)

### Bug Fixes (Round 2)
- **Fixed:** Undo during active refinement silently reversed — now blocked with warning toast
- **Fixed:** Test AI Connection button always tested proxy even in profile mode — now tests the active connection mode
- **Fixed:** No client-side timeout on proxy fetch — added AbortController so `processingMessageId` can't get stuck forever
- **Fixed:** Forward-only finding search skipped out-of-order AI results — now pre-locates all findings independently and sorts by document position
- **Fixed:** Clean/zero-applied messages not marked as processed — GENERATION_ENDED could double-trigger the same message, wasting tokens
- **Fixed:** Analyze button and `/ss-detect` could fire concurrent AI requests alongside auto-refine — now blocked when refinement is in progress
- **Fixed:** Re-refinement overwrites true original — undo now always restores the pre-refinement text, even after multiple `/ss-refine` passes
- **Fixed:** Obsidian fetch calls missing HTTP status checks — `loadObsidianPatterns` and `appendObsidianPatterns` now check `response.ok` before parsing JSON
- **Fixed:** `seedObsidianPatterns` showed success toast even when write failed — now checks write response and shows error on failure
- **Fixed:** Empty/whitespace-only messages sent to AI wastefully — now skipped early
- **Fixed:** Disabling "Show clean badges" didn't remove existing clean badges from DOM — now clears them immediately
- **Fixed:** Profile mode model override could send wrong model name to incompatible endpoints — now lets the profile's own model be used
- **Fixed:** Auto-refine triggered on character greetings (`first_message` type) — now skipped

---

## 0.1-alpha (2025-03-15)

Initial release.

### Features
- Post-generation slop detection using Claude Sonnet with extended thinking
- Surgical find/replace — only rewrites flagged prose, not the entire message
- Six slop categories: dead metaphors, purple prose, filler/hedging, echo/repetition, tell-not-show, AI-signature constructions
- Built-in pattern library (18 common slop phrases)
- Custom pattern support (user-defined, newline-separated)
- Obsidian vault integration for persistent AI-discovered pattern learning
- Dual connection modes: proxy (with thinking support) and ST Connection Manager profiles
- Auto-refine toggle (runs on every AI message or manual-only)
- In-place message replacement with full undo support (`/ss-undo`)
- Visual indicators: processing spinner, fix count badges, clean badges
- Findings viewer popup (click badge to see original vs replacement for each fix)
- Session statistics (`/ss-status`)
- Pattern viewer (`/ss-patterns`)
- Debug mode with console logging
- Configurable system prompt override
- Rate limiting to prevent double-trigger on rapid messages

### Slash Commands
- `/ss-refine` — Manual trigger on last AI message
- `/ss-detect` — Detect only (no changes applied)
- `/ss-undo` — Undo last refinement
- `/ss-status` — Show session stats
- `/ss-patterns` — Show active pattern list

### Server Plugin
- `/analyze` — AI proxy with extended thinking support
- `/read-patterns` — Read pattern file from Obsidian vault
- `/write-patterns` — Write/update pattern file in Obsidian vault
- `/test` — Test AI proxy connection
- `/obsidian-test` — Test Obsidian connection
