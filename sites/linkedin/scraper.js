import 'dotenv/config';
import axios from 'axios';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  --detail-concurrency N     Backward-compatible no-op; JobSpy handles detail fetching
  --limit N                  Maximum jobs to save, 0 means no limit
  --timeout-ms N             Fetch timeout, default 60000
  --no-slack                 Disable Slack posting for this run
  --debug                    Print collection diagnostics
`);
}

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanDescription(value) {
  return cleanWhitespace(
    String(value || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/[*_`>#-]+/g, ' '),
  );
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

async function resolveSearchSources(args) {
  const sourceUrls = await resolveSourceUrls(args);
  const searchSources = [];
  const seenSearches = new Set();

  for (const sourceUrl of sourceUrls) {
    const parsed = new URL(sourceUrl);
    const search = cleanWhitespace(parsed.searchParams.get('keywords') || '');
    if (!search) {
      throw new Error(`LinkedIn JobSpy scraping requires a search URL with a keywords parameter: ${sourceUrl}`);
    }
    if (seenSearches.has(search)) continue;
    seenSearches.add(search);
    searchSources.push({ search, sourceUrl });
  }

  return searchSources;
}

async function scrapeLinkedInWithJobSpy(searchSources, args) {
  if (!searchSources.length) return [];

  const helperConfig = {
    searches: searchSources.map((source) => source.search),
    sourceUrls: Object.fromEntries(searchSources.map((source) => [source.search, source.sourceUrl])),
    resultsWanted: Math.max(args.maxPages, 1) * 25,
    hoursOld: 24,
    debug: args.debug,
  };
  const helperPath = fileURLToPath(new URL('./jobspy_bridge.py', import.meta.url));
  const python = process.env.LINKEDIN_JOBSPY_PYTHON || process.env.PYTHON || 'python3';
  const timeout = Math.max(args.timeoutMs, 1) * Math.max(searchSources.length, 1);
  let stdout;
  let stderr;
  try {
    const result = await execFileAsync(python, [helperPath, JSON.stringify(helperConfig)], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const detail = cleanWhitespace(error.stderr || error.stdout || error.message);
    throw new Error(`JobSpy bridge failed: ${detail}`);
  }

  if (args.debug && stderr) process.stderr.write(stderr);

  try {
    const rows = parseJobSpyJson(stdout);
    return rows.map((row) => jobSpyRowToJob(row));
  } catch (error) {
    throw new Error(`JobSpy returned invalid JSON: ${error.message}`);
  }
}

function parseJobSpyJson(stdout) {
  const output = String(stdout || '').trim();
  if (!output) return [];
  try {
    return JSON.parse(output);
  } catch {
    const jsonStart = output.indexOf('[');
    const jsonEnd = output.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) throw new Error(output.slice(0, 500));
    return JSON.parse(output.slice(jsonStart, jsonEnd + 1));
  }
}

function jobSpyRowToJob(row) {
  const scrapedAt = new Date().toISOString();
  const description = cleanDescription(row.description);
  const listingText = cleanWhitespace(
    [
      row.title,
      row.company,
      row.location,
      row.job_type,
      row.job_level,
      row.job_function,
      row.company_industry,
      description,
    ]
      .filter(Boolean)
      .join(' '),
  );

  return {
    title: cleanWhitespace(row.title),
    company: cleanWhitespace(row.company),
    location: cleanWhitespace(row.location || (row.is_remote ? 'Remote' : '')),
    postedAt: jobSpyDateToIso(row.date_posted, scrapedAt),
    description,
    url: row.job_url_direct ? cleanWhitespace(row.job_url_direct) : cleanJobUrl(row.job_url),
    source: 'LinkedIn',
    sourceUrl: row.source_url || '',
    scrapedAt,
    listingText,
  };
}

function jobSpyDateToIso(value, fallback) {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function cleanJobUrl(value) {
  const url = new URL(value, LINKEDIN_BASE_URL);
  url.search = '';
  return url.toString();
}

async function scrapeLinkedIn(args) {
  const searchSources = await resolveSearchSources(args);
  const sourceJobs = await scrapeLinkedInWithJobSpy(searchSources, args);
  const allJobs = [];
  const seenUrls = new Set();

  for (const job of filterJobsPostedWithinLast24Hours(filterExcludedEngineeringRoles(sourceJobs))) {
    if (!job.title || !job.url || seenUrls.has(job.url)) continue;
    seenUrls.add(job.url);
    allJobs.push(job);
    if (args.limit > 0 && allJobs.length >= args.limit) return allJobs;
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
