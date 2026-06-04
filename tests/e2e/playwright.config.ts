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
    {
      name: 'bsky-visual',
      testMatch: /bsky-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'goodreads-visual',
      testMatch: /goodreads-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'embedded-tweet-probe',
      testMatch: /embedded-tweet-probe\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'embedded-tweet-visual',
      testMatch: /embedded-tweet-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'twitter-clip-modes',
      testMatch: /twitter-clip-modes\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'zh-counters-probe',
      testMatch: /zh-counters-probe\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'medium-probe',
      testMatch: /medium-probe\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'medium-capture',
      testMatch: /medium-capture\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'medium-visual',
      testMatch: /medium-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'medium-fixture-visual',
      testMatch: /medium-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'breitbart-probe',
      testMatch: /breitbart-probe\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'breitbart-fixture-visual',
      testMatch: /breitbart-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'breitbart-visual',
      testMatch: /breitbart-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'tweet-video-probe',
      testMatch: /tweet-video-probe\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'extractor-frame0-probe',
      testMatch: /extractor-frame0-probe\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'extractor-full-probe',
      testMatch: /extractor-full-probe\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'youtube-visual',
      testMatch: /youtube-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'wikipedia-visual',
      testMatch: /wikipedia-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'reddit-visual',
      testMatch: /reddit-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'reddit-formats-visual',
      testMatch: /reddit-formats-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'bbc-visual',
      testMatch: /bbc-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'stackoverflow-visual',
      testMatch: /stackoverflow-visual\.spec\.ts/,
      retries: 0,
    },
  ],
});
