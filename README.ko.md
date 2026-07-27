# Context Cleaner

Claude Code 세션 트랜스크립트 클리너. 대화 흐름을 보존하면서 트랜스크립트 크기를 60-80% 줄여줍니다.

## 설치

### 원라이너 설치 (추천)

```bash
curl -sL https://raw.githubusercontent.com/professional-ALFIE/context-cleaner-skill/main/install.sh | bash
```

`~/.claude/skills/context-cleaner/`에 스킬과 스크립트가 설치됩니다.

### SessionStart Hook (자동 탐색에 권장)

이 훅은 Claude에게 transcript 경로와 session ID를 제공하고 `CLAUDE_ENV_FILE`로 내보냅니다. 훅을 사용하지 않으면 cleaner에 transcript 경로나 session UUID를 직접 전달해야 합니다.

`--fork` 결과도 감지합니다. session ID가 `00effacedNNN`으로 끝나면 정리된 세션이라는 안내를 표시합니다. in-place 정리는 기존 session ID를 유지하므로 bundled hook은 ID만으로 정리 상태를 판단하지 못합니다.

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

**원칙: 결과는 지우고, 재현 수단은 남긴다.**
결과는 대화 안의 요약으로 대체되지만, 명령어와 경로는 요약으로 복원되지 않기 때문입니다.

`.jsonl` transcript 파일에서 불필요한 데이터를 제거합니다:
- thinking-only 행, 파일 내용, diff, stdout/stderr, base64 이미지
- hook progress·hook summary·hook attachment, synthetic/local-command 행, tool result 중복 데이터, meta content

보존 항목: 대화 텍스트, 편집 의도, UUID 체인, resume anchor, 갈래 tip,
**bash command 전문**, **파일 전체 경로**

> **2026-07 변경 — 명령어와 경로를 이제 보존합니다.**
> 이전에는 `input.command`를 치환하고 전체 경로를 파일명으로 잘랐습니다.
> 실측 (실제 4.2 MB / 1,526행 transcript 기준):
> bash command는 **1.70%** (167개, 약 20,600 토큰), 경로는 **0.05%** (약 2 KB)를 차지합니다.
> 반면 계속 지우는 bash **출력**은 명령어의 **2.8배**입니다.
> 감량률은 양쪽 모두 **68.8%** 로 동일 — 남겨도 사실상 공짜입니다.
> 파일명만 남기면 같은 이름의 다른 파일을 구분할 수 없고(예: 서로 다른 `CLAUDE.md` 두 개),
> 명령어 안의 옵션·정규식·필드 오프셋 시행착오는 요약으로 복원되지 않습니다.
> 두 동작 모두 **주석 한 줄**로 되돌릴 수 있습니다 — [되돌리기](#되돌리기-보존-vs-제거) 참조.

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

Claude Code는 모든 동작을 JSONL transcript에 기록합니다. cleaner는 대화 구조를 보존하면서 무거운 필드를 가벼운 marker로 치환하고 가치가 낮은 특정 행을 삭제합니다.

#### Thinking

thinking-only assistant 행은 삭제하고 참조를 다시 연결합니다. thinking과 다른 내용이 섞인 행은 보존하고 `message.content[N].thinking` 값만 치환합니다.

#### Read

파일을 읽으면 파일 전체 내용이 트랜스크립트에 기록됩니다.

- **호출**: `input.file_path` → **보존 (전체 경로)**
- **실행 결과**: `toolUseResult.file.content` → 치환
- **결과 중복**: `tool_result.content` → 치환

#### Write

파일을 작성하면 작성 내용과 원본 파일이 기록됩니다.

- **호출**: `input.file_path` → **보존 (전체 경로)**, `input.content` → 치환
- **실행 결과**: `toolUseResult.content`, `.originalFile`, `.structuredPatch` → 치환
- **결과 중복**: `tool_result.content` → 치환

#### Edit

파일을 편집하면 변경 전/후 문자열과 원본 파일이 기록됩니다.

- **호출**: `input.file_path` → **보존 (전체 경로)**, `input.old_string`, `input.new_string` → 치환
- **실행 결과**: `toolUseResult.oldString`, `.newString`, `.originalFile`, `.structuredPatch` → 치환
- **결과 중복**: `tool_result.content` → 치환

#### Bash

명령을 실행하면 명령어와 전체 출력이 기록됩니다.

- **호출**: `input.command` → **보존 (전문)**
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
- **Hook 행**: `hook_progress`, `stop_hook_summary`, `hook_*` attachment를 기본 삭제하며, `--hooks keep` 또는 event 목록으로 선택 보존
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

```text
🔄 Mode: in-place — 검증 후 원본 transcript 교체
✅ Context Cleaner v5 (TS) completed!
📁 Source: ${HOME}/.claude/projects/.../<session-id>.jsonl
📁 Output: ${HOME}/.claude/projects/.../<session-id>.jsonl
📊 Cleaning Statistics (값 치환): ...
🗑 Row Deletions (행 삭제 + 참조 재연결): ...
🚀 To resume this cleaned session, run:
   cd ${HOME}/project/example && claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume <session-id>
🔎 Verification: PASS
```

### 되돌리기: 보존 vs 제거

bash command와 전체 경로를 보존하는 것은 **기본값이지 고정 규칙이 아닙니다.**
각 동작은 `scripts/context-cleaner.ts`의 주석 블록으로 꺼져 있으므로, 주석을 풀면 다시 제거합니다.
다른 수정은 필요 없습니다.

**bash command를 제거하려면** (2곳 주석 해제):

| 위치 | 대상 |
|---|---|
| `processLine()` | `// cleanBashInput(o, stats);` |
| `cleanAgentProgress()` | 주석 처리된 `input.command` 블록 (서브에이전트 bash) |

**파일 전체 경로를 제거하려면** (5곳 주석 해제):

| 위치 | 대상 |
|---|---|
| `processLine()` | `// cleanInputFilepath(o, stats);` — 이 함수는 경로 전용이라 호출만 켜면 됨 |
| `cleanAttachment()` | 주석 처리된 `filePath` 블록 |
| `cleanReadResult()` | 주석 처리된 `filePath` 블록 |
| `cleanWriteResult()` | 주석 처리된 `filePath` 블록 |
| `cleanEditResult()` | 주석 처리된 `filePath` 블록 |

참고:
- `cleanBashInput()`과 `cleanInputFilepath()` 함수 자체는 **소스에 남겨뒀습니다** (호출만 껐습니다).
  되돌리기를 한 줄 수정으로 만들기 위해서입니다. 그래서 이 설정에서는 통계의 `Bash inputs`와
  `Filenames` 값이 항상 `0`입니다 — 정상이며 버그가 아닙니다.
- `row.cwd`는 원래부터 손대지 않습니다. resume 명령의 `cd` 대상을 만드는 근거이기 때문입니다.
- 시스템 프롬프트는 transcript에 **기록되지 않습니다**. 제거할 대상 자체가 없습니다.

## 사용법

### Skill로 사용

Claude에게 "context clean해줘" 또는 "transcript 정리해줘"라고 말하세요.

### CLI로 사용

```bash
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts ${HOME}/path/to/session.jsonl
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts ${HOME}/path/to/session.jsonl --fork
~/.claude/skills/context-cleaner/scripts/context-cleaner.ts <session-uuid-prefix> --hooks keep
```

기본 모드는 원자적 in-place 교체입니다. 결과를 비교하거나 원본 transcript를 보존해야 할 때는 `--fork`를 사용합니다. Python 구현은 v4 레거시 및 rollback 용도로만 보존합니다.

### 정리된 세션 재개

cleaner는 session에 기록된 작업 경로를 사용해 resume 명령을 출력합니다. in-place 모드는 기존 session ID를 유지하고, `--fork`는 새로운 `00effacedNNN` ID를 만듭니다.

```bash
cd ${HOME}/project/example && claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume <session-id>
```

macOS에서는 `pbcopy`가 있을 때 이 명령을 클립보드에도 복사합니다. 클립보드 복사 실패는 무시합니다. `--verbose`는 SessionStart hook 출력을 보여주며, 정리된 세션 안내는 `00effacedNNN`으로 끝나는 `--fork` ID에 자동으로 표시됩니다.

## 요구사항

- Bun
- `jq` (훅 스크립트용)
- macOS (`pbcopy` 지원은 선택 사항)
