// Phase 2 of the capture-flaw remediation: generic chrome that the 2026-09-21
// corpus sweep showed surviving on many domains at once. As in phase 1, each
// removal is paired with the counter-example that constrains the rule.
//
// Most cases capture `full-page`: under jsdom `article` falls to Readability,
// which deletes <input>/<textarea>/<button> itself, so it would hide whether
// removeGenericChrome ever saw the form.

import { describe, it, expect } from 'vitest';
import { captureContext } from '@/content/capture';

const PROSE = 'This is the real body of the article and it is long enough to be chosen as the content block by the layout finder, with plenty of words. '.repeat(3);

async function fullPage(html: string): Promise<string> {
  document.body.innerHTML = html;
  const cap = await captureContext('full-page', { smartArticleDetection: false, stripInlineStyles: false });
  return cap.bodyHtml ?? '';
}

describe('form widgets', () => {
  it('drops a politico-shaped newsletter signup with its heading and blurb', async () => {
    const html = await fullPage(`
      <main><article>
        <h1>NASA's nuclear Mars mission to cost over $2 billion</h1>
        <p>${PROSE}</p><p>Closing paragraph. ${PROSE}</p>
        <div>
          <div><h3><a href="https://www.politico.com/newsletters/national-security-daily">National Security Daily</a></h3>
            <p>From the SitRoom to the E-Ring, the inside scoop on defense.</p></div>
          <form action="/api/newsletters">
            <label for="e">Email</label><input id="e" type="email">
            <label for="emp">Employer</label><input id="emp" type="text">
            <label for="jt">Job Title</label><input id="jt" type="text">
            <p>By signing up, you acknowledge and agree to our Privacy Policy and Terms of Service. You may unsubscribe at any time by following the directions at the bottom of the email. This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.</p>
            <button type="submit">Sign Up</button>
          </form>
        </div>
      </article></main>`);
    for (const chrome of ['Employer', 'Job Title', 'Sign Up', 'reCAPTCHA', 'National Security Daily', 'SitRoom']) {
      expect(html, `${chrome} is signup chrome`).not.toContain(chrome);
    }
    expect(html).toContain('Closing paragraph.');
    expect(html).toContain('nuclear Mars mission');
  });

  it('drops an AP-shaped mid-article signup without touching the paragraphs around it', async () => {
    const html = await fullPage(`
      <main><article>
        <p>Before the box. ${PROSE}</p>
        <div>
          <div><strong>Sign up for Morning Wire:</strong> Our flagship newsletter breaks down the biggest headlines of the day.</div>
          <form><input type="email" placeholder="Enter your email"><button>Sign up</button>
            <label><input type="checkbox"> By checking this box, you agree to AP's Terms of Use.</label></form>
        </div>
        <p>After the box. ${PROSE}</p>
      </article></main>`);
    expect(html).not.toContain('Morning Wire');
    expect(html).not.toContain('By checking this box');
    expect(html).toContain('Before the box.');
    expect(html).toContain('After the box.');
  });

  it('drops a comment composer but keeps the comments', async () => {
    const html = await fullPage(`
      <main><article>
        <p>${PROSE}</p>
        <form><label>Display Name*</label><input type="text">
          <label><input type="checkbox">Remember nickname</label>
          <label>Comment</label><textarea></textarea>
          <p>By adding a comment, I agree to this site's terms and conditions</p>
          <button>Submit</button></form>
        <div><p>A reader's real comment that must remain in the clip. ${PROSE}</p></div>
      </article></main>`);
    expect(html).not.toContain('Display Name');
    expect(html).not.toContain('Remember nickname');
    expect(html).not.toContain('Submit');
    expect(html).toContain("A reader's real comment");
  });

  it('drops a haaretz-shaped email gate whose consent line sits OUTSIDE the form', async () => {
    const html = await fullPage(`
      <main><article>
        <p>${PROSE}</p>
        <div><h4>Keep reading for free</h4><p>Register with your email to unlock this article</p>
          <form><label>Email</label><input type="email"><button>Sign up</button></form>
          <p>One smart daily email. No spam. By registering, you agree to <a href="/misc/terms-and-conditions">Haaretz's terms and conditions</a></p></div>
        <p>After the gate. ${PROSE}</p>
      </article></main>`);
    expect(html).not.toContain('Keep reading for free');
    expect(html).not.toContain('One smart daily email');
    expect(html).toContain('After the gate.');
  });

  it('drops a comment composer that has not hydrated its inputs yet, by the form\'s own name', async () => {
    const html = await fullPage(`
      <main><article>
        <p>${PROSE}</p>
        <form data-testid="comment-form"><div><label for="r1">Display Name<span>*</span></label><div></div></div>
          <button type="button" disabled>Remember nickname</button><div>Enter the commenter display name</div>
          <span>Comment</span><div>By adding a comment, I agree to this site's terms and conditions</div>
          <button>Submit</button></form>
        <div><p>A reader's real comment that must remain. ${PROSE}</p></div>
      </article></main>`);
    expect(html).not.toContain('Display Name');
    expect(html).not.toContain('Remember nickname');
    expect(html).toContain("A reader's real comment");
  });

  it('drops a named signup <form> on the Readability path, where its inputs are already gone', async () => {
    document.body.innerHTML = `
      <main><article>
        <p>${PROSE}</p><p>Second paragraph. ${PROSE}</p>
        <form class="newsletter-signup" action="/subscribe">
          <label>Your email address</label><input type="email">
          <p>One smart daily email. No spam.</p><button>Subscribe</button>
        </form>
      </article></main>`;
    const cap = await captureContext('article', { smartArticleDetection: false, stripInlineStyles: false });
    expect(cap.bodyHtml ?? '').not.toContain('One smart daily email');
    expect(cap.bodyHtml ?? '').toContain('Second paragraph.');
  });

  it('keeps the article when a page-wide <form> wraps it, dropping only the search row', async () => {
    const html = await fullPage(`
      <form id="aspnetForm" action="/Default.aspx"><main><article>
        <h1>County budget approved</h1>
        <div><label>Search the site</label><input type="text" name="q"><button>Go</button></div>
        <p>${PROSE}</p><p>Second paragraph. ${PROSE}</p>
      </article></main></form>`);
    expect(html).toContain('County budget approved');
    expect(html).toContain('Second paragraph.');
    expect(html).not.toContain('Search the site');
  });

  it('keeps a GitHub task list, whose checkboxes sit inside a comment <form>', async () => {
    const html = await fullPage(`
      <main><article>
        <form class="js-comment-update" action="/o/r/issue_comments/1"><div>
          <p>${PROSE}</p>
          <ul><li><input type="checkbox" disabled> Write the parser</li>
            <li><input type="checkbox" checked disabled> Ship it</li></ul>
        </div></form>
      </article></main>`);
    expect(html).toContain('Write the parser');
    expect(html).toContain('Ship it');
  });

  it('keeps a product price beside a quantity field', async () => {
    const html = await fullPage(`
      <main><article>
        <h1>Widget Pro</h1>
        <div><span>$59.99</span><label>Qty</label><input type="text" name="quantity" value="1"></div>
        <p>${PROSE}</p>
      </article></main>`);
    expect(html).toContain('$59.99');
  });

  it('keeps the label of a readonly copy-command box', async () => {
    const html = await fullPage(`
      <main><article>
        <p>${PROSE}</p>
        <div><span>Install with</span><input type="text" readonly value="npm i react"></div>
      </article></main>`);
    expect(html).toContain('Install with');
  });
});

describe('Google preferred-source links', () => {
  it('drops a text-bearing link but keeps the byline sharing its wrapper', async () => {
    const html = await fullPage(`
      <main><article>
        <h1>Headline</h1>
        <div>
          <span>By <a href="/staff/audrey-decker">Audrey Decker</a></span>
          <span>07/21/2026 04:00 AM PDT</span>
          <div><span>+</span><a href="https://www.google.com/preferences/source?q=politico.com">Add POLITICO on Google</a></div>
        </div>
        <p>${PROSE}</p>
      </article></main>`);
    expect(html).not.toContain('Add POLITICO on Google');
    expect(html).not.toContain('preferences/source');
    expect(html).toContain('Audrey Decker');
    expect(html).toContain('07/21/2026');
  });

  it('drops the href-less button form by its whole text, but not a sentence that says it', async () => {
    const html = await fullPage(`
      <main><article>
        <h1>Headline</h1>
        <div><button><svg viewBox="0 0 24 24"><path d="M0 0h1"></path></svg> <span>Add Al Jazeera on Google</span>
          <svg viewBox="0 0 24 24"><title>info</title><path d="M0 0h1"></path></svg></button></div>
        <p>Publishers now ask readers to add them on Google as a preferred source. ${PROSE}</p>
      </article></main>`);
    expect(html).not.toContain('Add Al Jazeera on Google');
    expect(html).toContain('add them on Google as a preferred source');
  });
});

describe('notification opt-in prompts', () => {
  it('drops an aljazeera-shaped mid-article prompt but keeps the paragraphs and a quote using the words', async () => {
    const html = await fullPage(`
      <main><article>
        <p>Before the prompt. ${PROSE}</p>
        <div><span><svg viewBox="0 0 20 20"><title>notification-important</title><path d="M0 0h1"></path></svg></span>
          <span>Get instant alerts and updates based on your interests. Be the first to know when big stories happen.</span>
          <button> Yes, keep me updated </button></div>
        <p>After the prompt. "Keep me updated on the count," the governor told aides. ${PROSE}</p>
      </article></main>`);
    expect(html).not.toContain('Get instant alerts');
    expect(html).not.toContain('Yes, keep me updated');
    expect(html).toContain('Before the prompt.');
    expect(html).toContain('Keep me updated on the count');
  });
});

describe('ad-slot labels', () => {
  it('drops the label and the empty wrapper chain of each ad slot', async () => {
    const html = await fullPage(`
      <main><article>
        <p>First. ${PROSE}</p>
        <div><div><p>Advertisement</p></div></div>
        <p>Second. ${PROSE}</p>
        <div><div>- Advertisement -</div></div>
        <div><div><div>Advertisement - Scroll to continue</div></div></div>
        <div><span>Publicité</span></div>
        <p>Third. ${PROSE}</p>
      </article></main>`);
    expect(html).not.toMatch(/advertisement/i);
    expect(html).not.toContain('Publicité');
    expect(html).toContain('Third.');
  });

  it('keeps the word used in a sentence, inside a table, and "Advertising"', async () => {
    const html = await fullPage(`
      <main><article>
        <p>The word <i>advertisement</i> entered English in the fifteenth century. ${PROSE}</p>
        <table><tr><td>Category</td><td>Advertisement</td></tr></table>
        <ul><li>Advertising</li><li>Analytics</li></ul>
      </article></main>`);
    expect(html).toContain('<i>advertisement</i>');
    expect(html).toMatch(/<td>Advertisement<\/td>/);
    expect(html).toContain('Advertising');
  });
});

describe('recirculation headings', () => {
  it('drops the newly-recognised recirculation modules', async () => {
    const html = await fullPage(`
      <main><article>
        <p>First. ${PROSE}</p>
        <div><h2>Recommended Stories</h2><ul>
          <li><a href="/a">Story A headline</a></li><li><a href="/b">Story B headline</a></li></ul></div>
        <p>Second. ${PROSE}</p>
        <div><h3>You May Also Like</h3><a href="/x">Teaser X</a> <a href="/y">Teaser Y</a></div>
        <div><h3>Mother Jones Top Stories</h3><a href="/m1">Teaser M1</a> <a href="/m2">Teaser M2</a></div>
        <div><h4>More context</h4><a href="/c1">Context one</a> <a href="/c2">Context two</a></div>
        <div><h4>From our partners</h4><a href="/p1">Partner one</a> <a href="/p2">Partner two</a></div>
      </article></main>`);
    for (const teaser of ['Story A headline', 'Teaser X', 'Teaser M1', 'Context one', 'Partner one']) {
      expect(html, `${teaser} is recirculation`).not.toContain(teaser);
    }
    expect(html).toContain('Second.');
  });

  it('keeps a Keywords section and prose that mentions recommended stories', async () => {
    const html = await fullPage(`
      <main><article>
        <p>Editors pick the recommended stories each week from reader votes. ${PROSE}</p>
        <div><h3>Keywords</h3><a href="/mesh/a">Bone density</a>, <a href="/mesh/b">Osteoporosis</a></div>
      </article></main>`);
    expect(html).toContain('recommended stories each week');
    expect(html).toContain('Osteoporosis');
  });
});
