# Discerned Web — Codebase Guide for Claude

## What this project is

Companion web app for the Discerned Chrome extension, hosted at `discerned.online`. It is a **read-only** surface — clipping happens only in the extension, never here.

Three routes:
- `/` — public Discernments feed (Nostr `kind:1` events tagged `#discerned`)
- `/about` — brand/marketing page with HeroBeacon SVG
- `/library` — user's private Library, delivered via extension postMessage bridge

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
- **No backend.** Everything is client-side — Nostr relays for the public feed, postMessage bridge for private clips.
- **WSS only** for relay connections — never `ws://`.
- **Sanitize Nostr content** before rendering — never trust raw event content as HTML.
- **Origin-pin postMessage** on the extension bridge — both sides check `e.origin`.
- **TypeScript strict** — no `any`.

## Design system

All tokens live in `app/globals.css` under `body.style-editorial`. Do not add inline colors or hardcoded hex values — always use CSS variables. Key tokens:

```css
--paper / --paper-2 / --paper-3   /* background scale */
--ink / --ink-2 / --ink-3 / --ink-4  /* text scale */
--accent: #3B82F6                  /* Discerned blue */
--accent-ink: #1E3A8A              /* deep navy for links/emphasis */
--interest: #3B82F6
--ethics: oklch(0.55 0.10 155)
--category: oklch(0.50 0.08 270)
--serif / --sans / --mono          /* Newsreader / Geist / JetBrains Mono */
```

The design prototype lives at `C:\Users\steve\Downloads\discerned web design\design_handoff_discerned\` — reference it when making UI changes.

## File structure

```
app/
  globals.css          ← all tokens + component styles
  layout.tsx           ← body class="style-editorial"
  page.tsx             ← home (mounts HomeClient)
  HomeClient.tsx       ← client: feed + popover + modal
  about/page.tsx       ← HeroBeacon + philosophy copy
  library/page.tsx
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
  useLibraryBridge.ts  ← bridge listener for /library, 2s timeout
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
['l', '<value>', 'online.discerned.interest']
['l', '<value>', 'online.discerned.ethics']
['l', '<value>', 'online.discerned.category']
['r', '<url>']
['quote', '<selected text>']
['format', 'selection' | 'article' | ...]
```
