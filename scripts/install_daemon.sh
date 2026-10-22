#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
OS_TYPE="$(uname -s)"
ACTION="${1:-install}"

mkdir -p "$PROJECT_DIR/data"

if [[ "$OS_TYPE" == "Darwin" ]]; then
  # Reuse existing plist label if already installed on this Mac, or default to generic label
  EXISTING_PLIST="$(find "$HOME/Library/LaunchAgents" -maxdepth 1 -name "*wechat-as-context*.plist" 2>/dev/null | head -n 1 || true)"
  if [[ -z "${WECHAT_CONTEXT_DAEMON_LABEL:-}" && -n "$EXISTING_PLIST" && -f "$EXISTING_PLIST" ]]; then
    SERVICE_LABEL="$(basename "$EXISTING_PLIST" .plist)"
  else
    SERVICE_LABEL="${WECHAT_CONTEXT_DAEMON_LABEL:-com.wechat-as-context.daemon}"
  fi
  PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"

  if [[ "$ACTION" == "--uninstall" || "$ACTION" == "uninstall" ]]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "🛑 已卸载 macOS LaunchAgent 守护进程: $PLIST_PATH"
    exit 0
  fi

  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN_BIN}</string>
    <string>run</string>
    <string>${PROJECT_DIR}/src/server.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${HOME}/.local/bin:${HOME}/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PROJECT_DIR}/data/daemon.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${PROJECT_DIR}/data/daemon.stderr.log</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
  echo "✅ 已安装并启动 macOS 后台守护进程: $PLIST_PATH"
  echo "   工作目录: $PROJECT_DIR"
  echo "   日志文件: $PROJECT_DIR/data/daemon.stdout.log"

elif [[ "$OS_TYPE" == "Linux" ]]; then
  SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  SERVICE_NAME="wechat-as-context.service"
  SERVICE_PATH="$SYSTEMD_USER_DIR/$SERVICE_NAME"

  if [[ "$ACTION" == "--uninstall" || "$ACTION" == "uninstall" ]]; then
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$SERVICE_PATH"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "🛑 已卸载 Linux systemd 守护进程: $SERVICE_PATH"
    exit 0
  fi

  mkdir -p "$SYSTEMD_USER_DIR"

  cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=wechat-as-context Background Daemon (WeChat ClawBot Long-Polling Bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment="HOME=${HOME}"
Environment="PATH=${HOME}/.local/bin:${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=${BUN_BIN} run ${PROJECT_DIR}/src/server.ts
Restart=always
RestartSec=5
StandardOutput=append:${PROJECT_DIR}/data/daemon.stdout.log
StandardError=append:${PROJECT_DIR}/data/daemon.stderr.log

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  echo "✅ 已安装并启动 Linux systemd 用户级守护进程: $SERVICE_PATH"
  echo "   查看状态: systemctl --user status $SERVICE_NAME"
  echo "   日志文件: $PROJECT_DIR/data/daemon.stdout.log"
else
  echo "⚠️ 当前系统 ($OS_TYPE) 暂未内置系统级守护脚本，请直接运行: bun run start"
  exit 1
fi
