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
      testMatch: /(extension|end-to-end|relay-prefs-e2e)\.spec\.ts/,
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
      name: 'tagger-canary',
      testMatch: /tagger-canary\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'corpus-sweep',
      testMatch: /corpus-sweep\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'corpus-sweep-manual',
      testMatch: /corpus-sweep-manual\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'discover-article-urls',
      testMatch: /tools\/discover-article-urls\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'finder-diag-probe',
      testMatch: /tools\/finder-diag-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'facebook-feed-fixture-visual',
      testMatch: /facebook-feed-fixture-visual\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'fb-card-probe',
      testMatch: /tools\/fb-card-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'snapshot-facebook-feed',
      testMatch: /tools\/snapshot-facebook-feed\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'reel-tree-probe',
      testMatch: /tools\/reel-tree-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'social-tagger-probe',
      testMatch: /tools\/social-tagger-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'feed-clip-render',
      testMatch: /tools\/feed-clip-render\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'feed-post-probe',
      testMatch: /tools\/feed-post-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'instagram-probe',
      testMatch: /tools\/instagram-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'modal-fp-probe',
      testMatch: /tools\/modal-fp-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'hidden-prose-probe',
      testMatch: /tools\/hidden-prose-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'clip-width-probe',
      testMatch: /tools\/clip-width-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'video-card-geom-probe',
      testMatch: /tools\/video-card-geom-probe\.spec\.ts$/,
      retries: 0,
    },
    {
      name: 'primal-video-probe',
      testMatch: /tools\/primal-video-probe\.spec\.ts$/,
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
    {
      name: 'wikipedia-fixture-visual',
      testMatch: /wikipedia-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'hn-thread-fixture-visual',
      testMatch: /hn-thread-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'hackernews-thread-fixture-visual',
      testMatch: /hackernews-thread-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'youtube-viewcount-fixture-visual',
      testMatch: /youtube-viewcount-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'news-article-fixture-visual',
      testMatch: /news-article-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'blog-post-fixture-visual',
      testMatch: /blog-post-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'substack-essay-fixture-visual',
      testMatch: /substack-essay-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'github-readme-fixture-visual',
      testMatch: /github-readme-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'twitter-thread-fixture-visual',
      testMatch: /twitter-thread-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'x-status-newshape-fixture-visual',
      testMatch: /x-status-newshape-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'tweet-cast-photos-visual',
      testMatch: /tweet-cast-photos-visual\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      retries: 0,
    },
    {
      name: 'article-with-embedded-tweet-fixture-visual',
      testMatch: /article-with-embedded-tweet-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'tweet-with-show-more-fixture-visual',
      testMatch: /tweet-with-show-more-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'primal-thread-fixture-visual',
      testMatch: /primal-thread-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'bsky-thread-fixture-visual',
      testMatch: /bsky-thread-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'overlay-visual',
      testMatch: /overlay-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'signal-render-visual',
      testMatch: /signal-render-visual\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      retries: 0,
    },
    {
      name: 'snapshot-fixtures',
      testMatch: /tools\/snapshot-fixtures\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'fetch-avatars',
      testMatch: /tools\/fetch-avatars\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'snapshot-primal-note',
      testMatch: /tools\/snapshot-primal-note\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'snapshot-bsky-post',
      testMatch: /tools\/snapshot-bsky-post\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'reddit-thread-fixture-visual',
      testMatch: /reddit-thread-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'youtube-watch-fixture-visual',
      testMatch: /youtube-watch-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'goodreads-book-fixture-visual',
      testMatch: /goodreads-book-fixture-visual\.spec\.ts/,
      retries: 0,
    },
    {
      name: 'stackoverflow-question-fixture-visual',
      testMatch: /stackoverflow-question-fixture-visual\.spec\.ts/,
      retries: 0,
    },
  ],
});
