import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs/promises';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { filterJobsPostedWithinLast24Hours } from '../lib/recency.js';
import { filterExcludedEngineeringRoles } from '../lib/jobFilters.js';
import { cleanHtmlText, enrichJobDescriptions } from '../lib/descriptions.js';

const SIMPLIFY_BASE_URL = 'https://simplify.jobs';
const DEFAULT_SIMPLIFY_URLS = [
  'https://simplify.jobs/latest-jobs/S',
  'https://simplify.jobs/latest-jobs/D',
  'https://simplify.jobs/latest-jobs/M',
  'https://simplify.jobs/latest-jobs/A',
  'https://simplify.jobs/latest-jobs/E',
  'https://simplify.jobs/latest-jobs/F',
  'https://simplify.jobs/latest-jobs/B',
  'https://simplify.jobs/latest-jobs/P',
];
const LATEST_JOB_TITLE_PATTERN =
  /\b(ai|backend|data|developer|engineer|engineering|frontend|full-?stack|machine|ml|software)\b/i;
const RELEVANT_JOB_PATTERN =
  /\b(ai|analytics|backend|computer vision|data|deep learning|developer|engineer|engineering|frontend|full-?stack|generative|llm|machine learning|ml|nlp|software)\b/i;

const DEFAULT_ARGS = {
  urls: envUrls(process.env.SIMPLIFY_URLS),
  urlsFile: '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  latestCandidatesPerUrl: 15,
  limit: 0,
  timeoutMs: 60000,
  detailConcurrency: 3,
  debug: false,
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
    '--latest-candidates-per-url': 'latestCandidatesPerUrl',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
    '--detail-concurrency': 'detailConcurrency',
  };
  const numericKeys = new Set(['watchIntervalMinutes', 'latestCandidatesPerUrl', 'limit', 'timeoutMs', 'detailConcurrency']);

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
  console.log(`Simplify job scraper

Usage:
  node sites/simplify/scraper.js [options]

Options:
  --url URL                  Simplify latest-job or list URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one Simplify latest-job or list URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling Simplify and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --latest-candidates-per-url N
                              Detail pages to check per latest-jobs URL, default 15
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

function absoluteUrl(href) {
  return new URL(href, SIMPLIFY_BASE_URL).toString();
}

function slugify(value) {
  return cleanWhitespace(value)
    .replaceAll('&', 'and')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}

function dateValueToIso(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function salaryText(job) {
  if (!job.min_salary && !job.max_salary) return '';
  const currency = job.currency_type || 'USD';
  const periodByCode = {
    1: 'hr',
    2: 'day',
    3: 'mo',
    4: 'yr',
  };
  const period = periodByCode[job.salary_period] || '';
  const format = (amount) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);

  const range = [job.min_salary, job.max_salary].filter(Boolean).map(format).join(' - ');
  return period ? `${range}/${period}` : range;
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
  const uniqueUrls = [...new Set(urls.length ? urls : DEFAULT_SIMPLIFY_URLS)];
  for (const url of uniqueUrls) {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('simplify.jobs')) {
      throw new Error(`Expected a simplify.jobs URL, got: ${url}`);
    }
  }
  return uniqueUrls;
}

async function fetchHtml(url, timeoutMs) {
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
    if (error.response) throw new Error(`Simplify returned ${error.response.status} for ${url}`);
    throw error;
  }
}

function extractNextData(html, sourceUrl) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error(`Could not find Simplify job data on ${sourceUrl}`);
  return JSON.parse(match[1]);
}

function arrayValues(values, key = 'title') {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') return value[key] || value.value || value.name;
      return '';
    })
    .map(cleanWhitespace)
    .filter(Boolean);
}

function companyName(hit) {
  return cleanWhitespace(hit.company_name || hit.company?.name || hit.job?.company?.name);
}

function locationValues(hit) {
  return arrayValues(hit.locations, 'value');
}

function functionValues(hit) {
  return arrayValues(hit.functions, 'title');
}

function experienceLevels(hit) {
  if (Array.isArray(hit.experience_level)) return arrayValues(hit.experience_level);

  const levels = [];
  if (hit.entry_level) levels.push('Entry Level');
  if (hit.junior) levels.push('Junior');
  if (hit.mid_level) levels.push('Mid Level');
  if (hit.senior) levels.push('Senior');
  if (hit.expert) levels.push('Expert');
  return levels;
}

function travelText(value) {
  if (typeof value === 'string') return value;
  const labels = {
    1: 'In Person',
    2: 'Hybrid',
    3: 'Remote',
  };
  return labels[value] || '';
}

function typeText(value) {
  if (typeof value === 'string') return value;
  const labels = {
    1: 'Internship',
    2: 'Full-Time',
    3: 'Part-Time',
    4: 'Contract',
  };
  return labels[value] || '';
}

function isRemoteUsRelevant(job) {
  const text = [job.title, job.company, job.location, job.listingText].filter(Boolean).join(' ');
  const hasRemoteUs = /\bremote in usa\b|\bremote\b.*\b(united states|usa|u\.s\.)\b/i.test(text);
  return hasRemoteUs && RELEVANT_JOB_PATTERN.test(text);
}

function normalizeJob(hit, sourceUrl, scrapedAt) {
  const title = cleanWhitespace(hit.title);
  const company = companyName(hit);
  const locations = locationValues(hit);
  const functions = functionValues(hit);
  const levels = experienceLevels(hit);
  const id = hit.posting_id || hit.id;
  const url = id ? absoluteUrl(`/p/${id}/${slugify(title || 'job')}`) : '';
  const salary = salaryText(hit);
  const postedAt = dateValueToIso(hit.start_date);
  const updatedAt = dateValueToIso(hit.updated_date);
  const travel = travelText(hit.travel_requirements);
  const type = typeText(hit.type || hit.job?.type);
  const description = cleanWhitespace(
    cleanHtmlText(
      hit.description ||
        hit.job_description ||
        hit.jobDescription ||
        hit.about_role ||
        hit.requirements_summary ||
        hit.job?.description ||
        '',
    ),
  );
  const listingText = cleanWhitespace(
    [
      title,
      company,
      levels.join(', '),
      locations.join(', '),
      functions.join(', '),
      salary,
      travel,
      type,
      description,
    ]
      .filter(Boolean)
      .join(' | '),
  );

  return {
    title,
    company,
    location: locations.join(' | '),
    postedAt,
    updatedAt,
    salary,
    url,
    source: 'Simplify',
    sourceUrl,
    scrapedAt,
    description,
    listingText,
  };
}

async function scrapeSourceUrl(sourceUrl, args) {
  const scrapedAt = new Date().toISOString();
  if (isLatestJobsUrl(sourceUrl)) return scrapeLatestJobsUrl(sourceUrl, args, scrapedAt);
  return scrapeCuratedListUrl(sourceUrl, args, scrapedAt);
}

function isLatestJobsUrl(sourceUrl) {
  return new URL(sourceUrl).pathname.startsWith('/latest-jobs/');
}

function extractLatestJobUrls(data) {
  const jobs = data.props?.pageProps?.jobs || [];
  if (!Array.isArray(jobs)) return [];
  return jobs
    .map((url) => absoluteUrl(url))
    .filter((url) => LATEST_JOB_TITLE_PATTERN.test(decodeURIComponent(url)));
}

async function scrapeDetailUrl(url, sourceUrl, args, scrapedAt) {
  const html = await fetchHtml(url, args.timeoutMs);
  const data = extractNextData(html, url);
  const hit = data.props?.pageProps?.jobPosting;
  if (!hit) return null;
  return normalizeJob(hit, sourceUrl, scrapedAt);
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

async function scrapeLatestJobsUrl(sourceUrl, args, scrapedAt) {
  const html = await fetchHtml(sourceUrl, args.timeoutMs);
  const data = extractNextData(html, sourceUrl);
  const candidateLimit =
    args.limit > 0
      ? Math.min(args.latestCandidatesPerUrl, Math.max(args.limit * 4, args.limit))
      : args.latestCandidatesPerUrl;
  const candidateUrls = extractLatestJobUrls(data).slice(0, Math.max(candidateLimit, 1));

  if (args.debug) {
    console.log(`Detected ${candidateUrls.length} Simplify latest candidates on ${sourceUrl}`);
  }

  const jobs = await mapWithConcurrency(candidateUrls, 5, async (url) => {
    try {
      const job = await scrapeDetailUrl(url, sourceUrl, args, scrapedAt);
      return job && isRemoteUsRelevant(job) ? job : null;
    } catch (error) {
      console.warn(`Detail scrape skipped for ${url}: ${error.message}`);
      return null;
    }
  });

  return filterJobsPostedWithinLast24Hours(filterExcludedEngineeringRoles(jobs.filter(Boolean)));
}

async function scrapeCuratedListUrl(sourceUrl, args, scrapedAt) {
  const html = await fetchHtml(sourceUrl, args.timeoutMs);
  const data = extractNextData(html, sourceUrl);
  const hits = data.props?.pageProps?.initialJobHits || [];
  if (!Array.isArray(hits)) throw new Error(`Unexpected Simplify job data on ${sourceUrl}`);
  if (args.debug) console.log(`Detected ${hits.length} Simplify jobs on ${sourceUrl}`);
  return filterJobsPostedWithinLast24Hours(
    filterExcludedEngineeringRoles(
      hits.map((hit) => normalizeJob(hit, sourceUrl, scrapedAt)).filter((job) => job.url),
    ),
  );
}

async function scrapeSimplifyJobs(args) {
  const sourceUrls = await resolveSourceUrls(args);
  const allJobs = [];
  const seenUrls = new Set();
  for (const sourceUrl of sourceUrls) {
    for (const job of await scrapeSourceUrl(sourceUrl, args)) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      allJobs.push(job);
      if (args.limit > 0 && allJobs.length >= args.limit) return allJobs;
    }
  }
  const limitedJobs = args.limit > 0 ? allJobs.slice(0, args.limit) : allJobs;
  return enrichJobDescriptions(limitedJobs, {
    timeoutMs: args.timeoutMs,
    concurrency: args.detailConcurrency,
    sourceName: 'Simplify',
  });
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
  const source = slackEscape(job.source || 'Simplify');
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
  const text = `Found ${jobs.length} new Simplify ${plural}`;
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
  const jobs = await scrapeSimplifyJobs(args);

  console.log(`Found ${jobs.length} Simplify jobs posted within the last 24 hours.`);
  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} Simplify jobs to PostgreSQL.`);

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
      console.log('\nStopping Simplify watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching Simplify every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking Simplify for new jobs...`);

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
