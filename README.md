# SloppySeconds

A SillyTavern extension that automatically detects and rewrites AI-generated "slop" — cliched, repetitive, and purple prose patterns — using Claude Sonnet with extended thinking.

The second pass catches what the first one missed.

## What It Does

After every AI message, SloppySeconds:

1. **Detects** slop patterns (dead metaphors, purple prose, filler, echo/repetition, tell-not-show, AI-signature constructions)
2. **Rewrites** only the flagged bits — minimal surgical edits, not a full rewrite
3. **Replaces** the message in-place (with undo support)
4. **Learns** new patterns over time via Obsidian vault integration

## Features

- **Auto-refine**: Runs automatically after every AI message (toggleable)
- **Extended thinking**: Uses Sonnet's thinking mode for thorough analysis
- **Surgical edits**: Only rewrites the bad parts, preserving voice and style
- **Confidence filtering**: Low-confidence findings shown but not auto-applied (configurable threshold)
- **7 toggleable categories**: Cliches, purple prose, hedging, repetition, cross-message, tell-not-show, AI signatures
- **Growing pattern list**: AI discovers new slop patterns and saves them to Obsidian
- **Selective undo**: Click a badge to see findings, uncheck individual fixes to revert while keeping others
- **Before/after diff view**: Collapsible side-by-side comparison with highlighted changes
- **Batch refinement**: Refine multiple past messages at once with `/ss-batch`
- **Dual connection**: Proxy mode (with thinking) or ST Connection Manager profiles
- **Group chat support**: Refine all characters or disable auto-refine in groups
- **Visual indicators**: Spinner during processing, badges showing fix counts, writing craft explanations
- **Retry with backoff**: Transient errors automatically retry (429, 5xx, timeouts)
- **Health check**: `/ss-health` validates your entire configuration end-to-end
- **Cost tracking**: `/ss-status` shows token usage, estimated cost, and success rate

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (latest staging)
- An Anthropic-compatible API endpoint (claude-code-proxy or direct API)
- `enableCorsProxy: true` in SillyTavern's `config.yaml` (required for proxy AI connection mode)
- **Optional**: [Obsidian](https://obsidian.md/) + [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) for pattern persistence

## Installation

Clone or symlink `sillytavern-SloppySeconds/` into:
```
SillyTavern/public/scripts/extensions/third-party/sillytavern-SloppySeconds/
```

Restart SillyTavern after installation. No server plugin needed.

## Configuration

1. Open SillyTavern settings → Extensions → SloppySeconds
2. Enable the extension
3. Configure your AI connection:
   - **Proxy mode** (recommended): Enter your proxy URL (e.g., `http://localhost:42069`)
   - **Profile mode**: Select a Connection Manager profile
4. Set the model (default: `claude-sonnet-4-20250514`)
5. Adjust thinking budget (default: 10,000 tokens). **Note:** In profile mode, the thinking budget acts as a toggle — any value > 0 enables thinking, but the exact budget is managed by the backend.
6. **Optional**: Enable Obsidian integration for persistent pattern learning

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ss-refine [n]` | Manually trigger refinement (optionally on message index N) |
| `/ss-detect` | Detect slop without applying changes (shows findings popup) |
| `/ss-undo` | Undo the last refinement (restore original text) |
| `/ss-batch [n]` | Batch refine the last N unrefined AI messages (default: 5) |
| `/ss-status` | Show session statistics, token usage, and estimated cost |
| `/ss-patterns` | Show all active slop patterns |
| `/ss-health` | Run configuration health check |

## Slop Categories

SloppySeconds detects seven categories of AI-generated slop (each toggleable in settings):

1. **Dead metaphors & cliches** — "a testament to", "the air crackled", "a symphony of"
2. **Purple prose & melodrama** — "ministrations", "orbs" (for eyes), "pupils blown wide"
3. **Filler & hedging** — "couldn't help but", "found herself [verb]ing", "something akin to"
4. **Echo/repetition** — Same word/phrase/structure used too close together
5. **Cross-message repetition** — Patterns repeated across multiple AI messages (uses chat context)
6. **Tell-not-show emotional labels** — "fear gripped him", "a wave of sadness washed over"
7. **AI-signature constructions** — "[noun] that spoke of [abstract]", "the [noun] hung heavy"

## Built-in Pattern Library

Ships with 104 curated slop patterns across 10 subcategories (dead metaphors, purple prose, hedging, eyes/gaze, voice/speech, physical reactions, emotional telling, AI signatures, narrative tics). Patterns are sourced from:

- [Sukino/SillyTavern Banned Tokens](https://huggingface.co/Sukino/SillyTavern-Settings-and-Presets) — 259 community-curated phrases for roleplay
- [antislop-sampler](https://github.com/sam-paech/antislop-sampler) — 519 statistically overrepresented LLM phrases
- [slop-forensics](https://github.com/sam-paech/slop-forensics) — Quantitative analysis of LLM writing vs human baselines
- [tropes.fyi](https://tropes.fyi/tropes-md) — Structural and tonal LLM writing tropes
- r/SillyTavern and r/LocalLLaMA community discussions

Add your own via the custom patterns textarea or Obsidian integration. The AI also discovers new patterns automatically during refinement.

## Obsidian Integration

When enabled, SloppySeconds maintains a pattern file in your Obsidian vault (default: `SloppySeconds/Slop Patterns.md`). New patterns discovered by the AI during refinement are automatically appended, building a growing reference that improves detection over time.

## How It Works

```
AI generates message
  → CHARACTER_MESSAGE_RENDERED or GENERATION_ENDED fires
  → Guards: streaming check, lock check, cooldown check, group chat check
  → Loads merged patterns (built-in + custom + Obsidian)
  → Builds chat context (recent AI messages for cross-message detection)
  → Sends prose + patterns + context to AI with thinking enabled
  → AI returns JSON: { findings[], newPatterns[], summary }
  → Filters by confidence threshold (low-confidence shown but not applied)
  → Applies find/replace with overlap deduplication and position tracking
  → Stores original for undo, persists applied/confidence status per finding
  → Updates Obsidian pattern list with new discoveries
  → Shows badge with fix count (click for full findings + diff view)
```

## License

MIT
