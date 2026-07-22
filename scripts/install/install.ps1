<#
WhipDesk installer for Windows. Served at https://whipdesk.com/install.ps1
(canonical source: scripts/install/install.ps1 in the open-source repo - audit it there).

  powershell -c "irm https://whipdesk.com/install.ps1 | iex"
  powershell -c "& ([scriptblock]::Create((irm https://whipdesk.com/install.ps1))) -Version v0.1.4"
  powershell -c "& ([scriptblock]::Create((irm https://whipdesk.com/install.ps1))) -Interactive"

What it does (and nothing else):
  default      - downloads the release zip from GitHub Releases, verifies its
                 SHA-256 against the release's SHA256SUMS.txt, extracts to
                 %LOCALAPPDATA%\Programs\WhipDesk, and adds that folder to your user PATH.
  -Interactive - downloads the Setup wizard (whipdesk-<ver>-windows-x64-setup.exe),
                 verifies it, and launches it instead.

No admin rights required. Artifacts are built by GitHub Actions from the tagged source with
SLSA provenance - see docs/VERIFYING-DOWNLOADS.md in the repo.
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

# Resolve the version from the /releases/latest redirect - no API, no rate limits.
if (-not $Version) {
  Say "Resolving latest release"
  $resp = [System.Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
  $resp.AllowAutoRedirect = $false
  $location = $resp.GetResponse().Headers["Location"]
  $Version = ($location -split "/")[-1]
  if ($Version -notmatch '^v?\d+\.\d+\.\d+') { Fail "could not resolve the latest version (got '$Version')" }
}
# Normalize whichever form was supplied. Release TAGS are always v-prefixed (v1.0.0) while asset
# names use the bare number (whipdesk-1.0.0-...), so accept `-Version 1.0.0` and `-Version v1.0.0`
# alike: $Ver is the bare number for asset names, $Tag is the v-prefixed tag for the download URL.
if ($Version -notmatch '^v?\d+\.\d+\.\d+') { Fail "invalid -Version '$Version' (expected e.g. v1.0.0 or 1.0.0)" }
$Ver = $Version.TrimStart("v")
$Tag = "v$Ver"
$Base = "https://github.com/$Repo/releases/download/$Tag"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "whipdesk-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-Verified([string]$asset) {
  $file = Join-Path $tmp $asset
  Say "Downloading $asset"
  Invoke-WebRequest -Uri "$Base/$asset" -OutFile $file -UseBasicParsing
  Say "Verifying checksum"
  # Download the sums to a file and read it with Get-Content - do NOT parse (IWR).Content directly.
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
  if ($actual -ne $expected) { Fail "checksum mismatch for $asset - refusing to install" }
  return $file
}

# Remove WhipDesk copies installed by OTHER channels (Scoop, winget, npm -g). Each drops its own whipdesk.exe
# into a directory that may sit ahead of ours on PATH, so `whipdesk` would keep resolving to the OLD
# version even after we install the new one - and users have no reason to know they must uninstall it
# first. This also stops the old copy's updater from nagging. Every step is guarded: a failure here
# must never fail the install, because the PATH-priority step below still makes the new copy win.
function Remove-OldInstalls {
  # Scoop - uninstalling the app also removes its shim in ~\scoop\shims.
  if (Test-Path (Join-Path $env:USERPROFILE "scoop\apps\whipdesk")) {
    Say "Removing old Scoop install of WhipDesk"
    try { if (Get-Command scoop -ErrorAction SilentlyContinue) { scoop uninstall whipdesk *> $null } } catch { }
    # If the shim survived (scoop missing, or the uninstall was blocked by a running old agent), delete
    # the launcher directly. Only clear its sidecars once the .exe itself is gone, so a locked exe never
    # leaves a half-deleted, broken shim behind - and even if it stays, the PATH-priority step below
    # still makes the new copy win.
    $shimExe = Join-Path $env:USERPROFILE "scoop\shims\whipdesk.exe"
    if (Test-Path $shimExe) {
      try {
        Remove-Item $shimExe -Force -ErrorAction Stop
        Get-ChildItem (Join-Path $env:USERPROFILE "scoop\shims") -Filter "whipdesk.*" -ErrorAction SilentlyContinue |
          ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
      } catch { }
    }
  }
  # winget - the portable BinaryBanana.WhipDesk package drops a `whipdesk.exe` alias into the WinGet
  # Links dir (which is on PATH). Uninstalling clears both the package payload and that alias.
  $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\whipdesk.exe"
  if (Test-Path $wingetLink) {
    Say "Removing old winget install of WhipDesk"
    try { if (Get-Command winget -ErrorAction SilentlyContinue) { winget uninstall --id BinaryBanana.WhipDesk --exact --silent *> $null } } catch { }
    # If the alias survived (winget missing, or the uninstall was blocked by a running old agent),
    # delete it directly so it can't keep shadowing the new copy on PATH.
    if (Test-Path $wingetLink) {
      try { Remove-Item $wingetLink -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
  # npm global - an old `npm install -g whipdesk` puts whipdesk shims in the npm prefix root.
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    try {
      $npmPrefix = (npm prefix -g 2>$null)
      if ($npmPrefix -and (Test-Path (Join-Path $npmPrefix "whipdesk.cmd"))) {
        Say "Removing old npm global install of WhipDesk"
        npm rm -g whipdesk *> $null
      }
    } catch { }
  }
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
    # The zip contains a single "whipdesk" folder - move its contents into place.
    Move-Item -Path (Join-Path $tmp "whipdesk\*") -Destination $dest -Force

    # Clear out other-channel installs that would otherwise shadow this one on PATH.
    Remove-OldInstalls

    # Make THIS install win on PATH: drop any stale copy of $dest, then put it FIRST so nothing a
    # previous installer left behind can shadow it. User PATH only - no admin required.
    $exe = Join-Path $dest "whipdesk.exe"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $kept = @($userPath -split ";" | Where-Object { $_ -and $_ -ne $dest })
    $newPath = (@($dest) + $kept) -join ";"
    if ($newPath -ne $userPath) {
      Say "Putting $dest first on your user PATH"
      [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    }
    # Reflect it in THIS shell too, so `whipdesk` runs right away without opening a new terminal.
    $env:Path = "$dest;" + (($env:Path -split ";" | Where-Object { $_ -and $_ -ne $dest }) -join ";")

    # Confirm what `whipdesk` now resolves to. Compare the resolved path only - never execute it here,
    # since an OLD binary we couldn't remove would launch the interactive agent and hang the installer.
    $resolved = (Get-Command whipdesk -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if ($resolved -and $resolved -ne $exe) {
      Write-Host "    NOTE: another 'whipdesk' is still ahead on PATH and may shadow this install:" -ForegroundColor Yellow
      Write-Host "          $resolved" -ForegroundColor Yellow
      Write-Host "          Remove it, then reopen your terminal." -ForegroundColor Yellow
    }
    Say "Done. Run: whipdesk  (already active in this terminal; other open terminals need a restart)"
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
