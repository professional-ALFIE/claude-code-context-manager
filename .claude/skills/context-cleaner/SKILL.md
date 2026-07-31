---
name: context-cleaner
description: Claude Code transcript cleaner that reduces token usage by 60-80% while preserving conversation flow. Use when the user wants to clean, optimize, or compact a session transcript, reduce context tokens, or prepare a session for efficient resume. Triggers on keywords like context clean, transcript clean, token optimization, session compact, context reduction, effaced session.
---

# Context Cleaner

Transcript cleaning tool that strips bulky tool data (thinking blocks, file contents, diffs, stdout) while preserving conversation flow, edit intent, and filenames.

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
- Strips (값 치환): Read/Write/Edit/Bash contents, file paths, tool results, attachments, Workflow 인라인 스크립트(`tool_use.input.script` — 최대 512KB. 색인인 `name`·`scriptPath`는 보존)
- Strips (base64 이미지 — 두 자리를 함께): 도구가 반환한 스크린샷은 같은 이미지가 두 곳에 저장된다. ① `message.content[]` → `tool_result.content[]` 안쪽의 `image.source.data` ② `toolUseResult.file.base64`. 둘 다 유효한 1x1 PNG(96B)로 치환하고 메타(`originalSize`·`dimensions`·`type`)는 보존한다. 치환값이 유효한 PNG여야 하는 이유는 API가 이 값을 디코딩하므로 깨진 값이면 resume이 400으로 죽기 때문. **실측(2026-07-31): 스크린샷 2장이 1,038,776B(파일의 64%)를 차지했다** — v4는 ①을 최상위 배열에서만 찾아 `tool_result` 껍데기를 못 뚫었고 ②는 규칙이 없어 `Base64 images: 0 cleaned`로 찍혔다
- Strips (`attachment.snippet`): 외부에서 파일이 바뀐 것을 알리는 첨부(`type="edited_text_file"`)는 본문을 `content`가 아니라 `snippet`에 담아 v4 규칙이 지나쳤다. `filename`(색인)·`type`·행 자체는 보존하고 값만 치환한다(행이 uuid를 갖고 자식이 매달려 있어 삭제하면 재매핑이 필요하다). **실측: 8행 57,128B, 제거 시 컨텍스트 Messages 80.4k→63.4k (17k 감소)**
- Deletes (행 삭제 + 참조 재매핑): thinking rows (일반+summarized, signature 문제 원천 소멸), hook rows 3형태(`--hooks` 스위치), synthetic rows (`model="<synthetic>"` / "Continue from where you left off."), local-command rows
- 삭제하지 않기로 결정된 것: `queue-operation` rows (비동기 알림·입력의 큐잉 타이밍 기록. 지워도 안전하고 내용도 다른 행과 중복이지만, 입력이 언제 도달해 언제 소비됐는지는 이 행에만 남으므로 보존한다 — 실측 근거는 본체 주석 참조)
- Remaps on deletion: parentUuid(조상 사슬 기반), last-prompt.leafUuid(resume 앵커), sourceToolAssistantUUID, file-history-snapshot(대상 소멸 시 동반 삭제)
- Verifies output — 기존(고아 0·사이클 0·참조 해소·깨진 줄 증가 없음) + [PLAN §5] **uuid 체인 판정 3종**: ① 최신 tip → root 도달 ② 다중 대화 root 감지(대화 root 0개는 hook-root 정상 케이스 때문에 실패로 보지 않음) ③ resume 앵커(last-prompt.leafUuid) 해소·root 도달. FAIL 시 exit 2
- Preserves: conversation text, edit intent, filenames, uuid chain, last-prompt rows, 평행세계 갈래 tip, Workflow 완료 알림 본문(`<failures>`=실패 원인, `<diagnostics>`=journal.jsonl 경로·resumeFromRunId) 및 접수증 `toolUseResult`(runId·transcriptDir) — 실제 워크플로우 내역으로 가는 유일한 색인이라 지우지 않는다
- Smoke test: `scripts/context-cleaner.smoke.ts` (실물 transcript 대상, 산출물 보존)

### 감량 효과를 토큰으로 측정할 때 (파일 크기로 판단하지 말 것)

파일이 줄어도 컨텍스트가 안 줄 수 있고, 그 반대도 있다. 실제 효과는 `/context`로 재야 한다.

```bash
claude -r <세션id> -p "안녕"      # ① 워밍업 대화 먼저 (필수)
claude -r <세션id> -p "/context"  # ② 그 다음에 측정
```

①을 건너뛰면 `**Tokens:**` 헤더에 **갱신 전 옛 값**이 나온다. 실제로 이 함정 때문에
"snippet은 컨텍스트에 안 실린다"고 잘못 판정한 적이 있다(두 사본이 똑같이 662.3k로 보였다).
워밍업 후 다시 재니 80.4k vs 65.8k로 갈렸다. 비교는 `| Messages |` 행으로 한다 —
System prompt·tools·Memory는 파일과 무관하게 동일하므로 차이가 곧 transcript 기여분이다.

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
