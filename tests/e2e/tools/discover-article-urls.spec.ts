// Article-URL discovery tool for the corpus sweep (recreated — the older
// tools/discover-article-urls.mjs referenced in HANDOFF-corpus-sweep.md was not in
// the tree). Runs against the SAME warm branded-Chrome Profile 3 the sweep uses
// (cf_clearance + hand-installed extension), so a URL it discovers is one that
// actually LOADS in that environment — WebFetch/curl can't predict that (they hit
// bot walls the warm profile clears, and vice-versa).
//
// For each SEED (a section / hub / listing page for a site NOT already in the
// corpus), it navigates there, waits, and scrapes the best article deep-links via
// a per-seed link-picker (a URL-path regex + a min anchor-text length so we skip
// nav/section chrome and pick real stories). It prints — and writes to
// test-output/discovered-urls.json — a corpus-domains-shaped entry per seed
// (first link that passes the picker), plus a few runners-up per seed so a rotted
// pick can be swapped without re-running.
//
// This is a DISCOVERY tool, not a gate. Run:
//   $env:DISCOVER='1'; pnpm exec playwright test -c tests/e2e/playwright.config.ts \
//     --project=discover-article-urls
// Options: DISCOVER_ONLY=rollingstone,variety (subset), DISCOVER_HEADED=1.

import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWithExtension } from '../helpers/launchExtension';

interface Seed {
  /** corpus-domains name for the discovered entry. */
  name: string;
  /** section / hub / listing page to scrape links from. */
  seedUrl: string;
  /** RegExp source matched against each anchor's href — an article-shaped path. */
  hrefRe: string;
  /** Minimum anchor text length to accept (skips icon/section/nav links). */
  minText?: number;
  /** Free-text note carried into the corpus entry. */
  note?: string;
}

// ~50 seeds NOT already in corpus-domains.json, weighted to news/media + entity/
// structured pages (per the requested mix). hrefRe encodes each site's real
// article-URL shape (date segments, /article/, numeric ids, entity slugs).
const SEEDS: Seed[] = [
  // ── News / media (mainstream + magazine + international) ──────────────────
  { name: 'washingtonpost', seedUrl: 'https://www.washingtonpost.com/technology/', hrefRe: '/technology/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'news article (paywall-lite)' },
  { name: 'latimes', seedUrl: 'https://www.latimes.com/technology', hrefRe: '/[a-z-]+/story/\\d{4}-\\d{2}-\\d{2}/[a-z0-9-]+', note: 'news article' },
  { name: 'usatoday', seedUrl: 'https://www.usatoday.com/tech/', hrefRe: '/story/[a-z/]+/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/\\d+/', note: 'news article' },
  { name: 'time', seedUrl: 'https://time.com/section/tech/', hrefRe: '/\\d{6,}/[a-z0-9-]+/', note: 'magazine article' },
  { name: 'newsweek', seedUrl: 'https://www.newsweek.com/tech-science', hrefRe: '/[a-z0-9-]+-\\d{6,}$', note: 'news article' },
  { name: 'businessinsider', seedUrl: 'https://www.businessinsider.com/tech', hrefRe: '/[a-z0-9-]+-\\d{4}-\\d{1,2}$', note: 'business news article' },
  { name: 'forbes', seedUrl: 'https://www.forbes.com/innovation/', hrefRe: '/sites/[a-z0-9-]+/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'business/tech article (interstitial-prone)' },
  { name: 'fortune', seedUrl: 'https://fortune.com/section/tech/', hrefRe: '/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'business article' },
  { name: 'cnbc', seedUrl: 'https://www.cnbc.com/technology/', hrefRe: '/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+\\.html', note: 'business/tech article' },
  { name: 'foxnews', seedUrl: 'https://www.foxnews.com/tech', hrefRe: 'foxnews\\.com/tech/[a-z0-9-]{20,}$', note: 'news article' },
  { name: 'abcnews', seedUrl: 'https://abcnews.go.com/Technology', hrefRe: 'abcnews\\.go\\.com/[A-Za-z]+/[a-z0-9-]+/story\\?id=\\d+', note: 'news article' },
  { name: 'cbsnews', seedUrl: 'https://www.cbsnews.com/technology/', hrefRe: '/news/[a-z0-9-]+/', note: 'news article' },
  { name: 'usnews', seedUrl: 'https://www.usnews.com/news/technology', hrefRe: '/news/[a-z-]+/articles/\\d{4}-\\d{2}-\\d{2}/[a-z0-9-]+', note: 'news article' },
  { name: 'thehill', seedUrl: 'https://thehill.com/policy/technology/', hrefRe: 'thehill\\.com/policy/technology/\\d{6,}-[a-z0-9-]+/', note: 'politics/tech article' },
  { name: 'apnews-tech', seedUrl: 'https://apnews.com/technology', hrefRe: '/article/[a-z0-9-]+', note: 'wire tech article (may need headed)' },
  { name: 'skynews', seedUrl: 'https://news.sky.com/technology', hrefRe: 'news\\.sky\\.com/story/[a-z0-9-]+-\\d{6,}', note: 'UK news article' },
  { name: 'independent', seedUrl: 'https://www.independent.co.uk/tech', hrefRe: '/tech/[a-z0-9-]+-b\\d+\\.html', note: 'UK news article' },
  { name: 'telegraph', seedUrl: 'https://www.telegraph.co.uk/technology/', hrefRe: 'telegraph\\.co\\.uk/[a-z-]+/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', minText: 10, note: 'UK news article (paywall)' },
  { name: 'lemonde', seedUrl: 'https://www.lemonde.fr/pixels/', hrefRe: 'lemonde\\.fr/[a-z-]+/article/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+', note: 'French news article (non-English)' },
  { name: 'spiegel', seedUrl: 'https://www.spiegel.de/netzwelt/', hrefRe: '/netzwelt/[a-z0-9-]+-a-[a-z0-9-]+', note: 'German news article (non-English)' },
  { name: 'dw', seedUrl: 'https://www.dw.com/en/technology/s-100816', hrefRe: 'dw\\.com/en/[a-z0-9-]{15,}/a-\\d+', note: 'German intl news (English)' },
  { name: 'aljazeera-tech', seedUrl: 'https://www.aljazeera.com/tag/science-and-technology/', hrefRe: '/[a-z]+/\\d{4}/\\d{1,2}/\\d{1,2}/[a-z0-9-]+', note: 'intl news article' },
  { name: 'timesofindia', seedUrl: 'https://timesofindia.indiatimes.com/technology', hrefRe: '/articleshow/\\d+\\.cms', note: 'India news article' },
  { name: 'scmp', seedUrl: 'https://www.scmp.com/tech', hrefRe: '/tech/[a-z0-9-]+/article/\\d+/[a-z0-9-]+', note: 'HK news article' },
  { name: 'engadget', seedUrl: 'https://www.engadget.com/', hrefRe: '/[a-z0-9-]+-\\d{6}\\d*\\.html', note: 'tech news article' },
  { name: 'gizmodo', seedUrl: 'https://gizmodo.com/tech', hrefRe: '/[a-z0-9-]+-\\d{6,}', note: 'tech news article' },
  { name: 'venturebeat', seedUrl: 'https://venturebeat.com/category/ai/', hrefRe: 'venturebeat\\.com/[a-z-]+/[a-z0-9-]{15,}/$', note: 'tech news article' },
  { name: 'zdnet', seedUrl: 'https://www.zdnet.com/topic/artificial-intelligence/', hrefRe: '/article/[a-z0-9-]+/', note: 'tech news article' },
  { name: 'pcmag', seedUrl: 'https://www.pcmag.com/news', hrefRe: '/news/[a-z0-9-]+$', note: 'tech news article' },
  { name: 'macrumors', seedUrl: 'https://www.macrumors.com/', hrefRe: '/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'Apple news article' },
  { name: '9to5mac', seedUrl: 'https://9to5mac.com/', hrefRe: '/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'Apple news article' },
  { name: 'polygon', seedUrl: 'https://www.polygon.com/', hrefRe: 'polygon\\.com/\\d{6,}/[a-z0-9-]+', note: 'gaming news article' },
  { name: 'kotaku', seedUrl: 'https://kotaku.com/', hrefRe: '/[a-z0-9-]+-\\d{6,}', note: 'gaming news article' },
  { name: 'signalvnoise', seedUrl: 'https://world.hey.com/dhh', hrefRe: 'world\\.hey\\.com/dhh/[a-z0-9-]+-[0-9a-f]{8}', minText: 6, note: 'personal blog (hey world)' },

  // ── Entity / structured (product, film, book, profile, directory) ─────────
  { name: 'rottentomatoes', seedUrl: 'https://www.rottentomatoes.com/browse/movies_in_theaters/', hrefRe: '^https://www\\.rottentomatoes\\.com/m/[a-z0-9_]+$', minText: 3, note: 'film entity page' },
  { name: 'metacritic', seedUrl: 'https://www.metacritic.com/browse/movie/netflix/', hrefRe: 'metacritic\\.com/movie/[a-z0-9-]+/$', minText: 3, note: 'film entity page' },
  { name: 'letterboxd', seedUrl: 'https://letterboxd.com/films/popular/this/week/', hrefRe: 'letterboxd\\.com/film/[a-z0-9-]+/$', minText: 1, note: 'film entity page' },
  { name: 'tmdb', seedUrl: 'https://www.themoviedb.org/movie', hrefRe: '/movie/\\d+-[a-z0-9-]+$', minText: 2, note: 'film entity page' },
  { name: 'steam', seedUrl: 'https://store.steampowered.com/search/?filter=topsellers', hrefRe: '^https://store\\.steampowered\\.com/app/\\d+/', minText: 2, note: 'game store entity page' },
  { name: 'bestbuy', seedUrl: 'https://www.bestbuy.com/site/computers-pcs/laptops/abcat0502000.c', hrefRe: 'bestbuy\\.com/site/[a-z0-9-]+/\\d+\\.p', minText: 0, note: 'product entity page (heavy chrome)' },
  { name: 'walmart', seedUrl: 'https://www.walmart.com/browse/electronics/3944_1089430', hrefRe: 'walmart\\.com/ip/[A-Za-z0-9-]+/\\d+', minText: 0, note: 'product entity page (heavy chrome)' },
  { name: 'target', seedUrl: 'https://www.target.com/c/electronics/-/N-5xtg6', hrefRe: 'target\\.com/p/[a-z0-9-]+/-/A-\\d+', minText: 0, note: 'product entity page' },
  { name: 'etsy', seedUrl: 'https://www.etsy.com/search?q=leather+wallet&ref=search_bar', hrefRe: 'etsy\\.com/listing/\\d+/', minText: 0, note: 'marketplace listing entity page' },
  { name: 'ebay', seedUrl: 'https://www.ebay.com/b/Cell-Phones-Smartphones/9355/bn_320094', hrefRe: 'ebay\\.com/itm/\\d+', minText: 0, note: 'marketplace listing entity page' },
  { name: 'yelp', seedUrl: 'https://www.yelp.com/search?find_desc=coffee&find_loc=San+Francisco', hrefRe: 'yelp\\.com/biz/[a-z0-9-]+', minText: 0, note: 'business profile entity page' },
  { name: 'tripadvisor', seedUrl: 'https://www.tripadvisor.com/Restaurants-g60713-San_Francisco_California.html', hrefRe: 'Restaurant_Review-[a-zA-Z0-9_-]+\\.html', minText: 0, note: 'restaurant entity page' },
  { name: 'zillow', seedUrl: 'https://www.zillow.com/homes/San-Francisco,-CA_rb/', hrefRe: 'zillow\\.com/homedetails/[A-Za-z0-9-]+/\\d+_zpid/', minText: 0, note: 'real-estate listing entity page' },
  { name: 'crunchbase', seedUrl: 'https://www.crunchbase.com/organization/openai', hrefRe: 'crunchbase\\.com/organization/openai$', minText: 0, note: 'company entity page (direct)' },
  { name: 'allrecipes', seedUrl: 'https://www.allrecipes.com/recipes-a-z-6735880', hrefRe: 'allrecipes\\.com/recipe/\\d+/[a-z0-9-]+/', minText: 0, note: 'recipe entity page' },
  { name: 'discogs', seedUrl: 'https://www.discogs.com/search/?type=release&sort=have%2Cdesc', hrefRe: 'discogs\\.com/release/\\d+-', minText: 0, note: 'music release entity page' },
  { name: 'bandcamp', seedUrl: 'https://bandcamp.com/discover', hrefRe: '\\.bandcamp\\.com/album/[a-z0-9-]+', minText: 2, note: 'album entity page' },
  { name: 'genius', seedUrl: 'https://genius.com/tags/pop', hrefRe: 'genius\\.com/[A-Za-z0-9-]+-lyrics$', minText: 3, note: 'song lyrics entity page' },
];

test.describe.configure({ mode: 'serial' });

test('discover article URLs for the corpus sweep', async () => {
  test.skip(!process.env.DISCOVER, 'set DISCOVER=1 to run the article-URL discovery tool');
  test.setTimeout(SEEDS.length * 30_000 + 60_000);

  const only = process.env.DISCOVER_ONLY
    ? new Set(process.env.DISCOVER_ONLY.split(',').map(s => s.trim()))
    : null;
  const seeds = only ? SEEDS.filter(s => only.has(s.name)) : SEEDS;

  const rawUserDataDir = process.env.RAW_USER_DATA_DIR ??
    resolve(__dirname, '..', '..', '..', '.vscode', 'browser-test-profiles', 'chrome');
  const profileDirectory = process.env.PROFILE_DIR ?? 'Profile 3';
  const { ctx } = await launchWithExtension({
    rawUserDataDir, profileDirectory, channel: 'chrome', preinstalledExtension: true,
    headed: !!process.env.DISCOVER_HEADED, clearSwCacheForRawDir: true,
  });

  interface Discovered { name: string; url: string; note?: string; candidates: string[]; error?: string }
  const results: Discovered[] = [];

  try {
    for (const s of seeds) {
      const page = await ctx.newPage();
      const out: Discovered = { name: s.name, url: '', note: s.note, candidates: [] };
      try {
        await page.goto(s.seedUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
        await page.waitForTimeout(4_000);
        // Nudge lazy-loaded link grids (retail/news infinite feeds render anchors
        // only after a scroll) then return to top so the DOM has real hrefs.
        await page.evaluate(async () => {
          for (let y = 0; y < 4; y++) { window.scrollBy(0, window.innerHeight); await new Promise(r => setTimeout(r, 500)); }
          window.scrollTo(0, 0);
        }).catch(() => undefined);
        await page.waitForTimeout(1_000);
        const picks = await page.evaluate(
          ({ hrefRe, minText }: { hrefRe: string; minText: number }) => {
            const re = new RegExp(hrefRe);
            const seen = new Set<string>();
            const found: string[] = [];
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const href = (a as HTMLAnchorElement).href;
              const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (!re.test(href)) continue;
              if (text.length < minText) continue;
              // Strip query/hash for a clean canonical article URL.
              const clean = href.split('#')[0].split('?')[0];
              if (seen.has(clean)) continue;
              seen.add(clean);
              found.push(clean);
              if (found.length >= 8) break;
            }
            return found;
          },
          { hrefRe: s.hrefRe, minText: s.minText ?? 15 },
        );
        out.candidates = picks;
        out.url = picks[0] ?? '';
        if (!out.url) out.error = 'no link matched picker';
      } catch (e) {
        out.error = (e as Error).message.split('\n')[0];
      } finally {
        await page.close().catch(() => undefined);
      }
      results.push(out);
      // eslint-disable-next-line no-console
      console.log(out.url
        ? `OK    ${s.name.padEnd(18)} ${out.url}`
        : `MISS  ${s.name.padEnd(18)} ${out.error} (seed ${s.seedUrl})`);
    }
  } finally {
    await ctx.close();
  }

  const outPath = resolve(__dirname, '..', '..', '..', 'test-output', 'discovered-urls.json');
  writeFileSync(outPath, JSON.stringify({ discoveredAt: new Date().toISOString(), results }, null, 2), 'utf8');
  const hit = results.filter(r => r.url).length;
  // eslint-disable-next-line no-console
  console.log(`\nDiscovered ${hit}/${results.length} article URLs → ${outPath}`);
});
