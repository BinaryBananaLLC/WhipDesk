# Releasing WhipDesk

Releases are **manual and human-triggered**. Nothing is built per commit.

## Cut a release

1. Go to <https://github.com/BinaryBananaLLC/WhipDesk/releases/new>.
2. Create a tag `vX.Y.Z` (semver), write the notes, and **Publish**.
   - Tick *Set as a pre-release* to build/upload the platform packages **without** publishing to npm.
3. Publishing fires [`.github/workflows/release.yml`](../.github/workflows/release.yml), which:
   - stamps the tag into `apps/desktop-agent/package.json` → `src/version.ts` (single source of truth),
   - builds the SEA per OS/arch (macOS arm64 + x64, Windows x64, Linux x64),
   - signs + notarizes + staples the macOS `.pkg`, zips Windows, tars Linux,
   - writes `SHA256SUMS.txt` and generates SLSA build-provenance attestations,
   - uploads everything to the release (`fail_on_unmatched_files: true`),
   - `npm publish --provenance` (non-prerelease only), and
   - updates the Homebrew cask in the tap so `brew install --cask whipdesk` tracks the release.

To rebuild assets for an existing tag without re-publishing the release, run the workflow via
**Actions → Release → Run workflow** and pass the tag.

## Versioning model

- **Release version** (`vX.Y.Z`): drives artifact names, `npm`, and the "update available" nudge.
  The git tag is the single source — `scripts/sync-version.mjs` writes it into `src/version.ts`.
- **`PROTOCOL_VERSION`** (`packages/protocol`): the wire contract, mirrored in `apps/mobile-web/src/core.ts`.
  Bump it **only** on a breaking wire change. The always-fresh web client refuses/​warns on a mismatch
  (see the agent-outdated banner) instead of us carrying backward-compat shims.
- The WWW dashboard reads the latest release from the GitHub API and flags any device whose reported
  `agentVersion` is behind (`src/lib/latestRelease.ts`).

## Required repo secrets

| Secret | Purpose | Needed for |
| --- | --- | --- |
| `APPLE_CERT_P12` | base64 of a `.p12` with **Developer ID Application** + **Developer ID Installer** certs | macOS signing |
| `APPLE_CERT_PASSWORD` | password for that `.p12` | macOS signing |
| `APPLE_SIGN_IDENTITY` | `Developer ID Application: NAME (TEAMID)` | macOS signing |
| `APPLE_INSTALLER_IDENTITY` | `Developer ID Installer: NAME (TEAMID)` | macOS `.pkg` signing |
| `APPLE_API_KEY` | base64 of the App Store Connect API key (`.p8`) | notarization |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | notarytool key id + issuer | notarization |
| `NPM_TOKEN` | npm automation token with publish rights to `whipdesk` | npm publish |
| `HOMEBREW_TAP_TOKEN` | *(optional)* PAT with write access to the `homebrew-whipdesk` tap | Homebrew cask update |

Missing Apple secrets degrade gracefully (unsigned artifacts + a workflow warning) so forks still build.
Integrity is anchored by **SLSA build-provenance attestations** + the published `SHA256SUMS.txt` (no GPG).
Windows is intentionally **attestation-only** (no code-signing cert) — see the trust story in
[VERIFYING-DOWNLOADS.md](VERIFYING-DOWNLOADS.md).

### macOS notarization toolchain

The arm64 build must run on **`macos-15` or newer**, not `macos-14`. `macos-14`'s (Sonoma) `codesign`
signs the postject'd SEA binary such that it passes local `codesign --verify` but the notary rejects
it with *"The signature of the binary is invalid."* Newer toolchains sign it correctly (verified
end-to-end locally against the real Developer ID certs). The x64 build still runs on `macos-13` (the
only free Intel runner). If x64 notarization hits the same signature rejection, the options are: cut
Intel over to the npm/Homebrew path only, or cross-build the x64 SEA on `macos-15` — the arm64 `.pkg`
is the primary artifact.

## Homebrew tap setup (one-time)

`brew install --cask whipdesk` is served from a separate **tap** repo. To enable the automatic
cask bump on each release:

1. Create a **public** repo **`homebrew-whipdesk`** under the `BinaryBananaLLC` org (the
   `homebrew-` prefix is required; leave it empty — the workflow writes `Casks/whipdesk.rb`).
2. Create a token the release workflow can push to that repo with:
   - a **fine-grained PAT** scoped to *only* `BinaryBananaLLC/homebrew-whipdesk` with
     **Contents: Read and write**, **or**
   - a classic PAT with the `repo` scope.
3. Add it to **this** repo as the secret **`HOMEBREW_TAP_TOKEN`**
   (Settings → Secrets and variables → Actions).

That's the whole setup. Until the secret exists the `homebrew` job just warns and skips — the rest
of the release is unaffected. After the first release that runs it, users install with:

```bash
brew install --cask BinaryBananaLLC/whipdesk/whipdesk
# or:  brew tap BinaryBananaLLC/whipdesk && brew install --cask whipdesk
```

## Local dry run

```bash
npm ci
npm run build:sea --workspace whipdesk   # -> apps/desktop-agent/dist/stage/whipdesk[.exe]
npm publish --dry-run --provenance --workspace whipdesk
```
