# Changelog

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
- In-place message replacement with full undo support (`/refine-undo`)
- Visual indicators: processing spinner, fix count badges, clean badges
- Findings viewer popup (click badge to see original vs replacement for each fix)
- Session statistics (`/refine-status`)
- Pattern viewer (`/refine-patterns`)
- Debug mode with console logging
- Configurable system prompt override
- Rate limiting to prevent double-trigger on rapid messages

### Slash Commands
- `/refine` — Manual trigger on last AI message
- `/refine-undo` — Undo last refinement
- `/refine-status` — Show session stats
- `/refine-patterns` — Show active pattern list

### Server Plugin
- `/analyze` — AI proxy with extended thinking support
- `/read-patterns` — Read pattern file from Obsidian vault
- `/write-patterns` — Write/update pattern file in Obsidian vault
- `/test` — Test AI proxy connection
- `/obsidian-test` — Test Obsidian connection
