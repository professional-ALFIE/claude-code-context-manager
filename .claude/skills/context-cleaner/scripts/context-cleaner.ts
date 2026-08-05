#!/usr/bin/env bun
/**
 * Context Cleaner v5 (TypeScript) — Claude Code 세션 transcript 최적화 도구
 *
 * 목적: "상세 변경내역은 몰라도, 흐름은 기억나도록 + 다시 해볼 수는 있도록"
 *   - 값 치환: thinking 블록(혼합 행 한정), 도구 "결과", attachment 내용, base64 이미지 → placeholder
 *   - 행 삭제(v5 신규): thinking-only 행 / 훅 행 3형태(--hooks 스위치) / 합성 행 / (v4 계승) 로컬커맨드 행
 *   - 보존: 대화 텍스트, 사용자 발화, 편집 의도, uuid 체인, last-prompt 행, summary 행,
 *           ★ bash command 전문, ★ 파일 전체 경로   ← 2026-07-28 추가 (아래 [결정] 2개 절 참조)
 *
 * 무엇을 지우고 무엇을 남기나 (2026-07-28 현재):
 *   지운다  bash stdout/stderr · Read 파일내용 · Edit old/new_string · Write content ·
 *           tool_result · Task output · base64 이미지 · thinking · 훅 행 · 합성 행
 *   남긴다  bash command 전문 · Read/Edit/Write의 전체 경로 · Bash description ·
 *           Task description · row.cwd · 대화 텍스트 전부
 *   근거    "결과는 요약으로 대체되지만, 재현 수단(명령·경로)은 요약으로 복원되지 않는다."
 *           실측상 남기는 쪽 비용은 명령 1.70% + 경로 0.05% 로 작고,
 *           지우는 쪽(출력)이 명령의 2.8배라 감량 효과는 그대로다 (68.8% 감소 유지).
 *
 * 기본은 원본 파일을 in-place로 정리본과 교체한다. 원본 보존이 필요하면 --fork로
 * 00effaced{NNN} suffix의 사본을 만든다.
 *
 * 사용법:
 *   ./context-cleaner.ts <transcript.jsonl>                     # 기본: in-place + 훅 전부 삭제
 *   ./context-cleaner.ts <session-uuid | uuid접두>               # 경로 대신 uuid — ~/.claude/projects/<프로젝트폴더>/ 파일명 탐색
 *   ./context-cleaner.ts <transcript.jsonl> --fork              # 사본 생성(기존 동작)
 *   ./context-cleaner.ts <transcript.jsonl> --hooks keep        # 훅 전부 보존
 *   ./context-cleaner.ts <transcript.jsonl> --hooks sessionstart,stop
 *                                                               # 나열한 훅 이벤트만 보존, 나머지 삭제
 *
 * ============================================================================
 * [핵심 원칙 1 — 값은 치환(replace)만, 구조 변형 금지] (v4 계승)
 *   Claude Code는 resume 시 JSONL의 키가 존재한다고 가정하고 파싱한다.
 *   키 삭제·구조 변경(dict→str 등)은 런타임 에러 → 값만 placeholder로 치환한다.
 *   placeholder 문자열은 v4(python)와 "바이트 동일"하게 유지한다 — 이미 정리된 파일을
 *   재클리닝할 때 이중 치환을 막는 비교 조건이 전부 이 문자열 리터럴이기 때문.
 *
 * [핵심 원칙 2 — 행 삭제는 반드시 참조 재매핑과 한 몸] (v5)
 *   transcript에서 uuid를 참조하는 필드는 4종이다 (실측: v2.1.201):
 *     ① parentUuid                  — 대화 사슬 (모든 행)
 *     ② last-prompt.leafUuid        — resume 앵커 (아래 [last-prompt 지식] 참조)
 *     ③ file-history-snapshot.messageId — /rewind 파일 복원용, user 행 uuid와 1:1
 *     ④ sourceToolAssistantUUID     — tool_result(user 행) → tool_use(assistant 행) 역참조
 *   행을 삭제하면 ①②④는 "살아남은 조상"으로 재매핑하고, ③은 대상이 사라졌으면 스냅샷 행도
 *   함께 삭제한다. 실제 regression transcript에서 첫 last-prompt 앵커가 SessionStart 훅
 *   attachment 행을 가리킨 사례가 있었다 — 훅을 지우면서 ②를 재매핑하지 않으면 앵커가 끊긴다.
 *
 * [핵심 원칙 3 — 조상 기반 재연결 (v4 python과 다른 점)]
 *   v4는 삭제된 uuid를 "파일 순서상 직전에 살아남은 행"으로 재연결했다.
 *   평행세계(한 파일에 parentUuid 갈래 여러 개) 파일에서는 파일 순서가 갈래를 넘나들기
 *   때문에, 그 방식은 남의 갈래에 체인을 접붙일 수 있다 (regression transcript로 실증된 위험:
 *   a갈래 행 사이사이에 b갈래 행이 끼어 있음). v5는 삭제된 행의 "자기 parentUuid 사슬"을
 *   따라 올라가 가장 가까운 살아남은 조상으로 재연결한다. 조상이 전부 삭제됐으면 null(root).
 *
 * ============================================================================
 * [지식: last-prompt 앵커] (실증 2026-07-06, CC v2.1.201, 삭제 금지 대상)
 *   - resume은 "파일상 마지막 last-prompt 행의 leafUuid"를 앵커로 연다. 마지막 것이 이긴다.
 *     → 갈래 전환 = last-prompt 1줄 append (삭제·timestamp 조작 불필요, 완전 append-only)
 *   - leafUuid는 user 행이면 중간 지점이라도 유효(그 지점에서 절단되어 열림).
 *     assistant 행을 가리키면 무시되고 최신 leaf로 폴백.
 *   - 따라서 클리너는 last-prompt 행을 "절대 삭제하지 않고", 삭제된 행을 가리키는
 *     leafUuid만 살아남은 조상으로 재매핑한다.
 *
 * [지식: thinking 행과 signature]
 *   - thinking은 별도 assistant 행(내용이 thinking 블록뿐)으로 기록되며 체인 참가자다.
 *   - signature는 서버 암호화 서명: 1바이트라도 바꾸면 resume 시
 *     "thinking block cannot be modified" 400. "수정"은 불가하지만 "행 삭제"는 안전하다.
 *   - --thinking-display summarized 모드의 요약본도 같은 구조(assistant 행 + thinking 블록
 *     + signature, 내용만 요약 텍스트)라서 같은 삭제 규칙 하나로 처리된다. (실물 확인: 2026-07-07)
 *   - [thinking+text] 혼합 행은 실측된 적 없음 → 사전 방어 설계 없이 "모든 블록이 thinking류인
 *     행만 삭제"라는 규칙 하나만 둔다. 혼합이 실존하면 자연히 살아남고 통계(mixedThinkingRows)로
 *     보고되므로 실제 사례가 확인된 뒤 처리한다.
 *
 * [지식: 합성(synthetic) 행 — 왜 지우고, 왜 '지울 후보 1순위'인가]
 *   정체: CC가 resume 시 "응답 없이 끝난(pending) user 메시지"를 발견하면, 대화 상태를
 *   정리하려고 스스로 끼워 넣는 가짜 한 쌍이다:
 *     - user 행:      isMeta:true + text "Continue from where you left off."
 *     - assistant 행: message.model = "<synthetic>" (텍스트 "No response requested.")
 *   즉 모델이 생성한 응답도, 사람이 친 입력도 아닌 '접착제'다. (실물 transcript에서 확인, 2026-07-06)
 *   지울 후보 1순위인 이유:
 *     ① 대화 정보량이 0 — 흐름 기억에 기여하는 바이트가 한 글자도 없다.
 *     ② resume을 반복할 때마다 쌓인다 — 평행세계 운용(자주 열고 닫음)에서 순수 오염원.
 *     ③ 갈래 tip을 가짜 assistant가 차지한다 — pending user 행이 leaf일 때 생기는
 *        "입력창 프리필" 동작을 가리고, timestamp 최신 leaf 계산도 오염시킨다.
 *     ④ B' 정제(시행착오를 지우고 [A→B'] 한 쌍만 남기기)의 환상을 깨는 이물질이다.
 *   삭제 시 부모(pending user)가 다시 leaf로 복원된다 — 갈래를 이어가기에 오히려 좋은 상태.
 *
 * [지식: 훅 행 3형태] (전수조사 2026-07-07, 전부 명시 마커라 텍스트 추측 판별이 아님)
 *   ① progress 행:   data.type === "hook_progress"            (v4가 알던 유일한 형태)
 *   ② system 행:     subtype === "stop_hook_summary"           — Stop 훅 실행 요약
 *                     (hookCount/hookInfos[{command,durationMs}]/hookErrors 등. 체인 참가자)
 *   ③ attachment 행: attachment.type이 "hook_"으로 시작        — 훅 stdout 주입
 *                     (hookName "SessionStart:startup", hookEvent, stdout, exitCode, command...)
 *                     "transcript_path=...", "Session ID: ...", "OK" 행들이 전부 이것.
 *   v4는 ①만 인지했다(②③은 의도적 보존이 아니라 인지 밖). v5는 --hooks 스위치로 셋 다 다룬다.
 *   이벤트 매핑: ②=Stop, ③=attachment.hookEvent(SessionStart/UserPromptSubmit/...).
 *   ①은 이벤트 식별 필드가 버전에 따라 없을 수 있다 — data.hookEvent → data.hookName 순으로
 *   찾고, 없으면 이벤트 목록 모드에서는 화이트리스트 증명 불가로 "삭제"된다(주석 명시 사항).
 *
 * [지식: fix-session(pchalasani/claude-code-tools)에서 채택/기각한 아이디어]
 *   채택:
 *     - "끝에서부터 chain-walk" 진단(chain length / 최초 끊김 지점 보고) → verify에 내장
 *     - 사슬 사이클 가드(seen set) — 오염 파일에서 무한 루프 방지 → walk 전부에 적용
 *     - analyze → fix → re-analyze(수정 후 재검증) 패턴 → cleanTranscript가 출력 파일을
 *       다시 분석해 "입력보다 나빠진 게 없는지"를 기준으로 합격 판정
 *     - fix-session-metadata: 파일명 uuid ≠ 내부 sessionId 불일치가 실제로 문제를 일으킨다는
 *       교훈 → 우리는 생성 시점에 sessionId를 새 파일명으로 통일해 그 병을 예방
 *   기각(이유 있는 불채택):
 *     - fix-session의 고아 정의: "부모가 대화 타입({user,assistant,system,summary})이 아니면
 *       고아로 보고 재연결" — 이는 옛 버그(#22107, progress uuid 오염) 수리용 정의다.
 *       v2.1.201 정상 파일에서는 user 행의 부모가 system(turn_duration)/attachment인 것이
 *       "정상"임을 regression transcript에서 실측했다. 그 정의를 그대로 쓰면 건강한 체인을 오히려 파괴한다.
 *       → v5의 고아 정의는 "파일 안 어떤 uuid로도 해소되지 않는 parentUuid"뿐이다.
 *     - 파일 순서 기반 재연결 → [핵심 원칙 3]의 조상 기반으로 대체.
 *
 * [결정: bash command 보존] (2026-07-28, 주인님 지시)
 *   Bash tool_use의 input.command 는 "지우지 않는다". 출력(stdout/stderr)만 지운다.
 *   실측(이 결정을 내린 세션, 1526행 4249KB 기준):
 *     bash command  167개 / 72.4 KB / 약 20,600 tok / 전체의 1.70%
 *     bash 출력     171개 / 199.6 KB / 약 56,800 tok  ← 이건 계속 지운다 (명령의 2.8배)
 *   왜 살리나: 명령어에는 "어떤 옵션 조합으로 무엇을 알아냈는지"가 들어 있어 재현 가치가 크다.
 *     특히 필드 오프셋·정규식·파이프 조합 같은 시행착오는 응답 텍스트로 요약해도 복원이 안 된다.
 *     실제 사례 — awk로 로그를 집계할 때 "$(NF-4)처럼 뒤에서부터 센 이유(주파수 칸이
 *     '1900.00 Mhz'라 공백 포함 → 필드가 밀림)"가 명령 안 주석에만 있었고, 지우면 같은 함정을
 *     다시 밟는다. 1.7%를 내고 그걸 사는 편이 이득이라는 판단.
 *   끄는 법 (예전 동작으로 복귀): 아래 두 곳의 주석을 풀면 된다. 다른 수정 불필요.
 *     ① processLine() 안의 `// cleanBashInput(o, stats);`         — 메인 세션 Bash
 *     ② cleanAgentProgress() 안의 주석 처리된 command 블록          — 서브에이전트 Bash
 *   ※ 함수 cleanBashInput 자체는 지우지 않고 남겨둔다(호출만 끔) — 되살리기를 한 줄로 만들기 위해.
 *     그래서 통계의 bashInputCount/Bytes는 이 상태에서 항상 0이다(정상).
 *
 * [결정: 파일 경로 보존] (2026-07-28, 주인님 지시)
 *   Read/Edit/Write의 file_path 와 결과의 filePath 를 "자르지 않는다"(전체 경로 유지).
 *   실측(같은 세션): 경로 관련 34곳 ≈ 2 KB — 전체의 0.05%. 감량 효과가 사실상 없다.
 *   왜 살리나: 파일명만 남으면 같은 이름의 다른 파일을 구분할 수 없다.
 *     실사례 — 이 맥에는 CLAUDE.md 가 최소 2개다:
 *       /Users/…/project/CLAUDE.md  와  /Users/…/project/issue-00-ssh-19mbp/CLAUDE.md
 *     둘 다 "CLAUDE.md"로 뭉개지면 어느 파일을 고쳤는지 복원이 불가능하다.
 *     0.05%를 내고 그 구분을 사는 편이 압도적으로 이득.
 *   부수 효과(오히려 개선): MCP 도구의 file_path 는 원래부터 안 잘렸다
 *     (cleanInputFilepath가 name을 Read/Edit/Write로 한정하기 때문). 이제 일관성이 생긴다.
 *   끄는 법 (예전 동작으로 복귀): 아래 5곳의 주석을 풀면 된다. 다른 수정 불필요.
 *     ① processLine() 안의 `// cleanInputFilepath(o, stats);`  — 함수 전체가 경로 전용이라 호출만 끔
 *     ②~⑤ 각 함수 안의 주석 처리된 filePath 블록 (함수 본업은 따로 있어 블록만 끔):
 *          cleanAttachment / cleanReadResult / cleanWriteResult / cleanEditResult
 *   ※ row.cwd 는 원래부터 손대지 않는다 — resume 명령의 cd 대상을 만드는 근거이기 때문.
 *
 * [지식: 기타 관찰]
 *   - v2.1.201 행에는 sessionId(camelCase) 외에 session_id(snake_case)가 따로 있다.
 *     통일 대상은 sessionId뿐 (라운드2 결정: snake는 건드리지 않음 — 문제 증거 없음).
 *   - 세션이 "열려 있는 동안" 그 transcript를 편집하면 닫힐 때 덮어써진다.
 *     이 도구는 새 파일을 만들므로 안전하지만, 원본 in-place 편집 도구를 만들 땐 닫힘 감지 필수.
 *   - Ctrl+C 두 번으로 닫으면 CC는 종료 시 1~2줄(last-prompt 등)을 추가할 수 있다(실측).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

// ============================================================================
// 대체 텍스트 상수 — v4(python)와 바이트 동일 유지 (이중 치환 방지 비교에 쓰임)
// ============================================================================
const CLEANED_THINKING = "[context-cleaner: thinking]";
const CLEANED_FILE_CONTENT = "[context-cleaner: Read]";
const CLEANED_WRITE_INPUT = "[context-cleaner: Write]";
const CLEANED_WRITE_RESULT = "[context-cleaner: Write]";
const CLEANED_EDIT_INPUT = "[context-cleaner: Edit]";
const CLEANED_EDIT_RESULT = "[context-cleaner: Edit]";
const CLEANED_BASH_INPUT = "[context-cleaner: Bash]";
const CLEANED_BASH_OUTPUT = "[context-cleaner: Bash]";
const CLEANED_PLAN = "[context-cleaner: Plan]";
const CLEANED_TOOL_RESULT = "[context-cleaner: tool_result]";
const CLEANED_BASH_TAGS = "[context-cleaner: bash-output]";
const CLEANED_LOCAL_CMD_OUTPUT = "[context-cleaner: local-cmd-output]";
const CLEANED_USER_MARKED = "[context-cleaner: user-marked]";
const CLEANED_TASK_OUTPUT = "[context-cleaner: taskoutput]";
const CLEANED_TASK_PROMPT = "[context-cleaner: agent_prompt]";
const CLEANED_BASH_PROGRESS = "[context-cleaner: bashoutput]";
const CLEANED_AGENT_PROMPT = "[context-cleaner: agent_prompt]";
const CLEANED_BASE64_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const CLEANED_TOOL_RESULT_STRING = "[context-cleaner: tool_result_string]";
const CLEANED_TEAMMATE_MESSAGE = "[context-cleaner: teammate_message]";
const CLEANED_ATTACHMENT = "[context-cleaner: attachment]";
const CLEANED_META_CONTENT = "[context-cleaner: meta]";
const CLEANED_WORKFLOW_SCRIPT = "[context-cleaner: workflow_script]";
const CLEANED_ATTACHMENT_SNIPPET = "[context-cleaner: snippet]";
const CLEANED_QUEUE_OP = "[context-cleaner: queue_op]";
const CLEANED_TASK_RESULT = "[context-cleaner: task_result]";
const CLEANED_ORIGIN_BODY = "[context-cleaner: origin_body]";
const CLEANED_AGENT_MESSAGE = "[context-cleaner: agent_message]";

// 정규식 (python re.DOTALL → [\s\S])
const BASH_TAGS_PATTERN =
  /(<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*)?(<bash-input>[\s\S]*?<\/bash-input>\s*)?<bash-stdout>[\s\S]*?<\/bash-stdout>\s*<bash-stderr>[\s\S]*?<\/bash-stderr>/g;
const USER_MARKED_PATTERN = /<clean>[\s\S]*?<\/clean>/g;
const TEAMMATE_MESSAGE_PATTERN = /(<teammate-message[^>]*>)[\s\S]*?(<\/teammate-message>)/g;
const LOCAL_COMMAND_STDOUT_PATTERN = /(<local-command-stdout>)[\s\S]*?(<\/local-command-stdout>)/g;
const TASK_RESULT_PATTERN = /(<result>)[\s\S]*?(<\/result>)/g;
const AGENT_MESSAGE_PATTERN = /(<agent-message[^>]*>)[\s\S]*?(<\/agent-message>)/g;

// ============================================================================
// zod 상위 계약 — "우리가 읽고 분기하는 필드"의 의미 고정
// 심층 구조(message/attachment/data/toolUseResult)는 형태 다양성이 커서 스키마로 고정하면
// 미래 형식에서 클리닝이 통째로 스킵되는 역효과가 있다 → v4와 동일한 방어적 접근 유지.
// 계약 위반 행은 건드리지 않고 원문 그대로 보존한다(contractMissRows로 보고).
// ============================================================================
const RowCoreSchema = z
  .object({
    type: z.string().optional(),              // 행 종류 (user/assistant/system/attachment/progress/last-prompt/...)
    subtype: z.string().optional(),           // system 행 세부 (turn_duration/stop_hook_summary/local_command/...)
    uuid: z.string().optional(),              // 이 행의 식별자 (체인 노드)
    parentUuid: z.string().nullable().optional(), // 대화 사슬 부모
    isMeta: z.boolean().optional(),           // CC가 끼운 메타 행 표시 (합성 user 행 판별에 사용)
    isSidechain: z.boolean().optional(),      // 서브에이전트 사이드체인 여부
    sessionId: z.string().optional(),         // 파일명과 통일되어야 하는 세션 식별자 (camelCase만)
    leafUuid: z.string().optional(),          // last-prompt 행: resume 앵커
    messageId: z.string().optional(),         // file-history-snapshot 행: 대상 user 행 uuid
    sourceToolAssistantUUID: z.string().optional(), // tool_result → tool_use 역참조
  })
  .catchall(z.unknown());
export type RowCore = z.infer<typeof RowCoreSchema>; // 후속 도구(TS 스위처)가 같은 계약을 import해 쓴다

/** --hooks 플래그 3모드 (라운드2 확정 문법: delete | keep | 이벤트,이벤트 → 적은 것만 살림) */
export type HooksMode =
  | { mode: "delete" }
  | { mode: "keep" }
  | { mode: "keep-events"; events: Set<string> };

export function parseHooksFlag(v: string | undefined): HooksMode {
  if (v === undefined || v === "" || v.toLowerCase() === "delete") return { mode: "delete" };
  if (v.toLowerCase() === "keep") return { mode: "keep" };
  const events = new Set(
    v
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return { mode: "keep-events", events };
}

const byteLen = (s: unknown) => Buffer.byteLength(String(s), "utf8");

// ============================================================================
// 통계
// ============================================================================
class CleaningStats {
  // ── v4 계승 (값 치환) ──
  thinkingCount = 0; thinkingBytes = 0;
  readCount = 0; readBytes = 0;
  writeInputCount = 0; writeInputBytes = 0;
  writeResultCount = 0; writeResultBytes = 0;
  editInputCount = 0; editInputBytes = 0;
  editResultCount = 0; editResultBytes = 0;
  bashInputCount = 0; bashInputBytes = 0;
  bashOutputCount = 0; bashOutputBytes = 0;
  filenamesCount = 0; filenamesBytes = 0;
  exitplanCount = 0; exitplanBytes = 0;
  toolResultCount = 0; toolResultBytes = 0;
  sessionidCount = 0;
  bashTagsCount = 0; bashTagsBytes = 0;
  userMarkedCount = 0; userMarkedBytes = 0;
  taskOutputCount = 0; taskOutputBytes = 0;
  bashProgressCount = 0; bashProgressBytes = 0;
  metaContentCount = 0; metaContentBytes = 0;
  localCmdOutputCount = 0; localCmdOutputBytes = 0;
  agentProgressCount = 0; agentProgressBytes = 0;
  taskContentTextCount = 0; taskContentTextBytes = 0;
  base64ImageCount = 0; base64ImageBytes = 0;
  toolResultStringCount = 0; toolResultStringBytes = 0;
  teammateMessageCount = 0; teammateMessageBytes = 0;
  toolUseResultPromptCount = 0; toolUseResultPromptBytes = 0;
  localCommandStdoutCount = 0; localCommandStdoutBytes = 0;
  toolUseInputPromptCount = 0; toolUseInputPromptBytes = 0;
  attachmentCount = 0; attachmentBytes = 0;
  workflowScriptCount = 0; workflowScriptBytes = 0;
  queueOpCount = 0; queueOpBytes = 0;
  taskNotifyCount = 0; taskNotifyBytes = 0;
  originBodyCount = 0; originBodyBytes = 0;
  agentMessageCount = 0; agentMessageBytes = 0;
  // ── v4 계승 (행 삭제) ──
  localCmdRowsDeleted = 0;
  // ── v5 신규 (행 삭제) ──
  thinkingRowsDeleted = 0; thinkingRowsBytes = 0;
  mixedThinkingRows = 0; // 실측된 적 없는 혼합 행 — 발생하면 삭제하지 않고 여기로 보고 (그때 처리)
  hookRowsDeleted = 0; hookRowsBytes = 0;
  hookRowsByKey = new Map<string, number>(); // "form/event" → count
  syntheticRowsDeleted = 0; syntheticRowsBytes = 0;
  snapshotRowsDropped = 0; // 삭제된 user 행을 가리키던 file-history-snapshot 행
  // ── v5 신규 (재매핑) ──
  leafUuidRemapped = 0; leafUuidDropped = 0;
  sourceToolRemapped = 0; sourceToolDropped = 0;
  preexistingDanglingRooted = 0; // 원본부터 끊겨 있던 parentUuid → 키 제거(root화, v4 2.5단계 계승)
  contractMissRows = 0; // RowCore 계약 위반으로 건드리지 않고 통과시킨 행

  totalReplacedBytes(): number {
    return (
      this.thinkingBytes + this.readBytes + this.writeInputBytes + this.writeResultBytes +
      this.editInputBytes + this.editResultBytes + this.bashInputBytes + this.bashOutputBytes +
      this.filenamesBytes + this.exitplanBytes + this.toolResultBytes + this.bashTagsBytes +
      this.userMarkedBytes + this.taskOutputBytes + this.bashProgressBytes + this.metaContentBytes +
      this.localCmdOutputBytes + this.agentProgressBytes + this.taskContentTextBytes +
      this.base64ImageBytes + this.toolResultStringBytes + this.teammateMessageBytes +
      this.workflowScriptBytes +
      this.toolUseResultPromptBytes + this.localCommandStdoutBytes + this.toolUseInputPromptBytes +
      this.attachmentBytes +
      this.queueOpBytes + this.taskNotifyBytes + this.originBodyBytes + this.agentMessageBytes
    );
  }

  print(sourcePath: string, outputPath: string, originalSize: number, newSize: number, resumeCommand: string) {
    const L = (label: string, count: number, bytes?: number) =>
      console.log(`  ${label.padEnd(21)}${String(count).padStart(4)} ${bytes === undefined ? "removed" : `cleaned (${bytes.toLocaleString()} bytes)`}`);
    console.log(`\n✅ Context Cleaner v5 (TS) completed!`);
    console.log(`\n📁 Source: ${sourcePath}`);
    console.log(`📁 Output: ${outputPath}`);
    console.log(`\n📊 Cleaning Statistics (값 치환):`);
    L("Thinking blocks:", this.thinkingCount, this.thinkingBytes);
    L("Read results:", this.readCount, this.readBytes);
    L("Write inputs:", this.writeInputCount, this.writeInputBytes);
    L("Write results:", this.writeResultCount, this.writeResultBytes);
    L("Edit inputs:", this.editInputCount, this.editInputBytes);
    L("Edit results:", this.editResultCount, this.editResultBytes);
    L("Bash inputs:", this.bashInputCount, this.bashInputBytes);
    L("Bash outputs:", this.bashOutputCount, this.bashOutputBytes);
    L("Filenames:", this.filenamesCount, this.filenamesBytes);
    L("ExitPlanMode:", this.exitplanCount, this.exitplanBytes);
    L("Tool results:", this.toolResultCount, this.toolResultBytes);
    L("Task outputs:", this.taskOutputCount, this.taskOutputBytes);
    L("Bash progress:", this.bashProgressCount, this.bashProgressBytes);
    L("Agent progress:", this.agentProgressCount, this.agentProgressBytes);
    L("Task content text:", this.taskContentTextCount, this.taskContentTextBytes);
    L("Bash tags:", this.bashTagsCount, this.bashTagsBytes);
    L("User marked:", this.userMarkedCount, this.userMarkedBytes);
    L("Meta content:", this.metaContentCount, this.metaContentBytes);
    L("Local cmd output:", this.localCmdOutputCount, this.localCmdOutputBytes);
    L("Base64 images:", this.base64ImageCount, this.base64ImageBytes);
    L("Tool result string:", this.toolResultStringCount, this.toolResultStringBytes);
    L("Teammate message:", this.teammateMessageCount, this.teammateMessageBytes);
    L("ToolResult prompt:", this.toolUseResultPromptCount, this.toolUseResultPromptBytes);
    L("Local cmd stdout:", this.localCommandStdoutCount, this.localCommandStdoutBytes);
    L("ToolUse inp prompt:", this.toolUseInputPromptCount, this.toolUseInputPromptBytes);
    L("Attachments:", this.attachmentCount, this.attachmentBytes);
    L("Workflow scripts:", this.workflowScriptCount, this.workflowScriptBytes);
    L("Queue-op content:", this.queueOpCount, this.queueOpBytes);
    L("Task notify result:", this.taskNotifyCount, this.taskNotifyBytes);
    L("Origin body:", this.originBodyCount, this.originBodyBytes);
    L("Agent message:", this.agentMessageCount, this.agentMessageBytes);
    console.log(`\n🗑  Row Deletions (행 삭제 + 재매핑):`);
    console.log(`  Thinking rows:       ${String(this.thinkingRowsDeleted).padStart(4)} deleted (${this.thinkingRowsBytes.toLocaleString()} bytes)`);
    console.log(`  Hook rows:           ${String(this.hookRowsDeleted).padStart(4)} deleted (${this.hookRowsBytes.toLocaleString()} bytes)`);
    for (const [k, n] of this.hookRowsByKey) console.log(`      - ${k}: ${n}`);
    console.log(`  Synthetic rows:      ${String(this.syntheticRowsDeleted).padStart(4)} deleted (${this.syntheticRowsBytes.toLocaleString()} bytes)`);
    console.log(`  Local-cmd rows:      ${String(this.localCmdRowsDeleted).padStart(4)} deleted`);
    console.log(`  Snapshot rows:       ${String(this.snapshotRowsDropped).padStart(4)} dropped (삭제된 메시지 참조)`);
    console.log(`  leafUuid remapped:   ${String(this.leafUuidRemapped).padStart(4)} / dropped: ${this.leafUuidDropped}`);
    console.log(`  sourceTool remapped: ${String(this.sourceToolRemapped).padStart(4)} / dropped: ${this.sourceToolDropped}`);
    console.log(`  Dangling rooted:     ${String(this.preexistingDanglingRooted).padStart(4)} (원본부터 끊겨 있던 parentUuid)`);
    if (this.mixedThinkingRows > 0)
      console.log(`  ⚠ Mixed thinking rows kept: ${this.mixedThinkingRows} — 실측 첫 사례! 규칙 추가 검토 필요`);
    if (this.contractMissRows > 0)
      console.log(`  ⚠ Contract-miss rows (그대로 보존): ${this.contractMissRows}`);
    console.log(`  SessionId updated:   ${String(this.sessionidCount).padStart(4)} entries`);
    console.log(`\n💾 Replaced bytes: ${this.totalReplacedBytes().toLocaleString()} (${(this.totalReplacedBytes() / 1024).toFixed(1)} KB)`);
    console.log(`📦 Original size: ${originalSize.toLocaleString()} bytes`);
    console.log(`📦 New size: ${newSize.toLocaleString()} bytes (${(100 * (1 - newSize / originalSize)).toFixed(1)}% reduction)`);
    console.log(`\n🚀 To resume this cleaned session, run:`);
    console.log(`   ${resumeCommand}`);
  }
}

// ============================================================================
// 파일명 규칙 (v4 계승 + 보강)
// ============================================================================
/** 마지막 12자를 00effaced{NNN}으로 교체. 이미 effaced면 숫자+1 (v4와 동일 규칙) */
export function convertFilename(originalPath: string): string {
  const dirname = path.dirname(originalPath);
  const basename = path.basename(originalPath);
  if (!basename.endsWith(".jsonl")) return path.join(dirname, basename + "-00effaced001.jsonl");
  const namePart = basename.slice(0, -6);
  if (namePart.length < 12) return path.join(dirname, namePart + "-00effaced001.jsonl");
  const last12 = namePart.slice(-12);
  const prefix = namePart.slice(0, -12);
  const m = /^00effaced(\d{3})$/.exec(last12);
  const newSuffix = m ? `00effaced${String(parseInt(m[1], 10) + 1).padStart(3, "0")}` : "00effaced001";
  return path.join(dirname, prefix + newSuffix + ".jsonl");
}

/**
 * [v5 보강] 출력 경로가 이미 존재하면 NNN을 빈 번호까지 올린다.
 * SKILL.md의 실수 사례("원본 재클리닝이 기존 00effaced001을 덮어써 비교 기준 소실")를
 * 코드로 원천 봉쇄 — 이 도구는 어떤 경우에도 기존 파일을 덮어쓰지 않는다.
 */
export function nextFreeOutputPath(originalPath: string): string {
  let candidate = convertFilename(originalPath);
  for (let guard = 0; guard < 999 && existsSync(candidate); guard++) {
    candidate = convertFilename(candidate); // effaced 파일명을 입력하면 NNN+1이 되는 규칙 재활용
  }
  return candidate;
}

export function sessionIdFromPath(p: string): string {
  const base = path.basename(p);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : base;
}

// ============================================================================
// 값 치환 클리너들 — v4 python의 1:1 포팅 (동작·placeholder·판정 조건 동일)
// 각 함수는 독립적이며 실패해도(예외) 다른 클리너에 영향을 주지 않는다.
// ============================================================================
type Row = Record<string, any>;

/** thinking "블록" 치환 — 삭제되지 않은(=혼합) 행에만 잔여 적용. signature는 절대 불변.
 *  v4는 content[0]만 봤지만 v5는 모든 thinking 블록을 본다(상위집합, 안전). */
function cleanThinkingBlocks(o: Row, stats: CleaningStats): boolean {
  try {
    const content = o?.message?.content;
    if (!Array.isArray(content)) return false;
    let cleaned = false;
    for (const b of content) {
      if (b && b.type === "thinking" && typeof b.thinking === "string" && b.thinking && b.thinking !== CLEANED_THINKING) {
        stats.thinkingCount++;
        stats.thinkingBytes += byteLen(b.thinking);
        b.thinking = CLEANED_THINKING;
        cleaned = true;
      }
    }
    return cleaned;
  } catch { return false; }
}

/** attachment 정리. hookAware: --hooks keep 계열로 "살아남은 훅 attachment"는 내용도 원문 보존
 *  (keep의 의미는 보존이므로 placeholder 치환도 하지 않는다 — v4엔 없던 분기) */
function cleanAttachment(o: Row, stats: CleaningStats, keepHookContent: boolean): boolean {
  try {
    const attachment = o?.attachment;
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return false;
    if (keepHookContent && typeof attachment.type === "string" && attachment.type.startsWith("hook_")) return false;
    const content = attachment.content;
    let cleaned = false;
    // 외부에서 파일이 바뀐 것을 알리는 첨부(type="edited_text_file")는 본문을
    // content가 아니라 snippet에 담는다 → v4 규칙이 이 자리를 지나쳤다.
    // 실측(2026-07-31): 8행 57,128B가 남아 컨텍스트 Messages를 14.6k 더 먹고 있었다
    // (제거 후 80.4k→65.8k). 대상 파일은 디스크에 실물로 있고 filename이 남으므로
    // 유일본이 아니다. 행은 uuid를 갖고 자식이 매달려 있어 삭제하지 않고 값만 치환한다.
    if (typeof attachment.snippet === "string" && attachment.snippet && attachment.snippet !== CLEANED_ATTACHMENT_SNIPPET) {
      stats.attachmentCount++;
      stats.attachmentBytes += byteLen(attachment.snippet);
      attachment.snippet = CLEANED_ATTACHMENT_SNIPPET;
      cleaned = true;
    }
    if (typeof content === "string") {
      if (content && content !== CLEANED_ATTACHMENT) {
        stats.attachmentCount++;
        stats.attachmentBytes += byteLen(content);
        attachment.content = CLEANED_ATTACHMENT;
        cleaned = true;
      }
    } else if (content && typeof content === "object" && !Array.isArray(content)) {
      const fileObj = (content as Row).file;
      if (fileObj && typeof fileObj === "object") {
        if ("content" in fileObj) {
          const original = fileObj.content;
          if (original && original !== CLEANED_FILE_CONTENT) {
            stats.attachmentCount++;
            stats.attachmentBytes += byteLen(original);
            fileObj.content = CLEANED_FILE_CONTENT;
            cleaned = true;
          }
        }
        // ★ [2026-07-28] 경로 보존 — 아래 블록 주석을 풀면 예전처럼 basename만 남긴다.
        //   헤더 [결정: 파일 경로 보존] 참조. (attachment 안의 filePath)
        // if ("filePath" in fileObj && typeof fileObj.filePath === "string") {
        //   const np = path.basename(fileObj.filePath);
        //   if (fileObj.filePath !== np) {
        //     stats.attachmentBytes += byteLen(fileObj.filePath) - byteLen(np);
        //     fileObj.filePath = np;
        //     cleaned = true;
        //   }
        // }
      }
    }
    return cleaned;
  } catch { return false; }
}

function cleanReadResult(o: Row, stats: CleaningStats): boolean {
  try {
    const fileObj = o?.toolUseResult?.file;
    if (!fileObj || typeof fileObj !== "object") return false;
    let cleaned = false;
    // 도구가 반환한 이미지의 두 번째 사본. 같은 이미지가 message.content 쪽
    // tool_result 안에도 들어 있어 두 자리를 함께 지워야 실효가 있다.
    // 치환값은 반드시 유효한 1x1 PNG — API가 이 값을 디코딩하므로 깨진 값은 400을 낸다.
    // originalSize·dimensions·type 같은 메타는 건드리지 않는다(content 필드와 동일 원칙).
    if ("base64" in fileObj && typeof fileObj.base64 === "string" && fileObj.base64 !== CLEANED_BASE64_IMAGE) {
      stats.base64ImageCount++;
      stats.base64ImageBytes += byteLen(fileObj.base64);
      fileObj.base64 = CLEANED_BASE64_IMAGE;
      cleaned = true;
    }
    if ("content" in fileObj && fileObj.content && fileObj.content !== CLEANED_FILE_CONTENT) {
      stats.readCount++;
      stats.readBytes += byteLen(fileObj.content);
      fileObj.content = CLEANED_FILE_CONTENT;
      cleaned = true;
    }
    // ★ [2026-07-28] 경로 보존 — 아래 블록 주석을 풀면 복귀. 헤더 [결정: 파일 경로 보존] 참조.
    // if ("filePath" in fileObj && typeof fileObj.filePath === "string") {
    //   const np = path.basename(fileObj.filePath);
    //   if (fileObj.filePath !== np) {
    //     stats.readBytes += byteLen(fileObj.filePath) - byteLen(np);
    //     fileObj.filePath = np;
    //     cleaned = true;
    //   }
    // }
    return cleaned;
  } catch { return false; }
}

function cleanWriteInput(o: Row, stats: CleaningStats): boolean {
  try {
    const first = o?.message?.content?.[0];
    if (first?.name === "Write" && first?.type === "tool_use") {
      const inp = first.input;
      if (inp && typeof inp === "object" && "content" in inp && inp.content && inp.content !== CLEANED_WRITE_INPUT) {
        stats.writeInputCount++;
        stats.writeInputBytes += byteLen(inp.content);
        inp.content = CLEANED_WRITE_INPUT;
        return true;
      }
    }
    return false;
  } catch { return false; }
}

function cleanWriteResult(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    if (result && typeof result === "object" && "content" in result && ["create", "update"].includes(result.type)) {
      let cleaned = false;
      if (result.content && result.content !== CLEANED_WRITE_RESULT) {
        stats.writeResultCount++;
        stats.writeResultBytes += byteLen(result.content);
        result.content = CLEANED_WRITE_RESULT;
        cleaned = true;
      }
      if ("originalFile" in result && result.originalFile && result.originalFile !== CLEANED_WRITE_RESULT) {
        stats.writeResultBytes += byteLen(result.originalFile);
        result.originalFile = CLEANED_WRITE_RESULT;
        cleaned = true;
      }
      // ★ [2026-07-28] 경로 보존 — 아래 블록 주석을 풀면 복귀. 헤더 [결정: 파일 경로 보존] 참조.
      // if ("filePath" in result && typeof result.filePath === "string") {
      //   const np = path.basename(result.filePath);
      //   if (result.filePath !== np) {
      //     stats.writeResultBytes += byteLen(result.filePath) - byteLen(np);
      //     result.filePath = np;
      //     cleaned = true;
      //   }
      // }
      if (Array.isArray(result.structuredPatch)) {
        for (const patch of result.structuredPatch)
          if (patch && Array.isArray(patch.lines)) for (const line of patch.lines) if (line) stats.writeResultBytes += byteLen(line);
        result.structuredPatch = []; // 삭제하면 에러 — 빈 배열로 (v4 원칙)
        cleaned = true;
      }
      return cleaned;
    }
    return false;
  } catch { return false; }
}

function cleanEditInput(o: Row, stats: CleaningStats): boolean {
  try {
    const first = o?.message?.content?.[0];
    if (first?.name === "Edit" && first?.type === "tool_use" && first.input && typeof first.input === "object") {
      let cleaned = false;
      for (const field of ["old_string", "new_string"]) {
        if (field in first.input && first.input[field] && first.input[field] !== CLEANED_EDIT_INPUT) {
          stats.editInputBytes += byteLen(first.input[field]);
          first.input[field] = CLEANED_EDIT_INPUT;
          cleaned = true;
        }
      }
      if (cleaned) { stats.editInputCount++; return true; }
    }
    return false;
  } catch { return false; }
}

function cleanEditResult(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    if (result && typeof result === "object" && "oldString" in result) {
      let cleaned = false;
      for (const field of ["oldString", "newString", "originalFile"]) {
        if (field in result && result[field] && result[field] !== CLEANED_EDIT_RESULT) {
          stats.editResultBytes += byteLen(result[field]);
          result[field] = CLEANED_EDIT_RESULT;
          cleaned = true;
        }
      }
      // ★ [2026-07-28] 경로 보존 — 아래 블록 주석을 풀면 복귀. 헤더 [결정: 파일 경로 보존] 참조.
      // if ("filePath" in result && typeof result.filePath === "string") {
      //   const np = path.basename(result.filePath);
      //   if (result.filePath !== np) {
      //     stats.editResultBytes += byteLen(result.filePath) - byteLen(np);
      //     result.filePath = np;
      //     cleaned = true;
      //   }
      // }
      if (Array.isArray(result.structuredPatch)) {
        for (const patch of result.structuredPatch)
          if (patch && Array.isArray(patch.lines)) for (const line of patch.lines) if (line) stats.editResultBytes += byteLen(line);
        result.structuredPatch = [];
        cleaned = true;
      }
      if (cleaned) { stats.editResultCount++; return true; }
    }
    return false;
  } catch { return false; }
}

function cleanBashInput(o: Row, stats: CleaningStats): boolean {
  try {
    const first = o?.message?.content?.[0];
    if (first?.name === "Bash" && first?.type === "tool_use") {
      const inp = first.input;
      if (inp && typeof inp === "object" && "command" in inp && inp.command && inp.command !== CLEANED_BASH_INPUT) {
        stats.bashInputCount++;
        stats.bashInputBytes += byteLen(inp.command);
        inp.command = CLEANED_BASH_INPUT;
        return true;
      }
    }
    return false;
  } catch { return false; }
}

function cleanBashResult(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    if (result && typeof result === "object" && ("stdout" in result || "stderr" in result)) {
      let cleaned = false;
      for (const field of ["stdout", "stderr"]) {
        if (field in result && result[field] && result[field] !== CLEANED_BASH_OUTPUT) {
          stats.bashOutputBytes += byteLen(result[field]);
          result[field] = CLEANED_BASH_OUTPUT;
          cleaned = true;
        }
      }
      if (cleaned) { stats.bashOutputCount++; return true; }
    }
    return false;
  } catch { return false; }
}

function cleanFilenamesResult(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    if (result && typeof result === "object" && Array.isArray(result.filenames) && result.filenames.length > 0) {
      if (result.filenames.length === 1 && result.filenames[0] === "") return false; // 이미 처리됨
      for (const f of result.filenames) if (f) stats.filenamesBytes += byteLen(f);
      stats.filenamesCount++;
      result.filenames = [""];
      return true;
    }
    return false;
  } catch { return false; }
}

function cleanExitPlanModeInput(o: Row, stats: CleaningStats): boolean {
  try {
    const first = o?.message?.content?.[0];
    if (first?.name === "ExitPlanMode" && first?.type === "tool_use") {
      const inp = first.input;
      if (inp && typeof inp === "object" && "plan" in inp && inp.plan && inp.plan !== CLEANED_PLAN) {
        stats.exitplanCount++;
        stats.exitplanBytes += byteLen(inp.plan);
        inp.plan = CLEANED_PLAN;
        return true;
      }
    }
    return false;
  } catch { return false; }
}

function cleanToolResultContent(o: Row, stats: CleaningStats): boolean {
  try {
    const first = o?.message?.content?.[0];
    if (first && typeof first === "object" && first.type === "tool_result" && "content" in first) {
      const original = first.content;
      if (typeof original === "string") {
        if (original && original !== CLEANED_TOOL_RESULT) {
          stats.toolResultCount++;
          stats.toolResultBytes += byteLen(original);
          first.content = CLEANED_TOOL_RESULT;
          return true;
        }
      } else if (Array.isArray(original)) {
        let cleaned = false;
        for (const item of original) {
          if (item && typeof item === "object" && "text" in item && item.text && item.text !== CLEANED_TOOL_RESULT) {
            stats.toolResultBytes += byteLen(item.text);
            item.text = CLEANED_TOOL_RESULT;
            cleaned = true;
          }
        }
        if (cleaned) { stats.toolResultCount++; return true; }
      }
    }
    return false;
  } catch { return false; }
}

function cleanListToolUseResult(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    if (Array.isArray(result)) {
      let cleaned = false;
      for (const item of result) {
        if (item && typeof item === "object" && "text" in item && item.text && item.text !== CLEANED_TOOL_RESULT) {
          stats.toolResultBytes += byteLen(item.text);
          item.text = CLEANED_TOOL_RESULT;
          cleaned = true;
        }
      }
      if (cleaned) { stats.toolResultCount++; return true; }
    }
    return false;
  } catch { return false; }
}

// 서브에이전트 결과는 toolUseResult.task 안에 네 자리로 흩어져 있다.
//   .output  31B 안내문 ("Task output retrieved separately")
//   .result  본문 — 실측(838ef40d) 28,047B. 여기가 실제 덩어리다
//   .prompt  서브에이전트에 준 지시문. 호출 쪽 input.prompt와 같은 값의 사본이며
//            그쪽은 cleanToolUseInputPrompt가 이미 치운다 (두 자리 중 한쪽만 지우던 상태였다)
// task_id·task_type·status·description은 무엇을 위임했는지의 색인이라 보존한다.
function cleanTaskOutput(o: Row, stats: CleaningStats): boolean {
  try {
    const task = o?.toolUseResult?.task;
    if (!task || typeof task !== "object") return false;
    let cleaned = false;
    for (const [key, placeholder] of [["output", CLEANED_TASK_OUTPUT], ["result", CLEANED_TASK_OUTPUT], ["prompt", CLEANED_TASK_PROMPT]] as const) {
      const v = task[key];
      if (typeof v === "string" && v.length > 0 && v !== placeholder) {
        stats.taskOutputBytes += byteLen(v);
        task[key] = placeholder;
        cleaned = true;
      }
    }
    if (cleaned) { stats.taskOutputCount++; return true; }
    return false;
  } catch { return false; }
}

function cleanTaskContentText(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const content = result.content;
    if (!Array.isArray(content)) return false;
    if (["create", "update"].includes(result.type)) return false; // Write 결과는 별도 처리
    if ("task" in result) return false; // task 결과도 별도 처리
    let cleaned = false;
    for (const item of content) {
      if (item && typeof item === "object" && "text" in item && item.text && item.text !== CLEANED_TOOL_RESULT) {
        stats.taskContentTextBytes += byteLen(item.text);
        item.text = CLEANED_TOOL_RESULT;
        cleaned = true;
      }
    }
    if (typeof result.prompt === "string" && result.prompt && result.prompt !== CLEANED_AGENT_PROMPT) {
      stats.taskContentTextBytes += byteLen(result.prompt);
      result.prompt = CLEANED_AGENT_PROMPT;
      cleaned = true;
    }
    if (cleaned) { stats.taskContentTextCount++; return true; }
    return false;
  } catch { return false; }
}

function cleanBashProgress(o: Row, stats: CleaningStats): boolean {
  try {
    if (o?.type !== "progress") return false;
    const data = o.data;
    if (data && typeof data === "object" && data.type === "bash_progress") {
      let cleaned = false;
      for (const field of ["output", "fullOutput"]) {
        if (field in data && data[field] && data[field] !== CLEANED_BASH_PROGRESS) {
          stats.bashProgressBytes += byteLen(data[field]);
          data[field] = CLEANED_BASH_PROGRESS;
          cleaned = true;
        }
      }
      if (cleaned) { stats.bashProgressCount++; return true; }
    }
    return false;
  } catch { return false; }
}

function cleanAgentProgress(o: Row, stats: CleaningStats): boolean {
  try {
    if (o?.type !== "progress") return false;
    const data = o.data;
    if (!data || typeof data !== "object" || data.type !== "agent_progress") return false;
    let cleaned = false;
    if (typeof data.prompt === "string" && data.prompt && data.prompt !== CLEANED_AGENT_PROMPT) {
      stats.agentProgressBytes += byteLen(data.prompt);
      data.prompt = CLEANED_AGENT_PROMPT;
      cleaned = true;
    }
    const contentList = data?.message?.message?.content;
    if (Array.isArray(contentList)) {
      for (const item of contentList) {
        if (!item || typeof item !== "object") continue;
        if ("content" in item) {
          const cv = item.content;
          if (typeof cv === "string") {
            if (cv && cv !== CLEANED_TOOL_RESULT) {
              stats.agentProgressBytes += byteLen(cv);
              item.content = CLEANED_TOOL_RESULT;
              cleaned = true;
            }
          } else if (Array.isArray(cv)) {
            for (const sub of cv) {
              if (sub && typeof sub === "object" && "text" in sub && sub.text && sub.text !== CLEANED_TOOL_RESULT) {
                stats.agentProgressBytes += byteLen(sub.text);
                sub.text = CLEANED_TOOL_RESULT;
                cleaned = true;
              }
            }
          }
        }
        // ★ [2026-07-28 결정] 서브에이전트의 bash command도 살려둔다 — 아래 블록 주석을 풀면 복귀.
        //   메인(cleanBashInput)과 같은 이유. 파일 헤더 [결정: bash command 보존] 참조.
        // const inp = item.input;
        // if (inp && typeof inp === "object" && typeof inp.command === "string" && inp.command && inp.command !== CLEANED_BASH_INPUT) {
        //   stats.agentProgressBytes += byteLen(inp.command);
        //   inp.command = CLEANED_BASH_INPUT;
        //   cleaned = true;
        // }
        if (item.type === "text" && typeof item.text === "string" && item.text.length > 100 && !item.text.includes("[context-cleaner:")) {
          stats.agentProgressBytes += byteLen(item.text);
          item.text = CLEANED_AGENT_PROMPT;
          cleaned = true;
        }
      }
    }
    if (cleaned) { stats.agentProgressCount++; return true; }
    return false;
  } catch { return false; }
}

function cleanInputFilepath(o: Row, stats: CleaningStats): boolean {
  try {
    const first = o?.message?.content?.[0];
    if (first?.type === "tool_use" && ["Read", "Edit", "Write"].includes(first?.name)) {
      const inp = first.input;
      if (inp && typeof inp === "object" && typeof inp.file_path === "string") {
        const np = path.basename(inp.file_path);
        if (inp.file_path !== np) {
          stats.filenamesBytes += byteLen(inp.file_path) - byteLen(np);
          inp.file_path = np;
          return true;
        }
      }
    }
    return false;
  } catch { return false; }
}

function cleanBashTags(o: Row, stats: CleaningStats): boolean {
  try {
    const message = o?.message;
    if (!message || typeof message !== "object") return false;
    const content = message.content;
    if (typeof content === "string" && content) {
      const stripped = content.trim();
      // 전체가 감싸진 경우 (lazy .*?가 내부 리터럴에 걸리는 버그 방지 — v4 계승)
      if (stripped.startsWith("<bash-stdout>") && stripped.endsWith("</bash-stderr>")) {
        stats.bashTagsBytes += byteLen(content);
        stats.bashTagsCount++;
        message.content = CLEANED_BASH_TAGS;
        return true;
      }
      const matches = [...content.matchAll(BASH_TAGS_PATTERN)];
      if (matches.length > 0) {
        for (const m of matches) stats.bashTagsBytes += byteLen(m[0]);
        stats.bashTagsCount += matches.length;
        message.content = content.replace(BASH_TAGS_PATTERN, CLEANED_BASH_TAGS);
        return true;
      }
    }
    if (Array.isArray(content)) {
      let cleaned = false;
      for (const item of content) {
        if (item && typeof item === "object" && typeof item.text === "string") {
          const matches = [...item.text.matchAll(BASH_TAGS_PATTERN)];
          if (matches.length > 0) {
            for (const m of matches) stats.bashTagsBytes += byteLen(m[0]);
            stats.bashTagsCount += matches.length;
            item.text = item.text.replace(BASH_TAGS_PATTERN, CLEANED_BASH_TAGS);
            cleaned = true;
          }
        }
      }
      return cleaned;
    }
    return false;
  } catch { return false; }
}

function cleanUserMarked(o: Row, stats: CleaningStats): boolean {
  try {
    const message = o?.message;
    if (!message || typeof message !== "object") return false;
    const content = message.content;
    if (typeof content === "string" && content) {
      const matches = [...content.matchAll(USER_MARKED_PATTERN)];
      if (matches.length > 0) {
        for (const m of matches) stats.userMarkedBytes += byteLen(m[0]);
        stats.userMarkedCount += matches.length;
        message.content = content.replace(USER_MARKED_PATTERN, CLEANED_USER_MARKED);
        return true;
      }
    }
    if (Array.isArray(content)) {
      let cleaned = false;
      for (const item of content) {
        if (item && typeof item === "object" && typeof item.text === "string") {
          const matches = [...item.text.matchAll(USER_MARKED_PATTERN)];
          if (matches.length > 0) {
            for (const m of matches) stats.userMarkedBytes += byteLen(m[0]);
            stats.userMarkedCount += matches.length;
            item.text = item.text.replace(USER_MARKED_PATTERN, CLEANED_USER_MARKED);
            cleaned = true;
          }
        }
      }
      return cleaned;
    }
    return false;
  } catch { return false; }
}

function cleanMetaContent(o: Row, stats: CleaningStats): boolean {
  try {
    if (!o?.isMeta) return false;
    const first = o?.message?.content?.[0];
    if (first && typeof first === "object" && "text" in first && first.text && first.text !== CLEANED_META_CONTENT) {
      stats.metaContentCount++;
      stats.metaContentBytes += byteLen(first.text);
      first.text = CLEANED_META_CONTENT;
      return true;
    }
    return false;
  } catch { return false; }
}

/** image 블록 하나의 source.data를 1x1 PNG로 치환. (v4 계승 규칙을 함수로 분리) */
function cleanImageBlock(item: any, stats: CleaningStats): boolean {
  if (!item || typeof item !== "object" || item.type !== "image") return false;
  const source = item.source;
  if (!source || typeof source !== "object" || !("data" in source)) return false;
  let cleaned = false;
  if (source.data && source.data !== CLEANED_BASE64_IMAGE) {
    stats.base64ImageBytes += byteLen(source.data);
    source.data = CLEANED_BASE64_IMAGE;
    stats.base64ImageCount++;
    cleaned = true;
  }
  if (source.media_type !== "image/png") {
    source.media_type = "image/png"; // placeholder가 png라서 media_type도 맞춤 (v4 계승)
    cleaned = true;
  }
  return cleaned;
}

/** base64 이미지 치환. 이미지가 놓이는 자리는 두 가지다:
 *    ① 붙여넣은 이미지 → message.content[]에 image 블록이 바로 놓인다 (v4가 알던 형태)
 *    ② 도구가 반환한 이미지 → message.content[] → tool_result.content[] 안쪽에 놓인다
 *  ②는 최상위에서 보면 type이 "tool_result"라 v4 규칙이 껍데기를 못 뚫고 지나쳤다.
 *  실측(2026-07-31): 스크린샷 2장이 정리 후에도 남아 파일의 32%를 차지했고
 *  리포트에는 "Base64 images: 0 cleaned"로 찍혔다. 같은 이미지의 두 번째 사본은
 *  toolUseResult.file.base64에 있어 cleanReadResult가 함께 치운다. */
function cleanBase64Images(o: Row, stats: CleaningStats): boolean {
  try {
    const content = o?.message?.content;
    if (!Array.isArray(content)) return false;
    let cleaned = false;
    for (const item of content) {
      if (cleanImageBlock(item, stats)) cleaned = true;
      // tool_result 한 겹 안쪽 (중첩은 이 한 단계만 실측됨 — 더 깊은 재귀는 넣지 않는다)
      if (item?.type === "tool_result" && Array.isArray(item.content)) {
        for (const inner of item.content) if (cleanImageBlock(inner, stats)) cleaned = true;
      }
    }
    return cleaned;
  } catch { return false; }
}

function cleanToolUseResultString(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    // MCP 도구는 toolUseResult 자체가 문자열이다 (아래 객체 분기의 typeof 검사에서 탈락하던 자리).
    // 실측(f3aea91e): mcp__remote_tavily__tavily_extract 등 19건 30,184B가 그대로 남아 있었다.
    // 무엇을 요청했는지는 tool_use.input에 남으므로 색인은 잃지 않는다.
    if (typeof result === "string" && result.length > 200 && result !== CLEANED_TOOL_RESULT_STRING) {
      stats.toolResultStringBytes += byteLen(result);
      stats.toolResultStringCount++;
      o.toolUseResult = CLEANED_TOOL_RESULT_STRING;
      return true;
    }
    if (result && typeof result === "object" && typeof result.result === "string" && result.result.length > 200 && result.result !== CLEANED_TOOL_RESULT_STRING) {
      stats.toolResultStringBytes += byteLen(result.result);
      stats.toolResultStringCount++;
      result.result = CLEANED_TOOL_RESULT_STRING;
      return true;
    }
    return false;
  } catch { return false; }
}

function cleanTeammateMessage(o: Row, stats: CleaningStats): boolean {
  try {
    if (o?.type !== "user" || !o?.teamName) return false;
    const message = o.message;
    if (!message || typeof message !== "object") return false;
    const content = message.content;
    if (typeof content !== "string" || !content.includes("<teammate-message")) return false;
    const cleaned = content.replace(TEAMMATE_MESSAGE_PATTERN, `$1${CLEANED_TEAMMATE_MESSAGE}$2`);
    if (cleaned !== content) {
      stats.teammateMessageBytes += byteLen(content) - byteLen(cleaned);
      stats.teammateMessageCount++;
      message.content = cleaned;
      return true;
    }
    return false;
  } catch { return false; }
}

function cleanToolUseResultPrompt(o: Row, stats: CleaningStats): boolean {
  try {
    const result = o?.toolUseResult;
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const p = result.prompt;
    if (typeof p !== "string" || p.length <= 100 || p.includes("[context-cleaner:")) return false;
    stats.toolUseResultPromptBytes += byteLen(p);
    stats.toolUseResultPromptCount++;
    result.prompt = CLEANED_AGENT_PROMPT;
    return true;
  } catch { return false; }
}

function cleanToolUseInputPrompt(o: Row, stats: CleaningStats): boolean {
  try {
    const content = o?.message?.content;
    if (!Array.isArray(content)) return false;
    let cleaned = false;
    for (const item of content) {
      if (!item || typeof item !== "object" || item.type !== "tool_use") continue;
      const inp = item.input;
      if (!inp || typeof inp !== "object") continue;
      const p = inp.prompt;
      if (typeof p !== "string" || p.length <= 100 || p.includes("[context-cleaner:")) continue;
      stats.toolUseInputPromptBytes += byteLen(p);
      stats.toolUseInputPromptCount++;
      inp.prompt = CLEANED_AGENT_PROMPT;
      cleaned = true;
    }
    return cleaned;
  } catch { return false; }
}

/** Workflow 도구의 인라인 스크립트 전문(input.script, 최대 512KB) 치환.
 *  실행 결과는 완료 알림(task-notification)에 남고, 스크립트 파일은 세션 폴더에 보존되므로
 *  transcript에 전문을 다시 들고 갈 이유가 없다. 색인인 name·scriptPath는 손대지 않는다. */
function cleanWorkflowScript(o: Row, stats: CleaningStats): boolean {
  try {
    const content = o?.message?.content;
    if (!Array.isArray(content)) return false;
    let cleaned = false;
    for (const item of content) {
      if (!item || typeof item !== "object" || item.type !== "tool_use" || item.name !== "Workflow") continue;
      const inp = item.input;
      if (!inp || typeof inp !== "object") continue;
      const s = inp.script;
      if (typeof s !== "string" || s.length <= 100 || s.includes("[context-cleaner:")) continue;
      stats.workflowScriptBytes += byteLen(s);
      stats.workflowScriptCount++;
      inp.script = CLEANED_WORKFLOW_SCRIPT;
      cleaned = true;
    }
    return cleaned;
  } catch { return false; }
}

function cleanLocalCommandStdout(o: Row, stats: CleaningStats): boolean {
  try {
    if (o?.type !== "user") return false;
    const message = o.message;
    if (!message || typeof message !== "object") return false;
    const content = message.content;
    if (typeof content !== "string" || !content.includes("<local-command-stdout>") || content.length <= 200 || content.includes("[context-cleaner:")) return false;
    const cleaned = content.replace(LOCAL_COMMAND_STDOUT_PATTERN, `$1[context-cleaner: local_command_stdout]$2`);
    if (cleaned !== content) {
      stats.localCommandStdoutBytes += byteLen(content) - byteLen(cleaned);
      stats.localCommandStdoutCount++;
      message.content = cleaned;
      return true;
    }
    return false;
  } catch { return false; }
}

/** queue-operation 행의 content 축소 — 행·operation·timestamp는 보존 (2026-08-05 결정).
 *  실측(37d93cea): enqueue 27건 중 23건(85.2%)이 이후 정식 user 행과 중복.
 *  행 자체는 "삭제하지 않는다"(2026-07-31 결정)를 유지 — 타이밍 기록은 남고 본문만 준다. */
function cleanQueueOperation(o: Row, stats: CleaningStats): boolean {
  try {
    if (o?.type !== "queue-operation") return false;
    const c = o.content;
    if (typeof c !== "string" || c.length <= 200 || c.includes("[context-cleaner:")) return false;
    stats.queueOpBytes += byteLen(c) - byteLen(CLEANED_QUEUE_OP);
    stats.queueOpCount++;
    o.content = CLEANED_QUEUE_OP;
    return true;
  } catch { return false; }
}

/** task-notification user 행의 <result> 내부만 축소 — 껍데기(task-id·status·summary 등) 보존.
 *  실측(37d93cea): 21행 165,976B 중 result가 150,580B(90.7%). 결과 전문은 output-file에 남는다. */
function cleanTaskNotificationResult(o: Row, stats: CleaningStats): boolean {
  try {
    if (o?.type !== "user") return false;
    const message = o.message;
    if (!message || typeof message !== "object") return false;
    const content = message.content;
    if (typeof content !== "string" || !content.includes("<task-notification>") || content.includes(CLEANED_TASK_RESULT)) return false;
    const cleaned = content.replace(TASK_RESULT_PATTERN, `$1${CLEANED_TASK_RESULT}$2`);
    if (cleaned !== content) {
      stats.taskNotifyBytes += byteLen(content) - byteLen(cleaned);
      stats.taskNotifyCount++;
      message.content = cleaned;
      return true;
    }
    return false;
  } catch { return false; }
}

/** origin.body 축소 — 본문이 message.content에 이미 있는 순수 중복 저장분 (peer·task-notification 등).
 *  kind·from·senderTaskId 같은 메타데이터는 보존한다. */
function cleanOriginBody(o: Row, stats: CleaningStats): boolean {
  try {
    const origin = o?.origin;
    if (!origin || typeof origin !== "object") return false;
    const b = origin.body;
    if (typeof b !== "string" || b.length <= 200 || b.includes("[context-cleaner:")) return false;
    stats.originBodyBytes += byteLen(b) - byteLen(CLEANED_ORIGIN_BODY);
    stats.originBodyCount++;
    origin.body = CLEANED_ORIGIN_BODY;
    return true;
  } catch { return false; }
}

/** peer 메시지의 <agent-message> 내부 축소 — 여닫는 태그·from 속성은 보존 (teammate-message와 동일 방식) */
function cleanAgentMessage(o: Row, stats: CleaningStats): boolean {
  try {
    if (o?.type !== "user") return false;
    const message = o.message;
    if (!message || typeof message !== "object") return false;
    const content = message.content;
    if (typeof content !== "string" || !content.includes("<agent-message")) return false;
    const cleaned = content.replace(AGENT_MESSAGE_PATTERN, `$1${CLEANED_AGENT_MESSAGE}$2`);
    if (cleaned !== content) {
      stats.agentMessageBytes += byteLen(content) - byteLen(cleaned);
      stats.agentMessageCount++;
      message.content = cleaned;
      return true;
    }
    return false;
  } catch { return false; }
}

/** sessionId(camelCase)를 새 파일명으로 통일 — session_id(snake)는 건드리지 않는다(라운드2 결정) */
function updateSessionId(o: Row, newSessionId: string, stats: CleaningStats): boolean {
  if ("sessionId" in o && o.sessionId !== newSessionId) {
    o.sessionId = newSessionId;
    stats.sessionidCount++;
    return true;
  }
  return false;
}

/** v4 process_line 포팅: 한 행에 모든 값 치환을 적용 */
function processLine(o: Row, newSessionId: string, stats: CleaningStats, keepHookContent: boolean) {
  updateSessionId(o, newSessionId, stats);
  cleanThinkingBlocks(o, stats); // 삭제 안 된(혼합) 행 잔여용 — thinking-only 행은 여기 오기 전에 삭제 마킹됨
  cleanAttachment(o, stats, keepHookContent);
  cleanReadResult(o, stats);
  cleanWriteInput(o, stats);
  cleanWriteResult(o, stats);
  cleanEditInput(o, stats);
  cleanEditResult(o, stats);
  // ★ [2026-07-28 결정] bash command는 살려둔다 — 아래 한 줄 주석을 풀면 즉시 예전 동작으로 복귀.
  //   이유·실측은 파일 헤더 [결정: bash command 보존] 참조. 출력(stdout/stderr)은 계속 지운다.
  // cleanBashInput(o, stats);
  cleanBashResult(o, stats);
  cleanFilenamesResult(o, stats);
  cleanExitPlanModeInput(o, stats);
  cleanToolResultContent(o, stats);
  cleanListToolUseResult(o, stats);
  cleanTaskOutput(o, stats);
  cleanTaskContentText(o, stats);
  cleanBashProgress(o, stats);
  cleanAgentProgress(o, stats);
  // ★ [2026-07-28] 경로 보존 — 아래 한 줄 주석을 풀면 예전처럼 basename만 남긴다.
  //   이 함수는 file_path 자르기'만' 하므로 호출만 끄면 된다. 헤더 [결정: 파일 경로 보존] 참조.
  // cleanInputFilepath(o, stats);
  cleanBashTags(o, stats);
  cleanUserMarked(o, stats);
  cleanMetaContent(o, stats);
  cleanBase64Images(o, stats);
  cleanToolUseResultString(o, stats);
  cleanTeammateMessage(o, stats);
  cleanToolUseResultPrompt(o, stats);
  cleanLocalCommandStdout(o, stats);
  cleanToolUseInputPrompt(o, stats);
  cleanWorkflowScript(o, stats);
  cleanQueueOperation(o, stats);
  cleanTaskNotificationResult(o, stats);
  cleanOriginBody(o, stats);
  cleanAgentMessage(o, stats);
}

// ============================================================================
// 행 삭제 판정 (원본(pristine) 필드 기준 — 값 치환 이전에 판정해야 마커가 안 깨진다.
// 예: 합성 user 행은 isMeta라 cleanMetaContent가 텍스트를 placeholder로 바꿔버리면
//     "Continue from where you left off." 정확 일치 판정이 불가능해진다.)
// ============================================================================
type HookClass = { form: "progress" | "system" | "attachment"; event: string | null };

function classifyHook(o: Row): HookClass | null {
  if (o?.type === "progress" && o?.data?.type === "hook_progress") {
    // 이벤트 식별 필드는 버전에 따라 없을 수 있다(v2.1.201에서 미확정).
    // data.hookEvent → data.hookName("SessionStart:startup" 형태) 순으로 탐색.
    const ev =
      typeof o.data?.hookEvent === "string"
        ? o.data.hookEvent
        : typeof o.data?.hookName === "string"
          ? String(o.data.hookName).split(":")[0]
          : null;
    return { form: "progress", event: ev };
  }
  if (o?.type === "system" && o?.subtype === "stop_hook_summary") return { form: "system", event: "Stop" };
  if (o?.type === "attachment" && typeof o?.attachment?.type === "string" && o.attachment.type.startsWith("hook_")) {
    const ev = typeof o.attachment?.hookEvent === "string" ? o.attachment.hookEvent : null;
    return { form: "attachment", event: ev };
  }
  return null;
}

function shouldDeleteHook(mode: HooksMode, cls: HookClass): boolean {
  if (mode.mode === "delete") return true;
  if (mode.mode === "keep") return false;
  // keep-events: "적은 것만 살아남는다" (화이트리스트). 이벤트를 증명 못 하는 행(event=null)은 삭제된다.
  return !(cls.event && mode.events.has(cls.event.toLowerCase()));
}

/** thinking-only 행: 모든 content 블록이 thinking류. (redacted_thinking도 동일 취급 —
 *  암호화 블록이라 내용 가치 없이 바이트만 차지하므로 함께 지우는 게 자연스럽다) */
function isThinkingOnlyRow(o: Row): boolean {
  if (o?.type !== "assistant") return false;
  const content = o?.message?.content;
  return Array.isArray(content) && content.length > 0 &&
    content.every((b: any) => b?.type === "thinking" || b?.type === "redacted_thinking");
}

/** 혼합 행(thinking + 다른 블록) 감지 — 삭제하지 않고 통계 보고만 (실측된 적 없음) */
function isMixedThinkingRow(o: Row): boolean {
  if (o?.type !== "assistant") return false;
  const content = o?.message?.content;
  if (!Array.isArray(content)) return false;
  const hasThinking = content.some((b: any) => b?.type === "thinking" || b?.type === "redacted_thinking");
  return hasThinking && !isThinkingOnlyRow(o);
}

/** 합성 행 판별 — 헤더의 [지식: 합성 행] 참조. 마커는 실측 기반의 명시 필드다. */
function isSyntheticRow(o: Row): boolean {
  if (o?.type === "assistant" && o?.message?.model === "<synthetic>") return true;
  if (
    o?.type === "user" &&
    o?.isMeta === true &&
    Array.isArray(o?.message?.content) &&
    o.message.content.some((b: any) => b?.type === "text" && b?.text === "Continue from where you left off.")
  )
    return true;
  return false;
}

/* [지식: queue-operation 행 — 조사했으나 "삭제하지 않는다"로 결정됨 (2026-07-31)]
 *   비동기 알림이나 사용자 입력이 응답 생성 중에 도착해 큐에 쌓였다(enqueue) 꺼내진
 *   (dequeue/remove) 타이밍 기록. Workflow·Monitor·백그라운드 Bash를 쓰면 생긴다.
 *
 *   실측 (Workflow 2회 쓴 세션 440행): 20행 9,285바이트.
 *     - uuid·parentUuid가 없어 체인에 참여하지 않는다 → 지워도 재매핑할 것이 없다.
 *     - dequeue 7건은 content 필드조차 없다 (138B).
 *     - content를 가진 13건은 전부 다른 행과 중복: 알림 5건은 같은 본문이
 *       origin.kind="task-notification" user 행에, 사용자 발화 2건은
 *       origin.kind="human" user 행에 존재(대조 확인). enqueue·remove는 쌍으로 중복.
 *
 *   즉 "지워도 안전하고 내용도 중복"이지만, 입력이 언제 도달해 언제 소비됐는지의
 *   타이밍은 이 행에만 남는다. 그 기록을 남기는 편을 택했다 → 삭제 규칙을 넣지 않는다.
 *   (다시 논의할 때 이 실측을 재조사하지 말 것. 결정만 바꾸면 된다.)
 *
 *   [2026-08-05 추가 결정] 행 삭제는 여전히 안 하지만 content"만" 축소한다(cleanQueueOperation).
 *   실측(37d93cea, 360행 636KB): queue-operation 53행 189,971B가 파일의 29.9%.
 *   enqueue 27건 중 23건(85.2%)이 이후 정식 user 행과 본문 중복 → 타이밍 기록(행·
 *   operation·timestamp)은 보존하고 중복 본문만 마커로 치환. 위 결정과 모순 아님.
 */

// ============================================================================
// 무결성 분석 (fix-session의 analyze 차용·개선판)
// ============================================================================
export type Analysis = {
  parseErrors: number;
  totalRows: number;
  orphanParents: number;          // 파일 안 어떤 uuid로도 해소 안 되는 parentUuid (null 제외)
  unresolvedLeafUuid: number;     // last-prompt.leafUuid 미해소
  unresolvedSnapshotMessageId: number;
  unresolvedSourceTool: number;
  cycles: number;                 // parentUuid 사슬 순환 (오염 파일 감지)
  tipCount: number;               // user/assistant leaf 수 (평행세계 갈래 수 가늠)
  chainLengthFromNewestTip: number; // 최신 tip에서 root까지 길이 (fix-session 진단 차용)
  // ── [PLAN §5] uuid 체인 판정 3종의 원천 데이터 ──
  reachedRootFromNewestTip: boolean; // 최신 tip walk가 root에 도달했나 (중간 uuid 미해소로 멈추면 false)
  conversationRootCount: number;     // uuid 보유 + 대화타입(user/assistant/system/summary) + parentUuid null/없음 인 행 수
  nonBoundaryRootCount: number;      // 위에서 compact_boundary를 뺀 수 (참고용 — 판정에는 쓰지 않는다)
  conversationRootUuids: string[];   // 그 root들의 uuid — 입출력 대조 판정(§5.2)의 원천
  anchorLeafUuid: string | null;     // 파일상 마지막 last-prompt.leafUuid (CC resume의 실제 출발점 — F1)
  anchorResolvable: boolean;         // 앵커 leafUuid가 uuid 보유 행으로 해소되나
  reachedRootFromAnchor: boolean;    // 앵커에서 walk가 root에 도달하나
};

export function analyzeLines(lines: string[]): Analysis {
  const objs: Row[] = [];
  let parseErrors = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    try { objs.push(JSON.parse(l)); } catch { parseErrors++; }
  }
  const uuids = new Set(objs.filter((o) => typeof o.uuid === "string").map((o) => o.uuid as string));
  const byUuid = new Map(objs.filter((o) => typeof o.uuid === "string").map((o) => [o.uuid as string, o]));
  let orphanParents = 0, unresolvedLeafUuid = 0, unresolvedSnapshotMessageId = 0, unresolvedSourceTool = 0;
  const parents = new Set<string>();
  for (const o of objs) {
    if (typeof o.parentUuid === "string") {
      parents.add(o.parentUuid);
      if (!uuids.has(o.parentUuid)) orphanParents++;
    }
    if (o.type === "last-prompt" && typeof o.leafUuid === "string" && !uuids.has(o.leafUuid)) unresolvedLeafUuid++;
    if (o.type === "file-history-snapshot" && typeof o.messageId === "string" && !uuids.has(o.messageId)) unresolvedSnapshotMessageId++;
    if (typeof o.sourceToolAssistantUUID === "string" && !uuids.has(o.sourceToolAssistantUUID)) unresolvedSourceTool++;
  }
  // 사이클 검출 (white/gray/black 3색 — fix-session의 seen 가드 확장)
  const state = new Map<string, 0 | 1 | 2>();
  let cycles = 0;
  for (const start of uuids) {
    if (state.get(start)) continue;
    const stack: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && uuids.has(cur) && !state.get(cur)) {
      state.set(cur, 1);
      stack.push(cur);
      const p = byUuid.get(cur)?.parentUuid;
      cur = typeof p === "string" ? p : undefined;
      if (cur !== undefined && state.get(cur) === 1) { cycles++; break; }
    }
    for (const s of stack) state.set(s, 2);
  }
  // tip(leaf) 계산 + 최신 tip에서 chain-walk
  const tips = objs.filter(
    (o) => typeof o.uuid === "string" && (o.type === "user" || o.type === "assistant") && !parents.has(o.uuid as string),
  );
  let chainLengthFromNewestTip = 0;
  let reachedRootFromNewestTip = false; // [PLAN §5.1] walk 종착이 root였나
  if (tips.length > 0) {
    const newest = tips.reduce((a, b) => (String(a.timestamp ?? "") >= String(b.timestamp ?? "") ? a : b));
    const seen = new Set<string>();
    let cur: Row | undefined = newest;
    while (cur && typeof cur.uuid === "string" && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      chainLengthFromNewestTip++;
      const p = cur.parentUuid;
      if (p === null || p === undefined) { reachedRootFromNewestTip = true; break; } // 정상 root 도달
      const next = byUuid.get(p);
      if (!next) break; // parentUuid 미해소 → 끊김 (reachedRootFromNewestTip false 유지)
      cur = next;
    }
  }

  // [PLAN §5.2] 대화 root 수: uuid 보유 + 대화타입(user/assistant/system/summary) + parentUuid null/없음
  // 비대화 메타행(uuid 없음)은 애초 제외. summary도 대화행이라 포함(F_summary_주의).
  const CONVERSATION_TYPES = new Set(["user", "assistant", "system", "summary"]);
  let conversationRootCount = 0;
  let nonBoundaryRootCount = 0;
  const conversationRootUuids: string[] = [];
  for (const o of objs) {
    if (typeof o.uuid === "string" && CONVERSATION_TYPES.has(o.type as string) && (o.parentUuid === null || o.parentUuid === undefined)) {
      conversationRootCount++;
      if (o.type === "system" && o.subtype === "compact_boundary") continue;
      nonBoundaryRootCount++;
      conversationRootUuids.push(o.uuid as string);
    }
  }

  // [PLAN §5.3] 앵커 walk: 파일상 마지막 last-prompt.leafUuid → root 도달 여부
  // (CC의 실제 resume은 파일상 마지막 last-prompt.leafUuid를 출발점으로 쓴다 — 최신 tip과 다를 수 있음)
  const lastPrompts = objs.filter((o) => o.type === "last-prompt");
  let anchorLeafUuid: string | null = null;
  let anchorResolvable = false;
  let reachedRootFromAnchor = false;
  if (lastPrompts.length > 0) {
    const lastLp = lastPrompts[lastPrompts.length - 1]; // 파일상 마지막 (objs 순서 = 파일 순서)
    if (typeof lastLp.leafUuid === "string") {
      anchorLeafUuid = lastLp.leafUuid;
      const start = byUuid.get(anchorLeafUuid);
      anchorResolvable = !!start;
      if (start) {
        const seen = new Set<string>();
        let cur: Row | undefined = start;
        while (cur && typeof cur.uuid === "string" && !seen.has(cur.uuid)) {
          seen.add(cur.uuid);
          const p = cur.parentUuid;
          if (p === null || p === undefined) { reachedRootFromAnchor = true; break; }
          const next = byUuid.get(p);
          if (!next) break;
          cur = next;
        }
      }
    }
  }

  return {
    parseErrors, totalRows: objs.length, orphanParents, unresolvedLeafUuid,
    unresolvedSnapshotMessageId, unresolvedSourceTool, cycles,
    tipCount: tips.length, chainLengthFromNewestTip,
    reachedRootFromNewestTip, conversationRootCount, nonBoundaryRootCount, conversationRootUuids,
    anchorLeafUuid, anchorResolvable, reachedRootFromAnchor,
  };
}

export type VerifyReport = {
  ok: boolean;
  summary: { input: Analysis; output: Analysis };
  problems: string[];
};

/** 합격 기준: "입력보다 나빠진 것이 없다" + 우리가 만든 참조는 전부 해소된다.
 *  (원본에 이미 있던 미해소 참조·깨진 줄은 우리가 만든 문제가 아니므로 기준선으로만 취급) */
export function verifyAgainstBaseline(inputLines: string[], outputLines: string[]): VerifyReport {
  const input = analyzeLines(inputLines);
  const output = analyzeLines(outputLines);
  const problems: string[] = [];
  if (output.orphanParents > 0) problems.push(`고아 parentUuid ${output.orphanParents}개 (0이어야 함 — 재매핑 실패)`);
  if (output.cycles > 0) problems.push(`parentUuid 사이클 ${output.cycles}개`);
  if (output.unresolvedLeafUuid > input.unresolvedLeafUuid) problems.push(`last-prompt.leafUuid 미해소 증가 (${input.unresolvedLeafUuid}→${output.unresolvedLeafUuid})`);
  if (output.unresolvedSnapshotMessageId > input.unresolvedSnapshotMessageId) problems.push(`snapshot.messageId 미해소 증가 (${input.unresolvedSnapshotMessageId}→${output.unresolvedSnapshotMessageId})`);
  if (output.unresolvedSourceTool > input.unresolvedSourceTool) problems.push(`sourceToolAssistantUUID 미해소 증가 (${input.unresolvedSourceTool}→${output.unresolvedSourceTool})`);
  if (output.parseErrors > input.parseErrors) problems.push(`깨진 JSON 줄 증가 (${input.parseErrors}→${output.parseErrors})`);
  // ── [PLAN §5] uuid 체인 판정 3종 (절대 기준 — 출력만 본다) ──
  // §5.1 최신 tip walk가 root에 미도달 → 체인 끊김.
  //   주의: 클리너가 orphan parentUuid를 root화(6단계)하므로 정상 클리닝 출력에서는
  //   reachedRootFromNewestTip가 항상 true다. 이 판정은 "재매핑 실패로 orphan이 잔존"하는
  //   드문 클리너 자체 버그를 잡는 안전망. 실제 재매핑 실패 검출은 §5.2(입출력 uuid 대조)가 담당.
  if (output.tipCount > 0 && !output.reachedRootFromNewestTip)
    problems.push("최신 tip에서 root 미도달 — 체인 끊김 (재매핑 실패 잔존 가능)");
  // §5.2 출력 root의 "개수"가 아니라 "생긴 원인"을 입출력 uuid로 대조한다.
  //   정상 root:
  //   ① compact_boundary — CC가 의도적으로 parentUuid=null을 기록한다.
  //   ② 입력에서도 root — 클리너가 만든 변화가 아니다.
  //   ③ 입력부터 부모가 미해소 — 원본의 기존 끊김이다(6단계가 키를 제거해 명시적 root로 정리).
  //   ④ 입력의 부모가 출력에서 삭제됨 — 훅/thinking/로컬명령 삭제 후 resolveSurvivor가
  //      살아있는 조상을 못 찾은 정상 결과다. 400 에러 후 같은 훅 부모를 공유한 재발화처럼
  //      형제 여러 개가 동시에 root가 되어도 원본에 이미 있던 갈래가 드러난 것일 뿐이다.
  //   오류는 입력의 부모가 출력에도 살아 있는데 자식의 parentUuid만 사라진 경우다.
  //   실측(41개): 출력 root는 boundary 26, 삭제된 부모 25, 입력 root 17, 원본 고아 5,
  //   살아있는 부모를 잃은 root 0. root 수 기준은 정상 갈래를 오탐하므로 폐기했다.
  const inputRows: Row[] = [];
  const outputRows: Row[] = [];
  for (const line of inputLines) {
    if (!line.trim()) continue;
    try { inputRows.push(JSON.parse(line)); } catch { /* parseErrors가 별도 판정 */ }
  }
  for (const line of outputLines) {
    if (!line.trim()) continue;
    try { outputRows.push(JSON.parse(line)); } catch { /* parseErrors가 별도 판정 */ }
  }
  const inputByUuid = new Map(
    inputRows.filter((o) => typeof o.uuid === "string").map((o) => [o.uuid as string, o]),
  );
  const outputUuids = new Set(
    outputRows.filter((o) => typeof o.uuid === "string").map((o) => o.uuid as string),
  );
  const remapFailures: string[] = [];
  for (const uuid of output.conversationRootUuids) {
    const before = inputByUuid.get(uuid);
    if (!before) {
      remapFailures.push(`${uuid}(입력에 없던 대화 root)`);
      continue;
    }
    if (before.parentUuid === null || before.parentUuid === undefined) continue;
    // 입력의 parentUuid 사슬을 따라 가장 가까운 출력 생존 조상을 찾는다.
    // 바로 부모가 삭제됐어도 그 위 조상이 살아 있으면 root가 아니라 그 조상에 재연결되어야 한다.
    const seenAncestors = new Set<string>();
    let ancestorUuid: string | null = before.parentUuid as string;
    while (ancestorUuid !== null && !seenAncestors.has(ancestorUuid)) {
      seenAncestors.add(ancestorUuid);
      if (outputUuids.has(ancestorUuid)) {
        remapFailures.push(`${uuid}(살아있는 조상 ${ancestorUuid} 유실)`);
        break;
      }
      const ancestor = inputByUuid.get(ancestorUuid);
      if (!ancestor || ancestor.parentUuid === null || ancestor.parentUuid === undefined) break;
      ancestorUuid = ancestor.parentUuid as string;
    }
  }
  if (remapFailures.length > 0)
    problems.push(`parentUuid 재매핑 실패 ${remapFailures.length}개: ${remapFailures.join(", ")}`);
  // §5.3 resume 앵커(마지막 last-prompt.leafUuid) — CC가 실제로 열 갈래의 건강도
  if (output.anchorLeafUuid !== null && !output.anchorResolvable)
    problems.push("마지막 last-prompt.leafUuid가 미해소 uuid를 가리킴 — resume 앵커 끊김");
  else if (output.anchorLeafUuid !== null && output.anchorResolvable && !output.reachedRootFromAnchor)
    problems.push("resume 앵커에서 root 미도달 — 실제 열릴 갈래가 끊김");
  return { ok: problems.length === 0, summary: { input, output }, problems };
}

// ============================================================================
// uuid → transcript 경로 해석 & resume 명령 생성
// ============================================================================
/**
 * CLI 인자가 파일 경로가 아니라 세션 uuid(또는 그 접두)일 때
 * ~/.claude/projects/<프로젝트폴더>/<uuid>.jsonl 을 "파일명 매칭"으로 찾는다.
 *  - 내용을 읽지 않는 파일명 글롭이라 수천 파일 규모에서도 수십 ms 이내.
 *  - glm(CLAUDE_CONFIG_DIR=~/claude__2_GLM)의 projects도 같은 폴더로 향하는 symlink라
 *    (환경 실측 2026-07-07) 이 한 곳만 보면 claude·glm 세션 전부 커버된다.
 *  - "정확히 <arg>.jsonl"이 있으면 접두 매칭보다 우선한다 — effaced 사본
 *    (…00effacedNNN.jsonl)이 원본과 같은 접두를 공유하므로, 전체 uuid를 입력했는데
 *    접두 모호로 죽는 것을 막기 위함.
 *  - 접두 매칭이 2개 이상이면 후보를 나열하고 에러 (모호를 조용히 고르지 않는다).
 */
export function resolveTranscriptArg(
  arg: string,
  projectsRoot?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (existsSync(arg) && arg.endsWith(".jsonl")) return { ok: true, path: path.resolve(arg) };
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{3,}$/.test(arg)) {
    return { ok: false, error: `File not found: ${arg} (경로도 아니고 uuid 형태도 아님)` };
  }
  const root = projectsRoot ?? path.join(os.homedir(), ".claude", "projects");
  if (!existsSync(root)) return { ok: false, error: `projects 폴더 없음: ${root}` };
  const exact: string[] = [];
  const prefix: string[] = [];
  for (const name of readdirSync(root)) {
    const dirPath = path.join(root, name);
    let entries: string[];
    try {
      entries = readdirSync(dirPath); // 파일(디렉토리 아님)이면 throw → skip
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      if (f === `${arg}.jsonl`) exact.push(path.join(dirPath, f));
      else if (f.startsWith(arg)) prefix.push(path.join(dirPath, f));
    }
  }
  if (exact.length === 1) return { ok: true, path: exact[0] };
  const cands = exact.length > 1 ? exact : prefix;
  if (cands.length === 0) return { ok: false, error: `uuid 매칭 없음: ${arg} (탐색: ${root})` };
  if (cands.length > 1) {
    return {
      ok: false,
      error: `uuid 매칭 모호 (${cands.length}개) — 더 길게 입력하십시오:\n` + cands.map((c) => `  - ${c}`).join("\n"),
    };
  }
  return { ok: true, path: cands[0] };
}

/**
 * resume 안내 문구. cd 대상은 transcript 경로가 아니라 "세션의 cwd"다 —
 * claude --resume은 현재 디렉토리를 인코딩해 projects/<폴더>를 찾으므로,
 * 원래 작업 디렉토리에서 실행해야 세션이 발견된다. 그 cwd는 행에 기록돼 있다.
 */
export function buildResumeCommand(sessionCwd: string | null, newSessionId: string): string {
  const base = `claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume ${newSessionId}`;
  if (!sessionCwd) return base;
  // ${HOME} 토큰이 셸에서 확장돼야 하므로 홑따옴표 금지 — 인용이 필요하면 겹따옴표.
  // (겹따옴표 안에서 $는 살아서 확장되고, "·\·`만 이스케이프하면 된다)
  const safe = /^[A-Za-z0-9_\/.~${}-]+$/.test(sessionCwd)
    ? sessionCwd
    : `"${sessionCwd.replace(/(["\\`])/g, "\\$1")}"`;
  return `cd ${safe} && ${base}`;
}

/** 파일 순서상 마지막 행의 cwd — 세션이 실제로 돌던 작업 디렉토리 */
export function lastCwd(rows: ReadonlyArray<{ o: Record<string, any> | null }>): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = rows[i].o?.cwd;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/**
 * 행에 기록된 cwd의 홈 접두를 리터럴 "${HOME}" 토큰으로 치환 — 문구 자체가 이식형이 된다.
 * 실행하는 터미널의 셸이 그 자리에서 자기 홈으로 확장하므로, 어느 머신·어느 사용자명에서
 * 붙여넣어도 통한다 (기록된 cwd는 기록 당시 머신의 절대경로이므로).
 *  - 현재 홈으로 시작하면 그대로 토큰화.
 *  - 다른 계정의 홈 경로이면 "현재 홈 기준으로 실존할 때만" 토큰화 —
 *    진짜 다른 계정의 경로를 엉뚱한 곳으로 틀어버리는 오치환 방지.
 *    실존 안 하면 원문 유지(cd 실패가 눈에 보이도록).
 *  - 주의: ${HOME}은 홑따옴표 안에서 확장되지 않는다 — 인용은 buildResumeCommand가
 *    겹따옴표로 처리한다.
 */
export function normalizeHomePrefix(cwd: string | null, home: string = os.homedir()): string | null {
  if (!cwd) return cwd;
  if (cwd === home || cwd.startsWith(home + "/")) return "${HOME}" + cwd.slice(home.length);
  const m = cwd.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (!m) return cwd;
  const rest = m[1] ?? "";
  return existsSync(home + rest) ? "${HOME}" + rest : cwd;
}

// ============================================================================
// 본체
// ============================================================================
export type CleanResult = {
  ok: boolean;
  error?: string;
  outputPath?: string;
  newSessionId?: string;
  mode?: "inplace" | "fork"; // [D4] 사용 모드
  stats?: CleaningStats;
  verify?: VerifyReport;
  resumeCommand?: string;
};

export async function cleanTranscript(
  sourcePath: string,
  opts?: { hooks?: HooksMode; report?: boolean; mode?: "inplace" | "fork" },
): Promise<CleanResult> {
  const hooks = opts?.hooks ?? { mode: "delete" as const };
  const cleanMode = opts?.mode ?? "inplace"; // [PLAN §2/D4] inplace=원본 덮어쓰기(기본), fork=사본(기존 동작)
  if (!existsSync(sourcePath)) return { ok: false, error: `File not found: ${sourcePath}` };

  // [PLAN D4] inplace: 원본 경로에 쓰고 파일명 uuid 그대로(sessionId 치환 = 실질 무치환, R2).
  //            fork: 기존대로 00effacedNNN 사본 + 새 uuid(R5 회귀 0).
  const outputPath = cleanMode === "inplace" ? sourcePath : nextFreeOutputPath(sourcePath);
  const newSessionId = sessionIdFromPath(outputPath);
  const stats = new CleaningStats();
  const raw = readFileSync(sourcePath, "utf8");
  const originalSize = Buffer.byteLength(raw, "utf8");
  const inputLines = raw.split("\n").filter((l) => l.trim());

  // 0) 파싱 + 상위 계약 검사 (위반 행은 원문 그대로 통과 — 보수적)
  type Parsed = { raw: string; o: Row | null };
  const rows: Parsed[] = inputLines.map((line) => {
    try {
      const o = JSON.parse(line) as Row;
      if (!RowCoreSchema.safeParse(o).success) {
        stats.contractMissRows++;
        return { raw: line, o: null };
      }
      return { raw: line, o };
    } catch {
      return { raw: line, o: null }; // 깨진 줄은 원문 보존 (v4 계승)
    }
  });

  // 1) 삭제 판정 — pristine 필드 기준 (값 치환 전에!)
  const deleteReason = new Map<number, string>(); // index → 사유
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i].o;
    if (!o) continue;
    if (isThinkingOnlyRow(o)) { deleteReason.set(i, "thinking"); continue; }
    if (isMixedThinkingRow(o)) stats.mixedThinkingRows++; // 삭제 안 함 — 그때 처리 (헤더 주석 참조)
    if (isSyntheticRow(o)) { deleteReason.set(i, "synthetic"); continue; }
    const hookCls = classifyHook(o);
    if (hookCls && shouldDeleteHook(hooks, hookCls)) {
      deleteReason.set(i, `hook:${hookCls.form}/${hookCls.event ?? "?"}`);
    }
  }
  const keepHookContent = hooks.mode !== "delete"; // 살아남는 훅은 내용도 원문 보존

  // 2) 값 치환 (삭제될 행은 건너뜀 — 어차피 사라질 바이트)
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i].o;
    if (!o || deleteReason.has(i)) continue;
    processLine(o, newSessionId, stats, keepHookContent);
  }

  // 2.5) 로컬 커맨드 출력 자식 행 치환 (v4 1.5단계 포팅 — <bash-input> 행의 자식 = 출력 행)
  const bashInputUuids = new Set<string>();
  for (const { o } of rows) {
    if (o?.type === "user") {
      const c = o?.message?.content;
      if (typeof c === "string" && c.includes("<bash-input>") && typeof o.uuid === "string") bashInputUuids.add(o.uuid);
    }
  }
  for (const { o } of rows) {
    if (o?.type === "user" && typeof o.parentUuid === "string" && bashInputUuids.has(o.parentUuid)) {
      const c = o?.message?.content;
      if (typeof c === "string" && c.length > 100 && c !== CLEANED_LOCAL_CMD_OUTPUT) {
        stats.localCmdOutputBytes += byteLen(c);
        stats.localCmdOutputCount++;
        o.message.content = CLEANED_LOCAL_CMD_OUTPUT;
      }
    }
  }

  // 3) v4 계승 삭제 판정 (로컬 커맨드 관련 — 값 치환 "이후"의 placeholder에 의존하므로 여기서)
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i].o;
    if (!o || deleteReason.has(i)) continue;
    if (o.type === "user") {
      const c = o?.message?.content;
      if (typeof c === "string") {
        if (c.includes("<local-command-caveat>") && !c.includes("<bash-input>")) deleteReason.set(i, "local-cmd");
        else if (c.trim().startsWith("<bash-input>") && c.trim().endsWith("</bash-input>")) deleteReason.set(i, "local-cmd");
        else if (c === CLEANED_LOCAL_CMD_OUTPUT) deleteReason.set(i, "local-cmd");
        else if (c === CLEANED_BASH_TAGS) deleteReason.set(i, "local-cmd");
      }
    }
  }

  // 4) 삭제 확정 + 조상 사슬 기록 ([핵심 원칙 3])
  const deletedParent = new Map<string, string | null>(); // 삭제된 uuid → 그 행의 parentUuid
  const kept: Parsed[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const reason = r.o ? deleteReason.get(i) : undefined;
    if (r.o && reason !== undefined) {
      if (typeof r.o.uuid === "string")
        deletedParent.set(r.o.uuid, typeof r.o.parentUuid === "string" ? r.o.parentUuid : null);
      const bytes = byteLen(r.raw);
      if (reason === "thinking") { stats.thinkingRowsDeleted++; stats.thinkingRowsBytes += bytes; }
      else if (reason === "synthetic") { stats.syntheticRowsDeleted++; stats.syntheticRowsBytes += bytes; }
      else if (reason.startsWith("hook:")) {
        stats.hookRowsDeleted++; stats.hookRowsBytes += bytes;
        const k = reason.slice(5);
        stats.hookRowsByKey.set(k, (stats.hookRowsByKey.get(k) ?? 0) + 1);
      } else stats.localCmdRowsDeleted++;
      continue;
    }
    kept.push(r);
  }
  const keptUuids = new Set(kept.filter((r) => typeof r.o?.uuid === "string").map((r) => r.o!.uuid as string));

  /** 삭제된 uuid의 "가장 가까운 살아남은 조상"을 찾는다. 없으면 null(root). 사이클 가드 포함. */
  const resolveSurvivor = (uuid: string): string | null => {
    const seen = new Set<string>();
    let cur: string | null = uuid;
    while (cur !== null && deletedParent.has(cur)) {
      if (seen.has(cur)) return null; // 사이클 — 오염 파일 방어 (fix-session 아이디어)
      seen.add(cur);
      cur = deletedParent.get(cur) ?? null;
    }
    return cur !== null && keptUuids.has(cur) ? cur : null;
  };

  // 5) 참조 재매핑 ([핵심 원칙 2]: parentUuid / leafUuid / sourceToolAssistantUUID / snapshot)
  const finalRows: Parsed[] = [];
  for (const r of kept) {
    const o = r.o;
    if (!o) { finalRows.push(r); continue; }
    // ① parentUuid
    if (typeof o.parentUuid === "string" && deletedParent.has(o.parentUuid)) {
      o.parentUuid = resolveSurvivor(o.parentUuid); // 조상 전멸 시 null = 대화 시작점 (올바른 의미)
    }
    // ② last-prompt.leafUuid — resume 앵커 사수
    if (o.type === "last-prompt" && typeof o.leafUuid === "string" && deletedParent.has(o.leafUuid)) {
      const s = resolveSurvivor(o.leafUuid);
      if (s) { o.leafUuid = s; stats.leafUuidRemapped++; }
      else { delete o.leafUuid; stats.leafUuidDropped++; } // leafUuid는 스키마상 optional — 키 제거 허용
    }
    // ④ sourceToolAssistantUUID
    if (typeof o.sourceToolAssistantUUID === "string" && deletedParent.has(o.sourceToolAssistantUUID)) {
      const s = resolveSurvivor(o.sourceToolAssistantUUID);
      if (s) { o.sourceToolAssistantUUID = s; stats.sourceToolRemapped++; }
      else { delete o.sourceToolAssistantUUID; stats.sourceToolDropped++; }
    }
    // ③ file-history-snapshot: 대상 메시지가 삭제됐으면 스냅샷 행도 함께 제거
    //    (snapshot 행은 uuid가 없어 체인에 영향 없음 — 실측 구조)
    if (o.type === "file-history-snapshot" && typeof o.messageId === "string" && deletedParent.has(o.messageId)) {
      stats.snapshotRowsDropped++;
      continue;
    }
    finalRows.push(r);
  }

  // 6) 원본부터 끊겨 있던 parentUuid → 키 제거(root화) (v4 2.5단계 계승 — resume 표시 정상화)
  const finalUuids = new Set(finalRows.filter((r) => typeof r.o?.uuid === "string").map((r) => r.o!.uuid as string));
  for (const r of finalRows) {
    const o = r.o;
    if (o && typeof o.parentUuid === "string" && !finalUuids.has(o.parentUuid)) {
      delete o.parentUuid;
      stats.preexistingDanglingRooted++;
    }
  }

  // 7) 직렬화 (깨진 줄은 원문 그대로)
  const outputLines = finalRows.map((r) => (r.o ? JSON.stringify(r.o) : r.raw));
  const outputContent = outputLines.join("\n") + "\n";

  // 8) 재검증 (analyze → fix → re-analyze 패턴) — 쓰기 "전"에 검증한다 (PLAN D5: rename 전 검증)
  const verify = verifyAgainstBaseline(inputLines, outputLines);
  const resumeCommand = buildResumeCommand(normalizeHomePrefix(lastCwd(rows)), newSessionId);

  // 9) [PLAN D5] 쓰기
  //   inplace: 원자적 쓰기 — 검증 통과 시에만 임시파일 → rename (R1: 원본 보호는 원자성으로).
  //            검증 실패면 임시파일도 안 쓰고 rename 안 함 → 원본 무손상, ok=false.
  //   fork: 기존 동작(사본 직접 쓰기). 검증 실패해도 사본은 만들고 ok=true — T9~T11 회귀 유지(R5).
  if (cleanMode === "inplace") {
    if (!verify.ok) {
      return { ok: false, error: `무결성 검사 실패 — 원본 유지: ${verify.problems.join("; ")}`, mode: cleanMode, stats, verify, resumeCommand };
    }
    const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(tmpPath, outputContent);
      renameSync(tmpPath, outputPath); // 원본 위치로 원자적 교체 (쓰다 죽으면 임시파일만 남고 원본 무손상)
    } catch (e) {
      let cleanupError = "";
      if (existsSync(tmpPath)) {
        try { unlinkSync(tmpPath); }
        catch (u) { cleanupError = `; 임시파일 삭제 실패: ${u instanceof Error ? u.message : String(u)}`; }
      }
      return {
        ok: false,
        error: `원자적 쓰기 실패 — 원본 유지: ${e instanceof Error ? e.message : String(e)}${cleanupError}`,
        mode: cleanMode,
        stats,
        verify,
        resumeCommand,
      };
    }
  } else {
    writeFileSync(outputPath, outputContent);
  }
  const newSize = Buffer.byteLength(readFileSync(outputPath, "utf8"), "utf8");

  if (opts?.report) {
    console.log(`\n🔄 Mode: ${cleanMode === "inplace" ? "in-place — 원본을 정리본으로 덮어씀 (위험하면 --fork)" : "fork — 00effaced 사본 생성"}`);
    stats.print(sourcePath, outputPath, originalSize, newSize, resumeCommand);
    const a = verify.summary.output;
    console.log(`\n🔎 Verification: ${verify.ok ? "PASS" : "FAIL"}`);
    console.log(`   rows=${a.totalRows} tips=${a.tipCount} chainFromNewestTip=${a.chainLengthFromNewestTip} orphans=${a.orphanParents} cycles=${a.cycles}`);
    for (const p of verify.problems) console.log(`   ❌ ${p}`);
  }

  return { ok: true, outputPath, newSessionId, mode: cleanMode, stats, verify, resumeCommand };
}

// ============================================================================
// CLI
// ============================================================================
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: context-cleaner.ts <transcript.jsonl | session-uuid[접두]> [--fork|--inplace] [--hooks delete|keep|Event1,Event2]");
    console.error("  (기본 —inplace)            원본을 정리본으로 덮어씀 (원자적 쓰기 — 검증 통과 시에만 rename)");
    console.error("  --fork                     00effaced 사본 생성 (기존 동작 — 위험 부담 없이 결과를 따로 보려면)");
    console.error("  <session-uuid[접두]>       경로 대신 uuid 입력 시 ~/.claude/projects/*/ 에서 파일명 탐색");
    console.error("  --hooks delete            훅 행 전부 삭제 (기본값)");
    console.error("  --hooks keep              훅 행 전부 보존 (내용도 원문 유지)");
    console.error("  --hooks sessionstart,stop 나열한 이벤트만 보존, 나머지 삭제");
    process.exit(1);
  }
  let sourcePath = "";
  let hooksVal: string | undefined;
  let cleanMode: "fork" | "inplace" = "inplace"; // [D7] 기본 in-place(PLAN §2 CLI 반전). --fork 시 사본. 원자적 쓰기(D5)+체인 판정(D2)으로 원본 보호.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--hooks") { hooksVal = args[++i]; if (hooksVal === undefined) { console.error("Error: --hooks 값이 없습니다"); process.exit(1); } }
    else if (a.startsWith("--hooks=")) hooksVal = a.slice(8);
    else if (a === "--fork") cleanMode = "fork";
    else if (a === "--inplace") cleanMode = "inplace";
    else if (a.startsWith("--")) { console.error(`Error: 알 수 없는 플래그 ${a}`); process.exit(1); }
    else sourcePath = a;
  }
  if (!sourcePath) { console.error("Error: transcript 경로가 없습니다"); process.exit(1); }
  const resolved = resolveTranscriptArg(sourcePath);
  if (!resolved.ok) { console.error(`Error: ${resolved.error}`); process.exit(1); }
  sourcePath = resolved.path;

  const res = await cleanTranscript(sourcePath, { hooks: parseHooksFlag(hooksVal), report: true, mode: cleanMode });
  if (!res.ok) {
    if (res.verify && !res.verify.ok) {
      console.error(`Error: ${res.error ?? `무결성 검사 실패 — 원본 유지: ${res.verify.problems.join("; ")}`}`);
      process.exit(2);
    }
    console.error(`Error: ${res.error}`); process.exit(1);
  }
  if (res.verify && !res.verify.ok) {
    console.error(`무결성 검사 실패 — 출력을 신뢰하지 마십시오: ${res.verify.problems.join("; ")}`);
    process.exit(2);
  }
  // resume 명령 클립보드 복사 (macOS, 실패해도 무시)
  try {
    const { execSync } = await import("node:child_process");
    execSync("pbcopy", { input: res.resumeCommand ?? "" });
    console.log("📋 Copied to clipboard!");
  } catch {}
}

if (import.meta.main) main();
