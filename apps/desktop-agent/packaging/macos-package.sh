#!/usr/bin/env bash
# Signs + notarizes + staples the staged SEA build into a .pkg installer.
#
# The .pkg installs the CLI to a FIXED path (/usr/local/whipdesk) and symlinks
# /usr/local/bin/whipdesk, so the code-signature identity/path stay stable across updates —
# which keeps the user's Screen Recording / Accessibility (TCC) grants after upgrading.
#
# Env in:
#   VERSION, ARCH                     e.g. 1.4.0, arm64|x64
#   STAGE                             dist/stage produced by build-sea.mjs (default resolved)
#   OUT                               output dir for the .pkg (default dist/out)
#   APPLE_CERT_P12                    base64 of a .p12 holding BOTH "Developer ID Application" and
#                                     "Developer ID Installer" certs
#   APPLE_CERT_PASSWORD               password for that .p12
#   APPLE_SIGN_IDENTITY               "Developer ID Application: NAME (TEAMID)"
#   APPLE_INSTALLER_IDENTITY          "Developer ID Installer: NAME (TEAMID)"
#   APPLE_API_KEY                     base64 of the App Store Connect API key (.p8) for notarytool
#   APPLE_API_KEY_ID, APPLE_API_ISSUER
#
# Missing signing/notary env degrades to an UNSIGNED pkg with a loud warning (so forks still build).
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${STAGE:-$AGENT_DIR/dist/stage}"
OUT="${OUT:-$AGENT_DIR/dist/out}"
APP_ID="com.binarybanana.whipdesk"
ENTITLEMENTS="$AGENT_DIR/packaging/entitlements.plist"
PKG="$OUT/whipdesk-${VERSION}-macos-${ARCH}.pkg"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
mkdir -p "$OUT"

# 1) Import the signing certs into a throwaway keychain (only if provided).
if [[ -n "${APPLE_CERT_P12:-}" ]]; then
  KEYCHAIN="$TMP/whipdesk.keychain-db"
  KPW="$(openssl rand -hex 20)"
  security create-keychain -p "$KPW" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$KPW" "$KEYCHAIN"
  echo "$APPLE_CERT_P12" | base64 --decode > "$TMP/cert.p12"
  security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "${APPLE_CERT_PASSWORD:-}" -T /usr/bin/codesign -T /usr/bin/productbuild
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KPW" "$KEYCHAIN" >/dev/null
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | sed 's/"//g')
  # Show what actually landed in the keychain. codesign/productbuild fail with a cryptic "specified
  # item could not be found in the keychain" when APPLE_CERT_P12 is missing the Developer ID
  # Application/Installer identity (or its private key), or when APPLE_SIGN_IDENTITY /
  # APPLE_INSTALLER_IDENTITY don't EXACTLY match the names below. Expect TWO identities.
  echo "Signing identities available in the build keychain:"
  security find-identity -v "$KEYCHAIN" || true
fi

sign() { codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$APPLE_SIGN_IDENTITY" "$1"; }

# 2) Sign every Mach-O (notarization requires it): inner binaries (ffmpeg, *.node) first, exe last.
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  while IFS= read -r -d '' f; do
    if file "$f" | grep -q "Mach-O"; then sign "$f"; fi
  done < <(find "$STAGE/resources" -type f -print0)
  sign "$STAGE/whipdesk"
else
  echo "::warning::APPLE_SIGN_IDENTITY unset — building UNSIGNED pkg (Gatekeeper will block it)."
fi

# 3) Assemble payload at the fixed install path; postinstall drops the /usr/local/bin symlink.
PKGROOT="$(mktemp -d)"; SCRIPTS="$(mktemp -d)"; COMPONENT="$(mktemp -d)/component.pkg"
mkdir -p "$PKGROOT/usr/local/whipdesk"
cp -R "$STAGE/." "$PKGROOT/usr/local/whipdesk/"
cat > "$SCRIPTS/postinstall" <<'EOF'
#!/bin/bash
set -e
mkdir -p /usr/local/bin
ln -sf /usr/local/whipdesk/whipdesk /usr/local/bin/whipdesk
exit 0
EOF
chmod +x "$SCRIPTS/postinstall"
pkgbuild --root "$PKGROOT" --identifier "$APP_ID" --version "$VERSION" --scripts "$SCRIPTS" --install-location "/" "$COMPONENT"

# 4) Wrap in a (signed) product archive.
if [[ -n "${APPLE_INSTALLER_IDENTITY:-}" ]]; then
  productbuild --package "$COMPONENT" --sign "$APPLE_INSTALLER_IDENTITY" "$PKG"
else
  echo "::warning::APPLE_INSTALLER_IDENTITY unset — pkg will be unsigned."
  productbuild --package "$COMPONENT" "$PKG"
fi

# 5) Notarize + staple (offline Gatekeeper approval; works for .pkg).
if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  echo "$APPLE_API_KEY" | base64 --decode > "$TMP/AuthKey.p8"
  NOTARY=(--key "$TMP/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
  # `submit --wait` returns 0 even when Apple rejects the package (status: Invalid), so inspect the
  # status ourselves and ALWAYS print the notary log — that log is the ONLY place Apple explains the
  # per-file reason ("hardened runtime missing", "SDK too old", …). Without it, stapler just fails
  # later with a useless "Record not found".
  SUB_JSON="$(xcrun notarytool submit "$PKG" "${NOTARY[@]}" --output-format json --wait)"
  echo "$SUB_JSON"
  SUB_ID="$(printf '%s' "$SUB_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
  SUB_STATUS="$(printf '%s' "$SUB_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
  if [[ -n "$SUB_ID" ]]; then
    echo "----- Apple notary log ($SUB_ID) -----"
    xcrun notarytool log "$SUB_ID" "${NOTARY[@]}" || true
  fi
  if [[ "$SUB_STATUS" != "Accepted" ]]; then
    echo "::error::Notarization status '$SUB_STATUS' — see the notary log above for the exact reason."
    exit 1
  fi
  xcrun stapler staple "$PKG"
  xcrun stapler validate "$PKG"
else
  echo "::warning::Notary creds unset — skipping notarization/staple."
fi

echo "packaged: $PKG"
