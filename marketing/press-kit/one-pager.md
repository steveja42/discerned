# Discerned — one-pager

**A browser extension for clipping the web, rating what you clipped, and publishing your picks
— or keeping them entirely to yourself.**

discerned.online · [Chrome Web Store](https://chromewebstore.google.com/detail/discerned/gpfeknmodijdlehpnkfannklhplmfoma) · [github.com/steveja42/discerned](https://github.com/steveja42/discerned)

---

## What it is

Discerned is a Chrome extension paired with a companion web app. You clip something you're
reading, optionally evaluate it, and decide whether it stays on your machine or goes public.

Clips are private and stored locally in your browser. Casts are public, published to Nostr and
signed with your own key. The distinction is deliberate and it's the shape of the product: a
clip stays private unless you cast it.

## The problem it addresses

Two, joined at the hip.

Web clippers tend to flatten a page into plain text, which discards the thing that made it
worth keeping — a Reddit thread's reply structure, a Stack Overflow answer's code blocks, a
forum post's attribution. You save something and get back a worse version of it.

And when you do find something genuinely good, there's nowhere to put that judgement that you
own. Ratings go into someone else's platform, on someone else's terms, and stay there.

## How it works

1. **Clip.** Toolbar icon, right-click, or keyboard shortcut. Choose a text selection, an
   article, a full page, or just a bookmark.
2. **Evaluate — optionally.** A five-level signal rating (Toxic, Noise, Ordinary, Worthwhile,
   Masterpiece), qualifier tags for tone, utility and longevity, a category, and a note. All of
   it optional; an unrated clip is perfectly valid.
3. **Decide.** Keep it local, publish it, or both. Chosen at the moment you capture.
4. **Find it again.** Clips live in a private library; casts appear in a public feed you can
   filter by rating, tag, category, or the people you follow.

## What makes the capture different

This is the part that's unusual. Discerned keeps the page's real structure rather than
flattening it — bylines, images, threaded replies, code blocks, engagement counts land roughly
where they were.

It carries dedicated handling for sixteen sites that ordinarily defeat clippers: Reddit,
YouTube, Hacker News, Stack Overflow, Bluesky, primal.net, Instagram, TikTok, Facebook,
Goodreads, Zillow, Etsy, Yelp, Twitter/X, and forums running phpBB or SMF. Everything else goes
through generic structure detection. Ads, navigation and page clutter are dropped.

Around sixty end-to-end tests, many with pixel baselines, guard this against regressions — which
matters because sites redesign without warning and a silently degraded capture is the failure
mode that's easiest to miss.

## Evaluation, and who does it

The user does. Discerned doesn't rate anything on its own; there is no scoring model, no
ranking, and no reputation system. The extension is the instrument and the person is the agent
— which is also why the public feed has no algorithm. You filter it; nothing curates it for
you.

## Privacy

Clips are stored locally in your own browser and are not uploaded anywhere. There is no
account, and no analytics in the extension at all — the website uses GoatCounter, which is
cookieless and collects no personal data. You can export your entire library as JSON at any
time, or import what you already have, including from Evernote.

Note that private clips are local, not encrypted — encryption is designed but not yet built.

## Publishing

Casting publishes to Nostr, an open protocol where identity and posts belong to the user rather
than a platform. Each cast is a kind-1 note, plus a NIP-23 long-form note carrying the article
body when there is one; the evaluation travels as NIP-32 labels, so other Nostr clients can read
it. Sign in with a NIP-07 browser extension, a NIP-46 bunker, or a local key encrypted with a
PIN — or skip signing in and just keep clips.

Images are inlined into private clips. A public cast links to images at their original address.

## What's planned

Not yet built, and labelled as such wherever it's mentioned:

- **Tipping** — send Bitcoin to someone whose discern you valued.
- **Voting** — agree or disagree with someone else's assessment.
- **Firefox support.**
- **Android and iOS apps.**

## Who makes it

Steve, working solo. Free, open source under GPL-3.0-or-later, no ads, nothing sold.

Nostr: `npub12cw6ljs0hu8gz24ajsd5t43pf4h3m3rqdppa8ulvc769ep6gs8lq3mz0aa`
Feedback: https://discerned.online/feedback — reports become public GitHub issues, so you can
follow what happens next.

---

*Version 0.2.3. Screenshots at `https://discerned.online/press/screenshot1.png` through
`screenshot4.png`; icon at `https://discerned.online/icons/icon128.png`. Please link these
rather than re-hosting, so they stay current.*
