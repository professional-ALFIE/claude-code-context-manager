# Context Cleaner

Claude Code session transcript cleaner. Reduces transcript size by 60-80% while preserving conversation flow.

## What it does

Strips bulky data from `.jsonl` transcript files:
- Thinking blocks, file contents, diffs, stdout/stderr
- Full file paths → filenames only
- Hook progress lines, tool result duplicates

Preserves: conversation text, edit intent, filenames, uuid chain.

### Manual marking

Wrap any part of your prompt with `<clean>...</clean>` tags to mark it for deletion on the next clean. Useful for pasting large text that you don't need in future context.

```
<clean>paste your large content here</clean>
```

## Installation

### Quick Install (Recommended)

```bash
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash
```

This installs the skill and scripts to `~/.claude/skills/context-cleaner/`.

### SessionStart Hook (Required)

This hook is **required** — it provides the transcript path to Claude and copies the resume command to your clipboard. Without it, Claude cannot locate the transcript file.

After running the install script, register the hook in `~/.claude/settings.json`. Add the `SessionStart` entry to the `hooks` object (don't remove existing hooks):

```json
{"SessionStart":[{"hooks":[{"type":"command","command":"${HOME}/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh"}]}]}
```

After registration, restart your Claude Code session.

### Paste-to-Claude Install (Alternative)

Copy the block below and paste it into Claude Code. It will handle everything automatically.

```
Install the context-cleaner skill from this repo: https://github.com/professional-ALFIE/context-cleaner-skill

Step 1 - Run the install script:
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash

Step 2 - Add this SessionStart hook entry to ~/.claude/settings.json inside the "hooks" object. Do NOT remove any existing hooks:
{"SessionStart":[{"hooks":[{"type":"command","command":"${HOME}/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh"}]}]}

After all steps, tell me to restart the session.
```

## Usage

### Via Skill

Just tell Claude: "context clean해줘" or "transcript 정리해줘"

### Via CLI

```bash
./~/.claude/skills/context-cleaner/scripts/context-cleaner.py /path/to/session.jsonl
```

### Resume cleaned session

```bash
claude --resume <new_session_id> --verbose
```

The `--verbose` flag lets you see the SessionStart hook output in the terminal.

## Requirements

- Python 3
- `jq` (for the hook script)
- macOS (pbcopy for clipboard - hook only)
