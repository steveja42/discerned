# Prerequisites

Three things outside the `marketing/` folder that affect whether marketing effort converts.

**These are recommendations, not commitments.** Nothing here is scheduled and nothing here is
required for Phases 0–3 of `STRATEGY.md`. They are listed because two of them gate the one-shot
channels (Show HN, Product Hunt), which cannot be re-run once spent.

Verified 2026-09-02.

---

## (a) No landing page to send campaign traffic to

**There is no URL that explains the product to someone who has never heard of it.** `/about` is
the closest thing, but nothing routes to it by default: `discerned-web/app/page.tsx` redirects
`/` to `/discerns`, so anyone arriving at the bare domain lands in a feed of strangers' clips.

**Severity: blocking for one-shot channels.** Repeatable channels (Nostr posts, directory
listings, store search) are unaffected — they carry their own context or point at the Web Store
listing.

### A landing page does not have to be at `/`

Two separable problems, and only the first is blocking:

- **A destination for campaign links.** Any route works. Links can point anywhere.
- **What the bare domain does.** Matters for someone typing "discerned.online" or following an
  unlinked mention, but no campaign depends on it.

The root redirect is also doing real work — it preserves the query string so the extension's
`/?signin=1` auto-sign-in keeps functioning, and a static export can't redirect server-side.
Changing it means preserving that.

### Prefer several landing pages to one

A static export gives you a real page per route at no cost — `/l/clipper`, `/l/nostr` — each
independently linkable and fully cacheable. That suits this project better than one page:

- **The two tracks want different leads.** Track B opens on layout-preserving capture; Track A
  opens on signing with your own key. A single page serving both dilutes each.
- **It's the only channel attribution available.** GoatCounter gives referrer and path. A
  distinct path per channel tells you which one sent traffic *and* whether that page converted.
  One shared URL collapses that.

### Split-testing one URL doesn't work here, and wouldn't help yet

A/B testing normally means one URL serving variant A to half of visitors and B to the rest. The
static export can't do that server-side — no API routes, no server actions, no middleware.
The workarounds are all compromised: a client-side split flashes the wrong variant and is
invisible to GoatCounter, which counts one URL; Netlify's split testing is branch-based, so each
variant becomes a branch to keep alive.

More to the point, **there isn't enough traffic for a valid test.** Detecting a realistic
conversion difference needs hundreds of conversions per arm. Splitting a new extension's traffic
in two keeps both arms underpowered indefinitely, and the result is noise read as signal — the
trap the metrics section already warns about.

Distinct per-channel URLs are not a controlled experiment, but they are honest attribution,
which is the thing actually missing.

**Cheapest resolution:** one page at a fixed route, linked from campaign posts. The pitch, the
flow, and a "Get the extension" button already exist in `discerned-web/lib/marketing-copy.tsx`
and `app/about/page.tsx`, so this is mostly routing, not writing. Add per-channel variants later
if the attribution turns out to be worth the pages. What `/` does can stay as it is.

---

## (b) Empty-feed cold start

A first-time visitor with no Nostr identity and no follows sees whatever exists globally under
`{ kinds: [1, 30023], '#t': ['discerned'] }` — the filter in `discerned-web/lib/nostr/feed.ts`.
Today that is sparse.

This is the classic discovery-product cold start, and it compounds (a): a visitor arriving from
a link lands on an unexplained page that is also nearly empty. That combination is a worse
outcome than not posting at all, which is why the one-shot channels are gated on it.

**Severity: blocking for one-shot channels.**

**Cheapest partial mitigation is A1 in `STRATEGY.md`** — cast real discerns on a regular
cadence from the maintainer npub. Each cast is simultaneously a product demonstration and feed
inventory. Nothing else on the plan addresses this at zero cost, which is the main reason A1
leads Track A now that the directory work is finished.

A fuller resolution would be an empty/near-empty state on `/discerns` that explains what the
feed is and what a discern looks like, rather than rendering a short list with no framing. Not
proposed here — flagging that the empty state is a marketing surface, not just a UI edge case.

---

## (c) `discerned-ext/UI-TEXT.md` has drifted from shipped strings

Two confirmed mismatches:

| UI-TEXT.md says | Shipped string |
|---|---|
| "A web clipper with a Signal Rating. Keep what's worth reading, skip the rest, and publish your ratings when you choose." | `manifest.json`: "Web clipper for saving articles, quotes and pages. Rate and tag what you clip, and publish your picks to Nostr if you want." |
| "Clip it, rate it, keep it. Build your own library of what's worth reading." | `onboarding.html:193`: "Clip it, rate it, keep it, share it. Build your own library of high-quality information." |

The line reference is stale too — UI-TEXT.md cites `onboarding.html#L140`; the tagline is now at
line 193.

**Severity: non-blocking.** This is copy integrity, not conversion. It matters here because
`STORE-SUBMISSION.md` names UI-TEXT.md as a claim-discipline source, and `copy/claims.md` cites
source files as proof. A drifted proof source quietly weakens the registry.

**Resolution:** treat the source files as canonical (they are), and either refresh UI-TEXT.md
or note in it that it is a snapshot rather than the source of truth.

---

## Summary

| # | Blocker | Severity | Effort |
|---|---|---|---|
| (a) | No landing page for campaign links (any route; needn't be `/`) | Blocking for Show HN / Product Hunt | Small; routing + existing copy |
| (b) | Empty-feed cold start | Blocking for Show HN / Product Hunt | Ongoing; mitigated by A1 |
| (c) | UI-TEXT.md drift | Non-blocking; weakens claim proofs | Small |

Phases 0–3 of `STRATEGY.md` run regardless of all three. Phase 4 fires only when (a) and (b)
are resolved.
