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
ownership and portability are attributed to Nostr, which does deliver them. 

**The shared-feed claim** describes what ships: `lib/nostr/feed.ts` subscribes with no
`authors` filter, so `/discerns` shows every published discern from every publisher, and
the feed UI already supports follows + per-author filtering. Keep it in the present
tense and keep it mechanical — "a public feed you can filter", not "a globally curated
knowledge base". There is no curation, no ranking, and no reputation, so don't imply
any; and don't describe the publisher population ("readers everywhere", "thousands of
curators") until it exists.

**Do NOT paste the following two lines.** The Store prepends `manifest.json`'s
`description` above whatever goes in this field, so it is reproduced here only to show
how the listing reads end to end. Pasting it would duplicate the summary.

> Web clipper for saving articles, quotes and pages. Rate and tag what you clip, and publish your picks to Nostr if you want.

**Paste only the fenced block below.**

```
Discern the signal from the noise on the web.
Discerned is a local-first web clipper for saving and organizing web content — and a decentralized discovery tool for seeing what people you trust are rating across any website.

CLIP & RATE WHAT MATTERS
• Save full pages, articles, text selections, or bookmarks in one click.
• You can assign a Signal Rating — five levels, from "Toxic" through "Ordinary" to "Masterpiece".
• Tag clips by tone, utility, and longevity, or add your own custom qualifiers.
• Sort into custom categories alongside built-in ones.
• Add personal notes to any clip.

SEE WHAT OTHERS ARE RATING ACROSS THE WEB
• Break free from walled gardens: discover what curators and readers rate highly or lowly across multiple websites, not just a single platform controlled by one company.
• Published clips and ratings feed directly into a public index at discerned.online, open to read by anyone.
• Filter feeds by Signal Rating, category, or qualifiers to see genuine recommendations and skip the noise.
• Follow people you know and trusted curators to grow your network and see what it's rating across the web.

CAPTURES THAT LOOK LIKE WHAT YOU READ
• Preserves the page's real structure rather than flattening it into plain text.
• Dedicated handling for complex sites that defeat ordinary clippers, keeping visual layout intact.
• Strips out ads, clutter, and unwanted noise automatically.

PUBLISH TO AN OPEN PROTOCOL
• Publish your clips whenever you choose to Nostr — an open social network where you own your identity, posts, and social graph.
• Bring your existing key, or generate one locally in seconds — no email, password, or third-party auth required.
• Every public rating is cryptographically signed under your own key and works seamlessly across compatible apps.
• Freedom from lock-in: no single company owns your data, controls the feed, or can take your clips away.

NO ACCOUNT NEEDED — OWN YOUR DATA
• Start clipping immediately with zero mandatory account creation.
• Your clip library remains local-first, stored on your device.
• Export your entire library as JSON at any time, or import existing clips from JSON and Evernote files.

Start discerning signal from noise.
```

---

## Single purpose

```
Discerned is a web clipper and content-evaluation tool. It lets a user capture an
article, selection, or page they are reading, attach a structured evaluation to it
(a quality rating, descriptive tags, and a category), save it privately on their own
device, and — only when they explicitly choose to — publish that evaluation as a
cryptographically signed event to the Nostr network.
```

Everything the extension does serves that one flow: capture → evaluate → store locally →
optionally publish. There is no second, unrelated feature.

---

## Permission justifications

Paste these into the corresponding fields. Each states the concrete mechanism, because
"it's a general-purpose tool" is the phrasing that gets rejected.

`host_permissions: https://platform.twitter.com/*`

The only host permission granted at install. Keep this distinct from the optional
`<all_urls>` below — conflating them invites the "why do you need every site?" rejection
the split exists to avoid.

```
Required to extract the content of embedded tweets (author, text, images) that news and article pages render inside cross-origin platform.twitter.com iframes. This is a fixed, single-origin target, read only during a user-initiated capture.
```

`optional_host_permissions: <all_urls>`

```
Optional and not requested at install time. Discerned is a user-initiated web clipper: its single purpose is to let users capture, rate, and save content from whichever public webpage they are currently reading. Because a user may choose to clip from any domain, this access cannot be limited to a static list of host URLs.

The permission is requested only when the user opts in, and is used to save a clip's own copy of the media on the page being captured: fetching the page's images, and a poster frame for its videos, so the clip still renders if the source site later removes or blocks them. Those fetches go directly to the servers already hosting that media — the same ones the browser contacted to display the page. Declining is fully supported — the extension keeps working and clips simply reference the original URLs instead.

Routine capture does not rely on this permission. Content scripts are injected per tab under activeTab on the user's own gesture (toolbar beacon or right-click context menu), and remain absent until then, so no page data is read, processed, or monitored without the user initiating it. Discerned does not run background tracking, does not monitor browsing history, and operates no backend server to receive page content.
```

`scripting`

```
Used exclusively for a single read-only feature: extracting embedded tweet content (author, text, images) rendered inside cross-origin platform.twitter.com iframes on news and article pages.

Because cross-origin iframe content cannot be accessed by the parent page's content script, chrome.scripting.executeScript runs a small, bundled, read-only extractor targeted strictly at those specific iframe targets. This script contains no remote code, executes only during a user-initiated capture event, and makes no network requests.
```

`webNavigation`

```
Paired directly with the scripting permission for embedded tweet extraction. The chrome.webNavigation.getAllFrames API is called solely during an active, user-initiated capture to enumerate frame IDs and identify matching platform.twitter.com tweet embeds for target extraction.

It is never used to track navigation history, monitor tab changes, or observe user browsing behavior.
```

`contextMenus`

```
Adds the right-click menu entries the user invokes to capture the current page or a
selected passage. This is one of the two primary entry points to the extension.
```

`storage`

```
Stores the user's own data locally on their device: their saved clips and evaluations,
their relay list, theme preference, and sign-in state. Nothing in storage is
transmitted to us.
```

`activeTab`

```
Grants access to the tab the user invoked the extension on, so the capture can read
that page's content at the moment of the user's click.
```

`tabs`

```
Used solely to open, focus, and communicate with the extension's own pages: the onboarding page shown after install, the permissions page where the user grants or reviews the optional image permission, and the extension's web application (discerned.online), which provides the user's clip library and the Nostr identity connect and signing flow.

Every query is filtered to those specific extension and discerned.online URLs. The extension queries for an already-open instance so it can focus that tab instead of spawning a redundant duplicate, and so it can send a newly saved clip to an open library tab to keep it up to date.

This permission is never used to monitor, record, or transmit user tab history or general browsing activity. The extension does not enumerate, read, or report the URLs of the user's other tabs.
```

Remote code

```
No. All JavaScript is bundled in the package. The extension loads no remote scripts,
uses no eval or new Function, pulls in no CDN-hosted libraries, and executes no
WebAssembly. The CSP declares script-src 'self'; object-src 'self'. Nostr event
signing uses pure-JavaScript cryptography.
```

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
- [x] Small promo tile (440×280) — `store-assets/promo-tile-440x280.png`
- [ ] Version bumped in `manifest.json` if re-submitting

Known consequence of removing `key`

The extension ID is no longer pinned. An unpacked/side-loaded install now gets a random
per-profile ID, so its IndexedDB (`discerned`) is a **separate store** from a Web Store
install's — side-load users' existing clips do not carry over. Once the store ID is
assigned, add it to `ALLOWED_ORIGINS` in
`discerned-web/netlify/functions/feedback.mts` (currently listing the old pinned ID;
nothing is broken today because the extension opens a tab rather than posting directly).

Note on the download zip

`pnpm pack:ext` builds the side-load zip via PowerShell `Compress-Archive`, which writes
backslash path separators. Chrome on Windows handles this. That zip is the side-load
build, **not** the store upload — for the store, upload a zip of `dist-pack/` created
with a tool that writes forward slashes if uploading from Windows.
