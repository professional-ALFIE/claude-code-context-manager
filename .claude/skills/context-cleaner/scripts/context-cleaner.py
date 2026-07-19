#!/usr/bin/env python3
"""
Context Cleaner v4 - Claude Code 세션 파일 최적화 도구

목적: "상세 변경내역은 몰라도, 흐름은 기억나도록"
- thinking block, toolUseResult, attachment, 파일 전체경로 삭제
- 대화 기록(사용자 발화 포함), 편집 의도, 파일명, signature는 보존
- session compact보다 토큰 효율과 맥락 기억이 좋음

원본 파일을 보존하고, 00effaced{NNN} suffix로 새 파일 생성.

[핵심 원칙: 치환(replace)만, 삭제(del) 절대 금지]
=================================================
Claude Code는 resume 시 JSONL의 모든 키가 존재한다고 가정하고 파싱한다.
키를 삭제(del)하거나 구조를 바꾸면(dict→str, list→str 등) 런타임 에러 발생.

따라서 클리닝은 반드시:
  1. 키(key)는 원본 그대로 유지
  2. 값(value)만 placeholder 문자열로 치환 (예: "[context-cleaner: Read]")
  3. 배열은 빈 배열 []로 치환 (예: structuredPatch)
  4. toolUseResult가 list일 때도 list 구조와 내부 dict 키를 유지하고 값만 치환
  5. 어떤 필드든 하나라도 없어지면 오류 — 구조 보존이 최우선

[삭제 대상 요약]
==================

| 도구/패턴 | 삭제 필드 |
|-----------|-----------|
| Thinking | message.content[0].thinking (signature는 보존) |
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
| toolUseResult.prompt | toolUseResult.prompt (agent_prompt) |
| local-command-stdout | <local-command-stdout>...</local-command-stdout> 내부 콘텐츠 |
| attachment(skill) | attachment.content (string, 세션 주입 skill 목록) → placeholder |
| attachment(file) | attachment.content.file.content → placeholder, filePath→파일명 |

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
  (signature는 thinking 암호화 서명: 변형 시 resume 400, 토큰도 안 먹어 줄일 이유 없음)
- structuredPatch는 빈 배열 []로 교체 (삭제하면 에러)
- 대화 텍스트, 파일명, 편집 의도
- 사용자 발화(message.content, type=user)는 절대 삭제하지 않고 보존 (대화 흐름의 뼈대)

사용법:
    python3 context-cleaner.py /path/to/session.jsonl
    ./context-cleaner.py /path/to/session.jsonl
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
CLEANED_AGENT_PROMPT = "[context-cleaner: agent_prompt]"
CLEANED_BASE64_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII="
CLEANED_TOOL_RESULT_STRING = "[context-cleaner: tool_result_string]"
CLEANED_TEAMMATE_MESSAGE = "[context-cleaner: teammate_message]"
CLEANED_ATTACHMENT = "[context-cleaner: attachment]"  # 세션 시작 주입 skill 목록 등 attachment 본문

# 정규식 패턴
# 로컬 명령 출력: <local-command-caveat>...<bash-input>CMD</bash-input><bash-stdout>OUT</bash-stdout><bash-stderr>ERR</bash-stderr>
BASH_TAGS_PATTERN = re.compile(
    r"(<local-command-caveat>.*?</local-command-caveat>\s*)?"
    r"(<bash-input>.*?</bash-input>\s*)?"
    r"<bash-stdout>.*?</bash-stdout>\s*<bash-stderr>.*?</bash-stderr>",
    re.DOTALL,
)
USER_MARKED_PATTERN = re.compile(r"<clean>.*?</clean>", re.DOTALL)
TEAMMATE_MESSAGE_PATTERN = re.compile(r'(<teammate-message[^>]*>).*?(</teammate-message>)', re.DOTALL)
LOCAL_COMMAND_STDOUT_PATTERN = re.compile(r'(<local-command-stdout>).*?(</local-command-stdout>)', re.DOTALL)


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
        self.agent_progress_count = 0
        self.agent_progress_bytes = 0
        self.task_content_text_count = 0
        self.task_content_text_bytes = 0
        self.base64_image_count = 0
        self.base64_image_bytes = 0
        self.tool_result_string_count = 0
        self.tool_result_string_bytes = 0
        self.teammate_message_count = 0
        self.teammate_message_bytes = 0
        self.tool_use_result_prompt_count = 0
        self.tool_use_result_prompt_bytes = 0
        self.local_command_stdout_count = 0
        self.local_command_stdout_bytes = 0
        self.tool_use_input_prompt_count = 0
        self.tool_use_input_prompt_bytes = 0
        self.attachment_count = 0
        self.attachment_bytes = 0

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
            + self.agent_progress_bytes
            + self.task_content_text_bytes
            + self.base64_image_bytes
            + self.tool_result_string_bytes
            + self.teammate_message_bytes
            + self.tool_use_result_prompt_bytes
            + self.local_command_stdout_bytes
            + self.tool_use_input_prompt_bytes
            + self.attachment_bytes
        )

    def print_stats(self, source_path, output_path, original_size, new_size, new_session_id=None):
        print(f"\n✅ Context Cleaner v4 completed!")
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
            f"  Agent progress:      {self.agent_progress_count:>4} cleaned ({self.agent_progress_bytes:,} bytes)"
        )
        print(
            f"  Task content text:   {self.task_content_text_count:>4} cleaned ({self.task_content_text_bytes:,} bytes)"
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
        print(
            f"  Base64 images:       {self.base64_image_count:>4} cleaned ({self.base64_image_bytes:,} bytes)"
        )
        print(
            f"  Tool result string:  {self.tool_result_string_count:>4} cleaned ({self.tool_result_string_bytes:,} bytes)"
        )
        print(
            f"  Teammate message:    {self.teammate_message_count:>4} cleaned ({self.teammate_message_bytes:,} bytes)"
        )
        print(
            f"  ToolResult prompt:   {self.tool_use_result_prompt_count:>4} cleaned ({self.tool_use_result_prompt_bytes:,} bytes)"
        )
        print(
            f"  Local cmd stdout:    {self.local_command_stdout_count:>4} cleaned ({self.local_command_stdout_bytes:,} bytes)"
        )
        print(
            f"  ToolUse inp prompt: {self.tool_use_input_prompt_count:>4} cleaned ({self.tool_use_input_prompt_bytes:,} bytes)"
        )
        print(
            f"  Attachments:         {self.attachment_count:>4} cleaned ({self.attachment_bytes:,} bytes)"
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
            resume_cmd_var = f"claude --resume {new_session_id} --verbose --dangerously-skip-permissions"
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
    - message.content[0].thinking → placeholder 치환
    - signature는 보존한다 (절대 건드리지 않음).
      signature는 Anthropic 서버가 만든 opaque 암호화 서명이라 1바이트라도 바꾸면
      resume 시 "thinking block cannot be modified" 400 에러가 난다.
      게다가 signature는 모델 토큰으로 세지 않는 metadata라(차지하는 건 파일 바이트뿐,
      Claude Code tokenEstimation 기준) 줄여도 컨텍스트 절약 효과가 없다. → 보존이 정답.
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


def clean_attachment(obj, stats):
    """
    attachment 정리 (type: attachment 행)
    두 형태가 공존한다:
      A) attachment.content가 string → 세션 시작 시 주입되는 skill 목록 등 시스템 텍스트
         → CLEANED_ATTACHMENT로 치환 (names/skillCount 등 다른 키는 보존)
      B) attachment.content가 dict → 사용자가 첨부한 파일
         → attachment.content.file.content를 CLEANED_FILE_CONTENT로 치환,
           attachment.content.file.filePath는 파일명만으로 변환 (filename 등은 보존)
    주의: 사용자 발화(message.content, type=user)는 여기서 다루지 않으며 그대로 보존된다.
    """
    try:
        attachment = obj.get("attachment")
        if not isinstance(attachment, dict):
            return False
        content = attachment.get("content")
        cleaned = False
        # A) content가 string (주입 텍스트)
        if isinstance(content, str):
            if content and content != CLEANED_ATTACHMENT:
                stats.attachment_count += 1
                stats.attachment_bytes += len(content.encode("utf-8"))
                attachment["content"] = CLEANED_ATTACHMENT
                cleaned = True
        # B) content가 dict (첨부 파일)
        elif isinstance(content, dict):
            file_obj = content.get("file", {})
            if isinstance(file_obj, dict):
                if "content" in file_obj:
                    original = file_obj["content"]
                    if original and original != CLEANED_FILE_CONTENT:
                        stats.attachment_count += 1
                        stats.attachment_bytes += len(original.encode("utf-8"))
                        file_obj["content"] = CLEANED_FILE_CONTENT
                        cleaned = True
                if "filePath" in file_obj:
                    original_path = file_obj["filePath"]
                    new_path = basename_only(original_path)
                    if original_path != new_path:
                        stats.attachment_bytes += len(
                            original_path.encode("utf-8")
                        ) - len(new_path.encode("utf-8"))
                        file_obj["filePath"] = new_path
                        cleaned = True
        return cleaned
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
    message.content[0].content (tool_result) 정리 (user 행)
    """
    try:
        message = obj.get("message", {})
        if isinstance(message, dict) and "content" in message:
            content = message["content"]
            if isinstance(content, list) and len(content) > 0:
                first = content[0]
                if isinstance(first, dict) and first.get("type") == "tool_result":
                    if "content" in first:
                        original = first["content"]
                        if isinstance(original, str):
                            if original and original != CLEANED_TOOL_RESULT:
                                stats.tool_result_count += 1
                                stats.tool_result_bytes += len(original.encode("utf-8"))
                                first["content"] = CLEANED_TOOL_RESULT
                                return True
                        elif isinstance(original, list):
                            # list 내부: [{"type": "text", "text": "..."}, ...] 구조
                            # type/tool_name 등 키는 유지, text 값만 placeholder로 치환
                            cleaned = False
                            for item in original:
                                if isinstance(item, dict) and "text" in item:
                                    text_val = item["text"]
                                    if text_val and text_val != CLEANED_TOOL_RESULT:
                                        stats.tool_result_bytes += len(
                                            str(text_val).encode("utf-8")
                                        )
                                        item["text"] = CLEANED_TOOL_RESULT
                                        cleaned = True
                            if cleaned:
                                stats.tool_result_count += 1
                                return True
    except Exception:
        pass
    return False


def clean_list_tool_use_result(obj, stats):
    """
    toolUseResult가 list인 경우 처리 (assistant 행)
    - 구조: toolUseResult = [{"type": "text", "text": "..."}, ...]
    - text 값만 placeholder로 치환, type/tool_name 등 다른 키는 유지
    - dict인 경우는 기존 함수들(clean_read_result 등)이 처리하므로 상호배타적
    """
    try:
        result = obj.get("toolUseResult")
        if isinstance(result, list):
            cleaned = False
            for item in result:
                if isinstance(item, dict) and "text" in item:
                    text_val = item["text"]
                    if text_val and text_val != CLEANED_TOOL_RESULT:
                        stats.tool_result_bytes += len(
                            str(text_val).encode("utf-8")
                        )
                        item["text"] = CLEANED_TOOL_RESULT
                        cleaned = True
            if cleaned:
                stats.tool_result_count += 1
                return True
    except Exception:
        pass
    return False




def clean_task_output(obj, stats):
    """
    Task 도구 결과 정리 (user 행)
    - toolUseResult.task.output 삭제 (에이전트 실행 결과, 매우 큼)
    - description은 보존 (어떤 작업을 위임했는지 맥락 이해용)

    [v2 버그 수정] 같은 이름의 함수가 2개 정의되어 있었음:
      - 첫 번째: description 삭제 (의도와 다름)
      - 두 번째: output 삭제 (Python은 이것만 인식)
    → 하나로 통합. output만 삭제, description 보존.
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


def clean_task_content_text(obj, stats):
    """
    Task 도구의 content 내부 text 정리 (user 행)
    - toolUseResult가 dict이고 content 키에 list가 있는 경우
    - 구조: toolUseResult = {"status": "completed", "prompt": "...", "content": [{"type": "text", "text": "..."}]}
    - content 내부의 text 값만 placeholder로 치환
    - prompt도 placeholder로 치환
    - status, agentId 등 다른 키는 유지

    [v4 신규] 기존 clean_list_tool_use_result는 toolUseResult가 list인 경우만 처리.
    이 함수는 toolUseResult가 dict이고 content 키가 있는 경우를 처리.
    """
    try:
        result = obj.get("toolUseResult", {})
        if not isinstance(result, dict):
            return False
        content = result.get("content")
        if not isinstance(content, list):
            return False

        # Write 결과(type: create/update)나 task 결과는 다른 함수가 처리
        if result.get("type") in ["create", "update"]:
            return False
        if "task" in result:
            return False

        cleaned = False

        # 1. content[N].text → CLEANED_TOOL_RESULT
        for item in content:
            if isinstance(item, dict) and "text" in item:
                text_val = item["text"]
                if text_val and text_val != CLEANED_TOOL_RESULT:
                    stats.task_content_text_bytes += len(str(text_val).encode("utf-8"))
                    item["text"] = CLEANED_TOOL_RESULT
                    cleaned = True

        # 2. prompt → CLEANED_AGENT_PROMPT
        if "prompt" in result:
            prompt_val = result["prompt"]
            if isinstance(prompt_val, str) and prompt_val and prompt_val != CLEANED_AGENT_PROMPT:
                stats.task_content_text_bytes += len(prompt_val.encode("utf-8"))
                result["prompt"] = CLEANED_AGENT_PROMPT
                cleaned = True

        if cleaned:
            stats.task_content_text_count += 1
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


def clean_agent_progress(obj, stats):
    """
    agent_progress 데이터 정리 (progress 행)
    - type: "progress" + data.type: "agent_progress" 인 행 대상
    - 경로: data.message.message.content[N].content → placeholder 치환
    - content가 list인 경우: 내부 text 값만 치환
    - content가 string인 경우: 문자열 전체를 치환
    - data.prompt도 치환 (어떤 프롬프트를 보냈는지 대형 텍스트)

    [v4 신규] agent_progress 행은 서브에이전트의 tool_result를 감싸는 wrapper.
    기존 clean_tool_result_content()는 obj.message 경로만 보기 때문에
    obj.data.message.message 경로에 있는 데이터를 놓침.
    """
    try:
        if obj.get("type") != "progress":
            return False
        data = obj.get("data", {})
        if not isinstance(data, dict) or data.get("type") != "agent_progress":
            return False

        cleaned = False

        # 1. data.prompt 치환
        if "prompt" in data:
            original = data["prompt"]
            if isinstance(original, str) and original and original != CLEANED_AGENT_PROMPT:
                stats.agent_progress_bytes += len(original.encode("utf-8"))
                data["prompt"] = CLEANED_AGENT_PROMPT
                cleaned = True

        # 2. data.message.message.content[N] 처리
        message_wrapper = data.get("message", {})
        if isinstance(message_wrapper, dict):
            inner_message = message_wrapper.get("message", {})
            if isinstance(inner_message, dict):
                content_list = inner_message.get("content", [])
                if isinstance(content_list, list):
                    for item in content_list:
                        if not isinstance(item, dict):
                            continue

                        # 2a. content 필드 처리 (tool_result의 결과)
                        if "content" in item:
                            content_val = item["content"]
                            if isinstance(content_val, str):
                                # string인 경우 전체 치환
                                if content_val and content_val != CLEANED_TOOL_RESULT:
                                    stats.agent_progress_bytes += len(content_val.encode("utf-8"))
                                    item["content"] = CLEANED_TOOL_RESULT
                                    cleaned = True
                            elif isinstance(content_val, list):
                                # list인 경우: [{type: "text", text: "..."}, ...] 내부 text만 치환
                                for sub_item in content_val:
                                    if isinstance(sub_item, dict) and "text" in sub_item:
                                        text_val = sub_item["text"]
                                        if text_val and text_val != CLEANED_TOOL_RESULT:
                                            stats.agent_progress_bytes += len(str(text_val).encode("utf-8"))
                                            sub_item["text"] = CLEANED_TOOL_RESULT
                                            cleaned = True

                        # 2b. input.command 필드 처리 (agent 내부 bash 입력)
                        inp = item.get("input", {})
                        if isinstance(inp, dict) and "command" in inp:
                            cmd_val = inp["command"]
                            if isinstance(cmd_val, str) and cmd_val and cmd_val != CLEANED_BASH_INPUT:
                                stats.agent_progress_bytes += len(cmd_val.encode("utf-8"))
                                inp["command"] = CLEANED_BASH_INPUT
                                cleaned = True
                        # 2c. text 필드 처리 (agent_prompt 중복 텍스트)
                        if item.get("type") == "text" and "text" in item:
                            text_val = item["text"]
                            if isinstance(text_val, str) and len(text_val) > 100 and "[context-cleaner:" not in text_val:
                                stats.agent_progress_bytes += len(text_val.encode("utf-8"))
                                item["text"] = CLEANED_AGENT_PROMPT
                                cleaned = True

        if cleaned:
            stats.agent_progress_count += 1
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


def clean_base64_images(obj, stats):
    """
    base64 인코딩된 이미지 데이터 정리 (user 행)
    - message.content 배열 내 type=="image"인 항목의 source.data를 치환
    - source.type, source.media_type 등 구조는 보존
    - data 값만 placeholder로 치환

    [v4 신규] 스크린샷 등 이미지 첨부 시 수십만~수백만 자의 base64 데이터가
    포함되어 파일 크기의 상당 부분을 차지. resume 시 이미지는 불필요하므로 치환.
    """
    try:
        message = obj.get("message", {})
        if not isinstance(message, dict) or "content" not in message:
            return False
        content = message["content"]
        if not isinstance(content, list):
            return False

        cleaned = False
        for item in content:
            if isinstance(item, dict) and item.get("type") == "image":
                source = item.get("source", {})
                if isinstance(source, dict) and "data" in source:
                    data = source["data"]
                    if data and data != CLEANED_BASE64_IMAGE:
                        stats.base64_image_bytes += len(str(data).encode("utf-8"))
                        source["data"] = CLEANED_BASE64_IMAGE
                        stats.base64_image_count += 1
                        cleaned = True
                    # media_type은 data 치환과 독립적으로 항상 확인
                    if source.get("media_type") != "image/png":
                        source["media_type"] = "image/png"
                        cleaned = True
        return cleaned
    except Exception:
        pass
    return False


def clean_tool_use_result_string(obj, stats):
    """
    toolUseResult.result (string) 정리
    - WebFetch 등의 도구가 반환하는 result 문자열 (수천 자)
    - bytes, code, codeText, durationMs, url 등 메타데이터는 보존
    """
    try:
        result = obj.get("toolUseResult", {})
        if isinstance(result, dict) and "result" in result:
            result_val = result["result"]
            if isinstance(result_val, str) and len(result_val) > 200 and result_val != CLEANED_TOOL_RESULT_STRING:
                stats.tool_result_string_bytes += len(result_val.encode("utf-8"))
                stats.tool_result_string_count += 1
                result["result"] = CLEANED_TOOL_RESULT_STRING
                return True
    except Exception:
        pass
    return False


def clean_teammate_message(obj, stats):
    """
    teammate-message 태그 내부 콘텐츠 정리
    - type: "user" + teamName이 있는 메시지의 message.content에서
      <teammate-message ...>본문</teammate-message> 의 본문만 placeholder로 치환
    - 여는 태그(summary, teammate_id, color 속성 포함)와 닫는 태그는 보존
    """
    try:
        if obj.get("type") != "user" or not obj.get("teamName"):
            return False
        message = obj.get("message", {})
        if not isinstance(message, dict):
            return False
        content = message.get("content", "")
        if not isinstance(content, str) or "<teammate-message" not in content:
            return False

        cleaned = TEAMMATE_MESSAGE_PATTERN.sub(
            r'\1[context-cleaner: teammate_message]\2', content
        )
        if cleaned != content:
            stats.teammate_message_bytes += len(content.encode("utf-8")) - len(cleaned.encode("utf-8"))
            stats.teammate_message_count += 1
            message["content"] = cleaned
            return True
    except Exception:
        pass
    return False

def clean_tool_use_result_prompt(obj, stats):
    """
    toolUseResult.prompt 정리 (누락 보완)
    - toolUseResult가 dict이고 prompt 키가 있는 모든 경우를 커버
    - status: "teammate_spawned", "async_launched" 등에서 누락된 prompt 치환
    - 이미 clean_task_content_text()가 처리하는 content+prompt 조합은 그 함수에서 처리됨
    - 이 함수는 content 키가 없지만 prompt가 있는 나머지 케이스를 보완
    """
    try:
        result = obj.get("toolUseResult", {})
        if not isinstance(result, dict):
            return False
        prompt_val = result.get("prompt")
        if not isinstance(prompt_val, str):
            return False
        if len(prompt_val) <= 100:
            return False
        if "[context-cleaner:" in prompt_val:
            return False

        stats.tool_use_result_prompt_bytes += len(prompt_val.encode("utf-8"))
        stats.tool_use_result_prompt_count += 1
        result["prompt"] = CLEANED_AGENT_PROMPT
        return True
    except Exception:
        pass
    return False


def clean_tool_use_input_prompt(obj, stats):
    """
    tool_use의 input.prompt 정리 (assistant 행)
    - message.content[N].type == "tool_use" 인 항목의 input.prompt 치환
    - Task, call_omo_agent 등 서브에이전트 호출 시 대형 프롬프트가 저장됨
    - input의 다른 키(description, model, subagent_type, name 등)는 모두 보존
    - 경로A: tool_use input.prompt (이 함수)
    - 경로B: agent_progress data.prompt (clean_agent_progress)
    - 경로C: toolUseResult.prompt (clean_tool_use_result_prompt, clean_task_content_text)
    """
    try:
        content = obj.get("message", {}).get("content", [])
        if not isinstance(content, list):
            return False

        cleaned = False
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") != "tool_use":
                continue
            inp = item.get("input", {})
            if not isinstance(inp, dict):
                continue
            prompt_val = inp.get("prompt")
            if not isinstance(prompt_val, str):
                continue
            if len(prompt_val) <= 100:
                continue
            if "[context-cleaner:" in prompt_val:
                continue

            stats.tool_use_input_prompt_bytes += len(prompt_val.encode("utf-8"))
            stats.tool_use_input_prompt_count += 1
            inp["prompt"] = CLEANED_AGENT_PROMPT
            cleaned = True

        return cleaned
    except Exception:
        pass
    return False


def clean_local_command_stdout(obj, stats):
    """
    <local-command-stdout> 태그 내부 대형 콘텐츠 정리
    - type: user + message.content가 string + <local-command-stdout> 포함 + 200자 초과
    - 여는 태그와 닫는 태그는 보존, 내부 내용만 placeholder로 치환
    - ANSI 이스케이프 코드를 포함한 Context Usage 출력 등
    """
    try:
        if obj.get("type") != "user":
            return False
        message = obj.get("message", {})
        if not isinstance(message, dict):
            return False
        content = message.get("content", "")
        if not isinstance(content, str):
            return False
        if "<local-command-stdout>" not in content:
            return False
        if len(content) <= 200:
            return False
        if "[context-cleaner:" in content:
            return False

        cleaned = LOCAL_COMMAND_STDOUT_PATTERN.sub(
            r'\1[context-cleaner: local_command_stdout]\2', content
        )
        if cleaned != content:
            stats.local_command_stdout_bytes += len(content.encode("utf-8")) - len(cleaned.encode("utf-8"))
            stats.local_command_stdout_count += 1
            message["content"] = cleaned
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
def process_line(obj, new_session_id, stats):
    """
    파싱된 JSON 객체 1개에 대해 모든 클리닝을 적용하는 통합 함수.
    clean_transcript의 1단계에서 호출됨.

    [v2 → v4 변경]
    - v2: 이 함수가 존재했지만 clean_transcript에서 호출하지 않고
      인라인으로 동일 로직을 중복 작성. 게다가 clean_task_output,
      clean_bash_progress 등 7개 함수 호출이 누락된 불완전한 dead code.
    - v4: clean_transcript가 이 함수를 호출하도록 통합.
      모든 클리닝 함수를 빠짐없이 포함.
    """
    # sessionId 업데이트
    update_session_id(obj, new_session_id, stats)

    # 도구별 클리닝 (순서대로 적용, 각 함수는 독립적이므로 모두 실행)
    clean_thinking(obj, stats)
    clean_attachment(obj, stats)                # attachment (skill 목록 / 첨부 파일)
    clean_read_result(obj, stats)
    clean_write_input(obj, stats)
    clean_write_result(obj, stats)
    clean_edit_input(obj, stats)
    clean_edit_result(obj, stats)
    clean_bash_input(obj, stats)
    clean_bash_result(obj, stats)
    clean_filenames_result(obj, stats)          # Grep/Glob 결과
    clean_exitplanmode_input(obj, stats)
    clean_tool_result_content(obj, stats)       # message.content[0].content (tool_result)
    clean_list_tool_use_result(obj, stats)      # toolUseResult가 list인 경우
    clean_task_output(obj, stats)               # Task agent output
    clean_task_content_text(obj, stats)           # Task content 내부 text
    clean_bash_progress(obj, stats)             # bash_progress 데이터
    clean_agent_progress(obj, stats)             # agent_progress 데이터
    clean_input_filepath(obj, stats)            # input의 file_path → 파일명만
    clean_bash_tags(obj, stats)                 # <bash-stdout>...<bash-stderr>... 패턴
    clean_user_marked(obj, stats)               # <clean>...</clean> 패턴
    clean_meta_content(obj, stats)              # isMeta (Skill 결과 등)
    clean_base64_images(obj, stats)              # base64 이미지 데이터
    clean_tool_use_result_string(obj, stats)   # toolUseResult.result (string)
    clean_teammate_message(obj, stats)          # teammate-message 내부 콘텐츠
    clean_tool_use_result_prompt(obj, stats)  # toolUseResult.prompt (누락 보완)
    clean_local_command_stdout(obj, stats)    # <local-command-stdout> 태그
    clean_tool_use_input_prompt(obj, stats)  # tool_use input.prompt (경로A)


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

    # 1단계: 도구별 클리닝 적용
    # process_line()에 모든 클리닝 로직을 위임하여 단일 책임 유지
    processed_objs = []
    for line in lines:
        line = line.rstrip("\n")
        if line:
            try:
                obj = json.loads(line)
                process_line(obj, new_session_id, stats)
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
        print("Usage: context-cleaner.py <transcript_path>", file=sys.stderr)
        print(
            "Example: ./context-cleaner.py /path/to/session.jsonl", file=sys.stderr
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
