import 'dotenv/config';
import axios from 'axios';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { filterExcludedEngineeringRoles } from '../lib/jobFilters.js';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { filterJobsPostedWithinLast24Hours } from '../lib/recency.js';

const LINKEDIN_BASE_URL = 'https://www.linkedin.com';
const execFileAsync = promisify(execFile);
const DEFAULT_LINKEDIN_SEARCHES = [
  'software engineer',
  'data engineer',
  'machine learning engineer',
  'ai engineer',
  'artificial intelligence engineer',
  'full stack engineer',
  'backend engineer',
  'frontend engineer',
  'data scientist',
];
const OUTPUT_FIELDS = [
  'title',
  'company',
  'location',
  'postedAt',
  'description',
  'url',
  'source',
  'sourceUrl',
  'scrapedAt',
  'listingText',
];

const DEFAULT_ARGS = {
  searches: envList(process.env.LINKEDIN_SEARCHES || process.env.LINKEDIN_SEARCH),
  urls: envList(process.env.LINKEDIN_URLS),
  urlsFile: '',
  outputJson: 'results/linkedin/jobs.json',
  outputCsv: 'results/linkedin/jobs.csv',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  maxPages: 2,
  detailConcurrency: 3,
  limit: 0,
  timeoutMs: 60000,
  debug: false,
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
    '--output-json': 'outputJson',
    '--output-csv': 'outputCsv',
    '--slack-webhook-url': 'slackWebhookUrl',
    '--slack-channel': 'slackChannel',
    '--watch-interval-minutes': 'watchIntervalMinutes',
    '--max-pages': 'maxPages',
    '--detail-concurrency': 'detailConcurrency',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
  };
  const numericKeys = new Set([
    'watchIntervalMinutes',
    'maxPages',
    'detailConcurrency',
    'limit',
    'timeoutMs',
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
  console.log(`LinkedIn scraper

Usage:
  node sites/linkedin/scraper.js [options]

Options:
  --search TEXT              LinkedIn search text; repeat for multiple searches
                             Defaults: ${DEFAULT_LINKEDIN_SEARCHES.join(', ')}
  --url URL                  LinkedIn guest jobs API/search URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one LinkedIn URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling LinkedIn and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --max-pages N              Guest API pages to scrape per search, default 2
  --detail-concurrency N     Detail page concurrency, default 3
  --limit N                  Maximum jobs to save, 0 means no limit
  --timeout-ms N             Fetch timeout, default 60000
  --no-slack                 Disable Slack posting for this run
  --debug                    Print collection diagnostics
`);
}

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
  return cleanWhitespace(String(value || '').replace(/<[^>]*>/g, ' '));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanHtmlText(value) {
  return cleanWhitespace(decodeHtml(stripTags(value)));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readUrlFile(path) {
  if (!path) return [];
  const raw = await fs.readFile(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function searchUrl(search, start = 0) {
  const url = new URL('/jobs-guest/jobs/api/seeMoreJobPostings/search', LINKEDIN_BASE_URL);
  url.searchParams.set('keywords', search);
  url.searchParams.set('location', 'United States');
  url.searchParams.set('f_WT', '2');
  url.searchParams.set('f_TPR', 'r86400');
  url.searchParams.set('start', String(start));
  return url.toString();
}

function pageUrl(sourceUrl, pageNumber) {
  const url = new URL(sourceUrl);
  if (url.pathname.includes('/jobs-guest/jobs/api/seeMoreJobPostings/search')) {
    url.searchParams.set('start', String((pageNumber - 1) * 25));
  }
  return url.toString();
}

async function resolveSourceUrls(args) {
  const urls = [...args.urls, ...(await readUrlFile(args.urlsFile))];
  const searches = args.searches.length ? args.searches : DEFAULT_LINKEDIN_SEARCHES;
  const generatedUrls = searches.map((search) => searchUrl(search));
  const uniqueUrls = [...new Set(urls.length ? urls : generatedUrls)];
  for (const url of uniqueUrls) {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('linkedin.com')) {
      throw new Error(`Expected a linkedin.com URL, got: ${url}`);
    }
  }
  return uniqueUrls;
}

async function fetchHtml(url, timeoutMs) {
  try {
    return await fetchHtmlWithCurl(url, timeoutMs);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`curl fetch failed for ${url}: ${error.message}`);
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: timeoutMs,
        responseType: 'text',
        transformResponse: [(data) => data],
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      });
      return response.data;
    } catch (error) {
      lastError = error.response ? new Error(`LinkedIn returned ${error.response.status} for ${url}`) : error;
      if (attempt < 3) await sleep(750 * attempt);
    }
  }

  throw lastError;
}

async function fetchHtmlWithCurl(url, timeoutMs) {
  const timeoutSeconds = String(Math.max(Math.ceil(timeoutMs / 1000), 1));
  const { stdout } = await execFileAsync(
    'curl',
    [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--retry',
      '2',
      '--retry-max-time',
      timeoutSeconds,
      '--max-time',
      timeoutSeconds,
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      '--header',
      'accept: text/html,application/xhtml+xml',
      url,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return stdout;
}

function collectJobsFromHtml(html, sourceUrl, debug = false) {
  const scrapedAt = new Date().toISOString();
  const cards = html.match(/<div[^>]+base-search-card[\s\S]*?(?=<\/li>|<li>|$)/gi) || [];
  const jobs = [];
  const seenUrls = new Set();

  for (const card of cards) {
    const title = cleanHtmlText(matchText(card, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i));
    const company = cleanHtmlText(matchText(card, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i));
    const location = cleanHtmlText(matchText(card, /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/i));
    const rawUrl =
      decodeHtml(matchText(card, /<a[^>]+base-card__full-link[^>]+href=["']([^"']+)["']/i)) ||
      decodeHtml(matchText(card, /href=["']([^"']*\/jobs\/view\/[^"']+)["']/i));
    const postedAt = dateTextToIso(matchText(card, /<time[^>]+datetime=["']([^"']+)["']/i));

    if (!title || !rawUrl) continue;
    const url = cleanJobUrl(rawUrl);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const listingText = cleanHtmlText(card);
    jobs.push({
      title,
      company,
      location: location || 'Remote',
      postedAt,
      url,
      source: 'LinkedIn',
      sourceUrl,
      scrapedAt,
      description: '',
      listingText,
    });
  }

  if (debug) console.log(`Detected ${jobs.length} LinkedIn jobs on ${sourceUrl}`);
  return filterJobsPostedWithinLast24Hours(filterExcludedEngineeringRoles(jobs));
}

function collectDescriptionFromDetailHtml(html) {
  const description =
    matchText(
      html,
      /<div[^>]*show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>\s*(?:<\/section>|<button)/i,
    ) || matchText(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  return cleanHtmlText(description);
}

function collectCanonicalUrlFromHtml(html) {
  const canonicalUrl =
    matchText(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    matchText(html, /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
    matchText(html, /<meta[^>]+name=["']og:url["'][^>]+content=["']([^"']+)["']/i);

  return canonicalUrl ? cleanJobUrl(canonicalUrl) : '';
}

async function scrapeDescription(job, args) {
  try {
    const html = await fetchHtml(job.url, args.timeoutMs);
    const description = collectDescriptionFromDetailHtml(html);
    const detailUrl = collectCanonicalUrlFromHtml(html);
    const updatedJob = detailUrl ? { ...job, url: detailUrl } : job;

    if (!description) return updatedJob;
    return {
      ...updatedJob,
      description,
      listingText: cleanWhitespace([updatedJob.listingText, description].filter(Boolean).join(' ')),
    };
  } catch (error) {
    console.warn(`LinkedIn detail scrape skipped for ${job.url}: ${error.message}`);
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

async function enrichDescriptions(jobs, args) {
  if (!jobs.length) return jobs;
  return mapWithConcurrency(jobs, args.detailConcurrency, (job) => scrapeDescription(job, args));
}

function matchText(block, pattern) {
  const match = block.match(pattern);
  return match ? match[1] : '';
}

function cleanJobUrl(value) {
  const url = new URL(value, LINKEDIN_BASE_URL);
  url.search = '';
  return url.toString();
}

function dateTextToIso(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

async function scrapeSourceUrl(sourceUrl, args) {
  const jobs = [];
  const seenUrls = new Set();
  const maxPages = Math.max(args.maxPages, 1);

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const currentUrl = pageUrl(sourceUrl, pageNumber);
    const html = await fetchHtml(currentUrl, args.timeoutMs);
    const pageJobs = collectJobsFromHtml(html, currentUrl, args.debug);
    if (!pageJobs.length && pageNumber > 1) break;

    for (const job of pageJobs) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      jobs.push(job);
      if (args.limit > 0 && jobs.length >= args.limit) return jobs;
    }
  }

  return enrichDescriptions(jobs, args);
}

async function scrapeLinkedIn(args) {
  const sourceUrls = await resolveSourceUrls(args);
  const allJobs = [];
  const seenUrls = new Set();

  for (const sourceUrl of sourceUrls) {
    let sourceJobs = [];
    try {
      sourceJobs = await scrapeSourceUrl(sourceUrl, args);
    } catch (error) {
      console.warn(`LinkedIn scrape failed for ${sourceUrl}: ${error.message}`);
      continue;
    }

    for (const job of sourceJobs) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      allJobs.push(job);
      if (args.limit > 0 && allJobs.length >= args.limit) return allJobs;
    }
  }

  return allJobs;
}

async function ensureParentDirectory(path) {
  const directory = dirname(path);
  if (directory && directory !== '.') await fs.mkdir(directory, { recursive: true });
}

async function saveJson(path, jobs) {
  await ensureParentDirectory(path);
  await fs.writeFile(path, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8');
}

async function saveCsv(path, jobs) {
  await ensureParentDirectory(path);
  const lines = [OUTPUT_FIELDS.join(',')];
  for (const job of jobs) {
    lines.push(OUTPUT_FIELDS.map((field) => csvEscape(job[field])).join(','));
  }
  await fs.writeFile(path, `${lines.join('\n')}\n`, 'utf8');
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
  const source = slackEscape(job.source || 'LinkedIn');
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
  const text = `Found ${jobs.length} new LinkedIn ${plural}`;
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
  const jobs = await scrapeLinkedIn(args);

  console.log(`Found ${jobs.length} LinkedIn jobs posted within the last 24 hours.`);
  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} LinkedIn jobs to PostgreSQL.`);

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
      console.log('\nStopping LinkedIn watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching LinkedIn every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking LinkedIn for new jobs...`);

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
