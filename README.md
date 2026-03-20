# SloppySeconds

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that catches AI-generated slop after every message and surgically rewrites it. Dead metaphors, purple prose, hedging, repetition, emotional telling, AI-signature constructions — the patterns that make AI writing sound like AI writing.

The second pass catches what the first one missed.

## How It Works

Every time the AI generates a message, SloppySeconds sends the prose through a second AI pass that:

1. Scans against 104 known slop patterns (community-sourced, see below)
2. Compares against recent chat history to catch cross-message repetition
3. Identifies and surgically replaces only the bad phrases — not a rewrite, a cleanup
4. Stores the original for instant undo

Each finding includes a confidence score and a writing craft explanation so you can learn what makes it slop and why the replacement is better.

## Installation

Use SillyTavern's built-in extension installer:

1. Open SillyTavern → Extensions → Install Extension
2. Paste the Git URL: `https://github.com/pixelnull/sillytavern-SloppySeconds`
3. Click Install

Or install manually by cloning into `SillyTavern/public/scripts/extensions/third-party/sillytavern-SloppySeconds/`. Restart SillyTavern after. No server plugin needed.

### Requirements

- SillyTavern (latest staging)
- Any AI model via ST Connection Manager profile (Anthropic, OpenAI, OpenRouter, local, etc.)
- **Optional:** `enableCorsProxy: true` in `config.yaml` (only needed for proxy connection mode)
- **Optional:** [Obsidian](https://obsidian.md/) + [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) for pattern persistence

## Setup

1. Extensions → SloppySeconds → Enable
2. Pick a connection mode:
   - **Profile** (recommended): Select any ST Connection Manager profile. Works with Anthropic, OpenAI, OpenRouter, local models — anything that returns JSON.
   - **Proxy**: Point at any Anthropic-compatible endpoint (e.g. `http://localhost:42069`). Supports extended thinking budget control. Requires `enableCorsProxy: true` in `config.yaml`.
3. Hit "Test AI Connection" to verify
4. Optional: Enable Obsidian integration for persistent pattern learning

## Features

### Core
- **Auto-refine** on every AI message (toggleable)
- **Extended thinking** for thorough analysis (proxy mode)
- **Surgical edits** — only the flagged phrases change, everything else stays
- **Instant undo** — `/ss-undo` or click the badge

### Detection
- **104 built-in patterns** across 10 categories, community-sourced (see Pattern Library below)
- **7 toggleable categories**: cliches, purple prose, hedging, repetition, cross-message, tell-not-show, AI signatures
- **Cross-message detection** using recent chat context — catches the AI repeating itself across messages
- **Confidence scoring** — low-confidence findings shown but not auto-applied (threshold configurable)

### Review & Control
- **Findings popup** — click any badge to see every change with before/after, pattern category, confidence %, and craft explanation
- **Selective revert** — uncheck individual fixes to revert them while keeping others
- **Before/after diff view** — collapsible side-by-side with highlighted changes
- **Batch refinement** — `/ss-batch 10` to refine the last 10 unrefined messages

### Reliability
- **Retry with backoff** — transient errors (429, 5xx, timeouts) retry automatically
- **Streaming guard** — won't refine incomplete messages during streaming
- **Chat switch protection** — discards stale results if you switch chats during analysis
- **Swipe protection** — detects content changes and bails gracefully

### Obsidian Integration
- Maintains a growing pattern file in your vault (default: `SloppySeconds/Slop Patterns.md`)
- AI-discovered patterns automatically appended after each refinement
- Seed command writes curated starter patterns to your vault
- Patterns merge with built-in + custom lists (deduplicated, case-insensitive)

### Monitoring
- **Cost tracking** — `/ss-status` shows input/output tokens, estimated cost, success rate
- **Health check** — `/ss-health` validates AI connection, Obsidian, token budgets, patterns
- **Debug mode** — detailed console logging for troubleshooting

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ss-refine [n]` | Refine last AI message (or message at index N) |
| `/ss-detect` | Detect only — show findings without applying |
| `/ss-undo` | Undo the last refinement |
| `/ss-batch [n]` | Batch refine last N unrefined messages (default: 5) |
| `/ss-status` | Session stats, token usage, estimated cost |
| `/ss-patterns` | Show all active patterns |
| `/ss-health` | Configuration health check |

## Pattern Library

Ships with 104 curated slop patterns sourced from:

- [Sukino/SillyTavern Banned Tokens](https://huggingface.co/Sukino/SillyTavern-Settings-and-Presets) — 259 community-curated phrases for roleplay
- [antislop-sampler](https://github.com/sam-paech/antislop-sampler) — 519 statistically overrepresented LLM phrases
- [slop-forensics](https://github.com/sam-paech/slop-forensics) — quantitative LLM vs human writing analysis
- [tropes.fyi](https://tropes.fyi/tropes-md) — structural and tonal LLM tropes
- r/SillyTavern and r/LocalLLaMA community discussions

Patterns are organized into 10 subcategories: dead metaphors, purple prose, hedging/filler, eyes/gaze, voice/speech, physical reactions, emotional telling, AI signatures, narrative tics, and cross-message repetition.

Three layers of patterns merge at runtime:
1. **Built-in** (104 defaults, updated via settings migration)
2. **Custom** (user textarea, one per line)
3. **Obsidian** (vault file, auto-updated with AI discoveries)

## Connection Modes

| Mode | Thinking | Setup | Best For |
|------|----------|-------|----------|
| **Profile** (default) | Backend-managed | Select any CM profile | Any provider — Anthropic, OpenAI, OpenRouter, local models |
| **Proxy** | Full budget control | `enableCorsProxy: true` + proxy URL | Direct Anthropic API, claude-code-proxy |

## Architecture

```
index.js              Entry point (~150 lines): init, events, badge handler
settings.js           Settings, defaults, migration, system prompt
src/
  state.js            Centralized mutable state + setters
  ai.js               AI connection (profile + proxy), chat context, analysis
  refine.js           Refinement pipeline: replace, undo, selective revert
  patterns.js         Pattern merging, Obsidian load/append/seed
  ui.js               Badges, spinners, findings popup, diff view
  commands.js         All /ss-* slash commands
  settings-ui.js      Settings panel wiring + validation
  proxy-api.js        CORS bridge for Anthropic API
  obsidian-api.js     Direct browser → Obsidian REST API
```

## License

MIT
