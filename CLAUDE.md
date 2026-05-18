# CLAUDE.md — Discerned Monorepo Root

This is the parent workspace for the Discerned project. Use this folder when a question or task spans more than one sub-project.

## Sub-projects

| Folder | Purpose |
|---|---|
| `discerned-ext/` | Chrome Extension (MV3) — capture, evaluate, publish to Nostr |
| `discerned-web/` | Companion web app — public Cast feed + private Reading Room |

Each sub-project has its own `CLAUDE.md` with full stack, commands, and conventions. Read the relevant one before touching code in that project.

## Cross-project Conventions

- **Shared types** live in `discerned-ext/src/shared/types.ts` and are mirrored (not imported) into `discerned-web/lib/types.ts`. Keep them in sync manually.
- **Nostr tag conventions** (`online.discerned.interest`, etc.) are defined in `discerned-ext/src/shared/nostr/events.ts` — the web app's parser must match them exactly.
- **Extension ↔ web bridge** messages (`DISCERNED_BRIDGE_HELLO`, `DISCERNED_BRIDGE_CLIPS`, `DISCERNED_WEB_READY`) are typed in `discerned-ext/src/shared/types.ts` (`WebBridgeOutbound` / `WebBridgeInbound`) and consumed in `discerned-web/lib/bridge/extension-bridge.ts`.
- **Default relays** are defined in `discerned-ext/src/shared/types.ts` (`DEFAULT_RELAYS`) and mirrored in `discerned-web/lib/constants.ts` — keep them in sync.

## Commands

Run from within each sub-project:

```bash
# Extension
cd discerned-ext
pnpm dev          # Vite watch mode
pnpm build        # Production build
pnpm type-check   # tsc --noEmit
pnpm lint         # ESLint

# Web app
cd discerned-web
pnpm dev          # Next.js dev server (localhost:3000)
pnpm build        # Next.js production build
pnpm type-check   # tsc --noEmit
```
