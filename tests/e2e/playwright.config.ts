import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const FIXTURE_PORT = 4173;
const WEB_PORT = 3000;

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `pnpm --filter=./discerned-web dev --port ${WEB_PORT}`,
      cwd: resolve(__dirname, '..', '..'),
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `tsx ${resolve(__dirname, 'fixture-server.ts')}`,
      cwd: resolve(__dirname, '..', '..'),
      url: `http://127.0.0.1:${FIXTURE_PORT}/_health`,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      name: 'extension',
      testMatch: /(extension|end-to-end)\.spec\.ts/,
      // Chromium with a loaded extension uses launchPersistentContext, not the
      // default browser fixture. The spec files handle launch themselves.
    },
    {
      name: 'web',
      testMatch: /web-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'live',
      testMatch: /live\.spec\.ts/,
      grep: /@live/,
      retries: 0,
    },
    {
      name: 'primal-visual',
      testMatch: /primal-visual\.spec\.ts/,
      retries: 0,
    },
  ],
});
