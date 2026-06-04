import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import pg from 'pg';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { isExcludedEngineeringRole, isEnglishOnlyJob } from '../lib/jobFilters.js';
import { isWithinLast24Hours } from '../lib/recency.js';
import { proxyRotatorFromEnv } from '../lib/playwrightProxy.js';

const LINKEDIN_BASE_URL = 'https://www.linkedin.com';
const DEFAULT_LINKEDIN_SEARCHES = [
  'software engineer',
  'data engineer',
  'full stack engineer',
  'backend engineer',
  'frontend engineer',
  'data scientist',
];
const DISALLOWED_WORKPLACE_PATTERN =
  /\b(?:hybrid|on[\s-]?site|in[\s-]?office|office[\s-]?based|work\s+from\s+(?:the\s+)?office)\b/i;
const DISALLOWED_WORKPLACE_SQL_PATTERN =
  '(hybrid|on[[:space:]-]?site|in[[:space:]-]?office|office[[:space:]-]?based|work[[:space:]]+from[[:space:]]+(the[[:space:]]+)?office)';
const LINKEDIN_CLOSED_APPLICATION_PATTERN = /\bno\s+longer\s+accepting\s+applications\b/i;
const LINKEDIN_HOSTED_APPLY_MODES = new Set(['LinkedIn Apply', 'Easy Apply']);
const LINKEDIN_TOP_CARD_APPLY_BUTTON_XPATH = '//*[@id="main-content"]/section[1]/div/section[2]/div/div[1]/div/div/button';
const LINKEDIN_EASY_APPLY_BUTTON_XPATH =
  `${LINKEDIN_TOP_CARD_APPLY_BUTTON_XPATH}[starts-with(@data-tracking-control-name, "public_jobs_apply-link") and contains(@data-tracking-control-name, "_onsite")]`;
const LINKEDIN_EXTERNAL_APPLY_BUTTON_XPATH = `${LINKEDIN_TOP_CARD_APPLY_BUTTON_XPATH}[@data-modal]`;
const LINKEDIN_APPLY_BUTTON_XPATH = `${LINKEDIN_EASY_APPLY_BUTTON_XPATH} | ${LINKEDIN_EXTERNAL_APPLY_BUTTON_XPATH}`;
const LINKEDIN_APPLY_CLASSIFICATION_SETTLE_MS = 5000;
const LINKEDIN_APPLY_CLASSIFICATION_TIMEOUT_MS = 20000;
const LINKEDIN_MODAL_SELECTOR = [
  '[role="dialog"]',
  '.artdeco-modal',
  '.contextual-sign-in-modal',
  '.modal',
].join(', ');
const LINKEDIN_MODAL_CLOSE_SELECTOR = [
  'button[aria-label*="Dismiss" i]',
  'button[aria-label*="Close" i]',
  '.artdeco-modal__dismiss',
  '.contextual-sign-in-modal__modal-dismiss',
  '.modal__dismiss',
  'button[data-tracking-control-name*="dismiss" i]',
].join(', ');
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const DEFAULT_ARGS = {
  searches: envList(process.env.LINKEDIN_SEARCHES || process.env.LINKEDIN_SEARCH),
  urls: envList(process.env.LINKEDIN_URLS),
  urlsFile: '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 5,
  maxPages: 2,
  detailConcurrency: 1,
  limit: 0,
  timeoutMs: 60000,
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
    '--max-pages': 'maxPages',
    '--detail-concurrency': 'detailConcurrency',
    '--limit': 'limit',
    '--timeout-ms': 'timeoutMs',
  };
  const numericKeys = new Set(['watchIntervalMinutes', 'maxPages', 'detailConcurrency', 'limit', 'timeoutMs']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    if (token === '--search') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --search');
      args.searches.push(value);
      index += 1;
      continue;
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
  console.log(`LinkedIn scraper

Usage:
  node sites/linkedin/scraper.js [options]

Options:
  --search TEXT              LinkedIn search text; repeat for multiple searches
  --url URL                  LinkedIn search URL to scrape; repeat for multiple URLs
  --urls-file PATH           Text file with one LinkedIn search URL per line
  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL
  --slack-channel NAME       Optional channel override for compatible webhooks
  --watch                    Keep polling LinkedIn and posting newly inserted jobs
  --watch-interval-minutes N Minutes between watch runs, default 5
  --max-pages N              Search pages per search, default 2
  --detail-concurrency N     Detail page concurrency, default 3
  --limit N                  Maximum jobs to save, 0 means no limit
  --timeout-ms N             Playwright timeout, default 60000
  --headless / --no-headless Browser visibility, default headless
  --no-slack                 Disable Slack posting for this run
  --debug                    Print collection diagnostics
`);
}

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanHtmlText(value) {
  return cleanWhitespace(
    decodeHtml(
      String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|li|div|h\d)>/gi, '\n')
        .replace(/<[^>]*>/g, ' '),
    ),
  );
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

async function resolveSearchSources(args) {
  const urls = [...args.urls, ...(await readUrlFile(args.urlsFile))];
  const searches = args.searches.length ? args.searches : DEFAULT_LINKEDIN_SEARCHES;

  const sourceUrls = urls.length ? urls : searches.map((search) => searchUrl(search));
  const sources = [];
  const seen = new Set();
  for (const sourceUrl of sourceUrls) {
    const parsed = new URL(sourceUrl);
    if (!parsed.hostname.endsWith('linkedin.com')) {
      throw new Error(`Expected a linkedin.com URL, got: ${sourceUrl}`);
    }
    const search = cleanWhitespace(parsed.searchParams.get('keywords') || '');
    if (!search) {
      throw new Error(`LinkedIn scraping requires a search URL with a keywords parameter: ${sourceUrl}`);
    }
    if (seen.has(search.toLowerCase())) continue;
    seen.add(search.toLowerCase());
    sources.push({ search, sourceUrl });
  }
  return sources;
}

function pageUrlForSource(sourceUrl, start) {
  const url = new URL(sourceUrl);
  url.searchParams.set('start', String(start));
  url.searchParams.set('f_WT', '2');
  url.searchParams.set('f_TPR', 'r86400');
  return url.toString();
}

async function collectJobCards(page, source, args) {
  const jobs = [];
  const seenLinkedInUrls = new Set();
  const pageCount = Math.max(args.maxPages, 1);

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const url = pageUrlForSource(source.sourceUrl, pageIndex * 25);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
    const pageJobs = await page.evaluate(
      ({ sourceUrl, scrapedAt }) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const rows = [];
        for (const card of document.querySelectorAll('div.base-search-card, li')) {
          const link = card.querySelector('a.base-card__full-link[href], a[href*="/jobs/view/"]');
          const rawUrl = link?.getAttribute('href') || '';
          if (!rawUrl) continue;
          const url = new URL(rawUrl, 'https://www.linkedin.com');
          url.search = '';
          const jobId = url.pathname.match(/(\d+)\/?$/)?.[1] || '';
          if (!url.pathname.includes('/jobs/view/') || !jobId) continue;
          const linkedinUrl = `https://www.linkedin.com/jobs/view/${jobId}`;

          const title =
            clean(card.querySelector('span.sr-only')?.textContent) ||
            clean(card.querySelector('.base-search-card__title')?.textContent) ||
            clean(card.querySelector('h3')?.textContent);
          const company =
            clean(card.querySelector('.base-search-card__subtitle a')?.textContent) ||
            clean(card.querySelector('.base-search-card__subtitle')?.textContent) ||
            clean(card.querySelector('h4')?.textContent);
          const location = clean(card.querySelector('.job-search-card__location')?.textContent) || 'Remote';
          const time = card.querySelector('time');
          const postedAt = time?.getAttribute('datetime') || scrapedAt;
          const postedText = clean(time?.textContent);
          const listingText = clean([title, company, location, postedText, clean(card.textContent)].join(' '));

          if (title) {
            rows.push({
              title,
              company,
              location,
              postedAt,
              postedText,
              linkedinUrl,
              sourceUrl,
              scrapedAt,
              listingText,
            });
          }
        }
        return rows;
      },
      { sourceUrl: source.sourceUrl, scrapedAt: new Date().toISOString() },
    );

    if (args.debug) console.log(`LinkedIn search ${source.search} page ${pageIndex + 1} returned ${pageJobs.length} card(s).`);
    if (!pageJobs.length) break;
    for (const job of pageJobs) {
      if (seenLinkedInUrls.has(job.linkedinUrl)) continue;
      seenLinkedInUrls.add(job.linkedinUrl);
      jobs.push(job);
    }
  }

  return jobs;
}

async function newLinkedInContext(browser, proxyRotator) {
  const proxy = proxyRotator.next();
  return browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent: DEFAULT_USER_AGENT,
    ...(proxy ? { proxy } : {}),
  });
}

async function enrichJobDetail(browser, proxyRotator, job, args) {
  const context = await newLinkedInContext(browser, proxyRotator);
  const page = await context.newPage();
  try {
    let details;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.goto(job.linkedinUrl, { waitUntil: 'commit', timeout: args.timeoutMs });
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(args.timeoutMs, 10000) }).catch(() => {});
      await page.waitForTimeout(750 * attempt);
      await closeLinkedInModalIfOpen(page);
      await waitForApplyButton(page, args.timeoutMs);

      details = await waitForApplyClassification(page, args.timeoutMs);

      if (details.applyMode || attempt === 3) break;
    }
    const directUrl = externalDirectJobUrl(details.rawApplyUrl);
    const applyButtonDirectUrl = externalDirectJobUrl(details.applyButtonHref);
    const applyMode = details.applyMode;
    const applyOnExternalSite = applyMode === 'External Apply';
    const description = cleanHtmlText(details.description);
    return {
      ...job,
      title: details.title || job.title,
      company: details.company || job.company,
      location: details.location || job.location,
      description,
      url: applyOnExternalSite ? directUrl || applyButtonDirectUrl || job.linkedinUrl : job.linkedinUrl,
      source: 'LinkedIn',
      applyMode,
      applyOnExternalSite,
      applyButtonText: details.applyButtonText || job.applyButtonText,
      applyButtonHasExternalIcon: details.applyButtonHasExternalIcon || job.applyButtonHasExternalIcon,
      listingText: cleanWhitespace([job.listingText, description].filter(Boolean).join(' ')),
    };
  } catch (error) {
    console.warn(`LinkedIn detail scrape skipped for ${job.linkedinUrl}: ${error.message}`);
    return {
      ...job,
      description: '',
      url: job.linkedinUrl,
      source: 'LinkedIn',
      applyMode: '',
      applyOnExternalSite: false,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

const TRANSIENT_EVALUATE_ERROR_PATTERN =
  /Execution context was destroyed|Cannot find context|most likely because of a navigation|Frame was detached/i;

async function closeLinkedInModalIfOpen(page) {
  const modal = page.locator(LINKEDIN_MODAL_SELECTOR).filter({ visible: true }).first();
  if (!(await modal.count().catch(() => 0))) return false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const closeButton = page.locator(LINKEDIN_MODAL_CLOSE_SELECTOR).filter({ visible: true }).first();
    if (await closeButton.count().catch(() => 0)) {
      await closeButton.click({ timeout: 2000 }).catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }

    await page.waitForTimeout(300);
    const stillOpen = await page.locator(LINKEDIN_MODAL_SELECTOR).filter({ visible: true }).count().catch(() => 0);
    if (!stillOpen) return true;
  }

  return false;
}

async function evaluateWithRetry(page, pageFunction, pageArg, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.evaluate(pageFunction, pageArg);
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_EVALUATE_ERROR_PATTERN.test(error.message) || attempt === attempts) break;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(750 * attempt);
    }
  }
  throw lastError;
}

function classifyApplyDetails(details) {
  const directUrl = externalDirectJobUrl(details.rawApplyUrl) || externalDirectJobUrl(details.applyButtonHref);
  if (directUrl || details.externalApplyButton || details.applyButtonHasExternalIcon || details.applyButtonLooksExternal) {
    return 'External Apply';
  }
  if (details.easyApplyButton || details.applyButtonLooksEasy) return 'Easy Apply';
  return '';
}

async function readApplyDetails(page) {
  return evaluateWithRetry(
    page,
    ({ applyButtonXPath, easyApplyButtonXPath, externalApplyButtonXPath }) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const xpathNode = (xpath) => {
        return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      };
      const applyButton = xpathNode(applyButtonXPath);
      const easyApplyButton = xpathNode(easyApplyButtonXPath);
      const externalApplyButton = xpathNode(externalApplyButtonXPath);
      const applyButtonText = clean([applyButton?.textContent, applyButton?.getAttribute('aria-label')].filter(Boolean).join(' '));
      const applyButtonTracking = clean(applyButton?.getAttribute('data-tracking-control-name'));
      const descriptionNode = document.querySelector('div.show-more-less-html__markup');
      const applyUrlCode = document.querySelector('code#applyUrl');
      const applyUrlContent = applyUrlCode?.textContent || '';
      const applyMatch = applyUrlContent.match(/\?url=([^"]+)/);
      const iconText = clean(
        Array.from(applyButton?.querySelectorAll('svg, use, li-icon') || [])
          .map((node) =>
            [
              node.getAttribute('type'),
              node.getAttribute('data-test-icon'),
              node.getAttribute('aria-label'),
              node.getAttribute('href'),
              node.getAttribute('xlink:href'),
              node.outerHTML,
            ]
              .filter(Boolean)
              .join(' '),
          )
          .join(' '),
      );
      const buttonSignalText = clean([applyButtonText, applyButtonTracking, iconText].join(' '));
      const applyButtonHasExternalIcon = /\b(?:external|offsite|link-out|arrow|open_in_new)\b/i.test(iconText);
      const applyButtonLooksExternal =
        /\b(?:external|offsite|company\s+(?:site|website)|apply\s+on|apply\s+at|opens?\s+in\s+(?:a\s+)?new)\b/i.test(buttonSignalText) ||
        /_offsite\b/i.test(applyButtonTracking);
      const applyButtonLooksEasy = /\beasy\s+apply\b/i.test(buttonSignalText) || /_onsite\b/i.test(applyButtonTracking);
      const applyMode = '';
      return {
        description: clean(descriptionNode?.innerText || ''),
        rawApplyUrl: applyMatch ? decodeURIComponent(applyMatch[1]) : '',
        applyButtonText,
        applyButtonHref: applyButton?.href || applyButton?.getAttribute('href') || '',
        applyButtonHasExternalIcon,
        applyButtonLooksExternal,
        applyButtonLooksEasy,
        easyApplyButton: Boolean(easyApplyButton),
        externalApplyButton: Boolean(externalApplyButton),
        applyMode,
        title: clean(document.querySelector('h1')?.textContent),
        company: clean(document.querySelector('.topcard__org-name-link, .topcard__flavor')?.textContent),
        location: clean(document.querySelector('.topcard__flavor--bullet')?.textContent),
      };
    },
    {
      applyButtonXPath: LINKEDIN_APPLY_BUTTON_XPATH,
      easyApplyButtonXPath: LINKEDIN_EASY_APPLY_BUTTON_XPATH,
      externalApplyButtonXPath: LINKEDIN_EXTERNAL_APPLY_BUTTON_XPATH,
    },
  );
}

async function waitForApplyClassification(page, timeoutMs) {
  const startedAt = Date.now();
  const timeout = Math.min(timeoutMs, LINKEDIN_APPLY_CLASSIFICATION_TIMEOUT_MS);
  await closeLinkedInModalIfOpen(page);
  let latestDetails = await readApplyDetails(page);
  latestDetails.applyMode = classifyApplyDetails(latestDetails);

  while (Date.now() - startedAt < timeout) {
    if (latestDetails.applyMode === 'External Apply') return latestDetails;
    if (
      latestDetails.applyMode === 'Easy Apply' &&
      Date.now() - startedAt >= LINKEDIN_APPLY_CLASSIFICATION_SETTLE_MS
    ) {
      return latestDetails;
    }

    await page.waitForTimeout(750);
    await closeLinkedInModalIfOpen(page);
    latestDetails = await readApplyDetails(page);
    latestDetails.applyMode = classifyApplyDetails(latestDetails);
  }

  return latestDetails;
}

async function waitForApplyButton(page, timeoutMs) {
  await page
    .waitForFunction(
      (applyButtonXPath) =>
        Boolean(
          document.evaluate(
            applyButtonXPath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
          ).singleNodeValue,
        ),
      LINKEDIN_APPLY_BUTTON_XPATH,
      { timeout: Math.min(timeoutMs, 15000) },
    )
    .catch(() => {});
}

function externalDirectJobUrl(value) {
  const text = cleanWhitespace(value);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizePostedAt(value, fallback) {
  const text = cleanWhitespace(value);
  if (!text || /^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function isClosedLinkedInListing(job) {
  return LINKEDIN_CLOSED_APPLICATION_PATTERN.test(cleanWhitespace([job.listingText, job.description].join(' ')));
}

function isLinkedInHostedApplication(job) {
  return LINKEDIN_HOSTED_APPLY_MODES.has(job.applyMode);
}

function isOnsiteOrHybridRole(job) {
  return DISALLOWED_WORKPLACE_PATTERN.test(cleanWhitespace([job.location, job.listingText, job.description].join(' ')));
}

function shouldKeepJob(job, now = new Date()) {
  if (isClosedLinkedInListing(job)) return false;
  if (!job.applyMode) return false;
  if (isLinkedInHostedApplication(job)) return false;
  if (isExcludedEngineeringRole(job)) return false;
  if (isOnsiteOrHybridRole(job)) return false;
  if (!isWithinLast24Hours(job.postedAt, now)) return false;
  if (!isEnglishOnlyJob(job)) return false;
  return Boolean(job.title && job.url);
}

async function scrapeLinkedIn(args) {
  const sources = await resolveSearchSources(args);
  const proxyRotator = proxyRotatorFromEnv('LINKEDIN');
  if (proxyRotator.count) {
    console.log(`LinkedIn proxy rotation enabled with ${proxyRotator.count} proxy endpoint(s).`);
  }
  const browser = await chromium.launch({
    headless: args.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const allCards = [];
    for (const source of sources) {
      console.log(`Scraping LinkedIn search: ${source.search}`);
      const context = await newLinkedInContext(browser, proxyRotator);
      const page = await context.newPage();
      try {
        const cards = await collectJobCards(page, source, args);
        allCards.push(...cards);
        console.log(`LinkedIn search returned ${allCards.length} candidate job(s) so far.`);
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }

    const detailedJobs = await mapWithConcurrency(allCards, args.detailConcurrency, (job) =>
      enrichJobDetail(browser, proxyRotator, job, args),
    );
    const jobs = [];
    const seenUrls = new Set();
    const now = new Date();
    for (const job of detailedJobs) {
      const normalized = {
        ...job,
        postedAt: normalizePostedAt(job.postedAt, job.scrapedAt),
      };
      if (!shouldKeepJob(normalized, now)) continue;
      if (seenUrls.has(normalized.url)) continue;
      seenUrls.add(normalized.url);
      jobs.push(normalized);
      if (args.limit > 0 && jobs.length >= args.limit) break;
    }
    return jobs;
  } finally {
    await browser.close();
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

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to store scraped jobs in PostgreSQL');
  return url;
}

async function hideExistingLinkedInDisallowedWorkplaceRows() {
  const client = new pg.Client({
    connectionString: databaseUrl(),
    ssl:
      process.env.DATABASE_SSL === 'true'
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });
  await client.connect();
  try {
    await client.query(
      `
        UPDATE scraped_jobs
        SET is_hidden = TRUE,
            hidden_at = COALESCE(hidden_at, NOW()),
            updated_at = NOW()
        WHERE lower(source) = 'linkedin'
          AND is_hidden = FALSE
          AND (
            COALESCE(location, '') ~* $1
            OR COALESCE(listing_text, '') ~* $1
            OR COALESCE(raw_job::text, '') ~* $1
          )
      `,
      [DISALLOWED_WORKPLACE_SQL_PATTERN],
    );
  } finally {
    await client.end();
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
  return {
    text,
    ...(args.slackChannel ? { channel: args.slackChannel } : {}),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${text}*`,
        },
      },
      ...slackJobBatchBlocks(jobs),
    ],
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
  await hideExistingLinkedInDisallowedWorkplaceRows();
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

  console.log(`Watching LinkedIn every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`);

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
