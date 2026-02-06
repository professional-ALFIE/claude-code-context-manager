# Context Cleaner

Claude Code 세션 트랜스크립트 클리너. 대화 흐름을 보존하면서 트랜스크립트 크기를 60-80% 줄여줍니다.

## 기능

`.jsonl` 트랜스크립트 파일에서 불필요한 데이터를 제거합니다:
- Thinking block, 파일 내용, diff, stdout/stderr
- 전체 파일 경로 → 파일명만 유지
- Hook progress 행, tool result 중복 데이터

보존 항목: 대화 텍스트, 편집 의도, 파일명, uuid 체인

### 수동 마킹

프롬프트에서 `<clean>...</clean>` 태그로 감싸면 다음 클리닝 시 해당 내용이 삭제됩니다. 이후 컨텍스트에 필요 없는 대용량 텍스트를 붙여넣을 때 유용합니다.

```
<clean>여기에 대용량 텍스트 붙여넣기</clean>
```

## 설치

### 0. 아래를 복사해서 Claude Code에 붙여넣으세요

아래 블록을 통째로 복사해서 Claude Code에 붙여넣으면 1~3단계를 자동으로 처리합니다.

```
Install the context-cleaner skill and SessionStart hook from this repo: https://github.com/professional-ALFIE/claude-code-context-manager

Step 1 - Copy the skill folder:
cp -a .claude/skills/context-cleaner ~/.claude/skills/

Step 2 - Copy the hook script and make it executable:
Step 2 - Make the hook script executable:
chmod +x ~/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh

Step 3 - Add this SessionStart hook entry to ~/.claude/settings.json inside the "hooks" object. Do NOT remove any existing hooks:
{"SessionStart":[{"hooks":[{"type":"command","command":"${HOME}/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh"}]}]}

After all steps, tell me to restart the session.
```

### 1. Skill (Claude Code용)

스킬 폴더를 Claude 스킬 디렉토리에 복사합니다:

```bash
cp -a .claude/skills/context-cleaner ~/.claude/skills/
```

### 2. SessionStart Hook (필수)

이 훅은 **필수**입니다. Claude에게 트랜스크립트 경로를 제공하고, resume 명령을 클립보드에 복사합니다. 없으면 Claude가 트랜스크립트 파일을 찾을 수 없습니다.

훅 스크립트는 스킬 폴더 안에 `src/contextCleaner_sessionStartHook.sh`로 포함되어 있습니다. 실행 권한을 부여합니다:

```bash
chmod +x ~/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh
```

`~/.claude/settings.json`에 등록합니다. `hooks` 객체에 `SessionStart` 항목을 추가하세요 (기존 훅은 지우지 마세요):

```json
{"SessionStart":[{"hooks":[{"type":"command","command":"${HOME}/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh"}]}]}
```

등록 후 Claude Code 세션을 재시작하면 적용됩니다.

## 사용법

### Skill로 사용

Claude에게 "context clean해줘" 또는 "transcript 정리해줘"라고 말하세요.

### CLI로 사용

```bash
python3 ~/.claude/skills/context-cleaner/scripts/context-cleaner.py /path/to/session.jsonl
```

### 정리된 세션 재개

```bash
claude --resume <new_session_id> --verbose
```

`--verbose` 플래그를 사용하면 SessionStart 훅 출력을 터미널에서 볼 수 있습니다.

## 요구사항

- Python 3
- `jq` (훅 스크립트용)
- macOS (클립보드 복사 - 훅에서만 사용)
