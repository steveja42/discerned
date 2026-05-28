# CLAUDE.md — Discerned Monorepo Root

This is the parent workspace for the Discerned project. Use this folder when a question or task spans more than one sub-project.

## Repo shape

This is a **pnpm monorepo** at `github.com/steveja42/discerned`. It was migrated from two standalone repos (`discerned-ext` and `discerned-web`) via `git subtree`, so the full history of both is preserved under their respective prefixes. The old standalone repos are archived on GitHub and point at this one.

```
c:\dev\discerned\               ← workspace root, git repo, also CWD for monorepo commands
├── discerned-ext/              ← Chrome MV3 extension
├── discerned-web/              ← Next.js companion web app (deployed by Netlify)
├── tests/                      ← cross-project Playwright e2e suite + shared fixtures
├── .vscode/tasks.json          ← "dev: both" task that runs both pnpm dev servers
├── discerned.code-workspace    ← VS Code multi-root workspace file (open this, not the folder)
├── netlify.toml                ← Netlify config (publish .next from discerned-web/)
├── package.json                ← workspace root: test, test:e2e, test:live, build scripts
├── pnpm-workspace.yaml         ← lists discerned-ext + discerned-web as workspace members
└── pnpm-lock.yaml              ← shared lockfile for both sub-projects
```

## Sub-projects

| Folder | Purpose |
|---|---|
| `discerned-ext/` | Chrome Extension (MV3) — capture, evaluate, publish to Nostr |
| `discerned-web/` | Companion web app — public Cast feed + private Reading Room |

Each sub-project has its own `CLAUDE.md` with full stack, commands, and conventions. Read the relevant one before touching code in that project.

## Cross-project Conventions

- **Shared types** live in `discerned-ext/src/shared/types.ts` and are mirrored (not imported) into `discerned-web/lib/types.ts`. Keep them in sync manually.
- **Nostr tag conventions** (`online.discerned.interest`, etc.) are defined in `discerned-ext/src/shared/nostr/events.ts` — the web app's parser at `discerned-web/lib/nostr/parse.ts` must match them exactly.
- **Extension ↔ web bridge** messages are typed in `discerned-ext/src/shared/types.ts` (`WebBridgeOutbound` / `WebBridgeInbound`) and consumed in `discerned-web/lib/bridge/extension-bridge.ts`. Clip bodies (`bodyHtml`, `thumbnail`) are **not** included in the bulk `DISCERNED_BRIDGE_CLIPS` message — they are fetched per-clip on demand via `DISCERNED_REQUEST_CLIP_BODY` / `DISCERNED_BRIDGE_CLIP_BODY` to stay under `chrome.runtime.sendMessage`'s 64 MiB hard limit. See `discerned-ext/CLAUDE.md` → Web-bridge protocol for details.
- **Default relays** are defined in `discerned-ext/src/shared/types.ts` (`DEFAULT_RELAYS`) and mirrored in `discerned-web/lib/constants.ts` — keep them in sync.
- **Active relays vs default relays.** `DEFAULT_RELAYS` is the production wss:// list (mirrored ext↔web, keep in sync). `ACTIVE_RELAYS` is what the code actually publishes/subscribes to and is **deliberately not** mirrored — each side resolves it via its own platform idiom: the **extension** uses the `__DISCERNED_TEST_BUILD__` build flag (dev/test → `[ws://localhost:7777]`, production → `DEFAULT_RELAYS`, tree-shaken), while the **web app** uses the `NEXT_PUBLIC_LOCAL_RELAY` env var (set in `discerned-web/.env.local`, unset in production). In dev/test the local relay **replaces** the public ones so test casts never hit the real network. Publish ACK threshold (`MIN_PUBLISH_ACKS`) is derived from the relay count (1 local, 2 production). Run the relay with `pnpm relay:local` — see `tools/nostr-relay/README.md`.
- **Extension stable ID** is `egocpdhpffaddnhjimclgabdhpbjbhod`, pinned by the `key` field in `discerned-ext/manifest.json`. Don't remove the key — it anchors IndexedDB across rebuilds. The matching private `.pem` lives outside the repo at `~/.discerned-keys/discerned-ext.pem`.

## Commands

```bash
# === From monorepo root (c:\dev\discerned\) ===
pnpm install               # install workspace deps for both sub-projects
pnpm test                  # run unit tests for both sub-projects (Vitest)
pnpm test:e2e              # Playwright e2e suite (builds dist-test, starts dev servers)
pnpm test:live             # opt-in: hits real URLs (LIVE=1)
pnpm build                 # alias for discerned-web build (used by Netlify)

# === From within each sub-project ===
# Extension
cd discerned-ext
pnpm dev                   # Vite watch mode
pnpm build                 # production build → dist/
pnpm build:test            # development-mode build → dist-test/ (retains test hooks)
pnpm type-check
pnpm lint
pnpm test                  # Vitest unit tests (extraction + Nostr round-trip)

# Web app
cd discerned-web
pnpm dev                   # Next.js dev server on localhost:3000
pnpm build                 # Next.js production build → .next/
pnpm type-check
pnpm test                  # Vitest unit tests (parse + bridge + ClipRow)
```

## Test suite

The repo has a multi-layer test suite covering both sub-projects and the full clip pipeline end-to-end.

### Layer 1: Vitest unit tests (per sub-project)
- `discerned-ext/tests/extraction/` — extractors run against ~10 fixture HTML pages
- `discerned-ext/tests/nostr/` — event factory + serialize/parse round-trip
- `discerned-web/tests/parse.test.ts` — Nostr event → ClipData
- `discerned-web/tests/bridge.test.ts` — origin-pinned postMessage contract
- `discerned-web/tests/components/ClipRow.test.tsx` — component rendering
- Both projects use `jsdom` env. The extension's `tests/setup.ts` shims `chrome.runtime` and silences the extension logger to `WARN`.

### Layer 2: Playwright e2e (at repo root)
- `tests/e2e/extension.spec.ts` — real Chromium loads `discerned-ext/dist-test/`, drives each fixture page, asserts Capture matches the `.expected.json` sidecar.
- `tests/e2e/web-rendering.spec.ts` — injects fixture clips through real postMessage bridge into `/library`, asserts `<ClipRow>` rendering.
- `tests/e2e/web-feed.spec.ts` — uses `page.routeWebSocket` to mock the Nostr relay and verify public feed rendering.
- `tests/e2e/end-to-end.spec.ts` — full pipeline: capture → real CLIP handler → IndexedDB → bridge → `/library` rendering.
- `tests/e2e/live.spec.ts` — opt-in (`LIVE=1`), hits real URLs from `tests/fixtures/live-urls.json` (includes a primal.net note thread).
- `tests/e2e/primal-visual.spec.ts` — opt-in visual harness (`PRIMAL=1`, `PWDEBUG_HEADLESS_NEW=1` for headless). Loads real primal.net with the extension, captures a clip, renders it through the web app's `/library`, and screenshots the rendered `.clip-body`. Used to iterate on the per-site tagger + `dx-*` CSS (see `discerned-ext/CLAUDE.md` → Capture pipeline). All artifacts (screenshots, structure dumps, rendered HTML) write to `test-output/` (gitignored). Run: `PRIMAL=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/primal-visual.spec.ts`
- `tests/e2e/bsky-visual.spec.ts` — opt-in visual harness for bsky.app (`BSKY=1`, `PWDEBUG_HEADLESS_NEW=1`). Same shape as primal-visual: loads a real Bluesky profile/thread, captures, renders through `/library`, dumps `bsky-*` artifacts (incl. `bsky-testids.txt` enumerating the page's `data-testid` anchors) to `test-output/`. Used to iterate on the `tagBsky` tagger. Override the target with `BSKY_URL=...`. Run: `BSKY=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=bsky-visual`

### Fixtures
- `tests/fixtures/sites/*.html` + `*.expected.json` — 10 HTML pages covering news, blog, Wikipedia, Twitter/X DOM, GitHub README, HN, Substack, plain text, malformed, XSS payloads.
- `tests/fixtures/clips/*.json` — 6 Capture+Evaluation JSON fixtures (one per ClipFormat + with-note + unicode).
- `tests/fixtures/live-urls.json` — URLs for opt-in live mode.

### Dev-mode test bridge
Production-code edits in `discerned-ext/src/content/content.ts` add a message listener gated on `__DISCERNED_TEST_BUILD__` (a Vite `define` flag set to `true` only for `--mode test` / `--mode development`). It accepts `__DISCERNED_TEST_CAPTURE` and `__DISCERNED_TEST_CLIP` messages so Playwright can drive `captureContext()` and the CLIP path without the manual evaluation overlay. Production builds tree-shake this code out entirely.

### dist vs dist-test isolation
- `dist/` — production build (`pnpm build`). Loaded by your Brave browser for daily use.
- `dist-test/` — test build (`pnpm build:test`). Loaded by Playwright. **E2E tests never touch your dev install.**

## Deployment

The web app is deployed by **Netlify** from `github.com/steveja42/discerned` on every push to `main` (when files under `discerned-web/` change — guarded by a `[build.ignore]` rule). Config lives in both:
- `netlify.toml` at workspace root (the fallback)
- `discerned-web/netlify.toml` (read when Netlify's "package path" is set to `discerned-web` in the dashboard)

Both pin `NODE_VERSION = "22"` and `PNPM_VERSION = "11"`. Node 22 is required by pnpm 11 (uses `node:sqlite`). Build command is `pnpm install --frozen-lockfile && pnpm --filter=./discerned-web build`, publish dir is `discerned-web/.next`.

## VS Code workflow

Open `discerned.code-workspace` (not the folder). It loads four roots side by side:
- 🧩 Extension
- 🌐 Web app
- 🧪 E2E tests
- 📁 Monorepo root

Commands:
- **Ctrl+Alt+D** — runs the `dev: both` task (starts both `pnpm dev` watchers in side-by-side terminals).
- Compound launch config **"🚀 Debug everything (Brave + extension + web)"** launches Brave with the extension loaded AND attaches the web debugger to the localhost:3000 tab inside the same Brave instance. Both debug configs share port 9222.

## Status

MVP — Chrome extension and web app are functional. Test suite: 60 extension + web unit tests, 15 e2e tests, all green (plus opt-in `LIVE` and `PRIMAL` visual specs). Captured clips from div-soup SPAs (Nostr clients like primal.net, Mastodon, Bluesky) render as readable threads via the per-site tagger + `dx-*` marker system. Android and iOS sub-projects planned.
