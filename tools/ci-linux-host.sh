#!/usr/bin/env bash
# The one fact a child kururu stands on, checked on a real systemd.
#
# A child's server is a systemd user service, and systemd ends a service's
# whole cgroup with it. So the pty host must be in a unit of its own, or
# stopping the server ends every agent. The unit tests cover the command line
# that asks for that unit; only a user manager can say whether it is granted.
# This runs the built server as a transient user unit, with the loopback
# token on, and checks, in order:
#
#   1. the host was started as a transient systemd user unit of its own
#   2. the gate refuses loopback without the token and lets it in with it,
#      and the Share URL answers with the cookie
#   3. `status` finds the host through `ss` and names its unit
#   4. a terminal has the token in its environment and none of the
#      server's own variables
#   5. stopping the server's unit leaves the host and its terminal running
#   6. a new server finds them again
#   7. `kill-ptyhosts` finds the host by its socket and stops it
#
# Everything is under a scratch state, config and data directory, on its own
# port and socket. CI only: it enables linger for the runner's user.
set -euo pipefail

K=/tmp/k2
PORT=7817
mkdir -p "$K"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

sudo loginctl enable-linger "$USER"
for _ in $(seq 1 30); do
  [ -S "$XDG_RUNTIME_DIR/systemd/private" ] && break
  sleep 1
done
systemctl --user is-system-running || true

ENV=(
  "PATH=$PATH" "HOME=$HOME" "SHELL=/bin/bash" "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
  "KURURU_PORT=$PORT" "KURURU_HOST_SOCK=$K/ptyhost.sock" "KURURU_STATE_DIR=$K"
  "KURURU_DATA_DIR=$K/data" "XDG_CONFIG_HOME=$K/config" "XDG_STATE_HOME=$K/xdg-state"
  "KURURU_LOOPBACK_TOKEN=1"
)
SETENV=()
for pair in "${ENV[@]}"; do SETENV+=("--setenv=$pair"); done
for pair in "${ENV[@]}"; do export "${pair?}"; done

start_server() {
  systemd-run --user --unit="$1" --collect --quiet "${SETENV[@]}" \
    --working-directory="$PWD" \
    --property=StandardOutput="append:$K/$1.out" --property=StandardError="append:$K/$1.out" \
    -- "$(command -v node)" "$PWD/desktop/dist/server.mjs"
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)
    [ "$code" != "000" ] && return 0
    sleep 0.5
  done
  echo "the server did not answer"; cat "$K/$1.out"; tail -20 "$K/ptyhost.log" || true; exit 1
}

fail() { echo "FAIL: $*"; cat "$K"/*.out || true; tail -20 "$K/ptyhost.log" || true; tail -5 "$K/lifecycle.log" || true; exit 1; }

start_server kururu-ci-server-1
TOKEN=$(node -p "require('$K/config/kururu/access.json').token")
AUTH="authorization: Bearer $TOKEN"

echo "--- 1. the host's unit"
grep -q 'as a transient systemd user unit (kururu-ptyhost-' "$K/lifecycle.log" || fail "the record does not say the host has a unit of its own"
HOST=$(node server/status.mjs | sed -n 's/^pty host.*pid \([0-9]*\).*/\1/p')
[ -n "$HOST" ] || fail "status found no host"
grep -q 'kururu-ptyhost-' "/proc/$HOST/cgroup" || fail "the host is not in a unit of its own: $(cat /proc/$HOST/cgroup)"

echo "--- 2. the gate"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")" = 403 ] || fail "loopback got in without the token"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "http://127.0.0.1:$PORT/api/health")" = 200 ] || fail "loopback was refused with the token"
curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/?k=$TOKEN" | grep -qi '^set-cookie: kururu_access=' || fail "the Share URL set no cookie"

echo "--- 3. status"
node server/status.mjs | tee "$K/status.txt"
grep -q '^unit .*kururu-ptyhost-' "$K/status.txt" || fail "status does not name the host's unit"

AGENT=$(curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/agents" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents.find(a=>!a.exited);console.log(a?a.pid:"")})')
[ -n "$AGENT" ] || fail "the first start opened no terminal"

echo "--- 4. a terminal's environment"
ENVIRON=$(tr '\0' '\n' < "/proc/$AGENT/environ")
grep -qx "KURURU_TOKEN=$TOKEN" <<<"$ENVIRON" || fail "the terminal was not handed the token"
! grep -q '^KURURU_LOOPBACK_TOKEN=' <<<"$ENVIRON" || fail "the terminal inherited the server's own switch"

echo "--- 5. stopping the server's unit"
systemctl --user stop kururu-ci-server-1
sleep 1
kill -0 "$HOST" || fail "the host went with the server's unit"
kill -0 "$AGENT" || fail "the terminal went with the server's unit"

echo "--- 6. a new server"
start_server kururu-ci-server-2
curl -s -H "$AUTH" "http://127.0.0.1:$PORT/api/agents" | grep -q "\"pid\":$AGENT" || fail "the new server does not see the terminal"
systemctl --user stop kururu-ci-server-2

echo "--- 7. kill-ptyhosts"
node server/kill-hosts.mjs --list "$K" | tee "$K/kill.txt"
grep -q "pid $HOST" "$K/kill.txt" || fail "kill-ptyhosts did not find the host"
node server/kill-hosts.mjs --yes "$K"
sleep 1
! kill -0 "$HOST" 2>/dev/null || fail "the host is still up"

echo "every check passed"
