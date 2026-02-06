#!/bin/bash
set -e

SKILL_DIR="$HOME/.claude/skills/context-cleaner"
REPO="professional-ALFIE/context-cleaner-skill"
BRANCH="master"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/.claude/skills/context-cleaner"

echo "Installing context-cleaner skill..."

mkdir -p "$SKILL_DIR/scripts" "$SKILL_DIR/src"

curl -sL "$BASE_URL/SKILL.md" -o "$SKILL_DIR/SKILL.md"
curl -sL "$BASE_URL/scripts/context-cleaner.py" -o "$SKILL_DIR/scripts/context-cleaner.py"
curl -sL "$BASE_URL/src/contextCleaner_sessionStartHook.sh" -o "$SKILL_DIR/src/contextCleaner_sessionStartHook.sh"

chmod +x "$SKILL_DIR/scripts/"* "$SKILL_DIR/src/"*

echo ""
echo "Installed to: $SKILL_DIR"
echo "Done!"
