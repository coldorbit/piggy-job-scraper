import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { assertMostRecentSort, moveJobList } from '../sites/jobright/scraper.js';

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
