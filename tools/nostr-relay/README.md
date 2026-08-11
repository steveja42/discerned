# Local Nostr relay (dev/test)

A loopback-only [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay) at
`ws://localhost:7777` so test casts never reach the real Nostr network and can be
inspected immediately. SQLite-backed, so events survive restarts.

## Run

```powershell
pnpm relay:local          # from repo root
```

Or directly: `pwsh tools/nostr-relay/run.ps1`. The script tries, in order: a native
`nostr-rs-relay` binary on PATH → **Podman** → **Docker**. For containers it auto-derives a
`config.container.toml` (listening on `0.0.0.0:8080`) from `config.toml`, maps host
`127.0.0.1:7777` → container `8080`, and sets
`RUST_LOG=warn,nostr_rs_relay::db=info,nostr_rs_relay::server=info` so the window shows each
`persisted event` (publish) plus client connect/disconnect with a `sent: N events` summary
(subscriptions served), without the per-minute WAL-checkpoint noise. Individual `REQ` lines
only exist at DEBUG — use `RUST_LOG=nostr_rs_relay=debug` if you need raw subscription detail.
You don't hand-edit ports for the container path.

**On Windows the relay opens in its OWN console window.** podman only flushes container
stdout to a real TTY — piped through the `pnpm → powershell → podman` chain the relay logs
never appear (the relay still runs, you just can't see it). So `pnpm relay:local` launches the
container in a separate window (Windows Terminal if available) where the banner and per-cast
`persisted event: "..."` lines stream live, then returns. **Stop the relay with Ctrl+C in
that window**, or `podman stop discerned-local-relay`.

The container mounts land under the image's WorkingDir `/usr/src/app` (config →
`/usr/src/app/config.toml`, data → `/usr/src/app/db`, which is the image's `APP_DATA`). The
relay reads `config.toml` relative to that dir — mounting at `/app/...` instead makes it
silently fall back to built-in defaults (ignoring our `max_event_bytes`, etc.).

## Install — on Windows, use a container

> **nostr-rs-relay does not build natively on Windows.** Its source calls Unix-only
> `tokio::signal::unix` APIs (`#![cfg(unix)]`), so `cargo install nostr-rs-relay` fails to
> compile on Windows regardless of flags. (It also needs `protoc` to build at all — its
> `build.rs` unconditionally compiles `proto/nauthz.proto`; there are no cargo features to
> turn that off.) And there is **no prebuilt binary** — the GitHub releases page has zero
> assets (verified via the releases API). So on Windows the relay must run in a Linux
> container, where the `cfg(unix)` code compiles fine.

- **Podman** (recommended on Windows — lighter than Docker Desktop, no licensing): once
  installed, run `podman machine init` then `podman machine start` (one-time, brings up its
  WSL2 VM). After that, `pnpm relay:local` detects podman and pulls
  `docker.io/scsibug/nostr-rs-relay` automatically.
- **Docker Desktop**: also works; `run.ps1` uses it if podman isn't present. Heavier
  footprint (Docker Desktop + WSL2, several GB).
- **Native binary** (`cargo install nostr-rs-relay`): **Linux/macOS only** — needs `protoc`
  installed first (`apt install protobuf-compiler` / `brew install protobuf`). Not an option
  on Windows. If present on PATH, `run.ps1` prefers it.

## How the apps point at it

- **Extension**: dev/test builds (`pnpm dev`, `pnpm build:test`) compile with
  `__DISCERNED_DEV_BUILD__ = true`, which defaults the relay mode to `local` — so
  `getEffectiveRelays()` (in `discerned-ext/src/shared/relays.ts`) resolves to
  `[ws://localhost:7777]`, replacing the public relays. Local mode is exclusive: the
  user's own relays are ignored, so test casts can never reach the real network.
  Production (`pnpm build`) tree-shakes this out.
- **Web app**: set `NEXT_PUBLIC_LOCAL_RELAY=ws://localhost:7777` in `discerned-web/.env.local`
  (already created). Keep the web app on `http://localhost:3000` — an `https://` page can't
  open a `ws://` socket (mixed content).

## Previewing casts in real Nostr clients (`wss://` via `pnpm relay:tls`)

To see how third-party clients render your notes and long-form articles **before** publishing
to public relays, front the relay with a TLS endpoint so https-served web clients can connect
(they're blocked from opening a plain `ws://` socket — mixed content).

```powershell
pnpm relay:local     # in one window — the actual relay on ws://localhost:7777
pnpm relay:tls       # in another — adds wss://localhost:7778 (Caddy + mkcert cert)
```

`relay:tls` runs [Caddy](https://caddyserver.com) as a TLS terminator that reverse-proxies
`wss://localhost:7778` → `ws://127.0.0.1:7777`, using an **mkcert**-issued cert your OS/browser
trust store already trusts (no cert warning). The plain `ws://localhost:7777` endpoint keeps
working unchanged; this only ADDS the `wss://` one. Both serve the same events. Ctrl+C in the
`relay:tls` window to stop it. Prereqs: `caddy` + `mkcert` on PATH (run `mkcert -install` once
if the cert dir is empty — `run-tls.ps1` does this automatically). Certs live under
`tools/nostr-relay/certs/` (gitignored — per-machine).

**Point a web client at it:** in **[nostrudel.ninja](https://nostrudel.ninja)** or
**[coracle.social](https://coracle.social)** → relay settings → add `wss://localhost:7778`.
Log in with the same npub you cast from and your notes + long-form (Reads) appear. Long-form
articles show under the client's "Articles"/"Reads" section (kind 30023).

**Mobile (Amethyst, etc.):** an Android phone won't trust your desktop's mkcert CA out of the
box, and `localhost` on the phone isn't your PC. To test on a phone you'd install the mkcert
root CA on the device AND expose the relay on your LAN IP (or a tunnel like Tailscale) with a
cert whose SAN covers that host. Simplest desktop-only preview is a browser client above.

## Inspect what was cast

- **Dump raw event JSON** (no install — uses Node's built-in WebSocket):
  `node tools/dump-casts.mjs` (all `#discerned` notes + long-form),
  `node tools/dump-casts.mjs 30023` (long-form only),
  `node tools/dump-casts.mjs 1` (notes only). Prints each signed event as pretty JSON.
- Watch the relay's stdout, or
- `nak req -k 1 -t t=discerned ws://localhost:7777` (if you have [nak](https://github.com/fiatjaf/nak)), or
- open the web feed at `http://localhost:3000`, or
- preview in a real Nostr client via `pnpm relay:tls` (see above).
