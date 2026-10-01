// Guards <pre> whitespace against collapseEmpty.
//
// The corpus sweep captured kubernetes.io's Pod manifest as
// "apiVersion:v1kind:Podmetadata:name:nginxspec:containers:-" — every space and
// newline gone — while the PLAIN shell block on the same page was perfect.
//
// Cause (measured live with tools/pre-ws-probe.spec.ts): the whitespace IS in
// the DOM, but a syntax highlighter wraps each run of it in its own element.
// Chroma (kubernetes.io, and every Hugo-built docs site) emits
// `<span class="w"> </span>` and `<span class="w">\n</span>` between tokens.
// collapseEmpty's hasVisibleContent TRIMMED before testing, so it judged those
// spans empty and deleted them. The plain block survived only because its
// newlines sat in one un-wrapped text node, which is exactly the pairing that
// proved the cause was element wrapping rather than "code".
//
// Note the sibling defect this is NOT: separateInlineFacets used to paper over
// this by padding every token boundary in the CAST ("apiVersion : v1"). Fixing
// that alone made the cast match the clip's already-broken reality, which is
// why both halves are needed. See cast-markdown.test.ts (Phase 2).

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';

const PROSE_A = 'This paragraph is long enough to keep the article from collapsing to a bookmark capture entirely.';
const PROSE_B = 'Another paragraph of prose that is comfortably long enough to survive the capture pipeline here.';

/** Chroma's markup: a line wrapper, a token, and a whitespace-only token span. */
const line = (inner: string) => `<span class="line"><span class="cl">${inner}</span></span>`;
const tok = (cls: string, t: string) => `<span class="${cls}">${t}</span>`;
const ws = (s: string) => `<span class="w">${s}</span>`;

async function capture(blockHtml: string): Promise<string> {
  document.body.innerHTML =
    `<main><article><h1>Pods</h1><p>${PROSE_A}</p>${blockHtml}<p>${PROSE_B}</p></article></main>`;
  const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
  return cap.bodyHtml ?? '';
}

describe('highlighted <pre> whitespace', () => {
  it('keeps whitespace-only token spans inside <pre>', async () => {
    const html = await capture(
      '<pre class="chroma"><code>' +
      line(`${tok('nt', 'apiVersion')}${tok('p', ':')}${ws(' ')}${tok('l', 'v1')}${ws('\n')}`) +
      line(`${tok('nt', 'kind')}${tok('p', ':')}${ws(' ')}${tok('l', 'Pod')}${ws('\n')}`) +
      '</code></pre>',
    );
    // The defect: tokens glued with no separator at all.
    expect(html).not.toContain('apiVersion</span><span>:</span><span>v1');
    expect(html).toContain('<span> </span>');
    expect(html).toContain('<span>\n</span>');
  });

  it('renders as valid text with its spaces and newlines', async () => {
    document.body.innerHTML =
      `<main><article><h1>Pods</h1><p>${PROSE_A}</p>` +
      '<pre class="chroma"><code>' +
      line(`${tok('nt', 'apiVersion')}${tok('p', ':')}${ws(' ')}${tok('l', 'v1')}${ws('\n')}`) +
      line(`${tok('nt', 'kind')}${tok('p', ':')}${ws(' ')}${tok('l', 'Pod')}${ws('\n')}`) +
      `</code></pre><p>${PROSE_B}</p></article></main>`;
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(cap.bodyText ?? '').toContain('apiVersion: v1');
  });

  // Outside <pre> a whitespace-only wrapper is genuinely empty chrome (an <i>
  // left behind after its font-awesome class was stripped) and must still go,
  // or collapseEmpty stops doing the job it exists for.
  it('still collapses a whitespace-only element outside <pre>', async () => {
    const html = await capture(`<p>${PROSE_A}</p><div><i> </i><i>\n</i></div>`);
    expect(html).not.toContain('<i>');
  });


  // Pygments (PyPI, Sphinx) uses the same `<span class="w">` whitespace token
  // as Chroma, which is why ONE fix covered both halves the plan described as
  // separate bugs: the padded half ("r . json ( )") in the cast AND the
  // stripped half (">>> importrequests") in the clip.
  it('keeps the space inside "import requests" (Pygments shape)', async () => {
    document.body.innerHTML =
      `<main><article><h1>Requests</h1><p>${PROSE_A}</p>` +
      '<pre>' +
      `${tok('gp', '&gt;&gt;&gt;')} ${tok('kn', 'import')}${ws(' ')}${tok('nn', 'requests')}
` +
      '</pre>' +
      `<p>${PROSE_B}</p></article></main>`;
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(cap.bodyText ?? '').toContain('import requests');
    expect(cap.bodyText ?? '').not.toContain('importrequests');
  });

  // The counter-example that proved the cause: a PLAIN block holds its
  // newlines inside one un-wrapped text node and was always correct.
  it('leaves a plain (unhighlighted) block untouched', async () => {
    const html = await capture(
      '<pre><code>kubectl apply -f pod.yaml\nkubectl get pods --namespace default\n</code></pre>',
    );
    expect(html).toContain('kubectl apply -f pod.yaml\nkubectl get pods --namespace default');
  });
});
