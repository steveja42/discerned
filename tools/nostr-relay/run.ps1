# Launches the local nostr-rs-relay for Discerned dev/test on ws://localhost:7777.
# Order of preference: native nostr-rs-relay on PATH -> Podman -> Docker.
# Run from anywhere: "pnpm relay:local" (root) or "pwsh tools/nostr-relay/run.ps1".
#
# nostr-rs-relay does NOT build natively on Windows (it uses Unix-only tokio signal
# APIs), so on Windows the container path (Podman/Docker) is the real one. The
# committed config.toml targets the NATIVE case (127.0.0.1:7777). For containers we
# generate a temp config that listens on 0.0.0.0:8080 so the "-p 7777:8080" host
# mapping can reach it, keeping config.toml as the single human-edited source.
#
# Pass -Yes (or set DISCERNED_RELAY_YES=1) to skip the confirmation prompt. The VS Code
# "dev: relay" task passes -Yes so it never blocks the parallel "dev: both" launch.

param([switch]$Yes)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# Confirm before starting. Prompt only when a real interactive console is attached;
# when launched non-interactively (e.g. by a VS Code task or CI), auto-continue so we
# don't hang waiting on input that can never arrive.
if (-not $Yes -and $env:DISCERNED_RELAY_YES -ne '1') {
  $interactive = -not [System.Console]::IsInputRedirected -and $Host.UI.RawUI -ne $null
  if ($interactive) {
    $answer = Read-Host 'Starting local relay, continue? [Y/n]'
    if ($answer -and $answer.Trim() -notmatch '^(y|yes)$') {
      Write-Host 'Aborted.'
      exit 0
    }
  } else {
    Write-Host 'Starting local relay (non-interactive: auto-continue).'
  }
}

# Idempotent: if something is already serving 127.0.0.1:7777, a relay is up (or the port
# is taken) - exit cleanly instead of tearing down the running one and racing for the
# port. Makes a second run (the VS Code task fired twice, or "pnpm relay:local" alongside
# the task) a harmless no-op on both the native and container paths. Probe with a short
# TcpClient connect rather than Test-NetConnection (faster, no timeout noise).
$client = New-Object System.Net.Sockets.TcpClient
try {
  $connect = $client.BeginConnect('127.0.0.1', 7777, $null, $null)
  if ($connect.AsyncWaitHandle.WaitOne(500) -and $client.Connected) {
    Write-Host 'Local relay already running on ws://localhost:7777 - nothing to do.'
    exit 0
  }
} catch {
  # Connect failed -> nothing listening; fall through and start the relay.
} finally {
  $client.Close()
}

New-Item -ItemType Directory -Force -Path (Join-Path $here 'data') | Out-Null

# Log level: show casts + subscription activity, without WAL-checkpoint noise.
#   ::db=info      -> "persisted event" line per cast (the publish log)
#   ::server=info  -> client connect/disconnect + the "sent: N events, recv: M events"
#                     summary that shows a subscription was served
#   everything else (incl. ::sqlite WAL checkpoints) stays at warn = silent
# NOTE: per-REQ subscription lines and parse lines only exist at DEBUG in this relay; at
# any info level you see connection summaries, not individual REQ lines. Use
# nostr_rs_relay=debug if you ever need the raw REQ/parse detail (also re-adds checkpoints).
$logLevel = 'warn,nostr_rs_relay::db=info,nostr_rs_relay::server=info'

# Native binary (Linux/macOS; not buildable on Windows).
$native = Get-Command nostr-rs-relay -ErrorAction SilentlyContinue
if ($native) {
  Write-Host "Starting native nostr-rs-relay on ws://localhost:7777 ..."
  $env:RUST_LOG = $logLevel
  & $native.Source --config (Join-Path $here 'config.toml')
  exit $LASTEXITCODE
}

# Container path: derive an 8080 / 0.0.0.0 config from config.toml. Containers can't
# reach 127.0.0.1:7777 inside the namespace, so rewrite the [network] block. The host
# still only exposes 127.0.0.1:7777 via the port map.
function Write-ContainerConfig {
  $src = Get-Content (Join-Path $here 'config.toml') -Raw
  $src = $src -replace '(?m)^\s*address\s*=.*$', 'address = "0.0.0.0"'
  $src = $src -replace '(?m)^\s*port\s*=.*$',    'port = 8080'
  $tmp = Join-Path $here 'config.container.toml'
  Set-Content -Path $tmp -Value $src -Encoding ascii
  return $tmp
}

# Mounts land under the image WorkingDir /usr/src/app (it runs ./nostr-rs-relay --db
# $APP_DATA, APP_DATA=/usr/src/app/db, and reads config.toml relative to WorkingDir).
# Mounting at /app instead makes the relay fall back to built-in defaults silently.
function Invoke-Container([string]$engine, [string]$image) {
  $cfg = Write-ContainerConfig
  # Remove any leftover container with our name first, so a name collision can't block
  # a fresh run or leave casts landing on an old container.
  & $engine rm -f discerned-local-relay 2>$null | Out-Null

  # Run the relay in a NEW console window: podman on Windows only flushes container
  # stdout (the relay banner + per-cast log lines) to a real TTY. Piped through
  # pnpm/powershell the logs never appear; in its own window they stream live.
  #
  # We write the launch command to a temp .ps1 and have the new window run that FILE,
  # rather than passing a quoted command string through Start-Process -ArgumentList
  # (whose embedded quotes/spaces get mangled crossing the process boundary).
  $launcher = Join-Path $here 'relay-window.ps1'
  $script = @"
Set-Location '$here'
Write-Host 'Discerned local relay - ws://localhost:7777 (Ctrl+C to stop)'
& '$engine' run --rm ``
  -e 'RUST_LOG=$logLevel' ``
  -p '127.0.0.1:7777:8080' ``
  -v '$($cfg):/usr/src/app/config.toml:ro' ``
  -v '$($here)\data:/usr/src/app/db' ``
  --name discerned-local-relay ``
  '$image'
"@
  Set-Content -Path $launcher -Value $script -Encoding ascii

  $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
  if ($wt) {
    Start-Process wt.exe -ArgumentList @('powershell','-NoExit','-NoProfile','-File',$launcher)
  } else {
    Start-Process powershell -ArgumentList @('-NoExit','-NoProfile','-File',$launcher)
  }

  Write-Host "Relay launched in a separate window on ws://localhost:7777 (RUST_LOG=$logLevel)."
  Write-Host "Watch that window for the startup banner and a line per cast."
  Write-Host "Stop it with Ctrl+C in that window, or: $engine stop discerned-local-relay"
  return 0
}

# Podman (lighter than Docker Desktop; pulls from Docker Hub).
$podman = Get-Command podman -ErrorAction SilentlyContinue
if ($podman) {
  # Ensure at least one machine is running. If all machines are stopped, start the first one.
  $machines = & $podman.Source machine list --format '{{.Name}}|{{.Running}}' 2>$null
  $anyRunning = $machines | Where-Object { $_ -match '\|true$' }
  if (-not $anyRunning) {
    $stopped = $machines | Where-Object { $_ -match '\|false$' } | Select-Object -First 1
    if ($stopped) {
      $machineName = ($stopped -split '\|')[0].TrimEnd('*').Trim()
      Write-Host "Podman machine '$machineName' is not running - starting it (this may take a few seconds)..."
      & $podman.Source machine start $machineName
      if ($LASTEXITCODE -ne 0) { Write-Error "Failed to start Podman machine '$machineName'."; exit 1 }
    } else {
      Write-Host "No Podman machine found - creating and starting one (one-time setup, takes ~1 min)..."
      & $podman.Source machine init
      if ($LASTEXITCODE -ne 0) { Write-Error "Failed to init Podman machine."; exit 1 }
      & $podman.Source machine start
      if ($LASTEXITCODE -ne 0) { Write-Error "Failed to start Podman machine."; exit 1 }
    }
  }
  $code = Invoke-Container $podman.Source 'docker.io/scsibug/nostr-rs-relay:latest'
  exit $code
}

# Docker.
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
  $code = Invoke-Container $docker.Source 'scsibug/nostr-rs-relay:latest'
  exit $code
}

Write-Error "No relay engine found. Install one of: 'podman' (recommended on Windows), 'docker', or a native 'nostr-rs-relay' binary (Linux/macOS only). See tools/nostr-relay/README.md."
exit 1
