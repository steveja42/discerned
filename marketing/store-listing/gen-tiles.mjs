// Renders the Web Store promo tiles from HTML. Run: node marketing/store-listing/gen-tiles.mjs
// The beacon is read from wirthy-ext/art/icon.svg so the tiles track the icon master.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const iconSvg = readFileSync(resolve(here, '../../wirthy-ext/art/icon.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/width="128" height="128" /, '');
const beacon = (color = '#60a5fa', cls = 'mark') =>
  iconSvg.replaceAll('#60a5fa', color).replace('<svg ', `<svg class="${cls}" `);

const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700;800&display=block" rel="stylesheet">`;
const BASE = `*{margin:0;padding:0;box-sizing:border-box} body{background:#0a0a0b;color:#fff;overflow:hidden;-webkit-font-smoothing:antialiased}
.mono{font-family:'JetBrains Mono',monospace} .sans{font-family:'Geist',sans-serif}`;

const tile = `<!doctype html><html><head>${FONTS}<style>${BASE}
body{width:440px;height:280px;position:relative}
.mark{position:absolute;left:30px;top:22px;height:88px;width:auto}
.word{position:absolute;left:130px;top:62px;font:700 16px 'JetBrains Mono';letter-spacing:.32em;color:#ececec}
h1{position:absolute;left:30px;top:128px;font:700 33px/1.04 'Geist';letter-spacing:-.025em}
.rule{position:absolute;left:30px;top:212px;width:44px;height:2px;background:#60a5fa}
p{position:absolute;left:30px;top:231px;font:400 15px 'Geist';color:#cfcfd4}
</style></head><body>${beacon()}<div class="word">WIRTHY</div>
<h1>Clip, rate, own<br>what you read.</h1><div class="rule"></div><p>Publish if you like.</p></body></html>`;

const azureMarquee = `<!doctype html><html><head>${FONTS}<style>${BASE}
body{width:1400px;height:560px;position:relative;background:radial-gradient(ellipse 520px 420px at 1080px 280px,#14161c 0%,#0a0a0b 70%)}
.left .mark{position:absolute;left:204px;top:80px;height:62px;width:auto}
.word{position:absolute;left:276px;top:96px;font:700 26px 'JetBrains Mono';letter-spacing:.34em;color:#f2f2f2}
.tag{position:absolute;left:201px;top:170px;font:500 16px 'JetBrains Mono';letter-spacing:.3em;color:#60a5fa}
h1{position:absolute;left:198px;top:208px;font:700 68px/1 'Geist';letter-spacing:-.035em}
.sub{position:absolute;left:201px;top:358px;font:400 22px/1.5 'Geist';color:#d4d4d8}
.bar{position:absolute;height:12px;background:#1a1b20;border-radius:1px}
.panel{position:absolute;left:790px;top:80px;width:404px;height:398px;background:#0c0c0e;border:1px solid #2c2d33;font-family:'JetBrains Mono'}
.ph{display:flex;align-items:center;height:48px;padding:0 16px;border-bottom:1px solid #2c2d33}
.ph .mark{height:20px;width:auto;margin-right:12px}
.ph b{font:700 13px 'JetBrains Mono';letter-spacing:.2em;color:#f2f2f2}
.ph i{width:8px;height:8px;background:#3f3f46;margin-left:6px}
.tabs{display:flex;gap:8px;padding:13px 16px 0}
.tabs span{font:500 11px 'JetBrains Mono';letter-spacing:.12em;padding:8px 12px;background:#1e1f24;color:#c4c4c8}
.tabs span.on{background:#f4f4f5;color:#0a0a0b}
.src{display:flex;gap:12px;padding:13px 16px 0}
.av{width:32px;height:32px;background:#1e1f24;border:1px solid #2c2d33;display:grid;place-items:center;font:700 12px 'JetBrains Mono'}
.meta{font:400 10px 'JetBrains Mono';letter-spacing:.06em;color:#71717a}
.ttl{font:600 15px/1.45 'Geist';color:#f4f4f5;margin:4px 0 5px}
.lbl{padding:18px 16px 0;font:500 10px 'JetBrains Mono';letter-spacing:.14em;color:#a1a1aa}
.score{padding:8px 16px 0;font:500 20px 'JetBrains Mono';color:#60a5fa}
.track{margin:16px 16px 0;height:3px;background:#60a5fa;position:relative}
.track::after{content:'';position:absolute;right:-8px;top:-8px;width:19px;height:19px;border-radius:50%;background:#fff}
.ticks{display:flex;justify-content:space-between;margin:13px 16px 0;padding-top:12px;border-top:1px solid #1e1f24;font:400 10px 'JetBrains Mono';color:#52525b}
.ticks b{color:#60a5fa;font-weight:700}
.foot{position:absolute;left:0;right:0;bottom:0;height:74px;border-top:1px solid #2c2d33;padding:13px 16px}
.cta{height:44px;border:1px solid #60a5fa;display:grid;place-items:center;font:700 12px 'JetBrains Mono';letter-spacing:.18em;color:#60a5fa}
</style></head><body>
<div class="bar" style="left:790px;top:56px;width:322px;height:20px;background:#1e1f24"></div>
${[[93, 140], [118, 90], [145, 125], [197, 140], [222, 60], [249, 120], [301, 100], [326, 140], [353, 30]]
  .map(([t, w]) => `<div class="bar" style="left:1194px;top:${t}px;width:${w}px"></div>`).join('')}
<div class="left">${beacon()}</div><div class="word">WIRTHY</div>
<div class="tag">A WEB CLIPPER WITH SIGNAL RATING</div>
<h1>Clip, rate, own<br>what you read.</h1>
<div class="sub">Publish it if you’d like — open,<br>portable, and yours to keep.</div>
<div class="panel">
  <div class="ph">${beacon()}<b>WIRTHY</b><span style="flex:1"></span><i></i><i></i></div>
  <div class="tabs"><span>CAST</span><span>BOTH</span><span class="on">CLIP</span></div>
  <div class="src"><div class="av">R</div><div><div class="meta">REDDIT.COM · R/TRUELIT</div>
    <div class="ttl">What’s one essay you keep coming back to<br>years later?</div>
    <div class="meta">u/holland_m · 412 COMMENTS</div></div></div>
  <div class="lbl">SIGNAL RATING</div>
  <div class="score">5 ★ Masterpiece</div>
  <div class="track"></div>
  <div class="ticks"><span>Noise</span><span>Thin</span><span>Passable</span><span>Worthwhile</span><b>Masterpiece</b></div>
  <div class="foot"><div class="cta">CLIP + PUBLISH</div></div>
</div></body></html>`;

const AMBER = '#f59e0b';
const amberMarquee = `<!doctype html><html><head>${FONTS}<style>${BASE}
body{width:1400px;height:560px;position:relative;background:
  radial-gradient(ellipse 700px 500px at 0 560px,#120f1c 0%,transparent 70%),
  radial-gradient(ellipse 420px 300px at 1000px 0,#1c1308 0%,transparent 70%),#0a0a0c}
.brand .mark{position:absolute;left:137px;top:134px;height:34px;width:auto}
.word{position:absolute;left:184px;top:137px;font:700 24px 'JetBrains Mono';color:#f4f4f5}
.tag{position:absolute;left:130px;top:208px;font:700 12px 'JetBrains Mono';letter-spacing:.12em;color:${AMBER}}
h1{position:absolute;left:128px;top:246px;font:900 46px/1.13 'Segoe UI Black','Segoe UI',sans-serif;letter-spacing:-.005em}
h1 em{font-style:normal;color:#fbbf24}
.sub{position:absolute;left:130px;top:372px;font:600 18px/1.6 'Segoe UI',sans-serif;color:#a1a1aa}
.ghost{position:absolute;background:#16161a;border-radius:6px;opacity:.9}
.card{position:absolute;left:930px;top:96px;width:340px;height:282px;border-radius:16px;background:#141416;border:1px solid #3a3a40;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.cl{position:absolute;left:28px;top:30px;font:700 13px 'JetBrains Mono';letter-spacing:.08em;color:#a1a1aa}
.line{position:absolute;left:36px;top:108px;width:262px;height:2px;background:#3f3f46}
.dot{position:absolute;top:100px;width:18px;height:18px;border-radius:50%;background:#52525b}
.dot.on{top:93px;width:30px;height:30px;background:${AMBER};box-shadow:0 0 0 6px rgba(245,158,11,.22)}
.mp{position:absolute;left:0;right:0;top:130px;text-align:center;padding-left:2px;font:700 19px 'JetBrains Mono';color:${AMBER}}
.chips{position:absolute;left:28px;top:172px;width:280px;display:flex;flex-wrap:wrap;gap:10px}
.chips span{font:700 13px 'JetBrains Mono';padding:9px 15px;border-radius:999px;background:${AMBER};color:#18181b}
.chips span.off{background:#27272a;color:#d4d4d8;border:1px solid #3f3f46;padding:8px 14px}
.toast{position:absolute;left:1088px;top:420px;width:162px;height:52px;border-radius:26px;background:#f4f4f5;display:flex;align-items:center;gap:12px;padding-left:16px;font:700 19px 'JetBrains Mono';color:#18181b}
.toast i{width:24px;height:24px;border-radius:50%;background:#22c55e;display:grid;place-items:center}
</style></head><body>
<div class="ghost" style="left:840px;top:70px;width:600px;height:138px"></div>
${[[236, 600], [262, 600], [290, 600], [302, 460], [336, 600]]
  .map(([t, w]) => `<div class="ghost" style="left:840px;top:${t}px;width:${w}px;height:13px;border-radius:3px"></div>`).join('')}
<div class="brand">${beacon(AMBER)}</div><div class="word">Wirthy</div>
<div class="tag">A WEB CLIPPER WITH SIGNAL RATING</div>
<h1>Clip, rate, own<br>what you <em>read</em>.</h1>
<div class="sub">Publish it if you'd like — open, portable, and yours to<br>keep.</div>
<div class="card"><div class="cl">SIGNAL RATING</div><div class="line"></div>
  ${[28, 93, 158, 222].map((l) => `<div class="dot" style="left:${l}px"></div>`).join('')}<div class="dot on" style="left:283px"></div>
  <div class="mp">Masterpiece</div>
  <div class="chips"><span>Insightful</span><span class="off">Well-argued</span><span>Timeless</span></div></div>
<div class="toast"><i><svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7.2l2.6 2.6L11 4.4" stroke="#0a0a0b" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></i>Clipped!</div>
</body></html>`;

const jobs = [
  ['promo-tile-440x280-azure.png', tile, 440, 280],
  ['wirthy-marquee-1400x560-azure-option1.png', azureMarquee, 1400, 560],
  ['marquee-1400x560.png', amberMarquee, 1400, 560],
];

const browser = await chromium.launch();
for (const [name, html, width, height] of jobs) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(here, name), clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log('wrote', name);
}
await browser.close();
