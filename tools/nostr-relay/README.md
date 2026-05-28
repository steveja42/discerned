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
`127.0.0.1:7777` → container `8080`, and sets `RUST_LOG=info,nostr_rs_relay=debug` so the
relay prints a startup banner + a line per cast. You don't hand-edit ports for the container
path.

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
  `__DISCERNED_TEST_BUILD__ = true`, which makes `ACTIVE_RELAYS` (in
  `discerned-ext/src/shared/types.ts`) resolve to `[ws://localhost:7777]`, replacing the
  public relays. Production (`pnpm build`) tree-shakes this out.
- **Web app**: set `NEXT_PUBLIC_LOCAL_RELAY=ws://localhost:7777` in `discerned-web/.env.local`
  (already created). Keep the web app on `http://localhost:3000` — an `https://` page can't
  open a `ws://` socket (mixed content).

## Inspect what was cast

- Watch the relay's stdout, or
- `nak req -k 1 -t t=discerned ws://localhost:7777`, or
- open the web feed at `http://localhost:3000`.
