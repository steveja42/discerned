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
├── netlify.toml                ← Netlify config (publish out/ from discerned-web/)
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
- **Client version stamp.** Every published cast carries the NIP-89 tag `['client', 'discerned', '<version>']`; `tag[1]` stays `'discerned'` (that's what other Nostr clients read), the version is the third element. Casts are permanent and public, so this is the only way to know after the fact which capture pipeline produced a given event. The version is **injected**, not read from `chrome.runtime.getManifest()` inside `events.ts`: the factory stays pure (runs under jsdom in Vitest) and the committed golden fixtures in `tests/fixtures/events/` are generated from it — reading the live manifest would rewrite all ~20 on every version bump. Fixtures therefore carry the stable `DEFAULT_CLIENT_VERSION` (`0.0.0-dev`) placeholder; `background.ts` calls `setClientVersion(chrome.runtime.getManifest().version)` at **module scope**, so it re-applies on every MV3 service-worker wakeup (a listener-only assignment would leave the placeholder after a restart). Kind-30078 (private encrypted clips, not currently published) deliberately does **not** carry the version — its tags are public and kept minimal. Bump the version in three files together: `discerned-ext/manifest.json`, `discerned-ext/package.json`, `discerned-web/package.json`.
- **Extension ↔ web bridge** messages are typed in `discerned-ext/src/shared/types.ts` (`WebBridgeOutbound` / `WebBridgeInbound`) and consumed in `discerned-web/lib/bridge/extension-bridge.ts`. Clip bodies (`bodyHtml`, `thumbnail`) are **not** included in the bulk `DISCERNED_BRIDGE_CLIPS` message — they are fetched per-clip on demand via `DISCERNED_REQUEST_CLIP_BODY` / `DISCERNED_BRIDGE_CLIP_BODY` to stay under `chrome.runtime.sendMessage`'s 64 MiB hard limit. See `discerned-ext/CLAUDE.md` → Web-bridge protocol for details.
- **Default relays** are defined in `discerned-ext/src/shared/types.ts` (`DEFAULT_RELAYS`) and mirrored in `discerned-web/lib/constants.ts` — keep them in sync.
- **User relay preferences (NIP-65).** The effective relay set is **user-owned**: `getEffectiveRelays()` in `discerned-ext/src/shared/relays.ts` resolves it as `(mode defaults ∪ STORAGE_KEYS.USER_RELAYS) − STORAGE_KEYS.REMOVED_RELAYS`. Two invariants: **local mode is exclusive** (returns `[LOCAL_RELAY]` and ignores the user list, so dev/test casts never reach the public network) and the result is **never empty** (removals that would empty it fall back to the mode defaults). `REMOVED_RELAYS` is a separate list rather than a deletion so re-discovery can't resurrect a relay the user dropped. Every relay consumer goes through this one helper — publish, profile fetch, `naddr`/`nprofile` hints, the overlay's relay count. On sign-in (all three auth modes) `discoverAndMergeRelays` in `background.ts` fetches the identity's kind-10002 write relays via `background/relay-list-fetcher.ts` (24h per-pubkey cache; `window.nostr.getRelays()` is a nip07-only fallback) and merges them in. The **web app's Settings → Relays** section is the only editing UI; the extension remains the canonical store and syncs both ways over `DISCERNED_BRIDGE_RELAY_LIST` / `DISCERNED_SET_RELAY_LIST`. The overlay shows the list read-only. `RelayRow` + `normaliseRelayUrl` are mirrored (not imported) in `discerned-web/lib/constants.ts` — keep in sync.
- **Active relays vs default relays.** `DEFAULT_RELAYS` is the production wss:// list (mirrored ext↔web, keep in sync). The relay **mode** (`local` | `production`) is what's **deliberately not** mirrored — each side resolves it via its own platform idiom: the **extension** uses the `__DISCERNED_TEST_BUILD__` build flag (dev/test → `[ws://localhost:7777]`, production → `DEFAULT_RELAYS`, tree-shaken), while the **web app** uses the `NEXT_PUBLIC_LOCAL_RELAY` env var (set in `discerned-web/.env.local`, unset in production). In dev/test the local relay **replaces** the public ones so test casts never hit the real network. Publish ACK threshold is derived per-publish from the relays actually attempted via `minAcksFor()` (1 local, 2 production, capped at 2 however many the user adds). Run the relay with `pnpm relay:local` — see `tools/nostr-relay/README.md`.
- **Feedback deep link.** The extension's overlay Settings drawer opens the web app's `/feedback` page via an `OPEN_FEEDBACK` message (typed in `discerned-ext/src/shared/types.ts`, handled in `background.ts` by `openFeedbackTab` → the shared `openWebAppTab` helper). The URL carries `?target=extension&v=<manifest version>` and **deliberately nothing else** — reports become PUBLIC GitHub issues, so auth mode and publish mode are withheld rather than disclosed without the user's say-so. Don't "helpfully" add them. The page reads its params from `window.location.search` in a lazy `useState` initialiser, **not** `useSearchParams` (which forces a Suspense boundary under static export) and, unlike `TopBar`'s `?settings=1`, does not strip them — they're form state, so stripping would lose the prefill on reload.
- **Icons are generated across both projects by one script.** `discerned-ext/scripts/gen-icons.mjs` (`pnpm gen:icons`, run from `discerned-ext/`) rasterises SVG masters in `art/` into the extension's `public/icons/*.png`, the mirrored web copies that back the Nostr avatar, and the web app's `app/favicon.ico` / `app/icon.svg` / `app/apple-icon.png`. Deliberate **theme split**: azure for the extension + Nostr avatar, navy for the site's own favicons — so `discerned-web/public/icons/` is *not* a byte-mirror of the site favicon. All icons are transparent and full-bleed (no background tile, mark scaled to its tight bbox), and 16px uses a separate simplified master because the full mark is illegible at that size. All outputs are committed. After changing icons, re-run `pnpm pack:ext` too. Details in `discerned-ext/CLAUDE.md` → Icon assets.
- **Extension ID.** The `key` field was **removed from `manifest.json`** for Chrome Web Store submission — the store assigns its own ID and signs with its own key, and an uploaded package carrying a `key` is rejected. The old pinned ID was `egocpdhpffaddnhjimclgabdhpbjbhod` (private `.pem` outside the repo at `~/.discerned-keys/discerned-ext.pem`); keep the `.pem` so the side-loaded zip build can be re-pinned if ever needed. **Consequence:** an unpacked/side-loaded install now gets a random per-profile ID, so its IndexedDB (`discerned`) is a *separate store* from a Web Store install's. Existing side-load users do not carry clips over to the store build — that migration is not automatic. The store ID must be added to `ALLOWED_ORIGINS` in `discerned-web/netlify/functions/feedback.mts` once known (the extension currently opens a tab rather than POSTing, so nothing is broken until it does).

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
- `discerned-web/tests/feedback-format.test.ts` — the pure feedback helpers (issue title/body/labels, and the `@`/`#` neutering that must not mangle emails)
- `discerned-web/tests/feedback-function.test.ts` — the **real** Netlify function handler with `fetch` stubbed: honeypot files nothing, never-fail-open on a missing Turnstile secret, 400-vs-502 Turnstile outcomes, GitHub 422 mapping, rate limiting. Used instead of `netlify dev`, which would fight the dev server for port 3000.
- Both projects use `jsdom` env. The extension's `tests/setup.ts` shims `chrome.runtime` and silences the extension logger to `WARN`.

### Layer 2: Playwright e2e (at repo root)
- `tests/e2e/extension.spec.ts` — real Chromium loads `discerned-ext/dist-test/`, drives each fixture page, asserts Capture matches the `.expected.json` sidecar. **Always offline**: the navigation target is derived from the fixture FILENAME (`http://127.0.0.1:4173/<name>.html`), never from the sidecar's `url`. That field is the location to **simulate** — the Vitest suite fakes `window.location` with it, so fixtures whose capture path branches on hostname (Amazon, YouTube, AP) legitimately carry their real source URL. Navigating to it instead made 9 fixtures load the LIVE site and assert a saved snapshot's expectations against today's web (7 failed; hackernews + x-status passed only by luck). Hostname-dependence belongs in `hostOverride`, which exists precisely so the real tagger/Tier-0 path fires against the local file. Real live testing is `live.spec.ts` — opt-in via `LIVE=1`, its own project and URL list.
- `tests/e2e/web-rendering.spec.ts` — injects fixture clips through real postMessage bridge into `/clips`, asserts `<ClipRow>` rendering.
- `tests/e2e/web-feed.spec.ts` — uses `page.routeWebSocket` to mock the Nostr relay and verify public feed rendering.
- `tests/e2e/end-to-end.spec.ts` — full pipeline: capture → real CLIP handler → IndexedDB → bridge → `/clips` rendering.
- `tests/e2e/live.spec.ts` — opt-in (`LIVE=1`), hits real URLs from `tests/fixtures/live-urls.json` (includes a primal.net note thread).
- `tests/e2e/primal-visual.spec.ts` — opt-in visual harness (`PRIMAL=1`, `PWDEBUG_HEADLESS_NEW=1` for headless). Loads real primal.net with the extension, captures a clip, renders it through the web app's `/clips`, and screenshots the rendered `.clip-body`. Used to iterate on the per-site tagger + `dx-*` CSS (see `discerned-ext/CLAUDE.md` → Capture pipeline). All artifacts (screenshots, structure dumps, rendered HTML) write to `test-output/` (gitignored). Run: `PRIMAL=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/primal-visual.spec.ts`
- **Three-image visual verification (source / clip / cast).** Every live `*-visual.spec.ts` (bbc, breitbart, bsky, embedded-tweet, goodreads, medium, primal, reddit, stackoverflow, wikipedia, youtube) writes **three** screenshots per site to `test-output/`: `{site}-source.png` (the live website), `{site}-rendered.png` (the private **clip** — rich dx-* `bodyHtml`), and `{site}-cast.png` (the public **cast** — the kind-30023 markdown everyone else sees). The cast is built by the extension's OWN code via a test-only `BUILD_CAST` bridge (`__DISCERNED_TEST_CAST` → `handleCast`'s real `deriveLongFormMarkdown` + factory), then rendered through the real `/discerns` feed in a fresh (extension-free) browser with a mocked relay. This catches cast-only defects (duplicate hero, giant avatars, `](url)` brace spills, smashed stat digits) that the clip render hides — a site can look perfect as a clip and be broken as a cast, because the cast body is a lossy `htmlToMarkdown` conversion. Helpers: `tests/e2e/helpers/castFromCapture.ts` (drives `BUILD_CAST`), `renderCast.ts` (mocked-relay feed render), `castShot.ts` (`castShotSafe` — one call; never fails the primary clip check on a flaky live site). The cast render is additive; the clip assertions remain the pass/fail gate.
- `tests/e2e/bsky-visual.spec.ts` — opt-in visual harness for bsky.app (`BSKY=1`, `PWDEBUG_HEADLESS_NEW=1`). Same shape as primal-visual: loads a real Bluesky profile/thread, captures, renders through `/clips`, dumps `bsky-*` artifacts (incl. `bsky-testids.txt` enumerating the page's `data-testid` anchors) to `test-output/`. Used to iterate on the `tagBsky` tagger. Override the target with `BSKY_URL=...`. Run: `BSKY=1 PWDEBUG_HEADLESS_NEW=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=bsky-visual`
- `tests/e2e/embedded-tweet-visual.spec.ts` — opt-in (`EMBED=1`) capture of a real article with widgets.js tweet embeds (ZeroHedge by default); verifies the `EXTRACT_EMBEDDED_TWEETS` path harvests both blockquote and platform.twitter.com iframe shapes and renders rich tweet-cards inline.
- `tests/e2e/medium-fixture-visual.spec.ts` / `tests/e2e/medium-visual.spec.ts` — Medium article rendering. The `-fixture-` variant (`MED_FIX=1`) hits `tests/fixtures/sites/medium-article.html` for fast offline iteration on byline + engagement-row layout; the live variant (`MEDIUM_VISUAL=1`) uses a persistent Brave profile + anti-detection flags to clear Cloudflare Turnstile.
- `tests/e2e/breitbart-fixture-visual.spec.ts` / `tests/e2e/breitbart-visual.spec.ts` — Breitbart article rendering. Tests the wrapper-iframe tweet-embed pattern (`/t/assets/html/tweet-N.html#TWEET_ID`), nested platform.twitter.com extraction, dx-byline tagging on avatar-less bylines, and chrome-link removal (Google preferred-source button, Polly TTS audio scrubber).
- `tests/e2e/twitter-clip-modes.spec.ts` — `TWITTER=1`. Verifies article / full-page / selection capture on twitter.com / x.com all produce rich tweet-cards (Tier 0 routed for all three formats).
- `tests/e2e/web-feedback.spec.ts` — drives the `/feedback` form (`--project=web`): `?target=` prefill (and fallback on an unknown value), submit gated on message length, success replacing the form with the issue link, the exact JSON posted, a server error preserving the typed message plus the GitHub fallback link, retry-after-failure (the Turnstile stale-token path), and the honeypot being present but untabbable. **Stubs both externals** — `**/api/feedback` is route-fulfilled and the Turnstile script is replaced by a token-returning shim, so the spec never reaches GitHub or Cloudflare. Note the chips are visually-hidden radios styled as labels: click the `.feedback-chip` label, not the input (`.check()` fails as "not visible").
- `tests/e2e/web-relay-settings.spec.ts` — drives the Settings → Relays UI (`--project=web`): renders the defaults with source badges, adds/normalises/rejects a relay URL, removes a default, blocks removing the last relay, disables editing in local relay mode, and shows a NIP-65-discovered relay pushed over the bridge. Screenshots to `test-output/relay-settings-*.png`. Note it forces `discerned.relayMode=production` via `addInitScript` — the dev server sets `NEXT_PUBLIC_LOCAL_RELAY`, so the app otherwise boots in local mode where the list is deliberately fixed.
- `tests/e2e/relay-prefs-e2e.spec.ts` — the relay round-trip through the REAL extension (`--project=extension`): an edit in the web settings UI must reach `chrome.storage.local` (read back from the service worker) and change the effective publish set. Covers the half the web-only spec can't.
- `tests/e2e/overlay-visual.spec.ts` — opt-in (`OVERLAY=1`) visual harness for the extension's evaluation overlay (Signal slider + Qualifier chips, dark-zinc theme). Triggers `ACTIVATE_DISCERNED` through the extension service worker and screenshots the gate + unrated main views to `test-output/overlay-*.png` for human review (closed shadow root — no pixel baseline).
- `tests/e2e/helpers/launchExtension.ts` — `launchWithExtension({ profile, headed })`. Persistent profiles live at `.vscode/browser-test-profiles/<name>/` (gitignored). Anti-detection launch flags (`--disable-blink-features=AutomationControlled`, real UA, `navigator.webdriver` override) included by default — required for Medium/Breitbart-style Cloudflare gates.
- Probe specs (opt-in via env vars): `embedded-tweet-probe`, `breitbart-probe`, `medium-probe`, `tweet-video-probe`, `extractor-frame0-probe`, `extractor-full-probe`, `zh-counters-probe`. Each dumps DOM structure / per-iframe extractor output to `test-output/` for one-off diagnostics.

#### Sweep-triage probes

Three diagnostics that answer the questions a corpus-sweep score *can't*. All are opt-in, write to `test-output/`, and are **diagnostics, not gates** — the pixel baselines remain the regression floor. Reach for these before writing a capture fix: a sweep finding rarely means what it looks like, and guessing the mechanism has produced wrong fixes more than once.

| Probe | Answers | Run |
|---|---|---|
| `tools/finder-diag-probe.spec.ts` | **Two modes.** *finder* (default): which content-block the layout finder picks and why — tag/class/textLen/visLen/area/linkRatio/#p/#img per candidate, plus whether the real body text is even in the DOM. Distinguishes a finder mis-pick from a bot-gate/lazy-load. *picker* (`DIAG_MODE=picker`): why a discovery seed reported "no link matched picker" — final URL, `<title>`, anchor/regex/minText counts, real deep links, screenshot, verdict. | `DIAG=1 [DIAG_MODE=picker] [DIAG_ONLY=a,b] [DIAG_HEADED=1] [DIAG_WAIT=60] [DIAG_GAP=45] --project=finder-diag-probe` |
| `tools/hidden-prose-probe.spec.ts` | Is low text-coverage a **paywall** (prose in the DOM but `visibility:hidden` — capture is faithful, do NOT "fix" it) or a **finder mis-pick** (prose visible, wrong block won)? Reports visible-vs-hidden prose counts, what hid each paragraph, and where the visible prose lives. | `HIDDEN=1 [HIDDEN_ONLY=folha] [HIDDEN_HEADED=1] --project=hidden-prose-probe` |
| `tools/clip-width-probe.spec.ts` | Why a rendered clip **collapses into narrow columns** (text one character per line). Renders a saved capture through the real `.clip-body` CSS and reports the narrowest text elements + the ancestor chain that set the width. Works **offline from a saved HTML file**, so a fix can be iterated without re-hitting a Cloudflare-gated site. | `CLIPW=1 CLIPW_DOMAIN=<d> [CLIPW_HTML=<path>] --project=clip-width-probe` |

Notes:
- **Picker mode reads its seeds from `discover-article-urls.spec.ts`** rather than keeping a second copy — an earlier standalone probe drifted to a stale hub URL and silently probed the wrong page.
- `DIAG_GAP` paces between sites. Hitting ~10 domains back-to-back from one IP is itself a bot signal: an unpaced run got Cloudflare challenges on the *last* three sites while earlier ones loaded fine.
- Chrome must be **fully closed** before any of these run — they use the warm `Profile 3`, and a live Chrome holds the profile lock (`launchPersistentContext` fails).
- Causes these have actually found: domain rebrands (`msnbc.com` → `ms.now`, `phys.org` → `techxplore.com`) where the regex can never match; changed article-ID schemes (CBC `-1.N` → `-9.N`); wrong hub URL returning an empty shell (mistaken for a paywall); `minText` rejecting image-wrapped 0-char anchors; and `.dx-stats` (`display:flex`) collapsing a comment thread.
- `tests/e2e/tagger-canary.spec.ts` — opt-in (`CANARY=1`, `--project=tagger-canary`) weekly canary that runs each per-site tagger's selector-anchor manifest against the LIVE site and fails naming the exact dead selector when a redesign breaks a tagger (page-load flakes are SKIPs, not fails). A tagger may have several targets when the site has distinct page shapes (primal: profile feed + thread) — see `discerned-ext/CLAUDE.md` for why the manifest groups variants while the *targets* split them. Scheduled locally via `scripts/tagger-canary-local.ps1` (warm `test` Chrome profile → covers CF-walled Reddit/YouTube/StackOverflow) and in CI via `.github/workflows/tagger-canary.yml` (open sites only — the warm profile is gitignored, so CI silently gets an empty one). See `discerned-ext/CLAUDE.md` → "Tagger canary / repair loop".

### Fixtures
- `tests/fixtures/sites/*.html` + `*.expected.json` — HTML pages covering news, blog, Wikipedia, Twitter/X DOM, GitHub README, HN, Substack, Medium, Breitbart, plain text, malformed, XSS payloads, articles with embedded tweets (blockquote + iframe + Breitbart-style wrapper), and tweet with truncation + "Show more" link.
- `tests/fixtures/clips/*.json` — 6 Capture+Evaluation JSON fixtures (one per ClipFormat + with-note + unicode).
- `tests/fixtures/live-urls.json` — URLs for opt-in live mode.

### Dev-mode test bridge
Production-code edits in `discerned-ext/src/content/content.ts` add a message listener gated on `__DISCERNED_TEST_BUILD__` (a Vite `define` flag set to `true` only for `--mode test` / `--mode development`). It accepts `__DISCERNED_TEST_CAPTURE`, `__DISCERNED_TEST_CLIP`, and `__DISCERNED_TEST_CAST` messages so Playwright can drive `captureContext()`, the CLIP path, and the CAST **build** path without the manual evaluation overlay. Production builds tree-shake this code out entirely.

`__DISCERNED_TEST_CAST` runs the extension's REAL cast pipeline without signing or publishing: the content script does the real `deriveLongFormMarkdown` (turndown needs the content-script DOM the SW lacks), then the background's test-only `BUILD_CAST` handler runs the real `buildCastTemplates` (`buildShortNote` + `createLongFormEvent`) and returns the unsigned kind-1 + kind-30023 templates. Specs sign them with a throwaway key and render through `/discerns`. This drives production code — not a reimplementation — so the cast the visual specs screenshot is byte-for-byte what `handleCast` would publish. (Note: persistent test profiles cache the extension's MV3 service worker across a `pnpm build:test`, so a new background handler like `BUILD_CAST` can 404 with a stale SW — `launchWithExtension` now clears the SW/Code-Cache dirs for named profiles on launch to force a re-register.)

### dist vs dist-test isolation
- `dist/` — production build (`pnpm build`). Loaded by your Brave browser for daily use.
- `dist-test/` — test build (`pnpm build:test`). Loaded by Playwright. **E2E tests never touch your dev install.**

## Deployment

The web app is deployed by **Netlify** from `github.com/steveja42/discerned` on every push to `main` (when files under `discerned-web/` change — guarded by a bare `ignore = "..."` string under `[build]`; note a `[build.ignore]` *table* is rejected by Netlify). Config lives in both:
- `netlify.toml` at workspace root (the fallback)
- `discerned-web/netlify.toml` (read when Netlify's "package path" is set to `discerned-web` in the dashboard)

Both pin `NODE_VERSION = "22"` and `PNPM_VERSION = "11"`. Node 22 is required by pnpm 11 (uses `node:sqlite`). Build command is `pnpm install --frozen-lockfile && pnpm --filter=./discerned-web build`, publish dir is `discerned-web/out` (a static export — `next.config.ts` sets `output: 'export'`, so nothing is emitted to `.next/` for deploy).

**Netlify Functions.** `discerned-web/netlify/functions/` holds the only server-side code in the project (the static export rules out Next API routes and server actions). Currently one function: `feedback.mts`, which turns a `/feedback` submission into a GitHub issue. The directory **must** stay under `discerned-web/` — the `ignore` rule above would skip the deploy for a function-only change otherwise. Functions are ESM bundled by esbuild at deploy time, not by Next, so they carry their own `tsconfig.json` (`allowImportingTsExtensions`) and the app tsconfig excludes them; `pnpm type-check` checks both. Secrets (`TURNSTILE_SECRET_KEY`, `GITHUB_FEEDBACK_TOKEN`) live only in the Netlify dashboard and are never `NEXT_PUBLIC_`-prefixed — that prefix would inline them into the client bundle.

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

MVP — Chrome extension and web app are functional. Test suite: 219 extension + 137 web unit tests (Vitest) and ~60 e2e spec files, all green (plus opt-in `LIVE`, `PRIMAL`, and corpus-sweep specs). Captured clips from div-soup SPAs (Nostr clients like primal.net, Mastodon, Bluesky) render as readable threads via the per-site tagger + `dx-*` marker system. Android and iOS sub-projects planned.
