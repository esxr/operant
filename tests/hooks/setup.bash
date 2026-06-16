# Shared setup for hook tests
PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
  mkdir -p "$TEST_TMP/pending" "$TEST_TMP/processed" "$TEST_TMP/calls"
  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  export OPERANT_PI_DATA_DIR="$TEST_TMP"
}

teardown() {
  rm -rf "$TEST_TMP"
}
