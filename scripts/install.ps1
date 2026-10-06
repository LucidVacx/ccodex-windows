# CCodex for Windows, installed from this repository checkout (the published package carries no Windows launcher yet).
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# Builds the launcher (launcher\, Rust) and the TypeScript, packs the repo, then runs `ccodex setup` with that tarball:
# ~\.ccodex (versions, current, bin\codex.exe + ccodex.exe), user CODEX_CLI_PATH and PATH, Claude's codex MCP server.
# Double-click "scripts\Install CCodex.cmd" to run it without typing. Then it offers to log in to Claude.
[CmdletBinding()]
param(
  # Use launcher\bin\win32-<arch>\ccodex-launcher.exe as it is (no cargo build).
  [switch]$SkipLauncherBuild,
  # Ask nothing: stop a running gateway without asking, and skip the Claude login offer.
  [switch]$NonInteractive
)
# Native tools (npm, cargo) write progress to stderr, which Windows PowerShell 5.1 turns into errors under Stop:
# failures are checked by exit code, and cmdlets that must not fail say -ErrorAction Stop.
$ErrorActionPreference = 'Continue'

# Questions need a console someone types into (not -NonInteractive, redirected input, or powershell -NonInteractive).
$interactive = -not $NonInteractive -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and
  -not ([Environment]::GetCommandLineArgs() | Where-Object { $_ -ieq '-NonInteractive' })

function Fail([string]$Message) {
  [Console]::Error.WriteLine("CCodex install failed: $Message")
  exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repo 'package.json')) -or -not (Test-Path (Join-Path $repo 'launcher\Cargo.toml'))) {
  Fail 'run this script from a CCodex repository checkout (scripts\install.ps1).'
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'do not run this installer as Administrator: CCodex installs per user.'
}
$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
if (-not $arch) { Fail "unsupported architecture $($env:PROCESSOR_ARCHITECTURE); supported: x64, arm64." }

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'Node.js >=22.13 is missing. Install Node.js 22 or 24 LTS.' }
$nodeVersion = [version]((& $node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.13' -or $nodeVersion.Major -ge 27) { Fail "Node.js v$nodeVersion is unsupported. Install Node.js 22 or 24 LTS." }
# npm's own script, run by this Node (npm.cmd needs a shell, and this keeps the two in step).
$npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) { Fail "npm is missing beside $node. Reinstall Node.js 22 or 24 LTS." }
function Npm { & $node $npmCli @args; if ($LASTEXITCODE -ne 0) { Fail "npm $($args -join ' ') failed." } }
$npmMajor = [int]((& $node $npmCli --version).Split('.')[0])
if ($npmMajor -lt 10) { Fail 'npm >=10 is required. Run: npm install -g npm@latest' }

# The launcher ships inside the package: setup copies it to ~\.ccodex\bin.
$launcher = Join-Path $repo "launcher\bin\win32-$arch\ccodex-launcher.exe"
if (-not $SkipLauncherBuild) {
  $cargo = (Get-Command cargo.exe -ErrorAction SilentlyContinue).Source
  if (-not $cargo) {
    if (-not (Test-Path $launcher)) { Fail "cargo (Rust) is needed to build the launcher: install it from https://rustup.rs, or put a built launcher at $launcher" }
    Write-Host "cargo not found: using the existing $launcher"
  } else {
    Push-Location (Join-Path $repo 'launcher')
    try { & $cargo build --release; if ($LASTEXITCODE -ne 0) { Fail 'building the launcher failed.' } } finally { Pop-Location }
    New-Item -ItemType Directory -Force (Split-Path -Parent $launcher) -ErrorAction Stop | Out-Null
    Copy-Item -Force (Join-Path $repo 'launcher\target\release\ccodex-launcher.exe') $launcher -ErrorAction Stop
  }
}
if (-not (Test-Path $launcher)) { Fail "launcher missing: $launcher" }

Push-Location $repo
try {
  if (-not (Test-Path (Join-Path $repo 'node_modules\typescript'))) { Npm ci --no-audit --no-fund }
  Npm run build:ts
  $packs = Join-Path ([IO.Path]::GetTempPath()) "ccodex-pack-$PID"
  New-Item -ItemType Directory -Force $packs -ErrorAction Stop | Out-Null
  # Scripts already ran above; prepack would also regenerate the tracked legal notices.
  Npm pack --ignore-scripts --pack-destination $packs | Out-Null
} finally { Pop-Location }
$tarball = Get-ChildItem $packs -Filter *.tgz | Select-Object -First 1
if (-not $tarball) { Fail 'npm pack produced no tarball.' }
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version

$env:CCODEX_PACKAGE_SPEC = $tarball.FullName
try {
  # --repair: a local build reuses the version number, so reinstall it. Setup itself asks before stopping a running
  # gateway (its files are locked while it runs); --yes when nobody can answer.
  $setupArgs = @('setup', '--version', $version, '--repair')
  if (-not $interactive) { $setupArgs += '--yes' }
  & $node (Join-Path $repo 'dist\cli\main.js') @setupArgs
  if ($LASTEXITCODE -ne 0) { Fail "ccodex setup exited with $LASTEXITCODE." }
} finally {
  Remove-Item Env:\CCODEX_PACKAGE_SPEC
  Remove-Item -Recurse -Force $packs -ErrorAction SilentlyContinue
}
Write-Host "CCodex $version installed."

# Claude login, through the installed launcher by full path (this window's PATH predates the install).
$ccodexHome = if ($env:CCODEX_HOME) { $env:CCODEX_HOME } else { Join-Path $env:USERPROFILE '.ccodex' }
$ccodex = Join-Path $ccodexHome 'bin\ccodex.exe'
$loginStep = "Start menu -> CCodex - Log in to Claude, or run: `"$ccodex`" auth claude"
$status = $null
try { $status = (& $ccodex auth status 2>$null | Select-Object -Last 1) | ConvertFrom-Json } catch { }
if (-not $status) {
  Write-Host "Could not check the Claude login. To log in: $loginStep"
} elseif ($status.relayHost) {
  # setup printed how to switch from the third-party endpoint; a login alone would not change where Claude goes.
  Write-Host "Claude Code uses the third-party endpoint $($status.relayHost) (see the warning above). After removing it, log in: $loginStep"
} elseif (-not $status.anthropicLogin) {
  $why = if ($status.loggedIn) { "Claude Code is logged in with '$($status.authMethod)', not a claude.ai account." } else { 'Claude Code is not logged in.' }
  Write-Host $why
  if ($interactive) {
    $answer = Read-Host 'Log in to Claude now? [Y/n]'
    if ($answer -notmatch '^\s*n') {
      & $ccodex auth claude
      if ($LASTEXITCODE -eq 0) { Write-Host 'Logged in to Claude.' } else { Write-Host "Claude login did not finish. Later: $loginStep" }
    } else {
      Write-Host "Later: $loginStep"
    }
  } else {
    Write-Host "Next step, log in to Claude: $loginStep"
  }
} else {
  Write-Host "Claude: logged in as $($status.email) ($($status.authMethod))."
}
