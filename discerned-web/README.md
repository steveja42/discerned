# Discerned — Companion Web App

The companion surface for the [Discerned](https://discerned.online) Chrome extension. Browse the public Discerns feed on [Nostr](https://njump.me/), manage your private Clips, and learn about the project.

**Capturing happens only in the extension** — install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/discerned/gpfeknmodijdlehpnkfannklhplmfoma). This web app never creates a clip; it reads them from the extension over a bridge and can edit, import, export, and delete them.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Redirects to `/discerns` (client-side; query string preserved) |
| `/discerns` | Public Discerns feed — live `kind:1` Nostr events tagged `#discerned` |
| `/clips` | Private Clips — delivered from the extension via postMessage bridge |
| `/about` | Brand page — HeroBeacon SVG, pitch + roadmap copy |
| `/feedback` | Bug reports / feature requests → a GitHub issue, via a Netlify function |
| `/privacy` | Privacy policy (required for the Chrome Web Store listing) |

---

## Planned

Both of these act on someone else's **Discern**, so the UI lands here in the feed rather than in the extension. Each needs a signed event, so the extension carries the identity/signing half (it already routes casts here for NIP-07 — see [Extension bridge](#extension-bridge)).

- **Bitcoin tipping** — zap the author of a Discern over Lightning (NIP-57), so rating something highly can carry value and not just attention. Needs a zap request signed by the reader and a Lightning address resolved from the author's kind-0 profile.
- **Voting on Discerns** — agree or disagree with someone else's evaluation, turning one reader's rating into a shared signal about whose judgement is worth trusting.

---

## Stack

- **Next.js 16.2** — App Router, TypeScript strict, Turbopack, `output: 'export'` (static)
- **React 19**
- **nostr-tools 2.x** — Nostr relay subscriptions, NIP-07 auth, keypair generation
- **Vitest** — unit tests (jsdom)
- **pnpm**

No CSS framework. All styling is plain CSS custom properties in `app/globals.css` (Editorial theme — warm cream paper, Discerned blue accent), with a light and dark palette.

The app is a **static export** deployed by Netlify, so there are no API routes or server actions. The one piece of server-side code is a Netlify function (see [Feedback](#feedback) below).

---

## Getting started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
pnpm build        # static production build → out/
pnpm type-check   # tsc --noEmit (app + netlify/functions)
pnpm lint
pnpm test         # Vitest unit tests
```

The cross-project Playwright e2e suite lives at the monorepo root — run `pnpm test:e2e` from there.

---

## Project structure

**app/**

| File | Purpose |
|---|---|
| [app/globals.css](app/globals.css) | Design tokens + all component styles (Studio theme) |
| [app/layout.tsx](app/layout.tsx) | Root layout — `body.style-studio` |
| [app/page.tsx](app/page.tsx) | Root route — client redirect to `/discerns` |
| [app/discerns/page.tsx](app/discerns/page.tsx) | Discerns feed route — mounts `DiscernsClient` |
| [app/discerns/DiscernsClient.tsx](app/discerns/DiscernsClient.tsx) | Client component: feed, popover, sign-in modal |
| [app/not-found.tsx](app/not-found.tsx) | 404 page |
| [app/about/page.tsx](app/about/page.tsx) | About / brand page — HeroBeacon + pitch + roadmap |
| [app/clips/page.tsx](app/clips/page.tsx) | Clips route — extension bridge or install prompt |
| [app/feedback/page.tsx](app/feedback/page.tsx) | Feedback form + donate section |
| [app/privacy/page.tsx](app/privacy/page.tsx) | Privacy policy |
| [netlify/functions/feedback.mts](netlify/functions/feedback.mts) | The only server-side code — Turnstile check → GitHub issue |

**components/**

| File | Purpose |
|---|---|
| [components/brand/MiniBeacon.tsx](components/brand/MiniBeacon.tsx) | Topbar brand mark SVG |
| [components/brand/HeroBeacon.tsx](components/brand/HeroBeacon.tsx) | Hero brand mark SVG |
| [components/chrome/TopBar.tsx](components/chrome/TopBar.tsx) | Site-wide navigation bar |
| [components/chrome/SettingsModal.tsx](components/chrome/SettingsModal.tsx) | Settings — relays, categories, import/export |
| [components/layout/ResizableLayout.tsx](components/layout/ResizableLayout.tsx) | Resizable two-pane layout |
| [components/layout/CollapsibleSection.tsx](components/layout/CollapsibleSection.tsx) | Collapsible sidebar section |
| [components/feed/CastFeed.tsx](components/feed/CastFeed.tsx) | Public Discerns feed list |
| [components/feed/ClipRow.tsx](components/feed/ClipRow.tsx) | Single clip row in the feed |
| [components/feed/DetailPanel.tsx](components/feed/DetailPanel.tsx) | Clip detail side panel |
| [components/feed/FilterStrip.tsx](components/feed/FilterStrip.tsx) | Feed filter controls |
| [components/feed/ViewControls.tsx](components/feed/ViewControls.tsx) | Sort / density / unread controls |
| [components/glyph/SignalTag.tsx](components/glyph/SignalTag.tsx) | Signal rating badge |
| [components/auth/SignInModal.tsx](components/auth/SignInModal.tsx) | NIP-07 / nsec / generate sign-in modal |
| [components/auth/PendingSignModal.tsx](components/auth/PendingSignModal.tsx) | Signs casts the extension routes here (see below) |
| [components/auth/AuthAvatar.tsx](components/auth/AuthAvatar.tsx) | Topbar auth avatar button |
| [components/auth/StatusDot.tsx](components/auth/StatusDot.tsx) | Nostr connection / extension status dot |
| [components/menu/AuthorContextMenu.tsx](components/menu/AuthorContextMenu.tsx) | Follow / filter-by-author menu |
| [components/popover/FirstVisitPopover.tsx](components/popover/FirstVisitPopover.tsx) | First-visit welcome popover |
| [components/clips/Library.tsx](components/clips/Library.tsx) | Library clip list (bridge data) |
| [components/clips/LibraryEmpty.tsx](components/clips/LibraryEmpty.tsx) | Library empty / install-prompt state |
| [components/clips/BulkActionBar.tsx](components/clips/BulkActionBar.tsx) | Multi-select actions over clips |
| [components/clips/ImportDialog.tsx](components/clips/ImportDialog.tsx) | Evernote `.enex` import |
| [components/clips/JsonImportDialog.tsx](components/clips/JsonImportDialog.tsx) | Discerned JSON backup import |
| [components/feedback/FeedbackForm.tsx](components/feedback/FeedbackForm.tsx) | Feedback form (Turnstile-gated) |
| [components/feedback/DonateSection.tsx](components/feedback/DonateSection.tsx) | PayPal / Lightning donation panel |
| [components/analytics/GoatCounter.tsx](components/analytics/GoatCounter.tsx) | Cookieless analytics loader |

**lib/**

| File | Purpose |
|---|---|
| [lib/types.ts](lib/types.ts) | Shared types: `ClipData`, `Capture`, `Evaluation`, `AuthState` — mirrored from the extension, keep in sync |
| [lib/constants.ts](lib/constants.ts) | Signal levels, categories, default relays, `WEB_STORE_URL` |
| [lib/support.ts](lib/support.ts) | Project links (repo, issues, site) + donation IDs |
| [lib/mockData.ts](lib/mockData.ts) | Seed clips shown while Nostr connects |
| [lib/logger.ts](lib/logger.ts) | Level-filtered logger (`warn` in production) |
| [lib/analytics.ts](lib/analytics.ts) | GoatCounter event helper |
| [lib/nostr/feed.ts](lib/nostr/feed.ts) | Nostr relay feed subscription |
| [lib/nostr/parse.ts](lib/nostr/parse.ts) | Nostr event → `ClipData` parser (must match the extension's tag conventions) |
| [lib/nostr/auth.ts](lib/nostr/auth.ts) | NIP-07 / nsec / keypair auth helpers |
| [lib/nostr/profiles.ts](lib/nostr/profiles.ts) | kind-0 profile fetch + display-name resolution |
| [lib/nostr/follows.ts](lib/nostr/follows.ts) | kind-3 follow list read/write |
| [lib/nostr/strip-snippet.ts](lib/nostr/strip-snippet.ts) | Strips the invisible cast sentinels from rendered content |
| [lib/bridge/extension-bridge.ts](lib/bridge/extension-bridge.ts) | Extension `postMessage` listener (origin-pinned) |
| [lib/bridge/ClipStoreContext.tsx](lib/bridge/ClipStoreContext.tsx) | Clip store + per-clip body cache |
| [lib/export-utils.ts](lib/export-utils.ts) | Clip library JSON export / import |
| [lib/enex-parser.ts](lib/enex-parser.ts) | Evernote `.enex` → `ClipData` |
| [lib/feedback-format.ts](lib/feedback-format.ts) | Issue title/body/label formatting for the feedback function |
| [lib/marketing-copy.tsx](lib/marketing-copy.tsx) | Pitch copy shared by the About page and first-visit popover |

**hooks/**

| File | Purpose |
|---|---|
| [hooks/useCastFeed.ts](hooks/useCastFeed.ts) | Live Nostr feed with mock seed data |
| [hooks/useNostrAuth.tsx](hooks/useNostrAuth.tsx) | NIP-07 / readonly / guest auth state |
| [hooks/useFirstVisit.ts](hooks/useFirstVisit.ts) | `localStorage["discerned.seenHero"]` flag |
| [hooks/useLibraryBridge.ts](hooks/useLibraryBridge.ts) | Extension bridge for `/clips` with 2 s timeout |
| [hooks/useBridgeAuth.ts](hooks/useBridgeAuth.ts) | Auth state derived from bridge hello message |
| [hooks/useOwnProfile.ts](hooks/useOwnProfile.ts) | The signed-in identity's own kind-0 profile |
| [hooks/useAuthorProfiles.ts](hooks/useAuthorProfiles.ts) | Batched kind-0 lookups for feed authors |
| [hooks/useFollowList.ts](hooks/useFollowList.ts) | Reads the signed-in identity's follow list |
| [hooks/useFollowMutation.ts](hooks/useFollowMutation.ts) | Follow / unfollow (publishes kind 3) |
| [hooks/useReadCasts.ts](hooks/useReadCasts.ts) | Read/unread tracking for the feed |
| [hooks/useSidebarSections.ts](hooks/useSidebarSections.ts) | Persisted collapse state for sidebar sections |

---

## Nostr sign-in

Three methods, all client-side:

1. **NIP-07 browser extension** (featured) — calls `window.nostr.getPublicKey()`
2. **Paste nsec** — decoded and used in session memory only, never persisted
3. **Generate new identity** — keypair generated in-browser; user backs up the nsec

Pubkey is stored in `localStorage["discerned.auth"]`.

---

## Extension bridge

When the Discerned extension is installed, its content script runs on `discerned.online/*` and posts clips + auth state to the page via `postMessage`. The web app listens via `lib/bridge/extension-bridge.ts` and announces readiness with `DISCERNED_WEB_READY`. If no bridge message arrives within 2 seconds, `/clips` shows the install prompt. When the bridge is detected, a "My Clips" link with a blue indicator dot appears in the TopBar.

**Clip bodies arrive in two phases.** `chrome.runtime.sendMessage` has a hard 64 MiB limit and article clips carry large inlined images, so the bulk clip list ships **without** `bodyHtml` / `thumbnail`. Selecting a clip requests its body on demand (`DISCERNED_REQUEST_CLIP_BODY` → `DISCERNED_BRIDGE_CLIP_BODY`), cached for the session in `ClipStoreContext`.

**The bridge is bidirectional.** Edits made here — notes, deletes, categories, relay preferences, imports — travel back to the extension, which remains the canonical store. Settings → Relays is the only editing UI for the relay list.

**Casts sign here.** NIP-07 wallets keep per-origin approval lists, so the extension routes every `kind:1` cast to a `discerned.online` tab rather than signing on whatever site the user captured from — the user approves this one origin once. `PendingSignModal` (mounted in `app/layout.tsx`) handles it.

---

## Feedback

`/feedback` turns a submission into a GitHub issue via [netlify/functions/feedback.mts](netlify/functions/feedback.mts) — the only server-side code in the project, since the static export rules out API routes. It verifies a Cloudflare Turnstile token, rate-limits, and posts through a token held only in the Netlify dashboard (never `NEXT_PUBLIC_`-prefixed, which would inline it into the client bundle).

Reports become **public** GitHub issues, so the extension deliberately sends only its version and target — never auth or publish mode.

---

## Deployment

Netlify builds from `github.com/steveja42/discerned` on every push to `main` that touches `discerned-web/`. Publish dir is `out/` (static export). Config lives in `netlify.toml` here and at the monorepo root; both pin Node 22 / pnpm 11.

---

## Design reference

The `MiniBeacon` and `HeroBeacon` SVGs are hand-authored and load-bearing for brand identity — do not replace them. `MiniBeacon`'s geometry is copied verbatim into the extension's icon masters (`discerned-ext/art/`), so the navbar mark and the toolbar icon are provably the same drawing; change one and regenerate the rest with `pnpm gen:icons` from `discerned-ext/`.

---

## Sovereignty principles

- No user accounts, no server-side data storage — clips live in the extension's local IndexedDB and nowhere else
- The single Netlify function exists only to file feedback as a GitHub issue; it stores nothing
- Privacy-respecting, cookieless analytics (GoatCounter) — aggregate page/download counts only, no cookies, no personal data, no cross-site tracking; proxied through our own domain
- All relay connections use WSS only
- Nostr content is sanitized before rendering
- The extension bridge is origin-pinned on both sides
