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

### 0. Paste this to Claude Code

Copy the block below and paste it into Claude Code. It will handle steps 1 and 2 automatically.

```
Install the context-cleaner skill and SessionStart hook from this repo: https://github.com/professional-ALFIE/claude-code-context-manager

Step 1 - Copy the skill folder:
cp -a .claude/skills/context-cleaner ~/.claude/skills/

Step 2 - Copy the hook script and make it executable:
cp src/contextCleaner_sessionStartHook.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/contextCleaner_sessionStartHook.sh

Step 3 - Add this SessionStart hook entry to ~/.claude/settings.json inside the "hooks" object. Do NOT remove any existing hooks:
{"SessionStart":[{"hooks":[{"type":"command","command":"${HOME}/.claude/hooks/contextCleaner_sessionStartHook.sh"}]}]}

After all steps, tell me to restart the session.
```

### Manual installation

If you prefer to install manually, follow steps 1-3 above by hand.

The SessionStart hook is **required** — it provides the transcript path to Claude and copies the resume command to your clipboard. Without it, Claude cannot locate the transcript file.

## Usage

### Via Skill

Just tell Claude: "context clean해줘" or "transcript 정리해줘"

### Via CLI

```bash
python3 ~/.claude/skills/context-cleaner/scripts/context-cleaner.py /path/to/session.jsonl
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
