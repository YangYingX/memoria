#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo 'This script requires Linux and Bash. On Windows use stop.cmd.' >&2
  exit 1
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
server_path="$project_dir/src/server.js"
cd -- "$project_dir"
if [[ ! -d "${PERSONA_DATA_DIR:-$project_dir/data}" ]]; then
  echo 'No data directory; nothing to stop.'
  exit 0
fi
data_dir="$(cd -- "${PERSONA_DATA_DIR:-$project_dir/data}" && pwd -P)"
pid_file="$data_dir/server.pid"
if [[ ! -f "$pid_file" ]]; then
  echo 'No PID file; nothing to stop. For systemd use systemctl stop persona-agent.'
  exit 0
fi

saved_pid="$(cat -- "$pid_file")"
if [[ ! "$saved_pid" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid PID file; no process was changed: $pid_file" >&2
  exit 1
fi
if [[ ! -d "/proc/$saved_pid" ]]; then
  rm -- "$pid_file"
  echo 'Removed stale PID file; server was already stopped.'
  exit 0
fi

is_project_process() {
  local executable
  local -a arguments=()
  [[ -r "/proc/$saved_pid/cmdline" ]] || return 1
  mapfile -d '' -t arguments < "/proc/$saved_pid/cmdline" || return 1
  [[ ${#arguments[@]} -eq 2 && "${arguments[1]}" == "$server_path" ]] || return 1
  executable="$(readlink -- "/proc/$saved_pid/exe" 2>/dev/null)" || return 1
  [[ "${executable##*/}" == node || "${executable##*/}" == nodejs ]]
}

if ! is_project_process; then
  echo "PID $saved_pid is not this project's Node server. No signal was sent; inspect $pid_file." >&2
  exit 1
fi

kill -TERM "$saved_pid"
for ((attempt = 0; attempt < 60; attempt++)); do
  sleep 0.25
  if ! is_project_process; then
    [[ "$(cat -- "$pid_file" 2>/dev/null || true)" != "$saved_pid" ]] || rm -- "$pid_file"
    echo 'Memoria stopped.'
    exit 0
  fi
done

echo "PID $saved_pid did not stop within 15 seconds. No SIGKILL was sent; inspect $data_dir/server.err.log." >&2
exit 1
