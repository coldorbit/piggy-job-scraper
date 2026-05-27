import 'dotenv/config';
import axios from 'axios';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { filterJobsPostedWithinLast24Hours } from '../lib/recency.js';
import { filterExcludedEngineeringRoles } from '../lib/jobFilters.js';
import { enrichJobDescriptions } from '../lib/descriptions.js';

const DIVERSITYJOBS_BASE_URL = 'https://diversityjobs.com';
const execFileAsync = promisify(execFile);
const DEFAULT_DIVERSITYJOBS_QUERIES = [
  'software engineer',
  'data engineer',
  'software developer',
  'machine learning engineer',
  'ml engineer',
  'ai engineer',
  'artificial intelligence engineer',
  'full stack developer',
  'full stack engineer',
  'backend developer',
  'backend engineer',
  'frontend developer',
  'frontend engineer',
  'data scientist',
];
const DEFAULT_LOCATION = 'Remote';
const OUTPUT_FIELDS = [
  'title',
  'company',
  'location',
  'employmentType',
  'category',
  'url',
  'source',
  'sourceUrl',
  'scrapedAt',
  'description',
  'listingText',
];

const DEFAULT_ARGS = {
  queries: envQueries(process.env.DIVERSITYJOBS_QUERIES || process.env.DIVERSITYJOBS_QUERY),
  location: process.env.DIVERSITYJOBS_LOCATION || DEFAULT_LOCATION,
  remoteFriendly: true,
  urls: envUrls(process.env.DIVERSITYJOBS_URLS),
  urlsFile: '',
  outputJson: 'results/diversityjobs/jobs.json',
  outputCsv: 'results/diversityjobs/jobs.csv',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  maxPages: 2,
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

function envQueries(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((query) => query.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    ...DEFAULT_ARGS,
    queries: [...DEFAULT_ARGS.queries],
    urls: [...DEFAULT_ARGS.urls],
  };
  const aliases = {
    '--location': 'location',
    '--urls-file': 'urlsFile',
    '--output-json': 'outputJson',
    '--output-csv': 'outputCsv',
    '--slack-webhook-url': 'slackWebhookUrl',
    '--slack-channel': 'slackChannel',
    '--watch-interval-minutes': 'watchIntervalMinutes',
    '--max-pages': 'maxPages',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
    '--detail-concurrency': 'detailConcurrency',
  };
  const numericKeys = new Set(['watchIntervalMinutes', 'maxPages', 'limit', 'timeoutMs', 'detailConcurrency']);

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
    if (token === '--query') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --query');
      args.queries.push(value);
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
    if (token === '--no-remote-friendly') {
      args.remoteFriendly = false;
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
  console.log(`DiversityJobs scraper

Usage:
  node sites/diversityjobs/scraper.js [options]

Options:
  --query TEXT               Search keywords; repeat for multiple queries
                             Defaults: ${DEFAULT_DIVERSITYJOBS_QUERIES.join(', ')}
  --location TEXT            Search location, default "${DEFAULT_LOCATION}"
  --url URL                  DiversityJobs search URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one DiversityJobs URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling DiversityJobs and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --max-pages N              Pages to scrape per search URL, default 2
  --limit N                  Maximum jobs to save, 0 means no limit
  --timeout-ms N             Fetch timeout, default 60000
  --detail-concurrency N     Detail page concurrency, default 3
  --no-remote-friendly       Do not add remote_friendly=true to generated search URLs
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

function absoluteUrl(href) {
  return new URL(href, DIVERSITYJOBS_BASE_URL).toString();
}

async function readUrlFile(path) {
  if (!path) return [];
  const raw = await fs.readFile(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function buildSearchUrl(args, query) {
  const url = new URL('/candidate/job_search/quick/results', DIVERSITYJOBS_BASE_URL);
  url.searchParams.set('keywords', query);
  if (args.location) url.searchParams.set('location', args.location);
  if (args.remoteFriendly) url.searchParams.set('remote_friendly', 'true');
  url.searchParams.set('sort_field', 'post_date');
  url.searchParams.set('sort_dir', 'desc');
  url.searchParams.set('rss', 'true');
  return url.toString();
}

function queryTokens(query) {
  return cleanWhitespace(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function matchesQuery(job, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;

  const text = [job.title, job.company, job.location, job.employmentType, job.category, job.listingText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return tokens.every((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(text));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveSourceUrls(args) {
  const urls = [...args.urls, ...(await readUrlFile(args.urlsFile))];
  const queries = args.queries.length ? args.queries : DEFAULT_DIVERSITYJOBS_QUERIES;
  const generatedUrls = queries.map((query) => buildSearchUrl(args, query));
  const uniqueUrls = [...new Set(urls.length ? urls : generatedUrls)];
  for (const url of uniqueUrls) {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('diversityjobs.com')) {
      throw new Error(`Expected a diversityjobs.com URL, got: ${url}`);
    }
  }
  return uniqueUrls;
}

function pageUrl(sourceUrl, pageNumber) {
  if (pageNumber <= 1) return sourceUrl;
  const url = new URL(sourceUrl);
  if (url.searchParams.get('rss') === 'true') return sourceUrl;
  url.pathname = url.pathname.replace(/\/\d+$/, '');
  url.pathname = `${url.pathname}/${pageNumber - 1}`;
  return url.toString();
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
      lastError = error.response ? new Error(`DiversityJobs returned ${error.response.status} for ${url}`) : error;
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

function matchText(block, pattern) {
  const match = block.match(pattern);
  return match ? cleanHtmlText(match[1]) : '';
}

function collectJobsFromMarkup(markup, sourceUrl, debug = false) {
  if (/<rss[\s>]/i.test(markup.slice(0, 500))) {
    return collectJobsFromRss(markup, sourceUrl, debug);
  }
  return collectJobsFromHtml(markup, sourceUrl, debug);
}

function collectJobsFromRss(xml, sourceUrl, debug = false) {
  const scrapedAt = new Date().toISOString();
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const jobs = [];
  const seenUrls = new Set();

  for (const item of items) {
    const title = matchXmlText(item, 'title');
    const rawUrl = matchXmlText(item, 'link');
    if (!title || !rawUrl) continue;

    const url = cleanJobUrl(rawUrl);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const description = decodeHtml(stripCdata(matchXmlRaw(item, 'description')));
    const category = matchXmlText(item, 'category');
    const postedAt = dateTextToIso(matchXmlText(item, 'pubDate') || matchXmlText(item, 'dc:date'));
    const descriptionLines = description
      .split(/\r?\n|<br\s*\/?>/i)
      .map(cleanHtmlText)
      .filter(Boolean);
    const company = cleanWhitespace(descriptionLines[0] || '').replace(/\.$/, '');
    const location = descriptionLines.length > 1 ? descriptionLines[1] : '';
    const listingText = cleanWhitespace(
      [title, company, location, category, cleanHtmlText(description)].join(' '),
    );

    jobs.push({
      title,
      company,
      location: location || 'Remote',
      employmentType: '',
      category,
      postedAt,
      url,
      source: 'DiversityJobs',
      sourceUrl,
      scrapedAt,
      description: cleanHtmlText(description),
      listingText,
    });
  }

  if (debug) console.log(`Detected ${jobs.length} DiversityJobs RSS items on ${sourceUrl}`);
  return jobs;
}

function matchXmlText(block, tagName) {
  return cleanHtmlText(stripCdata(matchXmlRaw(block, tagName)));
}

function matchXmlRaw(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1] : '';
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[|\]\]>$/g, '');
}

function cleanJobUrl(value) {
  const url = new URL(decodeHtml(value), DIVERSITYJOBS_BASE_URL);
  url.search = '';
  return url.toString();
}

function dateTextToIso(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function collectJobsFromHtml(html, sourceUrl, debug = false) {
  const scrapedAt = new Date().toISOString();
  const chunks = html.split(/<div[^>]+id=["']s-res["'][^>]*data-dest=["']/i).slice(1);
  const jobs = [];
  const seenUrls = new Set();

  for (const chunk of chunks) {
    const destinationMatch = chunk.match(/^([^"']+)/);
    if (!destinationMatch) continue;

    const url = absoluteUrl(destinationMatch[1]);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const title = matchText(chunk, /<p[^>]+class=["']job-title["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const company = matchText(
      chunk,
      /<p[^>]+class=["']companyName["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    );
    const location = matchText(chunk, /<p[^>]+class=["']location["'][^>]*>([\s\S]*?)<\/p>/i);
    const employmentType = matchText(
      chunk,
      /<td>\s*(Full Time|Part Time|Contract|Temporary|Internship)\s*<\/td>/i,
    );
    const listingText = cleanHtmlText(chunk);
    if (!title || !url.includes('/career/')) continue;

    jobs.push({
      title,
      company,
      location: location || 'Remote',
      employmentType,
      category: '',
      url,
      source: 'DiversityJobs',
      sourceUrl,
      scrapedAt,
      description: '',
      listingText,
    });
  }

  if (debug) console.log(`Detected ${jobs.length} DiversityJobs cards on ${sourceUrl}`);
  return jobs;
}

async function scrapeSourceUrl(sourceUrl, args) {
  const jobs = [];
  const seenUrls = new Set();
  const maxPages = new URL(sourceUrl).searchParams.get('rss') === 'true' ? 1 : Math.max(args.maxPages, 1);

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const currentUrl = pageUrl(sourceUrl, pageNumber);
    const html = await fetchHtml(currentUrl, args.timeoutMs);
    const rawPageJobs = collectJobsFromMarkup(html, currentUrl, args.debug);
    const shouldFilterQuery = !args.urls.length && !args.urlsFile;
    const query = new URL(sourceUrl).searchParams.get('keywords') || '';
    const pageJobs = shouldFilterQuery
      ? rawPageJobs.filter((job) => matchesQuery(job, query))
      : rawPageJobs;
    const recentPageJobs = filterJobsPostedWithinLast24Hours(filterExcludedEngineeringRoles(pageJobs));
    if (!rawPageJobs.length && pageNumber > 1) break;

    for (const job of recentPageJobs) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      jobs.push(job);
      if (args.limit > 0 && jobs.length >= args.limit) return jobs;
    }
  }

  return jobs;
}

async function scrapeDiversityJobs(args) {
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

  return enrichJobDescriptions(allJobs, {
    timeoutMs: args.timeoutMs,
    concurrency: args.detailConcurrency,
    sourceName: 'DiversityJobs',
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
  const source = slackEscape(job.source || 'DiversityJobs');
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
  const text = `Found ${jobs.length} new DiversityJobs ${plural}`;
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
  const jobs = await scrapeDiversityJobs(args);

  console.log(`Found ${jobs.length} DiversityJobs jobs posted within the last 24 hours.`);
  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} DiversityJobs jobs to PostgreSQL.`);

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
      console.log('\nStopping DiversityJobs watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching DiversityJobs every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking DiversityJobs for new jobs...`);

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
