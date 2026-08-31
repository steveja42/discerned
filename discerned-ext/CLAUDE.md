# CLAUDE.md — Discerned 

## Project Overview

Discerned is a Chrome Extension (Manifest V3) that acts as a value attribution layer for the web. Users capture content (selected text or page metadata), evaluate it (a 5-level Signal rating, multi-select Qualifier tags, and a Category), and publish cryptographically-signed signals to the [Nostr](https://nostr.com/) network.

## Tech Stack

| Tool | Version | Role |
|---|---|---|
| TypeScript | 5.3.3 (strict) | Primary language |
| Vite | 5.1.3 | Bundler |
| pnpm | ≥ 8 | Package manager |
| nostr-tools | 2.7.2 | Nostr protocol |
| Vitest | 1.2.2 | Test runner |
| ESLint | 10.0.1 | Linting |

## Commands

```bash
pnpm dev          # Vite watch mode, writes dist/ incrementally
pnpm build        # tsc + Vite production build → dist-pack/
pnpm build:test   # development-mode build → dist-test/ (for Playwright)
pnpm pack:ext     # runs `pnpm build`, zips dist-pack/ to the web app's public/ for download
pnpm gen:icons    # regenerate all icon rasters (both projects) from the art/ SVG masters
pnpm type-check   # tsc --noEmit (strict)
pnpm lint         # ESLint on src/**/*.ts
```

## Dev environment — IMPORTANT for AI assistants

**Assume `pnpm dev` is already running in `discerned-ext/` and `discerned-web/`.** The user keeps both watchers up; `pnpm dev` (crxjs's dev mode) incrementally rewrites `dist/` on every save, and the loaded Chrome extension picks it up on reload. `pnpm build` and `pnpm pack:ext` both write to `dist-pack/` instead — **never `dist/`** — precisely so a production build can never collide with or clobber the live dev output. This has two consequences for any work in this repo:

- **`pnpm build` is safe to run** — it no longer touches `dist/`. It's still rarely what you want mid-task, though: to verify TypeScript compiles, prefer the faster `pnpm type-check`. To pick up your source edits in the user's loaded extension, do nothing — `pnpm dev` writes `dist/` on save, the user reloads the extension + page.
- **Playwright reads `dist-test/`, NOT `dist/` or `dist-pack/`.** When you need to validate via a Playwright spec, run `pnpm build:test` first (it writes only to `dist-test/`). The `tests/e2e/*` specs all load `dist-test/`.

If you ever see an "extension is broken" symptom (overlay missing, bookmark-style 2-line clips when full content was expected), the user's loaded `dist/` has gone stale — the fix is to **restart `pnpm dev`**.

## Production build (`pnpm build`) and packing for download (`pnpm pack:ext`)

`pnpm build` runs `tsc`, then `vite build --outDir dist-pack --emptyOutDir` — a real production build (minified, `__DISCERNED_DEV_BUILD__` false) into `dist-pack/`, isolated from the dev `dist/` and test `dist-test/` (same rationale as `dist-test/`'s isolation — see Dev environment above). `dist-pack/` is gitignored and is **wiped at the START of each build** (`emptyOutDir` / `rmSync` for a clean rebuild) but **kept afterward on purpose** — it doubles as a ready-to-load-unpacked local production build (`chrome://extensions` → Load unpacked → select `dist-pack/`).

`pnpm pack:ext` (`scripts/pack-extension.mjs`) builds on top of that: it shells out to `pnpm build` (so the zip and a locally-loadable `dist-pack/` always come from one build, never two), then zips the result as a downloadable **unpacked** extension to side-load via `chrome://extensions` → Load unpacked.

**Public installs now come from the [Chrome Web Store](https://chromewebstore.google.com/detail/discerned/gpfeknmodijdlehpnkfannklhplmfoma)** (store ID `gpfeknmodijdlehpnkfannklhplmfoma`). The web app's `/get-extension` side-load page was removed and every "Get the extension" CTA links to the store (`WEB_STORE_URL` in `discerned-web/lib/constants.ts`). The zip is kept for side-loading — testers, a pre-store build — but is no longer linked from the site.

What `pack:ext` does after the build:

1. Zips `dist-pack/` with `manifest.json` at the **zip root** (not nested in a subfolder) so users select the unzipped folder directly in Load unpacked. Zipping uses the OS-native tool — PowerShell `Compress-Archive` on Windows, `zip` elsewhere — so there's **no extra npm dependency**.
2. Writes the result to `../discerned-web/public/discerned-extension.zip`.

Because the web app is a **static export** deployed by Netlify (which only builds `discerned-web/`, never runs this script), the zip is **committed to git** so Netlify serves it at `/discerned-extension.zip` — reachable by direct URL even though nothing links to it. It does **not** auto-update: after shipping extension changes, re-run `pnpm pack:ext` and commit the refreshed zip. The manifest `version` is read only for the build log line — bump `manifest.json` yourself when cutting a new download.

## Icon assets (`pnpm gen:icons`)

Every shipped icon raster is generated from SVG masters by `scripts/gen-icons.mjs`. The PNGs/ICO are **committed** — the manifest and Next's icon lookup need real files, and the art changes about once a year, so a rasteriser in the build path would buy nothing.

**The theme split.** There are two masters, and they deliberately differ:

| Master | Colour | Feeds |
|---|---|---|
| `art/icon.svg` | azure `#60a5fa` | extension toolbar / Web Store icons, **and** the mirrored `discerned-web/public/icons/*.png` that `.well-known/nostr.json` uses as the Nostr profile avatar (Nostr clients are overwhelmingly dark-themed) |
| `discerned-web/app/icon.svg` | navy `#1d4ed8` | the site's own `favicon.ico` + `apple-icon.png`, matching its light theme and the navbar's `var(--accent-ink)` |

So `discerned-web/public/icons/` is **no longer a byte-mirror** of the extension's icons — the PNGs match each other, but the two masters don't. Don't "fix" the divergence.

**All icons are transparent and full-bleed.** No background tile: Chrome composites the toolbar icon onto whatever theme the user runs, and browsers composite a favicon onto a tab strip that is near-white in light mode and near-black in dark mode, so an opaque tile would show as a coloured square. Consequences worth knowing before editing a master:

- The mark is scaled to its own **tight bounding box** — `4 3 24 30` in `MiniBeacon`'s `0 0 32 36` coordinate system, measured with `getBBox()`. The raw viewBox carries ~4 units of slack per side, which is the "margin" that made the old icons look small. The same tight viewBox is used by the inline brand marks in `overlay.ts` / `popup.html` / `onboarding.html`, so a CSS `height` there is the mark's real rendered height.
- **Opacities are raised from MiniBeacon's**: rays `0.5 → 0.75`, lamp halo `0.12 → 0.28`. Those values were tuned against an opaque near-black tile; composited onto an arbitrary background, `0.12` azure becomes an ~alpha-30 smudge that makes the lamp read as a pale hole punched in the tower.

**The 16px problem.** A 16×16 downscale of the full mark is an unreadable smudge: the mark lands ~4px wide and only 22 of 256 pixels carry any ink. So 16px has its own simplified drawing (`art/icon-small.svg`, and `discerned-web/art/icon-small.svg` for the light side) — three rays instead of five, one rung, a solid tower instead of an outline. `gen-icons.mjs` picks it via `masterFor()` for `icon16.png` and the 16px `favicon.ico` frame only. Two traps that cost a round of rework there:

- The rung is a **real gap between two trapezoids**, not an overpainted line. With no background colour there is nothing to punch a hole with. The gap is 1.4px because a 1px void closes up under Lanczos antialiasing.
- The lamp needs ~0.7px of daylight under it, or lamp and tower antialias into one blob and the silhouette is lost.

**If you edit the silhouette, edit all four masters** plus `MiniBeacon.tsx` and the four inline copies, and keep them recognisably the same beacon.

**Masters live in `art/`, never `public/`.** Vite's `publicDir` defaults to `public/`, so anything under it is copied verbatim into `dist/` and into the zip users download — an art source has no business shipping inside the extension. (This bit once: the old `public/icons/icon.svg` was riding along in every build.)

Rasterising uses `@playwright/test`'s bundled Chromium (already a root devDependency for the e2e suite — no new package), so icons are drawn by the same engine that renders the navbar mark. `sharp` looks available but is **not** resolvable: it appears only in a pnpm `onlyBuiltDependencies` allowlist. Chromium can't emit `.ico`, so Pillow packs the 16/32/48/256 frames from the PNGs it produced.

**`pnpm dev` does NOT pick up icon changes on its own.** `viteStaticCopy` copies `public/icons` once at watcher startup and never watches it, so overwriting a PNG leaves a running dev server serving the OLD icon indefinitely — the loaded extension shows stale art with nothing to indicate it, and `pnpm build` is not an escape hatch (it would clobber the dev `dist/`, see Dev environment above). `gen-icons.mjs` therefore copies the finished PNGs straight into `dist/`, `dist-test/`, and `dist-pack/` when those exist. If you ever hand-edit an icon without running the generator, copy it into those dirs yourself. This is exactly how a "the toolbar icon still has a black background" report happened once — the source was already transparent; `dist/` was not.

**After any icon change, re-run `pnpm pack:ext`** — the committed zip carries its own copy of the icons and does not auto-update.

The geometry in `art/icon.svg` is copied verbatim from `discerned-web/components/brand/MiniBeacon.tsx` so the icon and the navbar mark are provably the same drawing; only a wrapping transform and the colour literals differ.

### The in-app brand mark

The extension UI used a 📡 emoji as its logo. That's now the beacon, as an **inline SVG in `currentColor`**, in three places: the overlay panel header (`overlay.ts`, via the `BRAND_MARK` constant — used by both the gate and main views), `popup.html`, and `onboarding.html`.

`currentColor`, **not** the toolbar icon's azure: the overlay's accent is amber (`shared/theme.ts`), so a blue mark would clash. Inheriting the surrounding ink is what `MiniBeacon` does on the web too. Each host sets the size in CSS.

Remaining 📡 occurrences are **prose and status text**, not brand marks — "📡 Broadcasting…", "📡 Public casts", "Cast published 📡". There the emoji reads as a broadcast verb and should stay. (The onboarding steps that told users to look for "the 📡 icon" in their toolbar *were* changed — they now say "the Discerned beacon", because that sentence describes the toolbar icon, which is no longer a satellite dish.)

## Architecture

Three isolated components communicate via `chrome.runtime.sendMessage`:

```
Content Script (src/content/)
  → capture.ts     Smart capture: selected text (quote) or page metadata (resource)
  → overlay.ts     Shadow DOM evaluation UI (DiscernedOverlay custom element)
  → content.ts     Entry; listens for ACTIVATE_DISCERNED messages
  → web-bridge.ts  Runs on discerned.online/* — bridges extension data to the web app

Background Worker (src/background/)
  → background.ts  Handles context menus, signing, relay publishing, IndexedDB, tab deep-links
  → relay-manager.ts  SimplePool wrapper; requires ≥ 2 relay ACKs; 10s timeout

Popup (src/popup/)
  → popup.html / popup.ts   Auth status, usage stats, login/export
```

Path alias: `@/*` → `src/*`

## Permissions and on-demand injection

**The extension ships no broad host permission.** `manifest.json` declares only
`host_permissions: ["https://platform.twitter.com/*"]` (the fixed target for
embedded-tweet extraction) plus `optional_host_permissions: ["<all_urls>"]`.
This removes the install-time "read and change all your data on all websites"
warning every installer used to see.

**Content scripts are injected per tab, on the gesture.** `content.ts` and
`nip07-bridge.ts` are NOT in `content_scripts` (only `web-bridge.ts` is, scoped
to the app's own domains). `chrome.action.onClicked` and
`chrome.contextMenus.onClicked` both call `activateDiscernedOnTab()` in
`background.ts`, which messages an already-injected script and falls back to
`injectDiscerned()` — both gestures confer `activeTab`, which grants the tab's
own origin for the injection.

Three things about this are load-bearing:

- **Order.** `injectDiscerned` awaits `nip07-bridge.ts` (MAIN world) BEFORE
  injecting `content.ts`. The bridge overrides `window.open` to neutralise pages
  whose capture-phase click handlers open tabs on any click — including clicks in
  the overlay. Racing the two leaves a window where the overlay is visible but
  the guard isn't armed. Guarded by `tests/e2e/clickjack-guard.spec.ts`
  (+ `tests/fixtures/sites/clickjack-window-open.html`), which fails if the order
  is reversed. See memory `project_overlay_click_guard_pitfall` for the earlier
  incident in the same area.
- **Idempotency.** A page can receive either script more than once. Each guards
  on a `window.__discerned*Loaded` marker — module scope won't do, since every
  injection is a fresh module instance. Without it, listeners double-register and
  each activation fires N times.
- **Build shape.** `chrome.scripting.executeScript` runs files as CLASSIC
  scripts, so a code-split ES entry throws "Cannot use import statement outside a
  module" and silently never runs. crxjs also only emits scripts the manifest
  declares. Both are handled by `scripts/build-injected.mjs`, a second Vite pass
  that emits each as a self-contained IIFE at a fixed path
  (`injected-content.js`, `injected-nip07-bridge.js`) — chained automatically
  from a plugin in `vite.config.ts`, so `pnpm dev`/`build`/`build:test` all stay
  complete. `background.ts` references those built filenames, not source paths.

**Image inlining requires the optional grant.** `inlineImage()` in `capture.ts`
round-trips to the background's privileged fetch, which is gated on
`canFetchCrossOrigin()` (`chrome.permissions.contains`, cached and invalidated by
the `permissions.onAdded/onRemoved` events). Without the grant the call fails fast
and the clip keeps the original `<img src>`, so images hotlink and may rot later.

A canvas-based fallback (draw the already-downloaded image, `toDataURL()`) was
built and **deliberately removed**: it only works on CORS-permissive hosts, and
CORS-hostile correlates with hotlink-protected — i.e. it missed exactly the images
inlining exists to preserve. It also re-encoded (flattening animated GIFs), had no
size cap, added up to 1.5 s per image before falling through, and would have
doubled the test matrix (granted/declined x permissive/hostile) for a path no
existing spec could actually verify. Don't reintroduce it without solving those.

**Inlining is for CLIPS ONLY — casts never carry inlined images.** The grant
affects the private clip and nothing else. `inlineAllImages` overwrites `src` with
base64 but preserves the real URL in `data-dx-src`, and `htmlToMarkdown`'s
`image-real-url` rule publishes THAT, dropping any image whose only source is a
`data:` URI — base64 art is far too large for a relay. So a cast links to images at
their original address whether or not the permission is held, and a granted user
who inspects a published kind-30023 will correctly find no embedded images. Don't
"fix" this by publishing the base64. It also means image-rot protection does not
extend to casts: only the clip is durable. Reflected in the permissions-page copy
(`src/permissions/permissions.html`), which says so in plain language — that page
is user-facing, so keep protocol jargon ("relay", "kind-30023") out of it.

**The grant can be given later.** Declining at onboarding is not final — the
overlay's Settings drawer shows an "Images" card (`initImagePermissionCard()` in
`overlay.ts`) whenever the permission is absent, and hides it once granted.
`chrome.permissions.request()` must be called SYNCHRONOUSLY inside the click
handler in both places; an `await` before it drops the user gesture.

**A mid-overlay grant must re-capture.** The capture runs when the overlay OPENS
(`show()` → `refreshCapture()`), so a capture taken before the grant has already
hotlinked its images; Clip then saves that stale object and silently ignores the
permission the user just gave. `watchImagePermission()` polls on `focus` /
`visibilitychange` (the grant happens on another tab) and, on a real
ungranted→granted edge, sets `captureStaleForImages`. Two traps, both of which
produced a fix that looked right and changed nothing:
- **Don't gate the re-capture on `view === 'main'`.** The grant is given FROM the
  Settings drawer, so the view is `'settings'` at that moment and the branch never
  runs.
- **Don't rely on the `if (!this.capture)` guard** on the return-to-main paths: a
  pre-grant capture EXISTS, it is merely stale, so that guard keeps it.
  `consumeStaleImageCapture()` is therefore called BEFORE that guard on all three
  return paths.

### Running the e2e tests against the real permission model

**There is no test-only manifest.** Specs run against the SAME manifest that
ships: no `<all_urls>`, content scripts injected on the gesture. Nothing special
is needed to run them:

```bash
pnpm --filter=./discerned-ext build:test      # writes dist-test/
pnpm exec playwright test -c tests/e2e/playwright.config.ts --project=extension --workers=1
```

**How a spec gets past `activeTab`.** Playwright cannot click the toolbar icon —
it is browser chrome, not page DOM — but Chrome treats an extension **keyboard
command** as a trusted gesture and grants `activeTab` identically. So
`manifest.json` declares a `discerned-activate` command (Alt+Shift+Y) and
`tests/e2e/helpers/activateExtension.ts` presses it over CDP. The real
`chrome.commands.onCommand` handler in `background.ts` then runs
`activateDiscernedOnTab` — production code, production manifest, real grant.

Two things cost hours to discover; do not "simplify" them away:
- Use a **custom** command, not `_execute_action`. Chrome handles the latter
  internally and it never reaches `chrome.commands.onCommand`.
- Focus the target tab at the **browser** level first
  (`chrome.windows.update({ focused: true })`). `page.bringToFront()` alone is
  not enough: Chrome routes the command to whatever tab IT thinks is focused,
  which is otherwise the install-time onboarding tab, and injection then fails
  against a `chrome-extension://` URL.

**Every spec must activate before driving the test bridge.** A spec that does
`page.goto(...)` then posts `__DISCERNED_TEST_CAPTURE` will fail with "capture
timeout" — there is no content script bound yet. `runFixtureVisual` does this for
the ~21 specs sharing it; specs with their own inline driver each need:

```ts
import { activateExtensionOnTab } from './helpers/activateExtension';
await page.goto(url, ...);
await activateExtensionOnTab(ctx, url);   // <- before any postMessage
```

Already wired: `extension.spec.ts`, `end-to-end.spec.ts`,
`medium-fixture-visual`, `breitbart-fixture-visual`, plus everything via
`fixtureVisual.ts`. **Not yet audited: the corpus sweep and the live `*-visual`
specs** — expect the same one-line fix if they report "capture timeout".

`activateExtensionOnTab` polls a `__DISCERNED_TEST_PING` until the listener
answers, so it is safe for specs that walk one page through many fixtures.

**Fixture baselines pin the capture date.** `runFixtureVisual` overwrites
`capture.timestamp` with a fixed instant (`FIXED_CAPTURE_TS`) before pushing the
clip through the bridge. `baseFields()` stamps `Date.now()` and the web app
renders it ("August 30, 2026"), so any baseline that includes the app's own
chrome — i.e. every `pageClipScreenshot: true` spec — otherwise rots the day
after it is committed. `goodreads-book-fixture-visual` is the only such spec
today, and it had been failing continuously since its baseline was taken on
2026-07-20 for exactly this reason. Only the RENDERED date changes; nothing in
the capture pipeline is affected, and the other baselines are untouched because
they screenshot `.clip-body`, which never contained the date.

## Web-bridge protocol (`src/content/web-bridge.ts`)

Runs exclusively on `discerned.online/*` and `localhost:3000/*`. Bridges the extension's IndexedDB and auth state to the companion web app via `window.postMessage`.

**Size constraint:** `chrome.runtime.sendMessage` has a hard 64 MiB limit. Article clips store large base64 images in `bodyHtml` — sending all clips at once can exceed this. The protocol therefore splits clip data into two phases:

**Phase 1 — clip list (on page load):**
- `GET_CLIPS` response strips `bodyHtml` and `thumbnail` before sending. The web app receives lightweight metadata-only clip objects and can render the clip list, filters, and categories immediately.
- `PUSH_NEW_CLIP` (background → web bridge) also strips those fields for the same reason.

**Phase 2 — body on demand:**
- When the user selects a clip in the library, `DetailPanel` posts `DISCERNED_REQUEST_CLIP_BODY` (with the clip `id`) via `window.postMessage`.
- `web-bridge.ts` forwards this to `background.ts` as `GET_CLIP_BODY`, which reads just that one clip from IndexedDB and returns `{ bodyHtml, thumbnail }`.
- The result is posted back as `DISCERNED_BRIDGE_CLIP_BODY` and stored in `ClipStoreContext.bodies` — a `Map<id, ClipBody>` that acts as a session-level cache. Subsequent selections of the same clip use the cache; no second fetch.

**Content script origin isolation:** `web-bridge.ts` runs in the web page's isolated world (`localhost:3000` or `discerned.online`), NOT the extension's `chrome-extension://` origin. It cannot directly access the extension's IndexedDB. All IndexedDB access must go through `chrome.runtime.sendMessage` to the background worker.

## Key Domain Concepts

- **Quote Capture**: Selected text + 100-char context window, published as Nostr kind 9802
- **Resource Capture**: Page title, URL, OG image, published as Nostr kind 1
- **Clip (🔒)**: Private; stored in IndexedDB (kind 30078 planned)
- **Cast (📡)**: Public; published to Nostr relays
- **Evaluation**: Signal (5 levels, Toxic→Masterpiece, optional — absent = unrated) · Qualifiers (multi-select tags, built-in + custom) · Category (7 built-in options + custom)
- **Auth modes**: NIP-07 (browser extension wallet), Local (no cast), NIP-46

## Opening web-app tabs (deep links)

Content scripts have no `chrome.tabs`, so every navigation goes through a `chrome.runtime.sendMessage` to the background worker. `openWebAppTab(path, query, patterns)` in `background.ts` is the shared opener: it reuses a matching tab if one is open (activating it and focusing its window) and navigates only when carrying a query — a bare activate on an already-correct tab avoids a pointless reload. `openDiscernsTab` and `openFeedbackTab` are thin wrappers over it.

`openLibraryTab` deliberately stays separate: it soft-navigates an already-open tab via a `NAVIGATE_TO_CLIP` message to preserve React state (`ClipStoreContext`), which doesn't fit the shared shape. Folding it in would need a `beforeNavigate` callback — over-abstraction for three call sites.

**Feedback link.** The overlay's Settings drawer has a "Send feedback or report a bug" card that sends `OPEN_FEEDBACK`, opening the web app's `/feedback?target=extension&v=<version>`. The version comes from `chrome.runtime.getManifest().version` (synchronous, permission-free, in every context).

The URL carries **the target and version only, on purpose.** Reports become PUBLIC GitHub issues, and auth mode / publish mode are information the user hasn't consented to disclose — "this user stores an nsec in the extension" should not be leaked into a public tracker by a bug report about a capture defect. They're also rarely the cause of what users actually report. A maintainer who needs them can ask in the issue thread. **Don't add them.**

`src/onboarding/onboarding.html` also links to the feedback page. It's a real extension page, so a plain `<a target="_blank">` works there — no message plumbing. `popup.html` deliberately has no link: it's a stub shown only on `chrome://`-style pages where content scripts can't run, so it would reach almost nobody.

## NIP-07 signing architecture

**Kind-1 (cast) must always be signed via the discerned web app**, not from the current tab's origin. The reason: NIP-07 wallets (Alby, nos2x) maintain per-origin approval lists. If a cast is signed on `example.com`, the wallet prompts the user to approve `example.com` — a different approval from `discerned.online`. By routing kind-1 through the web app, the user only ever approves `discerned.online` once and all subsequent casts from any site sign without additional prompts.

**Kind-0 (NIP-05 profile)** can be signed directly via `signWithSigningTab` — it's triggered post-cast when a discerned tab is already open and the wallet has just approved it.

**Implementation**: `handleCast` in `background.ts` calls `signEventViaWebApp()` for NIP-07 (pro) casts. This opens/focuses a discerned tab, posts a `DISCERNED_BRIDGE_PENDING_SIGN` message through the web-bridge, and waits for the user to click Confirm in `PendingSignModal` (mounted in `discerned-web/app/layout.tsx`). `signEvent()` is used for kind-0 and for nip46/nsec casts.

**Do not remove the web-app routing for kind-1 casts.** The `sendToBackground` timeout for CAST in `content.ts` is 150s (not 30s) so the user has time to confirm the modal.

## Capture pipeline (`src/content/capture.ts`)

`captureContext(format)` branches by `ClipFormat`. For `'article'` (the rich-content path), extraction runs in tiers, first match wins:

- **Tier 0 — Twitter/X**: `extractTweet()` builds a clean tweet card. The same function is reused by `full-page` and `selection` formats on twitter.com / x.com (a `format` parameter controls how the resulting card is plumbed into the Capture shape — `bodyHtml` for article/full-page, `selectionText` for selection). `extractTweetBlock()` and `extractTweet()` each try `data-testid` selectors first (legacy X DOM), then fall back to newer-shape equivalents (`article[data-tweet-id]`, plain `<a href="https://x.com/<handle>">` links for name/handle/avatar, `button[aria-label="Reply"|"Repost"|"Like"|"Bookmark"]` + sibling count buttons for stats, `div[dir="auto"]` for body text) — X has redesigned this markup before with no warning, dropping every `data-testid` hook at once, which silently degrades Tier 0 to the generic layout finder (avatar/date/stats end up beside the content instead of in a proper header/footer). `isTweetHost()` gates Tier 0 on the real page URL (`testHostOverride` can also satisfy it, for fixture-visual specs — unlike `SITE_TAGGERS`, which only need a hostname override).
- **Site taggers** (`applySiteTagger()`): before the tiers below, a per-site live-DOM tagger (if one matches the hostname) stamps `dx-*` class markers on the page so the captured HTML carries layout hints across sanitisation. When a site tagger runs, the generic semantic tagger is skipped (`siteTaggerActive`).
- **Tier 1 — semantic element**: `findArticleElement()` picks `<article>`/`<main>`/`[role=...]` when present.
- **Tier 1.5 — layout finder**: `findContentBlockByLayout()` scores every block by visual area + text density − link/button density, then `maybeExpandToFeed()` widens to a feed/thread parent. This is what makes div-soup SPAs (Nostr clients, Mastodon, Bluesky, Reddit) capture the right content.
- **Tier 2 — Readability**: Mozilla Readability for blog/news pages.
- **Tier 3 — full body**: last resort.

All tiers clone the live DOM, run `tagSemanticStructure()` (generic) or rely on the site tagger's markers, then `sanitiseTreeInPlace()`, then `inlineAllImages()` (round-trips images through the background's privileged fetch → base64).

### Capture quality philosophy

**The captured clip should visually match what the user saw on the source site** — not a generic reformatted version. Title, byline, avatar, hero image, body paragraphs, engagement counts should land in roughly the same positions and proportions as on the live page. Pixel-perfect isn't the goal; **recognisable shape** is.

When working on capture quality:

1. **General solutions take precedence over per-site ones.** A new heuristic in `tagSemanticStructure()` or the pipeline (e.g. `dedupAdjacentImages`, `dedupGalleryThumbnails`, `stripPageChrome`, the avatar-min-px guard) that fixes class N sites is worth more than a single tagger that fixes one. Before reaching for a per-site tagger, ask: is the problem a *pattern* (gallery-looks-like-avatar, blur-up-preview-image triplet, carousel-main-plus-thumbnail-rail, sidebar-without-aside) or *truly* unique to one site? Generic fixes go in `capture.ts` outside `SITE_TAGGERS`. Per-site taggers exist for irreducibly bespoke layouts (Reddit's `shreddit-comment` slot model, YouTube's player widget). Example: `dedupGalleryThumbnails` (in `sanitiseTreeInPlace`) drops the redundant small-thumbnail rail of a Splide/Swiper/Slick carousel — the same photos rendered large-then-small once the carousel's slide-hiding CSS classes are stripped. It keys on images sharing BOTH a real alt AND a URL filename stem (unambiguously the same photo, never two comments' identical avatar), keeps the widest, and ignores DOM distance (the two tracks live in separate wrappers, so `dedupAdjacentImages`'s 6-level cap deliberately won't merge them). Guarded by the `htg-gallery` fixture (real How-to Geek main+thumbnail markup, 10 imgs → 5).
2. **Don't break previously-working sites.** Run the pixel-baseline fixture specs (`medium-fixture-visual`, `breitbart-fixture-visual`) after any change to shared CSS, sanitiser logic, or generic taggers. They live in `tests/e2e/*-fixture-visual.spec.ts-snapshots/` and fail on visual diff. Update baselines (`--update-snapshots`) only when the change is *intentionally* visual. Also re-run the live visual specs for any site you've previously optimized (table below) and human-eyeball the screenshot.
3. **Always visually verify after structural changes.** Type-check + unit tests catch syntax / behaviour bugs but miss "wrong selector picked the avatar-wrapping anchor instead of the channel-name anchor" and "element got dropped before postClone could see it." After any pipeline change, run the relevant `*-visual` Playwright spec and `Read` the rendered PNG before reporting done. See [memory: feedback_visually_verify_after_refactor].

### Optimized sites — visual reference points

The clip should approximate the **content** column of the source site (title, byline, hero, body, comments). Side rails, action toolbars, sponsored chrome, and engagement panels are dropped.

| Site | Tagger | postClone | Visual target | Test spec |
|---|---|---|---|---|
| **primal.net** | `tagPrimal` | — | Single note OR thread with avatar + author header + zaps + stats per post. Quote-notes render as bordered cards. | `primal-visual` (live), `primal-thread-fixture-visual` (fixture, **pixel baseline** — runs `tagPrimal` via `hostOverride`; fixture is a real snapshotted note with all avatars + video poster baked in as data URIs) |
| **bsky.app** | `tagBsky` | — | Profile feed or thread with 44px round avatar pin + name/handle row + body + reply/repost/like row per post. | `bsky-visual` (live), `bsky-thread-fixture-visual` (fixture, **pixel baseline** — runs `tagBsky` via `hostOverride`; fixture is a real snapshotted thread with all avatars baked in as data URIs via Node.js-side fetching to bypass CORS) |
| **facebook.com** (all shapes) | (Tier 0 `extractFacebookPost`; `tagFacebook` is the fallback) | — | Single posts (`/reel/`, `/photo/`, `/posts/`, `/watch/`, `/share/`) AND the home feed all build the same tweet-card-shaped card: avatar + author name + date, caption, the post's own video/photo(s), and a Like/Comment/Share count row. The feed first narrows to the one visible post card (`fbVisiblePostCard`), then builds from that card only. Same `.tweet-card` HTML/CSS as Twitter, plus a `--album` photo-grid variant. | `facebook-feed-fixture-visual`, `facebook-reel-fixture-visual`, `facebook-photo-fixture-visual` (fixtures, **pixel baselines** — exercise the real path via `hostOverride` + `pathOverride`; all images baked to data URIs because fbcdn URLs carry expiring signed tokens and 403 within days), `facebook-visual` (live, `FB_LIVE=1`, warm profile). Diagnose the card boundary with `tools/fb-card-probe.spec.ts` (`FBCARD=1`). |
| **goodreads.com** | `tagGoodreads` / `tagGoodreadsList` | — | Book hero (cover + title + author + 5-star rating + genres pills + "About the author" card). List pages render as a 2-col grid. | `goodreads-visual` (live), `goodreads-book-fixture-visual` (fixture, **pixel baseline** — runs `tagGoodreads` via `hostOverride`) |
| **twitter.com / x.com** | (Tier 0 `extractTweet`) | — | Single tweet card with avatar + author + body + photos/video poster + footer (date/views/stats). Embedded tweets on news pages also use this. | `twitter-clip-modes` (live), `embedded-tweet-visual` (live), `twitter-thread-fixture-visual` + `tweet-with-show-more-fixture-visual` (fixtures, **pixel baselines** — generic pipeline only, legacy-shape markup), `x-status-newshape-fixture-visual` (fixture, **pixel baseline** — real Tier 0 path via `hostOverride: 'x.com'`, redesigned/newer DOM shape, `article.test.ts` corpus also covers it in Vitest) |
| **medium.com** | (generic byline) | — | Title + author avatar header + "N min read · date" meta + body. Engagement glyph rows preserved. | `medium-fixture-visual` (fixture, **pixel baseline**), `medium-visual` (live, behind Cloudflare) |
| **breitbart.com** | (generic byline + chrome strip) | — | Title + byline + hero image + body + embedded tweets rendered as tweet-cards (wrapper-iframe pattern). | `breitbart-fixture-visual` (fixture, **pixel baseline**), `breitbart-visual` (live), `article-with-embedded-tweet-fixture-visual` (fixture, **pixel baseline** — blockquote-fallback embed path) |
| **zerohedge.com** | (generic byline + engagement-row tagger) | — | Title + byline + body + right-aligned footer engagement counters. Embedded tweet iframes harvested into tweet-cards. | `embedded-tweet-visual` (live) |
| **stansberryresearch.com** | (generic, with shadow DOM piercing) | — | Author block (avatar + name) + article body, captured across declarative open shadow roots. | covered by `shadow-dom.test.ts` unit tests |
| **wikipedia.org** | (generic + `stripPageChrome`) | — | Article title + `<p>` body + infobox table + section headings. TOC sidebar and references-box pruned via `stripPageChrome`. | `wikipedia-visual` (live), `wikipedia-fixture-visual` (fixture, **pixel baseline**) |
| **bbc.com/news** | (Tier 1 `<article>`) | — | Title + byline + date + hero image + body paragraphs. No tagger needed; `<article>` semantics suffice. | `bbc-visual` (live), `news-article-fixture-visual` (fixture, **pixel baseline** — generic `<article>` Tier 1 path) |
| **reddit.com** | `tagReddit` | `postCloneReddit` | Subreddit avatar (round, left) + 2-row column right of it (subreddit · time on row 1, author on row 2) + title + post body or image + comments with avatar / dx-byline / action row each. Sidebar rails, "Back" button, ads dropped. | `reddit-visual` (live), `reddit-thread-fixture-visual` (fixture, **pixel baseline** — runs `tagReddit` + `postCloneReddit` via `hostOverride`) |
| **youtube.com** | `tagYoutube` | `postCloneYoutube` | Channel avatar (round, left) + 2-row column right of it (channel name on row 1, "N subscribers" on row 2) + poster image (from `i.ytimg.com/.../hqdefault.jpg` or live `<video poster>`) + title + views/date + description + comments. Up-Next sidebar, action strip, chapter shelves dropped. View-count/date rebuilt into a single clean `dx-stats` "N views · date" row — the live `<yt-animated-rolling-number>` odometer's per-digit positioned spans would otherwise collapse to one-digit-per-line after sanitisation; the count is read from an aria-label and any long consecutive digit-run (the odometer strips render ALL of 0-9 per column) is rejected as garbage. The like/dislike/subscribe/share/download SVG widgets, `lottie-component` animations, `ytd-ticket-shelf-renderer` (Event Tickets/Bandsintown) and other structured-description cards are excluded (they render as oversized ℹ/↗ glyphs on live pages — invisible in the static `youtube-watch.html` snapshot, so the compact `youtube-viewcount` fixture guards them). | `youtube-visual` (live), `youtube-watch-fixture-visual` (fixture, **pixel baseline** — `tagYoutube` + `postCloneYoutube` via `hostOverride`; dynamic view/like widgets are empty in that static snapshot), `youtube-viewcount-fixture-visual` (fixture, **pixel baseline** — a compact fixture with a POPULATED odometer, guards the view-count rebuild + glyph exclusion) |
| **stackoverflow.com** | `tagStackOverflow` | — | Question + each answer as separate dx-post, code blocks preserved, user-info cards as dx-byline, post-menu as dx-stats. Cloudflare-walled — use the `test` persistent profile. | `stackoverflow-visual` (live, persistent profile), `stackoverflow-question-fixture-visual` (fixture, **pixel baseline** — runs `tagStackOverflow` via `hostOverride`; fixture is hand-crafted because real SO snapshots hit a Cloudflare hard-deny) |
| **apnews.com** (generic) | (none — comment-widget-aware Tier 1 + layout finder) | — | Story headline + byline + hero + body paragraphs; the Viafoura reader-comments thread is dropped (or rides below), never replaces the story. AP pages have no real `<article>` — only `<main class="Page-main">` — but Viafoura renders each comment as `<article class="vf3-comment">`, so with `smartArticleDetection:false` (the sweep default) **`findArticleElement`'s first `article` match was a comment**. Fixed generically at THREE layers, all keyed off `COMMENT_WIDGET_SELECTOR` (Viafoura/Disqus/Coral/OpenWeb/FB/Hyvor/Commento): `findArticleElement` skips comment-widget `<article>`s (→ falls through to `<main>`), `scoreContentBlock` won't pick a comment block, and `markExcluded` drops the widget from a whole-`<main>` capture. **Must be verified LIVE** (offline fixtures + a layout-finder-only fix falsely pass — see [memory: project_comment_widget_layout_finder_fix]). | `comment-widget.test.ts` (both `smartArticleDetection` modes) + `apnews-article` sidecar in `article.test.ts`; live via the corpus sweep (`SWEEP_ONLY=apnews` → `test-output/corpus-sweep-run/apnews--2-clip.png`) |
| **Hacker News** (`ycombinator.com`) | `tagHackerNews` | — | Post header (title link + `dx-stats` "N points · author · N comments" meta row) + threaded comments, each a `dx-post`/`dx-reply` card with a `dx-byline` (author + date) + body prose. Nested replies indented by `td.ind[indent]` depth. Vote arrows, `[–]` collapse toggles, per-comment nav links (parent/next/prev/root), orange masthead, and the reply form dropped. HN is nested `<table>` soup with no `<article>` — a tagger, not the generic path. | `hackernews-thread-fixture-visual` (fixture, **pixel baseline** — runs `tagHackerNews` via `hostOverride`; real snapshotted item page). Note: the older `hn-thread-fixture-visual` uses an idealized `<article>`-based fixture (generic Tier-1 path) and is kept as a shared-CSS guard. |
| **phpBB forums** (any host) | `tagPhpBB` | `postClonePhpBB` | Each post a `dx-post`: one-line `dx-byline` (author · rank — Posts · Joined) + body prose + inline images. Per-post `div.signature` blocks and repeated "Re: &lt;topic&gt;" headings dropped. **Engine tagger, not a site tagger** — matches on stock phpBB MARKUP (`#page-body dl.postprofile`) instead of a hostname, so it covers every phpBB forum at once; registered LAST in `SITE_TAGGERS` so host-specific entries win. | `phpbb-thread-fixture-visual` (fixture, **pixel baseline**; no `hostOverride` needed — the markup match fires on its own) |
| **bitcointalk.org** (SMF forum) | `tagBitcointalk` | `postCloneBitcointalk` | Each post a `dx-post`: one-line `dx-byline` (author · rank — Activity · Merit) + subject + date + body prose. Per-post signature ad blocks, rank-star/online/IP gifs, "#N" permalink chrome and repeated "Re: <topic>" subject lines dropped. | `bitcointalk-thread-fixture-visual` (fixture, **pixel baseline** — runs the tagger via `hostOverride`) |
| **Substack** (generic) | (none — `<article>` Tier 1) | — | Title + body + thumbnail. | `substack-essay-fixture-visual` (fixture, **pixel baseline**) |
| **GitHub README** (generic) | (none — `<article>` Tier 1) | — | Title + headings + code blocks. | `github-readme-fixture-visual` (fixture, **pixel baseline**) |
| **Generic blog post** | (Readability) | — | Title + body paragraphs (fallback path). | `blog-post-fixture-visual` (fixture, **pixel baseline**) |

When adding a new site, **add a row here** and a visual spec under `tests/e2e/{site}-visual.spec.ts`. For sites that have a deterministic fixture (a saved HTML file under `tests/fixtures/sites/`), also add a `{site}-fixture-visual.spec.ts` with a `toHaveScreenshot()` pixel baseline — those guard against shared-CSS / generic-tagger regressions for free.

**Activating site taggers under fixtures** — site taggers gate on `window.location.hostname`, which means they don't fire on 127.0.0.1-served fixtures by default. The test build exposes `__setTestHostOverride(host)` in `capture.ts` (tree-shaken in production via `__DISCERNED_DEV_BUILD__`), and the dev test bridge in `content.ts` reads `opts.hostOverride` from `__DISCERNED_TEST_CAPTURE` messages and feeds it through. Fixture specs pass `hostOverride: 'www.reddit.com'` (etc.) to `runFixtureVisual()` to exercise the real tagger + `postClone` logic against the saved snapshot. See `reddit-thread-fixture-visual.spec.ts`, `youtube-watch-fixture-visual.spec.ts`, `goodreads-book-fixture-visual.spec.ts`, `stackoverflow-question-fixture-visual.spec.ts` for the pattern. Tier 0 (Twitter/X) is the one non-`SITE_TAGGERS` consumer of this override: `isTweetHost()` also honours `testHostOverride`, since Tier 0 gates on the full page URL rather than hostname alone — `hostOverride: 'x.com'` makes a 127.0.0.1-served fixture exercise the real `extractTweet()` path. See `x-status-newshape-fixture-visual.spec.ts`.

**Refreshing real-page snapshots** — Several one-shot snapshot tools exist under `tests/e2e/tools/`:

- `snapshot-fixtures.spec.ts` (`SNAP=1`) — Launches Brave with the `test` persistent profile + anti-detection flags, navigates to reddit/youtube/goodreads/stackoverflow, waits for site-specific render anchors (`shreddit-post`, `ytd-watch-flexy`, etc.), and saves the fully-rendered HTML to `tests/fixtures/sites/`. Re-run when a site redesign breaks the saved selectors. **Cloudflare hard-denies** cannot be worked around — for SO the fixture is hand-crafted instead.
- `snapshot-primal-note.spec.ts` (`PRIMAL_NOTE=1 PWDEBUG_HEADED=1`) — Loads a specific primal.net note in headed Brave. Inlines all `<img>` bytes as data URIs (via in-page `fetch` with `credentials: 'omit'`; large images/GIFs are downscaled to 256 px via `OffscreenCanvas`), bakes `<video>` poster frames (fetches video bytes → blob URL → untainted canvas), strips scripts/external links, and writes to `tests/fixtures/sites/primal-thread.html`.
- `snapshot-bsky-post.spec.ts` (`BSKY_POST=1 PWDEBUG_HEADED=1`) — Same shape for a Bluesky thread. `cdn.bsky.app` blocks CORS from the page context, so images are fetched on the **Node.js side** via `page.request.fetch()` (uses the browser's cookies/headers, no CORS enforcement), then injected back as data URIs via `page.evaluate()`. Writes to `tests/fixtures/sites/bsky-thread.html`.

After regenerating baselines, run `python tests/e2e/tools/refresh-gallery.py` (requires Pillow: `pip install pillow`) to rebuild `test-output/baselines-gallery/` — it copies every committed baseline and crops the top 1200 px of each `*-fixture-rendered.png` for a quick side-by-side gallery in File Explorer.

### Tagger canary / repair loop

Site taggers depend on live-DOM selectors that a site can redesign away with no warning — capture then silently degrades to the generic pipeline (worse-looking clip, no crash). Two mechanisms catch this early and one recipe repairs it.

**Selector-anchor manifest (`anchors`)** — each `SITE_TAGGERS` entry declares the load-bearing selectors it depends on (post container, avatar/name hooks). `checkTaggerAnchors(host, root)` (exported from `capture.ts`) runs them against a page and returns per-selector match counts + the `dead` (zero-match) list + `allDead`. Keep `anchors` to selectors that anchor the tagger's *core* output, not every incidental exclusion.

**Graceful degradation (runtime, Phase 3.4)** — `applySiteTagger()` runs `checkTaggerAnchors` *before* the tagger; if `allDead` it skips the tagger entirely and falls back to the generic layout-finder/Readability path, logging the dead selectors at WARN (partial death logs a warning but still runs the tagger). A post-capture `selfCheckCapture()` in `captureContext()` additionally WARNs when a tagger-active clip carries zero `dx-*` markers or its body text is <5% of the page text — a mis-scoped or empty capture surfaces in the console instead of shipping silently.

**Weekly canary (Phase 3.1)** — `tests/e2e/tagger-canary.spec.ts` (`CANARY=1`, `--project=tagger-canary`) visits each tagger's live target (`tests/e2e/helpers/taggerCanaryTargets.ts`) and runs its anchor manifest against the live DOM via the `__DISCERNED_TEST_ANCHORS` bridge (tree-shaken in production). A dead anchor **fails the run and names the exact selector**; a page that won't load (Cloudflare, network) is a SKIP, not a fail, so the canary never flakes on infra. Report → `test-output/tagger-canary.txt`.

**Page shapes: group the manifest, split the target.** A tagger's manifest must hold for *every* page shape the site serves, so mutually-exclusive variants belong in ONE comma-grouped anchor — primal's `_primaryNote_` (thread main note) does not exist on a profile feed, and requiring both separately made the canary FAIL every week on a live, healthy site. But grouping alone creates a blind spot: a rename of one variant still matches via the other. So a site with distinct shapes gets **one canary target per shape**, and the shape-specific selector goes in that target's `extraAnchors` (counted in-page, failing exactly like a manifest anchor). primal therefore has two targets — `primal` (profile feed, the reliable signal) and `primal:thread` (nevent URL, pins `_primaryNote_`; may SKIP if the relay fetch stalls). Use `label` to keep the report readable when a tagger has several targets. Note `extraAnchors` uses plain `querySelectorAll` — it does **not** pierce shadow roots; route a shadow-DOM site's extras through the `__DISCERNED_TEST_ANCHORS` bridge instead.
  - **Local (full coverage):** `pwsh -File scripts/tagger-canary-local.ps1` runs it against the warm branded-Chrome `test` profile (hand-installed extension + valid `cf_clearance`) — the only setup that gets Reddit/YouTube/StackOverflow to load. Register as a weekly Windows Scheduled Task (see the script header). This is the authoritative weekly run for the walled sites.
  - **CI (open sites only):** `.github/workflows/tagger-canary.yml` runs Mondays 08:00 UTC on a GitHub runner. It covers the sites that load headless-unauthenticated (primal, bsky, goodreads) and SKIPs the walled ones — a free early-warning for the open sites.

**Repair loop when the canary (or a live-visual spec) fails naming a dead selector:**
1. `CANARY=1 … --project=tagger-canary` (or the local script) → read `test-output/tagger-canary.txt` for the exact dead selector(s).
2. `SNAP=1` re-snapshot the site (`tools/snapshot-fixtures.spec.ts`) → fresh `tests/fixtures/sites/<site>.html`. (Primal/bsky use their dedicated snapshot tools; SO's fixture is hand-crafted — Cloudflare hard-deny.)
3. Fix the tagger + its `anchors` list against the new snapshot; iterate offline with the `<site>-fixture-visual` spec (runs the tagger via `hostOverride`).
4. `--update-snapshots` on the fixture-visual pixel baseline once the render looks right (only when the change is *intentionally* visual).
5. `python tests/e2e/tools/refresh-gallery.py` to rebuild the baseline gallery; commit the tagger fix + new snapshot + baseline together.

### Per-site taggers + `dx-*` markers

`SITE_TAGGERS` is a registry of `{ match: (host) => bool, tag: (root) => void, postClone?: (clone) => void, anchors: string[] }`. Each tagger walks the **live** DOM with selectors stable for that site (data attributes or class-name *prefixes* like `[class*="_primaryNote_"]`, since SPA class hashes change between builds) and stamps `dx-*` classes. The `anchors` array is the tagger's selector manifest — see "Tagger canary / repair loop" above.

| Marker | Meaning |
|---|---|
| `dx-post` | the primary captured post |
| `dx-reply` | a reply in a thread |
| `dx-reply-row` | a reply's avatar + (name/body) split (flex row) |
| `dx-header` | avatar + name row |
| `dx-author` | inline username + verification + handle + time |
| `dx-byline` | avatar-LESS byline strip (news sites): `<address>` or author-link `<a>` + `<time>` + short text |
| `dx-byline-meta` | meta strip like "25 min read · May 26, 2026"; tagger MOVES it into dx-header's name column |
| `dx-quote` | a quoted/embedded note card (bordered) |
| `dx-quote-frag` | one `<a>` fragment of a quote (sites split a quote across sibling `<a>`s) |
| `dx-zaps-row` | horizontal zappers row |
| `dx-stats` | reply/like/repost icon row |
| `dx-stats--end` | right-aligned stats variant for footer engagement counters (footerStat-class siblings) |
| `dx-avatar` | round 44px pin on a small image (subreddit icon, channel avatar, comment avatar). CSS clips to circle. |
| `dx-byline-col` | column holding two stacked byline rows (subreddit/channel on top, author/subscribers below). Built by `postClone` on Reddit / YouTube. |
| `dx-byline-row` | one row inside a `dx-byline-col`. Variants `--sub` (bold, primary) and `--author` (muted, secondary). |
| `dx-excl` | element to remove during capture. Promoted to `EXCL_MARKER` by the pipeline, dropped by `removeMarked` before sanitisation. |

The matching layout CSS lives in `discerned-web/app/globals.css` under `.clip-body .dx-*`. **To add a site**: copy `tagPrimal`, swap the selectors, register it in `SITE_TAGGERS`. No web-app change needed unless the site has a new layout quirk.

**Engine taggers (match on markup, not hostname).** Most entries match a hostname. A forum/CMS *engine* that ships stock, unhashed classes across thousands of independent deployments can't be covered that way — `tagPhpBB` therefore ignores the `host` argument and sniffs the live DOM (`#page-body dl.postprofile`). Rules for this kind of entry:
- **Register it LAST** in `SITE_TAGGERS` so any host-specific tagger claims its page first.
- Keep the probe selector **tight** — it runs on every capture on every site, and a loose one silently hijacks unrelated pages. Verify by running the whole fixture-visual baseline set, which is what catches a hijack.
- It can't be activated by `hostOverride`, so its Vitest sidecar must stay generic-path-only; the `dx-*` assertions live in its Playwright fixture-visual spec (which needs no override — the markup match fires by itself).

A tagger may optionally **return a capture root** (`Element | void`). When it does, `extractArticle` captures that subtree instead of running the generic article/layout finders — use this to scope the clip to the content column and exclude page chrome (sidebars, search, banners). Returning nothing leaves root selection to the pipeline (still stamping markers).

`tagPrimal` (primal.net) is the reference implementation. `tagBsky` (bsky.app) is a second example: it tags each `[data-testid^="feedItem-by-"]` post (`dx-post` + `dx-header` + `dx-stats`) and returns the `profileScreen` column as the capture root. Bluesky positions content with inline `transform`/`position`/`aspect-ratio` that survive sanitisation (only `<img>` styles get scrubbed); `globals.css` neutralises those inside `.clip-body` so the dx-* layout takes over.

#### Live tagger MUST be non-destructive — use `postClone` for mutations

The tagger function runs on `document` (the **live** page). It should only **read** structure and **stamp classes** — never call `replaceWith()`, `remove()`, `insertBefore()`, or otherwise reparent nodes on the live DOM. Doing so leaks into the user's actual session: YouTube's player will stop responding to navigation, Reddit's SPA loses sync with framework state, Goodreads's lazy-loaded sections may not render.

For any destructive change (rebuilding the byline column, swapping `#player` for a `<figure>` poster, hoisting an avatar out of a soon-to-be-excluded `<a>` wrapper), register a `postClone(clone: Element)` callback in `SITE_TAGGERS`. It runs on the **detached clone** that `extractArticle` builds, before `removeMarked`/sanitisation — so it can lift content out of `dx-excl`'d wrappers before they're pruned. See `postCloneReddit` and `postCloneYoutube` for the pattern.

Order matters: `extractArticle` does `deepCloneWithShadow → siteTaggerPostClone → removeMarked → sanitiseTreeInPlace → inlineAllImages`. Anything you want to use that's normally dropped (e.g. an avatar inside a dx-excl'd anchor) needs to be hoisted out *during* `postClone`, before `removeMarked` runs.

**When a tagger RETURNS a root, exclusion works differently — and `postClone` must delete, not mark.** For a tagger-scoped root the pipeline first *clears every `EXCL_MARKER` inside it* (the tagger authoritatively said "this subtree is content", so a sticky/fixed descendant isn't chrome), then re-promotes only surviving **`dx-excl` classes**. Two consequences that cost a debugging round on bitcointalk:

- Setting `EXCL_MARKER` yourself inside `postClone` is not reliable if the surrounding pass re-parents the node — the marker rides on the element, but any *unwrapping* you do in the same hook can lift marked content out of the subtree `removeMarked` deletes.
- So when `postClone` restructures the tree (unwrapping layout tables, rebuilding a byline), **remove unwanted subtrees outright** (`el.remove()`) rather than marking them, and do it *before* the restructuring. `postCloneBitcointalk` deletes `div.signature` first for exactly this reason: SMF nests layout tables inside the signature, and unwrapping them re-parented the ad-banner markup back out of the doomed subtree.

**The site tagger runs for ALL three article-like formats** — `article`, `selection`, AND `full-page`. The shared helper `applyTaggerToClone(cloneOrFragment)` is called from each of those extractors: it promotes `dx-excl` classes to `EXCL_MARKER` on the clone, runs the site-tagger's `postClone` hook (if any), then calls `removeMarked` to drop excluded subtrees. Selection and full-page also share `tagSemanticStructure` and `dedupAdjacentImages` (for the dx-byline / chrome-link / triple-image patterns). When you write or fix a site tagger, expect it to apply to all three formats — write selectors that locate semantic landmarks (`shreddit-post`, `ytd-video-owner-renderer`) rather than ones that assume the user captured the whole page.

When defining `postClone` for a site, ALSO keep important elements off the `dx-excl` list inside the live tagger — otherwise they're dropped from the clone before `postClone` can transform them. Example: `tagYoutube` skips `#player`, `#player-container`, `ytd-player` in its `excludeNonKept` pass so `postCloneYoutube` can swap the player for the poster figure.

### Generic byline + chrome detection

`tagSemanticStructure()` has several **generic** passes that handle news + blog sites without needing per-site code. Most modern news sites and WordPress blog layouts work out of the box.

- **Chrome-link removal** — drops empty `<a>` elements pointing at `google.com/preferences`, `facebook.com/share`, `x.com/share`, `mailto:?`, `whatsapp:`, etc. Removes the gray-oval "Make this site a preferred Google source" buttons and bare share icons that survived sanitisation.
- **Audio widget removal** — drops `[data-mp3u]`, `input[type="range"]`, and walks up to `[class*="amplitude" i]` / `[id*="Polly" i]` wrappers. Removes Polly TTS / Amplitude.js article-narration scrubbers.
- **`dx-byline`** — avatar-less byline detection: an element with `<address>` OR author-link `<a>` + `<time>` + short total text (< 200 chars), no img descendants. Walks elements in reverse so the deepest (tightest) match wins. CSS lays it out as a single muted flex row.
- **`dx-byline-meta`** — meta strip matching `\d+ min read` or month-name+day pattern, found in dx-header's next-sibling subtree. The tagger MOVES it into dx-header's name column so it shares row with the author name. Skipped inside `.tweet-card` so tweet-card footers aren't repurposed as byline meta.
- **`dx-stats--end`** — right-aligned variant for footer engagement counters: 2+ siblings whose class names match `/footerStat\|engagement[A-Z_]\|node[-_]?stat/i`.
- **dx-class preservation on unwrap** — `sanitiseElement` promotes non-allowed tags (`<footer>`, `<header>`, `<address>`, etc.) to `<div>` when they carry trusted `dx-*` / `tweet-*` classes, instead of unwrapping them. Without this, stamping `dx-stats` on a `<footer>` would lose the class when sanitisation deleted the `<footer>`.

Container heuristic relaxed: `looksLikeContainer()` no longer rejects an `<article>` element just because it contains a direct `<header>` or `<footer>` child — news sites legitimately use that semantic pattern.

#### Generic passes inside `sanitiseTreeInPlace` (all capture paths)

Three passes run on the sanitised **clone** so every path (site-tagger or generic; article/selection/full-page) inherits them. Guarded by `tests/fixtures/sites/chrome-patterns.html` + `chrome-patterns.test.ts`.

- **`removeGenericChrome()`** — text-identified page chrome the `<nav>`/`<aside>` landmark stripper can't see (div-soup modules news sites render inline with the article):
  - Skip-links (`^skip to` / `^jump to` with empty/`#` href).
  - Exact-text chrome verbs on `<a>`/`<button>` (`CHROME_LINK_TEXT_RE`): share/save/follow/report/copy-link/show-comments/improve-this-question/add-as-preferred/add-us-on-google/open-comment-sort. Matched against the element's ENTIRE trimmed text, so a prose link merely *containing* the word survives. "Show more" is deliberately excluded (tweet cards use it).
  - Related-content / recirculation boxes: **strong** headings (`STRONG_RELATED_RE`: "Discover more", "Want to know more?", "You might also like", "Up next", …) remove their prose-free enclosing container structurally; **weak** headings (`RELATED_HEADING_RE`) additionally require the container to be link-dominant (≥60% link text). Both bail if the container holds a ≥200-char `<p>` (real prose).
  - Newsletter signup blocks (`NEWSLETTER_RE`) and "preferred source" promo strips (`PREFERRED_SOURCE_RE`).
  - Interactive ARIA chrome: `select`, `[role=menu|menubar|listbox|tablist]`.
  - Image-viewer lightbox hint captions ("Press enter or click to view image…").
  - **dx-stats dedup**: identical `.dx-stats` text keeps only its first occurrence (Medium renders the same clap/comment counts 3×: sticky bar + inline + footer).
  - HTML comments are stripped during the sanitise walk.
  - Skips `.tweet-card` subtrees throughout.
- **`applyFlexSeparation()`** — inserts a space text node between the element children of every container the LIVE page laid out with flex/grid (or whose span/a children compute to block/inline-block). Marked on the live DOM by `annotateLiveImageSizes` (`FLEXSEP_MARKER`), applied on the clone before class stripping. Fixes run-together text: "399M views21 years ago", "Imran Rahman-JonesTechnology reporter".
- **sr-only exclusion** — `markExcluded` now also flags absolutely-positioned 1px-clip / `clip-path:inset` screen-reader-only elements. Fixes Stack Overflow's "2222 gold badges" (visible "22" + hidden "22 gold badges" gluing together).

### Facebook single-post capture (`extractFacebookPost`) — a second Tier 0

A single Facebook post URL (`/reel/`, `/photo/`, `/posts/`, `/watch/`, `/share/`) is handled by `extractFacebookPost()` — a **second Tier-0-style extractor**, gated by `isFacebookPostUrl()` right after the Twitter check in `extractArticle`. Like `extractTweet`, it **builds** a `tweet-card`-shaped HTML string from chosen elements rather than tagging the live div soup, and returns `null` (falling through to `tagFacebook` + the generic pipeline) when an essential field is missing.

This exists because `tagFacebook`'s permalink branch (still used by the home feed and as the fallback) had a structural defect specific to *tagger-returned roots*: Tier 1.5 clears every `EXCL_MARKER` inside a tagger root (a tagger may legitimately pin a fixed-position lightbox), so only `dx-excl` **classes** survive as exclusion — and Facebook's hidden preloaded carousel/next-item `<img>`s, normally killed by `markExcluded`, all rendered at full natural size. A permalink capture came out as a long thumbnail stack instead of one scoped card. Building the card from a short, explicit list of chosen elements sidesteps this entirely — nothing gets in that wasn't deliberately picked.

Field extraction, and the gotchas each one cost a debugging round to find:

- **Author name** — `fbBylineAnchors()` (shared with `tagFacebook`), sorted by `top` and filtered to exclude short comment cards. `fbIsProfileHref()` must match BOTH absolute (`https://www.facebook.com/name`) and site-relative (`/profile.php?id=N&sk=reels_tab...`) hrefs — reels use the relative form. A small fixed set of nav-chrome slugs (`reel`, `watch`, `marketplace`, …) is excluded from matching as a profile href, because a bare `/reel/` (the Reels tab link) is shape-indistinguishable from a real username vanity URL and, being near the top of the page, wins the "topmost" sort over the real author.
- **Avatar** — `fbFindAvatarSrc()`. Facebook renders the avatar in TWO shapes depending on page: a plain `<img>`, or (measured on a photo permalink) an inline `<svg><image xlink:href>` circle-masked avatar. Critically, the avatar is often a **sibling** anchor of the author-name anchor (both wrap the same profile href, one holds the avatar, the other the visible name) — not a descendant of it — so the lookup searches by shared href first, then falls back to a bounded ancestor climb for shapes (the feed) where the avatar does nest inside a common wrapper.
- **Caption** — prefers `FB_MSG_SEL` (the feed/permalink `story_message` marker), but reels/Watch carry **zero** `story_message` matches. The fallback there is the longest `[dir="auto"]` text block — but ONLY when a `<video>` is present: the same fallback on a photo/text permalink (also `story_message`-less) picks up Facebook's own anti-scraping obfuscation string instead, a per-character `<span style="display:flex">` scramble block that is reliably *longer* than any real caption, so it must be excluded by shape (`isObfuscationBlock`), not merely deprioritised. When even that fallback finds nothing (a photo permalink's caption can be absent from the visible DOM entirely), the last resort is the page's own `og:description`/`description` meta tag, guarded against Facebook's generic boilerplate ("See posts, photos and more on Facebook.").
- **Video poster** — `fbResolvePoster()`, in order: the live `<video poster>` attribute (present on some reels), then the largest `fbcdn`/`scontent` `<img>` inside the player subtree, then `og:image`. A reel is typically an MSE/`blob:` video with no `poster`, and the generic `captureVideoFrames` canvas-grab fails on it (cross-origin `SecurityError`, and the background fetch fallback requires an `https:` src which `blob:https://…` fails) — so this three-step fallback is what actually produces an image instead of the video silently vanishing.
- **Photos** — content images inside the post's own scope (nearest `[role="article"|"dialog"|"main"]`), bounded to on-screen images ≥150×150px — small enough to exclude the avatar, large enough to exclude preloaded thumbnail-rail images.
- **Date** — prefers a real `<time>` element, else the post's own permalink anchor's text. Must exclude hashtag/search links (`/reel/hashtag/?q=%23viral`) and comment permalinks (`?comment_id=…`) — both can share the same `/reel/` or `/posts/` path prefix as the post's own date link and, appearing earlier in the DOM, would otherwise steal the date slot with a hashtag or a comment's timestamp instead of the post's own date (or worse, no date at all when none was truly available — an honest absence beats a wrong element's text).
- **Stats** — reaction/comment/share **counts** only, never the icon glyphs (a CSS sprite sheet that renders as a column of emoji once page CSS is gone — the same reason `tagFacebook`'s feed branch drops the whole toolbar). Reels/Watch render these as plain `[role="button"][aria-label="Like"|"Comment"|"Share"]` divs with **no** `role="toolbar"` anywhere, and each count sits in a structurally distant sibling subtree, not a close descendant of the button — so lookup climbs a bounded number of ancestor levels from each button (mirroring the avatar lookup's idiom) to find the nearest numeric-text span.

**The feed builds from ONE card, not the document.** `extractFacebookPost` takes an optional `root`: `document` for a permalink (one post per page), or a single post card for the feed. `fbVisiblePostCard()` picks that card using the same dedupe + card-climb + viewport-dominance rule `tagFacebook` uses, kept as its own function so the two can't drift on what "the post" means. Scoping matters for more than tidiness — a document-wide lookup on the feed pulled a neighbouring post's photos and its byline into the card.

**Four feed-specific defects, each with a non-obvious cause:**

- **Duplicate byline / wrong author.** A TAGGED post renders "Evelyn Bueno was tagged" above the card AND "Diana Hulce is with Evelyn Bueno and 7 others" inside it. Both names are byline-shaped anchors, both sit on the same line, and the tagged person appears FIRST in document order — so neither topmost-wins nor document order picks the poster (measured: the two differ by shared-ancestor depth 5 vs 17, which is not a rule worth trusting either). Facebook marks the poster's own block with `[data-ad-rendering-role="profile_name"]`, an ad-tooling attribute it also applies to ordinary posts; that beats every heuristic and is what the builder uses.
- **Obfuscation garbage in the caption.** Facebook interleaves an anti-scraping run of per-character `<span style="display:flex">` elements ("r|e|d|S|o|t|s|n|p|o…") INSIDE the caption block, not only as a separate sibling. `fbCleanCaption` removes runs whose children are ≥70% single characters, on a CLONE so the live page is untouched.
- **"See more" truncation.** A collapsed caption ships as prose + an expander, and Facebook truncates mid-WORD ("…intense week with Colombia earthq… See more"). Dropping just the anchor leaves a broken fragment, so the partial word goes too and a real ellipsis closes the sentence. The full text is genuinely unavailable on the feed — Facebook ships only the truncated copy until "See more" is clicked, and feed pages carry no `og:description` to fall back on.
- **A giant circular emoji.** The site tagger runs before the builder and stamps `dx-avatar` on live nodes; an inline flag emoji inside the caption inherited it and the clip CSS pinned it to a round 44px avatar. `fbCleanCaption` strips all `dx-*` classes from the caption clone.

**Black letterbox bars around album photos.** Facebook serves an album photo on a padded canvas — measured: a 443x590 JPEG whose rows 0-130 and 500-590 are *pure black pixels* — and crops it in-page with an `overflow: hidden` wrapper sized to the visible region. Sanitisation strips that wrapper, exposing bars that are real image data, not styling. `cropLetterbox()` detects uniform dark rows and re-encodes the content band; it requires the bars to exceed 6% of the frame so an ordinary night photo is never trimmed. Note this was NOT a CSS problem: three plausible CSS fixes (the grid's 16:9 `aspect-ratio`, `align-items`, and the generic `.clip-body img { max-height: 420px !important }` override) were each tried and each left the bars untouched, because the pixels were black all along.

**Selecting the right photos.** Match on SIZE, never on the src host: a post photo is an fbcdn URL live, a `data:` URI in a baked fixture, and a blob/CDN variant elsewhere, so an `img[src*="fbcdn"]` filter found nothing off the live site. Reject the blur-up placeholder by INTRINSIC size (Facebook stacks a 90x160 low-res copy under the real photo and CSS-scales it, so rendered size is identical for both), and reject `static.xx.fbcdn.net`, which serves Facebook's own UI chrome at avatar dimensions. A zero-area `<video>` placeholder must also be ignored, or a photo post renders as a bare "▶ Video" link card.

**Fixture snapshots need a NODE-side fetch.** facebook.com → fbcdn.net is cross-origin with no CORS header, so an in-page `fetch` dies with "TypeError: Failed to fetch" and the fixture saves with 4x3 lazy-load stubs (measured: 1 of 39 images inlined, and the committed fixture had 26 identical 4x3 stubs — which is why no baseline ever showed the image defects). `page.request.fetch()` reuses the browser's cookies but is not subject to CORS: 35/35. Same approach, same reason, as `snapshot-bsky-post.spec.ts`.

**Shared posts.** A share nests the ORIGINAL inside the sharer's card, and the reliable signal is the screen-reader label `Shared post from <name>` — not the message markers. Four things measured on a real share (`tests/fixtures/sites/facebook-share.html`), each of which produced a visible defect on its own:

- **The sharer usually adds NO comment.** Then the only `story_message` on the card belongs to the ORIGINAL, so treating "the outermost message" as the sharer's comment built the whole card out of the shared content — the sharer's name and avatar replaced by the original poster's, which is exactly the "it looks like the post they shared" report. `sharerMsg` is allowed to be null, and once a share is identified it is authoritative: the plain first-match `msgAnchor` must NOT be used as a fallback, or the shared text renders twice (once as the caption, once in the quote card).
- **The shared card is the label's next SIBLING subtree**, not the block around the following `profile_name` — that resolves to a bare name wrapper (measured: `textLen` 17 vs 1543), which contains neither the shared message nor its photos, so the quote card came out empty.
- **Document order does not separate the two posts.** The shared card's like/comment/share buttons precede the sharer's (measured at offsets 550948 vs 653885), so a plain `querySelector` reported the ORIGINAL's engagement as the sharer's. Stats skip anything inside `sharedCard`.
- **Ownership is CONTAINMENT, never document position.** "Any photo after the label" also swept in the page's sidebar ads, because everything later in the document trivially follows the label.

Because a share legitimately has no `msgEl`, the photo scope must not fall back to `document.body` — that pulled the sidebar's promo images onto the card. It falls through `msgEl` → `authorLink` → `sharedCard` → body.

**Group posts.** Every byline link in a group is group-scoped (`/groups/<id>/user/<id>/`, `/groups/<id>/`), matching neither the vanity-slug nor the `/profile.php` pattern, so `fbBylineAnchors` returned ZERO, the card climb never terminated, and capture degraded to the bare message block — text only, no avatar, no photos, no reactions. One rejected URL shape cost all four. `fbIsProfileHref` also accepts legacy `/pages/<Name>/<id>`. In a group the `profile_name` block holds the GROUP while the posting member sits in a sibling block, so the byline renders "&lt;group&gt; · &lt;member&gt;".

**The builder needs real layout.** It picks the visible post and separates content photos from placeholders by measured geometry, so under jsdom (all rects 0x0) every filter collapses and it emits a near-empty card. `extractArticle` gates it on `hasLayout`; jsdom therefore exercises the tagger + generic path, and the built-card structure is covered by the Playwright fixture specs instead. `fbVisiblePostCard` also falls back to the topmost card when nothing is on screen — `pickVisibleFeedPost` requires a non-zero viewport intersection, and a page whose posts sit below the fold otherwise dropped the whole builder path silently.

**Test-only path override.** `isFacebookPostUrl` needs to branch on URL *path shape* (reel vs photo vs feed), which a fixture served from `127.0.0.1/<name>.html` can never reproduce — unlike a hostname-only gate, `hostOverride` alone isn't enough here. `testPathOverride` / `__setTestPathOverride()` is the companion to `testHostOverride`, wired through the same `__DISCERNED_TEST_CAPTURE` bridge and `runFixtureVisual`'s `pathOverride` option, tree-shaken the same way in production.

**Third-party embeds.** `matchVideoEmbed()` also gained a Facebook provider (`facebook.com/plugins/video.php` / `/plugins/post.php`) so an embedded FB reel/video iframe on another site degrades to a `dx-video-link` card (no derivable thumbnail, same as Rumble/Twitch/Dailymotion) instead of vanishing outright.

### Embedded tweets on third-party sites

Article captures detect and render embedded tweets from third-party pages (ZeroHedge, Breitbart, news blogs) as rich `tweet-card` blocks matching Tier 0's output.

**Pipeline** — `harvestEmbeddedTweets()` runs on the live DOM **before any clone**, returning `Map<tweetId, EmbeddedTweetData>`:
1. Parse every `<blockquote class="twitter-tweet">` (including hidden ones widgets.js leaves behind) for the static fallback data.
2. Round-trip through the background: `chrome.webNavigation.getAllFrames({ tabId })` enumerates ALL frames in the tab (including nested ones), filtered to `platform.twitter.com/embed/Tweet.html`. `chrome.scripting.executeScript({ target: { tabId, frameIds }, func: extractFromTweetEmbed })` injects an extractor that reads the rendered tweet DOM (avatar, author, text, photos, video poster, date, verified badge, "Show more" anchor). Iframe data wins over blockquote data when both are available.
3. 1-second timeout budget so a stuck iframe doesn't hang the capture.

**Substitution** — `substituteEmbeddedTweets(clone, harvested)` walks the cloned subtree and replaces:
- `iframe[id^="twitter-widget"]` — standard widgets.js render
- `iframe[src*="platform.twitter.com/embed"]` — direct platform embed
- `iframe[data-tweet-id]` — pre-tagged
- **Host-page wrapper iframes** — Breitbart pattern: `iframe[src*="/tweet-N.html#TWEET_ID"]` where the tweet ID is in the URL **fragment** (and may have a `-onlyvideo` suffix for video-only mode). Detection regex: `\/(tweet|status|x-embed)[^\/]*\.html#`.
- `blockquote.twitter-tweet` — static fallback

For each match: extract tweet ID, look up `harvested.get(id)`, `replaceWith()` a full `tweet-card--embed` div or a stub "View on X" card. Dedupes by tweet ID so a hidden blockquote + visible iframe for the same tweet produces ONE card.

**Required permissions** in `manifest.json`: `scripting`, `webNavigation`, `host_permissions: ["<all_urls>"]`.

**`-onlyvideo` mode** — Breitbart's wrapper iframes can request video-only rendering with `#TWEET_ID-onlyvideo`. In that mode the platform.twitter.com iframe has no avatar container, no `tweetText`, no profile link. `extractFromTweetEmbed` resolves `statusUrl` and `tweetId` FIRST, then derives `handle` from the URL path `/{handle}/status/` when the avatar container is absent. Display name falls back to handle. The video poster from `<video poster=>` flows through `videoInfos[].poster` → `buildVideoHtml` and renders as a `tweet-video` link card with play overlay.

**"Show more" link** — long tweets append `<a data-testid="tweet-text-show-more-link">` inside `tweetText`. The extractor preserves the anchor but rewrites its href from the Twitter signin-redirect chain to the canonical `https://x.com/.../status/...` URL, and prepends a regular-space text node (X's `<span>&nbsp;</span>` separator gets dropped during sanitisation because `trim()` strips U+00A0).

### Sanitisation

`sanitiseTreeInPlace()` whitelists tags (`ALLOWED_TAGS` — includes `div, span, img, table, svg` glyphs, etc.) and per-tag attributes (`ALLOWED_ATTRS_PER_TAG`). The `class` attribute is allowed but **only tokens with `dx-` or `tweet-` prefixes survive** (`TRUSTED_CLASS_PREFIXES`); source-page hashed classes are stripped. This is how the `dx-*` markers reach the rendered clip while the page's own CSS classes don't.

### Shadow DOM support

Some sites (Stansberry's Angular app is the reference case) ship article content via declarative open Shadow DOM (`<template shadowrootmode="open">`). `document.querySelector` and `window.getSelection` don't pierce shadow boundaries, and `cloneNode(true)` doesn't clone a host's shadow root — so the capture pipeline must descend manually wherever it touches the live DOM.

Five helpers at the top of `capture.ts` handle this:

| Helper | Used by |
|---|---|
| `hasOpenShadow(el)` | Type guard for the others. Returns false for closed-mode hosts (unreachable). |
| `querySelectorAllDeep(root, sel)` | `findArticleElement`, `findContentBlockByLayout`, `annotateLiveImageSizes`, `markExcluded` (cleanup). Live-DOM content discovery. |
| `forEachDeepElement(root, fn)` | `markExcluded`, `getActiveSelection`. Walks every element including shadow descendants. |
| `deepCloneWithShadow(src)` | The three clone steps in `extractArticle` (Tier 1 + 1.5), `cloneBodyClean`, `parseReadability`. Inlines open shadow content as ordinary children of the host clone so downstream walkers (`sanitiseTreeInPlace`, `tagSemanticStructure`, per-site taggers) work without modification. |
| `getActiveSelection()` | `hasSelection`, `extractSelection`. Uses the spec API `Selection.getComposedRanges({ shadowRoots })` (Chromium 134+) to retrieve selections that cross shadow boundaries, then converts the resulting `StaticRange` to a live `Range` so `cloneContents()` works in the existing pipeline. Falls back to `window.getSelection()` when `getComposedRanges` is unavailable, with an `LL.WARN` diagnostic when open shadow roots are present but the API is missing. |

**Closed shadow roots** are inaccessible to extensions. `hasOpenShadow` returns false for them; content there cannot be captured. We don't try to count them — there's no reliable in-page detection (heuristics produce too many false positives on empty placeholder custom elements).

**`<slot>` projection is NOT performed.** `deepCloneWithShadow` places light-DOM children before inlined shadow children, which is approximately right for most widgets and exactly right for widgets that render content straight into the shadow (no slots). If a site uses slots, add a site-specific tagger that handles the composition.

**Selection snapshot.** `hasSelection()` clones the live `Range` into a module-level `selectionSnapshot` when it returns true. `extractSelection()` falls back to that snapshot when the live `Selection` has been cleared between the user triggering the overlay and clicking Capture — a pattern observed on shadow-root content (e.g. Stansberry's Angular widgets) where appending the overlay shadow-DOM steals focus and collapses the selection on the page. The snapshot is consumed (set to `null`) at the start of `extractSelection` whether or not it's used, so a stale snapshot from a prior capture can't bleed in.

**Diagnostic logs** fire only when shadow roots are present (kept quiet on the common no-shadow case):
- `LL.NORMAL`: `Discerned: N open shadow root(s) detected on page` (once per article/selection capture)
- `LL.DEBUG`: `Discerned: layout finder winner is inside shadow root of <host-tag>` and `Discerned: selection found inside shadow root of <host-tag>`
- `LL.DEBUG`: in `extractSelection`, per-stage fragment-size logs (`after cloneContents+wrap`, `after unmarkWrappers`, `after removeMarked`, `after substituteVideos`, `after sanitizeFragment`, `after inlineAllImages`) so when a selection clip comes out empty the page console pinpoints which stage dropped the content.

## File Naming Conventions

- **No `index.ts` entry points** — name entry files after their directory (e.g., `background.ts`, `content.ts`, `popup.ts`)

## Coding Conventions

- **TypeScript strict mode** — no `any`, no unused vars/params (tsconfig enforces both as errors)
- **Vanilla TypeScript** — no React or UI frameworks; Shadow DOM for style isolation
- **HTML sanitization** — tag/attribute whitelist in `ALLOWED_TAGS` / `ALLOWED_ATTRS_PER_TAG` (see Sanitisation section below); `class` kept only for `dx-*`/`tweet-*` tokens (XSS prevention)
- **WSS only** — never use unencrypted WebSocket for relay connections
- **No source maps** in production builds

## Logging / Debug Bridge

All console output is centralised via `src/shared/logger.ts` using **function overriding**.

### How it works

Each non-background entry point calls `initLogBridge(source)` at module top-level:

```ts
// content.ts, popup.ts, onboarding.ts
import { initLogBridge } from '@/shared/logger';
initLogBridge('content'); // or 'popup' | 'onboarding'

// background.ts (called before any other code)
import { initLogBridge } from '@/shared/logger';
initLogBridge('background');
```

### Log flow per context

| Context | Destination | Mechanism |
|---|---|---|
| `content` / `onboarding` | Page console (VSCode debug session) | Already in page context; override just adds `[source]` prefix |
| `popup` | Page console (VSCode debug session) | `chrome.tabs.sendMessage → LOG_RELAY` to active tab |
| `background` | Page console (VSCode debug session) | `chrome.tabs.sendMessage → LOG_RELAY` to active tab |

`LOG_RELAY` messages land in the content script's `onMessage` handler, which calls `relayLog()` — a function that uses the **pre-override** originals to avoid double-prefixing.

### Toggle for Web Store release

```ts
// src/shared/logger.ts — line 1 of config
const REMOTE_LOGGING = true;   // ← set to false before publishing
```

When `false`, the bridge is a no-op; only the local `console` call fires in each context.

### Rules

- **Never** add `console.log` to `logger.ts` itself (causes recursion)
- All `LOG_RELAY` forwarding is fire-and-forget — failures are silently swallowed
- The `originals` snapshot in `logger.ts` must be taken **before** any override runs; `relayLog()` depends on it

## Logging Rules

- **Never use `console` directly** — always call `log(LOG_LEVEL.X, ...)` from `src/shared/logger.ts`
- Import both `log` from `@/shared/logger` and `LOG_LEVEL` from `@/shared/types`
- **Always include the URL** in log calls: pass `'url:', capture.url` (or `window.location.href` when no capture is in scope)
- Levels: `TRACE=0`, `DEBUG=1`, `NORMAL=2`, `WARN=3`, `ERROR=4` — filtered by `activeLogLevel` (default `TRACE`)
- Call `setLogLevel(LOG_LEVEL.WARN)` before publishing to Web Store to suppress verbose output

## Security Rules

- All user-supplied HTML must pass through `sanitizeHtml()` in `src/content/capture.ts`
- Shadow DOM isolation is required for all injected UI

## Current Status (MVP / Phase 1)

- NIP-44 encryption: stubbed, not fully implemented
- NIP-46 login: implemented
- No retry logic for failed relay publishes
- Firefox support: not targeted yet
- Tests: Vitest configured but coverage is minimal

## File Layout

```
src/
  background/   background.ts, relay-manager.ts, relay-list-fetcher.ts
  content/      content.ts, capture.ts, overlay.ts, web-bridge.ts, highlighter.ts
  shared/       types.ts, logger.ts, theme.ts, relays.ts, nostr/{auth,events,encryption}.ts
  popup/        popup.ts, popup.html          ← stub for chrome:// pages only
  onboarding/   onboarding.ts, onboarding.html
art/            icon.svg, icon-small.svg      ← SVG masters (build-time input, never shipped)
public/icons/   icon{16,48,128}.png           ← generated; the only icons the manifest loads
dist/           (build output, gitignored)
manifest.json   Chrome MV3 manifest
vite.config.ts
tsconfig.json
```
