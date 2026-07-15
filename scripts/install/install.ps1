<#
WhipDesk installer for Windows. Served at https://whipdesk.com/install.ps1
(canonical source: scripts/install/install.ps1 in the open-source repo — audit it there).

  powershell -c "irm https://whipdesk.com/install.ps1 | iex"
  powershell -c "& ([scriptblock]::Create((irm https://whipdesk.com/install.ps1))) -Version v0.1.4"
  powershell -c "& ([scriptblock]::Create((irm https://whipdesk.com/install.ps1))) -Interactive"

What it does (and nothing else):
  default      — downloads the release zip from GitHub Releases, verifies its
                 SHA-256 against the release's SHA256SUMS.txt, extracts to
                 %LOCALAPPDATA%\Programs\WhipDesk, and adds that folder to your user PATH.
  -Interactive — downloads the Setup wizard (whipdesk-<ver>-windows-x64-setup.exe),
                 verifies it, and launches it instead.

No admin rights required. Artifacts are built by GitHub Actions from the tagged source with
SLSA provenance — see docs/VERIFYING-DOWNLOADS.md in the repo.
#>
param(
  [string]$Version = "",
  [switch]$Interactive
)

$ErrorActionPreference = "Stop"
$Repo = "BinaryBananaLLC/WhipDesk"

function Say([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

if ([Environment]::Is64BitOperatingSystem -eq $false) { Fail "WhipDesk requires 64-bit Windows." }

# Resolve the version from the /releases/latest redirect — no API, no rate limits.
if (-not $Version) {
  Say "Resolving latest release"
  $resp = [System.Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
  $resp.AllowAutoRedirect = $false
  $location = $resp.GetResponse().Headers["Location"]
  $Version = ($location -split "/")[-1]
  # Accept both v-prefixed (v0.2.0) and bare (0.2.0) release tags — $Base uses the tag verbatim and
  # $Ver is the v-stripped number for asset names, so either form resolves correctly.
  if ($Version -notmatch '^v?\d+\.\d+\.\d+') { Fail "could not resolve the latest version (got '$Version')" }
}
$Ver = $Version.TrimStart("v")
$Base = "https://github.com/$Repo/releases/download/$Version"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "whipdesk-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-Verified([string]$asset) {
  $file = Join-Path $tmp $asset
  Say "Downloading $asset"
  Invoke-WebRequest -Uri "$Base/$asset" -OutFile $file -UseBasicParsing
  Say "Verifying checksum"
  # Download the sums to a file and read it with Get-Content — do NOT parse (IWR).Content directly.
  # GitHub serves release assets as Content-Type: application/octet-stream, so on Windows PowerShell
  # .Content comes back as a Byte[], not a string; splitting that on newlines yields the space-joined
  # byte values instead of text and every filename lookup fails ("not found in SHA256SUMS.txt").
  $sumsFile = Join-Path $tmp "SHA256SUMS.txt"
  Invoke-WebRequest -Uri "$Base/SHA256SUMS.txt" -OutFile $sumsFile -UseBasicParsing
  # Lines are "<sha256>  <filename>"; match the filename field exactly (not a substring), so
  # whipdesk-...-x64.zip can never be confused with whipdesk-...-x64-setup.exe.
  $line = Get-Content $sumsFile | Where-Object { ($_ -split "\s+", 2)[1] -eq $asset } | Select-Object -First 1
  if (-not $line) { Fail "$asset not found in SHA256SUMS.txt" }
  $expected = ($line -split "\s+")[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($actual -ne $expected) { Fail "checksum mismatch for $asset — refusing to install" }
  return $file
}

try {
  if ($Interactive) {
    $setup = Get-Verified "whipdesk-$Ver-windows-x64-setup.exe"
    Say "Launching the setup wizard"
    Start-Process -FilePath $setup -Wait
  } else {
    $zip = Get-Verified "whipdesk-$Ver-windows-x64.zip"
    $dest = Join-Path $env:LOCALAPPDATA "Programs\WhipDesk"
    Say "Installing to $dest"
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    # The zip contains a single "whipdesk" folder — move its contents into place.
    Move-Item -Path (Join-Path $tmp "whipdesk\*") -Destination $dest -Force

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not ($userPath -split ";" | Where-Object { $_ -eq $dest })) {
      Say "Adding $dest to your user PATH"
      [Environment]::SetEnvironmentVariable("Path", "$userPath;$dest", "User")
      Write-Host "    (open a NEW terminal for PATH to take effect)"
    }
    Say "Done. Run: whipdesk"
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
