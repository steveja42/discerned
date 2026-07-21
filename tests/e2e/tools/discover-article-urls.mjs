#!/usr/bin/env node
// One-off helper: for corpus-sweep entries whose URL is a homepage / section
// hub, navigate that page in the WARM sweep browser (Chrome Profile 3, Cloudflare-
// cleared) and read ONE real article link out of the LIVE DOM. Prints a mapping so
// the corpus can be updated with genuine, currently-live article URLs — no invented
// slugs. Sites that still show a challenge headless are retried HEADED.
//
// Usage:
//   node tests/e2e/tools/discover-article-urls.mjs            (headless, then headed retry)
//   node tests/e2e/tools/discover-article-urls.mjs --headed   (force headed)
//
// Output: JSON lines {name, from, picked|error} to stdout.

import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const RAW = resolve(process.cwd(), '.vscode', 'browser-test-profiles', 'chrome');
const forceHeaded = process.argv.includes('--headed');

// Section/hub pages to mine for a real article link, with a per-site regex that a
// genuine ARTICLE href must match (so we don't pick another hub/section/tag link).
const TARGETS = [
  { name: 'apnews',           from: 'https://apnews.com/hub/technology',                 re: /apnews\.com\/article\/[a-z0-9-]{20,}/i },
  { name: 'reuters',          from: 'https://www.reuters.com/technology/',               re: /reuters\.com\/[a-z-]+\/[a-z0-9-]+-\d{4}-\d{2}-\d{2}\/?$/i },
  { name: 'npr',              from: 'https://www.npr.org/sections/technology/',          re: /npr\.org\/\d{4}\/\d{2}\/\d{2}\/\d+\// },
  { name: 'theverge',         from: 'https://www.theverge.com/tech',                     re: /theverge\.com\/(?:[a-z-]+\/)?\d+\/[a-z0-9-]+/i },
  { name: 'arstechnica',      from: 'https://arstechnica.com/',                          re: /arstechnica\.com\/[a-z-]+\/\d{4}\/\d{2}\/[a-z0-9-]+\/?$/i },
  { name: 'techcrunch',       from: 'https://techcrunch.com/',                           re: /techcrunch\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\// },
  { name: 'wired',            from: 'https://www.wired.com/',                            re: /wired\.com\/story\/[a-z0-9-]+\/?$/i },
  { name: 'theguardian',      from: 'https://www.theguardian.com/international',         re: /theguardian\.com\/[a-z-]+\/\d{4}\/[a-z]{3}\/\d{2}\/[a-z0-9-]+/i },
  { name: 'aljazeera',        from: 'https://www.aljazeera.com/news/',                   re: /aljazeera\.com\/[a-z-]+\/\d{4}\/\d{1,2}\/\d{1,2}\/[a-z0-9-]+/i },
  { name: 'cnn',              from: 'https://www.cnn.com/',                              re: /cnn\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z-]+\/[a-z0-9-]+\/index\.html/i },
  { name: 'nbcnews',          from: 'https://www.nbcnews.com/',                          re: /nbcnews\.com\/[a-z-]+\/[a-z-]+\/[a-z0-9-]+-rcna\d+/i },
  { name: 'politico',         from: 'https://www.politico.com/',                         re: /politico\.com\/news\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+-\d+/i },
  { name: 'axios',            from: 'https://www.axios.com/technology',                  re: /axios\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+/i },
  { name: 'nature',           from: 'https://www.nature.com/news',                       re: /nature\.com\/articles\/[a-z0-9-]+/i },
  { name: 'sciencedaily',     from: 'https://www.sciencedaily.com/news/top/technology/', re: /sciencedaily\.com\/releases\/\d{4}\/\d{2}\/\d+\.htm/i },
  { name: 'github-blog',      from: 'https://github.blog/',                              re: /github\.blog\/[a-z0-9-]+\/[a-z0-9-]{10,}\/?$/i },
  { name: 'stackoverflow-blog', from: 'https://stackoverflow.blog/',                     re: /stackoverflow\.blog\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\// },
  { name: 'css-tricks',       from: 'https://css-tricks.com/',                           re: /css-tricks\.com\/[a-z0-9-]{8,}\/?$/i },
  { name: 'smashingmagazine', from: 'https://www.smashingmagazine.com/articles/',        re: /smashingmagazine\.com\/\d{4}\/\d{2}\/[a-z0-9-]+\// },
  { name: 'overreacted',      from: 'https://overreacted.io/',                           re: /overreacted\.io\/[a-z0-9-]{6,}\/?$/i },
  { name: 'danluu',           from: 'https://danluu.com/',                               re: /danluu\.com\/[a-z0-9-]{4,}\/?$/i },
  { name: 'ghost-blog',       from: 'https://blog.ghost.org/',                           re: /blog\.ghost\.org\/[a-z0-9-]{6,}\/?$/i },
  { name: 'dev-to',           from: 'https://dev.to/',                                   re: /dev\.to\/[a-z0-9_-]+\/[a-z0-9-]+-[a-z0-9]{3,}$/i },
  { name: 'hackaday',         from: 'https://hackaday.com/',                             re: /hackaday\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\// },
  { name: 'quantamagazine',   from: 'https://www.quantamagazine.org/',                   re: /quantamagazine\.org\/[a-z0-9-]+-\d{8}\/?$/i },
  { name: 'theatlantic',      from: 'https://www.theatlantic.com/technology/',           re: /theatlantic\.com\/[a-z-]+\/archive\/\d{4}\/\d{2}\/[a-z0-9-]+\/\d+\// },
  { name: 'newyorker',        from: 'https://www.newyorker.com/',                        re: /newyorker\.com\/(?:magazine|news)\/[a-z0-9\/-]+/i },
  { name: 'vox',              from: 'https://www.vox.com/',                              re: /vox\.com\/[a-z0-9-]+\/\d+\/[a-z0-9-]+/i },
  { name: 'espn',             from: 'https://www.espn.com/',                             re: /espn\.com\/[a-z]+\/story\/_\/id\/\d+\// },
  { name: 'nytimes',          from: 'https://www.nytimes.com/section/technology',        re: /nytimes\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z-]+\/[a-z0-9-]+\.html/i },
  { name: 'lobsters',         from: 'https://lobste.rs/',                                re: /lobste\.rs\/s\/[a-z0-9]+\/[a-z0-9_-]+/i },
  { name: 'reddit-thread',    from: 'https://www.reddit.com/r/programming/',             re: /reddit\.com\/r\/programming\/comments\/[a-z0-9]+\/[a-z0-9_]+\// },
];

const CHALLENGE_RE = /performing security verification|checking your browser|just a moment|access is temporarily restricted|attention required|verify you are human/i;

async function launch(headed) {
  return chromium.launchPersistentContext(RAW, {
    headless: false,
    channel: 'chrome',
    locale: 'en-US',
    args: [
      '--profile-directory=Profile 3',
      ...(headed ? [] : ['--headless=new']),
      '--disable-blink-features=AutomationControlled',
      '--disable-sync', '--disable-background-networking', '--no-first-run', '--mute-audio',
    ],
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--enable-automation'],
    viewport: { width: 1280, height: 900 },
  });
}

async function pickFrom(ctx, t) {
  const page = await ctx.newPage();
  try {
    await page.goto(t.from, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(3500);
    const bodyText = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 400));
    if (CHALLENGE_RE.test(bodyText) || bodyText.trim().length < 30) {
      return { challenged: true };
    }
    const href = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const seen = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const u = a.href;
        if (re.test(u)) { seen.push(u.split('#')[0].split('?')[0]); }
      }
      // Prefer the most common host-relative depth; just return the first match.
      return seen[0] ?? null;
    }, t.re.source);
    return { href };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

const results = [];
let ctx = await launch(forceHeaded);
const needHeaded = [];
for (const t of TARGETS) {
  const r = await pickFrom(ctx, t);
  if (r.challenged && !forceHeaded) { needHeaded.push(t); console.log(JSON.stringify({ name: t.name, status: 'challenged-will-retry-headed' })); continue; }
  results.push({ name: t.name, from: t.from, ...r });
  console.log(JSON.stringify({ name: t.name, picked: r.href ?? null, err: r.error ?? (r.challenged ? 'challenged' : (r.href ? undefined : 'no-match')) }));
}
await ctx.close();

// Headed retry pass for challenged sites.
if (needHeaded.length && !forceHeaded) {
  console.log(JSON.stringify({ status: `headed-retry for ${needHeaded.length} sites` }));
  ctx = await launch(true);
  for (const t of needHeaded) {
    const r = await pickFrom(ctx, t);
    results.push({ name: t.name, from: t.from, ...r, headed: true });
    console.log(JSON.stringify({ name: t.name, picked: r.href ?? null, headed: true, err: r.error ?? (r.challenged ? 'challenged-again' : (r.href ? undefined : 'no-match')) }));
  }
  await ctx.close();
}

console.log('DISCOVERY_JSON ' + JSON.stringify(results));
