// Builds the PUBLIC cast (kind-30023 long-form + kind-1 note) that the extension
// would publish for a given live capture — so the visual specs can screenshot
// the CAST render (the ReactMarkdown path everyone else sees) alongside the
// private CLIP render (the rich dx-* HTML only the author sees).
//
// This drives the extension's OWN code, not a reimplementation: it posts a
// __DISCERNED_TEST_CAST message to the loaded dist-test extension's dev test
// bridge (content.ts), which runs the real deriveLongFormMarkdown + the real
// background BUILD_CAST handler (buildShortNote + createLongFormEvent). The
// returned templates are exactly what handleCast would sign and publish; we only
// sign them here with a throwaway key so they can be fed to a mocked relay.
//
// The cast render is where the 2026-07-13 cast-rendering defects lived (giant
// avatars, "](url)" brace spills, smashed stat digits) — a site can look perfect
// as a clip and be broken as a cast, because the cast body is a lossy
// htmlToMarkdown conversion the clip render never touches.

import type { Page } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';

export interface CastTemplates {
  noteTemplate: EventTemplate;
  longFormTemplate: EventTemplate | null;
}

/**
 * Ask the loaded extension (via the dev test bridge on the capture page) to
 * build the cast event templates for a capture object. `page` must be the page
 * the capture came from — the one with the extension content script injected —
 * because the bridge listens for window messages on that page's origin.
 *
 * Returns the real production templates (note + optional long-form), unsigned.
 */
export async function buildCastTemplates(
  page: Page,
  capture: unknown,
  evaluation: unknown = { signal: 'Worthwhile', qualifiers: [], category: 'General' },
): Promise<CastTemplates> {
  const result = (await page.evaluate(
    async ({ capture, evaluation }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('BUILD_CAST timeout')), 30_000);
        const onMessage = (e: MessageEvent) => {
          if (e.data?.type !== '__DISCERNED_TEST_CAST_RESULT') return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.result);
        };
        window.addEventListener('message', onMessage);
        window.postMessage(
          { type: '__DISCERNED_TEST_CAST', capture, evaluation },
          window.location.origin,
        );
      });
    },
    { capture, evaluation },
  )) as { success: boolean; error?: string; data?: CastTemplates };

  if (!result?.success || !result.data) {
    throw new Error(`BUILD_CAST failed: ${result?.error ?? 'no data'}`);
  }
  return result.data;
}

/**
 * The ONE key every test cast is signed with.
 *
 * Fixed, not random. Test casts go to the local relay (helpers/localRelay.ts),
 * which is a persistent SQLite store — nothing expires, so they pile up run
 * after run. A per-cast throwaway key made them unidentifiable and permanently
 * undeletable: NIP-09 deletion requires the author's key, and it had already
 * been discarded. One fixed key makes every test cast trivially identifiable by
 * author, and deletable by signing a kind-5 with the same key.
 *
 * It is a literal, so anything signed with it is self-evidently test data and
 * can never be confused with a real user's cast. Never use it outside tests.
 *
 * Because every test cast shares this author, the npub cannot tell two of them
 * apart — `openCast` in renderCast.ts matches the row by TITLE instead.
 *
 * Cleanup: `node tests/e2e/tools/purge-test-casts.mjs` (--dry-run to preview).
 */
export const TEST_CAST_SECRET_KEY: Uint8Array = new Uint8Array(
  Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff),
);

/**
 * Build + sign the kind-30023 (NIP-23 long-form) cast the extension would
 * publish for this capture — the public render path. Returns null when the
 * capture is not long-form-eligible (bookmark / plain selection / empty body),
 * in which case the caller should skip the cast screenshot.
 */
export async function buildLongFormCast(
  page: Page,
  capture: unknown,
  evaluation?: unknown,
): Promise<NostrEvent | null> {
  const { longFormTemplate } = await buildCastTemplates(page, capture, evaluation);
  if (!longFormTemplate) return null;
  return finalizeEvent(longFormTemplate, TEST_CAST_SECRET_KEY);
}

/**
 * Build + sign the kind-1 note cast (always present, even for bookmarks). Useful
 * when a capture has no long-form companion but you still want to render the
 * note the public feed shows.
 */
export async function buildNoteCast(
  page: Page,
  capture: unknown,
  evaluation?: unknown,
): Promise<NostrEvent> {
  const { noteTemplate } = await buildCastTemplates(page, capture, evaluation);
  return finalizeEvent(noteTemplate, TEST_CAST_SECRET_KEY);
}
