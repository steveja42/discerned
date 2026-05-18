// Vitest setup for the discerned-web jsdom suite.
// Brings in @testing-library/jest-dom matchers for component assertions.

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
