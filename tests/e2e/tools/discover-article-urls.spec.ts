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
  /**
   * Stable deep-link that needs no scraping (docs pages, canonical entity pages,
   * evergreen essays). We still NAVIGATE to it so the run proves it loads in the
   * warm profile — the point of doing discovery live — but the seedUrl itself is
   * the corpus URL. `hrefRe` is ignored for these.
   */
  direct?: boolean;
}

// Seeds NOT already in corpus-domains.json, weighted to news/media + entity/
// structured pages (per the requested mix). hrefRe encodes each site's real
// article-URL shape (date segments, /article/, numeric ids, entity slugs).
// The first block is the original Phase 4.3 batch (~50); the PHASE 4.4 block
// below adds 100 more. Seeds are kept here after their URLs land in
// corpus-domains.json — re-running the tool is how a rotted URL is refreshed.
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

  // ══ PHASE 4.4 — +100 seeds (2026-07-28) ═══════════════════════════════════
  // None of these duplicate a name already in corpus-domains.json. Same mix
  // rationale as 4.3 (news/media heavy, plus entity/structured and long-form
  // docs/blog/forum shapes), extended along the axes the corpus was thinnest on:
  // non-English scripts (RTL, CJK, Cyrillic), sports/finance/science verticals,
  // Q&A + wiki + forum thread layouts, and doc-site/reference chrome.

  // ── News / media: US mainstream ───────────────────────────────────────────
  { name: 'chicagotribune', seedUrl: 'https://www.chicagotribune.com/business/', hrefRe: 'chicagotribune\\.com/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'metro news article' },
  { name: 'seattletimes', seedUrl: 'https://theticket.seattletimes.com/city-guides/', hrefRe: 'seattletimes\\.com/(city-guides|top-picks)/[a-z0-9-]{15,}/$', note: 'metro city-guide feature (the /business/technology hub renders an empty shell)' },
  { name: 'denverpost', seedUrl: 'https://www.denverpost.com/business/', hrefRe: 'denverpost\\.com/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'metro news article' },
  { name: 'nypost', seedUrl: 'https://nypost.com/tech/', hrefRe: 'nypost\\.com/\\d{4}/\\d{2}/\\d{2}/[a-z0-9/-]+/', note: 'tabloid news article (ad-heavy)' },
  { name: 'msnbc', seedUrl: 'https://www.ms.now/top-stories', hrefRe: 'ms\\.now/(news|opinion|rachel-maddow-show)/[a-z0-9-]{15,}$', minText: 0, note: 'news/opinion article (image-wrapped links: no anchor text)' },
  { name: 'huffpost', seedUrl: 'https://www.huffpost.com/news/technology', hrefRe: 'huffpost\\.com/entry/[a-z0-9-]+_[a-z0-9]+', note: 'news article' },
  { name: 'thedailybeast', seedUrl: 'https://www.thedailybeast.com/category/tech/', hrefRe: 'thedailybeast\\.com/[a-z0-9-]{15,}/?$', note: 'news article' },
  { name: 'motherjones', seedUrl: 'https://www.motherjones.com/politics/', hrefRe: 'motherjones\\.com/[a-z-]+/\\d{4}/\\d{2}/[a-z0-9-]+/', note: 'magazine article' },
  { name: 'reason', seedUrl: 'https://reason.com/latest/', hrefRe: 'reason\\.com/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'magazine article' },
  { name: 'thenation', seedUrl: 'https://www.thenation.com/subject/technology/', hrefRe: 'thenation\\.com/article/[a-z-]+/[a-z0-9-]+/', note: 'magazine article' },
  { name: 'propublica', seedUrl: 'https://www.propublica.org/topics/technology', hrefRe: 'propublica\\.org/article/[a-z0-9-]+', note: 'investigative long-form' },
  { name: 'theintercept', seedUrl: 'https://theintercept.com/technology/', hrefRe: 'theintercept\\.com/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', note: 'investigative article' },

  // ── News / media: international + non-English scripts ─────────────────────
  { name: 'cbc', seedUrl: 'https://www.cbc.ca/news/science', hrefRe: 'cbc\\.ca/news/[a-z0-9/-]+-\\d+\\.\\d{6,}', note: 'Canadian public broadcaster article' },
  { name: 'globeandmail', seedUrl: 'https://www.theglobeandmail.com/business/technology/', hrefRe: 'theglobeandmail\\.com/business/[a-z-]*article-[a-z0-9-]+/', note: 'Canadian news article' },
  { name: 'abc-au', seedUrl: 'https://www.abc.net.au/news/technology', hrefRe: 'abc\\.net\\.au/news/\\d{4}-\\d{2}-\\d{2}/[a-z0-9-]+/\\d+', note: 'Australian public broadcaster article' },
  { name: 'smh', seedUrl: 'https://www.smh.com.au/technology', hrefRe: 'smh\\.com\\.au/technology/[a-z0-9-]+-\\d{8}-[a-z0-9]+\\.html', note: 'Australian news article' },
  { name: 'nzherald', seedUrl: 'https://www.nzherald.co.nz/technology/', hrefRe: 'nzherald\\.co\\.nz/[a-z/-]+/[a-z0-9-]+/[A-Z0-9]{10,}/', note: 'NZ news article' },
  { name: 'straitstimes', seedUrl: 'https://www.straitstimes.com/tech', hrefRe: 'straitstimes\\.com/tech/[a-z0-9-]+', note: 'Singapore news article' },
  { name: 'japantimes', seedUrl: 'https://www.japantimes.co.jp/news/', hrefRe: 'japantimes\\.co\\.jp/news/\\d{4}/\\d{2}/\\d{2}/[a-z0-9/-]+/', note: 'Japan news article (English)' },
  { name: 'nhk-jp', seedUrl: 'https://www.nhk.or.jp/news/', hrefRe: 'nhk\\.or\\.jp/news/html/\\d+/[a-z0-9]+', minText: 4, note: 'Japanese-script news article (CJK)' },
  { name: 'asahi', seedUrl: 'https://www.asahi.com/tech_science/', hrefRe: 'asahi\\.com/articles/[A-Z0-9]+\\.html', minText: 4, note: 'Japanese-script news article (CJK)' },
  { name: 'chosun', seedUrl: 'https://www.chosun.com/national/', hrefRe: 'chosun\\.com/[a-z/_-]+/\\d{4}/\\d{2}/\\d{2}/[A-Z0-9]+/', minText: 4, note: 'Korean-script news article (CJK)' },
  { name: 'aljazeera-ar', seedUrl: 'https://www.aljazeera.net/news/', hrefRe: 'aljazeera\\.net/news/[a-z0-9/-]+/\\d{4}/\\d{1,2}/\\d{1,2}/', minText: 4, note: 'Arabic RTL news article (bidi layout)' },
  { name: 'haaretz', seedUrl: 'https://www.haaretz.com/israel-news', hrefRe: 'haaretz\\.com/[a-z-]+/\\d{4}-\\d{2}-\\d{2}/[a-zA-Z0-9-]+/[0-9a-f]+', note: 'Israeli news article (English edition)' },
  { name: 'meduza', seedUrl: 'https://meduza.io/en', hrefRe: 'meduza\\.io/en/(feature|news|episodes)/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+', note: 'Russian outlet, English edition' },
  { name: 'elpais', seedUrl: 'https://elpais.com/tecnologia/2026-01-08/la-inteligencia-artificial-se-cuela-en-el-ces-de-las-vegas.html', hrefRe: '', direct: true, note: 'Spanish-language news article' },
  { name: 'folha', seedUrl: 'https://www1.folha.uol.com.br/tec/', hrefRe: 'folha\\.uol\\.com\\.br/[a-z/]+/\\d{4}/\\d{2}/[a-z0-9-]+\\.shtml', minText: 8, note: 'Brazilian Portuguese news article' },
  { name: 'lefigaro', seedUrl: 'https://www.lefigaro.fr/secteur/high-tech', hrefRe: 'lefigaro\\.fr/[a-z/-]+/[a-z0-9-]+-\\d{8}', minText: 8, note: 'French news article' },
  { name: 'thehindu', seedUrl: 'https://www.thehindu.com/sci-tech/technology/', hrefRe: 'thehindu\\.com/sci-tech/[a-z/-]+/[a-z0-9-]+/article\\d+\\.ece', note: 'India news article' },
  { name: 'ndtv', seedUrl: 'https://www.ndtv.com/science/nasa-james-webb-space-telescope-captures-new-image-of-supernova-remnant-7208412', hrefRe: '', direct: true, note: 'India news article (ad-heavy)' },

  // ── Sports / finance / science verticals ──────────────────────────────────
  { name: 'bbc-sport', seedUrl: 'https://www.bbc.com/sport/football', hrefRe: 'bbc\\.com/sport/[a-z-]+/articles/[a-z0-9]+', note: 'sports article' },
  { name: 'bleacherreport', seedUrl: 'https://bleacherreport.com/nba', hrefRe: 'bleacherreport\\.com/articles/\\d+-[a-z0-9-]+', note: 'sports article (SPA-ish)' },
  { name: 'marketwatch', seedUrl: 'https://www.marketwatch.com/investing/stock/aapl', hrefRe: '', direct: true, note: 'finance quote/entity page (dense tables)' },
  { name: 'investopedia', seedUrl: 'https://www.investopedia.com/terms/c/compoundinterest.asp', hrefRe: '', direct: true, note: 'finance reference article' },
  { name: 'coindesk', seedUrl: 'https://www.coindesk.com/tech', hrefRe: 'coindesk\\.com/[a-z-]+/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+', note: 'crypto news article' },
  { name: 'yahoofinance', seedUrl: 'https://finance.yahoo.com/topic/latest-news/', hrefRe: 'finance\\.yahoo\\.com/news/[a-z0-9-]+-\\d{6}\\d*\\.html', note: 'finance news article (heavy chrome)' },
  { name: 'scientificamerican', seedUrl: 'https://www.scientificamerican.com/latest/', hrefRe: 'scientificamerican\\.com/article/[a-z0-9-]+/', note: 'science article' },
  { name: 'newscientist', seedUrl: 'https://www.newscientist.com/subject/technology/', hrefRe: 'newscientist\\.com/article/\\d+-[a-z0-9-]+/', note: 'science article (paywall-lite)' },
  { name: 'phys-org', seedUrl: 'https://techxplore.com/', hrefRe: 'techxplore\\.com/news/\\d{4}-\\d{2}-[a-z0-9-]+\\.html', minText: 20, note: 'science/tech press-release article (phys.org redirects to techxplore.com)' },
  { name: 'sciencemag', seedUrl: 'https://www.science.org/content/article/dna-reveals-surprising-origins-mysterious-etruscans', hrefRe: '', direct: true, note: 'science journalism article' },
  { name: 'plos', seedUrl: 'https://journals.plos.org/plosone/browse', hrefRe: 'journals\\.plos\\.org/plosone/article\\?id=10\\.1371', minText: 10, note: 'open-access paper (structured scientific layout)' },
  { name: 'biorxiv', seedUrl: 'https://www.biorxiv.org/collection/neuroscience', hrefRe: 'biorxiv\\.org/content/10\\.1101/[0-9.v]+$', minText: 10, note: 'preprint abstract page' },
  { name: 'pubmed', seedUrl: 'https://pubmed.ncbi.nlm.nih.gov/28985560/', hrefRe: '', direct: true, note: 'biomedical abstract entity page' },
  { name: 'mayoclinic', seedUrl: 'https://www.mayoclinic.org/diseases-conditions/migraine-headache/symptoms-causes/syc-20360201', hrefRe: '', direct: true, note: 'health reference article' },

  // ── Entity / structured (product, place, profile, catalogue) ──────────────
  { name: 'wikidata', seedUrl: 'https://www.wikidata.org/wiki/Q42', hrefRe: '', direct: true, note: 'structured-data entity page (statement tables)' },
  { name: 'wikivoyage', seedUrl: 'https://en.wikivoyage.org/wiki/Kyoto', hrefRe: '', direct: true, note: 'travel wiki article (infobox + lists)' },
  { name: 'wiktionary', seedUrl: 'https://en.wiktionary.org/wiki/example', hrefRe: '', direct: true, note: 'dictionary entry (deeply nested lists)' },
  { name: 'britannica', seedUrl: 'https://www.britannica.com/biography/Alan-Turing', hrefRe: '', direct: true, note: 'encyclopedia entity page' },
  { name: 'openlibrary', seedUrl: 'https://openlibrary.org/works/OL45804W/Fantastic_Mr_Fox', hrefRe: '', direct: true, note: 'book entity page' },
  { name: 'musicbrainz', seedUrl: 'https://musicbrainz.org/artist/b071f9fa-14b0-4217-8e97-eb41da73f598', hrefRe: '', direct: true, note: 'music artist entity page (dense tables)' },
  { name: 'lastfm', seedUrl: 'https://www.last.fm/music/Radiohead', hrefRe: '', direct: true, note: 'music artist entity page' },
  { name: 'myanimelist', seedUrl: 'https://myanimelist.net/anime/1535/Death_Note', hrefRe: '', direct: true, note: 'anime entity page (table-heavy sidebar)' },
  { name: 'boardgamegeek', seedUrl: 'https://boardgamegeek.com/boardgame/174430/gloomhaven', hrefRe: '', direct: true, note: 'board-game entity page (Angular SPA)' },
  { name: 'appstore', seedUrl: 'https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580', hrefRe: '', direct: true, note: 'app store entity page' },
  { name: 'playstore', seedUrl: 'https://play.google.com/store/apps/details?id=com.spotify.music', hrefRe: '', direct: true, note: 'app store entity page (SPA)' },
  { name: 'dockerhub', seedUrl: 'https://hub.docker.com/_/postgres', hrefRe: '', direct: true, note: 'container registry entity page (SPA)' },
  { name: 'crates-io', seedUrl: 'https://crates.io/crates/serde', hrefRe: '', direct: true, note: 'package registry entity page (Ember SPA)' },
  { name: 'huggingface', seedUrl: 'https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct', hrefRe: '', direct: true, note: 'model card entity page (markdown + metadata rail)' },
  { name: 'kaggle', seedUrl: 'https://www.kaggle.com/datasets/uciml/iris', hrefRe: '', direct: true, note: 'dataset entity page (React SPA)' },
  { name: 'zenodo', seedUrl: 'https://zenodo.org/records/3509134', hrefRe: '', direct: true, note: 'research artifact entity page' },
  { name: 'openstreetmap', seedUrl: 'https://www.openstreetmap.org/relation/65606', hrefRe: '', direct: true, note: 'geo entity page (tag tables)' },
  { name: 'weather-gov', seedUrl: 'https://forecast.weather.gov/MapClick.php?lat=45.52&lon=-122.68', hrefRe: '', direct: true, note: 'government forecast page (legacy table layout)' },
  { name: 'sec-edgar', seedUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K', hrefRe: '', direct: true, note: 'regulatory filing index (legacy tables)' },
  { name: 'courtlistener', seedUrl: 'https://www.courtlistener.com/opinion/108713/roe-v-wade/', hrefRe: '', direct: true, note: 'legal opinion long-form' },
  { name: 'congress-gov', seedUrl: 'https://www.congress.gov/bill/117th-congress/house-bill/3684', hrefRe: '', direct: true, note: 'legislative entity page (tabbed chrome)' },

  // ── Docs / reference / dev long-form ─────────────────────────────────────
  { name: 'rust-book', seedUrl: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', hrefRe: '', direct: true, note: 'doc-site chapter (mdBook chrome + code blocks)' },
  { name: 'go-docs', seedUrl: 'https://go.dev/doc/effective_go', hrefRe: '', direct: true, note: 'long doc page with code' },
  { name: 'kubernetes-docs', seedUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/', hrefRe: '', direct: true, note: 'doc-site page (nav rails both sides)' },
  { name: 'postgresql-docs', seedUrl: 'https://www.postgresql.org/docs/current/tutorial-join.html', hrefRe: '', direct: true, note: 'reference doc (pre-formatted SQL)' },
  { name: 'aws-docs', seedUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html', hrefRe: '', direct: true, note: 'doc-site page (iframe-ish chrome, heavy nav)' },
  { name: 'stripe-docs', seedUrl: 'https://docs.stripe.com/payments/quickstart', hrefRe: '', direct: true, note: 'doc-site page (interactive code panes)' },
  { name: 'w3c-spec', seedUrl: 'https://www.w3.org/TR/wai-aria-1.2/', hrefRe: '', direct: true, note: 'very long spec document' },
  { name: 'rfc-editor', seedUrl: 'https://www.rfc-editor.org/rfc/rfc9110.html', hrefRe: '', direct: true, note: 'RFC (monospace-ish long document)' },

  // ── Forums / Q&A / social threads / aggregators ──────────────────────────
  { name: 'superuser', seedUrl: 'https://superuser.com/questions?tab=Votes', hrefRe: 'superuser\\.com/questions/\\d+/[a-z0-9-]+', minText: 10, note: 'SE-network Q&A thread' },
  { name: 'mathoverflow', seedUrl: 'https://mathoverflow.net/questions?tab=Votes', hrefRe: 'mathoverflow\\.net/questions/\\d+/[a-z0-9-]+', minText: 10, note: 'Q&A thread with MathJax' },
  { name: 'discourse-meta', seedUrl: 'https://meta.discourse.org/latest', hrefRe: 'meta\\.discourse\\.org/t/[a-z0-9-]+/\\d+', minText: 10, note: 'Discourse forum thread (virtualised scroll)' },
  { name: 'xda-forums', seedUrl: 'https://xdaforums.com/t/how-to-unlock-bootloader.4515295/', hrefRe: '', direct: true, note: 'XenForo forum thread' },
  { name: 'github-issue', seedUrl: 'https://github.com/facebook/react/issues/24502', hrefRe: '', direct: true, note: 'issue thread (comment timeline)' },
  { name: 'github-pr', seedUrl: 'https://github.com/microsoft/TypeScript/pull/45711', hrefRe: '', direct: true, note: 'PR thread (diff + comments)' },
  { name: 'gitlab-repo', seedUrl: 'https://gitlab.com/gitlab-org/gitlab', hrefRe: '', direct: true, note: 'repo landing page (README below file table)' },
  { name: 'mastodon-thread', seedUrl: 'https://mastodon.social/@Gargron/109302836483513937', hrefRe: '', direct: true, note: 'fediverse post thread (div-soup SPA)' },
  { name: 'lemmy-thread', seedUrl: 'https://lemmy.world/post/49992871', hrefRe: '', direct: true, note: 'fediverse link-aggregator thread (direct post URL)' },
  { name: 'slashdot', seedUrl: 'https://slashdot.org/', hrefRe: 'slashdot\\.org/story/\\d+/[a-z0-9-]+', minText: 10, note: 'legacy aggregator story + comments' },
  { name: 'tildes', seedUrl: 'https://tildes.net/', hrefRe: 'tildes\\.net/~[a-z.]+/[a-z0-9]+/[a-z0-9_]+', minText: 10, note: 'minimal-markup aggregator thread' },
  { name: 'quora', seedUrl: 'https://www.quora.com/', hrefRe: 'quora\\.com/[A-Za-z0-9-]{20,}', minText: 5, note: 'Q&A page (login-wall prone, infinite scroll)' },

  // ── Long-form blogs / newsletters / personal sites ────────────────────────
  { name: 'simonwillison', seedUrl: 'https://simonwillison.net/', hrefRe: 'simonwillison\\.net/\\d{4}/[A-Z][a-z]{2}/\\d+/[a-z0-9-]+/', minText: 6, note: 'personal blog (dense link prose)' },
  { name: 'jvns', seedUrl: 'https://jvns.ca/', hrefRe: 'jvns\\.ca/blog/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', minText: 6, note: 'personal blog with inline images' },
  { name: 'nownownow-brave', seedUrl: 'https://brave.com/blog/', hrefRe: 'brave\\.com/blog/[a-z0-9-]+/$', minText: 6, note: 'company engineering blog' },
  { name: 'cloudflare-blog', seedUrl: 'https://blog.cloudflare.com/', hrefRe: 'blog\\.cloudflare\\.com/[a-z0-9-]+/?$', minText: 10, note: 'engineering blog (charts + code)' },
  { name: 'netflix-techblog', seedUrl: 'https://netflixtechblog.com/genpage-towards-end-to-end-generative-homepage-construction-at-netflix-77146fba8a08', hrefRe: '', direct: true, note: 'Medium-hosted engineering blog (direct post URL)' },
  { name: 'aws-blog', seedUrl: 'https://aws.amazon.com/blogs/aws/', hrefRe: 'aws\\.amazon\\.com/blogs/aws/[a-z0-9-]+/$', minText: 10, note: 'company blog' },
  { name: 'openai-blog', seedUrl: 'https://openai.com/index/introducing-gpt-4o/', hrefRe: '', direct: true, note: 'company announcement post (SPA)' },
  { name: 'anthropic-news', seedUrl: 'https://www.anthropic.com/news', hrefRe: 'anthropic\\.com/news/[a-z0-9-]+$', minText: 6, note: 'company announcement post' },
  { name: 'deepmind-blog', seedUrl: 'https://deepmind.google/discover/blog/', hrefRe: 'deepmind\\.google/(discover/blog|blog)/[a-z0-9-]+', minText: 6, note: 'research blog post' },
  { name: 'lesswrong', seedUrl: 'https://www.lesswrong.com/', hrefRe: 'lesswrong\\.com/posts/[A-Za-z0-9]+/[a-z0-9-]+', minText: 10, note: 'long-form forum post (footnotes)' },
  { name: 'noahpinion', seedUrl: 'https://www.noahpinion.blog/archive', hrefRe: 'noahpinion\\.blog/p/[a-z0-9-]+', minText: 10, note: 'Substack newsletter post' },
  { name: 'plato-stanford', seedUrl: 'https://plato.stanford.edu/entries/consciousness/', hrefRe: '', direct: true, note: 'very long academic reference entry' },
  { name: 'gutenberg', seedUrl: 'https://www.gutenberg.org/files/1342/1342-h/1342-h.htm', hrefRe: '', direct: true, note: 'full public-domain book (huge single HTML doc)' },
  { name: 'longreads', seedUrl: 'https://longreads.com/', hrefRe: 'longreads\\.com/\\d{4}/\\d{2}/\\d{2}/[a-z0-9-]+/', minText: 10, note: 'curated long-form article' },

  // ══ PHASE 4.5 — books / film / music review+catalogue entity pages ═════════
  // Requested coverage for the "rate + review a work" site class. The corpus
  // already had goodreads-book, goodreads-author, letterboxd, rottentomatoes,
  // metacritic, discogs and lastfm; these fill the gaps in that same class.
  // Music streaming catalogue pages (Spotify/Apple/YT Music) are SPA app shells
  // whose listing grids are JS-rendered and link-picker-hostile, so they're
  // `direct` canonical album/track URLs — the navigation still proves they load
  // and hydrate real text in the warm profile.
  { name: 'storygraph', seedUrl: 'https://app.thestorygraph.com/browse', hrefRe: 'app\\.thestorygraph\\.com/books/[a-z0-9-]+$', minText: 2, note: 'PHASE 4.5 — ENTITY: StoryGraph book page (rating, moods, pace, reviews)' },
  // LibraryThing work URLs carry a title slug after the id (/work/113/t/Slug),
  // NOT a bare /work/<id> — the slug segment is optional on the canonical page
  // but always present in Zeitgeist's links, so match it optionally.
  { name: 'librarything', seedUrl: 'https://www.librarything.com/zeitgeist', hrefRe: 'librarything\\.com/work/\\d+(/t/[A-Za-z0-9-]+)?$', minText: 2, note: 'PHASE 4.5 — ENTITY: LibraryThing work page (ratings, tags, reviews)' },
  { name: 'rateyourmusic', seedUrl: 'https://rateyourmusic.com/charts/top/album/all-time/', hrefRe: 'rateyourmusic\\.com/release/album/[a-z0-9._-]+/[a-z0-9._-]+/$', minText: 2, note: 'PHASE 4.5 — ENTITY: RYM album page (rating, genres, tracklist, reviews)' },
  { name: 'spotify-album', seedUrl: 'https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv', hrefRe: '', direct: true, note: 'PHASE 4.5 — ENTITY: Spotify album page (SPA app shell, tracklist)' },
  { name: 'applemusic-album', seedUrl: 'https://music.apple.com/us/album/the-dark-side-of-the-moon/1065973699', hrefRe: '', direct: true, note: 'PHASE 4.5 — ENTITY: Apple Music album page (SPA, tracklist + editorial notes)' },
  // YT Music album canonical form is /browse/MPREb_<id>, which 302s to a
  // ?list=OLAK5uy_<id> playlist URL. Use the /browse/ form — the OLAK ids rot
  // (a stale one renders the signed-in chrome with an EMPTY content pane, which
  // reads as a bot wall but is really a dead id). Refresh by searching in-app.
  { name: 'ytmusic-album', seedUrl: 'https://music.youtube.com/browse/MPREb_nHbCAGX6uUL', hrefRe: '', direct: true, note: 'PHASE 4.5 — ENTITY: YouTube Music album page (Polymer SPA, tracklist)' },
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
  const outPath = resolve(__dirname, '..', '..', '..', 'test-output', 'discovered-urls.json');
  const flush = () => writeFileSync(
    outPath, JSON.stringify({ discoveredAt: new Date().toISOString(), results }, null, 2), 'utf8');

  try {
    for (const s of seeds) {
      const out: Discovered = { name: s.name, url: '', note: s.note, candidates: [] };
      // newPage() itself can throw (browser hiccup after many tabs) — that used to
      // abort the whole run mid-way and lose every later seed. Treat it as a MISS.
      let page: Awaited<ReturnType<typeof ctx.newPage>>;
      try {
        page = await ctx.newPage();
      } catch (e) {
        out.error = `newPage failed: ${(e as Error).message.split('\n')[0]}`;
        results.push(out);
        // eslint-disable-next-line no-console
        console.log(`MISS  ${s.name.padEnd(18)} ${out.error}`);
        continue;
      }
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
        // `direct` seeds ARE the corpus URL — we navigated only to prove they
        // load in the warm profile. Treat a page with real text as the pick.
        if (s.direct) {
          // SPA entity pages (BoardGameGeek/Angular, Mastodon, congress.gov) paint
          // the shell first and hydrate the body a beat later — a single early read
          // sees ~260 chars of chrome and looks like a wall. Poll up to ~12s.
          const measure = () => page.evaluate(
            () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
          ).catch(() => 0);
          let textLen = await measure();
          for (let i = 0; i < 6 && textLen <= 400; i++) {
            await page.waitForTimeout(2_000);
            textLen = await measure();
          }
          if (textLen > 400) {
            out.url = s.seedUrl;
            out.candidates = [s.seedUrl];
          } else {
            out.error = `direct page had only ${textLen} chars of text (wall/empty?)`;
          }
        } else {
        // Client-rendered listing grids (StoryGraph/Rails-Turbo, RYM charts) can
        // still be empty of real hrefs at the fixed wait above, then populate a
        // few seconds later — that produced spurious "no link matched picker"
        // misses whose regex was actually correct (the picker probe, which waits
        // longer, reported "would match now"). Re-scrape a few times before
        // calling it a miss, mirroring the `direct` branch's poll.
        const scrape = () => page.evaluate(
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
        ).catch(() => [] as string[]);
        let picks = await scrape();
        for (let i = 0; i < 5 && picks.length === 0; i++) {
          await page.waitForTimeout(2_500);
          picks = await scrape();
        }
        out.candidates = picks;
        out.url = picks[0] ?? '';
        if (!out.url) out.error = 'no link matched picker';
        }
      } catch (e) {
        out.error = (e as Error).message.split('\n')[0];
      } finally {
        await page.close().catch(() => undefined);
      }
      results.push(out);
      // eslint-disable-next-line no-console
      console.log(out.url
        ? `${s.direct ? 'OK*  ' : 'OK   '} ${s.name.padEnd(18)} ${out.url}`
        : `MISS  ${s.name.padEnd(18)} ${out.error} (seed ${s.seedUrl})`);
      // Persist after EVERY seed — a long run that dies partway (browser hiccup,
      // timeout) then still leaves every URL discovered so far on disk.
      flush();
    }
  } finally {
    await ctx.close();
  }

  flush();
  const hit = results.filter(r => r.url).length;
  // eslint-disable-next-line no-console
  console.log(`\nDiscovered ${hit}/${results.length} article URLs → ${outPath}`);
});
