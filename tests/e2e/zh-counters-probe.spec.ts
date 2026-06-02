// Quick probe: find the live-DOM source of the trailing 20,762 / 179 counters
// on zerohedge.com so we can decide what to do with them (right-align, drop,
// reinstate the icons, etc.). Run with: PROBE_ZH=1 ...

import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL =
  process.env.EMBED_URL ||
  'https://www.zerohedge.com/geopolitical/brief-exchange-top-us-cuban-military-leaders-meet-edge-guantanamo-base';

test('probe zerohedge trailing counters', async () => {
  test.skip(!process.env.PROBE_ZH, 'set PROBE_ZH=1 to run this');
  test.setTimeout(120_000);

  const outDir = resolve(__dirname, '..', '..', 'test-output');
  mkdirSync(outDir, { recursive: true });

  const userDataDir = mkdtempSync(join(tmpdir(), 'discerned-probe-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--headless=new', '--no-sandbox', '--no-first-run'],
    viewport: { width: 1280, height: 2400 },
  });

  try {
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(4_000);

    const result = await page.evaluate(() => {
      // Find all elements whose class contains "footerStat" and dump their
      // grandparent + parent + own + first-child to understand the structure.
      const stats = Array.from(document.querySelectorAll('[class*="footerStat"]'));
      return stats.slice(0, 6).map(el => {
        return {
          ownHtml: el.outerHTML.slice(0, 500),
          ownClasses: el.className.toString(),
          parentClasses: el.parentElement?.className.toString() ?? '',
          parentTag: el.parentElement?.tagName.toLowerCase() ?? '',
          parentChildren: el.parentElement
            ? Array.from(el.parentElement.children).map(c => ({
                tag: c.tagName.toLowerCase(),
                classes: c.className.toString().slice(0, 80),
                text: (c.textContent ?? '').trim().slice(0, 30),
              }))
            : [],
          grandparentClasses: el.parentElement?.parentElement?.className.toString() ?? '',
        };
      });
    });

    writeFileSync(resolve(outDir, 'zh-counters.json'), JSON.stringify(result, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log('Found', result.length, '[class*="footerStat"] elements');
    for (const c of result) {
      // eslint-disable-next-line no-console
      console.log('---');
      console.log('own classes:', c.ownClasses);
      console.log('own html:', c.ownHtml.slice(0, 220));
      console.log('parent tag/classes:', c.parentTag, c.parentClasses);
      console.log('parent has', c.parentChildren.length, 'children:');
      for (const ch of c.parentChildren) console.log('   -', ch.tag, '|', ch.text, '|', ch.classes);
      console.log('grandparent classes:', c.grandparentClasses);
    }
  } finally {
    await ctx.close();
  }
});
