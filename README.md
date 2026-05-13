# Discerned

> **Value Attribution Layer for the Web**

A Chrome Extension that allows users to capture, evaluate, and cryptographically sign content to the Nostr network. Built for frictionless onboarding of non-crypto users.

---

## Vision

Discerned creates a new "value signal" protocol on Nostr, enabling users to:
- **Capture** meaningful content from anywhere on the web
- **Evaluate** it across three axes: Interest, Ethics, and Category
- **Signal** their assessment either privately (clipped) or publicly (cast to the network)

Current social media amplifies engagement-driven signals (likes, shares) that often reward outrage over wisdom. Discerned enables a **curated value layer** where signal quality matters more than virality.

---

## Features

### Phase 1 (MVP) — Current
- **Smart Capture**: Auto-detects selected-text quotes vs. full page resources
- **Triple-Axis Evaluation**: Interest (5 levels), Ethics (6 levels), Category (8 predefined + custom)
- **Dual Actions**:
  - **CLIP**: Save privately to local IndexedDB
  - **CAST**: Publish a signed Nostr event to the network
- **NIP-07 Support**: Auto-detected when a browser wallet (Alby, nos2x, etc.) is present; signing is routed through a canonical tab via a MAIN-world bridge script
- **NIP-46 Support**: Connect via `bunker://` URI to a remote signer (e.g. nsec.app); reconnects transparently on service worker wakeup
- **nsec Import**: Paste an `nsec1…` key, protect it with a PIN; stored as a NIP-49 encrypted blob — the raw key is memory-only
- **Onboarding Flow**: First-run tab guides new users to pin the extension icon; identity setup happens inline in the capture overlay
- **Connect Page**: Dedicated tab for identity setup (NIP-07 detection, NIP-46 bunker URL, nsec import)
- **Shadow DOM UI**: Perfect style isolation on any website; site styles never leak in or out

### Phase 2 (Planned)
- Relay health monitoring and auto-retry for failed publishes
- Export/import of guest clip data
- Local clip library (browse, filter, search)
- NIP-44 private encrypted clips (currently stubbed)

### Phase 3 (Planned)
- Firefox support (Manifest V3)
- Companion web app: browse your network's value signals
- Discovery feed: find high-signal content

---

## Architecture

```
┌─────────────────────────────────────────────┐
│           Chrome Extension (MV3)             │
├─────────────────────────────────────────────┤
│  Content Scripts                             │
│  ├─ nip07-bridge.ts (MAIN world)            │
│  │   Proxies window.nostr → postMessage     │
│  │   Blocks window.open while overlay open  │
│  └─ content.ts (isolated world)             │
│      ├─ Smart Capture (capture.ts)          │
│      ├─ Evaluation Overlay (overlay.ts)     │
│      └─ Message routing + log relay         │
├─────────────────────────────────────────────┤
│  Background Service Worker                   │
│  ├─ Auth management (guest/NIP-07/46/nsec)  │
│  ├─ Nostr event construction & signing      │
│  ├─ Relay pool (≥ 2 ACKs, 10 s timeout)    │
│  └─ IndexedDB clip storage                  │
├─────────────────────────────────────────────┤
│  Extension Pages                             │
│  ├─ popup.html — auth status & usage stats  │
│  ├─ connect.html — identity setup           │
│  └─ onboarding.html — first-run welcome     │
├─────────────────────────────────────────────┤
│  Storage                                     │
│  ├─ chrome.storage.local (auth, settings)   │
│  └─ IndexedDB (clips)                        │
└─────────────────────────────────────────────┘
              ↕
    ┌──────────────────┐
    │  Nostr Network   │
    │  (3 Relays)      │
    └──────────────────┘
```

**Tech Stack:**

| Tool | Version | Role |
|---|---|---|
| TypeScript | 5.3.3 (strict) | Primary language |
| Vite + crxjs | 5.1.3 | Bundler with MV3 support |
| nostr-tools | 2.7.2 | Nostr protocol (NIP-07/19/44/46/49) |
| Vanilla Web Components | — | Shadow DOM UI (no React) |

---

## Quick Start

### Prerequisites
```
node >= 18
pnpm >= 8
```

### Installation
```bash
git clone https://github.com/your-username/discerned-ext.git
cd discerned-ext
pnpm install
pnpm dev        # watch mode
pnpm build      # production build → dist/
```

### Load in Chrome
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

### Usage
1. Navigate to any webpage
2. Right-click and select **Discerned: Capture & Evaluate**, or click the extension icon
3. Evaluate the content on three axes
4. Choose an action:
   - **CLIP** → saved privately to IndexedDB
   - **CAST** → signed and published to Nostr relays

---

## Development

### Scripts
```bash
pnpm dev          # Vite watch mode
pnpm build        # tsc + Vite production build
pnpm type-check   # tsc --noEmit (strict)
pnpm lint         # ESLint on src/**/*.ts
```

### Project Structure

| File | Description |
|---|---|
| [src/background/background.ts](src/background/background.ts) | Service worker: auth, signing, Nostr casting (CAST handler → relay publish) |
| [src/background/relay-manager.ts](src/background/relay-manager.ts) | SimplePool wrapper; ≥ 2 ACK policy |
| [src/content/content.ts](src/content/content.ts) | Entry; routes messages, relays logs |
| [src/content/capture.ts](src/content/capture.ts) | Smart capture + HTML sanitiser |
| [src/content/overlay.ts](src/content/overlay.ts) | Shadow DOM evaluation UI |
| [src/content/highlighter.ts](src/content/highlighter.ts) | Text highlight / selection helpers |
| [src/content/nip07-bridge.ts](src/content/nip07-bridge.ts) | MAIN world: proxies window.nostr |
| [src/content/web-bridge.ts](src/content/web-bridge.ts) | Extension ↔ web app bridge messaging |
| [src/onboarding/onboarding.ts](src/onboarding/onboarding.ts) | First-run welcome page |
| [src/onboarding/onboarding.html](src/onboarding/onboarding.html) | Onboarding page markup |
| [src/connect/connect.ts](src/connect/connect.ts) | Identity setup (NIP-07/46/nsec) |
| [src/connect/connect.html](src/connect/connect.html) | Connect page markup |
| [src/popup/popup.ts](src/popup/popup.ts) | Auth status, usage stats, disconnect |
| [src/popup/popup.html](src/popup/popup.html) | Popup markup |
| [src/shared/types.ts](src/shared/types.ts) | All interfaces, message types, storage keys |
| [src/shared/logger.ts](src/shared/logger.ts) | Centralised log bridge (all contexts → page console) |
| [src/shared/nostr/auth.ts](src/shared/nostr/auth.ts) | Auth state helpers |
| [src/shared/nostr/events.ts](src/shared/nostr/events.ts) | Nostr event construction (kind 1, 9802) |
| [src/shared/nostr/encryption.ts](src/shared/nostr/encryption.ts) | NIP-44 wrapper (partial) |
| [src/shared/nostr/nip46-manager.ts](src/shared/nostr/nip46-manager.ts) | BunkerSigner lifecycle (reconnects after SW kill) |

### Key Design Decisions

**Why Vanilla TypeScript (not React)?**
Smaller bundle, faster cold start, native Shadow DOM support, and simpler build pipeline. The overlay is a single-screen UI — the overhead of a framework isn't warranted at this scale.

**Why Shadow DOM?**
The extension UI works on any website without CSS leaking in either direction. Capturing and restoring focus across the shadow boundary is handled explicitly.

**Why a MAIN-world NIP-07 bridge?**
Content scripts run in an isolated world and cannot reach `window.nostr`. A separate script (`nip07-bridge.ts`) is injected into the MAIN world at `document_start` to proxy wallet calls via `postMessage`. It also intercepts `window.open` before any page script runs, preventing sites with capture-phase click listeners from opening new tabs while the overlay is active.

**Why NIP-49 for nsec storage?**
Raw private keys are never written to disk. The key is encrypted with a user-supplied PIN using NIP-49 (scrypt + XChaCha20), and only the encrypted blob is persisted in `chrome.storage.local`. The decrypted key lives in service worker memory only for the lifetime of that SW instance.

**Why on-demand NIP-46 reconnection?**
Service workers are killed after ~30 s of inactivity, which closes the WebSocket held by `BunkerSigner`. `nip46-manager.ts` reconnects transparently on every signing request using the stored `clientKeyHex` and relay list.

---

## Security

### Content Sanitisation
All captured HTML is sanitised to prevent XSS:
```
Allowed tags:  b, i, a, p, br, strong, em
Allowed attrs: href only
Forbidden:     scripts, styles, event handlers, all other tags
```

### Key Storage
- **NIP-07 mode**: Keys stay in the user's wallet extension (Alby, nos2x, etc.)
- **NIP-46 mode**: Keys held by the remote signer; only an ephemeral client keypair is stored
- **nsec mode**: NIP-49 encrypted blob in `chrome.storage.local`; raw key is session memory only
- **Guest mode**: Ephemeral key generated in memory; never persisted

### Relay Security
- Only `wss://` (encrypted WebSocket) connections — no plain `ws://`
- Publish requires acknowledgement from at least 2 relays (10 s timeout)

---

## Nostr Protocol Details

### Event Types
| Type | Kind | Usage |
|---|---|---|
| Highlight | 9802 | Quote captures (selected text) |
| Note | 1 | Resource captures (page metadata) |
| App Data | 30078 | Encrypted clips (planned) |

### Tag Structure
```
// Highlight (quote)
['r', url]
['l', 'Wise', 'interest']         // InterestLevel
['l', 'Honest', 'ethics']         // EthicsLevel
['l', 'Tech', 'category']         // Category
['context', '…surrounding text…']

// Note (resource)
['r', url]
['l', 'Insightful', 'interest']
['l', 'Exemplary', 'ethics']
['l', 'Science', 'category']
['image', thumbnailUrl]            // optional OG image
```

### Evaluation Axes
| Axis | Levels |
|---|---|
| Interest | Wise · Insightful · Interesting · Neutral · Noise |
| Ethics | Exemplary · Honest · Neutral · Misleading · Malicious |
| Category | General · Tech · Finance · Health · Politics · Philosophy · Science · Culture · (custom) |

### Default Relays
- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.snort.social`

---

## Known Limitations

- NIP-44 encryption for CLIP is stubbed — clips are stored as plaintext JSON in IndexedDB pending full implementation
- No retry logic for failed relay publishes
- Guest clips are not yet exportable
- Firefox not supported (Manifest V3 port planned)
- No companion web viewer

---

## Contributing

Discerned is open source (GPL v3). Contributions welcome.

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes and test locally in Chrome
4. Run `pnpm type-check && pnpm lint`
5. Submit a PR with a clear description

---

## License

GPL v3 — see [LICENSE](LICENSE) for details.

---

## Acknowledgements

- Nostr protocol developers (NIPs 07, 19, 44, 46, 49)
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) library
- Anthropic Claude (architecture & code generation)
