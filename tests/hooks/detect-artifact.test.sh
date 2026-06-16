#!/usr/bin/env bats

load 'setup'

@test "ignores non-spec files" {
  result=$(echo '{"tool_input":{"file_path":"/tmp/foo.ts"}}' | bash "$PLUGIN_ROOT/scripts/detect-artifact.sh")
  [ -z "$result" ]
}

@test "ignores .operant files" {
  result=$(echo '{"tool_input":{"file_path":"/project/spec/.operant/state.txt"}}' | bash "$PLUGIN_ROOT/scripts/detect-artifact.sh")
  [ -z "$result" ]
}

@test "ignores non-artifact spec files" {
  result=$(echo '{"tool_input":{"file_path":"/project/docs/specs/my-spec/REQUIREMENTS.md"}}' | bash "$PLUGIN_ROOT/scripts/detect-artifact.sh")
  [ -z "$result" ]
}

@test "detects intent artifact when CLI is built" {
  if [ ! -f "$PLUGIN_ROOT/lib/cli/transition.js" ]; then
    skip "lib not built"
  fi
  echo "sdlc_intent" > "$TEST_TMP/current-state.txt"
  result=$(echo '{"tool_input":{"file_path":"/project/docs/specs/my-spec/intent-and-constraints.md"}}' | bash "$PLUGIN_ROOT/scripts/detect-artifact.sh")
  [[ "$result" == *"[PIPELINE]"* ]]
  [[ "$result" == *"intent"* ]]
}
