#!/usr/bin/env bash
# Build and install a macOS launcher app (~/Applications/Antigravity CDP.app)
# that always starts or focuses Antigravity with --remote-debugging-port=9223.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${1:-$HOME/Applications/Antigravity CDP.app}"
PORT="${CDP_PORT:-9223}"
START_SCRIPT="$DIR/start-antigravity.sh"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

if [[ -f /Applications/Antigravity.app/Contents/Resources/icon.icns ]]; then
  cp /Applications/Antigravity.app/Contents/Resources/icon.icns "$APP_DIR/Contents/Resources/icon.icns"
fi

cat > "$APP_DIR/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity CDP</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundleIdentifier</key>
  <string>com.antigravity-feishu.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Antigravity CDP</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF

cat > "$APP_DIR/Contents/MacOS/launcher" << EOF
#!/usr/bin/env bash
set -euo pipefail

PORT="\${CDP_PORT:-$PORT}"
MAIN_PATTERN='^/Applications/Antigravity\.app/Contents/MacOS/Antigravity( |\$)'

# 1. CDP already online -> focus Antigravity without interrupting running sessions
if curl -sf --max-time 1 "http://127.0.0.1:\${PORT}/json/version" >/dev/null 2>&1; then
  open -a Antigravity
  exit 0
fi

# 2. Not running -> launch directly with CDP debugging port enabled
if ! pgrep -f "\$MAIN_PATTERN" >/dev/null 2>&1; then
  open -a Antigravity --args --remote-debugging-port="\${PORT}"
  exit 0
fi

# 3. Running without CDP -> gracefully relaunch with CDP debugging port enabled
exec "$START_SCRIPT"
EOF

chmod +x "$APP_DIR/Contents/MacOS/launcher"
touch "$APP_DIR"
echo "已安装快捷启动器：$APP_DIR"
echo "可在 Spotlight / Raycast 搜索 \"Antigravity CDP\" 或拖入 Dock 使用。"
