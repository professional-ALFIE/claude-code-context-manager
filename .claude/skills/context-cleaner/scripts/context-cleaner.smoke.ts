#!/usr/bin/env bun
/**
 * context-cleaner.ts 스모크 테스트 (Integration)
 *
 * instruct--testing 지침 적용:
 * - §2 테스트 먼저 작성 (이 파일이 본체보다 먼저 작성됨 — Red 확인 후 구현)
 * - §3 격리: 본체를 import해서 내부 함수(cleanTranscript)를 직접 호출
 * - §4 Integration: fixture와 선택적으로 주입된 실물 transcript로 전체 흐름(파싱→클리닝→삭제→재매핑→검증→쓰기)을 돌림
 * - §5 관찰 가능성: 단계별 로그 + 경과 시간
 * - §6 에러 경로: 없는 파일 / 깨진 JSON 줄 / 플래그 파싱
 * - §8 산출물 보존이 기본값 — 저장소의 회귀 분석 정책에 따라 CLEAN_ARTIFACTS=1일 때만 정리.
 * - §12 안전장치: 실물 세션 테스트는 --fork로 고정해 원본 불변을 검증하고, in-place는 사본 fixture에서만 검증
 * - §14 동작 검증: 출력 파일의 행 구성(입력→출력)만 검증, 내부 구현 세부는 검증하지 않음
 * - §15 각 테스트는 Arrange→Act→Assert 구조
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// ── 선택적 실물 transcript integration ──
// 공개 저장소에 개인 경로·세션 ID를 넣지 않는다. 필요한 경우 실행 환경에서 주입한다.
//   CONTEXT_CLEANER_REGRESSION_TRANSCRIPT=${HOME}/path/to/regression.jsonl
//   CONTEXT_CLEANER_REAL_SESSION_IDS=<uuid1>,<uuid2>,<uuid3>
const regressionTranscript = process.env.CONTEXT_CLEANER_REGRESSION_TRANSCRIPT?.trim() ?? "";
const realSessionIds = (process.env.CONTEXT_CLEANER_REAL_SESSION_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const FIXTURE = fileURLToPath(new URL("./fixtures-smoke-malformed.jsonl", import.meta.url));

// ── 테스트 러너 최소 골격 (§5 로그 / §13 이름으로 의도 표현) ──
let failures: string[] = [];
let currentTest = "";
function assert(cond: boolean, msg: string) {
  const line = `[${currentTest}] ${msg}`;
  if (cond) console.log(`    ✅ ${line}`);
  else {
    console.log(`    ❌ ${line}`);
    failures.push(line);
  }
}
async function test(name: string, fn: () => Promise<void> | void) {
  currentTest = name;
  const t0 = performance.now();
  console.log(`\n▶ ${name}`);
  try {
    await fn();
    console.log(`  (${((performance.now() - t0) / 1000).toFixed(2)}s)`);
  } catch (e) {
    failures.push(`[${name}] 예외: ${e}`);
    console.log(`    ❌ 예외 발생: ${e}`);
  }
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const rows = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((raw) => {
      try {
        return { raw, o: JSON.parse(raw) as any };
      } catch {
        return { raw, o: null };
      }
    });

// 행 판별 헬퍼 (출력 검증용 — 본체와 독립 구현이어야 §14에 맞음)
const isHookRow = (o: any) =>
  !!o &&
  ((o.type === "progress" && o.data?.type === "hook_progress") ||
    (o.type === "system" && o.subtype === "stop_hook_summary") ||
    (o.type === "attachment" && typeof o.attachment?.type === "string" && o.attachment.type.startsWith("hook_")));
const isThinkingOnlyRow = (o: any) =>
  !!o &&
  o.type === "assistant" &&
  Array.isArray(o.message?.content) &&
  o.message.content.length > 0 &&
  o.message.content.every((b: any) => b?.type === "thinking" || b?.type === "redacted_thinking");
const isSyntheticRow = (o: any) =>
  !!o &&
  ((o.type === "assistant" && o.message?.model === "<synthetic>") ||
    (o.type === "user" &&
      o.isMeta === true &&
      Array.isArray(o.message?.content) &&
      o.message.content.some((b: any) => b?.type === "text" && b?.text === "Continue from where you left off.")));
const uuidSet = (rs: ReturnType<typeof rows>) => new Set(rs.filter((r) => r.o?.uuid).map((r) => r.o.uuid as string));
const leafUuids = (rs: ReturnType<typeof rows>) => {
  const parents = new Set(rs.filter((r) => r.o?.parentUuid).map((r) => r.o.parentUuid as string));
  return new Set(
    rs
      .filter((r) => r.o?.uuid && (r.o.type === "user" || r.o.type === "assistant") && !parents.has(r.o.uuid))
      .map((r) => r.o.uuid as string),
  );
};

async function main() {
  console.log("=== context-cleaner.ts 스모크 테스트 시작 ===");

  // 본체 import (없으면 Red)
  let mod: any;
  try {
    mod = await import("./context-cleaner.ts");
  } catch (e) {
    console.log(`\n🔴 RED: 본체 import 실패 — ${e}`);
    process.exit(1);
  }
  const { cleanTranscript, parseHooksFlag, resolveTranscriptArg, buildResumeCommand, lastCwd, normalizeHomePrefix } = mod;

  // 실물 transcript 경로 해석 (uuid → 현재 projects 폴더의 실제 경로)
  const 해석 = (uuid: string): string => {
    const r = resolveTranscriptArg(uuid);
    if (!r.ok) throw new Error(`실물 세션 해석 실패: ${r.error}`);
    return r.path;
  };
  const artifacts: string[] = [];

  // T1 ───────────────────────────────────────────────────────────────
  await test("T1 기본(--hooks delete): regression transcript에서 훅·think 행이 전부 사라지고 체인이 온전하다", async () => {
    if (!regressionTranscript) {
      console.log("    ⏭ CONTEXT_CLEANER_REGRESSION_TRANSCRIPT 미설정 — 선택적 실물 검증 건너뜀");
      return;
    }
    // Arrange
    const srcHash = sha(regressionTranscript);
    const before = rows(regressionTranscript);
    const beforeLeaves = leafUuids(before);
    // Act
    const res = await cleanTranscript(regressionTranscript, { hooks: parseHooksFlag(undefined), mode: "fork" });
    // Assert
    assert(res.ok === true, "클리닝 성공(ok=true)");
    assert(sha(regressionTranscript) === srcHash, "원본 파일 바이트 불변 (§12)");
    assert(!!res.outputPath && existsSync(res.outputPath), `출력 파일 생성됨: ${res.outputPath}`);
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    assert(after.every((r) => r.o !== null), "출력 전 행이 JSON으로 파싱됨");
    assert(after.filter((r) => isHookRow(r.o)).length === 0, "훅 행 3형태가 0개");
    assert(after.filter((r) => isThinkingOnlyRow(r.o)).length === 0, "thinking-only 행이 0개");
    // 체인 무결성: 모든 parentUuid가 파일 안에서 해소
    const us = uuidSet(after);
    const orphans = after.filter((r) => r.o?.parentUuid && !us.has(r.o.parentUuid));
    assert(orphans.length === 0, `고아 parentUuid 0개 (실제 ${orphans.length}개)`);
    // last-prompt는 삭제되지 않고, leafUuid는 전부 살아있는 uuid를 가리킴 (재매핑 검증)
    const lps = after.filter((r) => r.o?.type === "last-prompt");
    assert(lps.length === before.filter((r) => r.o?.type === "last-prompt").length, "last-prompt 행 수 보존");
    assert(
      lps.every((r) => r.o.leafUuid === undefined || r.o.leafUuid === null || us.has(r.o.leafUuid)),
      "모든 last-prompt.leafUuid가 해소됨(삭제행 앵커는 재매핑됨)",
    );
    // 평행세계 갈래 tip 보존: [7b](a173e6ca), 수동 [5a](9b7a597c)가 여전히 leaf
    const afterLeaves = leafUuids(after);
    for (const tip of beforeLeaves)
      assert(afterLeaves.has(tip), `갈래 tip 보존: ${String(tip).slice(0, 8)}`);
    // sessionId 통일: 모든 sessionId(camelCase)가 새 파일명과 일치
    const newId = res.newSessionId;
    assert(
      after.every((r) => !r.o?.sessionId || r.o.sessionId === newId),
      `sessionId 전부 ${newId} 로 통일`,
    );
    // 검증 리포트 자체도 통과해야 함
    assert(res.verify?.ok === true, `내장 무결성 검사 통과 (${JSON.stringify(res.verify?.summary ?? {})})`);
  });

  // T2 ───────────────────────────────────────────────────────────────
  await test("T2 --hooks keep: 훅 행은 전부 살아남고 think 행만 사라진다", async () => {
    if (!regressionTranscript) {
      console.log("    ⏭ CONTEXT_CLEANER_REGRESSION_TRANSCRIPT 미설정 — 선택적 실물 검증 건너뜀");
      return;
    }
    const before = rows(regressionTranscript);
    const hookCountBefore = before.filter((r) => isHookRow(r.o)).length;
    const res = await cleanTranscript(regressionTranscript, { hooks: parseHooksFlag("keep"), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    assert(
      after.filter((r) => isHookRow(r.o)).length === hookCountBefore,
      `훅 행 ${hookCountBefore}개 전부 보존`,
    );
    assert(after.filter((r) => isThinkingOnlyRow(r.o)).length === 0, "thinking-only 행은 여전히 0개");
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
  });

  // T3 ───────────────────────────────────────────────────────────────
  await test("T3 --hooks sessionstart: SessionStart 훅만 살고 Stop 훅(stop_hook_summary)은 삭제된다", async () => {
    if (!regressionTranscript) {
      console.log("    ⏭ CONTEXT_CLEANER_REGRESSION_TRANSCRIPT 미설정 — 선택적 실물 검증 건너뜀");
      return;
    }
    const res = await cleanTranscript(regressionTranscript, { hooks: parseHooksFlag("sessionstart"), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const sessionStartKept = after.filter(
      (r) => r.o?.type === "attachment" && r.o.attachment?.type?.startsWith?.("hook_") && r.o.attachment?.hookEvent === "SessionStart",
    ).length;
    assert(sessionStartKept > 0, `SessionStart 훅 attachment 보존됨 (${sessionStartKept}개)`);
    assert(
      after.filter((r) => r.o?.type === "system" && r.o.subtype === "stop_hook_summary").length === 0,
      "Stop 훅 요약 행은 삭제됨",
    );
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
  });

  // T4 ───────────────────────────────────────────────────────────────
  // 이 테스트는 과거 실물 세션에서 발견한 회귀를 fixture로 재현한다.
  // 그 파일은 synthetic 행들에도 attachment 자식이 붙어 있어 synthetic 자체가 leaf가 아니었다.
  // 따라서 "tip 개수"가 아니라 "synthetic uuid를 제외한 원본 tip이 출력에서도 tip으로 보존되는지"를 본다.
  // 지금은 실물 세션 구조 변화에 흔들리지 않도록 같은 의미를 fixture로 재현한다.
  await test("T4 fixture: 합성 행(model=<synthetic> / Continue-from)이 삭제되고 원본 갈래 tip이 보존된다", async () => {
    const F = FIXTURE.replace("malformed", "synthetic-branch");
    const sid = "fixture-synthetic-branch-0000-000000000001";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-root", timestamp: "2026-07-07T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-root", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "진짜 응답" }] }, uuid: "a-real", timestamp: "2026-07-07T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "a-real", type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] }, uuid: "u-synth", timestamp: "2026-07-07T00:00:02.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-synth", type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] }, uuid: "a-synth", timestamp: "2026-07-07T00:00:03.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "a-real", type: "user", message: { role: "user", content: "다음 질문" }, uuid: "u-tip", timestamp: "2026-07-07T00:00:04.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const before = rows(F);
    const syntheticUuids = new Set(before.filter((r) => isSyntheticRow(r.o) && r.o?.uuid).map((r) => r.o.uuid as string));
    const beforeTips = new Set([...leafUuids(before)].filter((uuid) => !syntheticUuids.has(String(uuid))));
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    assert(after.filter((r) => isSyntheticRow(r.o)).length === 0, "합성 행 0개");
    const us = uuidSet(after);
    const orphans = after.filter((r) => r.o?.parentUuid && !us.has(r.o.parentUuid));
    assert(orphans.length === 0, "고아 parentUuid 0개");
    const afterTips = leafUuids(after);
    for (const tip of beforeTips)
      assert(afterTips.has(tip), `원본 tip 보존: ${String(tip).slice(0, 8)}`);
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
  });

  // T4b ──────────────────────────────────────────────────────────────
  // synthetic 쌍이 "사슬 끝"에 있을 때 삭제하면 pending user가 leaf로 복원되는지 —
  // 실물 파일엔 attachment 자식이 붙어 있어 이 성질을 못 보므로 fixture로 검증 (§6)
  await test("T4b fixture: 사슬 끝 synthetic 쌍 삭제 시 pending user가 leaf로 복원된다", async () => {
    const FIXTURE2 = FIXTURE.replace("malformed", "synthetic");
    const lines = [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-07T00:00:00.000Z", sessionId: "fixture-0000-0000-0000-000000000001" }),
      JSON.stringify({ parentUuid: "u-1", type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] }, uuid: "u-synth", timestamp: "2026-07-07T00:00:01.000Z", sessionId: "fixture-0000-0000-0000-000000000001" }),
      JSON.stringify({ parentUuid: "u-synth", type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] }, uuid: "a-synth", timestamp: "2026-07-07T00:00:02.000Z", sessionId: "fixture-0000-0000-0000-000000000001" }),
    ];
    writeFileSync(FIXTURE2, lines.join("\n") + "\n");
    const res = await cleanTranscript(FIXTURE2, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    assert(after.length === 1 && after[0].o?.uuid === "u-1", "synthetic 쌍만 사라지고 진짜 user만 남음");
    assert(leafUuids(after).has("u-1"), "pending user(u-1)가 leaf로 복원됨");
  });

  // T5 ───────────────────────────────────────────────────────────────
  // 환경변수로 주입한 실물 세션 각각: 30%+ 감량 + verify ok + 원본 불변.
  await test("T5 환경변수 실물 세션: 각각 30%+ 감량 + verify ok + 원본 불변", async () => {
    if (realSessionIds.length === 0) {
      console.log("    ⏭ CONTEXT_CLEANER_REAL_SESSION_IDS 미설정 — 선택적 실물 검증 건너뜀");
      return;
    }
    for (const uuid of realSessionIds) {
      const p = 해석(uuid);
      const tag = uuid.slice(0, 8);
      const srcHash = sha(p);
      const res = await cleanTranscript(p, { hooks: parseHooksFlag(undefined), mode: "fork" });
      assert(res.ok === true, `${tag} 클리닝 성공`);
      if (!res.outputPath) continue;
      artifacts.push(res.outputPath);
      assert(sha(p) === srcHash, `${tag} 원본 파일 바이트 불변 (§12)`);
      const origSize = readFileSync(p).byteLength;
      const newSize = readFileSync(res.outputPath).byteLength;
      assert(newSize < origSize * 0.7, `${tag} 30%+ 감량 (${origSize} → ${newSize} bytes)`);
      assert(res.verify?.ok === true, `${tag} 내장 무결성 검사 통과`);
    }
  });

  // T6 ───────────────────────────────────────────────────────────────
  await test("T6 에러 경로: 없는 파일은 ok=false, 깨진 JSON 줄은 원문 그대로 보존된다", async () => {
    // (a) 없는 파일 (§6)
    const res1 = await cleanTranscript("/nonexistent/딸깍.jsonl", { hooks: parseHooksFlag(undefined) });
    assert(res1.ok === false, "없는 파일 → ok=false (예외로 죽지 않음)");
    // (b) 깨진 JSON 줄 fixture (Arrange: 직접 구성 — §1 프로덕션 코드 무수정)
    const malformed = `{"broken": [이건 JSON이 아님`;
    const fixtureLines = [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "안녕" }, uuid: "u-1", timestamp: "2026-07-07T00:00:00.000Z", sessionId: "fixture-0000-0000-0000-000000000000" }),
      malformed,
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "생각생각", signature: "SIG" }] }, uuid: "a-1", timestamp: "2026-07-07T00:00:01.000Z", sessionId: "fixture-0000-0000-0000-000000000000" }),
      JSON.stringify({ parentUuid: "a-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "응답" }] }, uuid: "a-2", timestamp: "2026-07-07T00:00:02.000Z", sessionId: "fixture-0000-0000-0000-000000000000" }),
    ];
    writeFileSync(FIXTURE, fixtureLines.join("\n") + "\n");
    const res2 = await cleanTranscript(FIXTURE, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res2.ok === true, "fixture 클리닝 성공");
    if (res2.outputPath) {
      artifacts.push(res2.outputPath);
      const after = readFileSync(res2.outputPath, "utf8").split("\n").filter((l) => l.trim());
      assert(after.includes(malformed), "깨진 줄이 원문 그대로 보존됨");
      const parsed = after.filter((l) => l !== malformed).map((l) => JSON.parse(l) as any);
      assert(!parsed.some((o) => o.uuid === "a-1"), "thinking-only 행(a-1) 삭제됨");
      const a2 = parsed.find((o) => o.uuid === "a-2");
      assert(a2?.parentUuid === "u-1", `a-2의 parentUuid가 삭제된 a-1을 건너뛰고 조상 u-1로 재연결됨 (실제: ${a2?.parentUuid})`);
    }
    // (c) 플래그 파싱
    assert(parseHooksFlag(undefined).mode === "delete", "--hooks 생략 → delete 기본");
    assert(parseHooksFlag("keep").mode === "keep", "--hooks keep → 전부 보존");
    const evs = parseHooksFlag("SessionStart,stop");
    assert(evs.mode === "keep-events" && evs.events.has("sessionstart") && evs.events.has("stop"), "--hooks 목록 → keep-events(소문자 정규화)");
  });

  // T7 ───────────────────────────────────────────────────────────────
  await test("T7 uuid 해석: 파일명 매칭·정확일치 우선·모호 거부", async () => {
    // Arrange: 고정 fixture projects 루트 (산출물 보존 원칙 — 임시폴더 아님)
    const ROOT = fileURLToPath(new URL("./fixtures-projects-root/", import.meta.url));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${ROOT}-proj-a`, { recursive: true });
    mkdirSync(`${ROOT}-proj-b`, { recursive: true });
    const 유일 = "aaaa1111-0000-0000-0000-000000000001";
    const 모호1 = "abcd1111-0000-0000-0000-000000000002";
    const 모호2 = "abcd2222-0000-0000-0000-000000000003";
    const 원본 = "eeee1111-0000-0000-0000-000000000004";
    const 사본 = "eeee1111-0000-0000-0000-00effaced001"; // 원본과 접두 공유하는 effaced
    writeFileSync(`${ROOT}-proj-a/${유일}.jsonl`, "{}\n");
    writeFileSync(`${ROOT}-proj-a/${모호1}.jsonl`, "{}\n");
    writeFileSync(`${ROOT}-proj-b/${모호2}.jsonl`, "{}\n");
    writeFileSync(`${ROOT}-proj-b/${원본}.jsonl`, "{}\n");
    writeFileSync(`${ROOT}-proj-b/${사본}.jsonl`, "{}\n");
    // Act & Assert
    const r1 = resolveTranscriptArg(유일, ROOT);
    assert(r1.ok === true && r1.path.endsWith(`${유일}.jsonl`), "전체 uuid → 정확히 해석");
    const r2 = resolveTranscriptArg("aaaa1111", ROOT);
    assert(r2.ok === true && r2.path.endsWith(`${유일}.jsonl`), "uuid 접두 → 유일 매칭 해석");
    const r3 = resolveTranscriptArg("abcd", ROOT);
    assert(r3.ok === false && /모호/.test(r3.error), "모호 접두 → 후보 나열 에러");
    const r4 = resolveTranscriptArg(원본, ROOT);
    assert(r4.ok === true && r4.path.endsWith(`${원본}.jsonl`), "effaced 사본이 접두를 공유해도 정확일치가 우선");
    const r5 = resolveTranscriptArg("deadbeef", ROOT);
    assert(r5.ok === false, "매칭 없음 → 에러");
    const r6 = resolveTranscriptArg("스크립트아님!!", ROOT);
    assert(r6.ok === false, "uuid 형태도 경로도 아님 → 에러");
    // 실전 projects 루트는 환경변수로 받은 세션 ID가 있을 때만 확인한다.
    const realSessionId = realSessionIds[0];
    if (realSessionId) {
      const rReal = resolveTranscriptArg(realSessionId);
      assert(rReal.ok && rReal.path.endsWith(`${realSessionId}.jsonl`), `실전 루트에서 실물 세션 해석: ${rReal.ok ? rReal.path : rReal.error}`);
    } else {
      console.log("    ⏭ CONTEXT_CLEANER_REAL_SESSION_IDS 미설정 — 실전 루트 검증 건너뜀");
    }
  });

  // T8 ───────────────────────────────────────────────────────────────
  await test("T8 resume 문구: cd <세션cwd> && claude … 형태 + e2e에서 resumeCommand 반환", async () => {
    // 단위: 템플릿·따옴표·cwd 부재 폴백
    const home = os.homedir();
    const homeProject = path.join(home, "project");
    const cmd1 = buildResumeCommand(homeProject, "id-123");
    assert(
      cmd1 === `cd ${homeProject} && claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume id-123`,
      `기본 템플릿 (실제: ${cmd1})`,
    );
    assert(buildResumeCommand(null, "id-123").startsWith("claude "), "cwd 부재 → cd 없이 폴백");
    const cmd2 = buildResumeCommand("/tmp/한글 경로", "id-123");
    assert(cmd2.startsWith(`cd "/tmp/한글 경로" &&`), `특수문자 cwd는 겹따옴표 감쌈 — \${HOME} 확장 유지 (실제: ${cmd2})`);
    const cmd3 = buildResumeCommand("${HOME}/project/x", "id-123");
    assert(cmd3.startsWith("cd ${HOME}/project/x &&"), `\${HOME} 토큰 경로는 따옴표 없이 그대로 (실제: ${cmd3})`);
    // 단위: 홈 접두 → 리터럴 ${HOME} 토큰 (실행 터미널에서 확장 — 이식형)
    const alternateHome = path.join(path.dirname(home), "context-cleaner-other-user");
    const currentRelativeCwd = process.cwd().startsWith(home + path.sep) ? process.cwd().slice(home.length) : "";
    const alternateExistingPath = alternateHome + currentRelativeCwd;
    assert(
      normalizeHomePrefix(alternateExistingPath) === "${HOME}" + currentRelativeCwd,
      "다른 홈 접두 → 리터럴 ${HOME} 토큰 (치환 결과 실존)",
    );
    const alternateMissingPath = path.join(alternateHome, "context-cleaner-path-does-not-exist");
    assert(
      normalizeHomePrefix(alternateMissingPath) === alternateMissingPath,
      "치환 결과가 실존하지 않으면 원문 유지 (오치환 방지)",
    );
    assert(normalizeHomePrefix(`${home}/project`) === "${HOME}/project", "현재 홈 접두도 ${HOME} 토큰화");
    assert(normalizeHomePrefix("/opt/somewhere") === "/opt/somewhere", "홈 꼴이 아니면 무변경");
    assert(normalizeHomePrefix(null) === null, "null 통과");
    // 단위: lastCwd는 파일 순서상 마지막 cwd
    const cwdRows = [
      { o: { cwd: "/old" } },
      { o: null },
      { o: { cwd: "/new" } },
      { o: { type: "last-prompt" } }, // cwd 없는 행
    ];
    assert(lastCwd(cwdRows) === "/new", "lastCwd = 마지막으로 기록된 cwd");
    // e2e: cwd 있는 fixture를 클리닝하면 resumeCommand가 세션 cwd로 조립됨
    const FIXTURE3 = FIXTURE.replace("malformed", "cwd");
    const sid = "fixture-0000-0000-0000-000000000002";
    const fixtureCwd = path.join(home, "context-cleaner 작업 폴더");
    writeFileSync(FIXTURE3, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-07T00:00:00.000Z", sessionId: sid, cwd: fixtureCwd }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "응답" }] }, uuid: "a-1", timestamp: "2026-07-07T00:00:01.000Z", sessionId: sid, cwd: fixtureCwd }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(FIXTURE3, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "cwd fixture 클리닝 성공");
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(
      res.resumeCommand === `cd "\${HOME}/context-cleaner 작업 폴더" && claude --dangerously-skip-permissions --thinking-display summarized --verbose --resume ${res.newSessionId}`,
      `e2e resumeCommand 조립 — 현재 홈은 \${HOME} 토큰화하고 공백 경로는 겹따옴표 처리 (실제: ${res.resumeCommand})`,
    );
  });

  // T9 ───────────────────────────────────────────────────────────────
  // [PLAN §6 D3 / §5.2] 체인 끊김: 중간 행 parentUuid가 미존재 uuid.
  // probe 실측 — 클리너가 orphan parentUuid를 root화(6단계)하므로 클리닝 후 roots=2(다중 root)로 변환.
  // reachedRootFromNewestTip는 항상 true(안전망 전용), 실제 끊김 검출은 §5.2(roots>1).
  await test("T9 체인 끊김(중간 parentUuid 미존재) → 클리닝 후 다중 root로 잡힌다", async () => {
    const F = FIXTURE.replace("malformed", "dmg-chainbreak");
    const sid = "dmg-chainbreak-0000-0000-0000-000000000001";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "fake-uuid-notexist", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "끊김" }] }, uuid: "a-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 자체는 성공(출력 생성)");
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(res.verify?.ok === false, "verify FAIL — 체인 끊김이 감지됨");
    assert(!!res.verify?.problems.some((p: string) => /다중 root/.test(p)), `problem에 '다중 root' 포함 (실제: ${JSON.stringify(res.verify?.problems)})`);
  });

  // T10 ──────────────────────────────────────────────────────────────
  // [PLAN §6 D3 / §5.2] 다중 root: 대화 parentUuid null이 2개.
  await test("T10 다중 root(대화행 parentUuid null 2개) → 다중 root로 잡힌다", async () => {
    const F = FIXTURE.replace("malformed", "dmg-multiroot");
    const sid = "dmg-multiroot-0000-0000-0000-000000000002";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q1" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a1" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q2" }, uuid: "u-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(res.verify?.ok === false, "verify FAIL — 다중 root 감지");
    assert(!!res.verify?.problems.some((p: string) => /다중 root/.test(p)), `problem에 '다중 root' 포함 (실제: ${JSON.stringify(res.verify?.problems)})`);
  });

  // T11 ──────────────────────────────────────────────────────────────
  // [PLAN §6 D3 / §5.3] resume 앵커 끊김: 마지막 last-prompt.leafUuid가 미존재 uuid.
  // unresLeaf는 기존 판정이 '증가'만 봐서 입력도 1이면 통과 → §5.3 절대기준이 메운다.
  await test("T11 resume 앵커 끊김(last-prompt.leafUuid 미존재) → 앵커 끊김으로 잡힌다", async () => {
    const F = FIXTURE.replace("malformed", "dmg-anchor");
    const sid = "dmg-anchor-0000-0000-0000-000000000003";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ type: "last-prompt", leafUuid: "ghost-uuid-notexist", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(res.verify?.ok === false, "verify FAIL — resume 앵커 끊김 감지");
    assert(!!res.verify?.problems.some((p: string) => /앵커 끊김/.test(p)), `problem에 '앵커 끊김' 포함 (실제: ${JSON.stringify(res.verify?.problems)})`);
  });

  // T12 ──────────────────────────────────────────────────────────────
  // [PLAN §6 D3] summary가 유일 root → 정상 (F_summary_주의: summary도 대화 root로 인정).
  await test("T12 summary가 유일 root(parentUuid null) → 정상으로 인정된다", async () => {
    const F = FIXTURE.replace("malformed", "dmg-summaryroot");
    const sid = "dmg-summaryroot-0000-0000-0000-000000000004";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "summary", summary: "이전 대화 요약", uuid: "s-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "s-1", type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(res.verify?.ok === true, `summary가 유일 root → 정상 (실제 problems: ${JSON.stringify(res.verify?.problems)})`);
  });

  // T13 ──────────────────────────────────────────────────────────────
  // [PLAN §6 D3] hook attachment가 실제 root면 대화행 root=0이어도 정상이어야 한다.
  await test("T13 hook attachment root + --hooks keep: 대화행 root=0이어도 walk가 root에 닿으면 정상", async () => {
    const F = FIXTURE.replace("malformed", "hookroot");
    const sid = "fixtures-smoke-hookroot";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "attachment", attachment: { type: "hook_success", hookEvent: "SessionStart" }, uuid: "h-root", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "h-root", type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(F, { hooks: parseHooksFlag("keep"), mode: "fork" });
    assert(res.ok === true, "hook root fixture 클리닝 성공");
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(res.verify?.ok === true, `verify PASS (실제 problems: ${JSON.stringify(res.verify?.problems)})`);
    assert(res.verify?.summary?.output?.conversationRootCount === 0, `대화행 root=0 (실제: ${res.verify?.summary?.output?.conversationRootCount})`);
    assert(res.verify?.summary?.output?.reachedRootFromNewestTip === true, "최신 tip walk가 hook root까지 도달");
  });

  // T14 ──────────────────────────────────────────────────────────────
  // [PLAN D4] cleanTranscript 기본 in-place: 사본 경로에 정리본을 덮어쓴다. R6(실물 아닌 사본에서 실험).
  // 검증: mode 생략, outputPath==sourcePath, newSessionId==파일명(R2 무치환), 사본이 정리본으로 교체, 원본 fixture 불변.
  await test("T14 cleanTranscript 기본값: mode 생략 시 in-place로 덮어쓰고 파일명 sessionId를 유지한다", async () => {
    const ORIG = FIXTURE.replace("malformed", "inplace-orig");
    const WORK = FIXTURE.replace("malformed", "inplace-work"); // 사본 = in-place 대상 (R6: 실물 아님)
    const sid = path.basename(WORK, ".jsonl"); // 내부 sessionId = basename(정상 세션 구조 → R2 무치환)
    writeFileSync(ORIG, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "생각", signature: "SIG" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "a-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "응답" }] }, uuid: "a-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    writeFileSync(WORK, readFileSync(ORIG, "utf8"));
    const origHash = sha(ORIG);
    const workSizeBefore = readFileSync(WORK).byteLength;
    // Act
    const res = await cleanTranscript(WORK, { hooks: parseHooksFlag(undefined) });
    // Assert
    assert(res.ok === true, "in-place 클리닝 성공");
    assert(res.mode === "inplace", "mode=inplace 반환");
    assert(res.outputPath === WORK, `outputPath = 원본(사본) 경로 (실제: ${res.outputPath})`);
    assert(res.newSessionId === sid, `newSessionId = basename 그대로 (실제: ${res.newSessionId})`);
    artifacts.push(WORK);
    assert(existsSync(WORK), "사본 파일 존재 (in-place 덮어쓰기됨)");
    const newSize = readFileSync(WORK).byteLength;
    assert(newSize < workSizeBefore, `정리본으로 크기 감소 (${workSizeBefore}→${newSize})`);
    const cleaned = readFileSync(WORK, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as any);
    assert(!cleaned.some((o: any) => o.uuid === "a-1"), "thinking-only 행(a-1)이 삭제됨");
    assert(cleaned.every((o: any) => !o.sessionId || o.sessionId === sid), "sessionId 전부 basename 유지 (R2 무치환)");
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
    assert(sha(ORIG) === origHash, "원본 fixture 불변 (R6)");
  });

  // T15 ──────────────────────────────────────────────────────────────
  await test("T15 --fork 모드: 원본을 보존하고 사본 sessionId로 치환한다", async () => {
    const F = FIXTURE.replace("malformed", "fork-work");
    const sid = path.basename(F, ".jsonl");
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "생각", signature: "SIG" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "a-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "응답" }] }, uuid: "a-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const srcHash = sha(F);
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "fork 클리닝 성공");
    assert(sha(F) === srcHash, "원본 파일 바이트 불변");
    assert(res.outputPath !== F, `outputPath가 원본과 다름 (실제: ${res.outputPath})`);
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    assert(after.every((r) => !r.o?.sessionId || r.o.sessionId === res.newSessionId), "sessionId 전부 사본 파일명으로 치환");
  });

  // T16 ──────────────────────────────────────────────────────────────
  // [PLAN D5] in-place + 검증 실패 → 원본 무손상. R1(원본 보호는 원자성으로)의 핵심 검증.
  // 체인 끊김 fixture는 verify FAIL(다중 root)을 유발 → rename 안 함 → 사본(원본) 무손상.
  await test("T16 in-place + 손상(체인 끊김) → 원본 무손상, 임시파일 미생성, ok=false", async () => {
    const ORIG = FIXTURE.replace("malformed", "inplace-dmg-orig");
    const WORK = FIXTURE.replace("malformed", "inplace-dmg-work"); // 사본 = in-place 대상 (R6)
    const sid = path.basename(WORK, ".jsonl");
    writeFileSync(ORIG, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a1" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "fake-notexist", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "끊김" }] }, uuid: "a-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    writeFileSync(WORK, readFileSync(ORIG, "utf8"));
    const workHashBefore = sha(WORK);
    // Act
    const res = await cleanTranscript(WORK, { hooks: parseHooksFlag(undefined), mode: "inplace" });
    // Assert
    assert(res.ok === false, "ok=false (검증 실패 → 정리본 미생성)");
    assert(res.verify?.ok === false, "verify FAIL (다중 root)");
    assert(!!res.verify?.problems.some((p: string) => /다중 root/.test(p)), "problem에 '다중 root'");
    assert(sha(WORK) === workHashBefore, "사본(원본) 내용 무손상 (R1 — rename 안 됨)");
    assert(!existsSync(`${WORK}.tmp-${process.pid}`), "임시파일 미생성");
  });

  // T17 ──────────────────────────────────────────────────────────────
  // CLI 사용자는 내부 verify 객체를 볼 수 없으므로, 실패 stderr에 상세 원인이 드러나야 한다.
  await test("T17 CLI in-place 실패 출력: stderr에 상세 원인(다중 root)이 나온다", async () => {
    const WORK = FIXTURE.replace("malformed", "cli-dmg-detail-work");
    const sid = path.basename(WORK, ".jsonl");
    writeFileSync(WORK, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a1" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "fake-notexist", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "broken" }] }, uuid: "a-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const beforeHash = sha(WORK);
    const cli = spawnSync("./context-cleaner.ts", [WORK], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
    });
    assert(cli.status === 2, `CLI exit code 2 (실제: ${cli.status})`);
    assert(cli.stderr.includes("다중 root"), `stderr에 상세 원인 포함 (stderr: ${cli.stderr.trim()})`);
    assert(sha(WORK) === beforeHash, "CLI 실패 시 원본 내용 무손상");
  });

  // ── 정리 (§8: 회귀 분석을 위해 보존이 기본) ──
  if (process.env.CLEAN_ARTIFACTS === "1") {
    for (const a of artifacts) if (existsSync(a)) unlinkSync(a);
    console.log(`\n🧹 CLEAN_ARTIFACTS=1 → 산출물 ${artifacts.length}개 삭제`);
  } else {
    console.log(`\n📦 산출물 보존 (${artifacts.length}개):`);
    for (const a of artifacts) console.log(`   ${a}`);
  }

  console.log("\n=== 결과 ===");
  if (failures.length === 0) {
    console.log("🟢 GREEN: 전체 통과");
  } else {
    console.log(`🔴 실패 ${failures.length}건:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
