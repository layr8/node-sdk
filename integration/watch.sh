#!/usr/bin/env bash
# Watch Claude Code's stream-json output for the integration test suite.
# Usage: ./integration/watch.sh [logfile]
# Default logfile: /tmp/claude-integration.jsonl

set -euo pipefail

LOGFILE="${1:-/tmp/claude-integration.jsonl}"

if [[ ! -f "$LOGFILE" ]]; then
  echo "Log file not found: $LOGFILE"
  echo "Start claude with: claude --dangerously-skip-permissions --verbose --output-format stream-json -p '...' > $LOGFILE 2>&1"
  exit 1
fi

tail -f "$LOGFILE" | grep --line-buffered '^{' | jq -r --unbuffered '
  if .type == "assistant" then
    .message.content[] |
    if .type == "text" then "\n\u001b[36m💬 " + .text + "\u001b[0m\n"
    elif .type == "tool_use" then
      if .name == "Bash" then
        "  \u001b[33m$ " + (.input.command // "" | .[0:200]) + "\u001b[0m"
      elif .name == "Read" then
        "  \u001b[2m📄 " + (.input.file_path // "") + "\u001b[0m"
      elif .name == "Write" then
        "  \u001b[32m✏️  " + (.input.file_path // "") + "\u001b[0m"
      elif .name == "Edit" then
        "  \u001b[32m✏️  " + (.input.file_path // "") + "\u001b[0m"
      elif .name == "Glob" then
        "  \u001b[2m🔍 " + (.input.pattern // "") + "\u001b[0m"
      elif .name == "Grep" then
        "  \u001b[2m🔍 " + (.input.pattern // "") + " in " + (.input.path // ".") + "\u001b[0m"
      elif .name == "Agent" then
        "  \u001b[35m🤖 agent: " + (.input.description // "") + "\u001b[0m"
      elif .name == "TodoWrite" then
        empty
      else
        "  \u001b[2m🔧 " + .name + " → " + (.input | tostring | .[0:120]) + "\u001b[0m"
      end
    else empty end
  elif .type == "tool_result" then
    if (.content // "" | length) > 0 then
      .content | if length > 500 then .[0:500] + "..." else . end |
      "  \u001b[2m   ↪ " + (. | gsub("\n"; "\n       ") | .[0:500]) + "\u001b[0m"
    else empty end
  elif .type == "result" then
    "\n\u001b[32;1m✅ SESSION COMPLETE\u001b[0m\n"
  else empty end'
