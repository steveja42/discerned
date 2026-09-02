# Banned phrases

Read this before posting anything. It should take twenty seconds.

Every row is a phrase that is **false**, **forbidden by `../CLAUDE.md`**, or **reliably
misread**. The right-hand column is what to write instead — not a softer version of the same
claim, but the true claim that sits nearest to it.

| Never write | Write instead | Why |
|---|---|---|
| encrypted · secure · safe · "not even we can see it" · "only you can read it" | local-only · private · stored in your own browser | NIP-44 is stubbed. Clips are plaintext JSON in IndexedDB. See constraint on C-09. |
| discernments | discerns | A published evaluation is a *discern*, the way a published post is a tweet. |
| until you cast it | unless you cast it | "Until" promises that a saved clip can be published later. It cannot — casting is capture-time only. |
| "clips pages and rates them" · "automatically evaluates" · "scores content" | lets you clip · rate it yourself · your evaluation | The user is the agent; the extension is the instrument. The banned forms read as automated scoring and invite the "isn't this just AI ranking?" misread. |
| military-grade · bank-level · enterprise-grade | (cut entirely) | Overclaiming, and in this case also false. |
| revolutionary · the future of · game-changing · reimagining | (cut entirely) | The voice rules forbid it, and it reads as untrustworthy to the audience most likely to install this. |
| thousands of curators · readers everywhere · a growing community · join thousands | (describe the mechanism, not the crowd) | Don't characterise the publisher population until it exists. |
| curated feed · ranked · reputation score · our algorithm surfaces | filter the feed by signal, qualifier, category, or who you follow | There is no ranking, curation, or reputation model. "No algorithm deciding what you see — you decide" is accurate and is the shipped framing. |
| your images are preserved forever · protects against link rot · permanent archive | images are stored inside your private clip; a cast links to images where they already live | Inlining is clips-only. Casts always hotlink. |
| saved to the blockchain · on-chain · crypto wallet | published to Nostr · signed with your key | Nostr is not a blockchain and there is no wallet. This misread is the main Track B risk. |
| free forever · no ads ever · we will never | free, no ads, nothing sold (present tense) | Don't make promises about the future of a one-person project. |
| seamlessly · effortlessly · just works · magic | (cut, or say what it actually does) | Empty intensifiers. If the capture handles Reddit's comment threads, say that. |

---

## Also watch for

**Stacked superlatives.** One accurate adjective beats three vague ones. "Captures Reddit
threads with their comment structure intact" is better than "beautifully preserves rich
content perfectly."

**Planned features stated flat.** Tipping, voting, Firefox, and Android/iOS are planned, not
shipped. Every mention needs the label. NIP-44 encryption and publish-retry aren't planned
enough to mention at all.

**Unglossed acronyms.** NIP-07, npub, and DOM are fine bare. Anything less common gets written
out on first use — and in Track B copy, most Nostr vocabulary counts as less common.

**"Just."** "Just install the extension" and "it just saves the page" both shrink the thing you
are trying to get someone to value.

---

## The merge failure

The subtlest error isn't a banned phrase — it's two permitted sentences that combine into a
false one. The live example: "your clips stay on your device" (true) plus "you own your data,
nothing on a company's server" (true) reads as *encrypted* (false).

Check the **Constraints** section of `claims.md`, not just this table. A phrase can pass this
list and still make a claim the product can't support.
