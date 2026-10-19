#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo 'This script requires Linux and Bash. On Windows use dev.cmd.' >&2
  exit 1
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
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
export PERSONA_DATA_DIR="$(cd -- "${PERSONA_DATA_DIR:-$project_dir/data}" && pwd -P)"
export PORT=3210
echo 'Development mode: http://127.0.0.1:3210; press Ctrl+C to stop.'
exec "$node_path" --watch "$project_dir/src/server.js"
