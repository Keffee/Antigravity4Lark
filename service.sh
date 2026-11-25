#!/usr/bin/env bash
# Manage the Antigravity Feishu bridge as a macOS LaunchAgent.
# Usage: ./service.sh install | uninstall | status | logs | restart
set -euo pipefail

LABEL="com.antigravity-feishu.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${AG_STATE_DIR:-$HOME/.antigravity-feishu}"
LOG="$STATE_DIR/server.log"
NODE_BIN="$HOME/.local/bin/node/bin"
SERVICE_PATH="$NODE_BIN:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$SERVICE_PATH"
NODE="$(command -v node)"
UID_NUM="$(id -u)"

case "${1:-}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/feishu.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 20); do
      launchctl list | grep -qF "$LABEL" || break
      sleep 0.5
    done
    launchctl bootstrap "gui/$UID_NUM" "$PLIST"
    echo "已安装并启动。日志：$LOG"
    ;;
  uninstall)
    launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已停止并移除开机自启"
    ;;
  restart)
    if [[ ! -f "$PLIST" ]]; then
      echo "尚未安装 LaunchAgent，请先执行：$0 install" >&2
      exit 1
    fi
    if launchctl list | grep -qF "$LABEL"; then
      launchctl kickstart -k "gui/$UID_NUM/$LABEL"
    else
      launchctl bootstrap "gui/$UID_NUM" "$PLIST"
    fi
    echo "已重启服务。日志：$LOG"
    ;;
  status)
    line="$(launchctl list | grep -F "$LABEL" || true)"
    pid="$(echo "$line" | awk '{print $1}')"
    if [[ -n "$pid" && "$pid" != "-" ]]; then
      echo "运行中 (pid $pid)"
    else
      echo "未运行"
    fi
    ;;
  logs)
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    touch "$LOG"
    tail -n 50 -f "$LOG"
    ;;
  *)
    echo "用法：$0 install | uninstall | status | logs | restart"
    exit 1
    ;;
esac
