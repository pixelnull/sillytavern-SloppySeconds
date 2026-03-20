# Changelog

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
