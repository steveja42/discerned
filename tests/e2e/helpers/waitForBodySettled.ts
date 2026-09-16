// Wait until a page's visible text has STOPPED GROWING before capturing it.
//
// Why this exists: politico captured 5% text coverage in one sweep and 87% two
// hours later from identical code, and nothing in the score sidecar
// distinguished the two — the bad run was reviewed as a capture regression and
// cost a long investigation before a re-run proved the pipeline fine. A capture
// that races hydration is indistinguishable, after the fact, from a capture
// that is genuinely broken.
//
// Why not the previous approach: the sweep already waited for a populated body,
// but keyed on a FIXED SELECTOR LIST ('[class*="RichTextStoryBody"]',
// '[data-testid="ArticleBody"]', …). Politico matches none of them, so the
// length probe returned 0 forever, the loop spun its whole budget and gave up
// silently — the wait was inert on exactly the page that needed it, and on
// every other site outside that list. A 206-domain corpus cannot be covered by
// enumerating each site's body selector.
//
// What this does instead is site-agnostic: poll document.body's rendered text
// length and return once it has been UNCHANGED for `stableFor`. Growth means
// hydration is still landing; a flat line means the page has settled. No
// selector, no per-site knowledge.
//
// It is a floor, not a guarantee — a site that streams content indefinitely
// (an infinite feed) hits `timeout` and captures anyway, which is the right
// trade: capturing late is a slow sweep, capturing early is a false defect.

export interface BodySettleResult {
  /** Rendered text length at the moment we stopped waiting. */
  textLen: number;
  /** True when the length went quiet; false when `timeout` ran out first. */
  settled: boolean;
  /** How long we actually waited, ms. */
  waitedMs: number;
  /** Text length on the first poll — growth is `textLen - initialLen`. */
  initialLen: number;
}

export interface BodySettleOptions {
  /** Stop waiting after this long even if still growing. Default 15000. */
  timeout?: number;
  /** Consecutive quiet time that counts as settled. Default 1200. */
  stableFor?: number;
  /** Poll interval. Default 300. */
  interval?: number;
  /**
   * Text length below which the page is assumed to be an un-hydrated shell, so
   * a quiet period does not count as settled. Default 400 - well under any real
   * article, well over a headline + dek. Set 0 to disable for a page that is
   * legitimately near-empty.
   */
  minLength?: number;
  /**
   * Never return before this, however quiet the page looks. Load-bearing: a
   * shell that paints fast and hydrates at t=2.5s is PERFECTLY QUIET at t=1.2s,
   * so `stableFor` alone returns the shell — measured on a synthetic hydrating
   * page, which settled at 1234ms with 48 chars while the body was still
   * coming. Must exceed the hydration delays actually seen in the wild.
   */
  minWait?: number;
}

/** Minimal surface we need — keeps this usable from any spec without importing Page. */
interface EvaluatablePage {
  evaluate<R>(fn: (arg: unknown) => R | Promise<R>, arg?: unknown): Promise<R>;
}

export async function waitForBodySettled(
  page: EvaluatablePage,
  opts: BodySettleOptions = {},
): Promise<BodySettleResult> {
  const timeout = opts.timeout ?? 15_000;
  const stableFor = opts.stableFor ?? 1_200;
  const interval = opts.interval ?? 300;
  const minWait = opts.minWait ?? 4_000;
  const minLength = opts.minLength ?? 400;

  return page.evaluate(async (raw) => {
    const { timeout: to, stableFor: sf, interval: iv, minWait: mw, minLength: ml } =
      raw as { timeout: number; stableFor: number; interval: number; minWait: number; minLength: number };

    // innerText, not textContent: it reflects what is RENDERED, so a hydration
    // payload sitting in a hidden template or a JSON island doesn't read as
    // content that has already arrived. That distinction is the whole point —
    // on a gate-cleared page the article text can be present in the DOM while
    // not yet being in a visible, capturable block.
    const len = () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length;

    const started = Date.now();
    const initialLen = len();
    let last = initialLen;
    let lastChangeAt = Date.now();

    for (;;) {
      await new Promise((r) => setTimeout(r, iv));
      const now = len();
      if (now !== last) { last = now; lastChangeAt = Date.now(); }

      const quietMs = Date.now() - lastChangeAt;
      const elapsed = Date.now() - started;
      // Both conditions, not either: a fast shell whose body lands at t=2.5s is
      // genuinely quiet at t=1.2s, so `quietMs` alone hands back the shell.
      //
      // The `now >= ml` term keeps waiting while the page holds only
      // shell-sized text. A slow hydrator (measured: body at t=6s) is quiet AND
      // past minWait at t=4s, and without this returns `settled: true` on 48
      // characters — a confident green light on exactly the capture this helper
      // exists to prevent. Below the floor we keep polling to `timeout` and, if
      // nothing ever arrives, report settled:false so the sidecar says the
      // capture is suspect instead of vouching for it.
      if (quietMs >= sf && elapsed >= mw && now >= ml) {
        return { textLen: now, settled: true, waitedMs: elapsed, initialLen };
      }
      if (elapsed >= to) {
        return { textLen: now, settled: false, waitedMs: elapsed, initialLen };
      }
    }
  }, { timeout, stableFor, interval, minWait, minLength });
}
