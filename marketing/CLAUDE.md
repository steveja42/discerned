# CLAUDE.md — Marketing

Positioning, voice, and marketing materials for Discerned. **Read this before writing any
user-facing copy**, in this folder or in the app — the terminology rules below are hard
constraints, not preferences, and several of them contradict what the product used to be.

**This folder is committed to a public GitHub repo.** Anything written here is visible to
anyone. Draft copy, taglines, and store listings are fine; keep genuinely private material
(revenue figures, unannounced plans, anything about a third party) out of it — `analytics/`
especially.

Nothing here is built or deployed. Netlify's `ignore` rule
(`git diff --quiet … -- discerned-web` in `discerned-web/netlify.toml`) scopes deploys to
`discerned-web/`, so commits under `marketing/` never trigger a build. Keep it that way: if
a marketing asset needs to ship, it goes in `discerned-web/public/`, not here.

## Layout

| Folder / file | Holds |
|---|---|
| `STRATEGY.md` | The marketing plan: positioning, the two tracks, ranked channels, timeline, metrics |
| `PREREQUISITES.md` | Product gaps that block conversion — recommendations, not commitments |
| `store-listing/` | Chrome Web Store submission checklist, promo tiles, marquees |
| | *(screenshots live in `discerned-web/public/press/` — served from discerned.online)* |
| `directories/` | Third-party app-directory submissions (nostrapps.com, …), as submitted |
| `press-kit/` | One-pager, boilerplate description. *(No image files — icons and screenshots are served from discerned.online; see its README.)* |
| `copy/` | Taglines, elevator pitches, feature blurbs — and **`copy/claims.md`, the canonical claim registry** |
| `social/` | Launch posts, Nostr/X threads |
| `analytics/` | Install numbers, notes on what landed |
| `archive/` | **Superseded drafts. Historical only — do NOT quote from these.** See below. |

## The archive is stale and contradicts the shipped product

`archive/` holds four pre-launch documents kept for reference. Every one of them describes a
product that no longer exists. They are the single biggest source of wrong copy, because they
read like finished marketing.

- **`marketing.md`**, **`copy-main.md`** — the "WorthCast" brand, a **two-axis** Interest +
  Ethics model, and kind-9802 highlights.
- **`Brower Extension Implementation.md`** — a developer spec with the same two-axis UI, plus
  NIP-32 labelling and kind-10003 library indexes.
- **`jungle.md`** — the original Goodreads-scraper concept, before the product became a
  general web capture tool.

What actually changed: the name is **Discerned**, evaluation is **Signal + Qualifiers +
Category** (not Interest/Ethics), and nothing publishes kind 9802. Mine these for *tone* if
you like — "signal vs. noise" survived and is still the core hook — but verify every product
claim against the source before reusing a sentence.

## Terminology — hard rules

**"Discerns", never "discernments".** A published evaluation is a *discern*, the way a
published post is a tweet. Standard call to action: "View more discerns at discerned.online".

**Clip vs. Cast.** A **clip** is private, stored in the user's own browser. A **cast** is
public, published to Nostr relays. Never blur these — the distinction is the product.

**Casting is capture-time only.** There is no path from a stored clip to a cast. Copy must
never imply clips are queued or waiting to be published. Write "**unless** you cast it", never
"**until** you cast it" — the second promises a feature that does not exist.

**Signal levels are the five shipped names**, in order: Toxic, Noise, Ordinary, Worthwhile,
Masterpiece. Signal is optional — an unrated clip is valid, so don't describe rating as
mandatory. The definitive list is `SIGNAL_LEVELS` in
`discerned-ext/src/shared/types.ts` — check it rather than trusting this file.

**The user evaluates, not the extension.** Discerned does not clip or rate anything on its
own — it is the instrument, the user is the agent. Never write "clips pages and rates them":
it reads as automated scoring, which is the opposite of the product (human judgment, signed
by a human key) and invites the "isn't this just AI ranking?" misread from exactly the
audience most likely to care. Keep the user as the subject — *lets you clip*, *rate it
yourself*, *your evaluation* — or use the imperative, which addresses them directly:
"Clip anything on the web, rate it, publish your picks."

**Spell out acronyms** on first use. NIP-07, npub, and DOM are fine unglossed; anything less
common gets written out.

**Images: clips only.** Inlined images live in the private clip. A public cast links to images
at their original address, always. Never claim casts preserve images against link rot.

**Encryption is not shipped.** NIP-44 encryption is stubbed — clips are plaintext JSON in
IndexedDB. The archive's "military-grade encryption" and "not even us can see it" lines are
false today. Local-only and private are both true and both sufficient; say those instead.

## Voice

Plain and concrete. The product is a small independent tool, and copy that oversells it reads
as untrustworthy to exactly the audience most likely to install it. Prefer a verifiable claim
over a grand one.

Avoid: "military-grade", "revolutionary", "the future of", stacked superlatives, and any
capability that is stubbed or planned. If a claim can't be checked against shipped code,
either cut it or mark it as planned in the copy itself.

## Links

**Lead with `discerned.online`, not the GitHub repo.** Where a listing takes one primary link,
it goes to the web app. A repo as the headline link reads as source-only — an unfinished
project — to someone scanning a directory of usable apps. In awesome-nostr the entries leading
with a repo are the ones with no product to point at; the shipped ones (Deepmarks, Pinstr,
Ditto) all lead with their site.

Put the repo in a separate field where the format has one (`source` in nostrapps' TOML), or
in the description as "Open source" where it doesn't. Same for the Chrome Web Store link:
secondary, never the headline.

## Before shipping copy

1. Check the terminology rules above, and run the copy past `copy/banned-phrases.md`.
2. **Every product claim must trace to an ID in `copy/claims.md`** — that file is the canonical
   registry and records the source file proving each claim. If you need to say something new,
   add the row with its proof first. Read its **Constraints** section too, not just the claim
   rows: the likeliest error is two individually-true sentences combining into a false one
   (private + you-own-it reading as *encrypted*, which is not shipped).
3. Verify product claims against source — `SIGNAL_LEVELS` and `QUALIFIER_GROUPS` in
   `discerned-ext/src/shared/types.ts`, `INITIAL_CATEGORIES` in
   `discerned-ext/src/background/background.ts`.
4. If the copy also appears in the app, edit `discerned-web/lib/marketing-copy.tsx` — the
   `PITCH` constant feeds both the first-visit popover and the About page hero. Copy that
   lives in two places drifts.
5. Store-listing copy is version-coupled. Bump it in the same commit as
   `discerned-ext/manifest.json`, `discerned-ext/package.json`, `discerned-web/package.json`.
