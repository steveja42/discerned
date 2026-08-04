# Chrome Web Store submission — permission justifications & disclosures

**This file is a paste-source, not a submission.** No reviewer ever sees it. Everything
below is text to copy into the Web Store dashboard form (and the uploaded package is the
only other thing review looks at). Keep in sync with `manifest.json`; if a permission is
added or removed, update the matching section here **and** re-check the privacy policy at
`discerned-web/app/privacy/page.tsx`.

Privacy policy URL: **https://discerned.online/privacy**

Listing copy that lives elsewhere: the **short description** is `manifest.json`'s
`description` field (132 char max) and auto-populates the listing summary. Every
user-facing string in the extension is catalogued in [UI-TEXT.md](UI-TEXT.md).

---

## Detailed description (Store listing tab)

The long listing field — up to 16,000 characters, typed into the dashboard, not in the
manifest. Plain text with basic line breaks; the Store strips most formatting.

**Claim discipline applies here as much as in-product** (see [UI-TEXT.md](UI-TEXT.md)): clips
are NOT encrypted at rest, so nothing below says "encrypted", "secure", or pairs a
padlock with local storage. Discerned has no reputation score, so none is promised —
ownership and portability are attributed to Nostr, which does deliver them. Don't add
"you own your social graph" here; it isn't true of this extension today.

**The shared-feed claim** describes what ships: `lib/nostr/feed.ts` subscribes with no
`authors` filter, so `/discerns` shows every published discern from every publisher, and
the feed UI already supports follows + per-author filtering. Keep it in the present
tense and keep it mechanical — "a public feed you can filter", not "a globally curated
knowledge base". There is no curation, no ranking, and no reputation, so don't imply
any; and don't describe the publisher population ("readers everywhere", "thousands of
curators") until it exists.

> ## Turn your daily reading into signal worth keeping.
>
> Most read-later tools are a graveyard. You save an article, and that's the last you
> think about it. Discerned adds the step that actually matters: you rate what you read,
> so your library becomes a record of what was worth your time — and so does anyone
> else's, if they choose to publish.
>
> **CLIP AND RATE WHAT MATTERS**
> • Save full articles, a text selection, or a plain bookmark in one click.
> • Give it a Signal Rating — five levels, from "Toxic" through "Ordinary" to
>   "Masterpiece". It's the whole point: a library you can sort by what was actually
>   worth reading.
> • Tag it by tone, utility, and longevity — or add your own qualifiers.
> • Sort into categories, with your own alongside the built-in ones.
>
> **LOCAL-FIRST, NO ACCOUNT REQUIRED**
> • Your clips and ratings are stored on your own device, not on a server.
> • There is no Discerned account, and no sign-up to start clipping.
> • We run no backend and receive none of your data — there is nothing to receive it.
> • Export your whole library as JSON whenever you want.
>
> **PUBLISH TO NOSTR WHEN YOU CHOOSE**
> • Publishing is entirely opt-in, and off until you connect an identity.
> • Connect however you like: a signing extension (Alby, nos2x), a remote signer over
>   bunker://, or your own key stored behind a PIN.
> • Published ratings are signed with your key, so they're verifiably yours.
> • Nostr is an open social network: you own your identity and your posts, they work
>   across every Nostr app, and no company can take them away.
>
> **A SHARED RECORD OF WHAT'S WORTH READING**
> Published ratings land in a public feed at discerned.online, open to read whether or
> not you use the extension. Filter it by Signal Rating, category, or qualifier to see
> what people rated highly and why — and follow the readers whose judgement you trust.
> Every rating there was published by someone who chose to, signed with their own key,
> on an open protocol no company controls. The more readers who publish, the more useful
> the record becomes.
>
> **CAPTURE THAT LOOKS LIKE WHAT YOU READ**
> Discerned reproduces the page's real structure — headline, byline, images, comment
> threads — rather than flattening it into plain text. Sites that defeat ordinary
> clippers (Reddit, YouTube, Stack Overflow, Bluesky, Hacker News, and other
> JavaScript-heavy layouts) have dedicated handling so the clip resembles the page you
> were actually looking at.
>
> Stop saving articles to a read-later graveyard. Start keeping a record of what was
> worth reading — and, if you choose, help build one worth sharing.

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


> Discerned is a user-initiated web clipper. Its single purpose is to let users capture, rate, and save content from whichever public webpage they are currently reading. Because a user may choose to clip content from any web domain, access cannot be limited to a static list of host URLs.

>The extension is strictly passive: content scripts remain completely idle and do not read, process, or monitor page data until the user actively initiates a capture via the toolbar beacon or right-click context menu. Discerned does not run background tracking, does not monitor browsing history, and operates no backend server to receive page content.


### `scripting`

>Used exclusively for a single read-only feature: extracting embedded tweet content (author, text, images) rendered inside cross-origin platform.twitter.com iframes on news and article pages. 

> Because cross-origin iframe content cannot be accessed by the parent page's content script, chrome.scripting.executeScript runs a small, bundled, read-only extractor targeted strictly at those specific iframe targets. This script contains no remote code, executes only during a user-initiated capture event, and makes no network requests.



### `webNavigation`

>Paired directly with the scripting permission for embedded tweet extraction. The chrome.webNavigation.getAllFrames API is called solely during an active, user-initiated capture to enumerate frame IDs and identify matching platform.twitter.com tweet embeds for target extraction. 

>It is never used to track navigation history, monitor tab changes, or observe user browsing behavior.


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

> Used solely to query open browser tabs for existing instances of the extension's onboarding page and internal web application (discerned.online). This allows the extension to focus an already-open tab rather than spawning redundant duplicate tabs during the identity connect flow. 

This permission is never used to monitor, record, or transmit user tab history or general browsing activity.

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
- [x] Short description written (`manifest.json` `description`, 119/132 chars)
- [x] Detailed description drafted (see the Store listing section above)
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
