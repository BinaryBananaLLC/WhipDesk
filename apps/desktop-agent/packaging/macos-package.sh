#!/usr/bin/env bash
# Signs + notarizes + staples the staged SEA build into a .pkg installer.
#
# The .pkg installs the CLI under a FIXED path (/usr/local/whipdesk/libexec) and symlinks
# /usr/local/bin/whipdesk, so the code-signature identity/path stay stable across updates —
# which keeps the user's Screen Recording / Accessibility (TCC) grants after upgrading. The payload
# lives in a `libexec` subdir (not directly in /usr/local/whipdesk) so the executable's parent dir
# name != the executable name — see the note at the payload-assembly step for why that matters.
#
# Mach-O binaries are signed with `rcodesign` (indygreg/apple-codesign), NOT Apple's `codesign`:
# macOS 14/15 runners' codesign mis-signs the large postject'd SEA binary (passes local
# `codesign --verify`, but the notary rejects it as "signature invalid"); rcodesign is a
# version-stable, runner-independent signer whose signatures notarize on every runner. The .pkg
# installer itself is still signed by `productbuild` (installer signing was never the problem).
#
# Env in:
#   VERSION, ARCH                     e.g. 1.4.0, arm64|x64
#   STAGE                             dist/stage produced by build-sea.mjs (default resolved)
#   OUT                               output dir for the .pkg (default dist/out)
#   APPLE_CERT_P12                    base64 of a .p12 holding BOTH "Developer ID Application" and
#                                     "Developer ID Installer" certs (the Application identity is
#                                     extracted from it for rcodesign; unset -> use login keychain)
#   APPLE_CERT_PASSWORD               password for that .p12
#   APPLE_SIGN_IDENTITY               "Developer ID Application: NAME (TEAMID)" (Mach-O signing)
#   APPLE_INSTALLER_IDENTITY          "Developer ID Installer: NAME (TEAMID)" (.pkg signing)
#   APPLE_API_KEY                     base64 of the App Store Connect API key (.p8) for notarytool
#   APPLE_API_KEY_ID, APPLE_API_ISSUER
#   RCODESIGN                         optional path to the rcodesign binary (default: on PATH)
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

# 1) Import the signing certs into a throwaway keychain (only if provided). This keychain is used by
#    `productbuild` to sign the .pkg with the Developer ID INSTALLER identity. The Mach-O binaries are
#    signed separately by rcodesign (see below), which reads the Application identity from the p12.
if [[ -n "${APPLE_CERT_P12:-}" ]]; then
  KEYCHAIN="$TMP/whipdesk.keychain-db"
  KPW="$(openssl rand -hex 20)"
  security create-keychain -p "$KPW" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$KPW" "$KEYCHAIN"
  echo "$APPLE_CERT_P12" | base64 --decode > "$TMP/cert.p12"
  security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "${APPLE_CERT_PASSWORD:-}" -T /usr/bin/productbuild
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KPW" "$KEYCHAIN" >/dev/null
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | sed 's/"//g')
  # Show what landed in the keychain. productbuild fails with a cryptic "specified item could not be
  # found in the keychain" when APPLE_CERT_P12 is missing the Developer ID Installer identity (or its
  # private key), or when APPLE_INSTALLER_IDENTITY doesn't EXACTLY match the name. Expect TWO identities.
  echo "Signing identities available in the build keychain:"
  security find-identity -v "$KEYCHAIN" || true
fi

# --- Mach-O signing: rcodesign, NOT Apple's codesign -------------------------------------------------
RCODESIGN="${RCODESIGN:-rcodesign}"
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]] && ! command -v "$RCODESIGN" >/dev/null 2>&1; then
  echo "::error::rcodesign not found on PATH (set \$RCODESIGN). The release workflow installs it."; exit 1
fi

# Extract the "Developer ID Application" identity (cert + its matching private key) from a possibly
# multi-identity .p12 into a unified PEM. Order-independent: it pairs key<->cert by public key, because
# rcodesign otherwise signs with the LAST identity in the p12 — which may be the Installer cert (wrong
# for Mach-O). openssl `-legacy` is for OpenSSL 3; the fallback covers LibreSSL / older p12 formats.
extract_app_pem() {
  local p12="$1" pass="$2" out="$3" dump tmpd appcert="" appkey="" certpub c k
  dump="$(mktemp)"; tmpd="$(mktemp -d)"
  openssl pkcs12 -legacy -in "$p12" -passin "pass:$pass" -nodes >"$dump" 2>/dev/null \
    || openssl pkcs12 -in "$p12" -passin "pass:$pass" -nodes >"$dump" 2>/dev/null
  awk -v d="$tmpd" '/-----BEGIN/{n++;f=d"/obj_"n".pem"} {if(f)print >f} /-----END/{f=""}' "$dump"
  for c in "$tmpd"/obj_*.pem; do
    openssl x509 -in "$c" -noout -subject 2>/dev/null | grep -q "Developer ID Application" && { appcert="$c"; break; }
  done
  [[ -n "$appcert" ]] || { echo "::error::no 'Developer ID Application' cert found in APPLE_CERT_P12"; exit 1; }
  certpub="$(openssl x509 -in "$appcert" -noout -pubkey 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | shasum -a 256 | awk '{print $1}')"
  for k in "$tmpd"/obj_*.pem; do
    [[ "$(openssl pkey -in "$k" -pubout -outform DER 2>/dev/null | shasum -a 256 | awk '{print $1}')" == "$certpub" ]] && { appkey="$k"; break; }
  done
  [[ -n "$appkey" ]] || { echo "::error::no private key matching the Application cert in APPLE_CERT_P12"; exit 1; }
  cat "$appkey" "$appcert" >"$out"; rm -rf "$tmpd" "$dump"
}

# Resolve the rcodesign certificate source once: the p12 secret in CI, else the login keychain locally.
RC_CERT_ARGS=()
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  if [[ -n "${APPLE_CERT_P12:-}" ]]; then
    extract_app_pem "$TMP/cert.p12" "${APPLE_CERT_PASSWORD:-}" "$TMP/app-signing.pem"
    RC_CERT_ARGS=(--pem-file "$TMP/app-signing.pem")
  else
    # Local dev: use the Developer ID Application key already in the login keychain, by SHA-256.
    FP="$(security find-certificate -Z -c "$APPLE_SIGN_IDENTITY" 2>/dev/null | awk '/SHA-256 hash:/{print $3; exit}')"
    [[ -n "$FP" ]] || { echo "::error::'$APPLE_SIGN_IDENTITY' not found in keychain"; exit 1; }
    RC_CERT_ARGS=(--keychain-fingerprint "$FP")
  fi
fi

# Sign a single Mach-O in place: hardened runtime + entitlements + Apple timestamp (rcodesign default).
sign() { "$RCODESIGN" sign --code-signature-flags runtime --entitlements-xml-file "$ENTITLEMENTS" "${RC_CERT_ARGS[@]}" "$1"; }

# 2) Sign every Mach-O (notarization requires it): inner binaries (ffmpeg, *.node) first, exe last.
if [[ -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  while IFS= read -r -d '' f; do
    if file "$f" | grep -q "Mach-O"; then sign "$f"; fi
  done < <(find "$STAGE/resources" -type f -print0)
  # The main binary was ad-hoc signed by build-sea.mjs after postject injected the NODE_SEA segment;
  # rcodesign replaces that signature in place (no `codesign --remove-signature` needed).
  sign "$STAGE/whipdesk"
  # Catch a bad signature HERE (Apple codesign validates rcodesign's signature) instead of at the notary.
  codesign --verify --strict --verbose=2 "$STAGE/whipdesk"
else
  echo "::warning::APPLE_SIGN_IDENTITY unset — building UNSIGNED pkg (Gatekeeper will block it)."
fi

# 3) Assemble payload at the fixed install path; postinstall drops the /usr/local/bin symlink.
#    The SEA + its resources/ go in a `libexec` subdir (NOT directly in /usr/local/whipdesk). If the
#    executable sat at /usr/local/whipdesk/whipdesk next to resources/, that directory — named
#    "whipdesk", containing an executable "whipdesk" AND a "resources" dir (== "Resources" on
#    case-insensitive APFS) — is detected by macOS as a legacy flat *bundle*. The notary then expects
#    a bundle signature with sealed resources and rejects our lone-Mach-O signature as "the signature
#    of the binary is invalid" (reproduced: exe-name==dir-name AND a Resources dir is the exact
#    trigger). Nesting under libexec/ makes the parent dir "libexec" != "whipdesk", so it stays a
#    plain directory. The loader resolves resources as <exeDir>/resources, so siblings must move together.
PKGROOT="$(mktemp -d)"; SCRIPTS="$(mktemp -d)"; COMPONENT="$(mktemp -d)/component.pkg"
mkdir -p "$PKGROOT/usr/local/whipdesk/libexec"
cp -R "$STAGE/." "$PKGROOT/usr/local/whipdesk/libexec/"
cat > "$SCRIPTS/postinstall" <<'EOF'
#!/bin/bash
set -e
mkdir -p /usr/local/bin
ln -sf /usr/local/whipdesk/libexec/whipdesk /usr/local/bin/whipdesk
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
