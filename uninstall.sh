#!/bin/bash
# OpenLog — Uninstall background service

PLIST_NAME="com.openlog.dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo ""
echo "  OpenLog — Uninstalling background service"
echo ""

launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"

echo "  Service stopped and removed."
echo "  Your data in ~/.claude/ is untouched."
echo ""
