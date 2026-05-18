# Discerned

A value attribution layer for the web. Capture content, evaluate it on three axes (Interest, Ethics, Category), and publish cryptographically-signed signals to the [Nostr](https://nostr.com/) network.

## Sub-projects

- **[discerned-ext/](./discerned-ext/)** — Chrome extension (Manifest V3). Capture, evaluate, and publish from any browser tab.
- **[discerned-web/](./discerned-web/)** — Next.js companion web app deployed at [discerned.online](https://discerned.online). Public discernments feed plus a private Reading Room for clips delivered from the extension.
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

MVP — Chrome extension and web app are functional. Android and iOS apps planned.
