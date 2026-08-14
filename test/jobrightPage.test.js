import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  assertMostRecentSort,
  isRemoteForCountry,
  moveJobList,
  trackJobrightBatches,
  verifyJobrightCountryFilter,
} from '../sites/jobright/scraper.js';

test('Jobright sort verification reads only the selected value', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();

  await page.setContent(`
    <div class="index_jobs-recommend-sorter__hash ant-select">
      <span class="ant-select-selection-item">Recommended</span>
    </div>
    <div role="option">Most Recent</div>
  `);

  await assert.rejects(assertMostRecentSort(page), /selected value is "Recommended"/);

  await page.locator('.ant-select-selection-item').evaluate((element) => {
    element.textContent = 'Most Recent';
  });
  await assert.doesNotReject(assertMostRecentSort(page));
});

test('Jobright scrolling moves its internal job-list panel', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  await page.setContent(`
    <style>
      body { margin: 0; }
      #jobs-page-main-content { height: 200px; overflow-y: auto; }
      .job-list-spacer { height: 1600px; }
    </style>
    <div id="jobs-page-main-content">
      <a href="/jobs/info/example">Example job</a>
      <div class="job-list-spacer"></div>
    </div>
  `);

  const state = await moveJobList(page);

  assert.equal(state.target, 'jobs-page-main-content');
  assert.equal(state.before, 0);
  assert.ok(state.after >= 600);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test('Jobright infinite-scroll tracker preserves prefetched batches', async () => {
  const page = new EventEmitter();
  const tracker = trackJobrightBatches(page);
  const response = (position) => ({
    url: () =>
      `https://jobright.ai/swan/recommend/list/jobs?refresh=false&sortCondition=1&position=${position}&count=10`,
    request: () => ({ method: () => 'GET' }),
    status: () => 200,
  });

  page.emit('response', response(10));
  page.emit('response', response(20));

  assert.equal((await tracker.next(50)).position, 10);
  assert.equal((await tracker.next(50)).position, 20);
  tracker.stop();
});

test('verified Jobright country feeds accept remote city and province cards', () => {
  assert.equal(isRemoteForCountry('Toronto, ON Remote', 'ca'), false);
  assert.equal(isRemoteForCountry('Toronto, ON Remote', 'ca', true), true);
  assert.equal(isRemoteForCountry('Austin, TX Remote', 'us', true), true);
});

test('Jobright country verification rejects a mislabeled session', async () => {
  const page = {
    request: {
      post: async () => ({
        ok: () => true,
        json: async () => ({ result: { country: 'GB' } }),
      }),
    },
  };
  const args = { authenticatedSession: true, country: 'us', timeoutMs: 60_000, debug: false };

  await assert.rejects(
    verifyJobrightCountryFilter(page, args),
    /United States session has the United Kingdom country filter/,
  );
  assert.notEqual(args.countryFilterVerified, true);
});
