import { test } from '@playwright/test';
import { launchWithExtension } from './helpers/launchExtension';

test('profile probe', async () => {
  test.setTimeout(90_000);
  const { ctx, userDataDir } = await launchWithExtension({ headed: true });
  try {
    console.log('PROBE userDataDir =', userDataDir);
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto('about:blank');
    console.log('PROBE UA =', await page.evaluate(() => navigator.userAgent));
  } finally { await ctx.close(); }
});
