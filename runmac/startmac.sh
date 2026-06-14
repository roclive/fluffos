#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

CONFIG="config.cfg"
DRIVER="../build/bin/driver"
RESTART="${1:-}"

PORTS=()
while IFS= read -r port; do
  [ -n "$port" ] && PORTS+=("$port")
done < <(awk '/^external_port_/ { print $4 }' "$CONFIG")

busy_pids=()
for port in "${PORTS[@]}"; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Port $port is already in use:"
    lsof -nP -iTCP:"$port" -sTCP:LISTEN
    while IFS= read -r pid; do
      [ -n "$pid" ] && busy_pids+=("$pid")
    done <<< "$pids"
  fi
done

if [ "${#busy_pids[@]}" -gt 0 ]; then
  if [ "$RESTART" != "restart" ] && [ "$RESTART" != "--restart" ]; then
    echo
    echo "Driver was not started. Run '$0 restart' to stop the existing driver process first."
    exit 1
  fi

  for pid in $(printf "%s\n" "${busy_pids[@]}" | sort -u); do
    comm="$(ps -p "$pid" -o comm= | xargs)"
    if [ "$comm" != "driver" ]; then
      echo "Refusing to kill non-driver process $pid ($comm)."
      exit 1
    fi
    echo "Stopping existing driver process $pid..."
    kill "$pid"
  done

  sleep 1
fi

exec "$DRIVER" "$CONFIG"
