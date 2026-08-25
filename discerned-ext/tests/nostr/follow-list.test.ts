import { describe, it, expect } from 'vitest';
import { buildFollowListEvent } from '@/shared/nostr/events';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('buildFollowListEvent', () => {
  it('adds a p tag when the pubkey is absent', () => {
    const tags = [['p', A]];
    const event = buildFollowListEvent(tags, '', { add: B });
    expect(event.tags).toEqual([['p', A], ['p', B]]);
  });

  it('is a no-op when the pubkey is already followed (add)', () => {
    const tags = [['p', A], ['p', B]];
    const event = buildFollowListEvent(tags, '', { add: B });
    expect(event.tags).toEqual(tags);
  });

  it('removes the p tag when the pubkey is present', () => {
    const tags = [['p', A], ['p', B], ['p', C]];
    const event = buildFollowListEvent(tags, '', { remove: B });
    expect(event.tags).toEqual([['p', A], ['p', C]]);
  });

  it('is a no-op when the pubkey to remove is absent', () => {
    const tags = [['p', A], ['p', C]];
    const event = buildFollowListEvent(tags, '', { remove: B });
    expect(event.tags).toEqual(tags);
  });

  it('preserves unrelated tags and their order', () => {
    const tags = [['p', A, 'wss://relay.example', 'alice'], ['t', 'nostr'], ['p', B]];
    const added = buildFollowListEvent(tags, '', { add: C });
    expect(added.tags).toEqual([...tags, ['p', C]]);

    const removed = buildFollowListEvent(tags, '', { remove: B });
    expect(removed.tags).toEqual([['p', A, 'wss://relay.example', 'alice'], ['t', 'nostr']]);
  });

  it('passes content through unchanged (legacy relay-list blob)', () => {
    const content = '{"wss://relay.example":{"read":true,"write":true}}';
    const event = buildFollowListEvent([['p', A]], content, { add: B });
    expect(event.content).toBe(content);
  });

  it('always builds kind 3 with an integer created_at', () => {
    const event = buildFollowListEvent([], '', { add: A });
    expect(event.kind).toBe(3);
    expect(Number.isInteger(event.created_at)).toBe(true);
    expect(event.created_at).toBeGreaterThan(0);
  });

  it('starts from an empty list on first-ever follow', () => {
    const event = buildFollowListEvent([], '', { add: A });
    expect(event.tags).toEqual([['p', A]]);
  });
});
