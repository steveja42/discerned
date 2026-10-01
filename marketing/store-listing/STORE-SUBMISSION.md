# Chrome Web Store submission — permission justifications & disclosures

**This file is a paste-source, not a submission.** No reviewer ever sees it. Everything
below is text to copy into the Web Store dashboard form (and the uploaded package is the
only other thing review looks at). Keep in sync with `manifest.json`; if a permission is
added or removed, update the matching section here **and** re-check the privacy policy at
`wirthy-web/app/privacy/page.tsx`.

Privacy policy URL: **https://wirthy.app/privacy**

Listing copy that lives elsewhere: the **short description** is `manifest.json`'s
`description` field (132 char max) and auto-populates the listing summary. Every
user-facing string in the extension is catalogued in [UI-TEXT.md](UI-TEXT.md).

---

## Detailed description (Store listing tab)

The long listing field — up to 16,000 characters, typed into the dashboard, not in the
manifest. Plain text with basic line breaks; the Store strips most formatting.

**Claim discipline applies here as much as in-product** (see [UI-TEXT.md](UI-TEXT.md)): clips
are NOT encrypted at rest, so nothing below says "encrypted", "secure", or pairs a
padlock with local storage. Wirthy has no reputation score, so none is promised —
ownership and portability are attributed to Nostr, which does deliver them. 

**The shared-feed claim** describes what ships: `lib/nostr/feed.ts` subscribes with no
`authors` filter, so `/home` shows every published post from every publisher, and
the feed UI already supports follows + per-author filtering. Keep it in the present
tense and keep it mechanical — "a public feed you can filter", not "a globally curated
knowledge base". There is no curation, no ranking, and no reputation, so don't imply
any; and don't describe the publisher population ("readers everywhere", "thousands of
curators") until it exists.

**Do NOT paste the following two lines.** The Store prepends `manifest.json`'s
`description` above whatever goes in this field, so it is reproduced here only to show
how the listing reads end to end. Pasting it would duplicate the summary.

>Web clipper for saving articles, selections, pages, and bookmarks. Rate and tag clips, and keep them private or publish to Nostr.

**Paste only the fenced block below.**

```
Keep track of the things you discover on the web—and record what is worthy.

CAPTURE WHAT MATTERS

Clip a selection, article, webpage, or bookmark. Keep the source with your clip so you can return to it later.

RECORD YOUR JUDGMENT

When you clip something, you can give it a Signal Rating:

★★★★★ Masterpiece
★★★★ Worthwhile
★★★ Ordinary
★★ Noise
★ Toxic

You can also add optional qualifiers such as Timeless, Practical Tool, Primary Source, Academic, or Current Event—or create your own.

Don't want to rate or tag something? Just clip it without them.

KEEP YOUR LIBRARY YOURS

Your personal clips can stay private on your device. No account is required to start building your collection.

Bring your existing collection with you using Evernote import, or import and export your clips as JSON. Your data isn't locked into Wirthy.

SHARE WHAT YOU DISCOVER

When you clip something, choose whether to keep it private, publish it to Nostr, or do both.

Nostr is an open, decentralized network where you can publish without relying on a single platform. Your identity and content aren't tied to one company's social network, and you can use different Nostr apps and services to access the same network.

Your published posts aren't confined to Wirthy. They're published to the open Nostr network and can be viewed through Wirthy and other Nostr clients.

DISCOVER WHAT OTHERS VALUE

Explore public posts, follow people whose judgment you trust, and discover worthwhile things through the recommendations of other people.

The web is full of information. Keep track of what you think is worthy

```

---

## Single purpose

```
Wirthy is a web clipper and content-evaluation tool. It lets a user capture an
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

**Sections below are ordered to match the dashboard form**, which lists the API
permissions alphabetically and then a single **Host permission** field last.

**The form has ONE host-permission field, not two.** It does not split
`host_permissions` from `optional_host_permissions` — both manifest entries are
justified in the same box, so the text below covers them together. Chrome itself still
treats them differently (the optional one stays out of the install warning until
requested); only the *form* merges them. Lead with the required, narrowly-scoped one:
it is the higher-risk item in a combined field, and scoping it explicitly answers the
"why every site?" question before the broad entry arrives.

`activeTab`

```
Grants access to the tab the user invoked the extension on, so the capture can read
that page's content at the moment of the user's click.
```

`contextMenus`

```
Adds the right-click menu entries the user invokes to capture the current page or a
selected passage. This is one of the two primary entry points to the extension.
```

`offscreen`

```
Used to decode a single still frame from a video file so a saved clip can show a poster image. When a user clips a page containing a video, the extension fetches the first few hundred KB of the video file and decodes one frame in an offscreen document, then saves that frame as a JPEG with the clip.

A page's own content security policy can block this decoding inside the page itself, which is why it runs in an extension-owned offscreen document (reason: BLOBS). The document is created only during a user-initiated capture, loads no remote code, and is closed after 30 seconds idle. The frame is stored locally with the clip; nothing is sent to any server.
```

`scripting`

```
Used for two things, both triggered only by the user's own gesture (toolbar icon, context menu, or keyboard shortcut):

1. Injecting the extension's bundled capture script into the tab the user invoked it on. The script is not declared in content_scripts, so it is absent from every page until the user asks to capture.

2. Reading content that a parent page's content script cannot reach: embedded tweets (author, text, images) rendered inside cross-origin platform.twitter.com iframes, and the body of a live-blog or article iframe on the page being clipped. chrome.scripting.executeScript runs a small, bundled, read-only extractor targeted strictly at those frames.

All injected code is bundled in the package. It contains no remote code and makes no network requests of its own.
```

`storage`

```
Stores the user's own data locally on their device: their saved clips and evaluations,
their relay list, theme preference, and sign-in state. Nothing in storage is
transmitted to us.
```

`tabs`

```
Used solely to open, focus, and communicate with the extension's own pages: the onboarding page shown after install, the permissions page where the user grants or reviews the optional image permission, and the extension's web application (wirthy.app), which provides the user's clip library and the Nostr identity connect and signing flow.

Every query is filtered to those specific extension and wirthy.app URLs. The extension queries for an already-open instance so it can focus that tab instead of spawning a redundant duplicate, and so it can send a newly saved clip to an open library tab to keep it up to date.

This permission is never used to monitor, record, or transmit user tab history or general browsing activity. The extension does not enumerate, read, or report the URLs of the user's other tabs.
```

`webNavigation`

```
Paired directly with the scripting permission for embedded tweet extraction. The chrome.webNavigation.getAllFrames API is called solely during an active, user-initiated capture to enumerate frame IDs and identify matching platform.twitter.com tweet embeds for target extraction.

It is never used to track navigation history, monitor tab changes, or observe user browsing behavior.
```

Host permission — covers BOTH `host_permissions: https://platform.twitter.com/*` and
`optional_host_permissions: <all_urls>`

```
REQUIRED — https://platform.twitter.com/*: Extracts the content of embedded tweets (author, text, images) that article pages render inside cross-origin platform.twitter.com iframes. A fixed, single-origin target, read only during a user-initiated capture, used for no other purpose.

OPTIONAL — <all_urls>: Not requested at install. Wirthy is a web clipper, so the user may clip from any domain; that cannot be reduced to a static host list. It is requested only where the user opts in — the "Save images with your clips" step during onboarding, or the extension's Permissions page — and used solely to save a clip's own copy of the page's images and video poster frames, so the clip still renders if the source site later removes them. Those fetches go directly to the servers already hosting that media. Declining is fully supported — clips simply reference the original URLs instead.

Neither permission is used for routine capture. Content scripts are injected per tab under activeTab on the user's own gesture (toolbar icon, context menu, or keyboard shortcut) and are absent until then. No background tracking, no browsing-history monitoring, and no backend server receives page content.
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

**Analytics note.** The wirthy.app *website* uses GoatCounter (cookieless,
no personal data, no cross-site tracking). The **extension contains no analytics**. The
privacy policy states this distinction explicitly; keep it accurate if that ever changes.

---

## Pre-upload checklist

Verified for the current build:

- [x] `key` field absent from the uploaded package (`manifest.json` carries the store's key for local builds; `pnpm build` / `pnpm pack:ext` strip it, since the store rejects a package with a `key`)
- [x] `alarms` permission removed (was unused)
- [x] `REMOTE_LOGGING = false` in `src/shared/logger.ts`
- [x] `activeLogLevel = LL.WARN`
- [x] No sourcemaps in the production build
- [x] No test hooks (`__WIRTHY_TEST_*`) in the production build
- [x] `pnpm type-check`, `pnpm lint`, `pnpm test` all clean
- [x] Short description written (`manifest.json` `description`, 123/132 chars)
- [x] Detailed description drafted (see the Store listing section above)
- [x] Privacy policy **deployed** and reachable at https://wirthy.app/privacy
      (`wirthy-web/app/privacy/page.tsx`, ships with the static export)
- [x] Screenshots (1280×800 or 640×400) — four, in `wirthy-web/public/press/`
- [x] Small promo tile (440×280) — `store-listing/promo-tile-440x280-azure.png`
- [ ] Version bumped in `manifest.json` if re-submitting
      *(per-resubmission reminder — leave unticked by design)*

Known consequence of removing `key`

The extension ID is no longer pinned. An unpacked/side-loaded install now gets a random
per-profile ID, so its IndexedDB (`wirthy`) is a **separate store** from a Web Store
install's — side-load users' existing clips do not carry over. Once the store ID is
assigned, add it to `ALLOWED_ORIGINS` in
`wirthy-web/netlify/functions/feedback.mts` (currently listing the old pinned ID;
nothing is broken today because the extension opens a tab rather than posting directly).

Note on the download zip

`pnpm pack:ext` builds the side-load zip via PowerShell `Compress-Archive`, which writes
backslash path separators. Chrome on Windows handles this. That zip is the side-load
build, **not** the store upload — for the store, upload a zip of `dist-pack/` created
with a tool that writes forward slashes if uploading from Windows.
