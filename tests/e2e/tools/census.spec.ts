// Read the pipeline census for a page. Set CENSUS_URL to any site; CENSUS_DUMP=<name>
// also writes test-output/census-<name>-{source,clip}.html (the source is dumped AFTER
// capture, so it carries dx-* markers — use snapshot-page.spec.ts for a fixture).
import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';
import { activateExtensionOnTab } from '../helpers/activateExtension';

const OUT = resolve(__dirname, '..', '..', '..', 'test-output');

test('census: per-stage element counts', async () => {
  test.skip(!process.env.CENSUS, 'set CENSUS=1 to run');
  test.setTimeout(300_000);
  const { ctx } = await launchWithExtension({
    rawUserDataDir: resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome'),
    profileDirectory: process.env.PROFILE_DIR ?? 'Profile 3',
    channel: 'chrome', preinstalledExtension: true,
    headed: process.env.CENSUS_HEADED !== '0',
  });
  const p = await ctx.newPage();
  const lines: string[] = [];
  p.on('console', m => {
    const t = m.text();
    if (t.includes('pipeline census') || t.includes('census —') || t.includes('removeGenericChrome dropped')) lines.push(t);
  });
  try {
    await p.goto(process.env.CENSUS_URL ?? 'https://www.snapchat.com/spotlight',
      { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await p.waitForTimeout(15_000);
    await p.evaluate(() => { (window as unknown as { WIRTHY_CENSUS_IMGS?: boolean }).WIRTHY_CENSUS_IMGS = true; });
    await activateExtensionOnTab(ctx, p.url());
    const cap = await p.evaluate(() => new Promise((res) => {
      const t = setTimeout(() => res({ error: 'timeout' }), 60_000);
      const on = (e: MessageEvent) => {
        if (e.data?.type !== '__WIRTHY_TEST_CAPTURE_RESULT') return;
        clearTimeout(t); removeEventListener('message', on);
        res({ html: e.data.capture?.bodyHtml ?? '' });
      };
      addEventListener('message', on);
      postMessage({ type: '__WIRTHY_TEST_CAPTURE', format: 'article' }, location.origin);
    })) as { html?: string };
    await p.waitForTimeout(1200);
    const html = cap.html ?? '';
    lines.push(`FINAL: ${(html.match(/<img/g) || []).length}i in bodyHtml`);
    // CENSUS_DUMP=<name> also saves the live page DOM and the captured bodyHtml.
    const dump = process.env.CENSUS_DUMP;
    if (dump) {
      const src = await p.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
      writeFileSync(resolve(OUT, `census-${dump}-source.html`), src, 'utf8');
      writeFileSync(resolve(OUT, `census-${dump}-clip.html`), html, 'utf8');
    }
  } finally {
    writeFileSync(resolve(OUT, 'census.txt'), lines.join('\n'), 'utf8');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n') || '(no census lines — is this a dev build?)');
    await ctx.close();
  }
});
