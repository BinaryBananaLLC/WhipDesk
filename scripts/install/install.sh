#!/usr/bin/env bash
# WhipDesk installer for macOS + Linux. Served at https://whipdesk.com/install.sh
# (canonical source: scripts/install/install.sh in the open-source repo - audit it there).
#
#   curl -fsSL https://whipdesk.com/install.sh | bash
#   curl -fsSL https://whipdesk.com/install.sh | bash -s -- --method npm
#   curl -fsSL https://whipdesk.com/install.sh | bash -s -- --version v0.1.4
#
# What it does (and nothing else):
#   macOS  - Homebrew cask when brew is present (tracks updates), otherwise the signed +
#            notarized .pkg from GitHub Releases (checksum-verified, needs sudo for installer).
#   Linux  - the .tar.gz from GitHub Releases (checksum-verified) into ~/.local/share/whipdesk
#            with a symlink at ~/.local/bin/whipdesk. No sudo.
#   --method npm - `npm install -g whipdesk` instead (needs Node >= 20).
#
# Every downloaded artifact is verified against the release's SHA256SUMS.txt. All artifacts are
# built by GitHub Actions from the tagged source with SLSA provenance - see
# https://github.com/BinaryBananaLLC/WhipDesk/blob/main/docs/VERIFYING-DOWNLOADS.md
set -euo pipefail

REPO="BinaryBananaLLC/WhipDesk"
METHOD="auto" # auto | brew | pkg | tar | npm
VERSION=""    # empty = latest

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method) METHOD="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $1 (try --method npm|brew|pkg|tar, --version vX.Y.Z)" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Remove a WhipDesk installed by npm -g so it can't shadow a brew/pkg/tar install on PATH (and so
# its own updater stops nagging). Only called from the non-npm installers, so we never remove the
# copy we just placed. Best-effort - a failure here must not fail the install.
remove_conflicting_installs() {
  if command -v npm >/dev/null 2>&1; then
    local npm_bin
    npm_bin="$(npm prefix -g 2>/dev/null)/bin/whipdesk"
    if [[ -e "$npm_bin" ]]; then
      say "Removing old npm global install of WhipDesk"
      npm rm -g whipdesk >/dev/null 2>&1 || true
    fi
  fi
}

# After install, warn if some OTHER whipdesk still resolves first on PATH (e.g. an old copy we can't
# safely remove). $1 is the path we just installed.
warn_if_shadowed() {
  hash -r 2>/dev/null || true
  local found; found="$(command -v whipdesk 2>/dev/null || true)"
  if [[ -n "$found" && "$found" != "$1" ]]; then
    printf '\n\033[1;33mNOTE:\033[0m another "whipdesk" is ahead on your PATH and may shadow this install:\n  %s\nRemove it (or adjust PATH so %s wins), then reopen your terminal.\n' "$found" "$1" >&2
  fi
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"

# Resolve the version from the /releases/latest redirect - no API, no rate limits.
if [[ -z "$VERSION" ]]; then
  say "Resolving latest release"
  final_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"
  VERSION="${final_url##*/}"
  [[ "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "could not resolve the latest version (got '$VERSION')"
fi
# Normalize whichever form was supplied. Release TAGS are always v-prefixed (v1.0.0) while asset
# names use the bare number (whipdesk-1.0.0-...), so accept `--version 1.0.0` and `--version v1.0.0`
# alike: $VER is the bare number for asset names, $TAG is the v-prefixed tag for the download URL.
[[ "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "invalid --version '$VERSION' (expected e.g. v1.0.0 or 1.0.0)"
VER="${VERSION#v}"
TAG="v$VER"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

verify_checksum() { # file expected-name
  say "Verifying checksum"
  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"
  local expected
  expected="$(awk -v f="$2" '$2==f{print $1}' "$tmp/SHA256SUMS.txt")"
  [[ -n "$expected" ]] || fail "$2 not found in SHA256SUMS.txt"
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$1" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  fi
  [[ "$actual" == "$expected" ]] || fail "checksum mismatch for $2 - refusing to install"
}

install_npm() {
  command -v npm >/dev/null 2>&1 || fail "--method npm needs Node.js >= 20 (https://nodejs.org)"
  say "Installing via npm (npm install -g whipdesk@${VER})"
  npm install -g "whipdesk@${VER}"
  say "Done. Run: whipdesk"
}

install_brew() {
  say "Installing via Homebrew cask (brew install --cask ${REPO%/*}/whipdesk/whipdesk)"
  brew install --cask "BinaryBananaLLC/whipdesk/whipdesk"
  remove_conflicting_installs
  say "Done. Run: whipdesk"
}

install_pkg() {
  local asset="whipdesk-${VER}-macos-${ARCH}.pkg"
  say "Downloading ${asset} (signed + notarized)"
  curl -fL --progress-bar -o "$tmp/$asset" "$BASE/$asset"
  verify_checksum "$tmp/$asset" "$asset"
  say "Installing (sudo required by macOS installer)"
  sudo installer -pkg "$tmp/$asset" -target /
  remove_conflicting_installs
  say "Done. Run: whipdesk"
}

install_tar() {
  local asset="whipdesk-${VER}-linux-${ARCH}.tar.gz"
  local share="$HOME/.local/share"
  local bin="$HOME/.local/bin"
  say "Downloading ${asset}"
  curl -fL --progress-bar -o "$tmp/$asset" "$BASE/$asset"
  verify_checksum "$tmp/$asset" "$asset"
  say "Installing to ${share}/whipdesk"
  mkdir -p "$share" "$bin"
  rm -rf "$share/whipdesk"
  tar -C "$share" -xzf "$tmp/$asset"
  ln -sf "$share/whipdesk/whipdesk" "$bin/whipdesk"
  remove_conflicting_installs
  say "Done. Run: whipdesk"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) printf '\nNOTE: %s is not on your PATH. Add this to your shell profile:\n  export PATH="%s:$PATH"\n' "$bin" "$bin" ;;
  esac
  warn_if_shadowed "$bin/whipdesk"
}

case "$METHOD" in
  npm) install_npm ;;
  brew) [[ "$OS" == "Darwin" ]] || fail "--method brew is macOS-only"; install_brew ;;
  pkg) [[ "$OS" == "Darwin" ]] || fail "--method pkg is macOS-only"; install_pkg ;;
  tar) [[ "$OS" == "Linux" ]] || fail "--method tar is Linux-only"; install_tar ;;
  auto)
    if [[ "$OS" == "Darwin" ]]; then
      if command -v brew >/dev/null 2>&1; then install_brew; else install_pkg; fi
    elif [[ "$OS" == "Linux" ]]; then
      install_tar
    else
      fail "unsupported OS: $OS (on Windows use: powershell -c \"irm https://whipdesk.com/install.ps1 | iex\")"
    fi
    ;;
  *) fail "unknown --method '$METHOD' (npm|brew|pkg|tar)" ;;
esac
