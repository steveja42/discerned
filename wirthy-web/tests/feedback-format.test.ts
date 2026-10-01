import { describe, it, expect } from 'vitest';
import {
  validatePayload, neutralizeMarkdown, deriveIssueTitle, deriveIssueLabels,
  buildIssueBody, looksLikeSpam, MESSAGE_MAX,
} from '@/lib/feedback-format';

const ZWSP = '​';
const valid = { type: 'bug', target: 'web', message: 'Something is broken here.', website: '' };

describe('validatePayload', () => {
  it('accepts a well-formed payload and trims the message', () => {
    const r = validatePayload({ ...valid, message: '  padded message here  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.message).toBe('padded message here');
  });

  it('rejects a non-object body', () => {
    expect(validatePayload(null).ok).toBe(false);
    expect(validatePayload('nope').ok).toBe(false);
  });

  // The honeypot must fail SILENTLY so a bot can't learn which field is the trap.
  it('flags a filled honeypot as silent', () => {
    const r = validatePayload({ ...valid, website: 'http://spam.example' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.silent).toBe(true);
  });

  it('does not flag an empty or whitespace-only honeypot', () => {
    expect(validatePayload({ ...valid, website: '   ' }).ok).toBe(true);
    expect(validatePayload({ type: 'bug', target: 'web', message: valid.message }).ok).toBe(true);
  });

  it('rejects unknown type/target rather than coercing them', () => {
    expect(validatePayload({ ...valid, type: 'urgent' }).ok).toBe(false);
    expect(validatePayload({ ...valid, target: 'mobile' }).ok).toBe(false);
    expect(validatePayload({ ...valid, type: 42 }).ok).toBe(false);
  });

  it('enforces message length bounds', () => {
    expect(validatePayload({ ...valid, message: 'too short' }).ok).toBe(false);
    expect(validatePayload({ ...valid, message: 'x'.repeat(MESSAGE_MAX + 1) }).ok).toBe(false);
  });

  it('rejects an over-long contact', () => {
    expect(validatePayload({ ...valid, contact: 'a'.repeat(201) }).ok).toBe(false);
  });

  // Diagnostics are dropped, never fatal — the user didn't type them.
  it('drops a malformed extVersion instead of failing', () => {
    const r = validatePayload({ ...valid, extVersion: 'not a version!!' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.extVersion).toBe('');
  });

  it('keeps a well-formed extVersion and truncates a long ua', () => {
    const r = validatePayload({ ...valid, extVersion: '0.2.0', ua: 'u'.repeat(500) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.extVersion).toBe('0.2.0');
      expect(r.value.ua).toHaveLength(300);
    }
  });
});

describe('looksLikeSpam', () => {
  it('flags link farms and unbroken blobs', () => {
    expect(looksLikeSpam('http://a.com http://b.com https://c.com http://d.com')).toBe(true);
    expect(looksLikeSpam('x'.repeat(250))).toBe(true);
  });

  it('leaves ordinary prose alone, including a couple of links', () => {
    expect(looksLikeSpam('See https://a.com and https://b.com for context.')).toBe(false);
    expect(looksLikeSpam('The capture drops footnotes on Substack posts.')).toBe(false);
  });
});

describe('neutralizeMarkdown', () => {
  it('defuses a bare @mention', () => {
    expect(neutralizeMarkdown('cc @steveja42')).toBe(`cc @${ZWSP}steveja42`);
  });

  // The regression that matters: the mention guard must not mangle email addresses.
  it('leaves an email address intact', () => {
    expect(neutralizeMarkdown('reach me at alice@example.com')).toBe('reach me at alice@example.com');
    expect(neutralizeMarkdown('a@b.com')).toBe('a@b.com');
  });

  it('defuses issue references so a submission cannot close issues', () => {
    expect(neutralizeMarkdown('fixes #7')).toBe(`fixes #${ZWSP}7`);
    expect(neutralizeMarkdown('#123 is related')).toBe(`#${ZWSP}123 is related`);
  });

  it('leaves ordinary prose, headings, and hex colours alone', () => {
    expect(neutralizeMarkdown('plain text, no triggers')).toBe('plain text, no triggers');
    expect(neutralizeMarkdown('# Heading')).toBe('# Heading');
    expect(neutralizeMarkdown('the colour &#39; entity')).toBe('the colour &#39; entity');
  });
});

describe('deriveIssueTitle', () => {
  it('prefixes the type and uses the first non-empty line', () => {
    expect(deriveIssueTitle('bug', 'Clipping drops footnotes\nmore detail below'))
      .toBe('[bug] Clipping drops footnotes');
  });

  it('skips leading blank lines', () => {
    expect(deriveIssueTitle('idea', '\n\n  Add dark mode  \nrest')).toBe('[idea] Add dark mode');
  });

  it('collapses internal whitespace', () => {
    expect(deriveIssueTitle('other', 'lots   of\tspace')).toBe('[other] lots of space');
  });

  it('truncates long titles on a word boundary', () => {
    const title = deriveIssueTitle('bug', 'word '.repeat(40));
    expect(title.length).toBeLessThanOrEqual(78); // "[bug] " + 70 + ellipsis
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });

  it('falls back to a generic title when there is no usable first line', () => {
    expect(deriveIssueTitle('other', '   ')).toBe('[other] Feedback');
  });
});

describe('deriveIssueLabels', () => {
  it('builds the triage label set', () => {
    expect(deriveIssueLabels('bug', 'extension')).toEqual(['feedback', 'bug', 'area:extension']);
  });

  // 'idea' maps to GitHub's DEFAULT 'enhancement' label so it needn't be created by hand.
  // Getting this wrong means a 422 that rejects the entire submission.
  it('maps idea → enhancement (a GitHub default label)', () => {
    expect(deriveIssueLabels('idea', 'web')).toEqual(['feedback', 'enhancement', 'area:web']);
    expect(deriveIssueLabels('idea', 'web')).not.toContain('idea');
  });

  it('passes other through unchanged', () => {
    expect(deriveIssueLabels('other', 'both')).toEqual(['feedback', 'other', 'area:both']);
  });
});

describe('buildIssueBody', () => {
  const base = { type: 'bug' as const, target: 'extension' as const, message: 'It broke.', receivedAt: new Date('2026-07-29T12:00:00Z') };

  it('includes the message, a separator, and the diagnostics table', () => {
    const body = buildIssueBody(base);
    expect(body).toContain('It broke.');
    expect(body).toContain('---');
    expect(body).toContain('| Type | bug |');
    expect(body).toContain('| Area | Extension |');
    expect(body).toContain('2026-07-29T12:00:00.000Z');
  });

  it('omits absent optional rows rather than printing n/a', () => {
    const body = buildIssueBody(base);
    expect(body).not.toContain('Contact');
    expect(body).not.toContain('Extension version');
    expect(body).not.toContain('User agent');
    expect(body).not.toContain('n/a');
  });

  it('includes optional rows when present', () => {
    const body = buildIssueBody({ ...base, contact: 'a@b.com', extVersion: '0.2.0', ua: 'Mozilla/5.0' });
    expect(body).toContain('| Contact | a@b.com |');
    expect(body).toContain('| Extension version | `0.2.0` |');
    expect(body).toContain('| User agent | `Mozilla/5.0` |');
  });

  it('neuters the message body', () => {
    const body = buildIssueBody({ ...base, message: 'ping @someone, fixes #9' });
    expect(body).toContain(`@${ZWSP}someone`);
    expect(body).toContain(`#${ZWSP}9`);
  });

  // A backtick in the UA would break out of the code span and could inject markdown.
  it('strips backticks from the user agent', () => {
    const body = buildIssueBody({ ...base, ua: 'Mozilla/5.0 `injected`' });
    expect(body).toContain('| User agent | `Mozilla/5.0 injected` |');
  });
});
