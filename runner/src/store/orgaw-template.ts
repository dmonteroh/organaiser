const ORGA_YAML = "orga.yaml";
const ORGA_DIR = ".orga";

export const ORGAW_TEMPLATE = `#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(sed -n 's/^[[:space:]]*version:[[:space:]]*"\\{0,1\\}\\([^"[:space:]]*\\)"\\{0,1\\}[[:space:]]*$/\\1/p' "$DIR/${ORGA_YAML}" | head -n 1)
RUNNER_BIN="$DIR/${ORGA_DIR}/runner/$VERSION/bin/orga.ts"
if [ -f "$RUNNER_BIN" ]; then
  exec node "$RUNNER_BIN" "$@"
fi
echo "orgaw: pinned runner not found at $RUNNER_BIN" >&2
exit 1
`;
