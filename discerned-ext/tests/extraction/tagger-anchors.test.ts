// Guards the selector-anchor manifest (Phase 3.2) that the tagger canary
// (Phase 3.1) and graceful-degradation self-check (Phase 3.4) both consume.
// A real site fixture must satisfy its tagger's anchors; an unknown host must
// resolve no tagger; a page that lost every anchor must report allDead so the
// runtime falls back to the generic pipeline.

import { describe, it, expect } from 'vitest';
import { checkTaggerAnchors } from '@/content/capture';
import { loadFixture } from '../helpers/loadFixture';

describe('checkTaggerAnchors — selector-anchor manifest', () => {
  it('returns null for a host with no registered tagger', () => {
    loadFixture('reddit-thread.html', 'https://example.com/whatever');
    expect(checkTaggerAnchors('example.com', document)).toBeNull();
  });

  it('reports every reddit anchor live against the real reddit fixture', () => {
    loadFixture('reddit-thread.html', 'https://www.reddit.com/r/x/comments/1/y/');
    const report = checkTaggerAnchors('www.reddit.com', document);
    expect(report).not.toBeNull();
    expect(report!.name).toBe('reddit');
    expect(report!.dead).toEqual([]);
    expect(report!.allDead).toBe(false);
    // Every anchor matched at least one element.
    for (const a of report!.anchors) expect(a.count).toBeGreaterThan(0);
  });

  it('reports every stackoverflow anchor live against the SO fixture', () => {
    loadFixture('stackoverflow-question.html', 'https://stackoverflow.com/questions/1/q');
    const report = checkTaggerAnchors('stackoverflow.com', document);
    expect(report!.name).toBe('stackoverflow');
    expect(report!.dead).toEqual([]);
  });

  it('flags a fully-redesigned page as allDead (triggers generic fallback)', () => {
    // A reddit URL whose DOM no longer contains ANY of the tagger's anchors —
    // exactly the shape of a silent redesign. allDead must be true so
    // applySiteTagger() skips the tagger and falls back to generic capture.
    loadFixture('blog-post.html', 'https://www.reddit.com/r/x/comments/1/y/');
    const report = checkTaggerAnchors('www.reddit.com', document);
    expect(report).not.toBeNull();
    expect(report!.allDead).toBe(true);
    expect(report!.dead.length).toBe(report!.anchors.length);
  });
});
