# Context Cleaner

Claude Code 세션 트랜스크립트 클리너. 대화 흐름을 보존하면서 트랜스크립트 크기를 60-80% 줄여줍니다.

## 기능

`.jsonl` 트랜스크립트 파일에서 불필요한 데이터를 제거합니다:
- Thinking block, 파일 내용, diff, stdout/stderr
- 전체 파일 경로 → 파일명만 유지
- Hook progress 행, tool result 중복 데이터, meta content (주입된 SKILL.md 등)

보존 항목: 대화 텍스트, 편집 의도, 파일명, uuid 체인

### 동작 원리

1. **클리닝** — 무거운 데이터(thinking, 파일 내용, bash 출력 등)를 제거하고 `[context-cleaner: Read]` 같은 가벼운 마커로 대체합니다
2. **새 파일 생성** — 원본 파일은 그대로 유지됩니다. `00effaced`가 포함된 새 파일이 생성됩니다 ("effaced" = 지워진/사라진)
3. **uuid 체인 유지** — 줄이 삭제되면 `parentUuid` 참조를 리매핑해서 대화 트리가 깨지지 않습니다. `claude --resume`이 정상 작동합니다
4. **sessionId 통일** — 모든 `sessionId`를 새 파일명과 일치시켜 세션 감지 문제를 방지합니다
5. **resume 명령 자동 복사** — 클리닝 후 `claude --resume <new_id> --verbose`가 자동으로 클립보드에 복사됩니다 (macOS)

### 파일명 규칙

```
원본:      9c4c1a42-...-239d2e110282.jsonl
정리 후:   9c4c1a42-...-00effaced001.jsonl
재정리:    9c4c1a42-...-00effaced002.jsonl  (숫자 증가)
```

- `00effaced` = 접두어 `00` + "effaced" (지워진/사라진)
- SessionStart 훅이 이 패턴을 감지하면 정리된 세션임을 알려줍니다

### 삭제 대상

| 소스 | 삭제 필드 |
|------|-----------|
| Thinking | `message.content[0].thinking` |
| Read | `toolUseResult.file.content`, 전체 경로 → 파일명 |
| Write | `input.content`, `toolUseResult.content/originalFile`, 전체 경로 → 파일명 |
| Edit | `input.old_string/new_string`, `toolUseResult.oldString/newString/originalFile` |
| Bash | `input.command`, `toolUseResult.stdout/stderr` |
| Grep/Glob | `toolUseResult.filenames` → `[""]` |
| ExitPlanMode | `input.plan` |
| Task | `toolUseResult.task.output` |
| tool_result | `message.content[0].content` (toolUseResult과 중복) |
| isMeta | `content[0].text` (주입된 SKILL.md 등) |
| hook_progress | 줄 전체 삭제 (uuid 체인 유지) |
| bash tags | `<bash-stdout>...<bash-stderr>` 패턴 |
| user-marked | `<clean>...</clean>` 패턴 |

### 수동 마킹

프롬프트에서 `<clean>...</clean>` 태그로 감싸면 다음 클리닝 시 해당 내용이 삭제됩니다. 이후 컨텍스트에 필요 없는 대용량 텍스트를 붙여넣을 때 유용합니다.

```
<clean>여기에 대용량 텍스트 붙여넣기</clean>
```

### 통계

클리닝 후 상세 리포트가 출력됩니다:

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

## 설치

### 원라이너 설치 (추천)

```bash
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash
```

`~/.claude/skills/context-cleaner/`에 스킬과 스크립트가 설치됩니다.

### SessionStart Hook (필수)

이 훅은 **필수**입니다. Claude에게 트랜스크립트 경로를 제공하고, resume 명령을 클립보드에 복사합니다. 없으면 Claude가 트랜스크립트 파일을 찾을 수 없습니다.

정리된 세션도 **자동 감지**합니다. 세션 ID에 `00effaced`가 포함되어 있으면 정리된 세션이라는 안내를 표시합니다.

설치 스크립트 실행 후, `~/.claude/settings.json`에 훅을 등록하세요. `hooks` 객체에 `SessionStart` 항목을 추가합니다 (기존 훅은 지우지 마세요):

```json
{"SessionStart":[{"hooks":[{"type":"command","command":"${HOME}/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh"}]}]}
```

등록 후 Claude Code 세션을 재시작하면 적용됩니다.

### Claude에 붙여넣기 설치 (대안)

아래 블록을 통째로 복사해서 Claude Code에 붙여넣으면 자동으로 처리됩니다.

```
Install the context-cleaner skill from this repo: https://github.com/professional-ALFIE/context-cleaner-skill

Step 1 - Run the install script:
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash

Step 2 - Add this SessionStart hook entry to ~/.claude/settings.json inside the "hooks" object. Do NOT remove any existing hooks:
{"SessionStart":[{"hooks":[{"type":"command","command":"${HOME}/.claude/skills/context-cleaner/src/contextCleaner_sessionStartHook.sh"}]}]}

After all steps, tell me to restart the session.
```

## 사용법

### Skill로 사용

Claude에게 "context clean해줘" 또는 "transcript 정리해줘"라고 말하세요.

### CLI로 사용

```bash
~/.claude/skills/context-cleaner/scripts/context-cleaner.py /path/to/session.jsonl
```

### 정리된 세션 재개

클리닝 후 resume 명령이 **자동으로 클립보드에 복사**됩니다. 붙여넣기만 하면 됩니다:

```bash
claude --resume 9c4c1a42-...-00effaced001 --verbose
```

`--verbose` 플래그를 사용하면 SessionStart 훅 출력(정리된 세션 안내 포함)을 터미널에서 볼 수 있습니다.

## 요구사항

- Python 3
- `jq` (훅 스크립트용)
- macOS (클립보드 복사 — 훅과 클리너 스크립트에서 사용)
