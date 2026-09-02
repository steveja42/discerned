# Analytics

What can be measured, how, and what can't.

**This folder is committed to a public repo.** Keep genuinely private material out of it — no
revenue figures, nothing about a third party. Aggregate install and publisher counts are fine.

---

## The number to steer by

**Distinct publishers over time.** Everything else is context.

If installs rise while distinct publishers stay flat, the product is being installed and used
privately. That's a legitimate outcome for a local-first clipper — not a failure — but it means
Track A's discovery premise isn't landing, and effort should shift to Track B. No other metric
tells you that.

---

## Sources

### 1. GoatCounter — website only

Cookieless, no personal data, aggregate only. Covers discerned.online; **the extension has no
analytics at all**, by design.

| Metric | Use |
|---|---|
| Sessions, top pages | Baseline traffic |
| **Referrers** | The only channel attribution available. Interpretable only if you log what was posted when — see the campaign log below |
| `/discerns` vs `/clips` split | Proxies discovery-reader vs. installed-user |

### 2. Chrome Web Store dashboard

| Metric | Use | Caveat |
|---|---|---|
| Installs | Cumulative | — |
| Weekly users | Retention proxy | Lags installs by several days |
| Impressions → installs | The only true conversion rate available | Moves with listing changes; note when you edit the listing |
| Ratings, reviews | Also the only qualitative feedback with any volume | — |

### 3. Relay query — discerns published

Count events across the default relays and dedupe by event ID (the same event will come back
from more than one relay).

```
filter: { kinds: [1], '#t': ['discerned'] }
relays: wss://relay.primal.net, wss://nos.lol, wss://relay.snort.social
```

- **Total discerns** = distinct event IDs.
- **Distinct publishers** = distinct `pubkey` values across those events.
- **Discerns per publisher** = the first divided by the second. This separates "many people
  tried it once" from "a few people use it regularly" — situations that call for opposite
  responses.

**Three things to get right:**

- **Don't reuse the app's filter as-is.** `discerned-web/lib/nostr/feed.ts` uses
  `{ kinds: [1, 30023], '#t': ['discerned'], limit: 50 }`. The `limit: 50` is right for a feed
  and wrong for a count — drop it, or page with `until`.
- **Exclude kind 30023 when counting discerns.** A single capture with an article body
  publishes a kind-1 *and* a companion kind-30023, so counting both double-counts. The kind-1
  is the discern.
- **Relays don't guarantee completeness.** A relay may not hold everything, and querying three
  gives a floor, not a total. Track the trend, not the absolute.

Subtract the maintainer's own npub
(`npub12cw6ljs0hu8gz24ajsd5t43pf4h3m3rqdppa8ulvc769ep6gs8lq3mz0aa`) when reporting distinct
publishers — dogfooding casts (A1) are deliberate and shouldn't flatter the number.

---

## Not measurable — be honest about this

A metrics section implying more visibility than exists causes worse decisions than one that
admits blindness.

- **Extension usage of any kind.** Clips made, capture modes used, rated vs. unrated, which
  sites get clipped — all invisible. The largest blind spot, and a deliberate design choice.
- **Clip-vs-cast ratio.** Clips never leave the device, so there is no denominator.
- **Install → first-use conversion.** No install event, no activation event.
- **Retention and churn.** Weekly users is a coarse proxy; nothing finer exists.
- **Cross-device or cross-session identity.** GoatCounter is cookieless by design.
- **True reach of a Nostr post.** No impression data — replies and reposts only.
- **Attribution beyond referrer.** A Show HN spike is visible; a slow burn from an
  AlternativeTo listing largely isn't.
- **Whether a discern came from Discerned** or from another client using the same tag. The
  `client` tag helps; it isn't a guarantee.

---

## Measurement log

Weekly. Append; don't overwrite.

| Date | Installs | Weekly users | Sessions | Discerns | Distinct publishers | Notes |
|---|---|---|---|---|---|---|
| | | | | | | *(no measurements taken yet — first baseline is Phase 3)* |

---

## Campaign log

Every outreach action, so referrer data can be interpreted afterwards.

| Date | Channel | What | Link | Outcome |
|---|---|---|---|---|
| — | nostrapps.com | Directory listing | `../directories/nostrapps.toml` | Submitted |
| — | awesome-nostr / nostr.net | Directory listing, PR #723 | `../directories/awesome-nostr-nostr.net.md` | **Merged — listed.** Link-fix PR #725 open |

Dates are unrecorded for the two entries above; fill them in if you have them. Log everything
from here on, including things that went nowhere — a channel that produced nothing is worth
knowing about before spending time on it again.
