# Phase 3.1 — local weekly tagger canary (the path that covers Cloudflare-walled
# sites). Runs the selector-anchor manifest for every per-site tagger against
# the live sites, using the warm branded-Chrome `test` profile that already has
# the extension hand-installed and a valid cf_clearance cookie — the only setup
# that gets Reddit / YouTube / StackOverflow to load. See CLAUDE.md → "Tagger
# canary / repair loop".
#
# Run once by hand:
#   pwsh -File scripts/tagger-canary-local.ps1
#
# Register as a weekly Windows Scheduled Task (Mondays 09:00 local):
#   $action  = New-ScheduledTaskAction -Execute 'pwsh' `
#     -Argument '-NoProfile -File C:\dev\discerned\scripts\tagger-canary-local.ps1' `
#     -WorkingDirectory 'C:\dev\discerned'
#   $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
#   Register-ScheduledTask -TaskName 'discerned-tagger-canary' `
#     -Action $action -Trigger $trigger -Description 'Weekly Discerned tagger selector canary'
#
# Result lands in test-output/tagger-canary.txt (also echoed to stdout). A dead
# selector exits non-zero.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "== Discerned tagger canary (local, warm profile) =="

# Preinstalled-extension path against real Chrome — the working method for
# CF-walled sites. Matches project_real_chrome_extension_cdp_load.
$env:CANARY = '1'
$env:BROWSER_CHANNEL = 'chrome'
$env:PREINSTALLED_EXT = '1'
# PROFILE defaults to 'test' inside the spec; override here if you keep the warm
# profile elsewhere.
if (-not $env:PROFILE) { $env:PROFILE = 'test' }

# The extension must be built into dist-test first (the profile loads dist-test).
# Safe: build:test writes only dist-test/, never the dev dist/.
pnpm --filter=./discerned-ext build:test

pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=tagger-canary
$code = $LASTEXITCODE

Write-Host ""
if (Test-Path "$repo/test-output/tagger-canary.txt") {
  Get-Content "$repo/test-output/tagger-canary.txt" | Write-Host
}

exit $code
