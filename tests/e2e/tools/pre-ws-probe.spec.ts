// Diagnose WHY a highlighted <pre> loses its whitespace.
//
// The corpus sweep showed kubernetes.io's Pod manifest captured as
// "apiVersion:v1kind:Podmetadata:" while the plain shell block beside it was
// perfect. The capture pipeline was cleared by unit test — it preserves <pre>
// whitespace exactly — so the question is what the LIVE DOM actually contains:
// real whitespace text nodes (a pipeline bug), or none at all (the highlighter
// positions tokens with CSS, and the whitespace must be RECONSTRUCTED).
//
// Reports, per <pre> on the page: the child-node shape, whether any whitespace
// text nodes exist, and the computed display of the line wrappers.
//
// Run: PREWS=1 PREWS_URL=<url> pnpm exec playwright test \
//   -c tests/e2e/playwright.config.ts --project=pre-ws-probe

import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

const URL = process.env.PREWS_URL ?? 'https://kubernetes.io/docs/concepts/workloads/pods/';

test('pre-ws-probe', async () => {
  test.skip(!process.env.PREWS, 'set PREWS=1 to run');
  test.setTimeout(180_000);

  const { ctx } = await launchWithExtension({ profile: 'test', headed: !!process.env.PWDEBUG_HEADED });
  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3500);

    const report = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('pre').forEach((pre, idx) => {
        const code = pre.querySelector('code') ?? pre;
        const kids = Array.from(code.childNodes);
        const wsTextNodes = kids.filter(
          (n) => n.nodeType === 3 && /^\s+$/.test(n.nodeValue ?? ''),
        ).length;
        const anyTextNodes = kids.filter((n) => n.nodeType === 3).length;
        // Whitespace ANYWHERE in the subtree, not just as a direct child.
        let deepWs = 0;
        const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = w.nextNode())) if (/\s/.test(n.nodeValue ?? '')) deepWs++;

        const firstEl = kids.find((k) => k.nodeType === 1) as Element | undefined;
        const disp = firstEl ? getComputedStyle(firstEl).display : '(none)';
        const text = (code.textContent ?? '').slice(0, 90).replace(/\n/g, '\n');
        out.push(
          `[pre #${idx}] class=${JSON.stringify(pre.className).slice(0, 60)}\n` +
          `  childNodes=${kids.length} textNodes=${anyTextNodes} ws-only-textNodes=${wsTextNodes} deepWsTextNodes=${deepWs}\n` +
          `  firstElementChild=<${firstEl?.tagName.toLowerCase() ?? '-'}> display=${disp}\n` +
          `  textContent[0:90]=${JSON.stringify(text)}\n` +
          `  innerHTML[0:260]=${JSON.stringify((code as HTMLElement).innerHTML.slice(0, 260))}`,
        );
      });
      return out.join('\n\n');
    });

    const dir = resolve(__dirname, '..', '..', '..', 'test-output');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'pre-ws-probe.txt'), `${URL}\n\n${report}\n`, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`\n=== ${URL} ===\n${report}\n`);
  } finally {
    await ctx.close();
  }
});
