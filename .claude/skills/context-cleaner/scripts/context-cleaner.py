#!/usr/bin/env python3
"""
Context Cleaner v2 - Claude Code 세션 파일 최적화 도구

목적: "상세 변경내역은 몰라도, 흐름은 기억나도록"
- thinking block, toolUseResult, 파일 전체경로 삭제
- 대화 기록, 편집 의도, 파일명은 보존
- session compact보다 토큰 효율과 맥락 기억이 좋음

원본 파일을 보존하고, 00effaced{NNN} suffix로 새 파일 생성.

[삭제 대상 요약]
==================

| 도구/패턴 | 삭제 필드 |
|-----------|-----------|
| Thinking | message.content[0].thinking |
| Read | toolUseResult.file.content, filePath→파일명만 |
| Write | input.content, toolUseResult.content/originalFile, filePath→파일명만 |
| Edit | input.old_string/new_string, toolUseResult.oldString/newString/originalFile, filePath→파일명만 |
| Bash | input.command, toolUseResult.stdout/stderr |
| Grep/Glob | toolUseResult.filenames → [""] |
| ExitPlanMode | input.plan |
| tool_result | message.content[0].content |
| hook_progress | 줄 전체 삭제 (parentUuid 연결 유지) |
| bash-stdout/stderr | <bash-stdout>...</bash-stdout><bash-stderr>...</bash-stderr> 패턴 |
| user-marked | <clean>...</clean> 패턴 |
| isMeta | Skill 결과 등 isMeta 메시지의 content[0].text |
| local-cmd-output | bash-input 메시지의 자식 메시지 (로컬 커맨드 출력) |

[파일명 규칙]
- 마지막 12자리를 '00effaced{NNN}'으로 교체
- 00effaced = "effaced"(지워진) + 접두어 00
- 예: 9c4c1a42-...-239d2e110282.jsonl → 9c4c1a42-...-00effaced001.jsonl
- 재실행 시 숫자 증가: 001 → 002 → 003 ...
- sessionId도 새 파일명과 동일하게 통일

[SessionStart Hook 연동]
- ~/.claude/hooks/session-start-context-cleaner.sh
- 세션 시작 시 00effaced 패턴이면 안내 메시지 출력

[보존 항목]
- uuid, parentUuid, signature, sessionId 등 식별자
- structuredPatch는 빈 배열 []로 교체 (삭제하면 에러)
- 대화 텍스트, 파일명, 편집 의도

사용법:
    python3 context-cleaner-v2.py /path/to/session.jsonl
    ./context-cleaner-v2.py /path/to/session.jsonl
"""

import sys
import os
import json
import re


# ============================================================================
# 유틸리티 함수
# ============================================================================
def basename_only(path):
    """
    전체 경로에서 파일명만 추출
    예: /Users/.../runner.ts → runner.ts
    """
    if path and isinstance(path, str):
        return os.path.basename(path)
    return path


# ============================================================================
# 대체 텍스트 상수
# ============================================================================
CLEANED_THINKING = "[context-cleaner: thinking]"
CLEANED_FILE_CONTENT = "[context-cleaner: Read]"
CLEANED_WRITE_INPUT = "[context-cleaner: Write]"
CLEANED_WRITE_RESULT = "[context-cleaner: Write]"
CLEANED_EDIT_INPUT = "[context-cleaner: Edit]"
CLEANED_EDIT_RESULT = "[context-cleaner: Edit]"
CLEANED_BASH_INPUT = "[context-cleaner: Bash]"
CLEANED_BASH_OUTPUT = "[context-cleaner: Bash]"
CLEANED_PLAN = "[context-cleaner: Plan]"
CLEANED_TOOL_RESULT = "[context-cleaner: tool_result]"
CLEANED_BASH_TAGS = "[context-cleaner: bash-output]"
CLEANED_LOCAL_CMD_OUTPUT = "[context-cleaner: local-cmd-output]"
CLEANED_USER_MARKED = "[context-cleaner: user-marked]"
CLEANED_TASK_OUTPUT = "[context-cleaner: taskoutput]"
CLEANED_BASH_PROGRESS = "[context-cleaner: bashoutput]"

# 정규식 패턴
# 로컬 명령 출력: <local-command-caveat>...<bash-input>CMD</bash-input><bash-stdout>OUT</bash-stdout><bash-stderr>ERR</bash-stderr>
BASH_TAGS_PATTERN = re.compile(
    r"(<local-command-caveat>.*?</local-command-caveat>\s*)?"
    r"(<bash-input>.*?</bash-input>\s*)?"
    r"<bash-stdout>.*?</bash-stdout>\s*<bash-stderr>.*?</bash-stderr>",
    re.DOTALL,
)
USER_MARKED_PATTERN = re.compile(r"<clean>.*?</clean>", re.DOTALL)


# ============================================================================
# 통계 클래스
# ============================================================================
class CleaningStats:
    def __init__(self):
        self.thinking_count = 0
        self.thinking_bytes = 0
        self.read_count = 0
        self.read_bytes = 0
        self.write_input_count = 0
        self.write_input_bytes = 0
        self.write_result_count = 0
        self.write_result_bytes = 0
        self.edit_input_count = 0
        self.edit_input_bytes = 0
        self.edit_result_count = 0
        self.edit_result_bytes = 0
        self.bash_input_count = 0
        self.bash_input_bytes = 0
        self.bash_output_count = 0
        self.bash_output_bytes = 0
        self.filenames_count = 0
        self.filenames_bytes = 0
        self.hook_progress_count = 0
        self.exitplan_count = 0
        self.exitplan_bytes = 0
        self.tool_result_count = 0
        self.tool_result_bytes = 0
        self.sessionid_count = 0
        self.bash_tags_count = 0
        self.bash_tags_bytes = 0
        self.user_marked_count = 0
        self.user_marked_bytes = 0
        self.task_output_count = 0
        self.task_output_bytes = 0
        self.bash_progress_count = 0
        self.bash_progress_bytes = 0
        self.meta_content_count = 0
        self.meta_content_bytes = 0
        self.local_cmd_output_count = 0
        self.local_cmd_output_bytes = 0

    def total_bytes(self):
        return (
            self.thinking_bytes
            + self.read_bytes
            + self.write_input_bytes
            + self.write_result_bytes
            + self.edit_input_bytes
            + self.edit_result_bytes
            + self.bash_input_bytes
            + self.bash_output_bytes
            + self.filenames_bytes
            + self.exitplan_bytes
            + self.tool_result_bytes
            + self.bash_tags_bytes
            + self.user_marked_bytes
            + self.task_output_bytes
            + self.bash_progress_bytes
            + self.meta_content_bytes
            + self.local_cmd_output_bytes
        )

    def print_stats(self, source_path, output_path, original_size, new_size, new_session_id=None):
        print(f"\n✅ Context Cleaner v2 completed!")
        print(f"\n📁 Source: {source_path}")
        print(f"📁 Output: {output_path}")
        print(f"\n📊 Cleaning Statistics:")
        print(
            f"  Thinking blocks:     {self.thinking_count:>4} cleaned ({self.thinking_bytes:,} bytes)"
        )
        print(
            f"  Read results:        {self.read_count:>4} cleaned ({self.read_bytes:,} bytes)"
        )
        print(
            f"  Write inputs:        {self.write_input_count:>4} cleaned ({self.write_input_bytes:,} bytes)"
        )
        print(
            f"  Write results:       {self.write_result_count:>4} cleaned ({self.write_result_bytes:,} bytes)"
        )
        print(
            f"  Edit inputs:         {self.edit_input_count:>4} cleaned ({self.edit_input_bytes:,} bytes)"
        )
        print(
            f"  Edit results:        {self.edit_result_count:>4} cleaned ({self.edit_result_bytes:,} bytes)"
        )
        print(
            f"  Bash inputs:         {self.bash_input_count:>4} cleaned ({self.bash_input_bytes:,} bytes)"
        )
        print(
            f"  Bash outputs:        {self.bash_output_count:>4} cleaned ({self.bash_output_bytes:,} bytes)"
        )
        print(
            f"  Filenames:           {self.filenames_count:>4} cleaned ({self.filenames_bytes:,} bytes)"
        )
        print(
            f"  ExitPlanMode:        {self.exitplan_count:>4} cleaned ({self.exitplan_bytes:,} bytes)"
        )
        print(
            f"  Tool results:        {self.tool_result_count:>4} cleaned ({self.tool_result_bytes:,} bytes)"
        )
        print(
            f"  Task outputs:        {self.task_output_count:>4} cleaned ({self.task_output_bytes:,} bytes)"
        )
        print(
            f"  Bash progress:       {self.bash_progress_count:>4} cleaned ({self.bash_progress_bytes:,} bytes)"
        )
        print(
            f"  Bash tags:           {self.bash_tags_count:>4} cleaned ({self.bash_tags_bytes:,} bytes)"
        )
        print(
            f"  User marked:         {self.user_marked_count:>4} cleaned ({self.user_marked_bytes:,} bytes)"
        )
        print(
            f"  Meta content:        {self.meta_content_count:>4} cleaned ({self.meta_content_bytes:,} bytes)"
        )
        print(
            f"  Local cmd output:    {self.local_cmd_output_count:>4} cleaned ({self.local_cmd_output_bytes:,} bytes)"
        )
        print(f"  Hook progress:       {self.hook_progress_count:>4} lines removed")
        print(f"  SessionId updated:   {self.sessionid_count:>4} entries")
        print(
            f"\n💾 Total saved: {self.total_bytes():,} bytes ({self.total_bytes() / 1024:.1f} KB)"
        )
        print(f"📦 Original size: {original_size:,} bytes")
        print(
            f"📦 New size: {new_size:,} bytes ({100 * (1 - new_size / original_size):.1f}% reduction)"
        )
        if new_session_id:
            resume_cmd_var = f"claude --resume {new_session_id} --verbose"
            print(f"\n🚀 To resume this cleaned session, run:")
            print(f"   {resume_cmd_var}")
            # pbcopy로 클립보드에 복사 (macOS)
            try:
                import subprocess
                subprocess.run(
                    ["pbcopy"],
                    input=resume_cmd_var.encode("utf-8"),
                    check=True,
                )
                print(f"📋 Copied to clipboard!")
            except (FileNotFoundError, subprocess.CalledProcessError):
                pass  # pbcopy 없는 환경에서는 무시


# ============================================================================
# 파일명 변환 함수
# ============================================================================
def convert_filename(original_path):
    """
    원본 파일명의 마지막 12자리(확장자 제외)를 '00effaced{NNN}'으로 교체

    규칙:
    - 마지막 12자리가 '00effaced{NNN}' 패턴이 아니면 → 00effaced001
    - 마지막 12자리가 '00effaced{NNN}' 패턴이면 → 숫자+1

    예: 9c4c1a42-1f6d-42ae-ac6d-239d2e110282.jsonl
      → 9c4c1a42-1f6d-42ae-ac6d-00effaced001.jsonl
      → 9c4c1a42-1f6d-42ae-ac6d-00effaced002.jsonl
    """
    dirname = os.path.dirname(original_path)
    basename = os.path.basename(original_path)

    if not basename.endswith(".jsonl"):
        return os.path.join(dirname, basename + "-00effaced001.jsonl")

    name_part = basename[:-6]  # .jsonl 제거

    if len(name_part) < 12:
        return os.path.join(dirname, name_part + "-00effaced001.jsonl")

    # 마지막 12자리 확인
    last_12 = name_part[-12:]
    prefix = name_part[:-12]

    # 00effaced{NNN} 패턴 확인
    pattern = re.match(r"00effaced(\d{3})$", last_12)

    if pattern:
        # 이미 effaced 패턴이면 숫자 + 1
        current_num = int(pattern.group(1))
        next_num = current_num + 1
        new_suffix = f"00effaced{next_num:03d}"
    else:
        # effaced 패턴이 아니면 001로 시작
        new_suffix = "00effaced001"

    new_name = prefix + new_suffix
    return os.path.join(dirname, new_name + ".jsonl")


def get_new_session_id(original_path):
    """
    새 파일명에서 sessionId 추출 (확장자 제외)
    예: 9c4c1a42-1f6d-42ae-ac6d-00effaced001
    """
    new_path = convert_filename(original_path)
    basename = os.path.basename(new_path)
    # .jsonl 제거
    if basename.endswith(".jsonl"):
        return basename[:-6]
    return basename


# ============================================================================
# 도구별 클리닝 함수
# ============================================================================
def clean_thinking(obj, stats):
    """
    Thinking 블록 정리
    - message.content[0].thinking 삭제
    - signature는 보존 (검증용)
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if first.get("type") == "thinking" and "thinking" in first:
                original = first["thinking"]
                if original and original != CLEANED_THINKING:
                    stats.thinking_count += 1
                    stats.thinking_bytes += len(original.encode("utf-8"))
                    first["thinking"] = CLEANED_THINKING
                    return True
    except Exception:
        pass
    return False


def clean_read_result(obj, stats):
    """
    Read 도구 결과 정리
    - toolUseResult.file.content 삭제
    - toolUseResult.file.filePath를 파일명만으로 변환
    - 파일 전체 내용이 저장되어 있어 용량이 매우 큼 (최대 58,000자)
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict):
            file_obj = result.get("file", {})
            if isinstance(file_obj, dict):
                cleaned = False
                # content 삭제
                if "content" in file_obj:
                    original = file_obj["content"]
                    if original and original != CLEANED_FILE_CONTENT:
                        stats.read_count += 1
                        stats.read_bytes += len(original.encode("utf-8"))
                        file_obj["content"] = CLEANED_FILE_CONTENT
                        cleaned = True
                # filePath를 파일명만으로 변환
                if "filePath" in file_obj:
                    original_path = file_obj["filePath"]
                    new_path = basename_only(original_path)
                    if original_path != new_path:
                        stats.read_bytes += len(original_path.encode("utf-8")) - len(
                            new_path.encode("utf-8")
                        )
                        file_obj["filePath"] = new_path
                        cleaned = True
                return cleaned
    except Exception:
        pass
    return False


def clean_write_input(obj, stats):
    """
    Write 도구 입력 정리 (assistant 행)
    - message.content[0].input.content 삭제
    - toolUseResult.content와 동일한 내용이 중복 저장됨
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if first.get("name") == "Write" and first.get("type") == "tool_use":
                inp = first.get("input", {})
                if isinstance(inp, dict) and "content" in inp:
                    original = inp["content"]
                    if original and original != CLEANED_WRITE_INPUT:
                        stats.write_input_count += 1
                        stats.write_input_bytes += len(original.encode("utf-8"))
                        inp["content"] = CLEANED_WRITE_INPUT
                        return True
    except Exception:
        pass
    return False


def clean_write_result(obj, stats):
    """
    Write 도구 결과 정리 (user 행)
    - toolUseResult.content 삭제
    - toolUseResult.originalFile 삭제
    - toolUseResult.filePath를 파일명만으로 변환
    - toolUseResult.structuredPatch를 빈 배열로 교체 (type: update인 경우)
    - input.content와 동일한 내용이 중복 저장됨
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict) and "content" in result:
            # Write 결과인지 확인 (type이 "create" 또는 "update")
            if result.get("type") in ["create", "update"]:
                cleaned = False
                original = result["content"]
                if original and original != CLEANED_WRITE_RESULT:
                    stats.write_result_count += 1
                    stats.write_result_bytes += len(original.encode("utf-8"))
                    result["content"] = CLEANED_WRITE_RESULT
                    cleaned = True
                # originalFile 삭제
                if "originalFile" in result:
                    original_file = result["originalFile"]
                    if original_file and original_file != CLEANED_WRITE_RESULT:
                        stats.write_result_bytes += len(
                            str(original_file).encode("utf-8")
                        )
                        result["originalFile"] = CLEANED_WRITE_RESULT
                        cleaned = True
                # filePath를 파일명만으로 변환
                if "filePath" in result:
                    original_path = result["filePath"]
                    new_path = basename_only(original_path)
                    if original_path != new_path:
                        stats.write_result_bytes += len(
                            original_path.encode("utf-8")
                        ) - len(new_path.encode("utf-8"))
                        result["filePath"] = new_path
                        cleaned = True
                # type: update인 경우 structuredPatch를 빈 배열로 교체
                if "structuredPatch" in result and isinstance(
                    result["structuredPatch"], list
                ):
                    for patch in result["structuredPatch"]:
                        if (
                            isinstance(patch, dict)
                            and "lines" in patch
                            and isinstance(patch["lines"], list)
                        ):
                            for line in patch["lines"]:
                                if line:
                                    stats.write_result_bytes += len(
                                        str(line).encode("utf-8")
                                    )
                    result["structuredPatch"] = []
                    cleaned = True
                return cleaned
    except Exception:
        pass
    return False


def clean_edit_input(obj, stats):
    """
    Edit 도구 입력 정리 (assistant 행)
    - message.content[0].input.old_string, new_string 삭제
    - snake_case 네이밍 사용
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if first.get("name") == "Edit" and first.get("type") == "tool_use":
                inp = first.get("input", {})
                if isinstance(inp, dict):
                    cleaned = False
                    for field in ["old_string", "new_string"]:
                        if field in inp:
                            original = inp[field]
                            if original and original != CLEANED_EDIT_INPUT:
                                stats.edit_input_bytes += len(original.encode("utf-8"))
                                inp[field] = CLEANED_EDIT_INPUT
                                cleaned = True
                    if cleaned:
                        stats.edit_input_count += 1
                        return True
    except Exception:
        pass
    return False


def clean_edit_result(obj, stats):
    """
    Edit 도구 결과 정리 (user 행)
    - toolUseResult.oldString, newString, originalFile 삭제
    - toolUseResult.filePath를 파일명만으로 변환
    - camelCase 네이밍 사용 (input과 다름!)
    - originalFile: 수정 전 파일 전체 내용 (~3,600자)
    - structuredPatch: 빈 배열로 교체
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict) and "oldString" in result:
            cleaned = False
            for field in ["oldString", "newString", "originalFile"]:
                if field in result:
                    original = result[field]
                    if original and original != CLEANED_EDIT_RESULT:
                        stats.edit_result_bytes += len(str(original).encode("utf-8"))
                        result[field] = CLEANED_EDIT_RESULT
                        cleaned = True
            # filePath를 파일명만으로 변환
            if "filePath" in result:
                original_path = result["filePath"]
                new_path = basename_only(original_path)
                if original_path != new_path:
                    stats.edit_result_bytes += len(original_path.encode("utf-8")) - len(
                        new_path.encode("utf-8")
                    )
                    result["filePath"] = new_path
                    cleaned = True
            # structuredPatch를 빈 배열로 교체
            if "structuredPatch" in result and isinstance(
                result["structuredPatch"], list
            ):
                for patch in result["structuredPatch"]:
                    if (
                        isinstance(patch, dict)
                        and "lines" in patch
                        and isinstance(patch["lines"], list)
                    ):
                        for line in patch["lines"]:
                            if line:
                                stats.edit_result_bytes += len(
                                    str(line).encode("utf-8")
                                )
                result["structuredPatch"] = []
                cleaned = True
            if cleaned:
                stats.edit_result_count += 1
                return True
    except Exception:
        pass
    return False


def clean_bash_input(obj, stats):
    """
    Bash 도구 입력 정리 (assistant 행)
    - message.content[0].input.command 삭제
    - 명령어 자체가 화면에 표시됨
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if first.get("name") == "Bash" and first.get("type") == "tool_use":
                inp = first.get("input", {})
                if isinstance(inp, dict) and "command" in inp:
                    original = inp["command"]
                    if original and original != CLEANED_BASH_INPUT:
                        stats.bash_input_count += 1
                        stats.bash_input_bytes += len(original.encode("utf-8"))
                        inp["command"] = CLEANED_BASH_INPUT
                        return True
    except Exception:
        pass
    return False


def clean_bash_result(obj, stats):
    """
    Bash 도구 결과 정리 (user 행)
    - toolUseResult.stdout, stderr 삭제
    - 명령어 실행 결과 (평균 ~1,500자)
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict) and ("stdout" in result or "stderr" in result):
            cleaned = False
            for field in ["stdout", "stderr"]:
                if field in result:
                    original = result[field]
                    if original and original != CLEANED_BASH_OUTPUT:
                        stats.bash_output_bytes += len(original.encode("utf-8"))
                        result[field] = CLEANED_BASH_OUTPUT
                        cleaned = True
            if cleaned:
                stats.bash_output_count += 1
                return True
    except Exception:
        pass
    return False


def clean_filenames_result(obj, stats):
    """
    Grep/Glob 도구 결과 정리 (user 행)
    - toolUseResult.filenames 배열을 [""]로 교체
    - 파일 목록이 화면에 표시됨
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict) and "filenames" in result:
            filenames = result["filenames"]
            if isinstance(filenames, list) and len(filenames) > 0:
                # 이미 처리된 경우 스킵
                if filenames == [""]:
                    return False
                for fname in filenames:
                    if fname:
                        stats.filenames_bytes += len(str(fname).encode("utf-8"))
                stats.filenames_count += 1
                result["filenames"] = [""]
                return True
    except Exception:
        pass
    return False


def clean_exitplanmode_input(obj, stats):
    """
    ExitPlanMode 도구 입력 정리 (assistant 행)
    - message.content[0].input.plan 삭제
    - Plan 전체가 저장되어 매우 큼 (최대 ~12,000자)
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if first.get("name") == "ExitPlanMode" and first.get("type") == "tool_use":
                inp = first.get("input", {})
                if isinstance(inp, dict) and "plan" in inp:
                    original = inp["plan"]
                    if original and original != CLEANED_PLAN:
                        stats.exitplan_count += 1
                        stats.exitplan_bytes += len(original.encode("utf-8"))
                        inp["plan"] = CLEANED_PLAN
                        return True
    except Exception:
        pass
    return False


def clean_tool_result_content(obj, stats):
    """
    tool_result의 content 정리 (user 행)
    - message.content[0].content 삭제 (type이 "tool_result"인 경우)
    - toolUseResult와 별개로 message.content에도 결과가 중복 저장됨
    - Read, Bash 등 도구 결과가 여기에도 들어있어 용량이 큼 (최대 ~69,000자)
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if first.get("type") == "tool_result" and "content" in first:
                original = first["content"]
                if (
                    original
                    and isinstance(original, str)
                    and original != CLEANED_TOOL_RESULT
                ):
                    stats.tool_result_count += 1
                    stats.tool_result_bytes += len(original.encode("utf-8"))
                    first["content"] = CLEANED_TOOL_RESULT
                    return True
    except Exception:
        pass
    return False


def clean_task_output(obj, stats):
    """
    Task 도구 결과의 description 정리 (user 행)
    - toolUseResult.task.description 삭제
    - Task agent의 결과가 매우 길 수 있음
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict) and "task" in result:
            task = result["task"]
            if isinstance(task, dict) and "description" in task:
                original = task["description"]
                if original and original != CLEANED_TASK_OUTPUT:
                    stats.task_output_bytes += len(original.encode("utf-8"))
                    stats.task_output_count += 1
                    task["description"] = CLEANED_TASK_OUTPUT
                    return True
    except Exception:
        pass
    return False


def clean_task_output(obj, stats):
    """
    Task 도구 결과 정리 (user 행)
    - toolUseResult.task.output 삭제 (매우 큼)
    - description은 보존 (맥락 이해용)
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict) and "task" in result:
            task = result["task"]
            if isinstance(task, dict):
                cleaned = False
                # output 삭제 (description은 보존)
                if "output" in task:
                    original = task["output"]
                    if original and original != CLEANED_TASK_OUTPUT:
                        stats.task_output_bytes += len(str(original).encode("utf-8"))
                        task["output"] = CLEANED_TASK_OUTPUT
                        cleaned = True
                if cleaned:
                    stats.task_output_count += 1
                    return True
    except Exception:
        pass
    return False


def clean_bash_progress(obj, stats):
    """
    Bash progress 데이터 정리 (progress 행)
    - type: progress, data.type: bash_progress
    - data.output, data.fullOutput 삭제
    """
    try:
        if obj.get("type") == "progress":
            data = obj.get("data", {})
            if isinstance(data, dict) and data.get("type") == "bash_progress":
                cleaned = False
                for field in ["output", "fullOutput"]:
                    if field in data:
                        original = data[field]
                        if original and original != CLEANED_BASH_PROGRESS:
                            stats.bash_progress_bytes += len(
                                str(original).encode("utf-8")
                            )
                            data[field] = CLEANED_BASH_PROGRESS
                            cleaned = True
                if cleaned:
                    stats.bash_progress_count += 1
                    return True
    except Exception:
        pass
    return False


def clean_input_filepath(obj, stats):
    """
    도구 입력의 file_path를 파일명만으로 변환 (assistant 행)
    - message.content[0].input.file_path → 파일명만
    - Read, Edit, Write 모두 해당
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if first.get("type") == "tool_use" and first.get("name") in [
                "Read",
                "Edit",
                "Write",
            ]:
                inp = first.get("input", {})
                if isinstance(inp, dict) and "file_path" in inp:
                    original_path = inp["file_path"]
                    new_path = basename_only(original_path)
                    if original_path != new_path:
                        # bytes 절약량은 별도 통계로 관리하지 않음 (filenames_bytes에 포함)
                        stats.filenames_bytes += len(
                            original_path.encode("utf-8")
                        ) - len(new_path.encode("utf-8"))
                        inp["file_path"] = new_path
                        return True
    except Exception:
        pass
    return False


def clean_bash_tags(obj, stats):
    """
    message.content에서 <bash-stdout>...</bash-stdout><bash-stderr>...</bash-stderr> 패턴 삭제
    - 터미널에서 실행한 명령어 출력이 저장됨
    - message.content가 string 또는 array[{type, text}] 형태 모두 처리
    """
    try:
        message = obj.get("message", {})
        content = message.get("content")

        # string 타입인 경우
        if content and isinstance(content, str):
            # 전체 콘텐츠가 <bash-stdout>...</bash-stderr>로 감싸진 경우
            # (lazy .*?가 내용물 안의 리터럴 </bash-stdout>에 걸리는 버그 방지)
            stripped_var = content.strip()
            if stripped_var.startswith("<bash-stdout>") and stripped_var.endswith("</bash-stderr>"):
                stats.bash_tags_bytes += len(content.encode("utf-8"))
                stats.bash_tags_count += 1
                message["content"] = CLEANED_BASH_TAGS
                return True
            # 부분 매치 (regex)
            matches = BASH_TAGS_PATTERN.findall(content)
            if matches:
                for match in matches:
                    stats.bash_tags_bytes += len(match.encode("utf-8"))
                stats.bash_tags_count += len(matches)
                message["content"] = BASH_TAGS_PATTERN.sub(CLEANED_BASH_TAGS, content)
                return True

        # array 타입인 경우 (content[i].text 처리)
        if content and isinstance(content, list):
            cleaned = False
            for item in content:
                if isinstance(item, dict) and "text" in item:
                    text = item["text"]
                    if isinstance(text, str):
                        matches = BASH_TAGS_PATTERN.findall(text)
                        if matches:
                            for match in matches:
                                stats.bash_tags_bytes += len(match.encode("utf-8"))
                            stats.bash_tags_count += len(matches)
                            item["text"] = BASH_TAGS_PATTERN.sub(
                                CLEANED_BASH_TAGS, text
                            )
                            cleaned = True
            return cleaned
    except Exception:
        pass
    return False


def clean_user_marked(obj, stats):
    """
    message.content에서 <clean>...</clean> 패턴 삭제
    - 사용자가 직접 마킹한 삭제 예정 내용
    - message.content가 string 또는 array[{type, text}] 형태 모두 처리
    """
    try:
        message = obj.get("message", {})
        content = message.get("content")

        # string 타입인 경우
        if content and isinstance(content, str):
            matches = USER_MARKED_PATTERN.findall(content)
            if matches:
                for match in matches:
                    stats.user_marked_bytes += len(match.encode("utf-8"))
                stats.user_marked_count += len(matches)
                message["content"] = USER_MARKED_PATTERN.sub(
                    CLEANED_USER_MARKED, content
                )
                return True

        # array 타입인 경우 (content[i].text 처리)
        if content and isinstance(content, list):
            cleaned = False
            for item in content:
                if isinstance(item, dict) and "text" in item:
                    text = item["text"]
                    if isinstance(text, str):
                        matches = USER_MARKED_PATTERN.findall(text)
                        if matches:
                            for match in matches:
                                stats.user_marked_bytes += len(match.encode("utf-8"))
                            stats.user_marked_count += len(matches)
                            item["text"] = USER_MARKED_PATTERN.sub(
                                CLEANED_USER_MARKED, text
                            )
                            cleaned = True
            return cleaned
    except Exception:
        pass
    return False


CLEANED_META_CONTENT = "[context-cleaner: meta]"


def clean_meta_content(obj, stats):
    """
    isMeta 메시지 정리 (Skill 도구 결과 등)
    - isMeta: true인 메시지의 message.content[0].text 삭제
    - Skill 호출 시 SKILL.md 전체 내용이 주입되어 매우 큼 (10,000~15,000자)
    """
    try:
        if not obj.get("isMeta"):
            return False
        content = obj.get("message", {}).get("content", [])
        if content and isinstance(content, list) and len(content) > 0:
            first = content[0]
            if isinstance(first, dict) and "text" in first:
                original = first["text"]
                if original and original != CLEANED_META_CONTENT:
                    stats.meta_content_count += 1
                    stats.meta_content_bytes += len(original.encode("utf-8"))
                    first["text"] = CLEANED_META_CONTENT
                    return True
    except Exception:
        pass
    return False


def update_session_id(obj, new_session_id, stats):
    """
    sessionId를 새 파일명과 동일하게 변경

    [전체 수정 이유]
    - session fork 시 원본 sessionId가 섞여 있을 수 있음
    - Claude Code의 파일 감지 기능이 sessionId로 세션을 식별
    - 모든 sessionId를 통일해야 복구/로드 시 혼란 방지
    """
    if "sessionId" in obj:
        old_id = obj["sessionId"]
        if old_id != new_session_id:
            obj["sessionId"] = new_session_id
            stats.sessionid_count += 1
            return True
    return False


# ============================================================================
# 메인 처리 함수
# ============================================================================
def process_line(line, new_session_id, stats):
    """
    한 줄(JSON) 처리
    1. sessionId 업데이트
    2. 도구별 클리닝 적용
    """
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return line  # 파싱 실패 시 원본 반환

    # sessionId 업데이트
    update_session_id(obj, new_session_id, stats)

    # 도구별 클리닝 (순서대로 시도)
    clean_thinking(obj, stats)
    clean_read_result(obj, stats)
    clean_write_input(obj, stats)
    clean_write_result(obj, stats)
    clean_edit_input(obj, stats)
    clean_edit_result(obj, stats)
    clean_bash_input(obj, stats)
    clean_bash_result(obj, stats)
    clean_filenames_result(obj, stats)  # Grep/Glob 결과
    clean_exitplanmode_input(obj, stats)
    clean_tool_result_content(obj, stats)  # message.content[0].content (tool_result)

    return json.dumps(obj, ensure_ascii=False)


def clean_transcript(source_path):
    """
    트랜스크립트 파일 정리

    1. 새 파일 경로 생성 (facec0de- prefix)
    2. sessionId 추출
    3. 한 줄씩 처리
    4. 새 파일에 저장
    5. 통계 출력
    """
    if not os.path.exists(source_path):
        print(f"Error: File not found: {source_path}", file=sys.stderr)
        return False

    # 새 파일 경로 및 sessionId
    output_path = convert_filename(source_path)
    new_session_id = get_new_session_id(source_path)

    # 통계 초기화
    stats = CleaningStats()

    # 원본 크기
    original_size = os.path.getsize(source_path)

    # 파일 처리
    with open(source_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # 1단계: 일반 클리닝 적용 (hook_progress 제외)
    processed_objs = []
    for line in lines:
        line = line.rstrip("\n")
        if line:
            try:
                obj = json.loads(line)
                # sessionId 업데이트
                update_session_id(obj, new_session_id, stats)
                # 도구별 클리닝
                clean_thinking(obj, stats)
                clean_read_result(obj, stats)
                clean_write_input(obj, stats)
                clean_write_result(obj, stats)
                clean_edit_input(obj, stats)
                clean_edit_result(obj, stats)
                clean_bash_input(obj, stats)
                clean_bash_result(obj, stats)
                clean_filenames_result(obj, stats)
                clean_exitplanmode_input(obj, stats)
                clean_tool_result_content(obj, stats)
                clean_task_output(obj, stats)
                clean_bash_progress(obj, stats)
                clean_input_filepath(obj, stats)  # input의 file_path를 파일명만으로
                clean_bash_tags(
                    obj, stats
                )  # <bash-stdout>...</bash-stdout><bash-stderr>...</bash-stderr>
                clean_user_marked(obj, stats)  # <clean>...</clean>
                clean_meta_content(obj, stats)  # isMeta (Skill 결과 등)
                processed_objs.append(obj)
            except json.JSONDecodeError:
                processed_objs.append({"_raw_line": line})

    # 1.5단계: 로컬 커맨드 출력 클리닝
    # <bash-input> 메시지의 UUID를 수집하고, 그 자식 메시지(출력)를 정리
    # 로컬 커맨드 출력은 별도 user 메시지로 저장되며 태그가 없음
    bash_input_uuids_var = set()
    for obj in processed_objs:
        if "_raw_line" in obj:
            continue
        if obj.get("type") == "user":
            content = obj.get("message", {}).get("content", "")
            if isinstance(content, str) and "<bash-input>" in content:
                uuid_var = obj.get("uuid")
                if uuid_var:
                    bash_input_uuids_var.add(uuid_var)

    for obj in processed_objs:
        if "_raw_line" in obj:
            continue
        if obj.get("type") == "user":
            parent_var = obj.get("parentUuid", "")
            content = obj.get("message", {}).get("content", "")
            if (
                parent_var in bash_input_uuids_var
                and isinstance(content, str)
                and len(content) > 100
                and content != CLEANED_LOCAL_CMD_OUTPUT
            ):
                stats.local_cmd_output_bytes += len(content.encode("utf-8"))
                stats.local_cmd_output_count += 1
                obj["message"]["content"] = CLEANED_LOCAL_CMD_OUTPUT

    # 2단계: 불필요한 행 삭제 및 parentUuid 연결 유지
    # 삭제 대상: hook_progress, local-command-caveat, bash-input, 로컬 커맨드 출력
    # 삭제된 uuid → 그 이전(살아남은) 줄의 uuid로 매핑
    # 다음 줄의 parentUuid가 삭제된 uuid를 참조하면 매핑된 uuid로 교체
    cleaned_objs = []
    last_kept_uuid = None  # 마지막으로 유지된 줄의 uuid
    deleted_uuid_map = {}  # 삭제된 uuid → 대체할 uuid

    for obj in processed_objs:
        # raw line인 경우 (파싱 실패)
        if "_raw_line" in obj:
            cleaned_objs.append(obj)
            continue

        should_delete = False

        # hook_progress 삭제
        if (
            obj.get("type") == "progress"
            and isinstance(obj.get("data"), dict)
            and obj.get("data", {}).get("type") == "hook_progress"
        ):
            stats.hook_progress_count += 1
            should_delete = True

        # 로컬 커맨드 관련 메시지 삭제 (UI에서 안 보이는 메시지들)
        if obj.get("type") == "user":
            content = obj.get("message", {}).get("content", "")
            if isinstance(content, str):
                # <local-command-caveat> 메시지
                if "<local-command-caveat>" in content and "<bash-input>" not in content:
                    should_delete = True
                # <bash-input> 메시지 (명령어만 있는 행)
                elif content.strip().startswith("<bash-input>") and content.strip().endswith("</bash-input>"):
                    should_delete = True
                # 로컬 커맨드 출력 (이미 CLEANED_LOCAL_CMD_OUTPUT으로 치환된 행)
                elif content == CLEANED_LOCAL_CMD_OUTPUT:
                    should_delete = True
                # 로컬 커맨드 출력 (bash-stdout 태그가 치환된 행)
                elif content == CLEANED_BASH_TAGS:
                    should_delete = True

        if should_delete:
            deleted_uuid = obj.get("uuid")
            if deleted_uuid and last_kept_uuid:
                deleted_uuid_map[deleted_uuid] = last_kept_uuid
            elif deleted_uuid:
                # 첫 번째 메시지가 삭제되는 경우, 매핑은 나중에 처리
                deleted_uuid_map[deleted_uuid] = None
            continue  # 이 줄은 삭제

        # 삭제 대상이 아닌 경우
        # parentUuid가 삭제된 uuid를 참조하면 매핑된 uuid로 교체
        parent_uuid = obj.get("parentUuid")
        if parent_uuid and parent_uuid in deleted_uuid_map:
            mapped = deleted_uuid_map[parent_uuid]
            if mapped:
                obj["parentUuid"] = mapped
            else:
                # 매핑 대상이 None이면 (첫 메시지 앞이 삭제됨) parentUuid 제거
                obj["parentUuid"] = None

        # 현재 uuid를 last_kept_uuid로 저장 (uuid가 없는 항목은 건너뜀)
        current_uuid_var = obj.get("uuid")
        if current_uuid_var:
            last_kept_uuid = current_uuid_var
            # 앞서 None으로 매핑된 항목들을 현재 uuid로 업데이트
            for k, v in deleted_uuid_map.items():
                if v is None:
                    deleted_uuid_map[k] = current_uuid_var
        cleaned_objs.append(obj)

    # 2.5단계: 끊긴 parentUuid 수정
    # 존재하지 않는 parentUuid를 가진 메시지의 parentUuid를 제거하여
    # 대화 트리의 루트로 만듦 (claude --resume 시 대화가 정상 표시됨)
    all_uuids_var = set()
    for obj in cleaned_objs:
        if "_raw_line" in obj:
            continue
        uuid_var = obj.get("uuid")
        if uuid_var:
            all_uuids_var.add(uuid_var)

    for obj in cleaned_objs:
        if "_raw_line" in obj:
            continue
        parent_var = obj.get("parentUuid")
        if parent_var and parent_var not in all_uuids_var:
            del obj["parentUuid"]

    # 3단계: JSON으로 직렬화
    cleaned_lines = []
    for obj in cleaned_objs:
        if "_raw_line" in obj:
            cleaned_lines.append(obj["_raw_line"] + "\n")
        else:
            cleaned_lines.append(json.dumps(obj, ensure_ascii=False) + "\n")

    # 새 파일에 저장 (이미 존재하면 덮어쓰기)
    with open(output_path, "w", encoding="utf-8") as f:
        f.writelines(cleaned_lines)

    # 새 파일 크기
    new_size = os.path.getsize(output_path)

    # 통계 출력
    stats.print_stats(source_path, output_path, original_size, new_size, new_session_id)

    return True


# ============================================================================
# 메인
# ============================================================================
def main():
    if len(sys.argv) < 2:
        print("Usage: context-cleaner-v2.py <transcript_path>", file=sys.stderr)
        print(
            "Example: ./context-cleaner-v2.py /path/to/session.jsonl", file=sys.stderr
        )
        sys.exit(1)

    source_path = sys.argv[1]

    # 절대 경로로 변환
    source_path = os.path.abspath(source_path)

    try:
        success = clean_transcript(source_path)
        if not success:
            sys.exit(1)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
