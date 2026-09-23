<#
.SYNOPSIS
  Drive a full corpus sweep: preflight, backup, capture (in the background so
  review runs alongside it), then retry whatever got blocked.

.DESCRIPTION
  The sweep itself is corpus-sweep.spec.ts; this script is the wrapper around it
  that makes a fortnightly full run cheap in wall-clock and in attention.

  Four things it does that a bare `playwright test` invocation does not:

  1. PREFLIGHT. Chrome holding the Profile 3 lock, a stale-or-missing dist-test,
     or a dead dev server each fail the run — but only after it has been going
     long enough to matter. All three are checked in seconds up front, and
     dist-test is REBUILT when any build input is newer than it (rather than
     warning and continuing, which let a whole sweep measure superseded code).

  2. BACKUP. corpus-sweep-run/ is overwritten in place, so without a snapshot a
     regression is invisible: the new PNG silently replaces the old one and
     there is nothing to compare against. Always taken before capture starts.

  3. BACKGROUND CAPTURE. The run is started detached, so reviewing the images
     already on disk overlaps with capturing the rest instead of following it.
     Progress goes to a log; review-queue.mjs reports what is ready.

  4. STAGED RETRY of blocked domains, via -Resume. Run length is itself the bot
     signal, so the recovery pass must be SHORT: SWEEP_RESUME=1 skips everything
     already captured ok and revisits only the failures, with a wider gap.

.PARAMETER Resume
  Retry only domains not yet captured ok. Use for the recovery passes.

.PARAMETER Attended
  Run the ATTENDED pass (corpus-sweep-manual) instead of the automated sweep:
  each domain opens in a visible window and waits for you to clear its gate.
  Requires -Only (there is no sensible default set to sit and watch).

  Use this for domains the automated passes keep skipping as gated. The gate
  wait is per-site and ends the moment the page is stably gate-free, so a site
  you clear in five seconds costs five seconds. If you CAN'T clear one, just
  close the tab — that is the documented escape hatch, and the run moves
  straight to the next domain rather than burning the rest of the wait.

  Never takes a backup (it captures a handful of domains, not a run) and does
  not accept -Resume, whose "skip what's already ok" logic is meaningless for
  an explicitly-named list.

.PARAMETER WaitSecs
  Attended only: per-site ceiling on the gate wait (SWEEP_MANUAL_WAIT_MS).
  Default 120. A ceiling, not a fixed cost.

.PARAMETER Window
  Attended only: OVERRIDE the headed window geometry (SWEEP_WINDOW).

  Empty by default, which is what you want: Chrome remembers window size and
  position per profile (browser.window_placement in its Preferences), including
  WHICH MONITOR, so a headed run reopens exactly where you left it. Passing
  geometry overrules that memory, so only do it when a deterministic window is
  actually wanted - 'max', '<W>x<H>' or '<W>x<H>+<X>+<Y>'.

  Explicit coordinates are the wrong tool on a multi-monitor setup: they replay
  raw pixels with no knowledge of which displays exist, so a monitor that is off
  or rearranged puts the window off-screen. Chrome validates its remembered
  placement against the current displays instead.

.PARAMETER Only
  Comma-separated domain subset (passed through as SWEEP_ONLY, or
  SWEEP_MANUAL_ONLY under -Attended).

.PARAMETER Gap
  Seconds between domains (SWEEP_GAP). Default 20 for a full run; raise to
  45-60 for a recovery pass, where pacing matters more than throughput.

.PARAMETER Foreground
  Run attached and wait, instead of detaching. Use for short recovery passes.

.PARAMETER Backup
  Snapshot the CURRENT corpus-sweep-run/ before overwriting it, so the run you
  are about to start has something to be compared against.

  OFF by default, and deliberately so. It used to be automatic, but a sweep is
  re-run far more often than it completes - a preflight failure, a burnt IP, a
  wrong flag - and every one of those rotated a good baseline out of the
  retention window, replacing it with a copy of the failed run. Measured
  2026-09-15: snapchat-web's cast was fine on 09-12 and is now 9/10 critical,
  but both surviving backups were from the same day, so the regression could
  not be shown and had to be filed as 'regression: none'.

  Pass it when starting a real sweep. Omit it when re-running after an error.
  Retention is five backups (SWEEP_BACKUP_KEEP), about a working week.

.EXAMPLE
  # Full fortnightly run - snapshot the previous run first, then review while
  # it captures. Use -Backup on the run you intend to compare against.
  powershell -ExecutionPolicy Bypass -File scripts/corpus-sweep-run.ps1 -Backup

.EXAMPLE
  # Re-run after an error (bad flag, burnt IP, failed preflight). NO -Backup:
  # the existing baseline is the good one and must not be rotated out.
  powershell -ExecutionPolicy Bypass -File scripts/corpus-sweep-run.ps1

.EXAMPLE
  # Recovery pass over whatever was blocked, paced wider.
  powershell -ExecutionPolicy Bypass -File scripts/corpus-sweep-run.ps1 -Resume -Gap 45 -Foreground

.EXAMPLE
  # Attended pass: sit with it and clear the gates by hand. Close a tab to skip.
  powershell -ExecutionPolicy Bypass -File scripts/corpus-sweep-run.ps1 -Attended -Only discogs,producthunt

.NOTES
  Runs under either host. PowerShell 7 (`pwsh`, 7.6.6) is now installed and this
  script parses and runs clean under it; `powershell -ExecutionPolicy Bypass`
  (Windows PowerShell 5.1) remains supported. The examples above use the 5.1
  form because it predates the pwsh install — both work.
#>
[CmdletBinding()]
param(
  [switch]$Resume,
  [switch]$Attended,
  [int]$WaitSecs = 120,
  [string]$Window = '',
  [string]$Only = '',
  [int]$Gap = 20,
  # Extra seconds on top of -Gap for the HEADED passes, which cluster the
  # most-defended sites (PerimeterX / Cloudflare / logged-in social) together.
  [int]$GapHeaded = 25,
  [switch]$Foreground,
  [switch]$Backup,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }

# ── -Stop: abort a background sweep WITHOUT touching the dev servers ─────────
# Deliberately scoped. A blanket `Get-Process node | Stop-Process` also kills the
# always-running `pnpm dev` watchers for discerned-ext and discerned-web, and the
# only symptom is a later preflight claiming the web app was never started.
# So: Chrome by name (the sweep drives its own), node ONLY where the command line
# says playwright.
if ($Stop) {
  Step 'Stopping sweep (dev servers left alone)'
  Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*playwright*' -or $_.CommandLine -like '*watch-sweep-stream*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  try {
    $null = Invoke-WebRequest -Uri 'http://localhost:3000' -TimeoutSec 3 -UseBasicParsing
    Ok 'Sweep stopped; dev web app still up on :3000'
  } catch {
    Warn 'Sweep stopped, but :3000 is not answering — restart your web dev watcher.'
  }
  exit 0
}

# ── Preflight ───────────────────────────────────────────────────────────────
Step 'Preflight'

# Chrome must be fully closed: the sweep drives the warm Profile 3, and a live
# Chrome holds its single-instance lock, so launchPersistentContext fails.
$chrome = Get-Process chrome -ErrorAction SilentlyContinue
if ($chrome) {
  Warn "Chrome is running ($($chrome.Count) processes) and holds the Profile 3 lock."
  Warn 'Close Chrome completely, then re-run. (The sweep cannot share the profile.)'
  exit 1
}
Ok 'Chrome is closed (Profile 3 lock free)'

# The sweep loads dist-test/, never dist/ or dist-pack/.
#
# Rebuild whenever a BUILD INPUT is newer than the build, rather than warning on
# wall-clock age. Age is the wrong question: a 30h-old build with no source
# changes is fine, while one from 20 minutes ago is stale if capture.ts was
# edited 5 minutes later. The old version only WARNED and continued, so a sweep
# could capture all 209 domains with superseded code — hours of wall-clock plus
# the IP-reputation budget against walled sites, spent measuring the wrong
# pipeline, and a set of verdicts describing code that no longer exists.
$ext = Join-Path $repo 'discerned-ext'
$distTest = Join-Path $ext 'dist-test\manifest.json'

function newestBuildInput {
  $files = @()
  $files += Get-ChildItem -Path (Join-Path $ext 'src') -Recurse -File -ErrorAction SilentlyContinue
  # Config that changes the OUTPUT, not just the toolchain. build-injected.mjs is
  # chained from vite.config.ts and emits the injected IIFEs, so it counts.
  foreach ($p in 'manifest.json','vite.config.ts','tsconfig.json','scripts\build-injected.mjs') {
    $f = Get-Item (Join-Path $ext $p) -ErrorAction SilentlyContinue
    if ($f) { $files += $f }
  }
  return ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

$needsBuild = $false
$reason = ''
if (-not (Test-Path $distTest)) {
  $needsBuild = $true
  $reason = 'dist-test/ missing'
} else {
  $newest = newestBuildInput
  if ($newest -and $newest.LastWriteTime -gt (Get-Item $distTest).LastWriteTime) {
    $needsBuild = $true
    $reason = "$($newest.Name) is newer than the build"
  }
}

if ($needsBuild) {
  Warn "Rebuilding dist-test ($reason)..."
  pnpm --filter=./discerned-ext build:test
  if ($LASTEXITCODE -ne 0) { Warn 'build:test failed'; exit 1 }
  Ok 'dist-test rebuilt from current source'
} else {
  $age = [math]::Round(((Get-Date) - (Get-Item $distTest).LastWriteTime).TotalHours, 1)
  Ok "dist-test is current (built ${age}h ago, no newer source)"
}

# The clip render step drives the web app at :3000.
try {
  $null = Invoke-WebRequest -Uri 'http://localhost:3000' -TimeoutSec 5 -UseBasicParsing
  Ok 'web app responding on :3000'
} catch {
  Warn 'No web app on http://localhost:3000 — the clip/cast render steps will fail.'
  Warn 'Start it with: cd discerned-web; pnpm dev'
  exit 1
}

# ── Attended pass ───────────────────────────────────────────────────────────
# Runs corpus-sweep-manual, which opens each domain in a visible window and
# waits for the user to clear its gate. Placed BEFORE the backup step and
# exiting from here, so an attended pass can never snapshot the run folder:
# it captures a named handful, and a backup is for a full sweep only.
#
# Note this is a DIFFERENT spec from the automated sweep, not the same one with
# SWEEP_UNATTENDED unset. corpus-sweep's own gate wait tops out at 20 polls and
# its passes are built around not blocking; corpus-sweep-manual is the one that
# waits per-site, auto-solves Press & Hold without stealing focus, and treats a
# closed tab as "skip to the next domain".
if ($Attended) {
  if (-not $Only) {
    Warn '-Attended requires -Only <domains> - there is no default set worth sitting and watching.'
    Warn 'Get the currently-gated list from: node tests/e2e/tools/review-queue.mjs'
    exit 1
  }
  if ($Resume) {
    Warn '-Attended cannot be combined with -Resume (which skips already-ok domains;'
    Warn 'an explicitly-named attended list is the point). Drop -Resume.'
    exit 1
  }

  Step "Capture - ATTENDED (visible window, you clear the gates): $Only"
  Write-Host '  Clear each gate in the window as it appears.' -ForegroundColor Cyan
  Write-Host '  Can''t clear one? CLOSE THE TAB - it skips straight to the next domain.' -ForegroundColor Cyan
  Write-Host "  Per-site wait ceiling: $WaitSecs s (ends early the moment the page is clear)." -ForegroundColor Cyan
  if ($Window) { Write-Host "  Window override: $Window" -ForegroundColor Cyan }
  else { Write-Host '  Window: reopening where Chrome last left it (per profile, incl. monitor).' -ForegroundColor Cyan }
  Write-Host ''

  $env:SWEEP_MANUAL = '1'
  $env:SWEEP_MANUAL_ONLY = $Only
  $env:SWEEP_MANUAL_WAIT_MS = "$($WaitSecs * 1000)"
  # Window geometry is normally LEFT ALONE: Chrome remembers size, position and
  # monitor per profile, so the headed window reopens where you left it. Only an
  # explicit -Window overrides that (see the .PARAMETER Window notes).
  if ($null -ne $Window -and $Window -ne '') { $env:SWEEP_WINDOW = $Window }
  else { Remove-Item Env:\SWEEP_WINDOW -ErrorAction SilentlyContinue }

  $log = Join-Path $repo 'test-output\sweep-attended.log'
  Remove-Item $log -ErrorAction SilentlyContinue
  # Always foreground: the entire point is that you are watching this window.
  #
  # NO `2>&1` here, and $ErrorActionPreference is relaxed for the call. Under
  # PS 5.1, redirecting a NATIVE command's stderr wraps each line in an
  # ErrorRecord (NativeCommandError); with ErrorActionPreference='Stop' that is
  # TERMINATING, so the script died on Playwright's harmless "NO_COLOR is
  # ignored" warning — observed killing an attended run after 2 of 5 domains,
  # with the remaining 3 never attempted. Playwright's stderr still reaches the
  # console; it just isn't teed into the log.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=corpus-sweep-manual |
    Tee-Object -FilePath $log
  $ErrorActionPreference = $prevEap

  Step 'Attended capture done - slicing for review'
  # Same pre-slice as the -Foreground path: a raw clip PNG downscales ~4x on
  # read and its text is unreadable, so slice before handing it to a reviewer.
  $captured = ($Only -split ',') |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and (Test-Path (Join-Path $repo "test-output\corpus-sweep-run\$_--2-clip.png")) }
  if ($captured) {
    $domainArg = ($captured -join ',')
    python3 tests/e2e/tools/slice-clip.py $domainArg | Out-Null
    python3 tests/e2e/tools/slice-clip.py $domainArg --cast | Out-Null
    Ok "Sliced: $domainArg"
  } else {
    Warn 'No clips captured - every domain was gated or skipped.'
  }
  # Catch up any domain re-captured outside this pass whose bands are older
  # than its PNG - see the --stale-only note in the -Foreground path below.
  python3 tests/e2e/tools/slice-clip.py --all --stale-only | Out-Null
  python3 tests/e2e/tools/slice-clip.py --all --stale-only --cast | Out-Null
  node tests/e2e/tools/review-queue.mjs --stats
  exit 0
}

# ── Backup ──────────────────────────────────────────────────────────────────
# OPT-IN, because a backup used to be taken on every non-resume run and a sweep
# is re-run far more often than it is completed: a preflight failure, a burnt
# IP, a bad flag. Each of those rotated a GOOD baseline out of the retention
# window and replaced it with a copy of the run that just failed. Measured
# 2026-09-15: snapchat-web's cast regressed sometime after 09-12 and both
# surviving backups were same-day, so it could not be demonstrated.
#
# So: pass -Backup when STARTING a real sweep you intend to compare against.
# Omit it when re-running after an error, which is the common case.
#
# Still never taken on a resume: the run in progress IS the current state, and
# snapshotting a half-finished run adds a partial folder to compare against.
if ($Backup -and -not $Resume) {
  Step 'Backing up previous run (comparison basis)'
  node tests/e2e/tools/backup-sweep-run.mjs
} elseif ($Backup -and $Resume) {
  Step 'Backup skipped (-Resume: the run in progress is the current state)'
} else {
  Step 'Backup skipped (pass -Backup to snapshot the previous run first)'
}

# ── Capture ─────────────────────────────────────────────────────────────────
Step $(if ($Resume) { 'Capture — RESUME (blocked/uncaptured domains only)' } else { 'Capture — full corpus' })

$env:SWEEP = '1'
$env:SWEEP_GAP = "$Gap"
$env:SWEEP_GAP_HEADED = "$GapHeaded"
# Never wait on a human: a full run has dozens of gated domains, and an
# unattended pass that stops for clicks is what turns 2 hours into a whole day.
# Genuinely click-only domains are recovered afterwards via corpus-sweep-manual.
$env:SWEEP_UNATTENDED = '1'
if ($Resume) { $env:SWEEP_RESUME = '1' } else { Remove-Item Env:\SWEEP_RESUME -ErrorAction SilentlyContinue }
if ($Only)   { $env:SWEEP_ONLY = $Only } else { Remove-Item Env:\SWEEP_ONLY -ErrorAction SilentlyContinue }

$log = Join-Path $repo 'test-output\sweep-run.log'
$sliceLog = Join-Path $repo 'test-output\sweep-slices.log'
# Truncate: the background writer appends, so a stale log would make the new
# run's progress unreadable (and a resume look like it re-ran everything).
Remove-Item $log -ErrorAction SilentlyContinue
# Not $args — that is an automatic variable in PowerShell and assigning it is
# an error under StrictMode / a no-op surprise otherwise.
$pwArgs = @('exec','playwright','test','-c','tests/e2e/playwright.config.ts','--project=corpus-sweep')

if ($Foreground) {
  Write-Host "  logging to $log"
  pnpm @pwArgs 2>&1 | Tee-Object -FilePath $log
  Step 'Capture done — preparing for AI review'
  # Pre-slice every captured clip+cast NOW, not on demand during review. Doing
  # it here means the review step is pure image-reading with no tool calls that
  # spend a turn just producing a legible image — see slice-clip.py: a raw
  # clip PNG downscales up to 4x on read and the text becomes unreadable.
  # slice-clip.py is a plain Pillow crop (no browser) — see its own header for
  # why that replaced an earlier Chromium-based version.
  # No --limit: review-queue.mjs defaults to Infinity, which is what "slice
  # everything pending" needs. --limit 0 would slice the result to ZERO rows.
  # Exclude 'blocked' rows: those never captured a clip/cast at all, so there is
  # nothing for slice-clip.py to slice (it would just print a harmless SKIP,
  # but filtering here keeps the domain list meaningful).
  # --all --stale-only rather than "the pending domains": it re-slices every
  # domain whose PNG is newer than its bands, which is a superset and closes
  # the hole that leaving it to the pending list opened. A domain re-captured
  # but NOT pending (its verdict is still current) was never re-sliced, so its
  # bands silently aged out beside a fresh clip - measured 2026-09-23,
  # politico's slices were 92h older than its PNG while its sidecar and verdict
  # both read as current, i.e. nothing anywhere flagged it. Skipping the
  # up-to-date ones is an mtime compare, so this stays cheap over all 209.
  python3 tests/e2e/tools/slice-clip.py --all --stale-only | Out-Null
  python3 tests/e2e/tools/slice-clip.py --all --stale-only --cast | Out-Null
  node tests/e2e/tools/review-queue.mjs --stats
  Write-Host ''
  Write-Host '  Capture + slicing are done. VISUAL REVIEW ITSELF IS NOT SCRIPTABLE —' -ForegroundColor Yellow
  Write-Host '  it means an AI actually reading each clip and cast image and judging' -ForegroundColor Yellow
  Write-Host '  it, which needs a model in the loop, not a script. Hand this to Claude:' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '    Review the corpus sweep: go through the review queue' -ForegroundColor Cyan
  Write-Host '    (node tests/e2e/tools/review-queue.mjs) — it lists ONLY the domains' -ForegroundColor Cyan
  Write-Host '    needing review, so do not walk the whole corpus. For each domain it' -ForegroundColor Cyan
  Write-Host '    lists, read EVERY band of its clip AND cast slices (up to 3 each — a' -ForegroundColor Cyan
  Write-Host '    verdict from band 1 alone cannot tell MISSING from BURIED), and' -ForegroundColor Cyan
  Write-Host '    record a verdict for each via record-verdict.mjs.' -ForegroundColor Cyan
  Write-Host '    Where you can compare against the previous backup, call out any' -ForegroundColor Cyan
  Write-Host '    real regressions explicitly (regression:"regressed" + regressedFrom).' -ForegroundColor Cyan
  Write-Host ''
} else {
  # Detached, so eyeballing the already-captured domains overlaps with capture.
  # Start-Process launches a FRESH process that does NOT inherit $env: values set
  # in this scope, so the SWEEP_* vars must be re-set inside the child's command.
  # Omitting this silently ran the FULL corpus under -Resume (observed: all 46
  # headed-first domains, when only the blocked ones should have run).
  $setEnv = @(
    "`$env:SWEEP='1'",
    "`$env:SWEEP_GAP='$Gap'",
    "`$env:SWEEP_GAP_HEADED='$GapHeaded'",
    "`$env:SWEEP_UNATTENDED='1'"
  )
  if ($env:SWEEP_RESUME_MAX_AGE_H) { $setEnv += "`$env:SWEEP_RESUME_MAX_AGE_H='$($env:SWEEP_RESUME_MAX_AGE_H)'" }
  if ($Resume) { $setEnv += "`$env:SWEEP_RESUME='1'" }
  if ($Only)   { $setEnv += "`$env:SWEEP_ONLY='$Only'" }
  # Log encoding matters here: Tee-Object/redirection under PS 5.1 writes UTF-16,
  # which greps and tails as binary garbage — and this log is the live progress
  # feed for the parallel review loop, so it must stay readable WHILE it grows.
  # ForEach-Object + Out-File -Append streams each line through as it arrives
  # (buffering the whole run and writing at the end would defeat watching it).
  $psi = ($setEnv -join '; ') +
    "; pnpm $($pwArgs -join ' ') 2>&1 | " +
    "ForEach-Object { `$_ | Out-File -FilePath '$log' -Encoding utf8 -Append; `$_ }"
  # Hidden, not Minimized: a minimised window still appears in the taskbar and
  # reads as a stray window the user did not open. The run is followed via the
  # log file and review-queue.mjs, so there is nothing to see in it anyway.
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$psi -WorkingDirectory $repo -WindowStyle Hidden
  Ok 'Capture started in the background.'

  # Second hidden process: watch-sweep-stream.mjs slices each domain's clip +
  # cast top band THE MOMENT it lands, batched (SLICE_BATCH, default 5) so it
  # is not launching Chromium once per domain. This is what makes "review runs
  # in parallel with capture" true rather than aspirational — without it, the
  # background sweep alone produces raw ~8000px PNGs that downscale ~4x on
  # read (illegible text), so review has to wait for the whole run to finish
  # AND a manual slicing pass before a single image is actually readable.
  Remove-Item $sliceLog -ErrorAction SilentlyContinue
  $sinceEpoch = [long]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  # MUST pass the same domain scope as the sweep itself. Without --only here,
  # a -Resume or -Only run watches for ALL 206 corpus domains while the sweep
  # is only capturing a few — the watcher then either hangs waiting for
  # domains that will never run, or (worse, observed) misreads pre-existing
  # sidecars from OTHER domains as satisfying its total and prints DONE
  # before the targeted domains ever land.
  $onlyArgStr = if ($Only) { " --only $Only" } else { '' }
  $slicePsi = "node tests/e2e/tools/watch-sweep-stream.mjs --since $sinceEpoch$onlyArgStr 2>&1 | " +
    "ForEach-Object { `$_ | Out-File -FilePath '$sliceLog' -Encoding utf8 -Append }"
  Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$slicePsi -WorkingDirectory $repo -WindowStyle Hidden
  Ok 'Live slicing started — clip/cast top bands appear in test-output\sweep-slices.log as each domain lands.'

  Write-Host ''
  Write-Host '  Watch capture:    Get-Content test-output\sweep-run.log -Wait -Tail 20'
  Write-Host '  Watch new slices: Get-Content test-output\sweep-slices.log -Wait -Tail 20'
  Write-Host '  Review queue:     node tests/e2e/tools/review-queue.mjs'
  Write-Host '  Then, per batch:  node tests/e2e/tools/record-verdict.mjs --batch-file <file>'
  Write-Host ''
  Write-Host '  VISUAL REVIEW ITSELF IS NOT SCRIPTABLE — it means an AI actually reading' -ForegroundColor Yellow
  Write-Host '  each clip/cast slice and judging it. Hand Claude (or another session) this' -ForegroundColor Yellow
  Write-Host '  while the sweep runs, so review overlaps with capture rather than following it:' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '    A corpus sweep is running in the background. Tail' -ForegroundColor Cyan
  Write-Host '    test-output/sweep-slices.log (or use Monitor on it) for TIMING only —' -ForegroundColor Cyan
  Write-Host '    it announces every captured domain, not just ones needing review. Run' -ForegroundColor Cyan
  Write-Host '    node tests/e2e/tools/review-queue.mjs to see which newly-landed domains' -ForegroundColor Cyan
  Write-Host '    actually need a look (it skips ones whose verdict already covers the' -ForegroundColor Cyan
  Write-Host '    current image). For each domain the queue lists, read EVERY clip and' -ForegroundColor Cyan
  Write-Host '    cast band (up to 3 each — content buried under a video rail or carousel' -ForegroundColor Cyan
  Write-Host '    does not reach band 1) and record a verdict via record-verdict.mjs. If a' -ForegroundColor Cyan
  Write-Host '    band line says some were NOT written and the verdict turns on what is' -ForegroundColor Cyan
  Write-Host '    below, re-slice with --max. Where you can compare against the previous' -ForegroundColor Cyan
  Write-Host '    backup, call out real regressions explicitly (regression:"regressed" +' -ForegroundColor Cyan
  Write-Host '    regressedFrom). Keep going until the log prints DONE and the queue is empty.' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '  When it finishes, recover blocked domains with:'
  Write-Host '    powershell -ExecutionPolicy Bypass -File scripts/corpus-sweep-run.ps1 -Resume -Gap 45 -Foreground'
}
