const ORGA_YAML = "orga.yaml";
const ORGA_DIR = ".orga";

export const ORGAW_TEMPLATE = `#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

yaml_value() {
  sed -n 's/^[[:space:]]*'"$1"':[[:space:]]*"\\{0,1\\}\\([^"[:space:]]*\\)"\\{0,1\\}[[:space:]]*$/\\1/p' "$DIR/${ORGA_YAML}" | head -n 1
}

VERSION=$(yaml_value version)
URL=$(yaml_value url)
CHECKSUM=$(yaml_value checksum)

if [ -z "$VERSION" ]; then
  echo "orgaw: ${ORGA_YAML} is missing runner.version" >&2
  exit 1
fi

RUNNER_BIN="$DIR/${ORGA_DIR}/runner/$VERSION/bin/orga.ts"
if [ -f "$RUNNER_BIN" ]; then
  exec node "$RUNNER_BIN" "$@"
fi

if [ -z "$CHECKSUM" ]; then
  echo "orgaw: no runner pinned for version $VERSION at $URL; run orga init --runner-checksum to record a checksum" >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  DOWNLOAD_TOOL=curl
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD_TOOL=wget
else
  echo "orgaw: no download tool found (need curl or wget)" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  HASH_TOOL=shasum
elif command -v openssl >/dev/null 2>&1; then
  HASH_TOOL=openssl
else
  echo "orgaw: no sha256 tool found (need sha256sum, shasum, or openssl)" >&2
  exit 1
fi

mkdir -p "$DIR/${ORGA_DIR}/runner"
chmod 0700 "$DIR/${ORGA_DIR}" "$DIR/${ORGA_DIR}/runner"

TMP=""
trap 'if [ -n "$TMP" ]; then rm -rf "$TMP"; fi' EXIT
TMP=$(mktemp -d "$DIR/${ORGA_DIR}/orgaw-tmp-XXXXXX")

if [ "$DOWNLOAD_TOOL" = curl ]; then
  curl -fsSL -o "$TMP/runner.tgz" "$URL"
else
  wget -q -O "$TMP/runner.tgz" "$URL"
fi

if [ "$HASH_TOOL" = sha256sum ]; then
  ACTUAL=$(sha256sum "$TMP/runner.tgz" | awk '{print $1}')
elif [ "$HASH_TOOL" = shasum ]; then
  ACTUAL=$(shasum -a 256 "$TMP/runner.tgz" | awk '{print $1}')
else
  ACTUAL=$(openssl dgst -sha256 "$TMP/runner.tgz" | awk '{print $NF}')
fi

if [ "$ACTUAL" != "$CHECKSUM" ]; then
  echo "orgaw: checksum mismatch downloading $URL (expected $CHECKSUM, got $ACTUAL)" >&2
  exit 1
fi

mkdir "$TMP/x"
tar -xzf "$TMP/runner.tgz" -C "$TMP/x"

COUNT=0
ENTRY=""
for e in "$TMP"/x/*; do
  [ -e "$e" ] || continue
  COUNT=$((COUNT + 1))
  ENTRY="$e"
done

if [ "$COUNT" -ne 1 ] || [ ! -d "$ENTRY" ]; then
  echo "orgaw: expected exactly one top-level directory in the runner archive from $URL" >&2
  exit 1
fi

mv "$ENTRY" "$DIR/${ORGA_DIR}/runner/$VERSION"

rm -rf "$TMP"
TMP=""
exec node "$DIR/${ORGA_DIR}/runner/$VERSION/bin/orga.ts" "$@"
`;
