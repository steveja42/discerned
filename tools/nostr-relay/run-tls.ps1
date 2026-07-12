# Fronts the local nostr-rs-relay (ws://127.0.0.1:7777) with a wss:// endpoint so
# https-served browser Nostr clients (nostrudel.ninja, coracle.social) can connect
# — a mixed-content block stops them from opening a plain ws:// socket.
#
# Uses Caddy as the TLS terminator with an mkcert-issued cert (trusted by your OS/
# browser store, so no cert warning). The plain ws://localhost:7777 endpoint keeps
# working unchanged for the extension + web app; this only ADDS wss://localhost:7778.
#
# Run from anywhere: "pnpm relay:tls" (root) or "pwsh tools/nostr-relay/run-tls.ps1".
# Stop with Ctrl+C. Prereqs: caddy + mkcert on PATH (both already installed here).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$TLS_PORT = 7778
$RELAY_PORT = 7777
$certDir = Join-Path $here 'certs'
$certFile = Join-Path $certDir 'localhost.pem'
$keyFile = Join-Path $certDir 'localhost-key.pem'

function Test-Cmd($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

if (-not (Test-Cmd 'caddy')) {
  Write-Host 'caddy not found on PATH. Install it: https://caddyserver.com/docs/install' -ForegroundColor Red
  exit 1
}

# Ensure the mkcert cert exists (and mkcert's CA is installed so clients trust it).
if (-not (Test-Path $certFile) -or -not (Test-Path $keyFile)) {
  if (-not (Test-Cmd 'mkcert')) {
    Write-Host "No cert at $certFile and mkcert not found. Install mkcert or drop a cert there." -ForegroundColor Red
    exit 1
  }
  Write-Host 'Generating mkcert cert for localhost...' -ForegroundColor Cyan
  # -install is idempotent; makes sure the local CA is in the OS/browser trust store.
  & mkcert -install | Out-Null
  New-Item -ItemType Directory -Force -Path $certDir | Out-Null
  & mkcert -cert-file $certFile -key-file $keyFile localhost 127.0.0.1 ::1
}

# Warn (don't block) if the plain relay isn't up yet — Caddy will still start and
# proxy once the relay comes online. Probe with a short TcpClient connect.
$relayUp = $false
try {
  $c = New-Object System.Net.Sockets.TcpClient
  $iar = $c.BeginConnect('127.0.0.1', $RELAY_PORT, $null, $null)
  if ($iar.AsyncWaitHandle.WaitOne(500)) { $c.EndConnect($iar); $relayUp = $true }
  $c.Close()
} catch {}
if (-not $relayUp) {
  Write-Host "Note: nothing is serving 127.0.0.1:$RELAY_PORT yet. Start it with 'pnpm relay:local' in another window." -ForegroundColor Yellow
}

Write-Host ''
Write-Host "TLS relay proxy:  wss://localhost:$TLS_PORT  ->  ws://127.0.0.1:$RELAY_PORT" -ForegroundColor Green
Write-Host 'Point web Nostr clients at that wss:// URL. Ctrl+C to stop.' -ForegroundColor Green
Write-Host ''

# Foreground so the console shows Caddy logs and Ctrl+C stops it cleanly.
& caddy run --config (Join-Path $here 'Caddyfile') --adapter caddyfile
