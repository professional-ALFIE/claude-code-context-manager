# Context Cleaner

Claude Code 세션 트랜스크립트 클리너. 대화 흐름을 보존하면서 트랜스크립트 크기를 60-80% 줄여줍니다.

## 설치

### 원라이너 설치 (추천)

```bash
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash
```

`~/.claude/skills/context-cleaner/`에 스킬과 스크립트가 설치됩니다.

### SessionStart Hook (필수)

이 훅은 **필수**입니다. Claude에게 transcript 경로와 session ID를 제공하고 `CLAUDE_ENV_FILE`로 내보냅니다. 없으면 Claude가 transcript 파일을 찾을 수 없습니다.

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

## 기능

`.jsonl` 트랜스크립트 파일에서 불필요한 데이터를 제거합니다:
- Thinking block, 파일 내용, diff, stdout/stderr
- 전체 파일 경로 → 파일명만 유지
- Hook progress 행, tool result 중복 데이터, meta content (주입된 SKILL.md 등)

보존 항목: 대화 텍스트, 편집 의도, 파일명, uuid 체인

### 동작 원리

1. **클리닝** — 무거운 데이터(thinking, 파일 내용, bash 출력 등)를 제거하고 `[context-cleaner: Read]` 같은 가벼운 마커로 대체합니다
2. **기본값은 원자적 in-place 교체** — 검증을 통과한 경우에만 정리본으로 원본을 교체합니다. 원본을 보존하고 `00effaced` 사본을 만들려면 `--fork`를 사용합니다
3. **uuid 체인 유지** — 줄이 삭제되면 `parentUuid` 참조를 리매핑해서 대화 트리가 깨지지 않습니다. `claude --resume`이 정상 작동합니다
4. **resume 상태 보존** — 행 삭제 시 `last-prompt.leafUuid`, `sourceToolAssistantUUID`, snapshot과 parent 참조를 다시 연결합니다
5. **교체 전 검증** — 고아 참조, cycle, 끊어진 참조, 대화 root와 resume anchor를 검사한 뒤에만 in-place rename을 수행합니다

### `--fork` 파일명 규칙

```
원본:      9c4c1a42-...-239d2e110282.jsonl
정리 후:   9c4c1a42-...-00effaced001.jsonl
재정리:    9c4c1a42-...-00effaced002.jsonl  (숫자 증가)
```

- `00effaced` = 접두어 `00` + "effaced" (지워진/사라진)
- SessionStart 훅이 이 패턴을 감지하면 정리된 세션임을 알려줍니다

### 삭제 대상

Claude Code는 모든 동작을 JSONL 트랜스크립트에 기록합니다. 클리너는 대화 구조를 보존하면서 무거운 필드를 가벼운 마커로 치환합니다.

#### Thinking

어시스턴트 응답마다 Extended Thinking 내용이 포함됩니다.

- `message.content[N].thinking` → 치환

#### Read

파일을 읽으면 파일 전체 내용이 트랜스크립트에 기록됩니다.

- **호출**: `input.file_path` → 파일명만 남김
- **실행 결과**: `toolUseResult.file.content` → 치환
- **결과 중복**: `tool_result.content` → 치환

#### Write

파일을 작성하면 작성 내용과 원본 파일이 기록됩니다.

- **호출**: `input.file_path` → 파일명만 남김, `input.content` → 치환
- **실행 결과**: `toolUseResult.content`, `.originalFile`, `.structuredPatch` → 치환
- **결과 중복**: `tool_result.content` → 치환

#### Edit

파일을 편집하면 변경 전/후 문자열과 원본 파일이 기록됩니다.

- **호출**: `input.file_path` → 파일명만 남김, `input.old_string`, `input.new_string` → 치환
- **실행 결과**: `toolUseResult.oldString`, `.newString`, `.originalFile`, `.structuredPatch` → 치환
- **결과 중복**: `tool_result.content` → 치환

#### Bash

명령을 실행하면 명령어와 전체 출력이 기록됩니다.

- **호출**: `input.command` → 치환
- **실행 결과**: `toolUseResult.stdout`, `.stderr` → 치환
- **진행 로그**: `data.output`, `data.fullOutput` (bash_progress 행) → 치환
- **결과 중복**: `tool_result.content` → 치환

#### Grep / Glob

검색하면 매칭된 파일 경로 목록이 기록됩니다.

- **실행 결과**: `toolUseResult.filenames` → `[""]`로 치환

#### Task (서브에이전트)

서브에이전트를 호출하면 프롬프트와 에이전트의 전체 응답이 기록됩니다. 프롬프트는 세 곳에 저장됩니다 (Path A/B/C).

- **호출 (Path A)**: `input.prompt` → 치환
- **실행 결과**: `toolUseResult.task.output` 또는 `toolUseResult.content[N].text` → 치환
- **결과 프롬프트 (Path C)**: `toolUseResult.prompt` → 치환
- **진행 로그 (Path B)**: `data.message.message.content` (agent_progress 행) → 치환
- **결과 중복**: `tool_result.content` → 치환

#### WebFetch

URL을 가져오면 페이지 전체 내용이 기록됩니다.

- **실행 결과**: `toolUseResult.result` (string) → 치환

#### ExitPlanMode

플랜 모드를 종료하면 플랜 텍스트가 기록됩니다.

- **호출**: `input.plan` → 치환

#### 기타 대상

특정 도구에 묶이지 않지만, 클리닝 대상인 항목들입니다.

- **이미지 첨부**: `source.data` base64 → 1x1 투명 PNG로 치환, `source.media_type` → `image/png`
- **hook_progress**: 줄 전체 삭제 (parentUuid 리매핑으로 uuid 체인 유지)
- **meta 메시지** (isMeta): `content[N].text` → 치환 (주입된 SKILL.md, 시스템 프롬프트 등)
- **bash 태그**: 사용자 메시지 내 `<bash-stdout>...<bash-stderr>` 패턴 → 치환
- **사용자 마킹**: `<clean>...</clean>` 패턴 → 치환
- **teammate-message**: 태그 내부 본문 → 치환 (`summary` 등 여는 태그 속성은 보존)
- **local-command-stdout**: 태그 내부 → 200자 초과 시 치환 (짧은 출력은 보존)

### 수동 마킹

프롬프트에서 `<clean>...</clean>` 태그로 감싸면 다음 클리닝 시 해당 내용이 삭제됩니다. 이후 컨텍스트에 필요 없는 대용량 텍스트를 붙여넣을 때 유용합니다.

```
<clean>여기에 대용량 텍스트 붙여넣기</clean>
```

### 통계

클리닝 후 상세 리포트가 출력됩니다:

```
✅ Context Cleaner v5 completed!

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

## 사용법

### Skill로 사용

Claude에게 "context clean해줘" 또는 "transcript 정리해줘"라고 말하세요.

### CLI로 사용

```bash
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts /path/to/session.jsonl
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts /path/to/session.jsonl --fork
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts <session-uuid-prefix> --hooks keep
```

기본 모드는 원자적 in-place 교체입니다. 결과를 비교하거나 원본 transcript를 보존해야 할 때는 `--fork`를 사용합니다. Python 구현은 v4 레거시 및 rollback 용도로만 보존합니다.

### 정리된 세션 재개

클리닝 후 resume 명령이 **자동으로 클립보드에 복사**됩니다. 붙여넣기만 하면 됩니다:

```bash
claude --resume 9c4c1a42-...-00effaced001 --verbose
```

`--verbose` 플래그를 사용하면 SessionStart 훅 출력(정리된 세션 안내 포함)을 터미널에서 볼 수 있습니다.

## 요구사항

- Bun
- `jq` (훅 스크립트용)
- macOS (`pbcopy` 지원은 선택 사항)
