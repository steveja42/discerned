// CSV/JSON export of the clip library. The CSV writer must survive titles and
// notes containing commas, quotes, and newlines — a broken escape silently
// corrupts every row after it in Excel/Sheets.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportClipsCsv, exportClipsJson } from '@/lib/export-utils';
import type { ClipData } from '@/lib/types';

function makeClip(over: Partial<ClipData['capture']> = {}, evalOver: Partial<ClipData['evaluation']> = {}): ClipData {
  return {
    capture: {
      id: 'c1',
      format: 'article',
      url: 'https://example.com/a',
      title: 'Plain Title',
      timestamp: Date.parse('2026-01-02T03:04:05Z'),
      ...over,
    },
    evaluation: { signal: 'Worthwhile', qualifiers: ['Timeless', 'Quick Read'], category: 'Tech', ...evalOver },
    encrypted: '',
  };
}

// Capture the Blob handed to URL.createObjectURL instead of downloading.
let lastBlob: Blob | null;

beforeEach(() => {
  lastBlob = null;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((b: Blob) => { lastBlob = b; return 'blob:mock'; }),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function lastText(): Promise<string> {
  expect(lastBlob).not.toBeNull();
  // jsdom's Blob has no .text(); FileReader is the portable path.
  return await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsText(lastBlob!);
  });
}

describe('exportClipsCsv', () => {
  it('writes a header plus one row per clip with joined qualifiers and ISO date', async () => {
    exportClipsCsv([makeClip()]);
    const csv = await lastText();
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('title,url,category,signal,qualifiers,note,date');
    expect(row).toBe('Plain Title,https://example.com/a,Tech,Worthwhile,Timeless; Quick Read,,2026-01-02T03:04:05.000Z');
  });

  it('quotes and escapes fields containing commas, quotes, and newlines', async () => {
    exportClipsCsv([makeClip({
      title: 'Comma, in title',
      note: 'He said "hi"\nand left',
    })]);
    const csv = await lastText();
    expect(csv).toContain('"Comma, in title"');
    expect(csv).toContain('"He said ""hi""\nand left"');
    // Still exactly one header + one (logical) record.
    expect(csv.split('\r\n')[0]).toBe('title,url,category,signal,qualifiers,note,date');
  });

  it('leaves unrated clips with an empty signal field', async () => {
    exportClipsCsv([makeClip({}, { signal: undefined, qualifiers: [] })]);
    const csv = await lastText();
    expect(csv.split('\r\n')[1]).toContain(',Tech,,,');
  });
});

describe('exportClipsJson', () => {
  it('wraps the clips in a versioned payload', async () => {
    const clip = makeClip();
    exportClipsJson([clip]);
    const payload = JSON.parse(await lastText());
    expect(payload.version).toBe(1);
    expect(typeof payload.exportedAt).toBe('string');
    expect(payload.clips).toHaveLength(1);
    expect(payload.clips[0].capture.title).toBe('Plain Title');
  });
});
