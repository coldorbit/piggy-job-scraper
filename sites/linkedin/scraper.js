import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import pg from 'pg';
import { saveJobsToPostgres } from '../lib/postgres.js';
import { isExcludedEngineeringRole, isEnglishOnlyJob } from '../lib/jobFilters.js';
import { isWithinLast24Hours } from '../lib/recency.js';

const LINKEDIN_BASE_URL = 'https://www.linkedin.com';
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
const DEFAULT_LINKEDIN_AI_SEARCH_MODEL = 'gpt-4.1-mini';
const DEFAULT_LINKEDIN_AI_SEARCH_LIMIT = 12;
const DISALLOWED_WORKPLACE_PATTERN =
  /\b(?:hybrid|on[\s-]?site|in[\s-]?office|office[\s-]?based|work\s+from\s+(?:the\s+)?office)\b/i;
const DISALLOWED_WORKPLACE_SQL_PATTERN =
  '(hybrid|on[[:space:]-]?site|in[[:space:]-]?office|office[[:space:]-]?based|work[[:space:]]+from[[:space:]]+(the[[:space:]]+)?office)';
const LINKEDIN_CLOSED_APPLICATION_PATTERN = /\bno\s+longer\s+accepting\s+applications\b/i;
const LINKEDIN_HOSTED_APPLY_MODES = new Set(['LinkedIn Apply', 'Easy Apply']);
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
  detailConcurrency: 3,
  limit: 0,
  timeoutMs: 60000,
  aiEnrichSearches: envBool(process.env.LINKEDIN_AI_ENRICH_SEARCHES),
  aiSearchModel: process.env.LINKEDIN_AI_SEARCH_MODEL || DEFAULT_LINKEDIN_AI_SEARCH_MODEL,
  aiSearchLimit: Number(process.env.LINKEDIN_AI_SEARCH_LIMIT || DEFAULT_LINKEDIN_AI_SEARCH_LIMIT),
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

function envBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
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
    '--ai-search-model': 'aiSearchModel',
    '--ai-search-limit': 'aiSearchLimit',
  };
  const numericKeys = new Set([
    'watchIntervalMinutes',
    'maxPages',
    'detailConcurrency',
    'limit',
    'timeoutMs',
    'aiSearchLimit',
  ]);

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
    if (token === '--ai-enrich-searches') {
      args.aiEnrichSearches = true;
      continue;
    }
    if (token === '--no-ai-enrich-searches') {
      args.aiEnrichSearches = false;
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
  --ai-enrich-searches       Ask OpenAI to expand generated LinkedIn searches
  --no-ai-enrich-searches    Disable env-enabled AI search enrichment
  --ai-search-model MODEL    OpenAI model, default ${DEFAULT_LINKEDIN_AI_SEARCH_MODEL}
  --ai-search-limit N        Maximum AI-added search terms, default ${DEFAULT_LINKEDIN_AI_SEARCH_LIMIT}
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

function linkedinSearchCriteria() {
  return {
    must_match: [
      'remote roles in the United States',
      'software engineering, data engineering, AI/ML engineering, full-stack, backend, frontend, or data science roles',
      'posted in the last 24 hours',
      'external company application URL when available',
      'English-language listing',
    ],
    exclude: [
      'Easy Apply or LinkedIn-hosted application-only listings',
      'hybrid, onsite, in-office, or office-based roles',
      'DevOps, platform, and cloud-focused engineering roles',
      'job descriptions written primarily in a non-English language',
      'closed listings that no longer accept applications',
    ],
  };
}

async function enrichLinkedInSearchesWithAi(searches, args) {
  const baseSearches = searches.map(cleanWhitespace).filter(Boolean);
  if (!args.aiEnrichSearches) return baseSearches;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('LINKEDIN_AI_ENRICH_SEARCHES is enabled but OPENAI_API_KEY is not set; using configured LinkedIn searches only.');
    return baseSearches;
  }

  try {
    const generatedSearches = await generateLinkedInSearchesWithOpenAi(baseSearches, args, apiKey);
    const enriched = uniqueSearches([...baseSearches, ...generatedSearches]);
    if (args.debug) {
      const baseKeys = new Set(baseSearches.map((search) => search.toLowerCase()));
      const added = enriched.filter((search) => !baseKeys.has(search.toLowerCase()));
      console.log(`LinkedIn AI search enrichment added ${added.length} search term(s): ${added.join(', ')}`);
    }
    return enriched;
  } catch (error) {
    console.warn(`LinkedIn AI search enrichment failed: ${error.message}; using configured LinkedIn searches only.`);
    return baseSearches;
  }
}

async function generateLinkedInSearchesWithOpenAi(searches, args, apiKey) {
  const limit = Math.max(args.aiSearchLimit, 0);
  if (!limit) return [];

  const prompt = {
    task: 'Generate concise LinkedIn job search keyword phrases.',
    existing_searches: searches,
    criteria: linkedinSearchCriteria(),
    rules: [
      `Return at most ${limit} new search phrases.`,
      'Use short keyword phrases only, not full Boolean expressions.',
      'Prefer titles and common title variants likely to find matching roles on LinkedIn.',
      'Do not include excluded workplace modes or excluded role families.',
      'Do not include location, remote, United States, posted-date, or apply-mode words; those are handled by scraper filters.',
      'Avoid duplicates or near-duplicates of existing_searches.',
    ],
  };
  const response = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model: args.aiSearchModel,
      input: [
        {
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'You expand job-board search keywords while preserving strict scraper criteria. Output only JSON matching the schema.',
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify(prompt) }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'linkedin_search_enrichment',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              searches: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['searches'],
          },
        },
      },
    },
    {
      timeout: 30000,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
    },
  );
  const parsed = JSON.parse(responseOutputText(response.data));
  return uniqueSearches((parsed.searches || []).map(sanitizeGeneratedSearch));
}

function responseOutputText(payload) {
  for (const item of payload?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && content.text) return content.text;
    }
  }
  throw new Error('OpenAI response did not include output_text');
}

function sanitizeGeneratedSearch(value) {
  const text = cleanWhitespace(String(value || '').toLowerCase().replace(/[^\w\s+/#.-]+/g, ' '));
  if (!text || text.length > 80) return '';
  if (DISALLOWED_WORKPLACE_PATTERN.test(text) || isExcludedEngineeringRole({ title: text, listingText: text })) return '';
  return text;
}

function uniqueSearches(searches) {
  const output = [];
  const seen = new Set();
  for (const search of searches) {
    const text = cleanWhitespace(search);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

async function resolveSearchSources(args) {
  const urls = [...args.urls, ...(await readUrlFile(args.urlsFile))];
  let searches = args.searches.length ? args.searches : DEFAULT_LINKEDIN_SEARCHES;
  if (!urls.length) searches = await enrichLinkedInSearchesWithAi(searches, args);

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
        const isVisible = (node) => {
          if (!node) return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const hasExternalLinkIcon = (node) => {
          if (!node) return false;
          const iconSelector = 'svg, li-icon, icon, use, [data-test-icon], [data-svg-class-name], [type], [aria-label], [title]';
          const externalIconPattern = /(?:external|offsite|new[-_\s]?window|open[-_\s]?in[-_\s]?new|link[-_\s]?external)/i;
          const iconMatches = (iconNode) => {
            const iconText = [
              iconNode.getAttribute('data-test-icon'),
              iconNode.getAttribute('data-svg-class-name'),
              iconNode.getAttribute('type'),
              iconNode.getAttribute('aria-label'),
              iconNode.getAttribute('title'),
              iconNode.getAttribute('href'),
              iconNode.getAttribute('xlink:href'),
              iconNode.className?.baseVal || iconNode.className,
              iconNode.outerHTML,
            ]
              .filter(Boolean)
              .join(' ');
            return externalIconPattern.test(iconText);
          };
          const isNearControl = (iconNode) => {
            if (node.contains(iconNode)) return true;
            const nodeRect = node.getBoundingClientRect();
            const iconRect = iconNode.getBoundingClientRect();
            if (nodeRect.width <= 0 || nodeRect.height <= 0 || iconRect.width <= 0 || iconRect.height <= 0) return false;
            const overlapsVertically = iconRect.bottom >= nodeRect.top - 6 && iconRect.top <= nodeRect.bottom + 6;
            const nearRightEdge = iconRect.left >= nodeRect.left - 8 && iconRect.left <= nodeRect.right + 56;
            return overlapsVertically && nearRightEdge;
          };
          const candidates = [
            ...node.querySelectorAll(iconSelector),
            ...(node.parentElement ? node.parentElement.querySelectorAll(iconSelector) : []),
          ];
          return candidates.some((iconNode) => iconMatches(iconNode) && isNearControl(iconNode));
        };
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
          const applyButtons = Array.from(card.querySelectorAll('a, button')).filter((node) => {
            const text = clean([node.textContent, node.getAttribute('aria-label')].filter(Boolean).join(' '));
            return /\bapply\b/i.test(text) && isVisible(node);
          });
          const applyButton =
            applyButtons.find((node) => hasExternalLinkIcon(node)) ||
            applyButtons.find((node) => /\beasy\s+apply\b/i.test(clean(node.textContent || node.getAttribute('aria-label') || ''))) ||
            applyButtons[0] ||
            null;
          const applyButtonText = clean(
            [applyButton?.textContent, applyButton?.getAttribute('aria-label')].filter(Boolean).join(' '),
          );
          const applyButtonHref = applyButton?.href || applyButton?.getAttribute('href') || '';
          const applyButtonHasExternalIcon = hasExternalLinkIcon(applyButton);
          const applyMode = applyButton ? (applyButtonHasExternalIcon ? 'External Apply' : 'Easy Apply') : '';
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
              applyMode,
              applyButtonText,
              applyButtonHref,
              applyButtonHasExternalIcon,
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

async function enrichJobDetail(context, job, args) {
  const page = await context.newPage();
  try {
    await page.goto(job.linkedinUrl, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs });
    await page.waitForTimeout(750);
    await page
      .waitForFunction(
        () =>
          Boolean(
            document.evaluate(
              '//*[@id="main-content"]/section[1]/div/section[2]/div/div[1]/div/div/button',
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            ).singleNodeValue,
          ),
        { timeout: Math.min(args.timeoutMs, 5000) },
      )
      .catch(() => {});
    const details = await evaluateWithRetry(page, () => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const applyButton = document.evaluate(
        '//*[@id="main-content"]/section[1]/div/section[2]/div/div[1]/div/div/button',
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
      const applyButtonText = clean([applyButton?.textContent, applyButton?.getAttribute('aria-label')].filter(Boolean).join(' '));
      const applyButtonHasIcon = Boolean(
        applyButton?.querySelector('svg, icon, li-icon, img, use, [class*="icon" i], [data-test-icon], [data-svg-class-name]'),
      );
      const applyButtonHasTextOnly = Boolean(applyButton && isVisible(applyButton) && applyButtonText && !applyButtonHasIcon);
      const descriptionNode = document.querySelector('div.show-more-less-html__markup');
      const applyUrlCode = document.querySelector('code#applyUrl');
      const applyUrlContent = applyUrlCode?.textContent || '';
      const applyMatch = applyUrlContent.match(/\?url=([^"]+)/);
      return {
        description: clean(descriptionNode?.innerText || ''),
        rawApplyUrl: applyMatch ? decodeURIComponent(applyMatch[1]) : '',
        applyButtonText,
        applyButtonHref: applyButton?.href || applyButton?.getAttribute('href') || '',
        applyButtonHasExternalIcon: Boolean(applyButton && !applyButtonHasTextOnly),
        applyMode: applyButton ? (applyButtonHasTextOnly ? 'Easy Apply' : 'External Apply') : '',
        title: clean(document.querySelector('h1')?.textContent),
        company: clean(document.querySelector('.topcard__org-name-link, .topcard__flavor')?.textContent),
        location: clean(document.querySelector('.topcard__flavor--bullet')?.textContent),
      };
    });
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
    await page.close();
  }
}

const TRANSIENT_EVALUATE_ERROR_PATTERN =
  /Execution context was destroyed|Cannot find context|most likely because of a navigation|Frame was detached/i;

async function evaluateWithRetry(page, pageFunction, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.evaluate(pageFunction);
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
  const browser = await chromium.launch({
    headless: args.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent: DEFAULT_USER_AGENT,
  });

  try {
    const allCards = [];
    for (const source of sources) {
      console.log(`Scraping LinkedIn search: ${source.search}`);
      const page = await context.newPage();
      try {
        const cards = await collectJobCards(page, source, args);
        allCards.push(...cards);
        console.log(`LinkedIn search returned ${allCards.length} candidate job(s) so far.`);
      } finally {
        await page.close();
      }
    }

    const detailedJobs = await mapWithConcurrency(allCards, args.detailConcurrency, (job) => enrichJobDetail(context, job, args));
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
    await context.close();
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
