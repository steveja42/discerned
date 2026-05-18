# Discerned — Companion Web App

A read-only companion surface for the [Discerned](https://discerned.online) Chrome extension. Browse the public Discernments feed on Nostr, explore your private Library, and learn about the project.

**Clipping happens only in the extension.** This web app does not create clips.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Public Discernments feed — live `kind:1` Nostr events tagged `#discerned` |
| `/about` | Brand page — HeroBeacon SVG, philosophy copy |
| `/library` | Private Library — delivered from the extension via postMessage bridge |

---

## Stack

- **Next.js 16.2** — App Router, TypeScript strict, Turbopack
- **React 19**
- **nostr-tools 2.x** — Nostr relay subscriptions, NIP-07 auth, keypair generation
- **pnpm**

No CSS framework. All styling is plain CSS custom properties in `app/globals.css` (Editorial theme — warm cream paper, Discerned blue accent).

---

## Getting started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
pnpm build          # production build
pnpm exec tsc --noEmit  # type-check
```

---

## Project structure

**app/**

| File | Purpose |
|---|---|
| [app/globals.css](app/globals.css) | Design tokens + all component styles (Editorial theme) |
| [app/layout.tsx](app/layout.tsx) | Root layout — `body.style-editorial` |
| [app/page.tsx](app/page.tsx) | Home route — mounts `HomeClient` |
| [app/HomeClient.tsx](app/HomeClient.tsx) | Client component: feed, popover, sign-in modal |
| [app/not-found.tsx](app/not-found.tsx) | 404 page |
| [app/about/page.tsx](app/about/page.tsx) | About / brand page — HeroBeacon + philosophy copy |
| [app/library/page.tsx](app/library/page.tsx) | Library route — extension bridge or install prompt |

**components/**

| File | Purpose |
|---|---|
| [components/brand/MiniBeacon.tsx](components/brand/MiniBeacon.tsx) | Topbar brand mark SVG |
| [components/brand/HeroBeacon.tsx](components/brand/HeroBeacon.tsx) | Hero brand mark SVG |
| [components/chrome/TopBar.tsx](components/chrome/TopBar.tsx) | Site-wide navigation bar |
| [components/layout/ResizableLayout.tsx](components/layout/ResizableLayout.tsx) | Resizable two-pane layout |
| [components/feed/CastFeed.tsx](components/feed/CastFeed.tsx) | Public Discernments feed list |
| [components/feed/ClipRow.tsx](components/feed/ClipRow.tsx) | Single clip row in the feed |
| [components/feed/DetailPanel.tsx](components/feed/DetailPanel.tsx) | Clip detail side panel |
| [components/feed/FilterStrip.tsx](components/feed/FilterStrip.tsx) | Feed filter controls |
| [components/glyph/Glyph.tsx](components/glyph/Glyph.tsx) | Glyph container |
| [components/glyph/GlyphBars.tsx](components/glyph/GlyphBars.tsx) | Bar-chart glyph variant |
| [components/glyph/GlyphRadial.tsx](components/glyph/GlyphRadial.tsx) | Radial glyph variant |
| [components/glyph/GlyphLetter.tsx](components/glyph/GlyphLetter.tsx) | Letter glyph variant |
| [components/auth/SignInModal.tsx](components/auth/SignInModal.tsx) | NIP-07 / nsec / generate sign-in modal |
| [components/auth/AuthAvatar.tsx](components/auth/AuthAvatar.tsx) | Topbar auth avatar button |
| [components/auth/StatusDot.tsx](components/auth/StatusDot.tsx) | Nostr connection / extension status dot |
| [components/popover/FirstVisitPopover.tsx](components/popover/FirstVisitPopover.tsx) | First-visit welcome popover |
| [components/clips/Library.tsx](components/clips/Library.tsx) | Library clip list (bridge data) |
| [components/clips/LibraryEmpty.tsx](components/clips/LibraryEmpty.tsx) | Library empty / install-prompt state |

**lib/**

| File | Purpose |
|---|---|
| [lib/types.ts](lib/types.ts) | Shared types: `ClipData`, `Capture`, `Evaluation`, `AuthState` |
| [lib/constants.ts](lib/constants.ts) | Dimension levels, categories, default relays |
| [lib/mockData.ts](lib/mockData.ts) | Seed clips shown while Nostr connects |
| [lib/dimensionColor.ts](lib/dimensionColor.ts) | Dimension → CSS color mapping |
| [lib/nostr/feed.ts](lib/nostr/feed.ts) | Nostr relay feed subscription |
| [lib/nostr/parse.ts](lib/nostr/parse.ts) | Nostr event → `ClipData` parser |
| [lib/nostr/auth.ts](lib/nostr/auth.ts) | NIP-07 / nsec / keypair auth helpers |
| [lib/bridge/extension-bridge.ts](lib/bridge/extension-bridge.ts) | Extension `postMessage` listener |

**hooks/**

| File | Purpose |
|---|---|
| [hooks/useCastFeed.ts](hooks/useCastFeed.ts) | Live Nostr feed with mock seed data |
| [hooks/useNostrAuth.ts](hooks/useNostrAuth.ts) | NIP-07 / readonly / guest auth state |
| [hooks/useFirstVisit.ts](hooks/useFirstVisit.ts) | `localStorage["discerned.seenHero"]` flag |
| [hooks/useLibraryBridge.ts](hooks/useLibraryBridge.ts) | Extension bridge for `/library` with 2 s timeout |
| [hooks/useBridgeAuth.ts](hooks/useBridgeAuth.ts) | Auth state derived from bridge hello message |

---

## Nostr sign-in

Three methods, all client-side:

1. **NIP-07 browser extension** (featured) — calls `window.nostr.getPublicKey()`
2. **Paste nsec** — decoded and used in session memory only, never persisted
3. **Generate new identity** — keypair generated in-browser; user backs up the nsec

Pubkey is stored in `localStorage["discerned.auth"]`.

---

## Extension bridge

When the Discerned extension is installed, its content script runs on `discerned.online/*` and posts clips + auth state to the page via `postMessage`. The web app listens via `lib/bridge/extension-bridge.ts` and announces readiness with `DISCERNED_WEB_READY`. If no bridge message arrives within 2 seconds, `/library` shows the install prompt. When the bridge is detected, a "My Library" link with a blue indicator dot appears in the TopBar.

---

## Design reference

The original HTML/JSX prototype lives at:

```
C:\Users\steve\Downloads\discerned web design\design_handoff_discerned\
```

Match that design for any UI changes. The `MiniBeacon` and `HeroBeacon` SVGs are hand-authored and load-bearing for brand identity — do not replace them.

---

## Sovereignty principles

- No backend, no server-side data storage
- No analytics, no telemetry
- All relay connections use WSS only
- Nostr content is sanitized before rendering
- The extension bridge is origin-pinned on both sides
