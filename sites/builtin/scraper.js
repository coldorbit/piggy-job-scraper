import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { filterJobsPostedWithinLast24Hours } from '../lib/recency.js';
import { filterExcludedEngineeringRoles } from '../lib/jobFilters.js';
import { enrichJobDescriptions } from '../lib/descriptions.js';

const BUILTIN_BASE_URL = 'https://builtin.com';
const DEFAULT_BUILTIN_URLS = [
  'https://builtin.com/jobs/remote/engineering/software-engineering?daysSinceUpdated=1&city=&state=&country=USA&allLocations=true',
  'https://builtin.com/jobs/remote/data-analytics/data-engineering?daysSinceUpdated=1&country=USA&allLocations=true',
  'https://builtin.com/jobs/remote/ai-machine-learning/ai-engineering/machine-learning-engineering/data-science/generative-artificial-intelligence/computer-vision-ai/nlp/deep-learning?daysSinceUpdated=1&country=USA&allLocations=true',
];

const DEFAULT_ARGS = {
  urls: envUrls(process.env.BUILTIN_URLS),
  urlsFile: '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  maxPages: 1,
  limit: 0,
  timeoutMs: 60000,
  detailConcurrency: 3,
  debug: false,
  headless: true,
  watch: false,
};

function envUrls(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = { ...DEFAULT_ARGS, urls: [...DEFAULT_ARGS.urls] };
  const aliases = {
    '--urls-file': 'urlsFile',
    '--slack-webhook-url': 'slackWebhookUrl',
    '--slack-channel': 'slackChannel',
    '--watch-interval-minutes': 'watchIntervalMinutes',
    '--max-pages': 'maxPages',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
    '--detail-concurrency': 'detailConcurrency',
  };
  const numericKeys = new Set([
    'watchIntervalMinutes',
    'maxPages',
    'limit',
    'timeoutMs',
    'detailConcurrency',
  ]);

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
  console.log(`Built In job scraper

Usage:
  node sites/builtin/scraper.js [options]

Options:
  --url URL                  Built In search URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one Built In URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling Built In and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --max-pages N              Pages to scrape per search URL, default 1
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

function absoluteUrl(href) {
  return new URL(href, BUILTIN_BASE_URL).toString();
}

function pageUrl(sourceUrl, pageNumber) {
  const url = new URL(sourceUrl);
  if (pageNumber > 1) url.searchParams.set('page', String(pageNumber));
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
  const uniqueUrls = [...new Set(urls.length ? urls : DEFAULT_BUILTIN_URLS)].map((url) => {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('builtin.com')) {
      throw new Error(`Expected a builtin.com URL, got: ${url}`);
    }
    parsed.searchParams.set('daysSinceUpdated', '1');
    return parsed.toString();
  });
  return uniqueUrls;
}

async function maybeAcceptPopups(page) {
  for (const label of ['Reject', 'Accept', 'Accept all', 'I agree', 'Got it', 'Close']) {
    try {
      await page.getByRole('button', { name: new RegExp(label, 'i') }).click({ timeout: 750 });
    } catch {
      // Optional cookie/marketing popups.
    }
  }
}

async function waitForQuietPage(page, timeoutMs, settleMs = 2500) {
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    await page.waitForTimeout(settleMs);
  }
}

async function collectJobsFromPage(page, sourceUrl, debug = false) {
  const scrapedAt = new Date().toISOString();
  const jobs = await page.evaluate(
    ({ baseUrl, sourceUrl: evaluatedSourceUrl, scrapedAt: evaluatedScrapedAt }) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const links = [...document.querySelectorAll('a[href]')];
      const rows = [];
      const seen = new Set();

      for (const [index, link] of links.entries()) {
        const href = link.getAttribute('href') || '';
        if (!href.includes('/job/')) continue;

        const url = new URL(href, baseUrl).toString();
        if (seen.has(url)) continue;
        seen.add(url);

        const title = clean(link.textContent);
        if (!title || /^\d+$/.test(title)) continue;

        let company = '';
        for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
          const previous = links[previousIndex];
          const previousHref = previous.getAttribute('href') || '';
          const previousText = clean(previous.textContent);
          if (previousHref.includes('/company/') && previousText) {
            company = previousText;
            break;
          }
        }

        let card = link;
        for (let level = 0; level < 5 && card?.parentElement; level += 1) {
          card = card.parentElement;
          const cardText = clean(card.innerText);
          if (cardText.includes(title) && company && cardText.includes(company)) break;
        }

        rows.push({
          title,
          company,
          url,
          source: 'Builtin',
          sourceUrl: evaluatedSourceUrl,
          postedAt: evaluatedScrapedAt,
          scrapedAt: evaluatedScrapedAt,
          listingText: clean(card?.innerText || link.textContent),
        });
      }

      return rows;
    },
    { baseUrl: BUILTIN_BASE_URL, sourceUrl, scrapedAt },
  );

  if (debug) console.log(`Detected ${jobs.length} Built In jobs on ${sourceUrl}`);
  return jobs;
}

async function scrapeSourceUrl(context, sourceUrl, args) {
  const jobs = [];
  const seenUrls = new Set();

  for (let pageNumber = 1; pageNumber <= Math.max(args.maxPages, 1); pageNumber += 1) {
    const currentUrl = pageUrl(sourceUrl, pageNumber);
    const page = await context.newPage();
    try {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
      await waitForQuietPage(page, args.timeoutMs);
      await maybeAcceptPopups(page);
      await page.waitForSelector("a[href*='/job/']", { timeout: args.timeoutMs });

      const recentJobs = filterJobsPostedWithinLast24Hours(
        filterExcludedEngineeringRoles(await collectJobsFromPage(page, sourceUrl, args.debug)),
      );
      for (const job of recentJobs) {
        if (seenUrls.has(job.url)) continue;
        seenUrls.add(job.url);
        jobs.push(job);
      }
    } finally {
      await page.close();
    }
  }

  return jobs;
}

async function scrapeBuiltinJobs(args) {
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
      for (const job of await scrapeSourceUrl(context, sourceUrl, args)) {
        if (seenUrls.has(job.url)) continue;
        seenUrls.add(job.url);
        allJobs.push(job);
      }
    }
    const limitedJobs = args.limit > 0 ? allJobs.slice(0, args.limit) : allJobs;
    return enrichJobDescriptions(limitedJobs, {
      timeoutMs: args.timeoutMs,
      concurrency: args.detailConcurrency,
      sourceName: 'Built In',
    });
  } finally {
    await context.close();
    await browser.close();
  }
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
  const source = slackEscape(job.source || 'Builtin');
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
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: slackCodeBlock(batch),
        },
      });
      batch = line;
    } else {
      batch = nextBatch;
    }
  }

  if (batch) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackCodeBlock(batch),
      },
    });
  }

  return blocks;
}

function buildSlackPayload(jobs, args) {
  const plural = jobs.length === 1 ? 'job' : 'jobs';
  const text = `Found ${jobs.length} new Built In ${plural}`;
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${text}*`,
      },
    },
    ...slackJobBatchBlocks(jobs),
  ];

  return {
    text,
    ...(args.slackChannel ? { channel: args.slackChannel } : {}),
    blocks,
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
  const jobs = await scrapeBuiltinJobs(args);

  console.log(`Found ${jobs.length} Built In jobs posted within the last 24 hours.`);
  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} Built In jobs to PostgreSQL.`);

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
      console.log('\nStopping Built In watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching Built In every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking Built In for new jobs...`);

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
