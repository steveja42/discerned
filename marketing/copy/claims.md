# Claim registry

**Every product claim in any Discerned marketing copy must trace to an ID in this file.**
Nothing ships that isn't listed here. If you need to say something new, add a row with its
proof first — don't write the sentence and backfill the justification.

This exists because the two messaging tracks (see `../STRATEGY.md`) fail in a specific way:
a claim can be true in one track's framing and false in the other's. Worked example, live in
this product today —

- Track B says "your clips stay private on your device." True (C-07).
- Track A says "you own your data; nothing sits on a company's server." Also true (C-09, C-14).
- A reader merges them into "my clips are private and safe" → slides to **"encrypted."**

That last step is false. NIP-44 encryption is stubbed; clips are plaintext JSON in IndexedDB.
Two individually-compliant sentences produced a hard-rule violation. The **Constraints** column
is what catches that, so read it, not just the claim text.

Verified against source 2026-09-02, extension v0.2.3.

---

## Claims

| ID | Claim | Proof | Tracks |
|---|---|---|---|
| C-01 | Captures a text selection, an article, a full page, or a bookmark | `ClipFormat` in `discerned-ext/src/shared/types.ts` | A, B |
| C-02 | Preserves the page's real structure rather than flattening it to plain text | `dx-*` marker system, `discerned-ext/src/content/capture.ts` | A, B |
| C-03 | Handles sites that defeat ordinary clippers — Reddit, YouTube, Hacker News, Stack Overflow, Bluesky, primal.net, Instagram, TikTok, Facebook, Goodreads, Zillow, Etsy, Yelp, phpBB and SMF forums, plus Twitter/X | `SITE_TAGGERS` (16 entries) + two Tier-0 extractors, `capture.ts` | A, B |
| C-04 | Rate what you clip on a five-level signal scale: Toxic, Noise, Ordinary, Worthwhile, Masterpiece | `SIGNAL_LEVELS` in `types.ts` | A, B |
| C-05 | Rating is optional — an unrated clip is valid | `Evaluation.signal?` (optional field) in `types.ts` | A, B |
| C-06 | Tag clips by tone and style, utility and format, or longevity; add your own custom tags | `QUALIFIER_GROUPS` in `types.ts` | A, B |
| C-07 | Sort into categories — eight built in (General, Tech, Finance, Health, Politics, Philosophy, Science, Culture), plus your own | `INITIAL_CATEGORIES`, `discerned-ext/src/background/background.ts:386` | A, B |
| C-08 | Add a personal note to any clip | `note` field, capture flow | A, B |
| C-09 | Clips are stored locally, in your own browser | IndexedDB store, `background.ts` | A, B |
| C-10 | You choose at capture time whether a clip stays local, is published, or both | `PublishMode = 'cast' \| 'local' \| 'both'` in `types.ts` | A, B |
| C-11 | Published casts are signed with your own Nostr key | signing path, `discerned-ext/src/shared/nostr/` | A, B |
| C-12 | Publishes a kind-1 note, plus a companion NIP-23 long-form (kind 30023) note for captures with an article body | `discerned-ext/src/shared/nostr/events.ts` | A |
| C-13 | Sign in with a NIP-07 browser extension, a NIP-46 bunker, or a local key encrypted with a PIN — or use it with no account at all, clip-only | auth modes, `discerned-ext/src/shared/nostr/auth.ts` | A, B |
| C-14 | No account required to start | guest mode, onboarding | A, B |
| C-15 | The public feed at discerned.online can be filtered by signal level, qualifier, category, or the people you follow, narrowed to unread, and searched | `discerned-web/components/feed/CastFeed.tsx` | A, B |
| C-16 | Export your library as JSON; import from JSON or from Evernote `.enex` files | `discerned-web/components/clips/ImportDialog.tsx`, `SettingsModal.tsx` | B |
| C-17 | No analytics in the extension. The website uses GoatCounter — cookieless, no personal data | `marketing/store-listing/STORE-SUBMISSION.md`, `/privacy` | A, B |
| C-18 | The evaluation travels as NIP-32 labels, so other Nostr clients can read it | `baseEvaluationTags` in `events.ts` | A |
| C-19 | Relay list is yours to edit; discovered from your NIP-65 relay list at sign-in | `discerned-ext/src/shared/relays.ts` | A |
| C-20 | The capture pipeline is covered by roughly 60 end-to-end specs, many with pixel baselines | `tests/e2e/`, `discerned-ext/CLAUDE.md` | A, B |

---

## Constraints

These are the "cannot be extended to imply" notes. Violating one of these is how compliant
sentences become false claims.

**C-09 may not be extended to "encrypted", "secure", "safe", or "only you can read it."**
NIP-44 encryption is stubbed. Clips are plaintext JSON in IndexedDB. *Local-only* and *private*
are both true and both sufficient — say those. This is the single most likely error in the whole
registry, because both tracks independently want to reach for it.

**C-13's "encrypted with a PIN" is the one legitimate use of "encrypted" in this project.**
It refers to NIP-49 encryption of a pasted private key (`nip49.encrypt`,
`discerned-ext/src/background/background.ts:895`) — a real, shipped feature. It is a different
thing from the stubbed NIP-44 encryption of clip *contents*. Never let the two blur: the key
is encrypted, the clips are not. If a sentence risks the confusion, say "a local key protected
by a PIN" instead.

**C-02 and C-03 may not be combined with image handling into a link-rot claim about casts.**
Images are inlined into the private clip only. A public cast always links to images at their
original address. Never write that casting preserves images, protects against link rot, or
makes anything permanent.

**C-10 may not be phrased as though a stored clip can be published later.** Casting is
capture-time only; there is no path from a saved clip to a cast. Write "**unless** you cast it",
never "**until** you cast it" — the second promises a feature that does not exist.

**C-04 and C-05 must travel together where there's room.** Presenting the five-level scale
without noting that rating is optional makes the product sound like it demands work on every
save.

**C-11 and C-15 may not be extended into a claim about the publisher population.** No
"thousands of curators", no "readers everywhere", no "a growing community." Describe the
mechanism, not the crowd, until the crowd exists.

**C-15 may not be described as curation, ranking, or reputation.** The feed applies the filters
the reader sets. There is no scoring, no algorithm, no reputation model. "No algorithm deciding
what you see — you decide" is the shipped framing and is accurate.

**C-12, C-18, C-19 are Track A only.** In Track B copy, Nostr is an optional publishing
destination mentioned below the fold — never protocol detail in an opening sentence.

**C-03's site list is a snapshot.** Name only sites with a real handler in `SITE_TAGGERS` or a
Tier-0 extractor, and re-check the registry before publishing a list. Undocumented additions
have happened (Instagram, TikTok, Zillow, Etsy, Yelp, Times of India shipped without reaching
`discerned-ext/CLAUDE.md`'s table).

---

## Planned — must be labelled planned wherever mentioned

Never present these as shipped. Where they appear, mark them explicitly ("planned", "not yet
built"), per the voice rules in `../CLAUDE.md`.

- **Tipping** — send Bitcoin to someone whose discern you valued (NIP-57 zaps).
- **Voting** — agree or disagree with someone else's assessment.
- **Firefox support.**
- **Android and iOS apps.**

The `/about` page's "What's planned" section is the canonical public wording for the first two.

---

## Not shipped — do not mention as available

- **NIP-44 encryption of clips** (stubbed; see the C-09 constraint).
- **Retry on failed relay publish.**
- **Casting a previously-saved clip** (see the C-10 constraint).
- **Kind 30078 encrypted clip events** — the factory can build them; nothing publishes them.

---

## Terminology

Governed by `../CLAUDE.md`, repeated here because this file is the one people actually open:

- A published evaluation is a **discern**, never a "discernment".
- A **clip** is private and local. A **cast** is public and on Nostr. Never blur them.
- **The user evaluates, not the extension.** Never "clips pages and rates them" — it reads as
  automated scoring and invites the "isn't this just AI ranking?" misread from precisely the
  audience most likely to care. Keep the user as the subject, or use the imperative.
- Standard call to action: **"View more discerns at discerned.online"**.
