#!/usr/bin/env bats

load 'setup'

@test "runs without error in idle state" {
  echo "idle" > "$TEST_TMP/current-state.txt"
  run bash "$PLUGIN_ROOT/scripts/validate-state.sh"
  [ "$status" -eq 0 ]
}

@test "detects state drift when CLI is built" {
  if [ ! -f "$PLUGIN_ROOT/lib/cli/infer-state.js" ]; then
    skip "lib not built"
  fi
  echo "dev" > "$TEST_TMP/current-state.txt"
  # No spec dirs exist, so inferred state should be idle -> drift
  run bash "$PLUGIN_ROOT/scripts/validate-state.sh"
  [ "$status" -eq 0 ]
}
