#!/usr/bin/env bats

load 'setup'

@test "approves non-spec writes in any state" {
  echo "dev" > "$TEST_TMP/current-state.txt"
  result=$(echo '{"tool_input":{"file_path":"/tmp/foo.ts"}}' | bash "$PLUGIN_ROOT/scripts/pre-write-guard.sh")
  [[ "$result" == *'"approve"'* ]]
}

@test "approves spec writes during dev state" {
  echo "dev" > "$TEST_TMP/current-state.txt"
  result=$(echo '{"tool_input":{"file_path":"/project/docs/specs/my-spec/intent-and-constraints.md"}}' | bash "$PLUGIN_ROOT/scripts/pre-write-guard.sh")
  [[ "$result" == *'"approve"'* ]]
}

@test "blocks spec writes during sdlc_review" {
  echo "sdlc_review" > "$TEST_TMP/current-state.txt"
  result=$(echo '{"tool_input":{"file_path":"/project/docs/specs/my-spec/intent-and-constraints.md"}}' | bash "$PLUGIN_ROOT/scripts/pre-write-guard.sh")
  [[ "$result" == *'"block"'* ]]
}

@test "allows .operant writes during sdlc_review" {
  echo "sdlc_review" > "$TEST_TMP/current-state.txt"
  result=$(echo '{"tool_input":{"file_path":"/project/spec/.operant/current-state.txt"}}' | bash "$PLUGIN_ROOT/scripts/pre-write-guard.sh")
  [[ "$result" == *'"approve"'* ]]
}

@test "blocks writes when gate-pending exists" {
  echo "sdlc_review" > "$TEST_TMP/current-state.txt"
  echo '{"mode":"review","artifactType":"intent","specDir":"/tmp/spec"}' > "$TEST_TMP/gate-pending.json"
  result=$(echo '{"tool_input":{"file_path":"/project/src/index.ts"}}' | bash "$PLUGIN_ROOT/scripts/pre-write-guard.sh")
  [[ "$result" == *'"block"'* ]]
  [[ "$result" == *'GATE PENDING'* ]]
}

@test "approves when no file_path in input" {
  echo "sdlc_review" > "$TEST_TMP/current-state.txt"
  result=$(echo '{"tool_input":{}}' | bash "$PLUGIN_ROOT/scripts/pre-write-guard.sh")
  [[ "$result" == *'"approve"'* ]]
}
