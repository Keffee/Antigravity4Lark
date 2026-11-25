#!/usr/bin/env bash
# Optional enhancement: relaunch Antigravity desktop with Chrome DevTools Protocol enabled
# (default port 9223, avoiding Cursor's 9222) so the Feishu bridge can click approval/stop buttons.
# Runs outside Antigravity's process tree via a one-shot LaunchAgent.
set -euo pipefail

PORT="${CDP_PORT:-9223}"

if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "Port ${PORT} already has a CDP endpoint."
  exit 0
fi

LABEL="com.antigravity-feishu.relaunch"
UID_NUM="$(id -u)"
STATE_DIR="${AG_STATE_DIR:-$HOME/.antigravity-feishu}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$STATE_DIR/start-antigravity.log"
WORKER="$STATE_DIR/relaunch-antigravity.sh"

mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE_DIR"

cat >"$WORKER" <<EOF
#!/bin/bash
set -u
PORT='$PORT'
LABEL='$LABEL'
PLIST='$PLIST'
LOG='$LOG'
MAIN_PATTERN='^/Applications/Antigravity\.app/Contents/MacOS/Antigravity( |$)'
exec >> "\$LOG" 2>&1
echo "\$(date) relaunch worker start pid \$\$"

cleanup() {
  launchctl bootout "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1 || true
  rm -f "\$PLIST"
}
trap cleanup EXIT

if pgrep -f "\$MAIN_PATTERN" >/dev/null; then
  echo "\$(date) asking Antigravity to quit"
  osascript -e 'tell application id "com.google.antigravity" to quit' >/dev/null 2>&1 || true
  for _ in \$(seq 1 40); do
    pgrep -f "\$MAIN_PATTERN" >/dev/null || break
    sleep 0.5
  done
  if pgrep -f "\$MAIN_PATTERN" >/dev/null; then
    echo "\$(date) quit was blocked; sending SIGTERM"
    pkill -TERM -f "\$MAIN_PATTERN" || true
    for _ in \$(seq 1 60); do
      pgrep -f "\$MAIN_PATTERN" >/dev/null || break
      sleep 0.5
    done
  fi
  if pgrep -f "\$MAIN_PATTERN" >/dev/null; then
    echo "\$(date) Antigravity did not quit; aborted"
    exit 1
  fi
  sleep 1
fi

echo "\$(date) opening Antigravity with debug port \$PORT"
open -a Antigravity --args --remote-debugging-port="\$PORT"
for _ in \$(seq 1 40); do
  if curl -sf --max-time 1 "http://127.0.0.1:\${PORT}/json/version" >/dev/null; then
    echo "\$(date) Antigravity up with CDP on \$PORT"
    exit 0
  fi
  sleep 1
done
echo "\$(date) Antigravity started but CDP port \$PORT is not responding"
exit 1
EOF
chmod +x "$WORKER"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WORKER}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
echo "已交给系统独立进程重启 Antigravity（CDP 端口 ${PORT}）。历史对话保留在本地。日志：${LOG}"
