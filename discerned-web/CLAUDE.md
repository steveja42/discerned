# Discerned Web — Codebase Guide for Claude

## What this project is

Companion web app for the Discerned Chrome extension, hosted at `discerned.online`. It is a **read-only** surface — clipping happens only in the extension, never here.

Three routes:
- `/` — public Discernments feed (Nostr `kind:1` events tagged `#discerned`)
- `/about` — brand/marketing page with HeroBeacon SVG
- `/clips` — user's private Clips, delivered via extension postMessage bridge

## Tech stack

```
Next.js 16.2 · App Router · TypeScript strict · Turbopack
React 19
nostr-tools 2.x
pnpm
```

No CSS framework — all styling is plain CSS custom properties defined in `app/globals.css`. The token system comes from the Editorial theme: warm cream paper, deep ink text, Discerned blue accent (`#3B82F6`).

## Key architectural rules

- **No clip creation UI.** The `+` button must never appear. Clipping is the extension's job.
- **No backend.** Everything is client-side — Nostr relays for the public feed, postMessage bridge for private clips. (The one server-side touch is a Netlify reverse-proxy for analytics — see Analytics — which forwards but stores nothing of ours.)
- **WSS only** for relay connections — never `ws://`.
- **Sanitize Nostr content** before rendering — never trust raw event content as HTML.
- **Origin-pin postMessage** on the extension bridge — both sides check `e.origin`.
- **TypeScript strict** — no `any`.

## Analytics

Privacy-respecting traffic measurement via **GoatCounter** (cookieless, no PII, no cross-site tracking; aggregate page + download counts only). The README's "sovereignty principles" reflect this reframing — keep them in sync if the setup changes.

**Same-origin proxying (bypasses hostname-based tracker blockers).** Both the counter script and its data endpoint are first-party:
- **Script**: GoatCounter's `count.js` is **vendored** at `public/api/stats/count.js` (served at `/api/stats/count.js`). Refresh manually from `https://gc.zgo.at/count.js` if it drifts — the provenance/fetch-date is in the file header.
- **Data endpoint**: `data-goatcounter="/api/stats/count"`. Netlify reverse-proxies the **exact** path `/api/stats/count` → `https://discernedweb.goatcounter.com/count` (`status = 200`, `force = true`) in `discerned-web/netlify.toml` (the sole Netlify config — dashboard "Package directory" = `discerned-web`). **Match the exact path, NOT `/api/stats/*`** — a wildcard + `force` would also swallow `/api/stats/count.js` (the vendored script) and proxy it to a nonexistent `goatcounter.com/count.js`, 404-ing the loader so nothing tracks. count.js POSTs to `/api/stats/count?<query>`; the query doesn't affect path matching, so the exact rule catches the hit while `/api/stats/count.js` falls through to the static file. The site code (`discernedweb`) is a **committed literal**, never a client env var — Netlify can't interpolate env vars in redirect targets, and the browser only ever talks to same-origin `/api/stats/*` anyway.

**Code:**
- `lib/analytics.ts` — `GOATCOUNTER_ENDPOINT` / `GOATCOUNTER_SCRIPT` / `PROD_HOST` constants, the `window.goatcounter` type, `isAnalyticsHost()`, and the null-safe `countEvent(path, title)` / `countPageview(path)` helpers.
- `components/analytics/GoatCounter.tsx` (`'use client'`, mounted last in `app/layout.tsx`) — loads the script via `next/script` and reports **SPA route changes** via a `usePathname()` effect (count.js only auto-counts the initial hard load; the effect skips its first run to avoid double-counting).
- **Hostname gate**: everything is a **no-op unless `window.location.hostname === 'discerned.online'`** — localhost and Netlify deploy previews never pollute stats. (The gate is resolved in an effect so SSR/first-render return `null` → no hydration mismatch.)
- **Extension-ZIP downloads**: both download links in `app/get-extension/page.tsx` fire `countEvent('download-extension', …)` on click (`sendBeacon`, non-blocking → the download still proceeds). One shared event path so the dashboard shows a single downloads count.

## Design system

All tokens live in `app/globals.css` under `body.style-studio` (the active **Studio** theme — white surface, Plus Jakarta Sans, blue accent). Do not add inline colors or hardcoded hex values — always use CSS variables. Key tokens:

```css
--paper / --paper-2 / --paper-3   /* background scale (white → #f7f7f7 → #efefef) */
--ink / --ink-2 / --ink-3 / --ink-4  /* text scale (#0d0d0d → #b0b0b0) */
--accent: #2563eb                  /* Discerned blue */
--accent-ink: #1d4ed8              /* deeper blue for links/emphasis */
--interest: #2563eb
--ethics: #059669
--category: #7c3aed
--serif / --sans / --mono          /* Plus Jakarta Sans / Plus Jakarta Sans / JetBrains Mono */
```

Studio also carries component-level overrides (tighter radii, upright non-italic brand/feed-title/excerpts, 12px topbar padding) under `body.style-studio .<selector>` directly below the token block.

The design prototype lives at `C:\Users\steve\Downloads\discerned web design\design_handoff_discerned\` — reference it when making UI changes.

## Captured-clip rendering (`.clip-body` + `dx-*`)

`DetailPanel.tsx` renders a clip's captured `bodyHtml` via `dangerouslySetInnerHTML` into a `.clip-body` div. The extension's capture pipeline sanitises that HTML and stamps `dx-*` class markers (the only page-origin classes that survive sanitisation, alongside `tweet-*`). All layout for captured social-post threads lives in `app/globals.css` under `.clip-body .dx-*`:

- `dx-post` / `dx-reply` — block containers with hairline separators
- `dx-reply-row` — flex row: avatar wrapper (first child) + name/body column. Missing-avatar wrappers (`:not(:has(img))`) get an inline-SVG silhouette placeholder.
- `dx-header` — avatar + name flex row (`align-items: flex-start` so name top-aligns with avatar)
- `dx-author` — inline username + verification + handle + time (one line)
- `dx-quote` — bordered embedded-note card; `dx-quote-frag` are the `<a>` fragments inside it (sites split one quote across sibling `<a>`s) — frags get underline/border stripped
- `dx-zaps-row` / `dx-stats` — horizontal icon/amount rows

The marker contract is defined extension-side in `discerned-ext/src/content/capture.ts` (`SITE_TAGGERS` / `tagPrimal`). When adding a marker there, add its CSS here. Verify visually with the Playwright spec `tests/e2e/primal-visual.spec.ts` (writes screenshots to `test-output/`).

## File structure

```
app/
  globals.css          ← all tokens + component styles
  layout.tsx           ← body class="style-studio"
  page.tsx             ← home (mounts HomeClient)
  HomeClient.tsx       ← client: feed + popover + modal
  about/page.tsx       ← HeroBeacon + philosophy copy
  clips/page.tsx
components/
  brand/               ← MiniBeacon.tsx, HeroBeacon.tsx (do not modify SVGs)
  chrome/              ← TopBar.tsx
  feed/                ← CastFeed, ClipRow, DetailPanel, FilterStrip
  glyph/               ← Glyph, GlyphBars, GlyphRadial, GlyphLetter
  auth/                ← SignInModal, AuthAvatar
  popover/             ← FirstVisitPopover
  clips/               ← Library, LibraryEmpty
lib/
  types.ts             ← ClipData, Capture, Evaluation, AuthState
  constants.ts         ← INTEREST_LEVELS, ETHICS_LEVELS, CATEGORIES, DEFAULT_RELAYS
  mockData.ts          ← seed clips shown while Nostr connects
  nostr/               ← feed.ts, parse.ts, auth.ts
  bridge/              ← extension-bridge.ts
hooks/
  useCastFeed.ts
  useNostrAuth.ts
  useFirstVisit.ts
  useLibraryBridge.ts  ← bridge listener for /clips, 2s timeout
```

## Brand mark discipline

`MiniBeacon` and `HeroBeacon` are hand-authored SVGs — do not replace them with generic icons or library components. Their visual vocabulary (tapered tower, lattice braces, lamp dome, rays) ties the topbar to the hero. Both use `currentColor`.

## Common commands

```bash
pnpm dev          # start dev server (Turbopack, port 3000)
pnpm build        # production build
pnpm exec tsc --noEmit  # type-check without building
```

## localStorage keys

| Key | Value |
|---|---|
| `discerned.seenHero` | `"1"` when first-visit popover has been dismissed |
| `discerned.auth` | Nostr pubkey hex string |

## Extension bridge protocol

The extension content script runs on `discerned.online/*` and sends two message types:

```ts
{ type: 'DISCERNED_BRIDGE_HELLO'; pubkey: string | null; authMethod: ... }
{ type: 'DISCERNED_BRIDGE_CLIPS'; clips: ClipData[] }
```

The web app announces readiness by posting `{ type: 'DISCERNED_WEB_READY' }`. Origin must be `window.location.origin` on both sides.

## Nostr event shape

Discerned casts use `kind:1` with these tags:

```
['t', 'discerned']
['l', '<value>', 'online.discerned.signal']     # optional — omitted when unrated
['l', '<value>', 'online.discerned.qualifier']  # repeated, one per qualifier
['l', '<value>', 'online.discerned.category']
# legacy casts carry online.discerned.interest / .ethics instead — parse.ts still reads them
['r', '<url>']
['quote', '<selected text>']
['format', 'selection' | 'article' | ...]
```
