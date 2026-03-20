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
- **Growing pattern list**: AI discovers new slop patterns and saves them to Obsidian
- **Undo support**: Every refinement can be undone with `/ss-undo`
- **Dual connection**: Proxy mode (with thinking) or ST Connection Manager profiles
- **Visual indicators**: Spinner during processing, badges showing fix counts
- **Findings viewer**: Click any badge to see exactly what was changed and why

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (latest staging)
- An Anthropic-compatible API endpoint (claude-code-proxy or direct API)
- **Optional**: [Obsidian](https://obsidian.md/) + [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) for pattern persistence

## Installation

### Client Extension
Copy or symlink `sillytavern-SloppySeconds/` into:
```
SillyTavern/public/scripts/extensions/third-party/sillytavern-SloppySeconds/
```

### Server Plugin
Copy or symlink `sillytavern-SloppySeconds/server/` into:
```
SillyTavern/plugins/SloppySeconds/
```

Restart SillyTavern after installation.

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
| `/ss-refine` | Manually trigger refinement on the last AI message |
| `/ss-detect` | Detect slop without applying changes (shows findings popup) |
| `/ss-undo` | Undo the last refinement (restore original text) |
| `/ss-status` | Show session statistics |
| `/ss-patterns` | Show all active slop patterns |

## Slop Categories

SloppySeconds detects six categories of AI-generated slop:

1. **Dead metaphors & cliches** — "a testament to", "the air crackled", "a symphony of"
2. **Purple prose & melodrama** — "ministrations", "orbs" (for eyes), "pupils blown wide"
3. **Filler & hedging** — "couldn't help but", "found herself [verb]ing", "something akin to"
4. **Echo/repetition** — Same word/phrase/structure used too close together
5. **Tell-not-show emotional labels** — "fear gripped him", "a wave of sadness washed over"
6. **AI-signature constructions** — "[noun] that spoke of [abstract]", "the [noun] hung heavy"

## Obsidian Integration

When enabled, SloppySeconds maintains a pattern file in your Obsidian vault (default: `SloppySeconds/Slop Patterns.md`). New patterns discovered by the AI during refinement are automatically appended, building a growing reference that improves detection over time.

## How It Works

```
AI generates message
  → CHARACTER_MESSAGE_RENDERED event fires
  → SloppySeconds loads merged patterns (built-in + custom + Obsidian)
  → Sends prose + patterns to Sonnet with extended thinking
  → Sonnet analyzes, returns JSON: { findings[], newPatterns[], summary }
  → Applies find/replace for each finding (surgical, first-occurrence only)
  → Stores original for undo in message metadata
  → Updates Obsidian pattern list with new discoveries
```

## License

MIT
