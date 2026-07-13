// Shared structural health checks for rendered clip bodies. Screenshots alone
// can't fail a test — these assertions are what let the visual specs (live and
// fixture) find bugs unattended. Factored out of primal-visual's inline checks
// and extended with the defect classes found in the 2026-07-12 review:
// stretched avatars, crushed one-word-per-line columns, giant blank regions,
// and page-chrome leaks ("Suggested for you", "Discover more", …).
//
// Usage, after .clip-body is visible and images have settled:
//   await assertClipBodyHealth(clipBody);
// A live spec exercising a site with a known, planned-but-unfixed leak can
// disable a single check rather than skip the whole call:
//   await assertClipBodyHealth(clipBody, { disable: ['chrome-leak'] });

import { expect, type Locator } from '@playwright/test';

export type ClipHealthCheck =
  | 'header-layout'   // dx-header must be flex and ≤ 90px tall
  | 'reply-height'    // dx-reply must not collapse to zero height
  | 'zaps-avatars'    // dx-zaps-row is flex; its avatars stay ≤ 32px
  | 'img-distortion'  // rendered aspect ratio must track natural aspect ratio
  | 'round-shape'     // border-radius:50% elements must render roughly square
  | 'text-squeeze'    // no tall skinny column of wrapped text
  | 'blank-run'       // no huge vertical blank region
  | 'chrome-leak';    // no known page-chrome strings in the body text

export interface ClipHealthOptions {
  /** Disable specific checks (for documented, planned exceptions). */
  disable?: ClipHealthCheck[];
  /** Site-specific junk strings to flag in addition to the defaults. */
  extraChromeStrings?: string[];
}

// Strings that mark page chrome which the capture pipeline should have
// stripped. Matched case-insensitively against the clip body's text.
const CHROME_STRINGS = [
  'Suggested for you',
  'Discover more',
  'Want to know more',
  'Show Comments',
  'preferred source',      // "Make this site a preferred Google source"
  'Subscribe to our newsletter',
  'Open comment sort options',
  'Expand comment search',
  'Skip to content',
  'Jump to ratings',
];

export async function collectClipBodyViolations(
  clipBody: Locator,
  opts: ClipHealthOptions = {},
): Promise<string[]> {
  const disabled = new Set(opts.disable ?? []);
  const chromeStrings = [...CHROME_STRINGS, ...(opts.extraChromeStrings ?? [])];

  const violations = await clipBody.evaluate(
    (root, args) => {
      const { disabled, chromeStrings } = args as {
        disabled: string[];
        chromeStrings: string[];
      };
      const off = new Set(disabled);
      const out: string[] = [];
      const brief = (el: Element) =>
        `<${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent ?? '').trim().slice(0, 50)}"`;

      // ── header-layout ────────────────────────────────────────────────────
      // The defect this guards against: the author NAME wraps UNDER the avatar
      // instead of sitting beside it. We detect that directly (avatar and name
      // no longer share a visual row) rather than by absolute header height —
      // some sites (bsky) legitimately scope dx-header to a wrapper that also
      // contains the post body, so the element is tall by design while the
      // avatar/name row itself is fine.
      if (!off.has('header-layout')) {
        for (const h of Array.from(root.querySelectorAll('.dx-header'))) {
          const cs = getComputedStyle(h);
          const rect = h.getBoundingClientRect();
          if (rect.height === 0) continue; // hidden header — reply-height covers its post
          if (cs.display !== 'flex') {
            out.push(`header-layout: dx-header display is "${cs.display}", expected flex — ${brief(h)}`);
          }
          // Find the avatar and the first text-bearing element; if both exist,
          // assert their top edges are within ~24px (i.e. same row). A name
          // stacked below the avatar shows a top delta of a full avatar height.
          const avatar = h.querySelector('img.dx-avatar, img') as HTMLElement | null;
          const nameEl = Array.from(h.querySelectorAll('a, span, div'))
            .find((el) => {
              const t = (el.textContent ?? '').trim();
              return t.length >= 2 && !el.querySelector('img') &&
                (el.getBoundingClientRect().height > 0);
            }) as HTMLElement | undefined;
          if (avatar && nameEl) {
            const av = avatar.getBoundingClientRect();
            const nm = nameEl.getBoundingClientRect();
            if (av.height > 0 && nm.height > 0 && nm.top - av.top > 24) {
              out.push(
                `header-layout: author name sits ${Math.round(nm.top - av.top)}px below the avatar ` +
                `(should be beside it) — ${brief(h)}`,
              );
            }
          } else if (!avatar && rect.height > 120) {
            // No avatar at all AND unusually tall — the generic-tagger case
            // where a plain byline got over-broad; keep the original guard.
            out.push(`header-layout: avatar-less dx-header is ${Math.round(rect.height)}px tall — ${brief(h)}`);
          }
        }
      }

      // ── reply-height ─────────────────────────────────────────────────────
      if (!off.has('reply-height')) {
        for (const r of Array.from(root.querySelectorAll('.dx-reply'))) {
          if (r.classList.contains('dx-reply-row')) continue;
          if (r.getBoundingClientRect().height <= 0) {
            out.push(`reply-height: dx-reply collapsed to 0px — ${brief(r)}`);
          }
        }
      }

      // ── zaps-avatars ─────────────────────────────────────────────────────
      if (!off.has('zaps-avatars')) {
        for (const z of Array.from(root.querySelectorAll('.dx-zaps-row'))) {
          const imgs = Array.from(z.querySelectorAll('img')) as HTMLImageElement[];
          if (imgs.length === 0) continue;
          const disp = getComputedStyle(z).display;
          if (disp !== 'flex') {
            out.push(`zaps-avatars: dx-zaps-row with images has display "${disp}", expected flex`);
          }
          for (const img of imgs) {
            if (img.offsetWidth > 32 || img.offsetHeight > 32) {
              out.push(`zaps-avatars: zapper avatar rendered ${img.offsetWidth}x${img.offsetHeight}px (max 32)`);
            }
          }
        }
      }

      // ── img-distortion ───────────────────────────────────────────────────
      // A stray avatar that escapes its sizing container gets stretched to the
      // column width and renders as a giant ellipse (seen on primal replies).
      // Two rules:
      //   1. Round-clipped images (border-radius ~50%) must render roughly
      //      square — a 300x35 "avatar" is broken no matter what object-fit
      //      says, because cover/contain crop the pixels but not the shape.
      //   2. Other images: rendered aspect must track natural aspect unless
      //      CSS is deliberately cropping (object-fit cover/contain).
      // Only images small in BOTH dimensions (icons) are exempt — a 300x35
      // strip is exactly the defect we're hunting.
      if (!off.has('img-distortion')) {
        let flagged = 0;
        for (const img of Array.from(root.querySelectorAll('img')) as HTMLImageElement[]) {
          if (flagged >= 5) break;
          const { naturalWidth: nw, naturalHeight: nh, offsetWidth: rw, offsetHeight: rh } = img;
          if (rw < 2 || rh < 2 || (rw < 48 && rh < 48)) continue;
          const cs = getComputedStyle(img);
          const src = (img.getAttribute('data-dx-src') ?? img.src).slice(0, 80);

          const shape = rw / rh;
          if (nw < 2 || nh < 2) continue;
          if (cs.objectFit === 'cover' || cs.objectFit === 'contain') continue;
          const distortion = shape / (nw / nh);
          if (distortion > 1.8 || distortion < 1 / 1.8) {
            flagged++;
            out.push(
              `img-distortion: img rendered ${rw}x${rh} vs natural ${nw}x${nh} ` +
              `(${distortion.toFixed(2)}x aspect distortion) — src=${src}…`,
            );
          }
        }
      }

      // ── round-shape ──────────────────────────────────────────────────────
      // Anything clipped to a circle (border-radius 50%) must render roughly
      // square. The primal "gray ellipse" defect: avatar-circle CSS lands on a
      // reply's CONTENT cell (a div with a painted background and the reply's
      // text), stretching a 561x40 ellipse across the column. Applies to divs
      // as well as imgs — the broken element need not be an image.
      if (!off.has('round-shape')) {
        let flagged = 0;
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (flagged >= 5) break;
          const r = el.getBoundingClientRect();
          if (r.width < 24 || r.height < 8) continue;
          const shape = r.width / r.height;
          if (shape <= 1.66 && shape >= 0.6) continue;
          const cs = getComputedStyle(el);
          if (!/50%/.test(cs.borderRadius)) continue;
          const isImg = el.tagName === 'IMG';
          const painted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
          const hasText = (el.textContent ?? '').trim().length >= 10;
          if (!isImg && !painted && !hasText) continue;
          flagged++;
          out.push(
            `round-shape: border-radius:50% element rendered ${Math.round(r.width)}x${Math.round(r.height)}px ` +
            `(should be ~square) — ${brief(el)}`,
          );
        }
      }

      // ── text-squeeze ─────────────────────────────────────────────────────
      // Tall, skinny elements full of wrapped text = a flex/grid column that
      // lost its width (reddit "80 more replies" letter-per-line, bsky
      // "Reposted by" strip). Thread lines and avatar rails have no text and
      // are not flagged.
      if (!off.has('text-squeeze')) {
        let flagged = 0;
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (flagged >= 5) break;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.width > 120 || rect.height < 150) continue;
          if (rect.height / rect.width < 3) continue;
          if (el.querySelector('img, svg, video')) continue;
          const text = (el.textContent ?? '').trim();
          if (text.length < 10) continue;
          // Skip ancestors of an already-flagged element: flag the deepest.
          if (Array.from(el.children).some((c) => {
            const cr = c.getBoundingClientRect();
            return cr.width <= 120 && cr.height >= 150 && cr.height / Math.max(cr.width, 1) >= 3;
          })) continue;
          flagged++;
          out.push(
            `text-squeeze: ${Math.round(rect.width)}x${Math.round(rect.height)}px column of wrapped text — ${brief(el)}`,
          );
        }
      }

      // ── blank-run ────────────────────────────────────────────────────────
      // Merge the vertical extents of every text/image leaf; any gap larger
      // than 1500px means the layout reserved a screen+ of empty space.
      if (!off.has('blank-run')) {
        const rootRect = root.getBoundingClientRect();
        const spans: Array<[number, number]> = [];
        const els = Array.from(root.querySelectorAll('*'));
        for (let i = 0; i < els.length && i < 20000; i++) {
          const el = els[i];
          const isImg = el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'SVG';
          if (!isImg) {
            // Only leaves with their own text contribute; containers span
            // their children anyway.
            const ownText = Array.from(el.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent ?? '')
              .join('').trim();
            if (ownText.length === 0) continue;
          }
          const r = el.getBoundingClientRect();
          if (r.height <= 0) continue;
          spans.push([r.top - rootRect.top, r.bottom - rootRect.top]);
        }
        spans.sort((a, b) => a[0] - b[0]);
        let cursor = 0;
        for (const [top, bottom] of spans) {
          if (top - cursor > 1500) {
            out.push(`blank-run: ${Math.round(top - cursor)}px of empty space starting at y=${Math.round(cursor)}`);
            break;
          }
          cursor = Math.max(cursor, bottom);
        }
        if (spans.length > 0 && rootRect.height - cursor > 1500) {
          out.push(`blank-run: ${Math.round(rootRect.height - cursor)}px of trailing empty space (clip body ${Math.round(rootRect.height)}px tall)`);
        }
      }

      // ── chrome-leak ──────────────────────────────────────────────────────
      if (!off.has('chrome-leak')) {
        const text = (root.textContent ?? '').toLowerCase();
        for (const s of chromeStrings) {
          if (text.includes(s.toLowerCase())) {
            out.push(`chrome-leak: clip body contains "${s}" — page chrome survived capture`);
          }
        }
      }

      return out;
    },
    { disabled: [...disabled], chromeStrings },
  );

  return violations;
}

export async function assertClipBodyHealth(
  clipBody: Locator,
  opts: ClipHealthOptions = {},
): Promise<void> {
  const violations = await collectClipBodyViolations(clipBody, opts);
  expect(
    violations,
    `clip body failed ${violations.length} health check(s):\n  - ${violations.join('\n  - ')}`,
  ).toEqual([]);
}
