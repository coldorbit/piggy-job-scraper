import 'dotenv/config';
import axios from 'axios';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { filterJobsPostedWithinLast24Hours } from '../lib/recency.js';
import { filterExcludedEngineeringRoles } from '../lib/jobFilters.js';
import { cleanHtmlText, enrichJobDescriptions } from '../lib/descriptions.js';

const HIRINGCAFE_BASE_URL = 'https://hiring.cafe';
const execFileAsync = promisify(execFile);
const DEFAULT_HIRINGCAFE_SEARCHES = [
  'software engineer',
  'data engineer',
  'machine learning engineer',
  'ai engineer',
  'full stack engineer',
  'backend engineer',
  'frontend engineer',
  'data scientist',
];
const DEFAULT_DEPARTMENTS = [
  'Engineering',
  'Software Development',
  'Information Technology',
  'Data and Analytics',
  'Quality Assurance',
];
const OUTPUT_FIELDS = [
  'title',
  'company',
  'location',
  'workplaceType',
  'jobCategory',
  'commitment',
  'seniority',
  'postedAt',
  'salary',
  'url',
  'applyUrl',
  'source',
  'sourceUrl',
  'scrapedAt',
  'description',
  'listingText',
];

const DEFAULT_ARGS = {
  searches: envList(process.env.HIRINGCAFE_SEARCHES || process.env.HIRINGCAFE_SEARCH),
  urls: envList(process.env.HIRINGCAFE_URLS),
  urlsFile: '',
  outputJson: 'results/hiringcafe/jobs.json',
  outputCsv: 'results/hiringcafe/jobs.csv',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  dateFetchedPastNDays: 1,
  limit: 0,
  timeoutMs: 60000,
  detailConcurrency: 3,
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
    '--date-fetched-past-n-days': 'dateFetchedPastNDays',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
    '--detail-concurrency': 'detailConcurrency',
  };
  const numericKeys = new Set(['watchIntervalMinutes', 'dateFetchedPastNDays', 'limit', 'timeoutMs', 'detailConcurrency']);

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
  console.log(`HiringCafe scraper

Usage:
  node sites/hiringcafe/scraper.js [options]

Options:
  --search TEXT              HiringCafe search text; repeat for multiple searches
                             Defaults: ${DEFAULT_HIRINGCAFE_SEARCHES.join(', ')}
  --url URL                  HiringCafe search URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one HiringCafe search URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling HiringCafe and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --date-fetched-past-n-days N
                             HiringCafe recency filter, default 1
  --limit N                  Maximum jobs to save, 0 means no limit
  --timeout-ms N             Fetch timeout, default 60000
  --detail-concurrency N     Detail page concurrency, default 3
  --no-slack                 Disable Slack posting for this run
  --debug                    Print collection diagnostics
`);
}

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
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

function buildSearchUrl(search, args) {
  const state = {
    searchQuery: search,
    workplaceTypes: ['Remote'],
    departments: DEFAULT_DEPARTMENTS,
    dateFetchedPastNDays: args.dateFetchedPastNDays,
  };
  const url = new URL('/', HIRINGCAFE_BASE_URL);
  url.searchParams.set('searchState', JSON.stringify(state));
  return url.toString();
}

async function resolveSourceUrls(args) {
  const urls = [...args.urls, ...(await readUrlFile(args.urlsFile))];
  const searches = args.searches.length ? args.searches : DEFAULT_HIRINGCAFE_SEARCHES;
  const generatedUrls = searches.map((search) => buildSearchUrl(search, args));
  const uniqueUrls = [...new Set(urls.length ? urls : generatedUrls)];
  for (const url of uniqueUrls) {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('hiring.cafe')) {
      throw new Error(`Expected a hiring.cafe URL, got: ${url}`);
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
    if (error.response) throw new Error(`HiringCafe returned ${error.response.status} for ${url}`);
    throw error;
  }
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
      maxBuffer: 25 * 1024 * 1024,
    },
  );
  return stdout;
}

function extractNextData(html, sourceUrl) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`Could not find HiringCafe data on ${sourceUrl}`);
  return JSON.parse(match[1]);
}

function collectJobsFromHtml(html, sourceUrl, debug = false) {
  const scrapedAt = new Date().toISOString();
  const data = extractNextData(html, sourceUrl);
  const hits = data?.props?.pageProps?.ssrHits || [];
  const jobs = [];
  const seenUrls = new Set();

  for (const hit of hits) {
    const job = normalizeJob(hit, sourceUrl, scrapedAt);
    if (!job.title || !job.url || seenUrls.has(job.url)) continue;
    if (!isRelevantRemoteTechJob(job, hit)) continue;
    seenUrls.add(job.url);
    jobs.push(job);
  }

  if (debug) {
    const total = data?.props?.pageProps?.ssrTotalCount;
    console.log(`Detected ${jobs.length} relevant HiringCafe jobs from ${hits.length} hits on ${sourceUrl}`);
    if (total) console.log(`HiringCafe reported ${total} total matches for this search.`);
  }
  return jobs;
}

function normalizeJob(hit, sourceUrl, scrapedAt) {
  const processed = hit?.v5_processed_job_data || {};
  const company = cleanWhitespace(
    processed.company_name || hit?.enriched_company_data?.name || hit?.job_information?.company,
  );
  const title = cleanWhitespace(hit?.job_information?.title || hit?.job_information?.job_title_raw);
  const applyUrl = cleanWhitespace(hit?.apply_url);
  const url = applyUrl || cleanWhitespace(hit?.objectID || hit?.id);
  const commitment = arrayText(processed.commitment);
  const salary = compensationText(processed);
  const description = cleanWhitespace(
    cleanHtmlText(
      processed.job_description ||
        processed.description ||
        processed.requirements_summary ||
        hit?.job_information?.description ||
        hit?.job_information?.job_description ||
        '',
    ),
  );
  const listingText = cleanWhitespace(
    [
      title,
      company,
      processed.formatted_workplace_location,
      processed.workplace_type,
      processed.job_category,
      commitment,
      processed.seniority_level,
      salary,
      description,
      processed.requirements_summary,
      arrayText(processed.technical_tools),
    ].join(' '),
  );

  return {
    title,
    company,
    location: cleanWhitespace(processed.formatted_workplace_location),
    workplaceType: cleanWhitespace(processed.workplace_type),
    jobCategory: cleanWhitespace(processed.job_category),
    commitment,
    seniority: cleanWhitespace(processed.seniority_level),
    postedAt: dateTextToIso(processed.estimated_publish_date),
    salary,
    url,
    applyUrl,
    source: 'HiringCafe',
    sourceUrl,
    scrapedAt,
    description,
    listingText,
  };
}

function arrayText(value) {
  return Array.isArray(value) ? value.map(cleanWhitespace).filter(Boolean).join(', ') : cleanWhitespace(value);
}

function compensationText(job) {
  const currency = job.listed_compensation_currency || 'USD';
  const frequency = cleanWhitespace(job.listed_compensation_frequency || 'Yearly').toLowerCase();
  const byFrequency = {
    hourly: [job.hourly_min_compensation, job.hourly_max_compensation],
    daily: [job.daily_min_compensation, job.daily_max_compensation],
    weekly: [job.weekly_min_compensation, job.weekly_max_compensation],
    monthly: [job.monthly_min_compensation, job.monthly_max_compensation],
    yearly: [job.yearly_min_compensation, job.yearly_max_compensation],
  };
  const [min, max] = byFrequency[frequency] || byFrequency.yearly;
  const values = [min, max].filter((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (!values.length) return '';

  const format = (amount) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number(amount) < 100 ? 2 : 0,
    }).format(amount);
  const range = [...new Set(values.map((value) => format(Number(value))))].join(' - ');
  const suffixByFrequency = {
    hourly: 'hr',
    daily: 'day',
    weekly: 'wk',
    monthly: 'mo',
    yearly: 'yr',
  };
  return `${range}/${suffixByFrequency[frequency] || frequency}`;
}

function dateTextToIso(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function isRelevantRemoteTechJob(job, rawJob) {
  const processed = rawJob?.v5_processed_job_data || {};
  const workplace = [job.workplaceType, processed.is_workplace_worldwide_ok ? 'worldwide' : ''].join(' ');
  const remote = /\b(remote|hybrid|worldwide|boundless)\b/i.test(workplace);
  if (!remote) return false;

  const text = [
    job.title,
    job.jobCategory,
    job.listingText,
    arrayText(processed.technical_tools),
    arrayText(processed.role_activities),
  ]
    .join(' ')
    .toLowerCase();
  return /\b(ai|analytics|backend|data|developer|engineer|engineering|frontend|full[- ]?stack|information technology|machine learning|ml|qa|quality assurance|software)\b/i.test(
    text,
  );
}

async function scrapeSourceUrl(sourceUrl, args) {
  const html = await fetchHtml(sourceUrl, args.timeoutMs);
  return filterJobsPostedWithinLast24Hours(
    filterExcludedEngineeringRoles(collectJobsFromHtml(html, sourceUrl, args.debug)),
  );
}

async function scrapeHiringCafe(args) {
  const sourceUrls = await resolveSourceUrls(args);
  const allJobs = [];
  const seenUrls = new Set();

  for (const sourceUrl of sourceUrls) {
    let sourceJobs = [];
    try {
      sourceJobs = await scrapeSourceUrl(sourceUrl, args);
    } catch (error) {
      console.warn(`HiringCafe scrape failed for ${sourceUrl}: ${error.message}`);
      continue;
    }

    for (const job of sourceJobs) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      allJobs.push(job);
      if (args.limit > 0 && allJobs.length >= args.limit) return allJobs;
    }
  }

  return enrichJobDescriptions(allJobs, {
    timeoutMs: args.timeoutMs,
    concurrency: args.detailConcurrency,
    sourceName: 'HiringCafe',
    urlForJob: (job) => job.applyUrl || job.url,
  });
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
  const source = slackEscape(job.source || 'HiringCafe');
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
  const text = `Found ${jobs.length} new HiringCafe ${plural}`;
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
  const jobs = await scrapeHiringCafe(args);

  console.log(`Found ${jobs.length} HiringCafe jobs posted within the last 24 hours.`);
  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} HiringCafe jobs to PostgreSQL.`);

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
      console.log('\nStopping HiringCafe watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching HiringCafe every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking HiringCafe for new jobs...`);

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
