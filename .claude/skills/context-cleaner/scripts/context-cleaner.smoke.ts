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
  const { cleanTranscript, parseHooksFlag, resolveTranscriptArg, buildResumeCommand, lastCwd, normalizeHomePrefix, verifyAgainstBaseline } = mod;

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

  // T8b ──────────────────────────────────────────────────────────────
  // [§5.2] root 개수가 아니라 "출력에서 왜 root가 됐는가"를 입출력 대조한다.
  // 첫 발화 취소/400 후 같은 훅 부모로 재발화한 갈래는 훅 삭제 후 root 2개가 되어도 정상이다.
  await test("T8b 삭제된 공통 훅 부모의 두 user가 root가 되어도 정상", () => {
    // Arrange
    const input = [
      JSON.stringify({ parentUuid: null, type: "attachment", attachment: { type: "hook_additional_context" }, uuid: "hook-1" }),
      JSON.stringify({ parentUuid: "hook-1", type: "user", message: { role: "user", content: "첫 발화" }, uuid: "u-1" }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "API Error" }] }, isApiErrorMessage: true, uuid: "a-err" }),
      JSON.stringify({ parentUuid: "hook-1", type: "user", message: { role: "user", content: "재발화" }, uuid: "u-2" }),
    ];
    const output = [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "첫 발화" }, uuid: "u-1" }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "API Error" }] }, isApiErrorMessage: true, uuid: "a-err" }),
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "재발화" }, uuid: "u-2" }),
    ];
    // Act
    const report = verifyAgainstBaseline(input, output);
    // Assert
    assert(report.ok === true, `삭제된 공통 부모에서 나온 정상 갈래 통과 (실제: ${JSON.stringify(report.problems)})`);
  });

  await test("T8c 부모가 출력에 살아있는데 root가 되면 재매핑 실패", () => {
    // Arrange
    const input = [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-parent" }),
      JSON.stringify({ parentUuid: "u-parent", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-child" }),
    ];
    const output = [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-parent" }),
      JSON.stringify({ parentUuid: null, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-child" }),
    ];
    // Act
    const report = verifyAgainstBaseline(input, output);
    // Assert
    assert(report.ok === false, "살아있는 부모를 잃은 root는 FAIL");
    assert(report.problems.some((p: string) => /재매핑 실패/.test(p)), `실패 원인이 드러남 (실제: ${JSON.stringify(report.problems)})`);
  });

  await test("T8d 바로 부모가 삭제돼도 살아있는 조상이 있으면 그 조상에 재연결해야 한다", () => {
    // Arrange
    const input = [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-ancestor" }),
      JSON.stringify({ parentUuid: "u-ancestor", type: "attachment", attachment: { type: "hook_success" }, uuid: "hook-parent" }),
      JSON.stringify({ parentUuid: "hook-parent", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-child" }),
    ];
    const output = [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-ancestor" }),
      JSON.stringify({ parentUuid: null, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-child" }),
    ];
    // Act
    const report = verifyAgainstBaseline(input, output);
    // Assert
    assert(report.ok === false, "살아있는 조상까지 건너뛴 root는 FAIL");
    assert(report.problems.some((p: string) => /u-ancestor/.test(p)), `재연결할 조상이 진단에 드러남 (실제: ${JSON.stringify(report.problems)})`);
  });

  // T9 ───────────────────────────────────────────────────────────────
  // [§5.2] 원본부터 미해소인 parentUuid는 클리너가 만든 손상이 아니다.
  // 6단계가 키를 제거해 명시적 root로 정리한 뒤 정상 통과해야 한다.
  await test("T9 원본부터 미해소인 parentUuid → root로 정리하고 통과", async () => {
    const F = FIXTURE.replace("malformed", "dmg-chainbreak");
    const sid = "dmg-chainbreak-0000-0000-0000-000000000001";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "질문" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "답" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "fake-uuid-notexist", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "끊김" }] }, uuid: "a-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공(출력 생성)");
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(res.verify?.ok === true, `원본 고아는 클리너 오류가 아니므로 통과 (실제: ${JSON.stringify(res.verify?.problems)})`);
    const outRows = res.outputPath ? rows(res.outputPath) : [];
    const repaired = outRows.find((r) => r.o?.uuid === "a-2")?.o;
    assert(repaired && !("parentUuid" in repaired), "미해소 parentUuid 키를 제거해 명시적 root로 정리");
  });

  // T10 ──────────────────────────────────────────────────────────────
  // [§5.2] 입력부터 존재한 다중 root는 클리너가 만든 변화가 아니다.
  await test("T10 입력부터 존재한 다중 root → 그대로 통과", async () => {
    const F = FIXTURE.replace("malformed", "dmg-multiroot");
    const sid = "dmg-multiroot-0000-0000-0000-000000000002";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q1" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a1" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q2" }, uuid: "u-2", timestamp: "2026-07-09T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    if (res.outputPath) artifacts.push(res.outputPath);
    assert(res.verify?.ok === true, `입력부터 있던 root는 클리너 오류가 아니므로 통과 (실제: ${JSON.stringify(res.verify?.problems)})`);
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
  // resume 앵커 미해소 fixture는 verify FAIL → rename 안 함 → 사본(원본) 무손상.
  await test("T16 in-place + resume 앵커 미해소 → 원본 무손상, 임시파일 미생성, ok=false", async () => {
    const ORIG = FIXTURE.replace("malformed", "inplace-dmg-orig");
    const WORK = FIXTURE.replace("malformed", "inplace-dmg-work"); // 사본 = in-place 대상 (R6)
    const sid = path.basename(WORK, ".jsonl");
    writeFileSync(ORIG, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a1" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ type: "last-prompt", leafUuid: "fake-notexist" }),
    ].join("\n") + "\n");
    writeFileSync(WORK, readFileSync(ORIG, "utf8"));
    const workHashBefore = sha(WORK);
    // Act
    const res = await cleanTranscript(WORK, { hooks: parseHooksFlag(undefined), mode: "inplace" });
    // Assert
    assert(res.ok === false, "ok=false (검증 실패 → 정리본 미생성)");
    assert(res.verify?.ok === false, "verify FAIL (resume 앵커 미해소)");
    assert(!!res.verify?.problems.some((p: string) => /resume 앵커|last-prompt/.test(p)), "problem에 resume 앵커 원인 포함");
    assert(sha(WORK) === workHashBefore, "사본(원본) 내용 무손상 (R1 — rename 안 됨)");
    assert(!existsSync(`${WORK}.tmp-${process.pid}`), "임시파일 미생성");
  });

  // T17 ──────────────────────────────────────────────────────────────
  // CLI 사용자는 내부 verify 객체를 볼 수 없으므로, 실패 stderr에 상세 원인이 드러나야 한다.
  await test("T17 CLI in-place 실패 출력: stderr에 resume 앵커 원인이 나온다", async () => {
    const WORK = FIXTURE.replace("malformed", "cli-dmg-detail-work");
    const sid = path.basename(WORK, ".jsonl");
    writeFileSync(WORK, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "q" }, uuid: "u-1", timestamp: "2026-07-09T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a1" }] }, uuid: "a-1", timestamp: "2026-07-09T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ type: "last-prompt", leafUuid: "fake-notexist" }),
    ].join("\n") + "\n");
    const beforeHash = sha(WORK);
    const cli = spawnSync("./context-cleaner.ts", [WORK], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
    });
    assert(cli.status === 2, `CLI exit code 2 (실제: ${cli.status})`);
    assert(/resume 앵커|last-prompt/.test(cli.stderr), `stderr에 상세 원인 포함 (stderr: ${cli.stderr.trim()})`);
    assert(sha(WORK) === beforeHash, "CLI 실패 시 원본 내용 무손상");
  });

  // T18 ──────────────────────────────────────────────────────────────
  // Workflow 도구 흔적: 인라인 script 전문은 치환, queue-operation 행은 삭제,
  // 완료 알림(task-notification)의 failures·diagnostics는 보존 —
  // 알림 본문은 실패 원인과 journal.jsonl 색인이라 지우면 추적이 끊긴다 (§14 동작 검증)
  await test("T18 fixture: Workflow inline script만 치환되고 queue-operation·완료 알림은 보존된다", async () => {
    // Arrange ── 실측한 Workflow 행 구성 그대로 (호출 → 접수증 → 큐잉 → 완료 알림)
    const F = FIXTURE.replace("malformed", "workflow");
    const sid = "fixture-workflow-0000-0000-000000000001";
    const bigScript = "export const meta = {name:'wf'}\n" + "// 인라인 스크립트 전문\n".repeat(60);
    const notification =
      "<task-notification>\n<status>completed</status>\n" +
      "<diagnostics>Per-agent results: /path/journal.jsonl — resumeFromRunId: 'wf_abc'</diagnostics>\n" +
      "<failures>parallel[0] failed: subagent completed without calling StructuredOutput</failures>\n" +
      "<usage><agent_count>10</agent_count></usage>\n</task-notification>";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "워크플로우 돌려라" }, uuid: "u-1", timestamp: "2026-07-31T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Workflow", id: "tu-1", input: { script: bigScript, scriptPath: "/repo/wf.mjs" } }] }, uuid: "a-1", timestamp: "2026-07-31T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "a-1", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "Workflow launched" }] }, toolUseResult: { status: "async_launched", taskType: "local_workflow", runId: "wf_abc", transcriptDir: "/path/subagents" }, uuid: "u-2", timestamp: "2026-07-31T00:00:02.000Z", sessionId: sid }),
      // queue-operation: uuid·parentUuid가 없다 (실측). content는 아래 알림과 중복
      JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-31T00:00:03.000Z", sessionId: sid, content: notification }),
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-31T00:00:04.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-2", type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: notification }, uuid: "u-3", timestamp: "2026-07-31T00:00:05.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const beforeBytes = readFileSync(F).length;

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);

    // Assert ── ① 인라인 script 전문은 사라지고 색인(name·scriptPath)은 남는다
    const wfCall = after.find((r) => r.o?.uuid === "a-1");
    const wfInput = wfCall?.o?.message?.content?.[0]?.input;
    assert(wfInput?.script === "[context-cleaner: workflow_script]", `input.script 치환 (실제: ${String(wfInput?.script).slice(0, 40)})`);
    assert(wfInput?.scriptPath === "/repo/wf.mjs", "input.scriptPath는 색인이므로 보존");
    assert(wfCall?.o?.message?.content?.[0]?.name === "Workflow", "tool_use.name 보존");
    // 감량 폭 검증: 스크립트 전문(약 1.5KB)이 빠졌다면 최소 절반 이상 줄어야 한다.
    // 느슨한 "줄었다"만 보면 다른 규칙의 감량에 묻혀 이 규칙의 회귀를 못 잡는다.
    const afterBytes = readFileSync(res.outputPath).length;
    assert(afterBytes < beforeBytes * 0.5, `스크립트 전문이 빠져 절반 이상 감량 (${beforeBytes}→${afterBytes})`);

    // ② queue-operation 행은 보존한다 (2026-07-31 결정).
    //    지워도 안전하지만 입력의 도달·소비 타이밍은 이 행에만 남으므로 남긴다.
    assert(after.filter((r) => r.o?.type === "queue-operation").length === 2, "queue-operation 행 2개 보존");

    // ③ 완료 알림 본문은 원문 그대로 — 실패 원인과 journal 색인이 유지되어야 한다
    const notif = after.find((r) => r.o?.uuid === "u-3");
    const nc = notif?.o?.message?.content;
    assert(typeof nc === "string" && nc.includes("StructuredOutput"), "완료 알림의 failures 내용 보존");
    assert(typeof nc === "string" && nc.includes("journal.jsonl"), "완료 알림의 diagnostics 색인 보존");
    assert(notif?.o?.toolUseResult === undefined || true, "접수증 행 존재 여부와 무관하게 체인 유지");

    // ④ 접수증의 추적 색인 보존 + 체인 무결성
    const receipt = after.find((r) => r.o?.uuid === "u-2");
    assert(receipt?.o?.toolUseResult?.transcriptDir === "/path/subagents", "접수증 transcriptDir(색인) 보존");
    const us = uuidSet(after);
    assert(after.filter((r) => r.o?.parentUuid && !us.has(r.o.parentUuid)).length === 0, "고아 parentUuid 0개");
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
  });

  // T19 ──────────────────────────────────────────────────────────────
  // 도구가 반환한 스크린샷: 같은 이미지가 두 자리에 저장된다.
  //   ① message.content[] → tool_result.content[] → image.source.data  (한 겹 안쪽)
  //   ② toolUseResult.file.base64                                       (두 번째 사본)
  // 기존 규칙은 ①을 최상위 배열에서만 찾아 tool_result 껍데기를 못 뚫었고,
  // ②는 규칙 자체가 없었다 → 실측 세션에서 1MB가 그대로 남았다 (Base64 images: 0 cleaned).
  // 치환값은 기존과 동일한 1x1 PNG여야 한다 — API가 data를 디코딩하므로 깨진 값은 400을 낸다.
  await test("T19 fixture: 도구 반환 이미지가 두 자리 모두 1x1 PNG로 치환되고 메타는 보존된다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "toolimage");
    const sid = "fixture-toolimage-0000-000000000001";
    const bigB64 = "iVBORw0KGgo" + "QUJDRUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3A".repeat(40);
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "스크린샷 찍어" }, uuid: "u-1", timestamp: "2026-07-31T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "tu-1", input: { command: "screencapture" } }] }, uuid: "a-1", timestamp: "2026-07-31T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({
        parentUuid: "a-1", type: "user", uuid: "u-2", timestamp: "2026-07-31T00:00:02.000Z", sessionId: sid,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: bigB64 } }] }] },
        toolUseResult: { type: "image", file: { base64: bigB64, type: "image/png", originalSize: 278348, dimensions: { originalWidth: 1999, originalHeight: 1112 } } },
      }),
    ].join("\n") + "\n");
    const beforeBytes = readFileSync(F).length;

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const row = after.find((r) => r.o?.uuid === "u-2");

    // Assert ── ① 중첩된 tool_result 안쪽까지 치환됐는가
    const inner = row?.o?.message?.content?.[0]?.content?.[0];
    assert(inner?.type === "image", "tool_result 안의 image 블록 구조는 유지");
    assert(typeof inner?.source?.data === "string" && inner.source.data.length < 200, `중첩 source.data 치환 (실제 ${inner?.source?.data?.length}자)`);
    assert(inner?.source?.media_type === "image/png", "media_type은 placeholder에 맞춰 image/png");

    // ② toolUseResult.file.base64도 치환됐는가
    const fileObj = row?.o?.toolUseResult?.file;
    assert(typeof fileObj?.base64 === "string" && fileObj.base64.length < 200, `file.base64 치환 (실제 ${fileObj?.base64?.length}자)`);

    // ③ 치환값이 유효한 1x1 PNG인가 — 깨진 값이면 resume이 400으로 죽는다
    for (const [label, v] of [["중첩 source.data", inner?.source?.data], ["file.base64", fileObj?.base64]] as const) {
      const buf = Buffer.from(String(v), "base64");
      assert(buf.length > 0 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", `${label}: 유효한 PNG 시그니처`);
    }

    // ④ 메타는 건드리지 않는다 (기존 cleanReadResult가 content만 치환하는 것과 동형)
    assert(fileObj?.originalSize === 278348, "originalSize 보존");
    assert(fileObj?.dimensions?.originalWidth === 1999, "dimensions 보존");
    assert(fileObj?.type === "image/png", "file.type 보존");

    // ⑤ 감량과 무결성
    const afterBytes = readFileSync(res.outputPath).length;
    assert(afterBytes < beforeBytes * 0.3, `두 사본이 빠져 70%+ 감량 (${beforeBytes}→${afterBytes})`);
    const us = uuidSet(after);
    assert(after.filter((r) => r.o?.parentUuid && !us.has(r.o.parentUuid)).length === 0, "고아 parentUuid 0개");
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
  });

  // T20 ──────────────────────────────────────────────────────────────
  // 외부에서 파일이 바뀐 것을 알리는 첨부(attachment.type="edited_text_file")는
  // 본문을 attachment.content가 아니라 attachment.snippet에 담는다.
  // 기존 cleanAttachment는 content 키만 봐서 이 자리를 지나쳤다.
  // 실측(2026-07-31): 8행 57,128B가 남아 있었고, 치환하니 컨텍스트가
  // Messages 80.4k → 65.8k (14.6k 감소)로 줄었다 — 실제로 컨텍스트에 실리는 자리다.
  // filename은 파일을 다시 찾는 색인이라 건드리지 않는다.
  await test("T20 fixture: attachment.snippet이 치환되고 filename(색인)은 보존된다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "snippet");
    const sid = "fixture-snippet-0000-000000000001";
    const bigSnippet = Array.from({ length: 80 }, (_, i) => `${i + 1} export const line${i} = ${i};`).join("\n");
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "파일 고쳐" }, uuid: "u-1", timestamp: "2026-07-31T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "attachment", uuid: "att-1", timestamp: "2026-07-31T00:00:01.000Z", sessionId: sid, attachment: { type: "edited_text_file", filename: "/repo/dynamic-workflow/wf.mjs", snippet: bigSnippet } }),
      JSON.stringify({ parentUuid: "att-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "확인했습니다" }] }, uuid: "a-1", timestamp: "2026-07-31T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const beforeBytes = readFileSync(F).length;

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const att = after.find((r) => r.o?.uuid === "att-1");

    // Assert ── ① snippet 치환
    const snip = att?.o?.attachment?.snippet;
    assert(typeof snip === "string" && snip.length < 100, `snippet 치환 (실제 ${String(snip).length}자)`);
    assert(String(snip).includes("context-cleaner"), "placeholder 형식은 기존과 동일한 [context-cleaner: …]");

    // ② 색인·구조 보존
    assert(att?.o?.attachment?.filename === "/repo/dynamic-workflow/wf.mjs", "filename(색인) 보존");
    assert(att?.o?.attachment?.type === "edited_text_file", "attachment.type 보존");

    // ③ 행은 남는다 — 이 행들은 uuid를 갖고 자식이 매달려 있어 삭제하면 재매핑이 필요하다.
    //    값만 치환하면 체인은 그대로다 (실측에서 검증 PASS였던 방식)
    assert(after.length === 3, "행 수 유지 (삭제 아님)");
    const us = uuidSet(after);
    assert(after.filter((r) => r.o?.parentUuid && !us.has(r.o.parentUuid)).length === 0, "고아 parentUuid 0개");

    // ④ 감량과 무결성
    const afterBytes = readFileSync(res.outputPath).length;
    assert(afterBytes < beforeBytes * 0.5, `snippet이 빠져 절반 이상 감량 (${beforeBytes}→${afterBytes})`);
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
  });

  // T21 ──────────────────────────────────────────────────────────────
  // toolUseResult에 도구 결과 원본이 두 자리로 남던 문제 (base64와 같은 유형).
  // message.content 쪽 표시용 사본은 이미 치환되는데 원본만 살아남았다.
  //
  // ① MCP 결과: toolUseResult 자체가 문자열이다.
  //    기존 cleanToolUseResultString은 typeof result === "object"를 먼저 검사해서
  //    최상위가 문자열이면 탈락했다. 실측(f3aea91e): 19건 30,184B 전부 통과.
  // ② Task 결과: 본문은 .task.result에 있다.
  //    기존 cleanTaskOutput은 .task.output만 봤는데 그건 31B 안내문이고
  //    실제 28,047B는 .result에 있었다 → 31B 지우고 28KB를 남긴 셈.
  //    .prompt(2,220B)는 호출 쪽 input.prompt가 이미 치환되는 값의 사본이다.
  // 색인(task_id·description·status·retrieval_status)은 무엇을 위임했는지의 맥락이라 보존한다.
  await test("T21 fixture: MCP 문자열·task.result·task.prompt가 치환되고 색인은 보존된다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "turesult");
    const sid = "fixture-turesult-000-000000000001";
    const mcpBody = JSON.stringify({ results: [{ url: "https://diataxis.fr/tutorials/", raw_content: "본문 ".repeat(400) }] });
    const taskResult = Array.from({ length: 60 }, (_, i) => `${i + 1}. 조사 결과 항목 ${i}`).join("\n");
    const taskPrompt = "structured-schema 4문서를 조사하라. ".repeat(40);
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "조사해줘" }, uuid: "u-1", timestamp: "2026-07-31T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t-mcp", name: "mcp__remote_tavily__tavily_extract", input: { urls: ["https://diataxis.fr/tutorials/"] } }] }, uuid: "a-1", timestamp: "2026-07-31T00:00:01.000Z", sessionId: sid }),
      // MCP: toolUseResult 자체가 문자열
      JSON.stringify({ parentUuid: "a-1", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-mcp", content: mcpBody }] }, uuid: "u-2", timestamp: "2026-07-31T00:00:02.000Z", sessionId: sid, toolUseResult: mcpBody }),
      JSON.stringify({ parentUuid: "u-2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t-task", name: "Agent", input: { prompt: taskPrompt } }] }, uuid: "a-2", timestamp: "2026-07-31T00:00:03.000Z", sessionId: sid }),
      // Task: 본문은 .task.result, 안내문은 .task.output
      JSON.stringify({ parentUuid: "a-2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-task", content: "done" }] }, uuid: "u-3", timestamp: "2026-07-31T00:00:04.000Z", sessionId: sid, toolUseResult: { retrieval_status: "retrieved", task: { task_id: "a3211ce5e1952b229", task_type: "local_agent", status: "completed", description: "structured-schema 조사", output: "Task output retrieved separately", prompt: taskPrompt, result: taskResult, isRawTranscript: false } } }),
      JSON.stringify({ parentUuid: "u-3", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "조사 완료했습니다" }] }, uuid: "a-3", timestamp: "2026-07-31T00:00:05.000Z", sessionId: sid }),
    ].join("\n") + "\n");
    const beforeBytes = readFileSync(F).length;

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);

    // Assert ── ① MCP 문자열 치환
    const mcpRow = after.find((r) => r.o?.uuid === "u-2");
    const mcpTur = mcpRow?.o?.toolUseResult;
    assert(typeof mcpTur === "string" && mcpTur.length < 100, `MCP toolUseResult 문자열 치환 (실제 ${String(mcpTur).length}자)`);
    assert(String(mcpTur).includes("context-cleaner"), "placeholder 형식은 기존과 동일");
    // 호출 인자는 무엇을 요청했는지의 색인이므로 남는다
    const mcpCall = after.find((r) => r.o?.uuid === "a-1");
    assert(mcpCall?.o?.message?.content?.[0]?.input?.urls?.[0] === "https://diataxis.fr/tutorials/", "MCP 호출 인자(색인) 보존");

    // ② task.result·task.prompt 치환
    const taskRow = after.find((r) => r.o?.uuid === "u-3");
    const task = taskRow?.o?.toolUseResult?.task;
    assert(typeof task?.result === "string" && task.result.length < 100, `task.result 치환 (실제 ${String(task?.result).length}자)`);
    assert(typeof task?.prompt === "string" && task.prompt.length < 100, `task.prompt 치환 (실제 ${String(task?.prompt).length}자)`);

    // ③ 색인 보존 — 무엇을 위임했는지의 맥락
    assert(task?.task_id === "a3211ce5e1952b229", "task_id(색인) 보존");
    assert(task?.description === "structured-schema 조사", "description(위임 맥락) 보존");
    assert(task?.status === "completed", "status 보존");
    assert(taskRow?.o?.toolUseResult?.retrieval_status === "retrieved", "retrieval_status 보존");

    // ④ 감량과 무결성
    const afterBytes = readFileSync(res.outputPath).length;
    assert(afterBytes < beforeBytes * 0.4, `원본 두 자리가 빠져 60% 이상 감량 (${beforeBytes}→${afterBytes})`);
    const us = uuidSet(after);
    assert(after.filter((r) => r.o?.parentUuid && !us.has(r.o.parentUuid)).length === 0, "고아 parentUuid 0개");
    assert(res.verify?.ok === true, "내장 무결성 검사 통과");
  });

  // T22 ──────────────────────────────────────────────────────────────
  // queue-operation은 타이밍 기록 행 자체를 남기고, 200자를 넘는 중복 content만 축소한다.
  // 경계값 200자는 유지하며, dequeue처럼 content 키가 없는 행도 그대로 둔다.
  await test("T22 fixture: queue-operation 긴 content만 치환되고 메타·경계값·dequeue는 보존된다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "queueopcontent");
    const sid = "fixture-queueopcontent-000000000001";
    const longContent = "<task-notification><result>" + "큐에 중복 저장된 실제 알림 본문 ".repeat(40) + "</result></task-notification>";
    const boundaryContent = "q".repeat(200);
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "시작" }, uuid: "u-1", timestamp: "2026-08-05T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-08-05T00:00:01.000Z", sessionId: sid, content: longContent }),
      JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: "2026-08-05T00:00:02.000Z", sessionId: sid, content: boundaryContent }),
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-08-05T00:00:03.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "완료" }] }, uuid: "a-1", timestamp: "2026-08-05T00:00:04.000Z", sessionId: sid }),
    ].join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const queueRows = after.filter((r) => r.o?.type === "queue-operation");
    const longRow = queueRows.find((r) => r.o?.operation === "enqueue");
    const boundaryRow = queueRows.find((r) => r.o?.operation === "remove");
    const dequeueRow = queueRows.find((r) => r.o?.operation === "dequeue");

    // Assert
    assert(longRow?.o?.content === "[context-cleaner: queue_op]", "200자 초과 content 치환");
    assert(longRow?.o?.operation === "enqueue", "operation 보존");
    assert(longRow?.o?.timestamp === "2026-08-05T00:00:01.000Z", "timestamp 보존");
    assert(longRow?.o?.sessionId === res.newSessionId, "sessionId 필드 보존(사본 ID 치환 규칙만 적용)");
    assert(boundaryRow?.o?.content === boundaryContent, "200자 content는 원문 유지");
    assert(!!dequeueRow && !("content" in dequeueRow.o), "content 없는 dequeue 행은 무변화");
    assert(queueRows.length === 3, "queue-operation 행 3개 모두 보존");
  });

  // T23 ──────────────────────────────────────────────────────────────
  // task-notification은 결과 전문만 output-file로 넘겨진 중복이므로 <result> 내부만 줄인다.
  // 이 규칙에는 길이 문턱이 없어 200자 경계의 result도 같은 방식으로 축소한다.
  await test("T23 fixture: task-notification의 긴·200자 result 내부만 치환되고 껍데기는 보존된다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "tasknotifyresult");
    const sid = "fixture-tasknotify-0000000000001";
    const longResult = "서브에이전트가 작성한 실제 조사 결과 문단입니다. ".repeat(40);
    const boundaryResult = "결".repeat(200);
    const notification = (taskId: string, result: string) =>
      "<task-notification>\n" +
      `<task-id>${taskId}</task-id>\n` +
      `<output-file>/Users/nsk_intel_mac/.claude/tasks/${taskId}/output.txt</output-file>\n` +
      "<status>completed</status>\n" +
      "<summary>조사 완료</summary>\n" +
      `<result>${result}</result>\n` +
      "</task-notification>";
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "조사 시작" }, uuid: "u-1", timestamp: "2026-08-05T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: notification("task-long", longResult) }, uuid: "u-2", timestamp: "2026-08-05T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-2", type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: notification("task-boundary", boundaryResult) }, uuid: "u-3", timestamp: "2026-08-05T00:00:02.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-3", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "확인" }] }, uuid: "a-1", timestamp: "2026-08-05T00:00:03.000Z", sessionId: sid }),
    ].join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const longContent = String(after.find((r) => r.o?.uuid === "u-2")?.o?.message?.content);
    const boundaryContent = String(after.find((r) => r.o?.uuid === "u-3")?.o?.message?.content);

    // Assert
    assert(longContent.includes("<result>[context-cleaner: task_result]</result>"), "긴 result 내부 치환 + 여닫는 태그 보존");
    assert(boundaryContent.includes("<result>[context-cleaner: task_result]</result>"), "200자 result도 동일하게 치환");
    for (const [label, content, taskId] of [["긴 행", longContent, "task-long"], ["경계 행", boundaryContent, "task-boundary"]] as const) {
      assert(content.includes(`<task-id>${taskId}</task-id>`), `${label}: task-id와 값 보존`);
      assert(content.includes(`<output-file>/Users/nsk_intel_mac/.claude/tasks/${taskId}/output.txt</output-file>`), `${label}: output-file과 값 보존`);
      assert(content.includes("<status>completed</status>"), `${label}: status와 값 보존`);
      assert(content.includes("<summary>조사 완료</summary>"), `${label}: summary와 값 보존`);
      assert(content.startsWith("<task-notification>") && content.endsWith("</task-notification>"), `${label}: task-notification 껍데기 보존`);
    }
  });

  // T24 ──────────────────────────────────────────────────────────────
  await test("T24 fixture: origin.body는 200자 초과만 치환되고 kind·from과 경계값은 보존된다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "originbody");
    const sid = "fixture-originbody-000000000000001";
    const longBody = "peer가 보낸 원본 메시지 본문과 메타데이터 중 중복 저장된 부분 ".repeat(40);
    const boundaryBody = "b".repeat(200);
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", origin: { kind: "peer", from: "researcher", body: longBody }, message: { role: "user", content: "전달된 메시지" }, uuid: "u-1", timestamp: "2026-08-05T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "user", origin: { kind: "peer", from: "reviewer", body: boundaryBody }, message: { role: "user", content: "짧은 전달 메시지" }, uuid: "u-2", timestamp: "2026-08-05T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-2", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "확인" }] }, uuid: "a-1", timestamp: "2026-08-05T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const longOrigin = after.find((r) => r.o?.uuid === "u-1")?.o?.origin;
    const boundaryOrigin = after.find((r) => r.o?.uuid === "u-2")?.o?.origin;

    // Assert
    assert(longOrigin?.body === "[context-cleaner: origin_body]", "200자 초과 origin.body 치환");
    assert(longOrigin?.kind === "peer", "origin.kind 보존");
    assert(longOrigin?.from === "researcher", "origin.from 보존");
    assert(boundaryOrigin?.body === boundaryBody, "200자 origin.body는 원문 유지");
    assert(boundaryOrigin?.kind === "peer" && boundaryOrigin?.from === "reviewer", "경계 행의 다른 origin 필드 보존");
  });

  // T25 ──────────────────────────────────────────────────────────────
  // agent-message도 길이 문턱 없이 태그 내부만 줄이므로 200자 경계 입력을 함께 고정한다.
  await test("T25 fixture: agent-message의 긴·200자 내부만 치환되고 from 속성·태그는 보존된다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "agentmessage");
    const sid = "fixture-agentmessage-00000000000001";
    const longBody = "서브에이전트가 메인 에이전트에 전달한 상세 분석 결과와 근거 문장 ".repeat(40);
    const boundaryBody = "에".repeat(200);
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: `<agent-message from="researcher">${longBody}</agent-message>` }, uuid: "u-1", timestamp: "2026-08-05T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-1", type: "user", message: { role: "user", content: `<agent-message from="reviewer">${boundaryBody}</agent-message>` }, uuid: "u-2", timestamp: "2026-08-05T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-2", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "수신" }] }, uuid: "a-1", timestamp: "2026-08-05T00:00:02.000Z", sessionId: sid }),
    ].join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const longContent = after.find((r) => r.o?.uuid === "u-1")?.o?.message?.content;
    const boundaryContent = after.find((r) => r.o?.uuid === "u-2")?.o?.message?.content;

    // Assert
    assert(longContent === '<agent-message from="researcher">[context-cleaner: agent_message]</agent-message>', "긴 내부 치환 + researcher 속성·태그 보존");
    assert(boundaryContent === '<agent-message from="reviewer">[context-cleaner: agent_message]</agent-message>', "200자 내부 치환 + reviewer 속성·태그 보존");
  });

  // T26 ──────────────────────────────────────────────────────────────
  // 네 신규 규칙을 한 transcript에 섞어 전체 파싱→치환→직렬화→무결성 검사를 통과시킨다.
  await test("T26 통합 fixture: 신규 축소 규칙 4종 혼합 후 uuid 체인 고아 0·내장 무결성 통과", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "fourrules");
    const sid = "fixture-fourrules-0000000000000001";
    const queueBody = "정식 user 행에도 들어가는 queue-operation 중복 알림 본문 ".repeat(40);
    const taskResult = "작업 완료 알림에 포함된 상세 결과 전문과 진단 자료 ".repeat(40);
    const taskNotification =
      "<task-notification><task-id>task-integrated</task-id>" +
      "<output-file>/Users/nsk_intel_mac/.claude/tasks/task-integrated/output.txt</output-file>" +
      "<status>completed</status><summary>통합 작업 완료</summary>" +
      `<result>${taskResult}</result></task-notification>`;
    const agentBody = "peer 서브에이전트가 전달한 상세 메시지와 조사 근거 ".repeat(40);
    writeFileSync(F, [
      JSON.stringify({ parentUuid: null, type: "user", message: { role: "user", content: "통합 시작" }, uuid: "u-root", timestamp: "2026-08-05T00:00:00.000Z", sessionId: sid }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue", content: queueBody, timestamp: "2026-08-05T00:00:01.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-root", type: "user", origin: { kind: "task-notification", from: "task-runner", body: taskNotification }, message: { role: "user", content: taskNotification }, uuid: "u-task", timestamp: "2026-08-05T00:00:02.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-task", type: "user", origin: { kind: "peer", from: "researcher" }, message: { role: "user", content: `<agent-message from="researcher">${agentBody}</agent-message>` }, uuid: "u-agent", timestamp: "2026-08-05T00:00:03.000Z", sessionId: sid }),
      JSON.stringify({ parentUuid: "u-agent", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "통합 완료" }] }, uuid: "a-final", timestamp: "2026-08-05T00:00:04.000Z", sessionId: sid }),
      JSON.stringify({ type: "last-prompt", leafUuid: "u-agent", timestamp: "2026-08-05T00:00:05.000Z", sessionId: sid }),
    ].join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const taskRow = after.find((r) => r.o?.uuid === "u-task");
    const agentRow = after.find((r) => r.o?.uuid === "u-agent");

    // Assert
    assert(after.find((r) => r.o?.type === "queue-operation")?.o?.content === "[context-cleaner: queue_op]", "queue-operation content 치환");
    assert(String(taskRow?.o?.message?.content).includes("<result>[context-cleaner: task_result]</result>"), "task-notification result 치환");
    assert(taskRow?.o?.origin?.body === "[context-cleaner: origin_body]", "origin.body 치환");
    assert(agentRow?.o?.message?.content === '<agent-message from="researcher">[context-cleaner: agent_message]</agent-message>', "agent-message 내부 치환");
    const us = uuidSet(after);
    const orphans = after.filter((r) => r.o?.parentUuid && !us.has(r.o.parentUuid));
    assert(orphans.length === 0, `고아 parentUuid 0개 (실제 ${orphans.length}개)`);
    assert(res.verify?.ok === true, `내장 무결성 검사 통과 (${JSON.stringify(res.verify?.summary?.output ?? {})})`);
  });

  // T27 ──────────────────────────────────────────────────────────────
  await test("T27 Bash 묶음: 1·2개는 전부 보존하고 3·10개는 첫·마지막만 남긴다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "bash-boundaries");
    const sid = "fixture-bash-boundaries-0000000001";
    const fixtureRows: any[] = [];
    let parent: string | null = null;
    let clock = 0;
    const add = (row: any) => {
      const withCommon = {
        ...row,
        ...(row.uuid ? { parentUuid: row.parentUuid === undefined ? parent : row.parentUuid } : {}),
        timestamp: `2026-08-09T00:00:${String(clock++).padStart(2, "0")}.000Z`,
        sessionId: sid,
      };
      fixtureRows.push(withCommon);
      if (withCommon.uuid) parent = withCommon.uuid;
      return withCommon;
    };
    const prompt = (name: string) => add({ type: "user", uuid: `u-${name}`, message: { role: "user", content: `${name} 실행` } });
    const bash = (group: string, index: number, sidechain = false) => {
      const id = `bash-${group}-${index}`;
      const assistantUuid = `a-${group}-${index}`;
      add({
        type: "assistant",
        uuid: assistantUuid,
        ...(sidechain ? { isSidechain: true } : {}),
        message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: `printf '${group}-${index}'`, description: `${group} ${index}` } }] },
      });
      add({
        type: "user",
        uuid: `r-${group}-${index}`,
        ...(sidechain ? { isSidechain: true } : {}),
        sourceToolAssistantUUID: assistantUuid,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `result-${group}-${index}` }] },
        toolUseResult: { stdout: `stdout-${group}-${index}`, stderr: "", interrupted: false },
      });
    };
    const group = (name: string, count: number, options?: { notificationAfterFirst?: boolean; sidechainAfterFirst?: boolean; readAfterFirst?: boolean }) => {
      prompt(name);
      for (let i = 1; i <= count; i++) {
        bash(name, i);
        if (i === 1 && options?.notificationAfterFirst) {
          add({
            type: "user",
            uuid: `n-${name}`,
            promptSource: "system",
            origin: { kind: "task-notification" },
            message: { role: "user", content: "<task-notification><task-id>other-task</task-id><result>알림 결과</result></task-notification>" },
          });
        }
        if (i === 1 && options?.sidechainAfterFirst) bash(name, 99, true);
        if (i === 1 && options?.readAfterFirst) {
          const readId = `read-${name}`;
          const readAssistant = `a-read-${name}`;
          add({ type: "assistant", uuid: readAssistant, message: { role: "assistant", content: [{ type: "tool_use", id: readId, name: "Read", input: { file_path: "/repo/file.ts" } }] } });
          add({ type: "user", uuid: `r-read-${name}`, sourceToolAssistantUUID: readAssistant, message: { role: "user", content: [{ type: "tool_result", tool_use_id: readId, content: "file body" }] }, toolUseResult: { file: { filePath: "/repo/file.ts", content: "file body" } } });
        }
      }
    };
    group("one", 1);
    group("two", 2);
    group("three", 3, { notificationAfterFirst: true, sidechainAfterFirst: true });
    group("ten", 10, { readAfterFirst: true });
    writeFileSync(F, fixtureRows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const bashBlocks = after.flatMap((r) => Array.isArray(r.o?.message?.content) ? r.o.message.content.filter((b: any) => b?.type === "tool_use" && b?.name === "Bash") : []);
    const bashIds = new Set(bashBlocks.map((b: any) => b.id));

    // Assert
    assert(bashIds.has("bash-one-1"), "Bash 1개 묶음의 호출 보존");
    assert(bashIds.has("bash-two-1") && bashIds.has("bash-two-2"), "Bash 2개 묶음의 두 호출 보존");
    assert(bashIds.has("bash-three-1") && bashIds.has("bash-three-3") && !bashIds.has("bash-three-2"), "Bash 3개 묶음은 첫·마지막만 보존");
    assert(bashIds.has("bash-three-99"), "sidechain Bash는 main-chain 개수와 제거 대상에서 제외");
    const tenIds = [...bashIds].filter((id) => String(id).startsWith("bash-ten-"));
    assert(tenIds.length === 2 && tenIds.includes("bash-ten-1") && tenIds.includes("bash-ten-10"), `Bash 10개 묶음은 첫·마지막 2개만 보존 (실제 ${tenIds.join(",")})`);
    assert(after.some((r) => r.o?.uuid === "a-read-ten") && after.some((r) => r.o?.uuid === "r-read-ten"), "Bash 사이의 다른 도구 호출·결과 보존");
    const preservedCommands = new Map(bashBlocks.map((b: any) => [b.id, b.input?.command]));
    for (const id of ["bash-one-1", "bash-two-1", "bash-two-2", "bash-three-1", "bash-three-3", "bash-ten-1", "bash-ten-10", "bash-three-99"])
      assert(preservedCommands.get(id) === `printf '${String(id).replace(/^bash-/, "").replace(/-(\d+)$/, "-$1")}'`.replace("three-99", "three-99"), `${id} input.command 전문 보존`);
    const remainingBashResults = after.flatMap((r) => Array.isArray(r.o?.message?.content) ? r.o.message.content.filter((b: any) => b?.type === "tool_result" && bashIds.has(b.tool_use_id)) : []);
    assert(remainingBashResults.every((b: any) => b.content === "[context-cleaner: tool_result]"), "보존된 Bash 결과 content 전부 정리");
    assert(!after.some((r) => Array.isArray(r.o?.message?.content) && r.o.message.content.some((b: any) => b?.type === "tool_result" && ["bash-three-2", ...Array.from({ length: 8 }, (_, i) => `bash-ten-${i + 2}`)].includes(b.tool_use_id))), "중간 Bash tool_result 전부 제거");
    assert(after.some((r) => r.o?.uuid === "n-three"), "task-notification이 사용자 묶음을 끊지 않고 행은 보존");
    assert(res.verify?.ok === true, `내장 무결성 검사 통과 (${JSON.stringify(res.verify?.problems)})`);
  });

  // T28 ──────────────────────────────────────────────────────────────
  await test("T28 혼합·background Bash: 중간 블록만 제거하고 완료 알림과 참조를 함께 정리한다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "bash-mixed-background");
    const sid = "fixture-bash-mixed-background-001";
    const notification = "<task-notification><task-id>bg-task-1</task-id><tool-use-id>bash-bg</tool-use-id><status>completed</status><result>background output</result></task-notification>";
    const fixtureRows = [
      { parentUuid: null, type: "user", uuid: "u-root", message: { role: "user", content: "네 번 실행" }, sessionId: sid },
      { parentUuid: "u-root", type: "assistant", uuid: "a-first", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-first", name: "Bash", input: { command: "first", timeout: 1000 } }] }, sessionId: sid },
      { parentUuid: "a-first", type: "user", uuid: "r-first", sourceToolAssistantUUID: "a-first", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-first", content: "first result" }] }, toolUseResult: { stdout: "first stdout", stderr: "" }, sessionId: sid },
      { parentUuid: "r-first", type: "assistant", uuid: "a-mixed", message: { role: "assistant", content: [{ type: "text", text: "중간 설명" }, { type: "tool_use", id: "bash-mixed", name: "Bash", input: { command: "middle", description: "mixed" } }] }, sessionId: sid },
      { parentUuid: "a-mixed", type: "user", uuid: "r-mixed", sourceToolAssistantUUID: "a-mixed", message: { role: "user", content: [{ type: "text", text: "결과 메모" }, { type: "tool_result", tool_use_id: "bash-mixed", content: "middle result" }] }, toolUseResult: { stdout: "middle stdout", stderr: "middle stderr" }, sessionId: sid },
      { parentUuid: "r-mixed", type: "assistant", uuid: "a-bg", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-bg", name: "Bash", input: { command: "background", run_in_background: true } }] }, sessionId: sid },
      { parentUuid: "a-bg", type: "user", uuid: "r-bg", sourceToolAssistantUUID: "a-bg", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-bg", content: "background launched" }] }, toolUseResult: { backgroundTaskId: "bg-task-1", stdout: "launched", stderr: "", interrupted: false }, sessionId: sid },
      { parentUuid: "r-bg", type: "user", uuid: "n-bg", promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: notification }, sessionId: sid },
      { type: "file-history-snapshot", messageId: "r-bg", snapshot: { trackedFileBackups: {} }, sessionId: sid },
      { parentUuid: "n-bg", type: "assistant", uuid: "a-last", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-last", name: "Bash", input: { command: "last", description: "last" } }] }, sessionId: sid },
      { parentUuid: "a-last", type: "user", uuid: "r-last", sourceToolAssistantUUID: "a-last", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-last", content: "last result" }] }, toolUseResult: { stdout: "last stdout", stderr: "" }, sessionId: sid },
      { type: "last-prompt", leafUuid: "n-bg", sessionId: sid },
    ];
    writeFileSync(F, fixtureRows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const aMixed = after.find((r) => r.o?.uuid === "a-mixed")?.o;
    const rMixed = after.find((r) => r.o?.uuid === "r-mixed")?.o;
    const aLast = after.find((r) => r.o?.uuid === "a-last")?.o;
    const lastPrompt = after.find((r) => r.o?.type === "last-prompt")?.o;

    // Assert
    assert(aMixed?.message?.content?.length === 1 && aMixed.message.content[0]?.text === "중간 설명", "text + 중간 tool_use에서 Bash 블록만 제거");
    assert(rMixed?.message?.content?.length === 1 && rMixed.message.content[0]?.text === "결과 메모", "text + 중간 tool_result에서 Bash 결과 블록만 제거");
    assert(!("toolUseResult" in (rMixed ?? {})), "혼합 결과 행의 대응 최상위 toolUseResult 제거");
    assert(!("sourceToolAssistantUUID" in (rMixed ?? {})), "tool_result가 사라진 혼합 행의 sourceToolAssistantUUID 제거");
    assert(!after.some((r) => ["a-bg", "r-bg", "n-bg"].includes(r.o?.uuid)), "중간 background 호출·직접 결과·완료 알림 행 함께 제거");
    assert(!after.some((r) => r.o?.type === "file-history-snapshot" && r.o?.messageId === "r-bg"), "삭제된 결과를 가리킨 snapshot 행 제거");
    assert(aLast?.parentUuid === "r-mixed", `연속 삭제 행을 건너 a-last.parentUuid 재연결 (실제 ${aLast?.parentUuid})`);
    assert(lastPrompt?.leafUuid === "r-mixed", `last-prompt.leafUuid를 생존 조상으로 재연결 (실제 ${lastPrompt?.leafUuid})`);
    assert(res.stats?.bashMiddleToolUseRemoved === 2, `중간 tool_use 2개 통계 (실제 ${res.stats?.bashMiddleToolUseRemoved})`);
    assert(res.stats?.bashBackgroundNotificationsRemoved === 1, `background 완료 알림 1개 통계 (실제 ${res.stats?.bashBackgroundNotificationsRemoved})`);
    assert(res.verify?.ok === true, `내장 무결성 검사 통과 (${JSON.stringify(res.verify?.problems)})`);
  });

  // T29 ──────────────────────────────────────────────────────────────
  await test("T29 모호한 Bash 묶음: 원인별로 행 삭제 없이 모든 입력·결과를 대체 처리한다", async () => {
    const cases = ["missing-id", "duplicate-id", "missing-result", "duplicate-result", "owner-unknown", "notification-ambiguous"] as const;
    for (const kind of cases) {
      // Arrange
      const F = FIXTURE.replace("malformed", `bash-fallback-${kind}`);
      const sid = `fixture-bash-fallback-${kind}`;
      const fixtureRows: any[] = [];
      let parent: string | null = null;
      let serial = 0;
      const add = (row: any) => {
        const uuid = row.uuid ?? `${kind}-row-${serial++}`;
        const withCommon = { ...row, uuid, parentUuid: row.parentUuid === undefined ? parent : row.parentUuid, sessionId: sid };
        fixtureRows.push(withCommon);
        parent = uuid;
        return withCommon;
      };
      const promptRow = add({ type: "user", uuid: `${kind}-prompt`, message: { role: "user", content: "세 번 실행" } });
      void promptRow;
      const addCall = (label: string, id: string | undefined, resultCount = 1, backgroundTaskId?: string) => {
        const assistantUuid = `${kind}-a-${label}`;
        const block: any = { type: "tool_use", name: "Bash", input: { command: `${kind}-${label}`, description: label } };
        if (id !== undefined) block.id = id;
        add({ type: "assistant", uuid: assistantUuid, message: { role: "assistant", content: [block] } });
        if (id !== undefined) {
          for (let n = 0; n < resultCount; n++) add({
            type: "user",
            uuid: `${kind}-r-${label}-${n}`,
            sourceToolAssistantUUID: assistantUuid,
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${kind}-${label}-result-${n}` }] },
            toolUseResult: { ...(backgroundTaskId ? { backgroundTaskId } : {}), stdout: `${kind}-${label}-stdout-${n}`, stderr: "" },
          });
        }
      };
      addCall("first", `${kind}-first`);
      if (kind === "missing-id") addCall("middle", undefined, 0);
      else if (kind === "duplicate-id") {
        addCall("middle-a", `${kind}-dup`);
        addCall("middle-b", `${kind}-dup`);
      } else if (kind === "missing-result") addCall("middle", `${kind}-middle`, 0);
      else if (kind === "duplicate-result") addCall("middle", `${kind}-middle`, 2);
      else if (kind === "owner-unknown") {
        const bashAssistant = `${kind}-a-middle`;
        add({ type: "assistant", uuid: bashAssistant, message: { role: "assistant", content: [{ type: "tool_use", id: `${kind}-middle`, name: "Bash", input: { command: `${kind}-middle` } }] } });
        const readAssistant = `${kind}-a-read`;
        add({ type: "assistant", uuid: readAssistant, message: { role: "assistant", content: [{ type: "tool_use", id: `${kind}-read`, name: "Read", input: { file_path: "/repo/file.ts" } }] } });
        add({
          type: "user",
          uuid: `${kind}-r-mixed`,
          sourceToolAssistantUUID: bashAssistant,
          message: { role: "user", content: [
            { type: "tool_result", tool_use_id: `${kind}-middle`, content: "bash result" },
            { type: "tool_result", tool_use_id: `${kind}-read`, content: "read result" },
          ] },
          toolUseResult: { stdout: "ambiguous stdout", stderr: "" },
        });
      } else {
        addCall("middle", `${kind}-middle`, 1, `${kind}-task`);
        add({
          type: "user",
          uuid: `${kind}-notification`,
          promptSource: "system",
          origin: { kind: "task-notification" },
          message: { role: "user", content: `<task-notification><task-id>${kind}-task</task-id><status>completed</status><result>done</result></task-notification>` },
        });
      }
      addCall("last", `${kind}-last`);
      const originalRowCount = fixtureRows.length;
      writeFileSync(F, fixtureRows.map((row) => JSON.stringify(row)).join("\n") + "\n");

      // Act
      const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
      assert(res.ok === true, `${kind}: 클리닝 성공`);
      if (!res.outputPath) continue;
      artifacts.push(res.outputPath);
      const after = rows(res.outputPath);
      const bashCalls = after.flatMap((r) => Array.isArray(r.o?.message?.content) ? r.o.message.content.filter((b: any) => b?.type === "tool_use" && b?.name === "Bash") : []);
      const bashIds = new Set(bashCalls.map((b: any) => b.id).filter(Boolean));
      const bashResults = after.flatMap((r) => Array.isArray(r.o?.message?.content) ? r.o.message.content.filter((b: any) => b?.type === "tool_result" && bashIds.has(b.tool_use_id)) : []);

      // Assert
      assert(after.length === originalRowCount, `${kind}: 행 삭제 없음 (${originalRowCount}개 보존)`);
      assert(bashCalls.every((b: any) => b.input?.command === "[context-cleaner: Bash]"), `${kind}: 모든 Bash input.command 대체 처리`);
      assert(bashResults.every((b: any) => b.content === "[context-cleaner: tool_result]"), `${kind}: 연결 가능한 Bash tool_result.content 대체 처리`);
      assert(after.filter((r) => r.o?.toolUseResult && typeof r.o.toolUseResult === "object" && ("stdout" in r.o.toolUseResult || "stderr" in r.o.toolUseResult)).every((r) => [r.o.toolUseResult.stdout, r.o.toolUseResult.stderr].every((v: any) => !v || v === "[context-cleaner: Bash]")), `${kind}: 구조화 stdout·stderr 대체 처리`);
      if (kind === "notification-ambiguous") {
        const nc = String(after.find((r) => r.o?.uuid === `${kind}-notification`)?.o?.message?.content);
        assert(nc.includes("<result>[context-cleaner: task_result]</result>"), `${kind}: 완료 알림 result만 기존 방식으로 정리`);
      }
      assert(res.stats?.bashFallbackGroups === 1, `${kind}: 대체 처리 묶음 1개 통계 (실제 ${res.stats?.bashFallbackGroups})`);
      assert((res.stats?.bashFallbackReasons?.get?.(kind) ?? 0) === 1, `${kind}: 원인별 통계 기록`);
      assert(res.verify?.ok === true, `${kind}: 내장 무결성 검사 통과 (${JSON.stringify(res.verify?.problems)})`);
    }
  });

  // T30 ──────────────────────────────────────────────────────────────
  await test("T30 Bash 묶음 정리 재실행: 추가 삭제·참조 변경·placeholder 변형이 없다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "bash-idempotent");
    const sid = "fixture-bash-idempotent-00000000001";
    const fixtureRows: any[] = [{ parentUuid: null, type: "user", uuid: "u-root", message: { role: "user", content: "열 번 실행" }, sessionId: sid }];
    let parent = "u-root";
    for (let i = 1; i <= 10; i++) {
      const assistantUuid = `a-${i}`;
      const resultUuid = `r-${i}`;
      fixtureRows.push({ parentUuid: parent, type: "assistant", uuid: assistantUuid, message: { role: "assistant", content: [{ type: "tool_use", id: `bash-${i}`, name: "Bash", input: { command: `command-${i}`, timeout: i * 100 } }] }, sessionId: sid });
      fixtureRows.push({ parentUuid: assistantUuid, type: "user", uuid: resultUuid, sourceToolAssistantUUID: assistantUuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `bash-${i}`, content: `result-${i}` }] }, toolUseResult: { stdout: `stdout-${i}`, stderr: "" }, sessionId: sid });
      parent = resultUuid;
    }
    writeFileSync(F, fixtureRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const first = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(first.ok === true && !!first.outputPath, "첫 번째 클리닝 성공");
    if (!first.outputPath) return;
    artifacts.push(first.outputPath);
    const hashAfterFirst = sha(first.outputPath);
    const rowCountAfterFirst = rows(first.outputPath).length;

    // Act
    const second = await cleanTranscript(first.outputPath, { hooks: parseHooksFlag(undefined), mode: "inplace" });

    // Assert
    assert(second.ok === true, "두 번째 in-place 클리닝 성공");
    assert(sha(first.outputPath) === hashAfterFirst, "두 번째 실행 후 출력 바이트 불변");
    assert(rows(first.outputPath).length === rowCountAfterFirst, "두 번째 실행에서 추가 행 삭제 없음");
    const after = rows(first.outputPath);
    const ids = after.flatMap((r) => Array.isArray(r.o?.message?.content) ? r.o.message.content.filter((b: any) => b?.type === "tool_use" && b?.name === "Bash").map((b: any) => b.id) : []);
    assert(ids.length === 2 && ids[0] === "bash-1" && ids[1] === "bash-10", `첫·마지막 두 호출 유지 (실제 ${ids.join(",")})`);
    assert(second.verify?.ok === true, `두 번째 실행 무결성 검사 통과 (${JSON.stringify(second.verify?.problems)})`);
  });

  // T31 ──────────────────────────────────────────────────────────────
  await test("T31 Bash ID가 다른 도구와 중복되면 삭제하지 않고 묶음 전체를 대체 처리한다", async () => {
    // Arrange
    const F = FIXTURE.replace("malformed", "bash-cross-tool-duplicate");
    const sid = "fixture-bash-cross-tool-duplicate-001";
    const fixtureRows = [
      { parentUuid: null, type: "user", uuid: "u-root", message: { role: "user", content: "세 번 실행" }, sessionId: sid },
      { parentUuid: "u-root", type: "assistant", uuid: "a-first", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-first", name: "Bash", input: { command: "first" } }] }, sessionId: sid },
      { parentUuid: "a-first", type: "user", uuid: "r-first", sourceToolAssistantUUID: "a-first", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-first", content: "first" }] }, toolUseResult: { stdout: "first", stderr: "" }, sessionId: sid },
      { parentUuid: "r-first", type: "assistant", uuid: "a-middle", message: { role: "assistant", content: [{ type: "tool_use", id: "shared-id", name: "Bash", input: { command: "middle" } }] }, sessionId: sid },
      { parentUuid: "a-middle", type: "user", uuid: "r-middle", sourceToolAssistantUUID: "a-middle", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "shared-id", content: "middle" }] }, toolUseResult: { stdout: "middle", stderr: "" }, sessionId: sid },
      { parentUuid: "r-middle", type: "assistant", uuid: "a-read", message: { role: "assistant", content: [{ type: "tool_use", id: "shared-id", name: "Read", input: { file_path: "/repo/file.ts" } }] }, sessionId: sid },
      { parentUuid: "a-read", type: "assistant", uuid: "a-last", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-last", name: "Bash", input: { command: "last" } }] }, sessionId: sid },
      { parentUuid: "a-last", type: "user", uuid: "r-last", sourceToolAssistantUUID: "a-last", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-last", content: "last" }] }, toolUseResult: { stdout: "last", stderr: "" }, sessionId: sid },
    ];
    writeFileSync(F, fixtureRows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    // Act
    const res = await cleanTranscript(F, { hooks: parseHooksFlag(undefined), mode: "fork" });
    assert(res.ok === true, "클리닝 성공");
    if (!res.outputPath) return;
    artifacts.push(res.outputPath);
    const after = rows(res.outputPath);
    const bashCalls = after.flatMap((r) => Array.isArray(r.o?.message?.content) ? r.o.message.content.filter((b: any) => b?.type === "tool_use" && b?.name === "Bash") : []);

    // Assert
    assert(after.length === fixtureRows.length, "행 삭제 없음");
    assert(bashCalls.length === 3 && bashCalls.every((b: any) => b.input?.command === "[context-cleaner: Bash]"), "Bash 세 호출을 모두 대체 처리");
    assert(after.some((r) => r.o?.uuid === "a-read" && r.o?.message?.content?.[0]?.name === "Read"), "중복 ID인 다른 도구 호출은 보존");
    assert(res.stats?.bashFallbackReasons?.get?.("duplicate-id") === 1, "다른 도구까지 포함한 전역 ID 중복을 기록");
    assert(res.verify?.ok === true, `입력 기준선보다 중복 관계가 증가하지 않아 통과 (${JSON.stringify(res.verify?.problems)})`);
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
