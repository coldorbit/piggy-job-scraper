import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { filterJobsPostedWithinLast24Hours } from '../lib/recency.js';
import { filterExcludedEngineeringRoles } from '../lib/jobFilters.js';
import { cleanHtmlText } from '../lib/descriptions.js';

const REMOTEHUNTER_BASE_URL = 'https://www.remotehunter.com';
const DEFAULT_REMOTEHUNTER_SEARCHES = [
  'Software Engineer',
  'Data Engineer',
  'Machine Learning Engineer',
  'AI Engineer',
  'Full Stack Engineer',
  'Backend Engineer',
  'Frontend Engineer',
  'Data Scientist',
];

const DEFAULT_ARGS = {
  searches: envList(process.env.REMOTEHUNTER_SEARCHES || process.env.REMOTEHUNTER_SEARCH),
  urls: envList(process.env.REMOTEHUNTER_URLS),
  urlsFile: '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  maxScrolls: 10,
  limit: 0,
  timeoutMs: 60000,
  detailConcurrency: 3,
  debug: false,
  headless: true,
  watch: false,
};

function envList(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    ...DEFAULT_ARGS,
    searches: [...DEFAULT_ARGS.searches],
    urls: [...DEFAULT_ARGS.urls],
  };
  const aliases = {
    '--urls-file': 'urlsFile',
    '--slack-webhook-url': 'slackWebhookUrl',
    '--slack-channel': 'slackChannel',
    '--watch-interval-minutes': 'watchIntervalMinutes',
    '--max-scrolls': 'maxScrolls',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
    '--detail-concurrency': 'detailConcurrency',
  };
  const numericKeys = new Set(['watchIntervalMinutes', 'maxScrolls', 'limit', 'timeoutMs', 'detailConcurrency']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    if (token === '--url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --url');
      args.urls.push(value);
      index += 1;
      continue;
    }
    if (token === '--search') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --search');
      args.searches.push(value);
      index += 1;
      continue;
    }
    if (token === '--debug') {
      args.debug = true;
      continue;
    }
    if (token === '--headless') {
      args.headless = true;
      continue;
    }
    if (token === '--no-headless') {
      args.headless = false;
      continue;
    }
    if (token === '--watch') {
      args.watch = true;
      continue;
    }
    if (token === '--no-slack') {
      args.slackWebhookUrl = '';
      continue;
    }

    const key = aliases[token];
    if (!key) throw new Error(`Unknown option: ${token}`);

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    args[key] = numericKeys.has(key) ? Number(value) : value;
    if (numericKeys.has(key) && Number.isNaN(args[key])) {
      throw new Error(`Expected a number for ${token}, got: ${value}`);
    }
    index += 1;
  }

  return args;
}

function printHelp() {
  console.log(`RemoteHunter scraper

Usage:
  node sites/remotehunter/scraper.js [options]

Options:
  --search TEXT              RemoteHunter search text; repeat for multiple searches
                             Defaults: ${DEFAULT_REMOTEHUNTER_SEARCHES.join(', ')}
  --url URL                  RemoteHunter jobs URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one RemoteHunter jobs URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling RemoteHunter and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --max-scrolls N            Page scroll attempts per source URL, default 10
  --limit N                  Maximum jobs to save, 0 means no limit
  --timeout-ms N             Playwright timeout, default 60000
  --detail-concurrency N     Detail page concurrency, default 3
  --headless / --no-headless Browser visibility, default headless
  --no-slack                 Disable Slack posting for this run
  --debug                    Print collection diagnostics
`);
}

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function jobUuidFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/apply-with-ai\/([^/]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function searchUrl(search) {
  const url = new URL('/jobs', REMOTEHUNTER_BASE_URL);
  url.searchParams.set('job_tag', 'remote');
  url.searchParams.set('salary_required', 'yes');
  url.searchParams.set('search', search);
  return url.toString();
}

async function readUrlFile(path) {
  if (!path) return [];
  const raw = await fs.readFile(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function resolveSourceUrls(args) {
  const urls = [...args.urls, ...(await readUrlFile(args.urlsFile))];
  const searches = args.searches.length ? args.searches : DEFAULT_REMOTEHUNTER_SEARCHES;
  const generatedUrls = searches.map(searchUrl);
  const uniqueUrls = [...new Set(urls.length ? urls : generatedUrls)];
  for (const url of uniqueUrls) {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('remotehunter.com')) {
      throw new Error(`Expected a remotehunter.com URL, got: ${url}`);
    }
  }
  return uniqueUrls;
}

async function waitForJobs(page, timeoutMs) {
  await page.waitForFunction(
    () => document.querySelectorAll('a[href*="/apply-with-ai/"]').length > 0,
    null,
    { timeout: timeoutMs },
  );
}

async function autoScroll(page, maxScrolls, debug = false) {
  let previousCount = 0;
  let stableRuns = 0;

  for (let scroll = 0; scroll < Math.max(maxScrolls, 0); scroll += 1) {
    const count = await page.locator('a[href*="/apply-with-ai/"]').count();
    if (debug) console.log(`RemoteHunter scroll ${scroll + 1}: ${count} job links`);

    stableRuns = count === previousCount ? stableRuns + 1 : 0;
    if (stableRuns >= 2) break;
    previousCount = count;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
}

async function collectJobsFromPage(page, sourceUrl, debug = false) {
  const scrapedAt = new Date().toISOString();
  const jobs = await page.evaluate(
    ({ baseUrl, sourceUrl: evaluatedSourceUrl, scrapedAt: evaluatedScrapedAt }) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const rows = [];
      const seen = new Set();

      for (const link of document.querySelectorAll('a[href*="/apply-with-ai/"]')) {
        const title = clean(link.querySelector('h4 span[title]')?.getAttribute('title'));
        if (!title) continue;

        const url = new URL(link.getAttribute('href'), baseUrl);
        url.search = '';
        if (seen.has(url.toString())) continue;
        seen.add(url.toString());

        const company = clean(link.querySelector('h4')?.parentElement?.nextElementSibling?.textContent);
        const detailRows = [...link.querySelectorAll('.space-y-1 > div')].map((row) =>
          clean(row.textContent),
        );
        const postedText = detailRows.find((line) => /\b(hour|day|week|month|year)s?\s+ago\b/i.test(line)) || '';
        const salary = detailRows.find((line) => /[$€£]\s?\d/.test(line)) || '';
        const status = detailRows.find((line) => /hiring|closed|expired/i.test(line)) || '';
        const location =
          detailRows.find(
            (line) =>
              !line.includes('$') &&
              !/hiring|closed|expired/i.test(line) &&
              !/\b(hour|day|week|month|year)s?\s+ago\b/i.test(line),
          ) || 'Remote';
        const listingText = clean([title, company, postedText, location, salary, status].join(' '));

        rows.push({
          title,
          company,
          location,
          postedText,
          salary,
          status,
          url: url.toString(),
          source: 'RemoteHunter',
          sourceUrl: evaluatedSourceUrl,
          scrapedAt: evaluatedScrapedAt,
          description: '',
          listingText,
        });
      }

      return rows;
    },
    { baseUrl: REMOTEHUNTER_BASE_URL, sourceUrl, scrapedAt },
  );

  if (debug) console.log(`Detected ${jobs.length} RemoteHunter jobs on ${sourceUrl}`);
  return jobs;
}

async function scrapeSourceUrl(context, sourceUrl, args) {
  const page = await context.newPage();
  try {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
    try {
      await waitForJobs(page, args.timeoutMs);
    } catch (error) {
      console.warn(`No RemoteHunter jobs detected on ${sourceUrl}: ${error.message}`);
      return [];
    }
    await page.waitForTimeout(1500);
    await autoScroll(page, args.maxScrolls, args.debug);
    return filterJobsPostedWithinLast24Hours(
      filterExcludedEngineeringRoles(await collectJobsFromPage(page, sourceUrl, args.debug)),
    );
  } finally {
    await page.close();
  }
}

async function scrapeRemoteHunter(args) {
  const sourceUrls = await resolveSourceUrls(args);
  const browser = await chromium.launch({
    headless: args.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });

  try {
    const allJobs = [];
    const seenUrls = new Set();
    for (const sourceUrl of sourceUrls) {
      let sourceJobs = [];
      try {
        sourceJobs = await scrapeSourceUrl(context, sourceUrl, args);
      } catch (error) {
        console.warn(`RemoteHunter scrape failed for ${sourceUrl}: ${error.message}`);
        continue;
      }

      for (const job of sourceJobs) {
        if (seenUrls.has(job.url)) continue;
        seenUrls.add(job.url);
        allJobs.push(job);
        if (args.limit > 0 && allJobs.length >= args.limit) return allJobs;
      }
    }
    return enrichRemoteHunterDescriptions(allJobs, args);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function enrichRemoteHunterDescriptions(jobs, args) {
  if (!jobs.length) return jobs;
  return mapWithConcurrency(jobs, args.detailConcurrency, (job) => scrapeRemoteHunterDescription(job, args));
}

async function scrapeRemoteHunterDescription(job, args) {
  const jobUuid = jobUuidFromUrl(job.url);
  if (!jobUuid) return job;

  try {
    const response = await axios.get(`${REMOTEHUNTER_BASE_URL}/api/jobs/${encodeURIComponent(jobUuid)}`, {
      timeout: args.timeoutMs,
      responseType: 'json',
      headers: {
        accept: 'application/json',
        referer: REMOTEHUNTER_BASE_URL,
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
    });
    const payload = response.data?.data || response.data;
    const description = cleanHtmlText(payload?.description_formatted || payload?.description).slice(0, 20000);
    if (!description) return job;
    return {
      ...job,
      description,
      listingText: cleanWhitespace([job.listingText, description].filter(Boolean).join(' ')),
    };
  } catch (error) {
    console.warn(`RemoteHunter detail scrape skipped for ${job.url}: ${error.message}`);
    return job;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function slackEscape(value) {
  return cleanWhitespace(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function slackJobLine(job) {
  const title = slackEscape(job.title || 'Untitled role');
  const company = slackEscape(job.company || 'Unknown company');
  const url = slackEscape(job.url);
  const source = slackEscape(job.source || 'RemoteHunter');
  return `${title} ;; ${company} ;; ${url} ;; ${source}`;
}

function slackCodeBlock(text) {
  return `\`\`\`\n${text}\n\`\`\``;
}

function slackJobBatchBlocks(jobs) {
  const blocks = [];
  const maxSectionLength = 2800;
  let batch = '';

  for (const job of jobs) {
    const line = slackJobLine(job);
    const nextBatch = batch ? `${batch}\n${line}` : line;
    if (nextBatch.length > maxSectionLength && batch) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackCodeBlock(batch) } });
      batch = line;
    } else {
      batch = nextBatch;
    }
  }

  if (batch) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackCodeBlock(batch) } });
  return blocks;
}

function buildSlackPayload(jobs, args) {
  const plural = jobs.length === 1 ? 'job' : 'jobs';
  const text = `Found ${jobs.length} new RemoteHunter ${plural}`;
  return {
    text,
    ...(args.slackChannel ? { channel: args.slackChannel } : {}),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${text}*` } }, ...slackJobBatchBlocks(jobs)],
  };
}

async function postNewJobsToSlack(jobs, args) {
  if (!args.slackWebhookUrl || !jobs.length) return;

  const response = await axios.post(args.slackWebhookUrl, buildSlackPayload(jobs, args), {
    headers: { 'content-type': 'application/json' },
    validateStatus: () => true,
    transformResponse: [(data) => data],
  });

  if (response.status < 200 || response.status >= 300) {
    const body = response.data || '';
    throw new Error(`Slack webhook returned ${response.status}: ${body || response.statusText}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runScraper(args) {
  const jobs = await scrapeRemoteHunter(args);

  console.log(`Found ${jobs.length} RemoteHunter jobs posted within the last 24 hours.`);
  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} RemoteHunter jobs to PostgreSQL.`);

  const savedUrlSet = new Set(savedUrls);
  const newJobs = jobs.filter((job) => job.url && savedUrlSet.has(job.url));

  if (args.slackWebhookUrl) {
    try {
      await postNewJobsToSlack(newJobs, args);
      console.log(`Posted ${newJobs.length} new jobs to Slack.`);
    } catch (error) {
      console.warn(`Slack post failed: ${error.message}`);
    }
  } else {
    console.log('Slack webhook not configured; skipping Slack post.');
  }

  return jobs;
}

async function watchScraper(args) {
  const intervalMs = Math.max(args.watchIntervalMinutes, 1) * 60 * 1000;
  let shouldStop = false;

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shouldStop = true;
      console.log('\nStopping RemoteHunter watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching RemoteHunter every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking RemoteHunter for new jobs...`);

    try {
      await runScraper(args);
    } catch (error) {
      console.error(`Watch run failed: ${error.message}`);
    }

    if (!shouldStop) await sleep(intervalMs);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.watch) {
    await watchScraper(args);
  } else {
    await runScraper(args);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
