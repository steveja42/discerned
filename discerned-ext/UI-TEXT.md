# UI text — Discerned extension

Every string the user can read, grouped by where it appears. Source file and line are
given per section so a text change can be traced to the code that renders it.

Two registers live here and should be edited differently: **marketing text** (taglines,
the gate, the connect intro) is persuasive and free to rewrite; **functional text**
(validation errors, status lines, the key-backup warning) is UX and safety text where
precision matters more than tone.

**Scope:** the extension only. The web app (`discerned-web/`) has its own copy, and the
Chrome Web Store "detailed description" (the long listing field) lives in the Web Store
dashboard, not in this repo — see the gap noted at the end.

**Vocabulary rule.** *Publish* is used before the user has learned the product (store
listing, onboarding, the connect flow); *cast* is used inside the product, once the
Clip/Cast slider has taught the term. Both refer to the same action.

**Claim discipline.** Clips are **not encrypted at rest** — the IndexedDB row's field is
named `encrypted` but holds plaintext JSON (NIP-44 is stubbed). Copy therefore says
"stays on this device", never "encrypted", "secure", or "only you can read". The one real
encryption is the stored private key (NIP-49, PIN-derived), and only that copy says so.
Ownership and portability are attributed to **Nostr**, which delivers them; Discerned
itself promises no reputation score and no follow graph.

---

## 1. Chrome Web Store listing

`manifest.json` — [name + description](manifest.json#L3-L5)

| Field | Text |
|---|---|
| Name | Discerned |
| Description (132 char max; currently 124) | Web clipper with ratings and publishing. Rate what's worth reading, keep a private library, publish to Nostr when you choose. |

Shown in store search results, on the store item page, in `chrome://extensions`, and in
the puzzle-piece menu. Also indexed by store search — "web clipper" is the load-bearing
phrase.

---

## 2. Onboarding page

Opens in a tab on first install. [src/onboarding/onboarding.html](src/onboarding/onboarding.html)

| Element | Text |
|---|---|
| Title (browser tab) | Welcome to Discerned |
| Wordmark | Discerned |
| [Tagline](src/onboarding/onboarding.html#L131) | Filter the noise. Clip, rate, and publish what's actually worth reading. |
| [Card heading](src/onboarding/onboarding.html#L134) | Pin Discerned to your toolbar |
| [Step 1](src/onboarding/onboarding.html#L139) | Click the `Extensions` puzzle-piece icon in Chrome's top-right toolbar. |
| [Step 2](src/onboarding/onboarding.html#L143) | Find **Discerned** in the list. |
| [Step 3](src/onboarding/onboarding.html#L147) | Click the **pin** icon 📌 next to it so the Discerned beacon stays visible in your toolbar. |
| [Step 4](src/onboarding/onboarding.html#L151) | Browse to any page, then **right-click** or click the Discerned beacon to clip and rate what you're reading. |
| [Hint](src/onboarding/onboarding.html#L155-L158) | Your clips stay on this device until you choose to publish. To publish your ratings and clips, connect a Nostr identity — Nostr is an open social network where you own your identity and your posts. |
| [Button](src/onboarding/onboarding.html#L160) | Got it — start using Discerned → |
| [Footer](src/onboarding/onboarding.html#L162-L165) | Something not working? [Report it](https://discerned.online/feedback?target=extension). |

---

## 3. Toolbar popup (restricted pages only)

Shown only when the toolbar icon is clicked on a page where content scripts can't run
(`chrome://`, `file://`, the Web Store). Normal pages open the overlay instead.
[src/popup/popup.html](src/popup/popup.html#L56-L57)

| Element | Text |
|---|---|
| Heading | Discerned can't clip this page |
| Body | Browser-internal pages (chrome://, file://, the Web Store) don't allow extensions to inject the clipper. Open a normal web page and try again. |

---

## 4. Overlay — gate (first run, guests)

The first screen a new user sees. [src/content/overlay.ts](src/content/overlay.ts#L397-L427)

### 4a. No signing extension detected

| Element | Text |
|---|---|
| Icon | 🔒 |
| Title | Start local, publish when ready |
| Body | Your clips and ratings stay on this device. Connect a Nostr identity to publish them — Nostr is an open social network where you own your identity and your posts, and no company can take them away. |
| Primary button | Connect a Nostr identity → |
| Secondary button | Not now — keep clips on this device |

### 4b. Signing extension detected

| Element | Text |
|---|---|
| Icon | 🔑 |
| Title | You're one click from publishing |
| Body | Your Nostr signing extension is ready. Sign in to publish your ratings under your own identity — they'll appear in any Nostr client, to the people who already follow you. |
| Primary button | Sign in → |
| Secondary button | Not now — keep clips on this device |

> The "people who already follow you" line is only shown in this branch — it assumes an
> existing Nostr presence, which the 4a user doesn't have.

---

## 5. Overlay — identity flow

### 5a. Chooser — [overlay.ts:466-495](src/content/overlay.ts#L466-L495)

| Element | Text |
|---|---|
| Header | Connect identity |
| Sign-in card (only when a signer is detected) | **Sign in →** / Signing extension detected. Sign in to Discerned to start casting. |
| Existing card | **Connect existing identity →** / Already on Nostr? Use a signing extension, remote signer, or your private key. |
| Create card | **Create new Nostr account →** / New to Nostr? Generate a fresh keypair and back it up. |

### 5b. Create account — [overlay.ts:527-546](src/content/overlay.ts#L527-L546)

| Element | Text |
|---|---|
| Header | Create account |
| Body | This generates a brand-new Nostr keypair right here in your browser. You'll see both keys once and must back them up — your private key can never be recovered if lost. Nothing is saved until you store it next. |
| Button | Generate keypair |
| Status | Generating… |
| Error | Failed to generate key. Please try again. |

### 5c. Connect existing — tabs — [overlay.ts:613-652](src/content/overlay.ts#L613-L652)

Tab labels: **Extension** (with ✓ when detected) · **Remote signer** · **Store key**

**Extension tab**, three states:

| State | Text |
|---|---|
| Connected | Signing extension connected. / Discerned uses your browser signing extension to sign casts. No key is stored here. / *Continue* |
| Detected, not signed in | Signing extension detected. / To finish connecting, sign in to Discerned. This is one time only — your signing extension will then be used to sign casts. No key is stored here. / *Sign in →* |
| Not detected | Install a signing extension like [nos2x] or [Alby] to sign with your Nostr identity. After installing, browse any page — Discerned detects it automatically. Or click below to check now. / *Detect extension now* |

**Remote signer tab:** Create a free account at [nstart.me], then paste your `bunker://`
link below. Your private key never leaves the remote signer. — placeholder `bunker://…`,
button *Connect account*

**Store key tab:** ⚠️ Your private key gives full access to your identity. It will be
encrypted with a PIN before being stored — only you can unlock it. — placeholders
`nsec1…` / `PIN (minimum 6 characters)` / `Confirm PIN`, button *Encrypt and store*

### 5d. Key backup — [overlay.ts:781-802](src/content/overlay.ts#L781-L802)

Shown once, after generating a new account.

| Element | Text |
|---|---|
| Header | Back up your keys |
| Warning | ⚠️ This is the only time your private key is shown. Save both keys somewhere safe (a password manager). Anyone with the private key controls your identity, and it can never be recovered if lost. |
| Labels | Public key (npub) — shareable · Private key (nsec) — keep secret |
| Buttons | Copy public key · Copy private key |
| Checkbox (gates *Done*) | I've saved my keys somewhere safe |
| Button | Done |

### 5e. Identity status messages — [overlay.ts:557-818](src/content/overlay.ts#L557-L818)

Checking… · Connecting… · Encrypting… · Generating… · Connected! · Stored! ·
Copied to clipboard.

| Error | Text |
|---|---|
| No signer | No extension found. Install Alby or nos2x, visit any page, then try again. |
| Empty bunker field | Paste your bunker:// link first. |
| Bad nsec | Invalid key — must start with nsec1… |
| Short PIN | PIN must be at least 6 characters. |
| PIN mismatch | PINs don't match. |
| Copy failed | Copy failed — select the key and copy manually. |
| Wrong PIN | Incorrect PIN. Please try again. |

---

## 6. Overlay — main capture panel

[overlay.ts:1245-1330](src/content/overlay.ts#L1245-L1330)

| Element | Text |
|---|---|
| Header | Discerned (beacon mark + wordmark) |
| Format chips | ✂ Selection · 📄 Article · 🗞 Full page · 🔖 Bookmark |
| Notes | label **Notes**, placeholder `Add a note or comment (optional)…` |
| Category | label **Category** (combobox; built-ins General, Tech, Finance, Health, Politics, Philosophy, Science, Culture + custom) |
| Preview labels | Selection · Article · Bookmark · Capturing… · No capture yet. |
| Footer status | Connected to Nostr · Connected · Locked · Local only |
| Footer links | Connect → · Unlock → |
| Publish slider | Cast · Both · Clip |
| Action button | CAST · CLIP & CAST · CLIP |
| Loading | Saving… |

**Publish-slider tooltips** — [overlay.ts:1307-1314](src/content/overlay.ts#L1307-L1314)

- Cast — Publish to Nostr — your clip is public and signed with your identity
- Both — Save locally and publish to Nostr — your clip is public and signed with your identity
- Clip — Keep local — stored only on this device, not published

**Cast size notice** — [overlay.ts:1455-1459](src/content/overlay.ts#L1455-L1459)

- Short body: Cast includes the full text — ~N KB.
- Long body: Long body — cast publishes title, URL, note & rating; full text stays local.

### 6a. Signal rating — [types.ts:36-40](src/shared/types.ts#L36-L40)

Section head **Signal Rating**, *Clear* button, readout `Unrated` or `N ★ Level`.
Tooltips per tick:

| Level | Tooltip |
|---|---|
| Toxic | 1 ★ — Outright fraud, dangerous disinformation, or malicious propaganda. |
| Noise | 2 ★ — Clickbait, low-effort engagement bait, or highly manipulative spin. |
| Passable | 3 ★ — Fine for a quick glance. Nothing wrong with it, but nothing that stays with you. |
| Worthwhile | 4 ★ — Solid, high-signal content. It delivered exactly what it promised. |
| Masterpiece | 5 ★ — Exceptional execution. Flawless utility, deep wisdom, or elite artistic craft. |

### 6b. Qualifiers — [types.ts:47-51](src/shared/types.ts#L47-L51)

Section head **Qualifiers**, custom input placeholder `+ add custom tag`.

- **Tone & Style** — Humorous / Satire · Academic / Dense · Opinion / Essay
- **Utility & Format** — Practical Tool · Primary Source · Quick Read
- **Longevity** — Timeless · Current Event · Passing Trend

---

## 7. Overlay — result messages

[overlay.ts:1799-1882](src/content/overlay.ts#L1799-L1882) · toast in
[content.ts:322](src/content/content.ts#L322)

| Outcome | Text |
|---|---|
| Local save | Clipped! 📥 |
| Cast only | Cast published 📡 |
| Clip + cast | Clipped & cast 📡 |
| In progress | 📡 Casting… · Clipped! 📡 Casting… |
| Cancelled at PIN (clip kept) | Clipped · not cast |
| Cancelled at PIN (no clip) | Cast cancelled — your key is still locked. |
| Cast failed (clip kept) | Clipped · cast failed |
| Cast failed (no clip) | Cast failed — your signer may have declined or timed out. |
| Clip failed | Failed to clip. Please try again. |
| Error toast | 📡 Cast failed *(+ the underlying error)* |
| Success links | View in My Clips → · View in Discerns → · Dismiss |

**Inline unlock** — 🔒 Enter your PIN to unlock your key · *Unlock & Cast* · *Cancel*

---

## 8. Overlay — settings

[overlay.ts:868-1005](src/content/overlay.ts#L868-L1005)

| Card | Text |
|---|---|
| Guest | **Publishing not set up** / Your clips and ratings stay on this device. Connect a Nostr identity to publish them publicly. / *Connect a Nostr identity →* |
| NIP-07 signed in | Status / Connected via signing extension / *Disconnect* |
| NIP-07 detected only | Status / Signing extension detected — sign in to connect / Sign in to connect your signing extension. You'll only be asked once. / *Sign in →* |
| NIP-46 | Status / Connected via remote signer / *Disconnect* |
| Stored key | Status / Connected with stored key / *Disconnect* / ▸ View / unlock your key → placeholder `Enter your PIN`, *Unlock* |
| Usage | 📥 Local clips · 📡 Public casts |
| Appearance | 🖥️ System · 🌙 Dark · ☀️ Light |
| Relays | Loading… / *Manage relays* / (error) Could not read relay list |
| Feedback | Send feedback or report a bug |
| Export | Export local clips as JSON |
| Developer (dev builds only) | Use local relay / Publish to ws://localhost:7777 instead of the public relays. Syncs to the web app feed. |

---

## 9. Connect tab

Full-page identity setup, opened from the popup when no identity exists.
[src/connect/connect.html](src/connect/connect.html)

| Element | Text |
|---|---|
| Tab title | Connect — Discerned |
| [Page title](src/connect/connect.html#L323) | Connect a Nostr identity |
| [Intro](src/connect/connect.html#L324-L329) | A Nostr identity lets you publish your ratings publicly, signed so they're verifiably yours. Nostr is an open social network — you own your identity and everything you post, it works across every Nostr app, and no company can take it away. Choose how to connect; all methods are free and take about a minute. |
| Connected state | ✓ Already connected / You can close this tab and start evaluating. |

**Method 1 — 🔌 [Signing extension](src/connect/connect.html#L346)** · badge *Recommended*
Install a signing extension like [Alby] or [nos2x] to sign with your Nostr identity.
After installing, browse any page — Discerned detects it automatically.
Links *Install Alby →* / *Install nos2x →*, button *I already have one — detect it now*

**Method 2 — 🔗 Remote signer** · subtitle *via bunker:// link*
Create a free account at [nstart.me], then paste your `bunker://` link below. Your
private key never leaves the remote signer. — button *Connect account*

**Method 3 — 🔑 Account key** · subtitle *nsec import*
⚠️ Your account key gives full access to your identity. It will be encrypted with a PIN
before being saved — only you can unlock it. — button *Encrypt and save*

**Status messages** — [connect.ts:59-152](src/connect/connect.ts#L59-L152)
Checking… · Connecting… · Encrypting… · ✓ Extension detected — you're connected! ·
✓ Connected! · ✓ Saved! · Could not check — try again. · Connection failed. Check the
link and try again. · Failed to save key. Please try again.

---

## 10. Context menu

[background.ts:363](src/background/background.ts#L363)

| Element | Text |
|---|---|
| Right-click entry (page + selection) | Discerned: Evaluate → Clip |

---

## Known inconsistencies

Not defects, but worth a decision if the copy gets another pass:

1. **"Evaluate" alongside "rate".** The context menu says "Discerned: Evaluate → Clip"
   ([background.ts:363](src/background/background.ts#L363)) and the connect tab says
   "start evaluating" ([connect.html:336](src/connect/connect.html#L336)), while most of
   the UI says *rate*. **Kept deliberately** — "evaluate" carries the considered-judgement
   sense the product is about, where "rate" is the lighter everyday verb. Not a defect;
   noted so it isn't "fixed" by accident.

2. **Emoji vs. custom SVG for the same concepts.** The publish slider uses the
   `ICON_CAST` / `ICON_CLIP` line SVGs ([overlay.ts:1998-2003](src/content/overlay.ts#L1998-L2003)),
   but status messages and the settings usage rows use 📡 / 📥 for the identical ideas.
   Unifying on the SVGs needs an `icon` parameter on `showSuccess`/`showError` so the
   existing HTML escaping isn't bypassed — tracked as separate work.

3. **Format chip emoji** (✂ 📄 🗞 🔖) are decorative and unrelated to the 📡/📥 status
   glyphs. Three different jobs for emoji in one UI.

4. **Web Store detailed description** now lives in
   [STORE-SUBMISSION.md](STORE-SUBMISSION.md) → "Detailed description". It is typed into
   the Web Store dashboard, not stored in the package, so it is not part of any build —
   but it carries the same claim discipline as the in-product copy above, and the two
   should be edited together.
