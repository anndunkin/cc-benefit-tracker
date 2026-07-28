#!/usr/bin/env bash
# Credit Card Benefit Tracker — Windows code-signing script
#
# Signs the app executable + DLLs in dist-installer/win-unpacked/ and the NSIS
# installer (Setup .exe) using osslsigncode and a self-signed certificate.
#
# Certificate identity: CN=Ann Dunkin, O=Dunkin Global Advisors, OU=Software, C=US
# (Freshly generated for this app — build/signing.key is NOT shared with any
#  other project.)
#
# Usage (from project root, after electron-builder has produced dist-installer/):
#   bash build/sign.sh
#
# Prerequisites: osslsigncode (sudo apt-get install osslsigncode)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT="$PROJECT_DIR/dist-installer"
UNPACKED="$OUT/win-unpacked"
CERT="$SCRIPT_DIR/signing.crt"
KEY="$SCRIPT_DIR/signing.key"
URL="https://github.com/anndunkin/cc-benefit-tracker"
APP_NAME="Credit Card Benefit Tracker"

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "ERROR: build/signing.crt and build/signing.key not found."
  exit 1
fi
if ! command -v osslsigncode &>/dev/null; then
  echo "ERROR: osslsigncode not installed (sudo apt-get install osslsigncode)."
  exit 1
fi

PASS=0; FAIL=0

sign_file() {
  local FILE="$1"
  local NAME; NAME=$(basename "$FILE")
  local TMP="${FILE}.signed"
  if osslsigncode sign -certs "$CERT" -key "$KEY" -n "$APP_NAME" -i "$URL" \
      -h sha256 -in "$FILE" -out "$TMP" >/dev/null 2>&1 && [ -f "$TMP" ]; then
    mv "$TMP" "$FILE"
    echo "  signed: $NAME"
    PASS=$((PASS+1))
  else
    rm -f "$TMP"
    echo "  FAILED: $NAME"
    FAIL=$((FAIL+1))
  fi
}

# 1) Sign the unpacked app binaries.
if [ -d "$UNPACKED" ]; then
  echo "Signing app binaries in win-unpacked/ ..."
  for FILE in "$UNPACKED"/*.exe "$UNPACKED"/*.dll; do
    [ -f "$FILE" ] && sign_file "$FILE"
  done
fi

# 2) Sign the NSIS installer (the primary distributable).
echo "Signing installer(s) ..."
shopt -s nullglob
for SETUP in "$OUT"/*Setup*.exe; do
  [ -f "$SETUP" ] && sign_file "$SETUP"
done

echo ""
echo "Done: $PASS signed, $FAIL failed"
[ $FAIL -gt 0 ] && exit 1 || exit 0
