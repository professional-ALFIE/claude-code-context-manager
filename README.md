# Context Cleaner

Claude Code session transcript cleaner. Reduces transcript size by 60-80% while preserving conversation flow.

## Installation

### Quick Install (Recommended)

```bash
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash
```

This installs the skill and scripts to `~/.claude/skills/context-cleaner/`.

### SessionStart Hook (Recommended for automatic discovery)

This hook provides the transcript path and session ID to Claude and exports them through `CLAUDE_ENV_FILE`. Without it, pass a transcript path or session UUID to the cleaner manually.

It also detects `--fork` results: when a session ID ends in `00effacedNNN`, the hook displays a cleaned-session notice. In-place cleaning preserves the original session ID, so the bundled hook does not infer that state from the ID alone.

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

## What it does

**Principle: strip the results, keep the means to reproduce them.**
Results are recoverable from your own summaries in the conversation; commands and paths are not.

Strips bulky data from `.jsonl` transcript files:
- Thinking-only rows, file contents, diffs, stdout/stderr, base64 images
- Hook progress, hook summaries and hook attachments; synthetic/local-command rows; tool result duplicates; meta content

Preserves: conversation text, edit intent, UUID chains, resume anchors, branch tips,
the reproducible **first and last Bash commands in each user-prompt group**, and **full file paths**.

> **Changed in 2026-07 — commands and paths are now kept.**
> Previously `input.command` was replaced and full paths were trimmed to filenames.
> Measured on a real 4.2 MB / 1,526-row transcript:
> bash commands cost **1.70%** (167 items, ~20.6k tokens) and paths **0.05%** (~2 KB),
> while bash *output* — still stripped — is **2.8×** the size of the commands.
> Reduction stayed at **68.8%** either way, so keeping them is nearly free.
> Filenames alone cannot disambiguate same-named files (e.g. two different `CLAUDE.md`),
> and option/regex/field-offset trial-and-error inside a command is not recoverable from a summary.
> Full-path preservation and subagent Bash command handling remain comment-controlled. Main-conversation Bash now follows the per-user-prompt grouping policy below — see [Reverting](#reverting-keep-vs-strip).

> **Changed in 2026-07-31 — base64 images and `attachment.snippet`.**
> Tool-returned screenshots are stored in *two* places: nested inside
> `tool_result.content[]` as `image.source.data`, and again at
> `toolUseResult.file.base64`. The old rule scanned only the top-level array, so it
> never got past the `tool_result` wrapper, and the second copy had no rule at all —
> reports read `Base64 images: 0 cleaned` while **1,038,776 B (64% of the file)** stayed.
> Both are now replaced with the same valid 1×1 PNG (96 B); metadata
> (`originalSize`, `dimensions`, `type`) is kept. The placeholder must remain a *valid*
> PNG because the API decodes it — a malformed value makes resume fail with a 400.
> Separately, `attachment.snippet` (how an externally-edited file is reported) was
> missed because it carries its body in `snippet`, not `content`: 8 rows, 57,128 B,
> worth **17k tokens** of context. Its `filename` is kept as the index, and the rows
> themselves are preserved — they hold UUIDs that children and resume anchors point to.

### How it works

1. **Cleans** — Removes heavy data (thinking, file contents, bash output, etc.) and replaces with lightweight markers like `[context-cleaner: Read]`
2. **Writes atomically in place by default** — The cleaned transcript replaces the original only after verification passes. Use `--fork` to preserve the original and create a `00effaced` copy
3. **Maintains uuid chain** — When lines are deleted, `parentUuid` references are remapped so the conversation tree stays intact. Claude `--resume` works correctly
4. **Preserves resume state** — `last-prompt.leafUuid`, `sourceToolAssistantUUID`, snapshots, and parent references are remapped when rows are deleted
5. **Verifies before replacement** — Orphans, cycles, broken references, conversation roots, and resume anchors are checked before an in-place rename

### File naming with `--fork`

```
Original:  9c4c1a42-...-239d2e110282.jsonl
Cleaned:   9c4c1a42-...-00effaced001.jsonl
Re-clean:  9c4c1a42-...-00effaced002.jsonl  (number increments)
```

- `00effaced` = prefix `00` + "effaced" (erased/removed)
- The SessionStart hook detects this pattern and shows a context-cleaned session notice

### What gets cleaned

Claude Code records every action to a JSONL transcript. The cleaner replaces bulky fields with lightweight markers and deletes specific low-value rows while preserving conversation structure.

#### Thinking

Thinking-only assistant rows are deleted and their references are remapped. If a row contains both thinking and non-thinking content, the row is preserved and only `message.content[N].thinking` is replaced.

#### Read

Reading a file records its full content in the transcript.

- **Call**: `input.file_path` → **kept (full path)**
- **Result**: `toolUseResult.file.content` → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### Write

Writing a file records the written content and the original file.

- **Call**: `input.file_path` → **kept (full path)**, `input.content` → replaced
- **Result**: `toolUseResult.content`, `.originalFile`, `.structuredPatch` → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### Edit

Editing records old/new strings and the original file.

- **Call**: `input.file_path` → **kept (full path)**, `input.old_string`, `input.new_string` → replaced
- **Result**: `toolUseResult.oldString`, `.newString`, `.originalFile`, `.structuredPatch` → replaced
- **Result duplicate**: `tool_result.content` → replaced

#### Bash

Running a command records the command text and its full output. The cleaner groups main-chain Bash calls from one actual user prompt up to the next actual user prompt.

```yaml
One_Bash_call:
  call: keep input.command verbatim
  result: replace with existing markers
Two_Bash_calls:
  calls: keep both input.command values verbatim
  results: replace both with existing markers
Three_or_more_Bash_calls:
  first_call: keep input.command verbatim
  middle_calls: remove tool_use and tool_result pairs whose ID links are complete
  last_call: keep input.command verbatim
  retained_results: replace with existing markers
Ambiguous_group:
  row_deletion: none
  every_Bash_input_and_result: replace with existing markers
Sidechain:
  handling: exclude from counts and middle-call removal; keep existing behavior
Background:
  middle_call: also remove the completion notification with the same tool-use-id
```

- Calls and results are linked by `tool_use.id === tool_result.tool_use_id`, never by row adjacency.
- In mixed `message.content[]`, only the target Bash block is removed. A row is deleted only when no content blocks remain.
- If a middle call has a missing or duplicate ID, missing or duplicate results, ambiguous structured-result ownership, or an ambiguous background notification link, the whole group uses the safe replacement fallback.
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
- **Hook rows**: `hook_progress`, `stop_hook_summary`, and `hook_*` attachments are deleted by default; `--hooks keep` or an event list preserves selected rows
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

```text
🔄 Mode: in-place — original transcript replaced after verification
✅ Context Cleaner v5 (TS) completed!
📁 Source: ${HOME}/.claude/projects/.../<session-id>.jsonl
📁 Output: ${HOME}/.claude/projects/.../<session-id>.jsonl
📊 Cleaning Statistics (field replacements): ...
🗑 Row Deletions (deletion + reference remapping): ...
🚀 To resume this cleaned session, run:
   cd ${HOME}/project/example && claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume <session-id>
🔎 Verification: PASS
```

### Reverting: keep vs strip

Keeping full paths and subagent Bash commands is a **default, not a hard rule**. Those behaviors remain disabled by comment blocks in `scripts/context-cleaner.ts`.

Main-conversation Bash commands are no longer controlled by a single commented function call. They are part of the per-user-prompt group policy. To change that policy, update the `preserve-inputs`, `remove-middle`, and `replace-all-bash` decisions in `buildBashCleaningPlan()` together, then run Integration tests T27–T31 to verify reference integrity and ambiguous-group fallback behavior.

**To strip subagent Bash commands**:

- Uncomment the `input.command` block in `cleanAgentProgress()`.

**To strip full file paths** (uncomment 5 places):

| Location | What |
|---|---|
| `processLine()` | `// cleanInputFilepath(o, stats);` — whole function is path-only, so disabling the call is enough |
| `cleanAttachment()` | commented `filePath` block |
| `cleanReadResult()` | commented `filePath` block |
| `cleanWriteResult()` | commented `filePath` block |
| `cleanEditResult()` | commented `filePath` block |

Notes:
- `cleanBashInput()` is used by the safe fallback for ambiguous Bash groups, so the `Bash inputs` counter increases when such a group is encountered.
- `cleanInputFilepath()` remains in the source with its call disabled, so a `Filenames` count of `0` is expected.
- `row.cwd` was never touched; it is the source for the `cd` target in the resume command.
- System prompts are **not** recorded in the transcript at all, so there is nothing to strip there.

## Usage

### Via Skill

Just tell Claude: "context clean해줘" or "transcript 정리해줘"

### Via CLI

```bash
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts ${HOME}/path/to/session.jsonl
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts ${HOME}/path/to/session.jsonl --fork
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts <session-uuid-prefix> --hooks keep
```

The default mode is atomic in-place replacement. Use `--fork` when comparing results or when the original transcript must remain untouched. The Python implementation is retained only as the legacy v4 fallback.

### Resume cleaned session

The cleaner prints a resume command using the session's recorded working directory. In-place mode keeps the original session ID; `--fork` produces a new `00effacedNNN` ID.

```bash
cd ${HOME}/project/example && claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume <session-id>
```

On macOS, the CLI also copies this command when `pbcopy` is available. Clipboard failure is ignored. The `--verbose` flag shows SessionStart hook output; the cleaned-session notice appears automatically for `--fork` IDs ending in `00effacedNNN`.

## Requirements

- Bun
- `jq` (for the hook script)
- macOS (optional `pbcopy` support)
