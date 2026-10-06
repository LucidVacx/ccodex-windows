# Removes CCodex for Windows: stops its gateway, restores the user CODEX_CLI_PATH and PATH, removes ~\.ccodex\bin,
# versions and current (state stays unless -Purge).
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-Purge]
[CmdletBinding()]
param([switch]$Purge)
# Native tools (npm, cargo) write progress to stderr, which Windows PowerShell 5.1 turns into errors under Stop:
# failures are checked by exit code, and cmdlets that must not fail say -ErrorAction Stop.
$ErrorActionPreference = 'Continue'

$home_ = if ($env:CCODEX_HOME) { $env:CCODEX_HOME } else { Join-Path $env:USERPROFILE '.ccodex' }
$main = Join-Path $home_ 'current\node_modules\@gkorepanov\ccodex\dist\cli\main.js'
if (-not (Test-Path $main)) {
  [Console]::Error.WriteLine("CCodex uninstall: no activated CCodex in $home_ (missing $main).")
  exit 1
}
# The Node setup recorded for the launcher; else the one on PATH. Not the launcher itself: it could not delete
# ~\.ccodex\bin\ccodex.exe while running from it.
$node = $null
$sidecar = Join-Path $home_ 'bin\ccodex-launcher.cfg'
if (Test-Path $sidecar) {
  $line = Get-Content $sidecar | Where-Object { $_ -like 'node=*' } | Select-Object -First 1
  if ($line) { $node = $line.Substring(5).Trim() }
}
if (-not $node -or -not (Test-Path $node)) { $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  [Console]::Error.WriteLine('CCodex uninstall needs Node.js. Install Node.js 22 or 24 LTS, then rerun this command.')
  exit 1
}
$arguments = @('uninstall')
if ($Purge) { $arguments += @('--purge', '--yes') }
& $node $main @arguments
exit $LASTEXITCODE
