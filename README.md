# Wirthy

A value attribution layer for the web. Capture content, evaluate it (a 5-level **Signal** rating, multi-select **Qualifier** tags, and a **Category**), and publish cryptographically-signed signals to the [Nostr](https://njump.me/) network.

## Install

**[Get the Wirthy extension on the Chrome Web Store](https://chromewebstore.google.com/detail/wirthy/gpfeknmodijdlehpnkfannklhplmfoma)** — then browse your public posts at [wirthy.app](https://wirthy.app).

## Sub-projects

- **[wirthy-ext/](./wirthy-ext/)** — Chrome extension (Manifest V3), live on the [Chrome Web Store](https://chromewebstore.google.com/detail/wirthy/gpfeknmodijdlehpnkfannklhplmfoma). Clip and save a web page, rate its **Signal**, tag it with **Qualifiers**, file it under a **Category**, and broadcast on the open web — or don't.
- **[wirthy-web/](./wirthy-web/)** — Next.js companion web app deployed at [wirthy.app](https://wirthy.app). Public Home feed plus My Clips for locally stored clips delivered from the extension.
- **[tests/](./tests/)** — Cross-project end-to-end test suite (Playwright) and shared HTML/clip fixtures.

Each sub-project has its own README with stack, setup, and conventions. Read the relevant one before touching code in that project.

## Commands

```bash
pnpm install               # install all workspace dependencies
pnpm test                  # run unit tests for both projects
pnpm test:e2e              # run end-to-end Playwright suite
pnpm test:live             # opt-in live-URL test run (LIVE=1)
```

Per-project commands run from inside the sub-project's folder. See the sub-project READMEs.

## Status

The Chrome extension is published on the [Chrome Web Store](https://chromewebstore.google.com/detail/wirthy/gpfeknmodijdlehpnkfannklhplmfoma) and the web app is live at [wirthy.app](https://wirthy.app). Bitcoin tipping, voting on posts, and Android and iOS apps are planned.
