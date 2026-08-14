import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { saveJobsToPostgres } from '../lib/postgres.js';
import {
  AI_ML_JOB_SEARCHES,
  filterExcludedEngineeringRoles,
  isEnglishOnlyJob,
} from '../lib/jobFilters.js';

const BASE_URL = 'https://jobright.ai';
const DEFAULT_JOBRIGHT_SEARCHES = [
  'software engineer',
  'data engineer',
  'full stack engineer',
  'backend engineer',
  'frontend engineer',
  ...AI_ML_JOB_SEARCHES,
];
const JOBRIGHT_COUNTRIES = {
  us: {
    label: 'United States',
    dbLocation: 'usa',
    defaultLocation: 'United States',
    urlLocationSlug: 'remote-united-states',
    envUrls: 'JOBRIGHT_US_URLS',
    envStorageState: 'JOBRIGHT_US_STORAGE_STATE',
    defaultStorageState: '.auth/jobright-us.json',
    locationPattern: /\b(united states|usa|u\.s\.|us remote|remote,\s*us|remote us)\b/i,
    cardLocationPattern:
      /\b((?:[A-Z][A-Za-z .'-]+,\s*)?United States|USA|U\.S\.|Remote,\s*US|US Remote)\b/i,
  },
  ca: {
    label: 'Canada',
    dbLocation: 'canada',
    defaultLocation: 'Canada',
    urlLocationSlug: 'remote-canada',
    envUrls: 'JOBRIGHT_CA_URLS',
    envStorageState: 'JOBRIGHT_CA_STORAGE_STATE',
    defaultStorageState: '.auth/jobright-ca.json',
    locationPattern: /\b(canada|canadian|remote,\s*canada|remote canada)\b/i,
    cardLocationPattern: /\b((?:[A-Z][A-Za-z .'-]+,\s*)?Canada|Remote,\s*Canada|Canada Remote)\b/i,
  },
  uk: {
    label: 'United Kingdom',
    dbLocation: 'uk',
    defaultLocation: 'United Kingdom',
    urlLocationSlug: 'remote-united-kingdom',
    envUrls: 'JOBRIGHT_UK_URLS',
    envStorageState: 'JOBRIGHT_UK_STORAGE_STATE',
    defaultStorageState: '.auth/jobright-uk.json',
    locationPattern:
      /\b(united kingdom|great britain|uk|u\.k\.|gb|remote,\s*(?:uk|united kingdom)|remote (?:uk|united kingdom))\b/i,
    cardLocationPattern:
      /\b((?:[A-Z][A-Za-z .'-]+,\s*)?(?:United Kingdom|Great Britain)|UK|U\.K\.|Remote,\s*(?:UK|United Kingdom)|(?:UK|United Kingdom) Remote)\b/i,
  },
};
const APPLY_NOW_TEXT = 'apply now';
const APPLY_WITH_AUTOFILL_TEXT = 'apply with autofill';
const APPLY_MODE_LABELS = {
  [APPLY_NOW_TEXT]: 'Apply Now',
  [APPLY_WITH_AUTOFILL_TEXT]: 'Apply with Autofill',
};
const LISTING_CARD_WAIT_MS = 30_000;
const LISTING_NAVIGATION_TIMEOUT_MS = 20_000;
const LISTING_LOAD_ATTEMPTS = 3;
const LISTING_RETRY_BASE_DELAY_MS = 5_000;
const SOURCE_DELAY_MIN_MS = 2_000;
const SOURCE_DELAY_MAX_MS = 5_000;
const MAX_CONSECUTIVE_SOURCE_FAILURES = 3;

const DEFAULT_ARGS = {
  country: normalizeCountry(process.env.JOBRIGHT_COUNTRY || 'us'),
  urls: [],
  urlsFile: '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  watchIntervalMinutes: 10,
  limit: 0,
  maxScrolls: 40,
  scrollPauseMs: 900,
  timeoutMs: 60000,
  descriptionLimit: 0,
  detailConcurrency: 3,
  storageState: '',
  skipDescriptions: false,
  debug: false,
  headless: true,
  watch: false,
};

function parseArgs(argv) {
  const args = { ...DEFAULT_ARGS, urls: [...DEFAULT_ARGS.urls] };
  const aliases = {
    '--start-url': 'startUrl',
    '--country': 'country',
    '--urls-file': 'urlsFile',
    '--slack-webhook-url': 'slackWebhookUrl',
    '--slack-channel': 'slackChannel',
    '--watch-interval-minutes': 'watchIntervalMinutes',
    '--limit': 'limit',
    '--max-scrolls': 'maxScrolls',
    '--scroll-pause-ms': 'scrollPauseMs',
    '--timeout-ms': 'timeoutMs',
    '--description-limit': 'descriptionLimit',
    '--detail-concurrency': 'detailConcurrency',
    '--storage-state': 'storageState',
  };
  const numericKeys = new Set([
    'limit',
    'maxScrolls',
    'scrollPauseMs',
    'timeoutMs',
    'descriptionLimit',
    'detailConcurrency',
    'watchIntervalMinutes',
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
    if (token === '--skip-descriptions') {
      args.skipDescriptions = true;
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
    if (!key) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }
    args[key] = numericKeys.has(key) ? Number(value) : value;
    if (numericKeys.has(key) && Number.isNaN(args[key])) {
      throw new Error(`Expected a number for ${token}, got: ${value}`);
    }
    index += 1;
  }

  args.country = normalizeCountry(args.country);
  const country = countryConfig(args.country);
  const legacyUrls = args.country === 'us' ? process.env.JOBRIGHT_URLS : '';
  args.urls = args.urls.length ? args.urls : envUrls(process.env[country.envUrls] || legacyUrls);
  args.storageState =
    args.storageState ||
    process.env[country.envStorageState] ||
    process.env.JOBRIGHT_STORAGE_STATE ||
    country.defaultStorageState;

  return args;
}

function printHelp() {
  console.log(`Jobright remote tech job scraper\n\nUsage:\n  node sites/jobright/scraper.js [options]\n\nOptions:\n  --country us|ca|uk         Country to scrape, default us or JOBRIGHT_COUNTRY\n  --url URL                  Jobright search page to scrape; repeat for multiple URLs\n  --start-url URL            Backward-compatible alias for a single Jobright search page\n  --urls-file PATH           Text file with one Jobright search URL per line\n  --slack-webhook-url URL    Slack incoming webhook URL, or use SLACK_WEBHOOK_URL\n  --slack-channel NAME       Optional channel override for compatible webhooks\n  --watch                    Keep polling Jobright and posting newly inserted jobs\n  --watch-interval-minutes N Minutes between watch runs, default 10\n  --limit N                  Maximum jobs to save, 0 means no limit\n  --max-scrolls N            Scroll attempts, default 40\n  --scroll-pause-ms N        Delay after each scroll, default 900\n  --timeout-ms N             Playwright timeout, default 60000\n  --description-limit N      Detail pages to open, 0 means all\n  --detail-concurrency N     Detail page concurrency, default 3\n  --storage-state PATH       Playwright logged-in storage state, default .auth/jobright-<country>.json\n  --skip-descriptions        Do not scrape detail-page descriptions\n  --headless / --no-headless Browser visibility, default headless\n  --no-slack                 Disable Slack posting for this run\n  --debug                    Print card-detection diagnostics\n`);
}

function normalizeCountry(value) {
  const normalized = cleanWhitespace(value).toLowerCase();
  if (['us', 'usa', 'united-states', 'united states'].includes(normalized)) return 'us';
  if (['ca', 'canada'].includes(normalized)) return 'ca';
  if (['uk', 'gb', 'united-kingdom', 'united kingdom', 'great britain'].includes(normalized)) return 'uk';
  throw new Error(`Unsupported Jobright country "${value}". Expected "us", "ca", or "uk".`);
}

function countryConfig(country) {
  return JOBRIGHT_COUNTRIES[normalizeCountry(country)];
}

function envUrls(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function absoluteUrl(href) {
  return new URL(href, BASE_URL).toString();
}

function originalJobUrlFromHref(href) {
  try {
    const parsed = new URL(href, BASE_URL);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';

    if (!parsed.hostname.endsWith('jobright.ai')) return parsed.toString();

    for (const param of ['url', 'u', 'target', 'redirect', 'redirect_url', 'redirectUrl']) {
      const value = parsed.searchParams.get(param);
      if (!value) continue;
      const originalUrl = originalJobUrlFromHref(value);
      if (originalUrl) return originalUrl;
    }
  } catch {
    // Ignore malformed links.
  }

  return '';
}

function searchToJobrightUrl(search, country) {
  const config = countryConfig(country);
  const slug = cleanWhitespace(search).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${BASE_URL}/jobs/${slug}-jobs-in-${config.urlLocationSlug}`;
}

async function readUrlFile(path) {
  if (!path) return [];
  const raw = await fs.readFile(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function existingStorageState(path) {
  if (!path) return undefined;
  try {
    await fs.access(path);
    return path;
  } catch {
    return undefined;
  }
}

async function resolveSourceUrls(args) {
  if (args.authenticatedSession) return [`${BASE_URL}/jobs/recommend`];

  const defaultUrls = DEFAULT_JOBRIGHT_SEARCHES.map((search) => searchToJobrightUrl(search, args.country));
  const urls = [
    ...args.urls,
    ...(args.startUrl ? [args.startUrl] : []),
    ...(await readUrlFile(args.urlsFile)),
  ];
  const uniqueUrls = [...new Set(urls.length ? urls : defaultUrls)];
  for (const url of uniqueUrls) {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('jobright.ai')) {
      throw new Error(`Expected a jobright.ai URL, got: ${url}`);
    }
  }
  return uniqueUrls;
}

function postedTextFromCard(text) {
  const match = cleanWhitespace(text).match(
    /(just now|\d+\s*(?:minute|minutes|hour|hours|day|days|week|weeks|month|months)\s+ago)/i,
  );
  return match ? match[1] : '';
}

function parsePostedTime(text, now = new Date()) {
  const value = cleanWhitespace(text).toLowerCase();
  if (!value) return null;
  if (value.includes('just now')) return now;

  const match = value.match(
    /(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months)\s+ago/i,
  );
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const millisByUnit = {
      minute: 60 * 1000,
      minutes: 60 * 1000,
      hour: 60 * 60 * 1000,
      hours: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000,
    };
    return new Date(now.getTime() - amount * millisByUnit[unit]);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecent(postedAt, now = new Date()) {
  if (!postedAt) return false;
  return postedAt.getTime() >= now.getTime() - 24 * 60 * 60 * 1000;
}

function isRemoteForCountry(text, country) {
  const config = countryConfig(country);
  const normalized = cleanWhitespace(text).toLowerCase();
  const hasRemote = /\b(remote|work from home|wfh)\b/i.test(normalized);
  return hasRemote && config.locationPattern.test(normalized);
}

function applyModeFromText(text) {
  const normalized = cleanWhitespace(text).toLowerCase();
  if (!normalized) return '';
  if (normalized.includes(APPLY_WITH_AUTOFILL_TEXT)) return APPLY_MODE_LABELS[APPLY_WITH_AUTOFILL_TEXT];
  if (normalized.includes(APPLY_NOW_TEXT)) return APPLY_MODE_LABELS[APPLY_NOW_TEXT];
  return '';
}

function applyModeFromActions(actions) {
  let fallbackApplyMode = '';
  for (const text of actions) {
    const applyMode = applyModeFromText(text);
    if (applyMode === APPLY_MODE_LABELS[APPLY_WITH_AUTOFILL_TEXT]) return applyMode;
    if (applyMode && !fallbackApplyMode) fallbackApplyMode = applyMode;
  }
  return fallbackApplyMode;
}

function parseCardText(text, country) {
  const config = countryConfig(country);
  const lines = cleanLines(text);
  let compact = lines.join(' ');
  const postedText = postedTextFromCard(compact);

  if (postedText && compact.toLowerCase().startsWith(postedText.toLowerCase())) {
    compact = compact.slice(postedText.length).trim();
  }
  compact = compact.replace(/^be an early applicant\s+/i, '').trim();

  let title = '';
  let company = '';
  let location = '';
  const [beforeCompany = '', afterCompany = ''] = compact.split(/\s+\/\s+/, 2);
  const beforeLines = cleanLines(beforeCompany);

  if (beforeLines.length >= 2) {
    title = beforeLines.at(-2);
    company = beforeLines.at(-1);
  } else if (beforeCompany) {
    title = beforeCompany;
  }

  const locationMatch = afterCompany.match(config.cardLocationPattern);
  if (locationMatch) location = locationMatch[1];

  return { title, company, location, postedText };
}

async function extractCardFields(anchor) {
  return anchor.evaluate((card) => {
    const text = (selector) => card.querySelector(selector)?.textContent?.trim() || '';
    const metaByIcon = (alt) => {
      const icon = card.querySelector(`img[alt="${alt}"]`);
      return icon?.parentElement?.textContent?.trim() || '';
    };

    return {
      title: text('h2') || text('[class*="title" i]'),
      company: text('[class*="company-name" i]') || text('[class*="company" i]'),
      postedText: text('[class*="publish-time" i]') || text('[class*="time" i]'),
      location: metaByIcon('position') || text('[class*="location" i]'),
      workMode: metaByIcon('remote') || text('[class*="remote" i]'),
    };
  });
}

async function dismissVisiblePopups(page) {
  const popupScopes = page.locator(
    "[role='dialog']:visible, .ant-modal-wrap:visible, .ant-drawer:visible, [class*='popup' i]:visible, [class*='modal' i]:visible",
  );
  const dismissAction = /^(?:close|dismiss|no thanks|not now|maybe later|skip|got it|decline|i'?ll pass|continue without.*|×)$/i;
  let dismissed = 0;

  for (let index = (await popupScopes.count()) - 1; index >= 0; index -= 1) {
    const popup = popupScopes.nth(index);
    if (!(await popup.isVisible().catch(() => false))) continue;

    const action = popup.getByRole('button', { name: dismissAction }).first();
    const closeControl = popup
      .locator("button[aria-label*='close' i], [role='button'][aria-label*='close' i], .ant-modal-close, [class*='close-button' i]")
      .first();
    const control = (await action.count()) ? action : closeControl;
    if (!(await control.count())) continue;

    try {
      await control.click({ force: true, timeout: 1500 });
      dismissed += 1;
      await page.waitForTimeout(150);
    } catch {
      // A fallback below removes persistent promotional overlays.
    }
  }

  dismissed += await page.evaluate(() => {
    const promotionPattern = /exclusive offer|limited[- ]time offer|upgrade to turbo|upgrade now|special offer|subscribe|start (?:a )?trial/i;
    const candidates = Array.from(
      document.querySelectorAll("[role='dialog'], .ant-modal-wrap, .ant-drawer, [class*='popup' i], [class*='modal' i]"),
    );
    let removed = 0;

    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0;
      if (!visible || !promotionPattern.test(element.textContent || '')) continue;
      element.remove();
      removed += 1;
    }

    if (removed) {
      document.querySelectorAll('.ant-modal-mask, .ant-drawer-mask').forEach((element) => element.remove());
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('padding-right');
    }
    return removed;
  }).catch(() => 0);

  return dismissed;
}

async function waitForVisibleJobList(page, timeoutMs, debug = false) {
  const deadline = Date.now() + timeoutMs;
  let dismissed = 0;

  while (Date.now() < deadline) {
    dismissed += await dismissVisiblePopups(page);
    const listReady = await page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0
        );
      };
      const cardVisible = Array.from(document.querySelectorAll("a[href*='/jobs/info/']")).some((anchor) => {
        let current = anchor.closest('.job-card-flag-classname') || anchor;
        for (let depth = 0; current && depth < 6; depth += 1) {
          if (visible(current) && /\bapply\b/i.test(current.innerText || current.textContent || '')) return true;
          current = current.parentElement;
        }
        return false;
      });
      const blockingPopup = Array.from(
        document.querySelectorAll("[role='dialog'], .ant-modal-wrap, .ant-drawer, [class*='popup' i], [class*='modal' i]"),
      ).some((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        const modalContainer = element.matches("[role='dialog'], .ant-modal-wrap, .ant-drawer");
        return modalContainer || rect.width * rect.height >= window.innerWidth * window.innerHeight * 0.1;
      });
      return cardVisible && !blockingPopup;
    }).catch(() => false);

    if (listReady) {
      if (debug && dismissed) console.log(`Dismissed ${dismissed} Jobright popup(s) before loading jobs.`);
      return;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`no visible job cards after waiting ${timeoutMs}ms and dismissing ${dismissed} popup(s)`);
}

async function waitForQuietPage(page, timeoutMs, settleMs = 2500) {
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    await page.waitForTimeout(settleMs);
  }
}

async function listingPageDiagnostic(page, response) {
  const title = cleanWhitespace(await page.title().catch(() => '')) || 'untitled';
  const bodyText = cleanWhitespace(await page.locator('body').innerText().catch(() => ''));
  const state = /captcha|verify you are human|just a moment|access denied|too many requests/i.test(bodyText)
    ? 'challenge or rate limit'
    : /(?:^|\s)0 results|no jobs found/i.test(bodyText)
      ? 'empty results'
      : bodyText
        ? `page rendered ${bodyText.length} text characters`
        : 'empty page';

  return `HTTP ${response?.status() || 'unknown'}, title "${title}", ${state}, final URL ${page.url()}`;
}

async function loadListingPage(page, sourceUrl, args) {
  const cardWaitMs = Math.min(args.timeoutMs, LISTING_CARD_WAIT_MS);
  const navigationTimeoutMs = Math.min(args.timeoutMs, LISTING_NAVIGATION_TIMEOUT_MS);
  let lastError;

  for (let attempt = 1; attempt <= LISTING_LOAD_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await page.goto(sourceUrl, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeoutMs,
      });
      await waitForVisibleJobList(page, cardWaitMs, args.debug);
      return;
    } catch (error) {
      lastError = error;
      const diagnostic = await listingPageDiagnostic(page, response);
      console.warn(
        `Jobright listing load attempt ${attempt}/${LISTING_LOAD_ATTEMPTS} failed after waiting up to ${cardWaitMs}ms: ${diagnostic}`,
      );
      if (attempt < LISTING_LOAD_ATTEMPTS) {
        const backoffMs = LISTING_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + randomInteger(0, 2_000);
        console.warn(`Retrying Jobright listing in ${backoffMs}ms.`);
        await sleep(backoffMs);
      }
    }
  }

  throw new Error(`no job cards after ${LISTING_LOAD_ATTEMPTS} attempts (${lastError?.message || 'unknown error'})`);
}

function randomInteger(minimum, maximum) {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

async function waitBeforeNextSource() {
  const delayMs = randomInteger(SOURCE_DELAY_MIN_MS, SOURCE_DELAY_MAX_MS);
  await sleep(delayMs);
}

export async function selectedJobSortText(page) {
  const sorter = page.locator("[class*='jobs-recommend-sorter']").first();
  if (!(await sorter.count())) return '';

  const selectedItem = sorter.locator('.ant-select-selection-item').first();
  const text = (await selectedItem.count())
    ? await selectedItem.innerText().catch(() => '')
    : await sorter.innerText().catch(() => '');
  return cleanWhitespace(text);
}

export async function assertMostRecentSort(page) {
  const selectedSort = await selectedJobSortText(page);
  if (!/^most recent$/i.test(selectedSort)) {
    throw new Error(
      `Jobright Most Recent sort verification failed; selected value is "${selectedSort || 'unknown'}"`,
    );
  }
}

export async function moveJobList(page, { reset = false } = {}) {
  return page.evaluate(({ resetToTop }) => {
    const jobLinkSelector = "a[href*='/jobs/info/']";
    const canScroll = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 1 && /(auto|scroll)/i.test(style.overflowY);
    };

    const explicitCandidates = Array.from(
      document.querySelectorAll(
        '#jobs-page-main-content, [class*="jobs-page-main-content" i], [class*="jobs-list-scrollable" i]',
      ),
    );
    const firstJobLink = document.querySelector(jobLinkSelector);
    const ancestorCandidates = [];
    for (let current = firstJobLink?.parentElement; current; current = current.parentElement) {
      if (canScroll(current)) ancestorCandidates.push(current);
    }
    const containingCandidates = Array.from(document.querySelectorAll('*')).filter(
      (element) => canScroll(element) && element.querySelector(jobLinkSelector),
    );
    const target =
      [...explicitCandidates, ...ancestorCandidates, ...containingCandidates].find(canScroll) ||
      explicitCandidates.find((element) => element.querySelector(jobLinkSelector));

    if (target) {
      const before = target.scrollTop;
      const distance = Math.max(Math.round(target.clientHeight * 0.8), 600);
      target.scrollTo({ top: resetToTop ? 0 : before + distance });
      return {
        target:
          target.id ||
          Array.from(target.classList).find((className) => /jobs.*(?:content|scroll)/i.test(className)) ||
          target.tagName.toLowerCase(),
        before,
        after: target.scrollTop,
        max: Math.max(target.scrollHeight - target.clientHeight, 0),
      };
    }

    const scrollingElement = document.scrollingElement;
    if (!scrollingElement || scrollingElement.scrollHeight <= scrollingElement.clientHeight + 1) {
      throw new Error('Jobright job-list scroll container was not found');
    }

    const before = scrollingElement.scrollTop;
    const distance = Math.max(Math.round(window.innerHeight * 0.8), 600);
    window.scrollTo({ top: resetToTop ? 0 : before + distance });
    return {
      target: 'window',
      before,
      after: scrollingElement.scrollTop,
      max: Math.max(scrollingElement.scrollHeight - scrollingElement.clientHeight, 0),
    };
  }, { resetToTop: reset });
}

async function selectMostRecentSort(page, args) {
  await dismissVisiblePopups(page);
  const sorter = page.locator("[class*='jobs-recommend-sorter']").first();
  await sorter.waitFor({ state: 'visible', timeout: Math.min(args.timeoutMs, 15_000) });

  if (/^most recent$/i.test(await selectedJobSortText(page))) {
    await assertMostRecentSort(page);
    await moveJobList(page, { reset: true });
    if (args.debug) console.log('Verified Jobright Most Recent sort is already selected.');
    return;
  }

  await sorter.click({ timeout: 5000 });
  const mostRecentOption = page.getByRole('option', { name: 'Most Recent', exact: true }).filter({ visible: true });
  const mostRecentText = page.getByText('Most Recent', { exact: true }).filter({ visible: true });
  const option = (await mostRecentOption.count()) ? mostRecentOption.first() : mostRecentText.last();
  await option.click({ timeout: 5000 });
  await page.waitForFunction(
    () => {
      const sorter = document.querySelector("[class*='jobs-recommend-sorter']");
      const selected = sorter?.querySelector('.ant-select-selection-item');
      return /^most recent$/i.test((selected?.textContent || '').replace(/\s+/g, ' ').trim());
    },
    undefined,
    { timeout: 5000 },
  );
  await waitForQuietPage(page, Math.min(args.timeoutMs, 10_000), Math.max(args.scrollPauseMs, 2_000));
  await waitForVisibleJobList(page, Math.min(args.timeoutMs, LISTING_CARD_WAIT_MS), args.debug);
  await assertMostRecentSort(page);
  await moveJobList(page, { reset: true });

  if (args.debug) console.log('Selected and verified Jobright Most Recent sort.');
}

function mergeNonEmpty(...objects) {
  return objects.reduce((merged, object) => {
    for (const [key, value] of Object.entries(object)) {
      if (cleanWhitespace(value)) merged[key] = value;
    }
    return merged;
  }, {});
}

async function collectListingJobs(page, sourceUrl, args, seenUrls = new Set()) {
  const config = countryConfig(args.country);
  const now = new Date();
  const scrapedAt = now.toISOString();
  const debug = args.debug;
  const cards = await page.locator("a[href*='/jobs/info/']").evaluateAll((anchors) => {
    const seenHrefs = new Set();
    return anchors.flatMap((anchor) => {
      const href = anchor.getAttribute('href') || '';
      if (!href || seenHrefs.has(href)) return [];
      seenHrefs.add(href);

      let cardRoot = anchor.closest('.job-card-flag-classname') || anchor;
      if (cardRoot === anchor) {
        let current = anchor;
        for (let depth = 0; current && depth < 6; depth += 1) {
          const text = current.innerText || current.textContent || '';
          const jobLinkCount =
            (current.matches?.("a[href*='/jobs/info/']") ? 1 : 0) +
            current.querySelectorAll("a[href*='/jobs/info/']").length;
          if (/apply/i.test(text) && jobLinkCount <= 1) {
            cardRoot = current;
            break;
          }
          current = current.parentElement;
        }
      }

      const actionsRoot = cardRoot.querySelector('[class*="actions" i]') || cardRoot;
      const actionTexts = Array.from(actionsRoot.querySelectorAll('button, a, [role="button"]'))
        .map((node) => (node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter((text) => /\bapply\b/i.test(text));

      return {
        href,
        text: cardRoot.innerText || cardRoot.textContent || anchor.innerText || anchor.textContent || '',
        actionText: actionTexts.join(' | '),
        actionTexts,
        title:
          cardRoot.querySelector('h2')?.textContent?.trim() ||
          cardRoot.querySelector('[class*="title" i]')?.textContent?.trim() ||
          anchor.querySelector('h2')?.textContent?.trim() ||
          anchor.querySelector('[class*="title" i]')?.textContent?.trim() ||
          '',
        company:
          cardRoot.querySelector('[class*="company-name" i]')?.textContent?.trim() ||
          cardRoot.querySelector('[class*="company" i]')?.textContent?.trim() ||
          anchor.querySelector('[class*="company-name" i]')?.textContent?.trim() ||
          anchor.querySelector('[class*="company" i]')?.textContent?.trim() ||
          '',
        postedText:
          cardRoot.querySelector('[class*="publish-time" i]')?.textContent?.trim() ||
          cardRoot.querySelector('[class*="time" i]')?.textContent?.trim() ||
          anchor.querySelector('[class*="publish-time" i]')?.textContent?.trim() ||
          anchor.querySelector('[class*="time" i]')?.textContent?.trim() ||
          '',
        location:
          cardRoot.querySelector('img[alt="position"]')?.parentElement?.textContent?.trim() ||
          cardRoot.querySelector('[class*="location" i]')?.textContent?.trim() ||
          anchor.querySelector('img[alt="position"]')?.parentElement?.textContent?.trim() ||
          anchor.querySelector('[class*="location" i]')?.textContent?.trim() ||
          '',
        workMode:
          cardRoot.querySelector('img[alt="remote"]')?.parentElement?.textContent?.trim() ||
          cardRoot.querySelector('[class*="remote" i]')?.textContent?.trim() ||
          anchor.querySelector('img[alt="remote"]')?.parentElement?.textContent?.trim() ||
          anchor.querySelector('[class*="remote" i]')?.textContent?.trim() ||
          '',
      };
    });
  });
  const jobs = [];

  if (debug) console.log(`Detected ${cards.length} job cards.`);

  for (const card of cards) {
    const href = card.href;
    if (!href) continue;

    const url = absoluteUrl(href);
    if (seenUrls.has(url)) {
      console.log(`Jobright already seen listing URL during source scan: ${url}`);
      continue;
    }
    seenUrls.add(url);

    const listingText = cleanWhitespace(card.text);
    if (!listingText) continue;
    if (debug && seenUrls.size <= 5) console.log(`Card ${seenUrls.size}: ${listingText.slice(0, 300)}`);

    const listingApplyMode = applyModeFromActions(card.actionTexts || []);
    if (!listingApplyMode) continue;

    const parsed = mergeNonEmpty(parseCardText(listingText, args.country), card);
    const filterText = [listingText, parsed.location, parsed.workMode].filter(Boolean).join(' ');
    if (!isRemoteForCountry(filterText, args.country)) continue;

    const postedAt = parsePostedTime(parsed.postedText, now);
    if (!isRecent(postedAt, now)) continue;

    jobs.push({
      title: cleanWhitespace(parsed.title),
      company: cleanWhitespace(parsed.company),
      location: config.dbLocation,
      jobrightLocation: cleanWhitespace(parsed.location) || config.defaultLocation,
      postedText: cleanWhitespace(parsed.postedText),
      postedAt: postedAt ? postedAt.toISOString() : '',
      url,
      source: 'Jobright',
      sourceUrl,
      scrapedAt,
      description: '',
      listingText,
      applyMode: listingApplyMode,
    });
  }

  return jobs;
}

async function scrollAndCollectListingJobs(page, args) {
  const jobs = [];
  const seenUrls = new Set();
  let previousCardCount = 0;
  let stableRounds = 0;

  for (let index = 0; index <= args.maxScrolls; index += 1) {
    await dismissVisiblePopups(page);
    await assertMostRecentSort(page);
    jobs.push(...(await collectListingJobs(page, page.url(), args, seenUrls)));

    const currentCardCount = seenUrls.size;
    stableRounds = currentCardCount === previousCardCount ? stableRounds + 1 : 0;
    if (stableRounds >= 3 || index === args.maxScrolls) break;

    previousCardCount = currentCardCount;
    const scrollState = await moveJobList(page);
    if (args.debug) {
      console.log(
        `Jobright scroll ${index + 1}/${args.maxScrolls} on ${scrollState.target}: ` +
          `${Math.round(scrollState.before)} -> ${Math.round(scrollState.after)} ` +
          `(max ${Math.round(scrollState.max)}), ${currentCardCount} unique listing URL(s) seen.`,
      );
    }
    await page.waitForTimeout(args.scrollPauseMs);
  }

  return jobs;
}

async function scrapeJobrightJobs(args, context) {
  const config = countryConfig(args.country);
  const sourceUrls = await resolveSourceUrls(args);
  const allJobs = [];
  const seenUrls = new Set();
  let successfulSources = 0;
  let consecutiveSourceFailures = 0;
  let circuitBreakerOpened = false;
  const page = await context.newPage();

  try {
    for (let sourceIndex = 0; sourceIndex < sourceUrls.length; sourceIndex += 1) {
      if (sourceIndex > 0) await waitBeforeNextSource();

      const sourceUrl = sourceUrls[sourceIndex];
      console.log(`Jobright ${config.label} source ${sourceIndex + 1}/${sourceUrls.length}: ${sourceUrl}`);
      try {
        await loadListingPage(page, sourceUrl, args);
        await selectMostRecentSort(page, args);
      } catch (error) {
        consecutiveSourceFailures += 1;
        console.warn(
          `Skipping Jobright ${config.label} source ${sourceIndex + 1}/${sourceUrls.length}: ${error.message}`,
        );
        if (consecutiveSourceFailures >= MAX_CONSECUTIVE_SOURCE_FAILURES) {
          circuitBreakerOpened = true;
          console.warn(
            `Stopping Jobright ${config.label} source scan after ${consecutiveSourceFailures} consecutive load failures.`,
          );
          break;
        }
        continue;
      }
      successfulSources += 1;
      consecutiveSourceFailures = 0;

      const sourceJobs = await scrollAndCollectListingJobs(page, args);
      console.log(
        `Jobright ${config.label} source ${sourceIndex + 1}/${sourceUrls.length} collected ${sourceJobs.length} candidate job(s).`,
      );

      for (const job of filterExcludedEngineeringRoles(sourceJobs)) {
        if (seenUrls.has(job.url)) {
          console.log(`Jobright already seen job URL across sources: ${job.url}`);
          continue;
        }
        seenUrls.add(job.url);
        allJobs.push(job);
        if (args.limit > 0 && allJobs.length >= args.limit) return allJobs;
      }
    }

    if (!successfulSources) {
      const reason = circuitBreakerOpened
        ? `the circuit breaker opened after ${MAX_CONSECUTIVE_SOURCE_FAILURES} consecutive failures`
        : `all ${sourceUrls.length} sources failed to load`;
      throw new Error(`no Jobright ${config.label} sources loaded because ${reason}`);
    }
  } finally {
    await page.close();
  }

  return args.limit > 0 ? allJobs.slice(0, args.limit) : allJobs;
}

function firstDescriptionFromJson(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstDescriptionFromJson(item);
      if (found) return found;
    }
    return '';
  }

  if (value && typeof value === 'object') {
    for (const key of ['description', 'jobDescription', 'content', 'details']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && cleanWhitespace(candidate).length > 150) {
        return candidate;
      }
    }
    for (const child of Object.values(value)) {
      const found = firstDescriptionFromJson(child);
      if (found) return found;
    }
  }

  return '';
}

async function extractDescriptionFromPage(page) {
  const jsonTexts = await page
    .locator("script[type='application/ld+json'], script#__NEXT_DATA__")
    .evaluateAll((scripts) => scripts.map((script) => script.textContent || ''))
    .catch(() => []);

  for (const jsonText of jsonTexts) {
    try {
      const description = firstDescriptionFromJson(JSON.parse(jsonText));
      if (description) return description;
    } catch {
      // Ignore non-JSON script contents.
    }
  }

  for (const selector of [
    '[data-testid*="description" i]',
    '[class*="description" i]',
    '[class*="job-detail" i]',
    '[class*="jobDescription" i]',
    "section:has-text('Job Description')",
    "section:has-text('Responsibilities')",
    'article',
    'main',
  ]) {
    const text = await page.locator(selector).first().innerText({ timeout: 1500 }).catch(() => '');
    if (cleanWhitespace(text).length > 150) return text;
  }

  const metaDescription = await page
    .locator("meta[name='description'], meta[property='og:description']")
    .evaluateAll((metas) => metas.map((meta) => meta.getAttribute('content') || '').find(Boolean) || '')
    .catch(() => '');
  return metaDescription;
}

async function visibleApplyActions(page) {
  return page.locator('button, a, [role="button"]').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const text = (node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const classChain = [];
        let current = node;
        while (current) {
          classChain.push(String(current.className || ''));
          current = current.parentElement;
        }
        const classText = classChain.join(' ');
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0;
        const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
        const sidebarAutofillPlugin = /auto-fill-section|visitor-tool-sider/i.test(classText);
        return { text, visible, disabled, sidebarAutofillPlugin };
      })
      .filter((action) => action.visible && !action.disabled && !action.sidebarAutofillPlugin && /\bapply\b/i.test(action.text)),
  );
}

async function eligibleApplyMode(page) {
  const actions = await visibleApplyActions(page).catch(() => []);
  const actionTexts = actions.map((action) => action.text);
  if (actionTexts.some((text) => applyModeFromText(text) === APPLY_MODE_LABELS[APPLY_NOW_TEXT])) {
    return APPLY_MODE_LABELS[APPLY_NOW_TEXT];
  }
  if (actionTexts.some((text) => applyModeFromText(text) === APPLY_MODE_LABELS[APPLY_WITH_AUTOFILL_TEXT])) {
    return APPLY_MODE_LABELS[APPLY_WITH_AUTOFILL_TEXT];
  }
  return '';
}

async function extractOriginalJobPostUrl(page) {
  const href = await page
    .locator('a', { hasText: /original job post/i })
    .first()
    .getAttribute('href', { timeout: 1500 })
    .catch(() => '');
  const directUrl = originalJobUrlFromHref(href);
  if (directUrl) return directUrl;

  const nearbyHref = await page.evaluate(() => {
    const normalizedText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const textNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (normalizedText(node.textContent).includes('original job post')) textNodes.push(node);
    }

    for (const node of textNodes) {
      let current = node.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1) {
        if (current.matches?.('a[href]')) return current.getAttribute('href') || '';
        const link = current.querySelector?.('a[href]');
        if (link) return link.getAttribute('href') || '';
        current = current.parentElement;
      }
    }

    return '';
  }).catch(() => '');

  const nearbyUrl = originalJobUrlFromHref(nearbyHref);
  if (nearbyUrl) return nearbyUrl;

  return '';
}

async function inspectJobDetail(context, job, options) {
  const page = await context.newPage();
  const { debug = false, includeDescription = false, timeoutMs } = options;

  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForQuietPage(page, timeoutMs);
    await dismissVisiblePopups(page);

    const detailApplyMode = await eligibleApplyMode(page);
    const descriptionText = cleanWhitespace(await extractDescriptionFromPage(page).catch(() => ''));
    const languageJob = {
      ...job,
      description: descriptionText || '',
      listingText: [job.listingText, descriptionText].filter(Boolean).join(' '),
    };
    if (!isEnglishOnlyJob(languageJob)) {
      if (debug) console.log(`Skipping non-English Jobright job: ${job.url}`);
      return null;
    }

    const hasAutofillApplyMode =
      job.applyMode === APPLY_MODE_LABELS[APPLY_WITH_AUTOFILL_TEXT] ||
      detailApplyMode === APPLY_MODE_LABELS[APPLY_WITH_AUTOFILL_TEXT];
    job.applyMode = hasAutofillApplyMode ? APPLY_MODE_LABELS[APPLY_WITH_AUTOFILL_TEXT] : detailApplyMode || job.applyMode;
    if (!job.applyMode) {
      if (debug) console.log(`Skipping Jobright job without an eligible apply action: ${job.url}`);
      return null;
    }

    if (hasAutofillApplyMode) {
      const originalJobUrl = await extractOriginalJobPostUrl(page);
      if (originalJobUrl) {
        job.jobrightUrl = job.url;
        job.url = originalJobUrl;
      } else if (debug) {
        console.log(`Could not find original Jobright autofill post URL: ${job.url}`);
      }
    }

    if (includeDescription && descriptionText) {
      job.description = descriptionText.slice(0, 20000);
      if (job.description) {
        job.listingText = cleanWhitespace([job.listingText, job.description].filter(Boolean).join(' '));
      }
    }

    return job;
  } catch (error) {
    console.warn(`Detail eligibility check skipped for ${job.url}: ${error.message}`);
    return null;
  } finally {
    await page.close();
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

async function filterEligibleJobDetails(context, jobs, args) {
  if (!jobs.length) return jobs;

  const descriptionLimit = args.skipDescriptions ? 0 : args.descriptionLimit || jobs.length;
  const inspected = await mapWithConcurrency(jobs, args.detailConcurrency, (job, index) =>
    inspectJobDetail(context, job, {
      debug: args.debug,
      includeDescription: index < descriptionLimit,
      timeoutMs: args.timeoutMs,
    }),
  );

  return inspected.filter(Boolean);
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
  const source = slackEscape(job.source || 'Jobright');
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
  const text = `Found ${jobs.length} new Jobright ${plural}`;
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
  const config = countryConfig(args.country);
  const browser = await chromium.launch({
    headless: args.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const storageState = await existingStorageState(args.storageState);
  if (args.storageState && !storageState) {
    console.warn(`Jobright storage state not found at ${args.storageState}; scraping as a guest session.`);
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ...(storageState ? { storageState } : {}),
  });
  args.authenticatedSession = Boolean(storageState);
  let jobs = [];
  try {
    jobs = await scrapeJobrightJobs(args, context);
    console.log(`Found ${jobs.length} remote ${config.label} tech jobs posted within the last 24 hours.`);

    jobs = await filterEligibleJobDetails(context, jobs, args);
    console.log(
      `Kept ${jobs.length} English-only Jobright ${config.label} jobs with an eligible apply action.`,
    );
  } finally {
    await context.close();
    await browser.close();
  }

  const { insertedOrUpdated, savedUrls = [] } = await saveJobsToPostgres(jobs);
  console.log(`Saved ${insertedOrUpdated} Jobright jobs to PostgreSQL.`);

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
  const config = countryConfig(args.country);
  const intervalMs = Math.max(args.watchIntervalMinutes, 1) * 60 * 1000;
  let shouldStop = false;

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shouldStop = true;
      console.log('\nStopping watch mode after the current wait/run finishes.');
    });
  }

  console.log(
    `Watching Jobright ${config.label} every ${Math.round(intervalMs / 60000)} minute(s). Press Ctrl+C to stop.`,
  );

  while (!shouldStop) {
    const startedAt = new Date();
    console.log(`\n[${startedAt.toISOString()}] Checking for new jobs...`);

    try {
      await runScraper(args);
    } catch (error) {
      console.error(`Watch run failed: ${error.message}`);
    }

    if (!shouldStop) await sleep(intervalMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
}
