# Verifying WhipDesk downloads

WhipDesk can control your machine, so **prove a download came from this repo's source before you run it.**
Every release asset is built by GitHub Actions from the tagged commit and carries a cryptographic
[build-provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds).
None of this requires trusting a mirror or a hosted binary — the checks below tie the exact bytes you
downloaded to the exact workflow run and commit that produced them.

The one-liner installers (`https://whipdesk.com/install.sh`, `/install.ps1`) verify each download
against the release's `SHA256SUMS.txt` automatically before installing; their canonical, auditable
source lives in this repo at [`scripts/install/`](../scripts/install/).

## 1. Build provenance (strongest — recommended)

Requires the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify whipdesk-<ver>-<os>-<arch>.<ext> --repo BinaryBananaLLC/WhipDesk
```

A pass means: this file's SHA-256 was produced by the `Release` workflow in `BinaryBananaLLC/WhipDesk`,
from a specific commit — signed via Sigstore, not by us. If it fails, **do not run the file.**

## 2. Checksums

`SHA256SUMS.txt` is attached to every release. (Integrity is anchored by the build-provenance
attestation above; the checksums are a quick second check that doesn't need the GitHub CLI.)

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt        # run from the folder holding the downloads

# Windows (PowerShell)
Get-FileHash .\whipdesk-<ver>-windows-x64.zip -Algorithm SHA256
```

## 3. Per-platform OS checks

**macOS** — the `.pkg` is signed with a Developer ID and notarized+stapled by Apple:

```bash
spctl -a -vvv -t install whipdesk-<ver>-macos-arm64.pkg   # should say "accepted / Notarized Developer ID"
xcrun stapler validate whipdesk-<ver>-macos-arm64.pkg
```

**Windows** — verify the download by its SHA-256 against `SHA256SUMS.txt` (and the SLSA provenance
above) before running. WhipDesk's Windows builds are not yet code-signed, so SmartScreen will warn;
use **More info → Run anyway** only *after* the provenance/checksum checks above pass.

**Linux** — no OS signature layer; rely on the provenance + checksum checks.

## 4. npm

```bash
npm view whipdesk   # shows the published provenance statement / repo link
```

npm records the build provenance for the package too; the verified badge on the npmjs.com page links
to the workflow run that published it.
