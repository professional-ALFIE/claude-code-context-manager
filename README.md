# Context Cleaner

Claude Code session transcript cleaner. Reduces transcript size by 60-80% while preserving conversation flow.

## What it does

Strips bulky data from `.jsonl` transcript files:
- Thinking blocks, file contents, diffs, stdout/stderr
- Full file paths → filenames only
- Hook progress lines, tool result duplicates

Preserves: conversation text, edit intent, filenames, uuid chain.

## Installation

### 1. Skill (for Claude Code)

Copy the skill folder to your Claude skills directory:

```bash
cp -a .claude/skills/context-cleaner ~/.claude/skills/
```

### 2. SessionStart Hook (recommended)

This hook provides the transcript path to Claude automatically and copies the resume command to your clipboard.

Copy the hook script:

```bash
cp src/contextCleaner_sessionStartHook.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/contextCleaner_sessionStartHook.sh
```

Then register it. Paste the following to your LLM and let it handle the rest:

---

**Paste this to Claude Code:**

> Add a SessionStart hook to my `~/.claude/settings.json`.
> The command should be: `${HOME}/.claude/hooks/contextCleaner_sessionStartHook.sh`
> Don't remove any existing hooks, just add this one.

---

After registration, restart your Claude Code session.

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
