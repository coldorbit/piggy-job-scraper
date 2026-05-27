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

const REMOTEYEAH_BASE_URL = 'https://remoteyeah.com';
const DEFAULT_REMOTEYEAH_URLS = ['https://remoteyeah.com/rss.xml'];
const DEFAULT_MARKDOWN_PROXY_URL = 'https://r.jina.ai/http://r.jina.ai/http://{rawUrl}';
const execFileAsync = promisify(execFile);
const OUTPUT_FIELDS = [
  'title',
  'company',
  'location',
  'category',
  'tags',
  'postedAt',
  'image',
  'url',
  'source',
  'sourceUrl',
  'scrapedAt',
  'description',
  'listingText',
];

const DEFAULT_ARGS = {
  urls: envUrls(process.env.REMOTEYEAH_URLS),
  urlsFile: '',
  outputJson: 'results/remoteyeah/jobs.json',
  outputCsv: 'results/remoteyeah/jobs.csv',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  limit: 0,
  timeoutMs: 60000,
  directTimeoutMs: 10000,
  detailConcurrency: 3,
  fetchProxyUrl: process.env.REMOTEYEAH_FETCH_PROXY_URL || '',
  markdownProxyUrl: process.env.REMOTEYEAH_MARKDOWN_PROXY_URL ?? DEFAULT_MARKDOWN_PROXY_URL,
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
    '--output-json': 'outputJson',
    '--output-csv': 'outputCsv',
    '--slack-webhook-url': 'slackWebhookUrl',
    '--slack-channel': 'slackChannel',
    '--watch-interval-minutes': 'watchIntervalMinutes',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
    '--direct-timeout-ms': 'directTimeoutMs',
    '--detail-concurrency': 'detailConcurrency',
    '--fetch-proxy-url': 'fetchProxyUrl',
    '--markdown-proxy-url': 'markdownProxyUrl',
  };
  const numericKeys = new Set(['watchIntervalMinutes', 'limit', 'timeoutMs', 'directTimeoutMs', 'detailConcurrency']);

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
  console.log(`RemoteYeah scraper

Usage:
  node sites/remoteyeah/scraper.js [options]

Options:
  --url URL                  RemoteYeah RSS URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one RemoteYeah RSS URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling RemoteYeah and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --limit N                  Maximum jobs to save, 0 means no limit
  --timeout-ms N             Fetch timeout, default 60000
  --direct-timeout-ms N      Direct RemoteYeah timeout before proxy fallback, default 10000
  --detail-concurrency N     Detail page concurrency, default 3
  --fetch-proxy-url URL      Optional raw proxy URL template; use {url} for an encoded feed URL
  --markdown-proxy-url URL   Markdown proxy URL template, default ${DEFAULT_MARKDOWN_PROXY_URL}
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

async function resolveSourceUrls(args) {
  const urls = [...args.urls, ...(await readUrlFile(args.urlsFile))];
  const uniqueUrls = [...new Set(urls.length ? urls : DEFAULT_REMOTEYEAH_URLS)];
  for (const url of uniqueUrls) {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('remoteyeah.com')) {
      throw new Error(`Expected a remoteyeah.com URL, got: ${url}`);
    }
  }
  return uniqueUrls;
}

async function fetchXml(url, args) {
  const directTimeoutMs = Math.min(args.directTimeoutMs, args.timeoutMs);
  try {
    return await fetchXmlDirect(url, directTimeoutMs);
  } catch (error) {
    console.warn(`direct fetch failed for ${url}: ${error.message}`);
  }

  const proxiedUrl = buildProxyUrl(args.fetchProxyUrl, url);
  if (proxiedUrl) {
    try {
      return await fetchXmlDirect(proxiedUrl, args.timeoutMs, url);
    } catch (error) {
      console.warn(`proxy fetch failed for ${url}: ${error.message}`);
    }
  }

  const markdownProxyUrl = buildProxyUrl(args.markdownProxyUrl, url);
  if (markdownProxyUrl) {
    try {
      const markdown = await fetchXmlDirect(markdownProxyUrl, args.timeoutMs, url);
      return rssXmlFromMarkdown(markdown, url);
    } catch (error) {
      console.warn(`markdown proxy fetch failed for ${url}: ${error.message}`);
    }
  }

  return fetchXmlWithNode(url, args.timeoutMs);
}

async function fetchXmlDirect(url, timeoutMs, sourceUrl = url) {
  try {
    return await fetchXmlWithCurl(url, timeoutMs);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return fetchXmlWithNode(url, timeoutMs, sourceUrl);
}

async function fetchXmlWithNode(url, timeoutMs, sourceUrl = url) {
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
          accept: 'application/rss+xml,application/xml,text/xml,text/html',
        },
      });
      return response.data;
    } catch (error) {
      lastError = error.response ? new Error(`RemoteYeah returned ${error.response.status} for ${sourceUrl}`) : error;
      if (attempt < 3) await sleep(750 * attempt);
    }
  }

  throw lastError;
}

function buildProxyUrl(template, url) {
  const value = String(template || '').trim();
  if (!value || value.toLowerCase() === 'none') return '';
  const encodedUrl = encodeURIComponent(url);
  if (value.includes('{url}')) return value.replaceAll('{url}', encodedUrl);
  if (value.includes('{rawUrl}')) return value.replaceAll('{rawUrl}', url);
  return `${value}${encodedUrl}`;
}

function rssXmlFromMarkdown(markdown, sourceUrl) {
  const itemPattern =
    /### \[([^\]]+)\]\((https:\/\/remoteyeah\.com\/jobs\/[^)]+)\)[\s\S]*?\n(\d{4}-\d{2}-\d{2}T[^\n]+)/g;
  const items = [];

  for (const match of markdown.matchAll(itemPattern)) {
    const title = cleanWhitespace(match[1]);
    const url = cleanJobUrl(match[2]);
    const postedAt = dateTextToIso(match[3]);
    const company = companyFromTitle(title);
    const category = categoryFromTitle(title, company);
    items.push(`<item>
<title>${escapeXml(title)}</title>
<company>${escapeXml(company)}</company>
<description><![CDATA[]]></description>
<category>${escapeXml(category)}</category>
<tags>${escapeXml([category, company].filter(Boolean).join(', '))}</tags>
<location>Remote</location>
<pubDate>${escapeXml(postedAt)}</pubDate>
<link>${escapeXml(url)}</link>
</item>`);
  }

  if (!items.length) throw new Error('Markdown proxy did not contain RemoteYeah jobs');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>RemoteYeah fallback feed</title>
<link>${escapeXml(sourceUrl)}</link>
${items.join('\n')}
</channel>
</rss>`;
}

function companyFromTitle(title) {
  return cleanWhitespace(title.match(/\bat\s+(.+)$/i)?.[1] || '');
}

function categoryFromTitle(title, company) {
  const withoutRemotePrefix = title.replace(/^remote\s+/i, '');
  if (!company) return cleanWhitespace(withoutRemotePrefix);
  return cleanWhitespace(withoutRemotePrefix.replace(new RegExp(`\\s+at\\s+${escapeRegExp(company)}$`, 'i'), ''));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function fetchXmlWithCurl(url, timeoutMs) {
  const timeoutSeconds = String(Math.max(Math.ceil(timeoutMs / 1000), 1));
  try {
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
        'accept: application/rss+xml,application/xml,text/xml,text/html',
        url,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (error) {
    if (looksLikeCompleteRss(error.stdout)) return error.stdout;
    throw error;
  }
}

function looksLikeCompleteRss(value) {
  const text = String(value || '').trim();
  return /<rss(?:\s|>)/i.test(text.slice(0, 500)) && /<\/rss>$/i.test(text);
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

    const company = matchXmlText(item, 'company');
    const category = matchXmlText(item, 'category');
    const tags = splitTags(matchXmlText(item, 'tags'));
    const location = matchXmlText(item, 'location') || 'Remote';
    const postedAt = dateTextToIso(matchXmlText(item, 'pubDate'));
    const image = matchXmlText(item, 'image');
    const description = decodeHtml(stripCdata(matchXmlRaw(item, 'description')));
    const listingText = cleanWhitespace(
      [title, company, location, category, tags.join(', '), cleanHtmlText(description)]
        .filter(Boolean)
        .join(' '),
    );

    jobs.push({
      title,
      company,
      location,
      category,
      tags,
      postedAt,
      image,
      url,
      source: 'RemoteYeah',
      sourceUrl,
      scrapedAt,
      description: cleanHtmlText(description),
      listingText,
    });
  }

  if (debug) console.log(`Detected ${jobs.length} RemoteYeah RSS items on ${sourceUrl}`);
  return jobs;
}

function splitTags(value) {
  return cleanWhitespace(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function matchXmlText(block, tagName) {
  return cleanHtmlText(stripCdata(matchXmlRaw(block, tagName)));
}

function matchXmlRaw(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1] : '';
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[|\]\]>$/g, '');
}

function cleanJobUrl(value) {
  const url = new URL(decodeHtml(value), REMOTEYEAH_BASE_URL);
  url.search = '';
  return url.toString();
}

function dateTextToIso(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

async function scrapeRemoteYeah(args) {
  const sourceUrls = await resolveSourceUrls(args);
  const allJobs = [];
  const seenUrls = new Set();

  for (const sourceUrl of sourceUrls) {
    const xml = await fetchXml(sourceUrl, args);
    const jobs = filterJobsPostedWithinLast24Hours(
      filterExcludedEngineeringRoles(collectJobsFromRss(xml, sourceUrl, args.debug)),
    );
    for (const job of jobs) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      allJobs.push(job);
      if (args.limit > 0 && allJobs.length >= args.limit) return allJobs;
    }
  }

  return enrichJobDescriptions(allJobs, {
    timeoutMs: args.timeoutMs,
    concurrency: args.detailConcurrency,
    sourceName: 'RemoteYeah',
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
  const source = slackEscape(job.source || 'RemoteYeah');
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
  const text = `Found ${jobs.length} new RemoteYeah ${plural}`;
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
  const jobs = await scrapeRemoteYeah(args);

  console.log(`Found ${jobs.length} RemoteYeah jobs posted within the last 24 hours.`);
  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} RemoteYeah jobs to PostgreSQL.`);

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
      console.log('\nStopping RemoteYeah watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching RemoteYeah every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking RemoteYeah for new jobs...`);

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
