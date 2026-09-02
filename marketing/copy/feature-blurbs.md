# Feature blurbs

Six paste-ready paragraphs, one per feature area. Written once, reused across the store
listing, directory submissions, the press kit, and posts.

Each has a **lead-sentence variant** per track rather than a full rewrite — the body stays the
same, so the two tracks can't drift apart in substance. Claim IDs refer to `claims.md`.

---

## 1. Capture modes

**Body**
> Save a text selection, a whole article, an entire page, or just a bookmark. Selections keep
> the surrounding context; articles pull the piece out of the page furniture; full-page keeps
> everything; bookmarks are for when the link is all you need. Each one is a single click from
> the toolbar icon, the right-click menu, or a keyboard shortcut. [C-01]

*Track A lead:* "Four ways to capture, depending on what you're actually saving."
*Track B lead:* "Four capture modes, one click each."

---

## 2. Layout-preserving capture — **the differentiator**

**Body**
> Most clippers flatten a page into prose and lose whatever made it worth saving. Discerned
> keeps the page's real structure: bylines, images, threaded replies, code blocks, engagement
> counts. It has dedicated handling for sixteen sites that ordinarily defeat clippers —
> Reddit, YouTube, Hacker News, Stack Overflow, Bluesky, primal.net, Instagram, TikTok,
> Facebook, Goodreads, Zillow, Etsy, Yelp, Twitter/X, and forums running phpBB or SMF — plus
> generic structure detection for everything else. Ads, navigation and page clutter are dropped.
> [C-02, C-03]

*Track A lead:* "A clip that looks like what you read, not a text dump."
*Track B lead:* "The part most clippers get wrong."

**Note:** this is the strongest claim in the set and the one to lead Track B with. It is also
verifiable — around sixty end-to-end tests with pixel baselines guard it (C-20), which is
exactly the kind of checkable detail the voice rules prefer over a superlative.

---

## 3. The evaluation model

**Body**
> Rate what you clipped on a five-level signal scale — Toxic, Noise, Ordinary, Worthwhile,
> Masterpiece — and tag it by tone and style, utility and format, or longevity. File it under
> a category, add your own tags and categories, and write a note. All of it is optional: an
> unrated clip is perfectly valid, and plenty of clipping happens without any evaluation at
> all. Nothing is scored automatically. The judgement is yours. [C-04, C-05, C-06, C-07, C-08]

*Track A lead:* "Your assessment, in a structure other people's clients can read."
*Track B lead:* "Rate and tag what you save, so you can find it again."

**Never drop the "optional" sentence.** Without it the product sounds like it demands work on
every save.

---

## 4. Clip versus cast

**Body**
> A **clip** is private. It's stored locally, in your own browser, and goes nowhere else. A
> **cast** is public — published to the Nostr network, signed with your own key. You choose
> which at the moment you capture: keep it local, cast it, or both. A clip stays private
> unless you cast it. [C-09, C-10, C-11]

*Track A lead:* "Two things, kept deliberately distinct."
*Track B lead:* "Everything stays on your machine by default."

**Two traps here.** Don't write "until you cast it" — casting is capture-time only and there's
no path from a saved clip to a cast. And don't let "private" and "local" slide into
"encrypted"; NIP-44 is stubbed and clips are stored as plaintext.

---

## 5. Nostr identity and portability

**Body**
> Publishing goes to Nostr, an open protocol where you own your identity and your posts rather
> than renting them from a platform. Sign in with a NIP-07 browser extension, a NIP-46 bunker,
> or a local key encrypted with a PIN — or don't sign in at all and just keep clips. Each cast
> is a kind-1 note, plus a NIP-23 long-form note carrying the article body where there is one,
> and the evaluation travels as NIP-32 labels so other clients can read it. Your relay list is
> yours to edit, and is discovered from your NIP-65 list when you sign in.
> [C-11, C-12, C-13, C-18, C-19]

*Track A lead:* "Signed by your key, on a network no company owns."
*Track B lead:* "Optional: publish what you rated highly."

**Track B usage:** cut everything after the second sentence. The protocol detail is Track A
material and reads as noise — or worse, as "a crypto thing" — to someone looking for a clipper.

---

## 6. No account, no lock-in

**Body**
> No account is required to start — install it and clip. There are no analytics in the
> extension at all, and the website uses GoatCounter, which is cookieless and collects no
> personal data. Export your whole library as JSON whenever you want, or import what you
> already have, including Evernote exports. [C-14, C-16, C-17]

*Track A lead:* "Nothing to sign up for, nothing to be locked into."
*Track B lead:* "Your library, in a format you can take with you."

---

## Assembly notes

**Store listing order** (Track B, utility-first): 2 → 1 → 3 → 6 → 4 → 5.
**Nostr directory order** (Track A, sovereignty-first): 4 → 5 → 2 → 3 → 1 → 6.

Blurbs 2 and 3 are the two that carry the product. If space allows only two, use those.

Before publishing any assembled version, run it past `banned-phrases.md` and check the
Constraints section of `claims.md` — particularly if blurbs 4 and 6 end up adjacent, since
that pairing is where the "encrypted" misread is most likely to form.
