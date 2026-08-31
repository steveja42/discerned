import { test } from '@playwright/test';
test('pos', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/facebook-share.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(1500);
  const out = await page.evaluate(()=>{
    const SEL='[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"]';
    const L:string[]=[];
    const lbl=Array.from(document.querySelectorAll<HTMLElement>('span,div'))
      .find(el=>/^\s*Shared post from\s+\S/i.test(el.textContent||'') && (el.textContent||'').trim().length<120)!;
    L.push(`label: <${lbl.tagName.toLowerCase()}> "${(lbl.textContent||'').trim()}"`);
    const msgs=Array.from(document.querySelectorAll(SEL));
    msgs.forEach((m,m_i)=>{
      const rel=lbl.compareDocumentPosition(m);
      const names=[];
      if(rel&Node.DOCUMENT_POSITION_PRECEDING)names.push('PRECEDING(before label)');
      if(rel&Node.DOCUMENT_POSITION_FOLLOWING)names.push('FOLLOWING(after label)');
      if(rel&Node.DOCUMENT_POSITION_CONTAINS)names.push('CONTAINS');
      if(rel&Node.DOCUMENT_POSITION_CONTAINED_BY)names.push('CONTAINED_BY');
      L.push(`msg#${m_i} rel=${rel} [${names.join(',')}] role=${m.getAttribute('data-ad-rendering-role')||m.getAttribute('data-ad-comet-preview')} text="${(m.textContent||'').replace(/\s+/g,' ').trim().slice(0,45)}"`);
    });
    return L.join('\n');
  });
  console.log(out);
});
