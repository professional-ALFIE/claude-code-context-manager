---
name: context-cleaner
description: Claude Code transcript cleaner that reduces token usage by 60-80% while preserving conversation flow. Use when the user wants to clean, optimize, or compact a session transcript, reduce context tokens, or prepare a session for efficient resume. Triggers on keywords like context clean, transcript clean, token optimization, session compact, context reduction, effaced session.
---

# Context Cleaner

Transcript cleaning tool that strips bulky tool data (thinking blocks, file contents, diffs, stdout) while preserving conversation flow, edit intent, and filenames.

## Workflow

1. Get the transcript path
2. Run the cleaning script
3. Report results and resume command

## Step 1: Get Transcript Path

Check these sources in order:

1. **SessionStart hook context** - Look for `Transcript:` in the system-reminder at the top of conversation
2. **Environment variable** - Run `echo $TRANSCRIPT_PATH` in Bash
3. **Ask the user** - If neither is available, ask for the path

## Step 2: Run the Cleaning Script

```bash
python3 <skill-path>/scripts/context-cleaner.py <transcript_path>
```

The script:
- Creates a NEW file with `00effaced{NNN}` suffix (original preserved)
- Unifies all sessionId entries to match the new filename
- Strips: thinking blocks, Read/Write/Edit/Bash contents, file paths, tool results, hook progress lines
- Preserves: conversation text, edit intent, filenames, uuid chain

## Step 3: Report Results

The script outputs cleaning statistics and a resume command. Share the resume command with the user:

```
claude --resume <new_session_id> --verbose
```

## SessionStart Hook

The `src/contextCleaner_sessionStartHook.sh` file provides:
- Transcript path injection into Claude context (every session)
- CLAUDE_ENV_FILE env vars ($SESSION_ID, $TRANSCRIPT_PATH)
- Resume command copied to clipboard
- Cleaned session detection (00effaced pattern)

Installation: copy to `~/.claude/hooks/` and register in `~/.claude/settings.json` under SessionStart.
