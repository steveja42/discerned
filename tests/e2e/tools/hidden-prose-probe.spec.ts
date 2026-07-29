// Diagnostic probe for the "clip captured almost no text" class of sweep finding.
//
// A low text-coverage score has two very different causes, and the fix (or the
// decision NOT to fix) depends entirely on which one it is:
//
//   * PAYWALL / hidden prose — the article text is in the DOM but the reader
//     can't see it (visibility:hidden, a collapse, a subscription modal). The
//     capture is FAITHFUL; there is nothing to fix.
//   * FINDER MIS-PICK — the prose is visible and a worse block won the scoring.
//     That IS a bug.
//
// Offline fixtures can't tell these apart (see the AP News lesson in
// HANDOFF-corpus-sweep.md), so this runs against the LIVE page in the warm
// Profile 3. For each target it reports how many prose <p>s are visible vs
// hidden and what hid them, then where the visible prose actually lives.
//
// Run:
//   HIDDEN=1 pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=hidden-prose-probe
// Options: HIDDEN_ONLY=folha,thehindu (subset), HIDDEN_HEADED=1.

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const TARGETS: Record<string, string> = {
  thehindu: 'https://www.thehindu.com/sci-tech/technology/moonshot-ai-releases-weights-for-kimi-k3-as-us-big-tech-firms-debate-open-weight-models/article71276300.ece',
  folha: 'https://www1.folha.uol.com.br/mercado/2026/07/china-busca-lideranca-nas-regras-da-ia-com-nova-organizacao-internacional.shtml',
  haaretz: 'https://www.haaretz.com/gaza/2026-07-26/ty-article/al-jazeera-reportedly-ends-contracts-of-over-20-gazan-journalists/0000019f-9eeb-df42-a1df-fffb994d0000',
  'rfc-editor': 'https://www.rfc-editor.org/rfc/rfc9110.html',
};

test.describe.configure({ mode: 'serial' });

test('why is the prose invisible?', async () => {
  test.skip(!process.env.HIDDEN, 'set HIDDEN=1 to run the hidden-prose probe');
  test.setTimeout(300_000);

  const only = process.env.HIDDEN_ONLY
    ? new Set(process.env.HIDDEN_ONLY.split(',').map(s => s.trim()))
    : null;
  const entries = Object.entries(TARGETS).filter(([n]) => !only || only.has(n));

  const rawUserDataDir = process.env.RAW_USER_DATA_DIR ??
    resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome');
  const { ctx } = await launchWithExtension({
    rawUserDataDir, profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true, headed: !!process.env.HIDDEN_HEADED,
    clearSwCacheForRawDir: true,
  });

  mkdirSync(resolve(__dirname, '..', '..', '..', 'test-output'), { recursive: true });
  const out: string[] = [];

  try {
    for (const [name, url] of entries) {
      const page = await ctx.newPage();
      out.push(`\n════════ ${name} ════════\n${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(4_000);
        await page.evaluate(async () => {
          for (let y = 0; y < 6000; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 250)); }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(1_500);

        const report = await page.evaluate(() => {
          const lines: string[] = [];
          const ps = Array.from(document.querySelectorAll('p'))
            .filter(p => (p.textContent ?? '').trim().length > 60);
          lines.push(`prose <p> with >60ch: ${ps.length}`);

          let visible = 0, hidden = 0;
          const reasons = new Map<string, number>();
          const samples: string[] = [];

          for (const p of ps) {
            const vis = (p as HTMLElement).innerText.replace(/\s+/g, ' ').trim().length;
            if (vis > 0) { visible++; continue; }
            hidden++;
            // Walk up to find WHAT hid it.
            let cur: Element | null = p;
            let reason = '(none found — innerText empty but no hiding ancestor)';
            let culpritDesc = '';
            while (cur && cur !== document.body) {
              const cs = getComputedStyle(cur);
              const r = cur.getBoundingClientRect();
              const why =
                cs.display === 'none' ? 'display:none' :
                cs.visibility === 'hidden' ? 'visibility:hidden' :
                cs.opacity === '0' ? 'opacity:0' :
                (cs.overflow === 'hidden' && r.height < 4) ? `overflow:hidden + height=${Math.round(r.height)}` :
                (r.height === 0) ? 'height:0' :
                cs.clipPath && cs.clipPath !== 'none' ? `clip-path:${cs.clipPath}` : '';
              if (why) {
                reason = why;
                culpritDesc = `<${cur.tagName.toLowerCase()} class="${(cur.className || '').toString().slice(0, 60)}">`;
                break;
              }
              cur = cur.parentElement;
            }
            reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
            if (samples.length < 4) {
              samples.push(`   ${reason}  on ${culpritDesc}\n     text: "${(p.textContent ?? '').trim().slice(0, 80)}"`);
            }
          }
          lines.push(`visible: ${visible}   hidden: ${hidden}`);
          if (hidden) {
            lines.push('hiding reasons:');
            for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
              lines.push(`   ${n.toString().padStart(4)} × ${r}`);
            }
            lines.push('samples:');
            lines.push(...samples);
          }

          // Where the VISIBLE prose lives — "one block the finder missed" reads
          // very differently from "only N paragraphs are readable at all".
          const byContainer = new Map<string, { n: number; chars: number }>();
          for (const p of ps) {
            const vis = (p as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
            if (!vis) continue;
            let host: Element | null = p;
            for (let i = 0; i < 6 && host; i++) {
              if ((host.className || '').toString().trim()) break;
              host = host.parentElement;
            }
            const key = host ? `${host.tagName.toLowerCase()}.${(host.className || '').toString().slice(0, 45)}` : '(none)';
            const e = byContainer.get(key) ?? { n: 0, chars: 0 };
            e.n++; e.chars += vis.length;
            byContainer.set(key, e);
          }
          lines.push('visible prose by container:');
          for (const [k, v] of [...byContainer.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 8)) {
            lines.push(`   ${v.n.toString().padStart(3)}p ${v.chars.toString().padStart(6)}ch  ${k}`);
          }

          const t = (document.body.innerText ?? '').toLowerCase();
          const marks = ['subscribe', 'subscription', 'premium', 'sign in to read', 'already a subscriber',
            'assine', 'continue reading', 'unlock', 'paywall'];
          lines.push(`paywall words present: ${marks.filter(m => t.includes(m)).join(', ') || '(none)'}`);
          return lines.join('\n');
        });
        out.push(report);
      } catch (e) {
        out.push(`ERROR: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await ctx.close();
  }

  const p = resolve(__dirname, '..', '..', '..', 'test-output', 'hidden-prose.txt');
  writeFileSync(p, out.join('\n'), 'utf8');
  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
  // eslint-disable-next-line no-console
  console.log(`\n→ ${p}`);
});
