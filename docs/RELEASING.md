# Releasing WhipDesk

Releases are **manual and human-triggered**. Nothing is built per commit.

> ⚠️ **Never use the Releases page** (Releases → "Draft a new release" → Publish).
> This repo uses **immutable releases**: publishing seals the release instantly, so CI can never
> attach the binaries — and the tag name is **burned forever** (deleting the sealed release does
> not free it; GitHub permanently refuses a new release on that tag). This burned v0.0.8–v0.0.12.
> The workflow creates, fills, and publishes the release itself — start it one of the two ways below.

## Cut a release (in the browser — recommended)

1. Go to **[Actions → Release](https://github.com/BinaryBananaLLC/WhipDesk/actions/workflows/release.yml)**.
2. Click **Run workflow** (top right of the runs list).
3. Leave branch `main`, type the new tag — e.g. `v0.1.0` — and click **Run workflow**.

The workflow creates the tag at `main`'s HEAD and does everything else. No terminal, no Releases page.

## Cut a release (terminal alternative)

```bash
git tag v0.1.0        # semver, with the leading v
git push origin v0.1.0
```

Either way, [`.github/workflows/release.yml`](../.github/workflows/release.yml) then:

- stamps the tag into `apps/desktop-agent/package.json` → `src/version.ts` (single source of truth),
- builds the SEA per OS/arch (macOS arm64 + x64, Windows x64, Linux x64 + arm64),
- signs + notarizes + staples the macOS `.pkg`; authenticode-signs the Windows exe via SignPath
  (when configured), zips Windows, tars Linux,
- writes `SHA256SUMS.txt` and generates SLSA build-provenance attestations,
- **creates the GitHub Release as a draft, attaches every asset, then publishes it** (see below),
  with auto-generated release notes,
- `npm publish --provenance` (non-prerelease only), and
- updates the Homebrew cask, the Scoop bucket, and the winget manifest (each when its token is
  configured) so `brew` / `scoop` / `winget` installs track the release.

A **pre-release** tag — any tag with a hyphen suffix, e.g. `v0.1.0-rc.1` — builds and publishes the
GitHub Release only, skipping npm/brew/scoop/winget (the old "Set as a pre-release" tick).

To rebuild an existing tag, use the same **Run workflow** button and enter the existing tag.

### Why not "Publish a release" on the Releases page

GitHub's **immutable releases** seals a release the instant it's published — you can no longer add
assets to it. So the assets have to be attached while the release is still a *draft*, and only then
flipped to published. That means CI must own release creation: if a human published an empty release
in the UI first, it would be sealed with no binaries and the upload would fail with
*"Cannot upload asset … to an immutable release."* (This broke v0.0.8–v0.0.10 — and those tag names
are now permanently unusable for releases.) The workflow guards against this: it fails fast in the
`resolve` job if a published release already exists for the tag. Notes are auto-generated; the
release **body stays editable** after publish if you want to polish them — only the tag and assets
are frozen.

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
| `SCOOP_TAP_TOKEN` | *(optional)* PAT with write access to the `scoop-whipdesk` bucket repo | Scoop manifest update |
| `WINGET_TOKEN` | *(optional)* classic PAT (`public_repo`) on a fork of `microsoft/winget-pkgs` | winget manifest PR |
| `SIGNPATH_API_TOKEN`, `SIGNPATH_ORG_ID` | *(optional)* [SignPath OSS](https://signpath.io/open-source) API token + organization id | Windows authenticode signing |

Missing Apple/SignPath secrets degrade gracefully (unsigned artifacts + a workflow warning) so
forks still build. Integrity is anchored by **SLSA build-provenance attestations** + the published
`SHA256SUMS.txt` (no GPG) — see the trust story in [VERIFYING-DOWNLOADS.md](VERIFYING-DOWNLOADS.md).

### macOS signing & notarization

Mach-O binaries (the SEA executable + its bundled native libs) are signed with **`rcodesign`**
([indygreg/apple-codesign](https://github.com/indygreg/apple-platform-rs)), **not** Apple's
`codesign`. The workflow installs a pinned, checksum-verified `rcodesign` on the macOS runners.
Because rcodesign is a version-stable, runner-independent signer, the runner's macOS version no
longer affects notarization — the arm64 (`macos-15`) and x64 (`macos-15-intel`) legs notarize identically.
(This replaced a `codesign` flow whose signature for the large postject'd SEA binary passed local
`codesign --verify` but the notary rejected as *"The signature of the binary is invalid."*)

The Mach-O signing cert is the **Developer ID Application** identity, extracted from `APPLE_CERT_P12`
at build time (rcodesign otherwise signs with the *last* identity in the p12, which may be the
Installer cert). The `.pkg` itself is still signed by `productbuild` with the **Developer ID Installer**
identity.

The payload installs under **`/usr/local/whipdesk/libexec/`** — *not* directly in `/usr/local/whipdesk`.
A directory named `whipdesk` holding an executable `whipdesk` **and** a `resources` dir (≈ `Resources`
on case-insensitive APFS) is detected by macOS as a legacy *flat bundle*, so the notary rejects the
lone-Mach-O signature as invalid. Nesting under `libexec` makes the executable's parent dir name differ
from the executable name, keeping it a plain directory; `/usr/local/bin/whipdesk` symlinks to it. Both
the arm64 and x64 `.pkg`s are verified to notarize + staple end-to-end.

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
