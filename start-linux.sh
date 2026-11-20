#!/bin/sh
# ContinuousAgent 在 Linux / macOS 上的启动脚本（对照 Windows 的 start-windows.ps1）
#
# 用法:
#   ./start-linux.sh                 构建（如需）+ 前台启动
#   ./start-linux.sh --port 8080     指定端口（默认 7800）
#   ./start-linux.sh --host 0.0.0.0  指定监听地址（默认 127.0.0.1）
#   ./start-linux.sh --no-build      跳过构建（要求 dist 已存在）
#   ./start-linux.sh --no-open       不尝试打开浏览器
#   ./start-linux.sh --daemon        后台运行（nohup），日志写入数据目录
#   ./start-linux.sh --stop          停止后台运行的实例
#   ./start-linux.sh --status        查看后台实例状态
#   ./start-linux.sh --check-env     只检测运行环境，不安装也不启动
#   ./start-linux.sh --no-auto-install  缺 Node.js 时不自动安装，直接报错
#   ./start-linux.sh --help          显示帮助
#
# 环境变量（命令行参数优先）:
#   PORT                       监听端口，默认 7800
#   HOST                       监听地址，默认 127.0.0.1
#   CONTINUOUS_AGENT_DATA_DIR  数据目录，默认 ~/.config/ContinuousAgent
#   LOG_FILE                   后台模式日志路径，默认 <数据目录>/agent.log
#   PID_FILE                   后台模式 pid 文件，默认 <数据目录>/agent.pid
#   CA_NODE_HOME               自动安装 Node.js 的位置，默认 ~/.local/lib/node
#   CA_NODE_SERIES             自动安装的 Node.js 大版本（LTS），默认 22
#
# 运行环境: 需要 Node.js >= 20 与 npm。首次运行若检测不到，会从 nodejs.org
# 下载官方发行包解压到 $CA_NODE_HOME（无需 root，不改系统目录与 shell 配置）。
#
# 说明: 兼容 POSIX sh（dash/busybox 都能跑），不依赖 bash。

set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$APP_DIR"

PORT=${PORT:-7800}
HOST=${HOST:-127.0.0.1}
DATA_DIR=${CONTINUOUS_AGENT_DATA_DIR:-$HOME/.config/ContinuousAgent}
LOG_FILE=${LOG_FILE:-$DATA_DIR/agent.log}
PID_FILE=${PID_FILE:-$DATA_DIR/agent.pid}

NO_BUILD=0
DAEMON=0
NO_OPEN=0
AUTO_INSTALL=1
ACTION=run

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

usage() {
  # 只打印文件头的注释块：跳过 shebang，遇到第一行非注释即停止
  # （不要用固定行号范围，头部注释一变长就会把源码打出来）
  awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

# ---------- 参数 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --port|-p)
      [ $# -ge 2 ] || die "--port 需要一个数字"
      PORT=$2
      shift 2
      ;;
    --port=*)
      PORT=${1#*=}
      shift
      ;;
    --host)
      [ $# -ge 2 ] || die "--host 需要一个地址"
      HOST=$2
      shift 2
      ;;
    --host=*)
      HOST=${1#*=}
      shift
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --daemon|-d)
      DAEMON=1
      shift
      ;;
    --no-open)
      NO_OPEN=1
      shift
      ;;
    --check-env)
      ACTION=check
      shift
      ;;
    --no-auto-install)
      AUTO_INSTALL=0
      shift
      ;;
    --stop)
      ACTION=stop
      shift
      ;;
    --status)
      ACTION=status
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "未知参数: $1（用 --help 查看用法）"
      ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) die "端口必须是数字: $PORT" ;;
esac

# ---------- 工具函数 ----------
pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

# 确认 pid 确实是本项目的服务进程，避免杀错别人的进程
pid_is_ours() {
  pid=$1
  [ -r "/proc/$pid/cmdline" ] || return 0   # 无 /proc（如 macOS）时不做这项校验
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'dist/server/index\.js'
}

read_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
  [ -n "$pid" ] || return 1
  printf '%s' "$pid"
}

http_ready() {
  # 用 node 自带的 fetch 探活，避免依赖 curl
  # 监听地址是 0.0.0.0 / :: 时不能当连接目标（macOS 上必然失败），改用回环地址探
  host=$1
  case "$host" in
    0.0.0.0|'::'|'[::]') host=127.0.0.1 ;;
  esac
  node -e "fetch('http://$host:$2/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

# ---------- stop / status ----------
if [ "$ACTION" = "stop" ]; then
  if ! pid=$(read_pid); then
    info "没有找到 pid 文件（$PID_FILE），后台实例可能没在运行。"
    exit 0
  fi
  if ! pid_alive "$pid"; then
    info "进程 $pid 已不存在，清理 pid 文件。"
    rm -f "$PID_FILE"
    exit 0
  fi
  pid_is_ours "$pid" || die "pid $pid 不是本项目的服务进程，已放弃。请手动检查 $PID_FILE"
  info "正在停止进程 $pid ..."
  kill "$pid" 2>/dev/null || true
  i=0
  while pid_alive "$pid" && [ "$i" -lt 20 ]; do
    sleep 0.5
    i=$((i + 1))
  done
  if pid_alive "$pid"; then
    info "进程未在 10 秒内退出，强制终止。"
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
  fi
  if pid_alive "$pid"; then
    die "无法终止进程 $pid"
  fi
  rm -f "$PID_FILE"
  info "已停止。"
  exit 0
fi

if [ "$ACTION" = "status" ]; then
  if ! pid=$(read_pid); then
    info "未在运行（无 pid 文件：$PID_FILE）"
    exit 1
  fi
  if pid_alive "$pid"; then
    if http_ready "$HOST" "$PORT"; then
      info "运行中：pid $pid，http://$HOST:$PORT 可访问"
    else
      info "进程存在（pid $pid），但 http://$HOST:$PORT 暂无响应（可能仍在启动）"
    fi
    exit 0
  fi
  info "未在运行（pid 文件里的 $pid 已退出）"
  exit 1
fi

# ---------- 运行环境检测（首次运行会自动安装） ----------
# 必需运行环境：Node.js >= 20（口径来自 package.json 的 engines.node）与 npm。
# 缺失时从 nodejs.org 取官方发行包，解压到 $NODE_HOME（无需 root），
# 只对本次运行把它加进 PATH，不动系统目录、不改用户 shell 配置。
NODE_MIN_MAJOR=${CA_NODE_MIN_MAJOR:-20}
NODE_SERIES=${CA_NODE_SERIES:-22}
NODE_HOME=${CA_NODE_HOME:-$HOME/.local/lib/node}
NODE_DIST=${CA_NODE_DIST:-https://nodejs.org/dist}

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  _v=$(node -v 2>/dev/null) || return 1
  _v=${_v#v}
  case "$_v" in ''|*[!0-9.]*) return 1 ;; esac
  printf '%s' "${_v%%.*}"
}

# 返回 0 表示环境可用；否则把原因写进 ENV_PROBLEM
env_check() {
  ENV_PROBLEM=''
  _major=$(node_major 2>/dev/null || true)
  if [ -z "$_major" ]; then
    ENV_PROBLEM="未找到 Node.js（要求 >= $NODE_MIN_MAJOR）"
  elif [ "$_major" -lt "$NODE_MIN_MAJOR" ]; then
    ENV_PROBLEM="Node.js 版本过低（当前 $(node -v)，要求 >= $NODE_MIN_MAJOR）"
  elif ! command -v npm >/dev/null 2>&1; then
    ENV_PROBLEM="未找到 npm（Node.js $(node -v) 本应自带，请检查安装是否完整）"
  fi
  [ -z "$ENV_PROBLEM" ]
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 120 -O "$2" "$1"
  else
    return 127
  fi
}

node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    armv7l|armv6l) printf 'armv7l' ;;
    ppc64le) printf 'ppc64le' ;;
    s390x) printf 's390x' ;;
    *) return 1 ;;
  esac
}

install_node() {
  _arch=$(node_arch) || { info "不支持的 CPU 架构：$(uname -m)"; return 1; }
  command -v tar >/dev/null 2>&1 || { info "缺少 tar，无法解压安装包"; return 1; }
  _tmp=$(mktemp -d 2>/dev/null) || _tmp="/tmp/ca-node-install.$$"
  mkdir -p "$_tmp" || return 1

  info "正在查询 Node.js v$NODE_SERIES.x 最新版本…"
  if ! download "$NODE_DIST/latest-v$NODE_SERIES.x/SHASUMS256.txt" "$_tmp/SHASUMS256.txt"; then
    info "无法获取版本清单（网络不可用，或 $NODE_DIST 不可达）"
    rm -rf "$_tmp"
    return 1
  fi
  # 选 .tar.gz 而不是 .tar.xz：只依赖 gzip，不要求系统装 xz
  _file=$(grep "linux-$_arch\.tar\.gz" "$_tmp/SHASUMS256.txt" | head -n 1 | awk '{print $2}')
  if [ -z "$_file" ]; then
    info "版本清单里没有 linux-$_arch 的发行包"
    rm -rf "$_tmp"
    return 1
  fi
  _ver=${_file#node-v}
  _ver=${_ver%-linux-*}

  info "正在下载 $_file（约 50MB）…"
  if ! download "$NODE_DIST/v$_ver/$_file" "$_tmp/$_file"; then
    info "下载失败：$NODE_DIST/v$_ver/$_file"
    rm -rf "$_tmp"
    return 1
  fi
  _sha=$(grep " $_file\$" "$_tmp/SHASUMS256.txt" | awk '{print $1}')
  if [ -n "$_sha" ] && command -v sha256sum >/dev/null 2>&1; then
    if ! printf '%s  %s\n' "$_sha" "$_tmp/$_file" | sha256sum -c - >/dev/null 2>&1; then
      info "SHA256 校验失败，已放弃安装"
      rm -rf "$_tmp"
      return 1
    fi
  fi

  info "正在解压到 $NODE_HOME …"
  mkdir -p "$NODE_HOME" || { rm -rf "$_tmp"; return 1; }
  rm -rf "$NODE_HOME/${_file%.tar.gz}"
  if ! tar -xzf "$_tmp/$_file" -C "$NODE_HOME"; then
    info "解压失败"
    rm -rf "$_tmp"
    return 1
  fi
  ln -sfn "$NODE_HOME/${_file%.tar.gz}" "$NODE_HOME/current" 2>/dev/null || true
  rm -rf "$_tmp"

  PATH="$NODE_HOME/current/bin:$PATH"
  export PATH
  info "已安装 Node.js $_ver → $NODE_HOME/current（本次运行生效）"
  info "想长期使用可把 $NODE_HOME/current/bin 加入 PATH"
  return 0
}

if [ "$ACTION" = "check" ]; then
  info "运行环境检测（要求 Node.js >= $NODE_MIN_MAJOR）："
  if env_check; then
    info "  Node.js  $(node -v)   ok"
    info "  npm      $(npm -v 2>/dev/null || printf '?')   ok"
    info "结论：可以运行。"
    exit 0
  fi
  info "  $ENV_PROBLEM"
  info "结论：不能运行。"
  if [ "$AUTO_INSTALL" = "1" ]; then
    info "去掉 --check-env 直接运行，脚本会自动安装。"
  else
    info "已指定 --no-auto-install，请手动安装：https://nodejs.org/zh-cn/download"
  fi
  exit 1
fi

if env_check; then
  : # 环境就绪，安静放行
else
  info "运行环境检测：$ENV_PROBLEM"
  if [ "$AUTO_INSTALL" = "0" ]; then
    die "已指定 --no-auto-install。请先安装 Node.js $NODE_MIN_MAJOR 及以上版本：https://nodejs.org/zh-cn/download"
  fi
  install_node || die "自动安装 Node.js 失败，请手动安装 $NODE_MIN_MAJOR 及以上版本：https://nodejs.org/zh-cn/download"
  env_check || die "自动安装后仍不可用：$ENV_PROBLEM"
  info "环境就绪：$(node -v)，npm $(npm -v 2>/dev/null || printf '?')"
fi

# ---------- 构建 ----------
# 与 start-windows.ps1 对齐：默认总是构建；只有显式 --no-build 且产物存在时才跳过
if [ "$NO_BUILD" = "1" ] && [ -f "dist/server/index.js" ]; then
  info "跳过构建（--no-build）"
else
  info "开始构建：npm run build"
  command -v npm >/dev/null 2>&1 || die "未找到 npm，无法构建；可先自行构建后用 --no-build 启动"
  npm run build || die "构建失败"
fi

[ -f "dist/server/index.js" ] || die "缺少 dist/server/index.js，请先运行 npm run build"

# ---------- 启动 ----------
export PORT HOST
URL="http://$HOST:$PORT"

if [ "$DAEMON" = "1" ]; then
  mkdir -p "$DATA_DIR"
  if pid=$(read_pid) && pid_alive "$pid"; then
    die "已有实例在运行（pid $pid）；如需重启请先 --stop"
  fi
  info "后台启动，日志：$LOG_FILE"
  nohup node dist/server/index.js >>"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" >"$PID_FILE"

  i=0
  while [ "$i" -lt 30 ]; do
    if ! pid_alive "$pid"; then
      rm -f "$PID_FILE"
      printf '启动失败，日志尾部：\n' >&2
      tail -n 20 "$LOG_FILE" >&2 2>/dev/null || true
      exit 1
    fi
    if http_ready "$HOST" "$PORT"; then
      info "已启动：pid $pid，$URL"
      info "数据目录：$DATA_DIR"
      info "停止：$0 --stop"
      exit 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  info "进程已启动（pid $pid），但 15 秒内未就绪，请查看日志：$LOG_FILE"
  exit 1
fi

# 前台运行：仅在确有图形会话时尝试打开浏览器
if [ "$NO_OPEN" = "0" ] && [ "${DISPLAY:-}${WAYLAND_DISPLAY:-}" != "" ] && command -v xdg-open >/dev/null 2>&1; then
  ( sleep 2; xdg-open "$URL" >/dev/null 2>&1 || true ) &
fi

info "启动 $URL"
info "数据目录：$DATA_DIR"
exec node dist/server/index.js
