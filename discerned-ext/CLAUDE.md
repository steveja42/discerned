# CLAUDE.md — Discerned 

## Project Overview

Discerned is a Chrome Extension (Manifest V3) that acts as a value attribution layer for the web. Users capture content (selected text or page metadata), evaluate it on three axes (Interest, Ethics, Category), and publish cryptographically-signed signals to the [Nostr](https://nostr.com/) network.

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
pnpm dev          # Vite watch mode
pnpm build        # tsc + Vite production build
pnpm type-check   # tsc --noEmit (strict)
pnpm lint         # ESLint on src/**/*.ts
```

## Architecture

Three isolated components communicate via `chrome.runtime.sendMessage`:

```
Content Script (src/content/)
  → capture.ts     Smart capture: selected text (quote) or page metadata (resource)
  → overlay.ts     Shadow DOM evaluation UI (DiscernedOverlay custom element)
  → content.ts     Entry; listens for ACTIVATE_DISCERNED messages

Background Worker (src/background/)
  → background.ts  Handles context menus, signing, relay publishing, IndexedDB
  → relay-manager.ts  SimplePool wrapper; requires ≥ 2 relay ACKs; 10s timeout

Popup (src/popup/)
  → popup.html / popup.ts   Auth status, usage stats, login/export
```

Path alias: `@/*` → `src/*`

## Key Domain Concepts

- **Quote Capture**: Selected text + 100-char context window, published as Nostr kind 9802
- **Resource Capture**: Page title, URL, OG image, published as Nostr kind 1
- **Clip (🔒)**: Private; stored in IndexedDB (kind 30078 planned)
- **Cast (📡)**: Public; published to Nostr relays
- **Evaluation axes**: Interest (5 levels) · Ethics (5 levels) · Category (7 options)
- **Auth modes**: NIP-07 (browser extension wallet), Local (no cast), NIP-46

## Capture pipeline (`src/content/capture.ts`)

`captureContext(format)` branches by `ClipFormat`. For `'article'` (the rich-content path), extraction runs in tiers, first match wins:

- **Tier 0 — Twitter/X**: `extractTweet()` builds a clean tweet card from `data-testid` selectors.
- **Site taggers** (`applySiteTagger()`): before the tiers below, a per-site live-DOM tagger (if one matches the hostname) stamps `dx-*` class markers on the page so the captured HTML carries layout hints across sanitisation. When a site tagger runs, the generic semantic tagger is skipped (`siteTaggerActive`).
- **Tier 1 — semantic element**: `findArticleElement()` picks `<article>`/`<main>`/`[role=...]` when present.
- **Tier 1.5 — layout finder**: `findContentBlockByLayout()` scores every block by visual area + text density − link/button density, then `maybeExpandToFeed()` widens to a feed/thread parent. This is what makes div-soup SPAs (Nostr clients, Mastodon, Bluesky, Reddit) capture the right content.
- **Tier 2 — Readability**: Mozilla Readability for blog/news pages.
- **Tier 3 — full body**: last resort.

All tiers clone the live DOM, run `tagSemanticStructure()` (generic) or rely on the site tagger's markers, then `sanitiseTreeInPlace()`, then `inlineAllImages()` (round-trips images through the background's privileged fetch → base64).

### Per-site taggers + `dx-*` markers

`SITE_TAGGERS` is a registry of `{ match: (host) => bool, tag: (root) => void }`. Each tagger walks the **live** DOM with selectors stable for that site (data attributes or class-name *prefixes* like `[class*="_primaryNote_"]`, since SPA class hashes change between builds) and stamps `dx-*` classes:

| Marker | Meaning |
|---|---|
| `dx-post` | the primary captured post |
| `dx-reply` | a reply in a thread |
| `dx-reply-row` | a reply's avatar + (name/body) split (flex row) |
| `dx-header` | avatar + name row |
| `dx-author` | inline username + verification + handle + time |
| `dx-quote` | a quoted/embedded note card (bordered) |
| `dx-quote-frag` | one `<a>` fragment of a quote (sites split a quote across sibling `<a>`s) |
| `dx-zaps-row` | horizontal zappers row |
| `dx-stats` | reply/like/repost icon row |

The matching layout CSS lives in `discerned-web/app/globals.css` under `.clip-body .dx-*`. **To add a site**: copy `tagPrimal`, swap the selectors, register it in `SITE_TAGGERS`. No web-app change needed unless the site has a new layout quirk.

`tagPrimal` (primal.net) is the reference implementation.

### Sanitisation

`sanitiseTreeInPlace()` whitelists tags (`ALLOWED_TAGS` — includes `div, span, img, table, svg` glyphs, etc.) and per-tag attributes (`ALLOWED_ATTRS_PER_TAG`). The `class` attribute is allowed but **only tokens with `dx-` or `tweet-` prefixes survive** (`TRUSTED_CLASS_PREFIXES`); source-page hashed classes are stripped. This is how the `dx-*` markers reach the rendered clip while the page's own CSS classes don't.

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
  background/   background.ts, relay-manager.ts
  content/      content.ts, capture.ts, overlay.ts
  shared/       types.ts, nostr/{auth,events,encryption}.ts
  popup/        popup.ts, popup.html
public/icons/
dist/           (build output, gitignored)
manifest.json   Chrome MV3 manifest
vite.config.ts
tsconfig.json
```
