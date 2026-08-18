#!/usr/bin/env bash

set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

if [ -n "${1:-}" ]; then
  mkdir -p "$1"
  codex_home="$(cd "$1" && pwd)"
  codex_home_owned=0
else
  codex_home="$(mktemp -d)"
  codex_home_owned=1
fi

scratch="$(mktemp -d)"
listener_pid_a=""
listener_pid_b=""
codex_pid_a=""
codex_pid_b=""

cleanup() {
  local pid

  for pid in "$listener_pid_a" "$listener_pid_b" "$codex_pid_a" "$codex_pid_b"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  rm -rf -- "$scratch"
  if [ "$codex_home_owned" -eq 1 ]; then
    rm -rf -- "$codex_home"
  fi
}

wait_for_socket() {
  local socket_path="$1"
  local listener_pid="$2"
  local attempt

  for attempt in {1..100}; do
    if [ -S "$socket_path" ]; then
      return 0
    fi
    if ! kill -0 "$listener_pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.05
  done

  return 1
}

run_with_watchdog() {
  local deadline_seconds="$1"
  local status_var_name="$2"
  local pid_var_name="$3"
  local input_file="$4"
  local run_label="$5"
  local pid polls=0 max_polls status

  shift 5
  if [ "$1" = "--" ]; then
    shift
  fi

  max_polls=$((deadline_seconds * 2))
  "$@" < "$input_file" &
  pid=$!
  printf -v "$pid_var_name" '%s' "$pid"

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$polls" -ge "$max_polls" ]; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      wait "$pid" 2>/dev/null || true
      printf 'run %s: codex exec timed out after %ss\n' "$run_label" "$deadline_seconds" >&2
      printf -v "$status_var_name" '%s' 124
      printf -v "$pid_var_name" '%s' ""
      return 0
    fi

    sleep 0.5
    polls=$((polls + 1))
  done

  if wait "$pid"; then
    printf -v "$status_var_name" '%s' 0
  else
    status=$?
    printf -v "$status_var_name" '%s' "$status"
    printf 'run %s: codex exec exited with status %s\n' "$run_label" "$status" >&2
  fi
  printf -v "$pid_var_name" '%s' ""
}

assert_capture() {
  local output_file="$1"
  local expected_token="$2"
  local run_label="$3"
  local line_count

  if [ ! -f "$output_file" ]; then
    printf 'run %s: expected a capture file, but none was written\n' "$run_label" >&2
    return 1
  fi

  if ! line_count="$(jq -R -s '[split("\n")[] | select(test("^\\s*$") | not)] | length' "$output_file")"; then
    printf 'run %s: could not count captured lines with jq\n' "$run_label" >&2
    return 1
  fi

  if [ "$line_count" -ne 2 ]; then
    printf 'run %s: expected 2 non-empty lines, found %s\n' "$run_label" "$line_count" >&2
    return 1
  fi

  if jq -e -s --arg token "$expected_token" '
    def expected_content:
      if type == "string" then
        startswith("<teammate-message teammate_id=\"codex\"")
        and contains("[Codex turn complete]")
      else
        false
      end;

    length == 2
    and .[0].type == "auth"
    and .[0].token == $token
    and .[1].type == "user"
    and .[1].message.role == "user"
    and (.[1].message.content | expected_content)
  ' "$output_file" >/dev/null 2>&1; then
    return 0
  fi

  printf 'run %s: captured frames did not match the expected auth and user envelopes\n' "$run_label" >&2
  if ! jq -s --arg token "$expected_token" '
    def string_check($operation):
      if type == "string" then $operation else false end;

    (.[1].message.content? // null) as $content
    | {
        expected: {
          line_1_type: "auth",
          line_1_token_matches: true,
          line_2_type: "user",
          line_2_role_matches: true,
          line_2_content_type: "string",
          line_2_prefix_matches: true,
          line_2_marker_matches: true
        },
        actual: {
          line_1_type: .[0].type,
          line_1_token_matches: (.[0].token == $token),
          line_2_type: .[1].type,
          line_2_role_matches: (.[1].message.role? == "user"),
          line_2_content_type: ($content | type),
          line_2_prefix_matches: ($content | string_check(startswith("<teammate-message teammate_id=\"codex\""))),
          line_2_marker_matches: ($content | string_check(contains("[Codex turn complete]")))
        }
      }
  ' "$output_file" >&2; then
    printf 'run %s: one or more captured lines were not valid json\n' "$run_label" >&2
  fi

  return 1
}

trap cleanup EXIT

# step 1: codex home setup
printf '%s\n' 'STEP 1: CODEX_HOME setup'
export CODEX_HOME="$codex_home"
if [ ! -f "$CODEX_HOME/auth.json" ]; then
  cp "$HOME/.codex/auth.json" "$CODEX_HOME/auth.json" && chmod 600 "$CODEX_HOME/auth.json"
fi

result_a=FAIL
result_b=FAIL

# run a: legacy notify mode
printf '%s\n' 'RUN A: legacy notify mode'
rm -f "$CODEX_HOME/hooks.json"
printf '%s\n' "notify = [\"node\", \"$repo_root/plugins/codex-claude-notify/hooks/notify.mjs\"]" > "$CODEX_HOME/config.toml"

socket_a="$scratch/a.sock"
output_a="$scratch/a-output.ndjson"
prompt_a="$scratch/prompt-a.md"
token_a="smoke-$RANDOM-$RANDOM"
printf '%s\n' 'hello' > "$prompt_a"

node "$repo_root/test/e2e/listener.mjs" "$socket_a" "$output_a" &
listener_pid_a=$!

listener_ready_a=FAIL
if wait_for_socket "$socket_a" "$listener_pid_a"; then
  listener_ready_a=PASS
else
  printf '%s\n' 'run A: listener did not become ready' >&2
fi

export CLAUDE_CODE_MESSAGING_SOCKET="$socket_a"
export CLAUDE_CODE_MESSAGING_TOKEN="$token_a"

run_with_watchdog 300 codex_status_a codex_pid_a "$prompt_a" A -- \
  codex exec -m gpt-5.6-luna -c model_reasoning_effort=low --skip-git-repo-check --json -

if wait "$listener_pid_a"; then
  listener_status_a=0
else
  listener_status_a=$?
  printf 'run A: listener exited with status %s\n' "$listener_status_a" >&2
fi
listener_pid_a=""

if [ "$listener_ready_a" = PASS ] && [ "$codex_status_a" -eq 0 ] && [ "$listener_status_a" -eq 0 ] && assert_capture "$output_a" "$token_a" A; then
  result_a=PASS
  printf '%s\n' 'PASS A'
else
  printf '%s\n' 'FAIL A'
fi

# run b: config-layer stop hook mode
printf '%s\n' 'RUN B: config-layer Stop hook mode'
: > "$CODEX_HOME/config.toml"
script_path="$repo_root/plugins/codex-claude-notify/hooks/notify.mjs"
printf -v escaped 'node %q' "$script_path"
jq -n \
  --arg command "$escaped" \
  '{hooks:{Stop:[{hooks:[{type:"command",command:$command}]}]}}' \
  > "$CODEX_HOME/hooks.json"

socket_b="$scratch/b.sock"
output_b="$scratch/b-output.ndjson"
prompt_b="$scratch/prompt-b.md"
token_b="smoke-$RANDOM-$RANDOM"
printf '%s\n' 'hello' > "$prompt_b"

node "$repo_root/test/e2e/listener.mjs" "$socket_b" "$output_b" &
listener_pid_b=$!

listener_ready_b=FAIL
if wait_for_socket "$socket_b" "$listener_pid_b"; then
  listener_ready_b=PASS
else
  printf '%s\n' 'run B: listener did not become ready' >&2
fi

export CLAUDE_CODE_MESSAGING_SOCKET="$socket_b"
export CLAUDE_CODE_MESSAGING_TOKEN="$token_b"

# this bypass is only for the isolated, disposable smoke-test codex home; real users must use the normal one-time interactive tui hook-trust prompt and must never bypass trust for a persistent codex home.
run_with_watchdog 300 codex_status_b codex_pid_b "$prompt_b" B -- \
  codex exec -m gpt-5.6-luna -c model_reasoning_effort=low --skip-git-repo-check --json --dangerously-bypass-hook-trust -

if wait "$listener_pid_b"; then
  listener_status_b=0
else
  listener_status_b=$?
  printf 'run B: listener exited with status %s\n' "$listener_status_b" >&2
fi
listener_pid_b=""

if [ "$listener_ready_b" = PASS ] && [ "$codex_status_b" -eq 0 ] && [ "$listener_status_b" -eq 0 ] && assert_capture "$output_b" "$token_b" B; then
  result_b=PASS
  printf '%s\n' 'PASS B'
else
  printf '%s\n' 'FAIL B'
fi

# summary
printf '%s\n' 'SUMMARY'
if [ "$result_a" = PASS ] && [ "$result_b" = PASS ]; then
  printf '%s\n' 'SMOKE PASS'
  exit 0
fi

printf 'SMOKE FAIL: run A=%s, run B=%s\n' "$result_a" "$result_b"
exit 1
