#!/bin/bash
# OpenLog — Install as always-on macOS background service
# This creates a LaunchAgent that starts OpenLog when you log in.

set -e

OPENLOG_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.openlog.dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
BUN_PATH="$HOME/.bun/bin/bun"
PORT="${PORT:-7777}"

# Check bun exists
if [ ! -f "$BUN_PATH" ]; then
  echo "Error: Bun not found at $BUN_PATH"
  echo "Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo ""
echo "  OpenLog — Installing background service"
echo "  ────────────────────────────────────────"
echo ""
echo "  Server:  $OPENLOG_DIR/server.ts"
echo "  Port:    $PORT"
echo "  Plist:   $PLIST_PATH"
echo ""

# Unload existing if present
launchctl unload "$PLIST_PATH" 2>/dev/null || true

# Write the plist
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BUN_PATH}</string>
        <string>run</string>
        <string>${OPENLOG_DIR}/server.ts</string>
        <string>--port</string>
        <string>${PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${OPENLOG_DIR}/openlog.log</string>
    <key>StandardErrorPath</key>
    <string>${OPENLOG_DIR}/openlog.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

# Load it
launchctl load "$PLIST_PATH"

# Add openlog.local to /etc/hosts if not present
if ! grep -q "openlog.local" /etc/hosts 2>/dev/null; then
  echo ""
  echo "  Adding openlog.local to /etc/hosts (requires password)..."
  sudo sh -c 'echo "127.0.0.1 openlog.local" >> /etc/hosts' 2>/dev/null && \
    echo "  Added openlog.local" || \
    echo "  Skipped (no sudo). Access via localhost:${PORT} instead."
fi

# Port redirect: 80 → 7777 so http://openlog.local works without :port
ANCHOR_FILE="/etc/pf.anchors/openlog"
if [ ! -f "$ANCHOR_FILE" ]; then
  echo ""
  echo "  Setting up port redirect (80 → ${PORT})..."
  sudo sh -c "echo 'rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${PORT}' > /etc/pf.anchors/openlog" 2>/dev/null
  # Add anchor to pf.conf if not present
  if ! grep -q "openlog" /etc/pf.conf 2>/dev/null; then
    sudo sh -c 'echo "rdr-anchor \"openlog\"" >> /etc/pf.conf && echo "load anchor \"openlog\" from \"/etc/pf.anchors/openlog\"" >> /etc/pf.conf' 2>/dev/null
  fi
  sudo pfctl -ef /etc/pf.conf 2>/dev/null && \
    echo "  Port redirect active: http://openlog.local" || \
    echo "  Port redirect failed. Use http://openlog.local:${PORT} instead."
fi

echo ""
echo "  Done. OpenLog is now running at:"
echo ""
echo "    http://openlog.local"
echo "    http://localhost:${PORT}"
echo ""
echo "  It will auto-start on login."
echo "  To stop:   launchctl unload $PLIST_PATH"
echo "  To logs:   tail -f $OPENLOG_DIR/openlog.log"
echo ""
