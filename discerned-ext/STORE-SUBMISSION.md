# Chrome Web Store submission — permission justifications & disclosures

Reference copy of what goes into the Web Store submission form. Keep in sync with
`manifest.json`; if a permission is added or removed, update the matching section here
**and** re-check the privacy policy at `discerned-web/app/privacy/page.tsx`.

Privacy policy URL: **https://discerned.online/privacy**

---

## Single purpose

> Discerned is a web clipper and content-evaluation tool. It lets a user capture an
> article, selection, or page they are reading, attach a structured evaluation to it
> (a quality rating, descriptive tags, and a category), save it privately on their own
> device, and — only when they explicitly choose to — publish that evaluation as a
> cryptographically signed event to the Nostr network.

Everything the extension does serves that one flow: capture → evaluate → store locally →
optionally publish. There is no second, unrelated feature.

---

## Permission justifications

Paste these into the corresponding fields. Each states the concrete mechanism, because
"it's a general-purpose tool" is the phrasing that gets rejected.

### `host_permissions: <all_urls>`

> Discerned is a web clipper: its core function is to capture the content of whatever
> page the user is reading. We cannot predict or enumerate in advance which sites a user
> will want to clip, so access cannot be limited to a fixed list of hosts.
>
> Content is only ever read when the user actively invokes the extension — via the
> toolbar button or the right-click context menu. The extension does not read, monitor,
> or transmit page content in the background, does not build a browsing history, and
> sends no page data to any server we operate. We operate no such server.
>
> The content script that loads on all pages is idle until it receives an explicit
> activation message triggered by the user's own click.

### `scripting`

> Used for one specific feature: capturing embedded tweets that appear inside articles
> on third-party news sites.
>
> Embedded tweets render inside cross-origin `platform.twitter.com` iframes whose content
> is unreadable from the parent page's content script. To capture the tweet as the user
> actually sees it, the extension uses `chrome.scripting.executeScript` to run a small
> read-only extractor inside those specific tweet-embed frames, reading the author,
> text, and images. The extractor is limited to frames matching the tweet-embed URL and
> only runs as part of a user-initiated capture.

### `webNavigation`

> Paired with `scripting`, for the same embedded-tweet feature.
> `chrome.webNavigation.getAllFrames` enumerates the frames present in the current tab so
> the extension can identify which are tweet embeds and target only those for extraction.
> It is called only during a user-initiated capture. We do not observe navigation events
> or track which pages the user visits.

### `contextMenus`

> Adds the right-click menu entries the user invokes to capture the current page or a
> selected passage. This is one of the two primary entry points to the extension.

### `storage`

> Stores the user's own data locally on their device: their saved clips and evaluations,
> their relay list, theme preference, and sign-in state. Nothing in storage is
> transmitted to us.

### `activeTab`

> Grants access to the tab the user invoked the extension on, so the capture can read
> that page's content at the moment of the user's click.

### `tabs`

> Used to open and focus the extension's own pages — the onboarding page after install,
> and the Discerned web app tab used for the Nostr signing flow. The extension reuses an
> already-open Discerned tab rather than spawning duplicates, which requires querying for
> one. Not used to record or report the user's browsing.

### Remote code

> **No.** All JavaScript is bundled in the package. The extension loads no remote scripts,
> uses no `eval` or `new Function`, and pulls in no CDN-hosted libraries. The CSP declares
> `script-src 'self' 'wasm-unsafe-eval'`; `wasm-unsafe-eval` is required by the
> cryptography library used for Nostr event signing.

---

## Data-usage disclosure

For the "collected data" checklist — the honest answer is **none of the categories**.
The extension transmits no user data to the developer. There is no backend to receive it.

Two points that need care because a reviewer may read them as collection:

- **Casts** are published to third-party Nostr relays *at the user's explicit direction*,
  which is the extension's stated purpose, not background collection. The user chooses
  what to publish and to which relays.
- **Image fetching** during capture goes directly to the sites already hosting those
  images — the same servers the user's browser contacted to render the page. Nothing is
  routed through us.

Certify all three required statements:

- ✅ I do not sell or transfer user data to third parties outside of approved use cases
- ✅ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Analytics note.** The discerned.online *website* uses GoatCounter (cookieless,
no personal data, no cross-site tracking). The **extension contains no analytics**. The
privacy policy states this distinction explicitly; keep it accurate if that ever changes.

---

## Pre-upload checklist

Verified for the current build:

- [x] `key` field removed from `manifest.json` (store assigns its own ID)
- [x] `alarms` permission removed (was unused)
- [x] `REMOTE_LOGGING = false` in `src/shared/logger.ts`
- [x] `activeLogLevel = LL.WARN`
- [x] No sourcemaps in the production build
- [x] No test hooks (`__DISCERNED_TEST_*`) in the production build
- [x] `pnpm type-check`, `pnpm lint`, `pnpm test` all clean
- [ ] Privacy policy **deployed** and reachable at https://discerned.online/privacy
- [ ] Screenshots (1280×800 or 640×400) — at least one, up to five
- [ ] Small promo tile (440×280)
- [ ] Version bumped in `manifest.json` if re-submitting

### Known consequence of removing `key`

The extension ID is no longer pinned. An unpacked/side-loaded install now gets a random
per-profile ID, so its IndexedDB (`discerned`) is a **separate store** from a Web Store
install's — side-load users' existing clips do not carry over. Once the store ID is
assigned, add it to `ALLOWED_ORIGINS` in
`discerned-web/netlify/functions/feedback.mts` (currently listing the old pinned ID;
nothing is broken today because the extension opens a tab rather than posting directly).

### Note on the download zip

`pnpm pack:ext` builds the side-load zip via PowerShell `Compress-Archive`, which writes
backslash path separators. Chrome on Windows handles this. That zip is the
`/get-extension` download, **not** the store upload — for the store, upload a zip of
`dist-pack/` created with a tool that writes forward slashes if uploading from Windows.
