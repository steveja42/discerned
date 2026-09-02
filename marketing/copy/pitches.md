# Pitches

Elevator pitches at five lengths, in a Track A (Nostr) and Track B (clipper/PKM) variant.
Claim IDs in brackets refer to `claims.md`.

**The shipped tagline is not here.** It lives in `discerned-web/lib/marketing-copy.tsx` as the
`PITCH` constant and feeds both the About hero and the first-visit popover. These pitches are
for external use — directories, posts, listings, replies. Changing the shipped one is a code
edit.

---

## ≤132 characters

The Chrome Web Store `description` limit, and the length most directories want. Counts below
are verified; re-count before using one, since an over-length string is silently rejected.

**Track B (shipped, in `manifest.json`)** *(123)*
> Web clipper for saving articles, quotes and pages. Rate and tag what you clip, and publish
> your picks to Nostr if you want. [C-01, C-04, C-06, C-10]

**Track B (alternate — leads on the differentiator)** *(115)*
> Web clipper that keeps the page's real layout. Rate and tag what you save; publish your picks
> to Nostr if you want. [C-02, C-04, C-06, C-10]

**Track A** *(125)*
> Clip anything on the web, rate it yourself, and publish your picks to Nostr — signed by your
> key, private unless you cast it. [C-01, C-04, C-09, C-11]

---

## One line

**Track A**
> Clip anything on the web, rate it yourself, and publish your evaluation to Nostr under your
> own key — private clips stay in your browser, and publishing is always opt-in.
> [C-01, C-04, C-09, C-10, C-11]

**Track B**
> A web clipper that captures the page the way you actually read it — Reddit threads, YouTube
> pages, forum posts and all — then lets you rate and tag what you saved.
> [C-02, C-03, C-04, C-06]

**Shared** (when the audience is mixed or unknown)
> Clip anything on the web, rate it, and keep it — or publish your picks for others to find.
> [C-01, C-04, C-09, C-10]

---

## One paragraph

**Track A**
> Discerned is a browser extension that lets you clip a page with its original layout intact,
> rate it on a five-level signal scale, tag it, and publish that evaluation to Nostr as a
> signed note. Nothing is scored automatically — the judgement is yours, under your own key.
> Private clips stay in your browser; casting is opt-in and chosen at capture time. Sign in
> with a NIP-07 extension, a NIP-46 bunker, or a local key, or skip signing in entirely and
> just keep clips. The companion site at discerned.online shows what others found worthwhile.
> [C-01, C-02, C-04, C-06, C-09, C-10, C-11, C-13, C-15]

**Track B**
> Discerned is a web clipper that keeps the page's real structure instead of flattening it into
> plain text. It has dedicated handling for the sites that usually defeat clippers — Reddit
> comment threads, YouTube pages, Hacker News, Stack Overflow answers, forum posts, Bluesky
> threads. Save a selection, an article, a full page, or just a bookmark; rate it on a
> five-level scale if you want, tag it, file it under a category, and add a note. Clips are
> stored locally in your own browser. There's no account, and you can export everything as JSON
> — or import what you already have, including from Evernote.
> [C-01, C-02, C-03, C-04, C-05, C-06, C-07, C-08, C-09, C-14, C-16]

---

## Three paragraphs

**Track A**

> Discerned is a browser extension that lets you clip a page with its original layout intact —
> not a plain-text dump, but the thing you actually read, with its bylines, images, threads and
> code blocks. It has dedicated handling for sites that ordinary clippers mangle: Reddit,
> Hacker News, Stack Overflow, Bluesky, primal.net, forums running phpBB or SMF.
>
> Having clipped it, you can evaluate it: a five-level signal rating from Toxic through
> Ordinary to Masterpiece, qualifier tags for tone, utility and longevity, and a category.
> Rating is optional — an unrated clip is perfectly valid. Nothing is scored automatically; the
> judgement is yours.
>
> At capture time you choose what happens to it. Keep it local, and it stays in your browser.
> Cast it, and it's published to Nostr as a note signed with your own key — a kind-1 note, plus
> a NIP-23 long-form note carrying the article body when there is one. The evaluation travels
> as NIP-32 labels, so other clients can read it. Sign in with a NIP-07 extension, a NIP-46
> bunker, or a local key encrypted with a PIN. See what others cast at discerned.online.
> [C-01–C-13, C-15, C-18]

**Track B**

> Discerned is a web clipper with one thing it does unusually well: it keeps the page's real
> structure. Most clippers flatten a page into prose and lose whatever made it worth saving — a
> Reddit thread's reply structure, a Stack Overflow answer's code blocks, a forum post's
> attribution. Discerned has dedicated handling for sixteen of those sites and generic
> structure-preservation for the rest, guarded by around sixty end-to-end tests with pixel
> baselines.
>
> Save a text selection, an article, a whole page, or just a bookmark. Then, if you want, rate
> it on a five-level signal scale, tag it by tone, utility or longevity, file it under a
> category, and add a note. All of that is optional — clipping without rating is a normal way
> to use it.
>
> Clips live locally in your own browser. No account is required to start, nothing is uploaded
> anywhere, and there are no analytics in the extension at all. Export the whole library as
> JSON whenever you like, or import what you already have — including Evernote exports. If you
> want to publish a clip and its rating, you can, to an open protocol called Nostr where the
> post is signed by you and no company owns the feed. That part is entirely optional.
> [C-01–C-10, C-14, C-16, C-17, C-20]

---

## Spoken, ~30 seconds

**Track A**
> You know how when you find something genuinely good online, there's nowhere to put that
> judgement that you actually own? Discerned is a browser extension for that. You clip the
> page — properly, with its layout intact — rate it, and publish that evaluation to Nostr,
> signed with your key. Or keep it private, which is the default. It's the same act either
> way: you decide what's worth something, and the record of that decision belongs to you.
> [C-01, C-02, C-04, C-09, C-10, C-11]

**Track B**
> Most web clippers turn a page into plain text and lose the thing you wanted. Discerned keeps
> the structure — Reddit threads stay threads, code blocks stay code blocks, forum posts keep
> their attribution. You save a page, and you can rate it and tag it so you can actually find
> it again. It all stays on your machine, there's no account, and you can export the lot as
> JSON. If you ever want to share what you rated highly, there's a way to publish it — but
> that's opt-in and most people never touch it.
> [C-02, C-03, C-04, C-06, C-09, C-14, C-16]

---

## Notes on use

**Never combine the Track A and Track B one-paragraph versions.** They're calibrated to
different leads; merging them produces the "private and safe → encrypted" failure described in
`claims.md`.

**In Track B copy, Nostr never appears before the second paragraph.** It's an optional
destination, not the premise. Leading with it costs you the audience that would otherwise
install this as a clipper.

**In Track A copy, don't undersell the capture.** The Nostr-native audience has seen plenty of
"publish to Nostr" tools; the layout-preserving capture (C-02, C-03) is what's actually unusual.

Run anything derived from these past `banned-phrases.md` before posting.
