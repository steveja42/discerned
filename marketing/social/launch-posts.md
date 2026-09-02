# Launch posts

Drafts per channel, with each channel's rules noted inline. Claim IDs refer to
`../copy/claims.md`. Run everything past the checklist in `post-template.md` before posting.

**Gating:** the Show HN and Product Hunt drafts are for Phase 4 and should not be posted until
a landing page exists and the feed has visible content. See `../PREREQUISITES.md`. The Nostr
and community drafts are unblocked and can go now.

---

## Nostr — announce, long (A1)

Track A. Post from the maintainer npub.

> I built a browser extension for clipping the web and rating what you clip.
>
> The capture is the part I spent the most time on. Most clippers flatten a page into plain
> text, which throws away the thing you wanted — a Reddit thread's reply structure, a Stack
> Overflow answer's code blocks, a forum post's attribution. Discerned keeps the layout. It has
> dedicated handling for sixteen sites that usually defeat clippers, and generic structure
> detection for the rest.
>
> Once you've clipped something you can rate it — a five-level signal scale, tags, a category —
> though that's optional. Then you choose: keep it local, or cast it to Nostr signed with your
> key. Clips stay in your own browser unless you cast them. The evaluation travels as NIP-32
> labels, so other clients can read it, and a capture with an article body gets a kind-30023
> long-form note alongside the kind-1.
>
> No account needed, nothing scored automatically, no algorithm on the feed — you filter it
> yourself.
>
> Chrome/Chromium for now, Firefox planned. Free and open source.
>
> View more discerns at discerned.online

*[C-01, C-02, C-03, C-04, C-05, C-09, C-10, C-11, C-12, C-14, C-18]*

---

## Nostr — announce, short (A1)

For reposting, or when the long one is too much.

> A browser extension that clips web pages with their layout intact — Reddit threads, forum
> posts, code blocks and all — lets you rate what you saved, and publishes your picks to Nostr
> signed with your own key. Or keeps them entirely local, which is the default.
>
> discerned.online

*[C-02, C-03, C-04, C-09, C-10, C-11]*

---

## Nostr — ongoing casts (A1, the actual work)

**This is the channel that matters, and it isn't an announcement.** Cast real discerns on a
regular cadence: things you genuinely read and rated. Each one demonstrates the product and
adds inventory to a feed that is otherwise sparse.

No template — a real discern with a real note is the whole point. The occasional one can
mention the tool; most shouldn't.

---

## Nostr communities and topic spaces (A2)

**Rules:** effective only after A1 has built a visible posting history. Cold-posting a launch
into a space you've never participated in reads as spam here as anywhere.

Use the short announce above, adapted to what the space is about. In a reading- or
curation-focused space, lead with the evaluation and the feed. Don't post the same text into
several spaces the same day.

---

## PKM / tools-for-thought communities (B3)

**Rules — read these before writing anything.** These communities are strongly anti-drive-by. A
first post that is an announcement gets removed or ignored. **The entry is answering an existing
question, not posting.**

The question to watch for is some variant of *"what clipper actually handles Reddit / Hacker
News / forums properly?"* — which Discerned genuinely does, so the answer is honest rather than
promotional.

**Reply shape:**

> Most clippers flatten those into prose and lose the thread structure. I ended up writing one
> that keeps it — [Discerned](https://chromewebstore.google.com/detail/discerned/gpfeknmodijdlehpnkfannklhplmfoma).
> It has specific handling for Reddit, HN, Stack Overflow and a few forum engines, so replies
> stay nested and code blocks stay code blocks. Clips are stored locally, no account.
>
> Fair warning that I wrote it, and it's Chrome-only right now.

*[C-02, C-03, C-09, C-14]*

**Disclose that you made it, every time.** In these communities an undisclosed self-recommendation
is the one unrecoverable mistake.

---

## Subreddits (B4)

**⚠️ Read the sidebar and the wiki the same day you post. Every time.** Rules vary sharply
between subs and change without notice. Some ban self-promotion outright; others require a
participation ratio, specific flair, or a designated weekly thread. Posting into a no-self-promo
sub gets the post removed, the account flagged, and sometimes a shadowban that quietly kills all
future Reddit reach.

**Never cross-post the same body to several subs at once** — Reddit's spam heuristics treat that
as spam regardless of what individual sub rules allow. Space them out, and vary the text.

Prefer subs with an explicit showcase or "what are you working on" thread. That's a sanctioned
entry point and costs nothing.

**Body (adapt per sub):**

> **I got annoyed that web clippers mangle Reddit threads, so I wrote one that doesn't**
>
> Most clippers flatten a page into plain text and lose the structure — nested replies, code
> blocks, attribution. This one keeps the layout, with specific handling for about sixteen
> sites that usually break clippers (Reddit, HN, Stack Overflow, Bluesky, YouTube, phpBB
> forums, others).
>
> You can rate and tag what you save if you want, or not. Clips are stored locally in your
> browser — no account, no analytics in the extension, export to JSON whenever. There's an
> optional publishing side that puts your ratings on Nostr signed with your own key, but you
> can ignore that entirely.
>
> Chrome/Chromium only for now, Firefox planned. Free, open source, I'm the only one working
> on it.

*[C-02, C-03, C-04, C-05, C-09, C-14, C-16, C-17]*

The "Chrome only for now" line stays. It pre-empts the first reply and buys credibility.

---

## Show HN (B5) — **gated, Phase 4**

**⚠️ One shot, non-renewable.** Don't post until a landing page exists and the feed isn't empty.

**Rules:** the maker must post it. Title must not editorialize — no superlatives, no marketing
language. It should say what the thing is.

**Title:**
> Show HN: Discerned – a web clipper that keeps the page's layout

**First comment:**

> I kept clipping Reddit threads and Stack Overflow answers and getting back unreadable prose —
> the reply nesting gone, code blocks flattened, attribution lost. So the bulk of the work here
> is the capture: it walks the live DOM, tags structure with markers that survive sanitisation,
> and reassembles it. There's dedicated handling for sixteen sites that defeat generic
> extraction, and about sixty end-to-end tests with pixel baselines, because sites redesign
> without warning and a silently degraded capture is easy to miss.
>
> On top of that you can rate what you clipped — a five-level scale, tags, a category — all
> optional. Clips are stored locally in the browser; there's no account and no analytics in the
> extension.
>
> There's a publishing side that casts a clip and its rating to Nostr, signed with your own key,
> as a kind-1 note plus a NIP-23 long-form note. That's opt-in and chosen at capture time; if
> you never touch it, it's a local clipper.
>
> Known limits: Chrome/Chromium only for now, Firefox planned. Private clips are local but not encrypted
> — that's designed and not built. And you can't cast a clip you saved earlier; publishing is
> decided when you capture.
>
> Free, GPL-3, one person. Happy to answer anything about the capture pipeline, which is where
> all the interesting failures are.

*[C-01–C-05, C-09, C-10, C-11, C-12, C-14, C-17, C-20]*

**Lead the clipper, not Nostr.** If Nostr leads, the thread becomes a protocol argument instead
of a product conversation. **Expect "why not Obsidian Web Clipper?"** — the answer is layout
preservation on sites that defeat ordinary clippers, and it's demonstrable rather than asserted.

The known-limits paragraph is not optional. HN finds those anyway, and finding them yourself is
worth more than the space it costs.

---

## Product Hunt (B6) — **gated, Phase 4**

**⚠️ One shot.** Ranked last deliberately — Product Hunt rewards pre-built follower lists,
which a zero-budget solo project doesn't have. Worth doing for the backlink and the evergreen
listing, not for launch-day traffic. **Don't post it the same week as Show HN.**

**Tagline (60 char max):**
> A web clipper that keeps the page's real layout *(47)*

**Description (260 char max):**
> Clip articles, selections, or whole pages with their structure intact — Reddit threads, code
> blocks, forum posts and all. Rate and tag what you save. Clips stay local in your browser; no
> account. Publish your picks to Nostr if you want, signed with your key. *(258)*

**Maker comment:** adapt the Show HN first comment, cutting the technical detail by about half.
Product Hunt's audience wants the shape of the thing, not the capture pipeline.

*[C-01, C-02, C-03, C-04, C-06, C-09, C-10, C-11, C-14]*

---

## After posting

Log it in `../analytics/README.md` — date, channel, link. Referrer data in GoatCounter is the
only channel attribution available, and it's only interpretable if you know what was posted
when.
