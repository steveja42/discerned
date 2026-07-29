# Discerned Web — Codebase Guide for Claude

## What this project is

Companion web app for the Discerned Chrome extension, hosted at `discerned.online`. It is a **read-only** surface — clipping happens only in the extension, never here.

Routes:
- `/` — client-side redirect to `/discerns` (static export — no server redirects; query string preserved for `?signin=1`)
- `/discerns` — public Discerns feed (Nostr `kind:1` events tagged `#discerned`)
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
- **No backend, with one deliberate exception.** Everything is client-side — Nostr relays for the public feed, postMessage bridge for private clips. Two server-side touches: a Netlify reverse-proxy for analytics (see Analytics), which forwards but stores nothing of ours, and **one Netlify Function** at `netlify/functions/feedback.mts` (see Feedback function) — needed because filing a GitHub issue requires holding a token, which a static export cannot do.
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
- **Feedback / donate events**: `feedback-submit` (fired on the *success* transition, not on click, so the stat counts successes), `donate-lightning-copy`, `donate-paypal-complete`.

## Feedback function

`netlify/functions/feedback.mts` turns a `/feedback` submission into a GitHub issue on the **public** `steveja42/discerned`. It is a v2-runtime function (`.mts` → standard `Request`/`Response`) and declares `export const config = { path: '/api/feedback' }`, so it is served same-origin at that path with no `[[redirects]]` alias — `/.netlify/functions/*` is avoided because some blockers and corporate proxies filter that well-known path (same rationale as the GoatCounter proxy).

All the interesting logic lives in `lib/feedback-format.ts`, which is **pure and dependency-free** so both the browser and the function import it and it is unit-testable without a running function. Tests: `tests/feedback-format.test.ts` (the helpers) and `tests/feedback-function.test.ts` (the real handler with `fetch` stubbed — no request ever leaves the machine).

**Three spam layers, cheapest first**, so a bot never costs a network round-trip:
1. **Honeypot** — an offscreen `website` field (`position:absolute; left:-9999px`, *not* `display:none`, which some bots skip). When filled, the function returns a **fake `200 {ok:true}`** and files nothing; a 400 would teach the bot which field is the trap.
2. **Type guards + length caps + content heuristics** (≥4 URLs, or >200 chars with no whitespace).
3. **Rate limit** — in-memory, 3 per 10 min per IP. **Best-effort only**: functions are per-instance and scale horizontally. It exists for the case Turnstile does *not* cover — a human who solves challenges and submits repeatedly. Don't delete it as redundant; escalation path is Netlify Blobs.
4. **Cloudflare Turnstile**, verified last. Chosen over the reCAPTCHA key that was already on hand: reCAPTCHA fingerprints every visitor, which cuts against a privacy-preserving local-first product on precisely the page where a privacy-conscious user would notice. **Don't "simplify" back to Google.**

**Rules that must not be relaxed:**
- **Never fail open.** A missing `TURNSTILE_SECRET_KEY` returns 500 rather than skipping verification — a deploy that silently accepts everything gets discovered via spam. Guarded by a test.
- **Distinguish Turnstile outcomes.** `success:false` → 400 (client resets the widget); unreachable/timeout → 502. Conflating them tells a user holding a valid token to retry forever.
- **Neuter the message** (`neutralizeMarkdown`): `@mentions` and `#123` get a zero-width space, or a submission could mass-ping GitHub users and *close unrelated issues* via closing keywords. The `(^|[^\w])` guard keeps ordinary emails like `a@b.com` intact — that's the regex's real failure mode, and it has a test.
- **Turnstile tokens are single-use and expire (~5 min).** The form calls `turnstile.reset()` after any failed submit; without it the retry fails inexplicably. Most common integration bug — covered by a Playwright test.

**Prerequisite:** the GitHub Issues API rejects the whole request with **422 if any label does not already exist**. Seven labels are applied: `feedback`, one type label, and one `area:*`. `bug` and `enhancement` are GitHub **defaults** (present on every repo), so only these 5 need creating by hand: `feedback`, `other`, `area:extension`, `area:web`, `area:both`.

The form's `idea` maps to GitHub's `enhancement` via `GITHUB_TYPE_LABEL` in `lib/feedback-format.ts` — one fewer label to create, and `enhancement` is what anyone browsing the issue list expects. The form and the issue *title* keep saying "idea" (it reads better in the UI and the deep-link URL); only the label is translated. Covered by tests in both `feedback-format.test.ts` and `feedback-function.test.ts`, because getting it wrong is a 422 that rejects the whole submission.

**Local testing:** don't use `netlify dev` — it wants port 3000 and fights the dev server. `tests/feedback-function.test.ts` drives the real handler instead. (`tsx` mis-resolves the shared `.ts` import that Netlify's esbuild handles correctly, so a standalone tsx harness won't load it.)

**Submitting the form on `localhost:3000` fails, by design.** Netlify Functions are not part of `next dev`, so `/api/feedback` hits Next's own HTML 404 page. The function returns JSON on *every* path including errors, so **a non-JSON response means the request never reached the function** — not that GitHub or the token is misconfigured. `submitFeedback` diagnoses a local 404 explicitly rather than showing a bare "(404)", which reads misleadingly like a token problem (regression covered in `tests/support-submit.test.ts`). To exercise the real function locally, run `pnpm exec netlify functions:serve --port 9999` and set `NEXT_PUBLIC_FUNCTIONS_ORIGIN` (see `.env.example`); remember `next dev` must be **restarted** to pick up an env change.

**Which account files the issues:** whoever owns `GITHUB_FEEDBACK_TOKEN` — so issues appear authored by the maintainer, not the reporter. The reporter's identity only appears in the body if they filled in the optional contact field. A **404 from GitHub** (as opposed to the local case above) means the token can't see the repo: fine-grained PATs return 404 rather than 403 so a token can't probe for private repos, so check the PAT's repository access and that it has Issues: write.

**Donate assets:** `public/support/lightning-qr.svg` is a **committed build-time artifact** — regenerate with `pnpm gen:qr` after changing `LIGHTNING_ADDRESS` in `lib/support.ts` (the script reads the address from there rather than duplicating it). Its black-on-white is baked into the SVG **on purpose**: scanners need dark modules on a light field, so it must not follow the theme into dark mode. Don't tokenise those colours.

## Design system

All tokens live in `app/globals.css` under `body.style-studio` (the active **Studio** theme — white surface, Plus Jakarta Sans, blue accent). Do not add inline colors or hardcoded hex values — always use CSS variables. Key tokens:

```css
--paper / --paper-2 / --paper-3   /* background scale (white → #f7f7f7 → #efefef) */
--ink / --ink-2 / --ink-3 / --ink-4  /* text scale (#0d0d0d → #b0b0b0) */
--accent: #2563eb                  /* Discerned blue */
--accent-ink: #1d4ed8              /* deeper blue for links/emphasis */
--signal: #d99814                  /* signal-star gold (rating pips + stars) */
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
  page.tsx             ← root: client redirect to /discerns
  discerns/page.tsx    ← feed route (mounts DiscernsClient)
  discerns/DiscernsClient.tsx ← client: feed + popover + modal
  about/page.tsx       ← HeroBeacon + philosophy copy
  clips/page.tsx
  get-extension/page.tsx ← ZIP download + install steps
  feedback/page.tsx    ← feedback form + donate (Lightning / PayPal)
  not-found.tsx        ← 404
components/
  brand/               ← MiniBeacon.tsx, HeroBeacon.tsx (do not modify SVGs)
  chrome/              ← TopBar.tsx, SettingsModal.tsx
  feed/                ← CastFeed, ClipRow, DetailPanel, FilterStrip
  glyph/               ← Glyph, GlyphBars, GlyphRadial, GlyphLetter
  auth/                ← SignInModal, AuthAvatar, StatusDot, PendingSignModal
  popover/             ← FirstVisitPopover
  clips/               ← Library, LibraryEmpty, ImportDialog, JsonImportDialog
  feedback/            ← FeedbackForm, DonateSection
  analytics/           ← GoatCounter.tsx
lib/
  types.ts             ← ClipData, Capture, Evaluation, AuthState
  constants.ts         ← SIGNAL_LEVELS, QUALIFIER_GROUPS, CATEGORIES, DEFAULT_RELAYS, relay mode
  support.ts           ← donation constants, feedback endpoint + submitFeedback()
  feedback-format.ts   ← PURE validation / issue formatting, shared with the function
  analytics.ts         ← countEvent / countPageview (GoatCounter)
  logger.ts · export-utils.ts · enex-parser.ts
  mockData.ts          ← seed clips shown while Nostr connects
  nostr/               ← feed.ts, parse.ts, auth.ts, profiles.ts, follows.ts
  bridge/              ← extension-bridge.ts
hooks/
  useCastFeed.ts
  useNostrAuth.ts
  useFirstVisit.ts
  useLibraryBridge.ts  ← bridge listener for /clips, 2s timeout
netlify/functions/
  feedback.mts         ← the ONLY server-side code; own tsconfig.json
scripts/
  gen-lightning-qr.mjs ← regenerates public/support/lightning-qr.svg (`pnpm gen:qr`)
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
['r', '<url>']
['quote', '<selected text>']
['format', 'selection' | 'article' | ...]
```
