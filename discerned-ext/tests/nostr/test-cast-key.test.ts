// The purge tool (tests/e2e/tools/purge-test-casts.mjs) hard-codes the test
// signing key because it is plain .mjs and cannot import the TypeScript helper.
// If the two ever drift, the tool finds no casts by that author and reports
// "nothing to do" while the relay fills up — a silent failure. Pin them here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const KEY_EXPR = 'Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff)';

describe('test cast signing key', () => {
  it('is defined identically in the helper and the purge tool', () => {
    const helper = readFileSync('../tests/e2e/helpers/castFromCapture.ts', 'utf8');
    const tool = readFileSync('../tests/e2e/tools/purge-test-casts.mjs', 'utf8');
    expect(helper, 'helper key expression changed — update the purge tool too').toContain(KEY_EXPR);
    expect(tool, 'purge tool key expression changed — update the helper too').toContain(KEY_EXPR);
  });
});
