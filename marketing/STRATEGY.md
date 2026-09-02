# Marketing strategy

How Discerned gets in front of people, who those people are, and what we're allowed to say.

**This is strategy, not copy.** Copy lives in `copy/`. Every product claim in any material
traces to an ID in `copy/claims.md` — that file is canonical and this one defers to it.

Written 2026-09-02 against extension v0.2.3. Sized for one maintainer at 2–4 hrs/week, zero
budget.

---

## 1. What Discerned is

A Chrome extension plus a companion web app. You clip something you're reading — a selection,
an article, a full page, or just a bookmark — optionally rate it, tag it, and file it under a
category, and then choose whether it stays on your machine, gets published to Nostr, or both.
Private clips are **clips**; published ones are **casts**, and a published evaluation is a
**discern**.

The shipped tagline is in `discerned-web/lib/marketing-copy.tsx`:

> **A value-attribution layer for the web** — Signal, *not noise*.
> Discerned is powered by a browser extension that lets you clip and rate anything on the web.
> See what your friends and follows love and hate.

That `PITCH` constant feeds both the About page hero and the first-visit popover. **Changing
the shipped tagline is a code edit**, not a marketing-folder edit — and doing it in one place
only is how the two drift.

---

## 2. Non-negotiable rules

Reproduced from `CLAUDE.md` rather than linked, because a strategy doc that only links to its
constraints gets read without them. `copy/banned-phrases.md` is the operational version.

- **"Discerns", never "discernments".** Standard call to action: "View more discerns at
  discerned.online".
- **Clip = private and local. Cast = public and on Nostr.** Never blur them; the distinction is
  the product.
- **Casting is capture-time only.** Write "**unless** you cast it", never "**until** you cast
  it" — the second promises a feature that does not exist.
- **The user evaluates, not the extension.** Never "clips pages and rates them". Keep the user
  as the subject, or use the imperative.
- **NIP-44 is stubbed.** Never "encrypted", "secure", or "not even us can see it". Say
  local-only, private.
- **Images inline into clips only.** A cast links to images at their original address. Never
  claim casts survive link rot.
- **Don't describe the publisher population** until it exists. No curation, ranking, or
  reputation claims.
- **Voice: plain, concrete, verifiable.** No "military-grade", "revolutionary", "the future
  of", stacked superlatives, or stubbed capability presented as shipped.
- **Spell out uncommon acronyms** on first use.
- **Not shipped:** NIP-44, publish retry, casting a saved clip.
  **Planned and must be labelled planned:** Bitcoin tipping (NIP-57 zaps), voting on discerns,
  Firefox, Android and iOS.

---

## 3. The two tracks

Both run at once. They differ in what leads, not in what's true.

| | **Track A — Nostr-native** | **Track B — Web clipper / PKM** |
|---|---|---|
| **Who** | People already on Nostr; sovereignty-minded, key-owning, protocol-literate | People who clip and keep things: Evernote and Pocket refugees, researchers, writers, note-takers |
| **Where** | Nostr itself, Nostr app directories, curation- and reading-focused communities | Chrome Web Store search, AlternativeTo, PKM and tools-for-thought communities, Hacker News |
| **Lead claim** | Your evaluation, signed by your key, on a network no company owns (C-11, C-13, C-18) | A web clipper that keeps the page's real layout — including sites that defeat ordinary clippers (C-02, C-03) |
| **Lead artifact** | A real cast discern, visible in any Nostr client | The Chrome Web Store listing |
| **Nostr appears** | First sentence | Below the fold, as an optional destination |
| **Misread to avoid** | *"another Nostr client"* — it's a capture tool that publishes to Nostr, not a general client | *"a crypto thing"* — no blockchain, no wallet, no token |

Track A's one-sentence framing already exists, merged upstream in
`directories/awesome-nostr-nostr.net.md`. Reuse its wording rather than inventing a new one.

For Track B, **"web clipper" is the load-bearing phrase** — it's what people search the Web
Store for, and it's the category they already understand. Lead with it.

---

## 4. Keeping the tracks from drifting

Two parallel tracks fail in a way that isn't obvious: not as tonal inconsistency, but as **a
claim that is true in one track's framing and false in the other's**.

The live example in this product:

- Track B: "your clips stay private on your device." True.
- Track A: "you own your data; nothing sits on a company's server." Also true.
- The reader merges them into "my clips are private and safe" → **"encrypted."** False. NIP-44
  is stubbed; clips are plaintext JSON in IndexedDB.

Two individually-compliant sentences produced a hard-rule violation, and no amount of tonal
consistency would have caught it.

**The mechanism is `copy/claims.md`.** Every claim has an ID, its exact wording, the source file
that proves it, which tracks may use it, and any "cannot be extended to imply X" constraint.
The rule: **no sentence ships that isn't traceable to a claim ID.** When a new claim is needed,
the row goes in first, with its proof.

---

## 5. Prerequisites

Three things outside `marketing/` affect conversion; they're detailed in `PREREQUISITES.md`.
Two of them — no landing page, and a sparse feed for a first-time visitor — gate the one-shot
channels. The third is a copy-integrity issue that weakens the claim registry's proofs.

**The one sequencing consequence:** one-shot channels (Show HN, Product Hunt) are gated on
those two being resolved. Everything repeatable runs now, regardless. You can't re-Show-HN,
and sending a burst of cold traffic to an unexplained near-empty feed spends a non-renewable
channel for nothing.

---

## 6. Channels

Every numbered row is actionable this quarter.

### Track A — Nostr-native

| # | Channel | Effort | Requires | Notes |
|---|---|---|---|---|
| **A1** | **Nostr posts from the maintainer npub** | 30 min, repeatable | The claim set | **Track A's lead activity.** The only genuinely repeatable channel and the only one that compounds. Dogfooding *is* the strategy: each real discern cast is simultaneously a product demo and feed inventory — the cheapest thing on this plan that addresses the cold-start problem. |
| **A2** | **Nostr community and topic spaces** (curation, reading, long-form) | 30 min each | Posting history from A1 | Effective only after A1 builds a visible history. Cold-posting a launch into a community you've never participated in reads as spam on Nostr as anywhere else. |
| **A3** | **Watch awesome-nostr PR #725** | ~0 | Already open | A tracking item, not a campaign task. PR #723 is merged and Discerned is listed on nostr.net; #725 only fixes the link. Keep `directories/awesome-nostr-nostr.net.md` in sync when it lands, per that folder's "entry as submitted" rule. |

**Track A's directory work is done** — nostrapps.com submitted, awesome-nostr merged,
nostr.co.uk dropped. There's no quick win left to open with, which is why A1 is an ongoing
practice rather than a one-off task. Slower payoff, but it's the only Nostr-side activity that
builds anything.

### Track B — Web clipper / PKM

| # | Channel | Effort | Requires | Notes |
|---|---|---|---|---|
| **B1** | **Chrome Web Store listing optimization** | 2–3 hrs | Nothing — unblocked | **Highest-leverage item on either track.** It's already the destination every other Track B channel funnels into, so a weak listing taxes all of them, and it's the only channel with compounding organic yield. Tune the 132-char description toward "web clipper" search intent; make sure screenshots show the capture quality, which is the actual differentiator. |
| **B2** | **AlternativeTo** | ~1 hr | Live product + listing URL | Low effort, evergreen, exact intent match — "alternative to Evernote Web Clipper / Pocket". Pocket's shutdown makes this well-timed. Self-submission is normal and accepted there. |
| **B3** | **PKM / tools-for-thought communities** (Obsidian, Zettelkasten, note-taking forums and Discords) | 1 hr each | Participation history | ⚠️ Strongly anti-drive-by. A first post that is an announcement gets removed or ignored. The workable entry is **answering an existing question** — "what clipper handles Reddit threads properly?" — which Discerned genuinely does (C-03). Requires patience, not effort. |
| **B4** | **Subreddits** | 1 hr each | Per-sub rule check, same day | ⚠️ **Biggest trap on the list.** Rules vary sharply and change. Some relevant subs ban self-promotion outright; others require a participation ratio, flair, or a specific weekly thread. Posting into a no-self-promo sub gets the post removed, the account flagged, and sometimes a shadowban that quietly kills *all* future Reddit reach. **Read the sidebar and wiki the same day you post, every time.** Prefer subs with an explicit showcase thread. Never cross-post the same body simultaneously — Reddit's spam heuristics treat that as spam regardless of individual sub rules. |
| **B5** | **Show HN** | 2 hrs | **Gated** (Phase 4) | One shot, non-renewable. Lead clipper; let Nostr be the second paragraph or the thread becomes a protocol argument instead of a product conversation. Prepare for "why not Obsidian Web Clipper?" — the answer is layout preservation on sites that defeat ordinary clippers, which is demonstrable rather than asserted. |
| **B6** | **Product Hunt** | 3–4 hrs | **Gated** (Phase 4) | One shot. Effort is disproportionate for a free developer tool with no launch-day audience to mobilise; PH rewards pre-built follower lists, which a zero-budget solo project doesn't have. Ranked last deliberately — worth doing eventually for the backlink and the evergreen listing, not for launch-day traffic. |

### If you only do four things

**B1 → B2 → A1 → B3.** All unblocked, all repeatable or evergreen, under six hours to start.
With the directory work finished, the store listing is the highest-leverage remaining item
because it's where every other Track B channel points.

### Not enterable — don't rediscover these dead ends

- **Zapstore** — an Android app store. Discerned is a Chrome extension; Android is planned, not
  shipped.
- **Lobsters** — invite-only, and harsh on self-promotion from new accounts. Opportunistic at
  best.
- **NostrHub** — lists apps from their NIP-89 kind-31990 handler announcements. Publishing one
  is **deliberately excluded**; the reasoning is documented in `directories/README.md` and
  should not be re-litigated here.

---

## 7. Timeline

| Phase | Weeks | Hours | Work | Done when |
|---|---|---|---|---|
| **0 — Foundation** | 1–2 | 5–7 | `copy/claims.md`, `copy/banned-phrases.md`, `PREREQUISITES.md`. | Claim registry exists |
| **1 — Unblocked channels** | 3–5 | 6–9 | `copy/pitches.md`, `copy/feature-blurbs.md`. Tune the store listing (B1). Submit AlternativeTo (B2). Begin casting (A1). | Listing tuned, AlternativeTo submitted, casting started |
| **2 — Presence & inventory** | 6–10 | 8–12 | Sustain A1 on a regular cadence. Write `press-kit/*`. Begin B3 participation — answering, not announcing. Directly builds feed inventory. | Visible posting history; press kit complete |
| **3 — Repeatable outreach** | 11–14 | 6–10 | Write `social/*`. Enter A2 and B4, staggered — never simultaneous. Set up `analytics/README.md`, take the first measurement. | First baseline metrics recorded |
| **4 — One-shot channels** | **Gated, not dated** | 6–8 | **Only once a landing page exists and the feed has visible content:** Show HN (B5), then Product Hunt (B6) some weeks later, never the same week. | — |

Phase 4 fires on a condition, not a calendar. **If the prerequisites are never resolved, Phases
0–3 still constitute a complete campaign** — that's the point of sequencing this way.

---

## 8. Metrics

### Measurable

| Metric | Source | Cadence |
|---|---|---|
| Sessions, top pages | GoatCounter (cookieless, website only) | Weekly |
| Referrer breakdown | GoatCounter — the only channel attribution available | Per campaign action |
| `/discerns` vs `/clips` split | GoatCounter — proxies discovery-reader vs. installed-user | Monthly |
| Installs, weekly users | Web Store dashboard (weekly-users lags installs) | Weekly |
| Impressions → installs | Web Store dashboard — the only true conversion rate | Monthly |
| Ratings and reviews | Web Store listing — also the only qualitative feedback with volume | Weekly |
| **Total discerns published** | Relay query, deduped by event ID | Weekly |
| **Distinct publishers** | Distinct `pubkey` in that result — **the number to steer by** | Weekly |
| Discerns per publisher | Derived — separates "many tried once" from "a few use it" | Monthly |

The exact relay query and method live in `analytics/README.md` so the figure is reproducible
rather than re-derived each time.

### Not measurable — say so plainly

A metrics section implying more visibility than exists causes worse decisions than one that
admits blindness.

- **Extension usage of any kind.** No analytics in the extension, by design. Clips made, capture
  modes used, rated vs. unrated, sites clipped — all invisible. The largest blind spot, and
  deliberate.
- **Clip-vs-cast ratio.** Clips never leave the device, so there's no denominator.
- **Install → first-use conversion.** No install event, no activation event.
- **Retention and churn.** Web Store weekly-users is a coarse proxy; nothing else exists.
- **Cross-device or cross-session identity.** GoatCounter is cookieless by design.
- **True reach of a Nostr post.** No impression data — replies and reposts only.
- **Attribution beyond referrer.** A Show HN spike is visible; a slow burn from AlternativeTo
  largely isn't.
- **Whether a discern came from Discerned** or another client using the same tag. The `client`
  tag helps; it isn't a guarantee.

**Steer by distinct publishers over time.** If installs rise while publishers stay flat, the
product is being installed and used privately — a legitimate outcome for a local-first clipper,
not a failure, but it means Track A's discovery premise isn't landing and effort should move to
Track B.

---

## 9. Explicitly not doing

- **Paid anything** — ads, promoted listings, sponsored posts, PR agencies, contractors.
- **A content calendar.** A solo maintainer won't execute one, and an unexecuted calendar in a
  public repo reads as a broken commitment.
- **A newsletter.** Nothing to send yet, and it's a recurring obligation.
- **Influencer or "growth" outreach.**
- **A NIP-89 kind-31990 handler** — see `directories/README.md`. Settled; don't re-litigate.
- **Describing the user base.** Not until there is one to describe.
