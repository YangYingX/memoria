#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo 'This script requires Linux and Bash. On Windows use start.cmd.' >&2
  exit 1
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
server_path="$project_dir/src/server.js"
cd -- "$project_dir"
node_path="$(command -v node || true)"
if [[ -z "$node_path" ]] || ! "$node_path" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 16 ? 0 : 1)'; then
  echo 'Node.js 22.16 or newer is required.' >&2
  exit 1
fi
if ! "$node_path" -e 'require.resolve("@mozilla/readability"); require.resolve("linkedom")' >/dev/null 2>&1; then
  echo 'Dependencies missing. Run npm ci in the project directory first.' >&2
  exit 1
fi

umask 077
mkdir -p -- "${PERSONA_DATA_DIR:-$project_dir/data}"
data_dir="$(cd -- "${PERSONA_DATA_DIR:-$project_dir/data}" && pwd -P)"
pid_file="$data_dir/server.pid"
if ! mkdir -- "$data_dir/.start.lock" 2>/dev/null; then
  echo "Another start may be in progress. If no start script is running, remove the empty directory: $data_dir/.start.lock" >&2
  exit 1
fi
trap 'rmdir -- "$data_dir/.start.lock" 2>/dev/null || true' EXIT

is_project_process() {
  local candidate="$1" executable
  local -a arguments=()
  [[ "$candidate" =~ ^[1-9][0-9]*$ && -r "/proc/$candidate/cmdline" ]] || return 1
  mapfile -d '' -t arguments < "/proc/$candidate/cmdline" || return 1
  [[ ${#arguments[@]} -eq 2 && "${arguments[1]}" == "$server_path" ]] || return 1
  executable="$(readlink -- "/proc/$candidate/exe" 2>/dev/null)" || return 1
  [[ "${executable##*/}" == node || "${executable##*/}" == nodejs ]]
}

if [[ -f "$pid_file" ]]; then
  saved_pid="$(cat -- "$pid_file")"
  if is_project_process "$saved_pid"; then
    echo 'Memoria is already running: http://127.0.0.1:3210'
    exit 0
  fi
  if [[ ! "$saved_pid" =~ ^[1-9][0-9]*$ || -d "/proc/$saved_pid" ]]; then
    echo "PID file does not identify this project's server. No process was changed: $pid_file" >&2
    exit 1
  fi
  rm -- "$pid_file"
fi

export PORT=3210 PERSONA_DATA_DIR="$data_dir"
nohup "$node_path" "$server_path" >> "$data_dir/server.log" 2>> "$data_dir/server.err.log" < /dev/null &
server_pid=$!
printf '%s\n' "$server_pid" > "$pid_file"

for ((attempt = 0; attempt < 30; attempt++)); do
  sleep 0.25
  if ! is_project_process "$server_pid"; then
    [[ "$(cat -- "$pid_file" 2>/dev/null || true)" != "$server_pid" ]] || rm -- "$pid_file"
    echo "Server exited. See $data_dir/server.err.log" >&2
    exit 1
  fi
  if "$node_path" --input-type=module -e 'try { const response = await fetch("http://127.0.0.1:3210/api/status", { signal: AbortSignal.timeout(1000) }); const status = await response.json(); process.exit(response.ok && typeof status.initialized === "boolean" ? 0 : 1); } catch { process.exit(1); }' >/dev/null 2>&1; then
    if is_project_process "$server_pid"; then
      echo 'Memoria: http://127.0.0.1:3210'
      echo "Data and logs: $data_dir"
      [[ ! -f "$data_dir/setup-key.txt" ]] || echo "Setup key file: $data_dir/setup-key.txt"
      exit 0
    fi
  fi
done

echo "Startup readiness timed out; process $server_pid was left running. Check $data_dir/server.err.log or use bash scripts/stop.sh." >&2
exit 1
