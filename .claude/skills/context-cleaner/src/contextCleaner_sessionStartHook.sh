#!/bin/bash
# SessionStart hook: session info injection + context-cleaner detection
# - Every session: echo session info to Claude context + write to CLAUDE_ENV_FILE
# - Effaced sessions: additional context-cleaner notice
# - Always: copy resume command to clipboard

# stdin에서 JSON 입력 읽기
input_var=$(cat)
session_id_var=$(echo "$input_var" | jq -r '.session_id')
transcript_path_var=$(echo "$input_var" | jq -r '.transcript_path // ""')

# Claude 컨텍스트에 세션 정보 출력 (stdout → system-reminder)
echo "Session ID: $session_id_var"
echo "Transcript: $transcript_path_var"

# CLAUDE_ENV_FILE에 환경변수 저장 (Bash 도구에서 사용 가능)
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export SESSION_ID=\"$session_id_var\"" >> "$CLAUDE_ENV_FILE"
  echo "export TRANSCRIPT_PATH=\"$transcript_path_var\"" >> "$CLAUDE_ENV_FILE"
fi

# resume 명령어를 클립보드에 복사
resume_cmd_var="claude --resume $session_id_var --verbose"
echo "$resume_cmd_var" | pbcopy
echo "Copied to clipboard: $resume_cmd_var"

# 00effaced{NNN} 패턴 확인 (context-cleaner로 정리된 세션)
last_12_var="${session_id_var: -12}"
if [[ "$last_12_var" =~ ^00effaced[0-9]{3}$ ]]; then
  echo "This is a context-cleaned session."
  echo "- Removed: thinking blocks, toolUseResult contents, full file paths"
  echo "- Preserved: conversation history, edit intent, filenames"
  echo "- Effect: better token efficiency and context retention than session compact."
fi

exit 0
