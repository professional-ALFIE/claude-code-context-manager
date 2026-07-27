---
name: context-cleaner
description: Claude Code transcript cleaner that reduces token usage by 60-80% while preserving conversation flow. Use when the user wants to clean, optimize, or compact a session transcript, reduce context tokens, or prepare a session for efficient resume. Triggers on keywords like context clean, transcript clean, token optimization, session compact, context reduction, effaced session.
---

# Context Cleaner

Transcript cleaning tool that strips bulky tool **results** (thinking blocks, file contents, diffs, stdout, images) while preserving conversation flow, edit intent, **bash commands, and full file paths**.

원칙: **결과는 지우고, 재현 수단은 남긴다.** 결과는 응답 텍스트의 요약으로 대체되지만,
명령어·경로 같은 재현 수단은 요약으로 복원되지 않기 때문. (2026-07-28 결정 — 아래 두 절 참조)

## ⚠️ 이 스킬을 수정·작업할 때 지침 (반드시 먼저 읽기)

transcript jsonl 파일(원본 및 `00effaced` 결과물)은 **매우 크다** (수십 MB 단위). 그래서 transcript를 다룰 때는 다음 규칙을 지킨다.

- **`Read` 도구로 transcript를 통째로 읽지 않는다.** Read는 파일 전체를 컨텍스트에 올려 토큰을 폭증시킨다.
- transcript의 내용을 확인해야 할 때는 `instruct--shell-language--bun-typescript` 스킬(`bun -` + TypeScript)을 사용해, **필요한 줄/필드만 골라서** 읽는다. (예: 특정 `type`만 필터링, 앞 N줄만, 특정 키만 추출, 줄 수만 세기)
- transcript를 **수정·가공할 때도** 같은 스킬(`bun -` + TypeScript)로 stream 처리한다. 전체를 메모리에 올린 뒤 일괄 치환하지 않는다.

단, `SKILL.md`·`context-cleaner.py` 같은 **스크립트/문서 파일**은 크기가 작으므로 평소대로 `Read`/`Edit`로 다룬다. 위 규칙은 **transcript(jsonl) 데이터 파일에만** 적용된다.

## ⚠️ 점검·검증 시 원본을 덮어쓰지 말 것 (실수 사례 기반)

스크립트를 수정한 뒤 효과를 점검할 때, **원본 transcript를 in-place(기본)로 재클리닝하지 않는다.** — in-place는 원본을 정리본으로 덮어써 버린다.

- 점검·비교가 목적이면 **반드시 `--fork`** 로 사본을 만들어 비교한다. in-place 재클리닝은 원본을 교체해 "수정 전 vs 수정 후" 비교 기준(원본)이 사라진다. (실제로 이 실수가 발생한 적 있음)
- **점검·분석은 이미 존재하는 "마지막 effaced 파일"을 대상으로, 읽기/길이 집계만 수행한다.** 점검하려고 새 클리닝을 돌리지 않는다.
- 수정 후 결과물을 새로 만들어 비교해야 한다면, 비교 기준을 보존하는 방식으로 한다:
  - **`--fork`** 로 사본을 만들거나,
  - 기존 effaced 파일을 입력으로 주어 다음 번호(`002`, `003` …) 사본으로 저장한다.
- 즉, **비교 기준(원본 또는 기존 마지막 effaced)을 절대 덮어쓰지 않는다.**

## ★ bash command는 보존한다 (2026-07-28 결정)

Bash `input.command`는 **지우지 않는다.** 출력(stdout/stderr)만 지운다.

```yaml
실측 (1526행 4249KB 세션 기준):
  bash command  167개 /  72.4 KB / 약 20,600 tok / 전체의 1.70%   ← 살림
  bash 출력     171개 / 199.6 KB / 약 56,800 tok                  ← 계속 지움 (명령의 2.8배)

왜 살리나:
  명령어에는 "어떤 옵션 조합으로 무엇을 알아냈는지"가 들어 있어 재현 가치가 크다.
  필드 오프셋·정규식·파이프 조합 같은 시행착오는 응답 텍스트로 요약해도 복원되지 않는다.
  실제 사례 — awk 집계에서 `$(NF-4)`처럼 뒤에서부터 센 이유(주파수 칸이 "1900.00 Mhz"라
  공백 포함 → 필드가 밀림)가 명령 안 주석에만 있었다. 지우면 같은 함정을 다시 밟는다.
  1.7%를 내고 그걸 사는 편이 이득.

되돌리는 법 (예전처럼 지우고 싶을 때) — scripts/context-cleaner.ts 에서 주석 2곳만 풀면 된다:
  ① processLine() 안:            // cleanBashInput(o, stats);
  ② cleanAgentProgress() 안:     주석 처리된 command 블록 (서브에이전트 Bash)
  ※ 함수 cleanBashInput 자체는 남겨뒀다(호출만 껐다) — 되살리기를 한 줄로 만들기 위해.
    그래서 통계의 "Bash inputs" 는 이 상태에서 항상 0이다 (정상).

교훈 (별개로 지켜야 할 것):
  "왜 이렇게 짰는지"를 bash 주석에만 쓰면, 명령을 지우는 설정에서는 사라진다.
  중요한 이유는 응답 메시지나 스크립트 파일(예: throttle-watch.sh)로 남겨야 안전하다.
```

## ★ 파일 경로도 보존한다 (2026-07-28 결정)

Read/Edit/Write의 `file_path`와 결과의 `filePath`를 **자르지 않는다** (전체 경로 유지).

```yaml
실측: 경로 관련 34곳 ≈ 2 KB — 전체의 0.05%. 감량 효과가 사실상 없다.

왜 살리나:
  파일명만 남으면 같은 이름의 다른 파일을 구분할 수 없다.
  실사례 — CLAUDE.md 가 최소 2개다:
    /Users/…/project/CLAUDE.md
    /Users/…/project/issue-00-ssh-19mbp/CLAUDE.md
  둘 다 "CLAUDE.md"로 뭉개지면 어느 파일을 고쳤는지 복원 불가능하다.

부수 효과(개선): MCP 도구의 file_path는 원래부터 안 잘렸다
  (cleanInputFilepath가 name을 Read/Edit/Write로 한정하므로). 이제 일관성이 생긴다.

되돌리는 법 — scripts/context-cleaner.ts 에서 주석 5곳을 풀면 된다:
  ① processLine() 안:   // cleanInputFilepath(o, stats);   ← 함수 전체가 경로 전용, 호출만 끔
  ②~⑤ 각 함수 안의 filePath 블록 (함수 본업은 따로 있어 블록만 끔):
       cleanAttachment / cleanReadResult / cleanWriteResult / cleanEditResult

※ row.cwd 는 원래부터 손대지 않는다 — resume 명령의 cd 대상 근거이기 때문.
※ 시스템 프롬프트는 transcript에 애초에 기록되지 않는다 (확인함) — 자를 대상이 아니다.
```

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

**기본 동작은 원본을 덮어씁니다 (in-place, 파괴적).** 세션 수를 안 늘리기 위함이다. 위험이 우려되면 `--fork`로 사본을 만든다.

```bash
<skill-path>/scripts/context-cleaner.ts <transcript_path>                     # 기본(in-place): 원본을 정리본으로 덮어씀 + 훅 전부 삭제
<skill-path>/scripts/context-cleaner.ts <session-uuid | uuid접두>              # 경로 대신 uuid — ~/.claude/projects 파일명 탐색 (모호하면 후보 나열)
<skill-path>/scripts/context-cleaner.ts <transcript_path> --fork              # 사본 생성(기존 동작) — 원본 보존
<skill-path>/scripts/context-cleaner.ts <transcript_path> --hooks keep        # 훅 전부 보존
<skill-path>/scripts/context-cleaner.ts <transcript_path> --hooks sessionstart,stop  # 적은 이벤트만 보존
```

(레거시: `python3 <skill-path>/scripts/context-cleaner.py <transcript_path>` — v4 값 치환만, 행 삭제 없음. 참조·롤백용으로 보존)

모드 (PLAN §2 CLI 반전):
- **in-place (기본)**: 원본을 정리본으로 덮어씀 — 세션 수를 안 늘림. **원자적 쓰기**(임시파일 → 검증 통과 시에만 rename)로 원본을 보호한다. 검증 실패 시 원본 무손상, exit 2. sessionId는 파일명 그대로(무치환, R2).
- **--fork**: `00effaced{NNN}` 사본 생성(기존 동작) — 원본 보존, 세션 수 증가. 비교·점검·안전판.

The script (v5 TS):
- in-place: 원본 경로에 덮어씀. fork: `00effaced{NNN}` 사본 + 새 uuid(기존 effaced 파일은 절대 덮어쓰지 않고 빈 번호로 증가)
- Strips (값 치환): Read/Write/Edit **결과** contents, bash **stdout/stderr**, tool results, attachments, base64 images
  ※ 2026-07-28부터 **bash command와 file path는 지우지 않는다** (위 두 절 참조 — 주석 해제로 복귀 가능)
- Deletes (행 삭제 + 참조 재매핑): thinking rows (일반+summarized, signature 문제 원천 소멸), hook rows 3형태(`--hooks` 스위치), synthetic rows (`model="<synthetic>"` / "Continue from where you left off."), local-command rows
- Remaps on deletion: parentUuid(조상 사슬 기반), last-prompt.leafUuid(resume 앵커), sourceToolAssistantUUID, file-history-snapshot(대상 소멸 시 동반 삭제)
- Verifies output — 기존(고아 0·사이클 0·참조 해소·깨진 줄 증가 없음) + [PLAN §5] **uuid 체인 판정 3종**: ① 최신 tip → root 도달 ② 다중 대화 root 감지(대화 root 0개는 hook-root 정상 케이스 때문에 실패로 보지 않음) ③ resume 앵커(last-prompt.leafUuid) 해소·root 도달. FAIL 시 exit 2
- Preserves: conversation text, edit intent, uuid chain, last-prompt rows, 평행세계 갈래 tip,
  **bash commands (전문)**, **full file paths**, Bash/Task description, row.cwd
- Smoke test: `scripts/context-cleaner.smoke.ts` (실물 transcript 대상, 산출물 보존)

## Step 3: Report Results

The script outputs cleaning statistics and a resume command. Share the resume command with the user:

```
cd ${HOME}/<세션 cwd의 홈 이하 부분> && claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume <new_session_id>
```

(cd 대상은 transcript 경로가 아니라 세션의 cwd — `claude --resume`은 현재 디렉토리로 projects 폴더를 찾으므로. cwd는 행에서 자동 추출되며, 없으면 cd 없이 출력. 홈 접두는 리터럴 `${HOME}` 토큰으로 출력되어 실행하는 터미널에서 확장 — 어느 머신·사용자명이든 이식됨. 단 현재 홈 기준 실존 경로일 때만 토큰화하며, 인용이 필요한 경로는 확장이 살도록 겹따옴표 처리)

## SessionStart Hook

The `src/contextCleaner_sessionStartHook.sh` file provides:
- Transcript path injection into Claude context (every session)
- CLAUDE_ENV_FILE env vars ($SESSION_ID, $TRANSCRIPT_PATH)
- Resume command copied to clipboard
- Cleaned session detection (00effaced pattern)

Installation: copy to `~/.claude/hooks/` and register in `~/.claude/settings.json` under SessionStart.
