#!/usr/bin/env bats

load 'setup'

@test "outputs idle context when no state file" {
  result=$(echo "" | bash "$PLUGIN_ROOT/scripts/inject-context.sh")
  [[ "$result" == *"Phase:** idle"* ]]
  [[ "$result" == *"State:** idle"* ]]
  [[ "$result" == *"Active Spec:** none"* ]]
}

@test "outputs correct phase for sdlc state" {
  echo "sdlc_hld" > "$TEST_TMP/current-state.txt"
  echo "my-feature" > "$TEST_TMP/active-spec.txt"
  SPECS_ROOT="$(dirname "$TEST_TMP")"
  mkdir -p "$SPECS_ROOT/my-feature"
  result=$(echo "" | bash "$PLUGIN_ROOT/scripts/inject-context.sh")
  [[ "$result" == *"Phase:** sdlc"* ]]
  [[ "$result" == *"State:** sdlc_hld"* ]]
  [[ "$result" == *"Active Spec:** my-feature"* ]]
}

@test "counts blockers correctly" {
  echo "dev" > "$TEST_TMP/current-state.txt"
  echo "my-feature" > "$TEST_TMP/active-spec.txt"
  SPECS_ROOT="$(dirname "$TEST_TMP")"
  mkdir -p "$SPECS_ROOT/my-feature/blockers"
  echo "# Blocker" > "$SPECS_ROOT/my-feature/blockers/b1.md"
  echo "# Blocker" > "$SPECS_ROOT/my-feature/blockers/b2.md"
  result=$(echo "" | bash "$PLUGIN_ROOT/scripts/inject-context.sh")
  [[ "$result" == *"Blockers:** 2"* ]]
}
