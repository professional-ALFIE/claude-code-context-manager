# Context Cleaner

Claude Code session transcript cleaner. Reduces transcript size by 60-80% while preserving conversation flow.

## What it does

Strips bulky data from `.jsonl` transcript files:
- Thinking blocks, file contents, diffs, stdout/stderr
- Full file paths → filenames only
- Hook progress lines, tool result duplicates, meta content (injected SKILL.md, etc.)

Preserves: conversation text, edit intent, filenames, uuid chain.

### How it works

1. **Cleans** — Removes heavy data (thinking, file contents, bash output, etc.) and replaces with lightweight markers like `[context-cleaner: Read]`
2. **Generates new file** — Original file stays untouched. A new file is created with `00effaced` in the filename ("effaced" = erased/removed)
3. **Maintains uuid chain** — When lines are deleted, `parentUuid` references are remapped so the conversation tree stays intact. Claude `--resume` works correctly
4. **Unifies sessionId** — All `sessionId` entries are updated to match the new filename, preventing session detection issues
5. **Copies resume command** — After cleaning, `claude --resume <new_id> --verbose` is automatically copied to your clipboard (macOS)

### File naming

```
Original:  9c4c1a42-...-239d2e110282.jsonl
Cleaned:   9c4c1a42-...-00effaced001.jsonl
Re-clean:  9c4c1a42-...-00effaced002.jsonl  (number increments)
```

- `00effaced` = prefix `00` + "effaced" (erased/removed)
- The SessionStart hook detects this pattern and shows a context-cleaned session notice

### What gets cleaned

Claude Code records every action to a JSONL transcript. The cleaner replaces bulky fields with lightweight markers while preserving conversation structure.

#### Thinking

Each assistant response includes Extended Thinking content.

- `message.content[N].thinking` → replaced

#### Read

Reading a file records its full content in the transcript.

- **Call**: `input.file_path` → trimmed to filename only
- **Result**: `toolUseResult.file.content` → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### Write

Writing a file records the written content and the original file.

- **Call**: `input.file_path` → trimmed to filename only, `input.content` → replaced
- **Result**: `toolUseResult.content`, `.originalFile`, `.structuredPatch` → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### Edit

Editing records old/new strings and the original file.

- **Call**: `input.file_path` → trimmed to filename only, `input.old_string`, `input.new_string` → replaced
- **Result**: `toolUseResult.oldString`, `.newString`, `.originalFile`, `.structuredPatch` → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### Bash

Running a command records the command text and its full output.

- **Call**: `input.command` → replaced
- **Result**: `toolUseResult.stdout`, `.stderr` → replaced
- **Progress**: `data.output`, `data.fullOutput` (bash_progress lines) → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### Grep / Glob

Searching records a list of matched file paths.

- **Result**: `toolUseResult.filenames` → replaced with `[""]`

#### Task (subagent)

Calling a subagent records the prompt and the agent's full output. The prompt is stored in three locations (Path A/B/C).

- **Call (Path A)**: `input.prompt` → replaced
- **Result**: `toolUseResult.task.output` or `toolUseResult.content[N].text` → replaced
- **Result prompt (Path C)**: `toolUseResult.prompt` → replaced
- **Progress (Path B)**: `data.message.message.content` (agent_progress lines) → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### WebFetch

Fetching a URL records the full page content.

- **Result**: `toolUseResult.result` (string) → replaced

#### ExitPlanMode

Exiting plan mode records the plan text.

- **Call**: `input.plan` → replaced

#### Other targets

Not tied to a specific tool, but still cleaned.

- **Image attachments**: `source.data` base64 → 1x1 transparent PNG, `source.media_type` → `image/png`
- **hook_progress**: entire line deleted (uuid chain preserved via parentUuid remapping)
- **Meta messages** (isMeta): `content[N].text` → replaced (injected SKILL.md, system prompts, etc.)
- **Bash tags**: `<bash-stdout>...<bash-stderr>` patterns in user messages → replaced
- **User-marked content**: `<clean>...</clean>` patterns → replaced
- **teammate-message**: tag body → replaced (opening tag attributes including `summary` preserved)
- **local-command-stdout**: tag body → replaced when over 200 characters (short outputs preserved)

### Manual marking

Wrap any part of your prompt with `<clean>...</clean>` tags to mark it for deletion on the next clean. Useful for pasting large text that you don't need in future context.

```
<clean>paste your large content here</clean>
```

### Statistics

After cleaning, you get a detailed report:

```
✅ Context Cleaner v2 completed!

📊 Cleaning Statistics:
  Thinking blocks:       42 cleaned (128,400 bytes)
  Read results:          18 cleaned (95,200 bytes)
  ...

💾 Total saved: 892,103 bytes (871.2 KB)
📦 Original size: 1,245,678 bytes
📦 New size: 353,575 bytes (71.6% reduction)

🚀 To resume this cleaned session, run:
   claude --resume 9c4c1a42-...-00effaced001 --verbose
📋 Copied to clipboard!
```

## Installation

### Quick Install (Recommended)

```bash
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash
```

This installs the skill and scripts to `~/.claude/skills/context-cleaner/`.

### SessionStart Hook (Required)

This hook is **required** — it provides the transcript path to Claude and copies the resume command to your clipboard. Without it, Claude cannot locate the transcript file.

It also **auto-detects** cleaned sessions: when a session ID contains `00effaced`, the hook displays a notice explaining what was preserved and removed.

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
~/.claude/skills/context-cleaner/scripts/context-cleaner.py /path/to/session.jsonl
```

### Resume cleaned session

After cleaning, the resume command is **automatically copied to your clipboard**. Just paste and run:

```bash
claude --resume 9c4c1a42-...-00effaced001 --verbose
```

The `--verbose` flag lets you see the SessionStart hook output (including the cleaned session notice) in the terminal.

## Requirements

- Python 3
- `jq` (for the hook script)
- macOS (pbcopy for clipboard — hook and cleaner script)
