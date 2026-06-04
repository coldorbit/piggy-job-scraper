import 'dotenv/config';
import pg from 'pg';
import { chromium } from 'playwright';
import { proxyRotatorFromEnv } from '../sites/lib/playwrightProxy.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
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

function parseArgs(argv) {
  const args = {
    concurrency: 6,
    limit: 0,
    offset: 0,
    ids: [],
    onlyMissing: false,
    timeoutMs: 20000,
    dryRun: false,
    last24Hours: false,
    latest: false,
    latestPosted: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--concurrency') args.concurrency = Number(next || args.concurrency);
    if (arg === '--concurrency') index += 1;
    if (arg === '--limit') args.limit = Number(next || args.limit);
    if (arg === '--limit') index += 1;
    if (arg === '--offset') args.offset = Number(next || args.offset);
    if (arg === '--offset') index += 1;
    if (arg === '--ids') args.ids.push(...String(next || '').split(','));
    if (arg === '--ids') index += 1;
    if (arg === '--only-missing') args.onlyMissing = true;
    if (arg === '--timeout-ms') args.timeoutMs = Number(next || args.timeoutMs);
    if (arg === '--timeout-ms') index += 1;
    if (arg === '--dry-run') args.dryRun = true;
    if (arg === '--last-24-hours') args.last24Hours = true;
    if (arg === '--latest') args.latest = true;
    if (arg === '--latest-posted') args.latestPosted = true;
  }

  args.concurrency = Math.max(1, args.concurrency || 1);
  args.limit = Math.max(0, args.limit || 0);
  args.offset = Math.max(0, args.offset || 0);
  args.ids = args.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  args.timeoutMs = Math.max(5000, args.timeoutMs || 20000);
  return args;
}

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return url;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function externalDirectJobUrl(value) {
  const text = clean(value);
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

function classifyApplyDetails(details) {
  const directUrl = externalDirectJobUrl(details.rawApplyUrl) || externalDirectJobUrl(details.applyButtonHref);
  if (directUrl || details.externalApplyButton || details.applyButtonHasExternalIcon || details.applyButtonLooksExternal) {
    return 'External Apply';
  }
  if (details.easyApplyButton || details.applyButtonLooksEasy) return 'Easy Apply';
  return 'Unknown';
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
      const applyMode = 'Unknown';
      return {
        applyButtonText,
        applyButtonHref: applyButton?.href || applyButton?.getAttribute('href') || '',
        applyButtonHasExternalIcon,
        applyButtonLooksExternal,
        applyButtonLooksEasy,
        applyButtonCount: applyButton ? 1 : 0,
        hasApplyButton: Boolean(applyButton),
        easyApplyButton: Boolean(easyApplyButton),
        externalApplyButton: Boolean(externalApplyButton),
        applyMode,
        rawApplyUrl: applyMatch ? decodeURIComponent(applyMatch[1]) : '',
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

async function classifyLinkedInJob(page, linkedinUrl, timeoutMs) {
  let details;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(linkedinUrl, { waitUntil: 'commit', timeout: timeoutMs });
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 10000) }).catch(() => {});
    await page.waitForTimeout(750 * attempt);
    await closeLinkedInModalIfOpen(page);
    await waitForApplyButton(page, timeoutMs);

    details = await waitForApplyClassification(page, timeoutMs);

    if (details.applyMode !== 'Unknown' || attempt === 3) break;
  }

  const directUrl = externalDirectJobUrl(details.rawApplyUrl) || externalDirectJobUrl(details.applyButtonHref);
  const applyMode = details.applyMode;

  return {
    ...details,
    directUrl,
    applyMode,
    applyOnExternalSite: applyMode === 'External Apply',
  };
}

async function newLinkedInContext(browser, proxyRotator) {
  const proxy = proxyRotator.next();
  return browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent: DEFAULT_USER_AGENT,
    ...(proxy ? { proxy } : {}),
  });
}

async function fetchRows(client, args) {
  if (args.ids.length) {
    const result = await client.query(
      `
        SELECT id,
               url,
               COALESCE(NULLIF(raw_job->>'linkedinUrl', ''), url) AS linkedin_url
        FROM scraped_jobs
        WHERE lower(source) = 'linkedin'
          AND id = ANY($1::bigint[])
        ORDER BY array_position($1::bigint[], id)
      `,
      [args.ids],
    );
    return result.rows;
  }

  const limitSql = args.limit > 0 ? 'LIMIT $1 OFFSET $2' : 'OFFSET $1';
  const params = args.limit > 0 ? [args.limit, args.offset] : [args.offset];
  const missingSql = args.onlyMissing
    ? "AND COALESCE(raw_job->>'applyMode', '') IN ('', 'Unknown', 'LinkedIn Apply')"
    : '';
  const recencySql = args.last24Hours
    ? "AND COALESCE(posted_at, scraped_at) >= NOW() - INTERVAL '24 hours'"
    : '';
  const orderSql = args.latestPosted
    ? 'COALESCE(posted_at, scraped_at) DESC, id DESC'
    : args.latest
      ? 'COALESCE(scraped_at, posted_at) DESC, id DESC'
      : 'id';
  const result = await client.query(
    `
      SELECT id,
             url,
             COALESCE(NULLIF(raw_job->>'linkedinUrl', ''), url) AS linkedin_url
      FROM scraped_jobs
      WHERE lower(source) = 'linkedin'
        ${missingSql}
        ${recencySql}
      ORDER BY ${orderSql}
      ${limitSql}
    `,
    params,
  );
  return result.rows;
}

async function updateRow(client, row, classification, dryRun) {
  if (dryRun) return { rowCount: 0 };

  const directUrl = classification.applyMode === 'External Apply' ? classification.directUrl || '' : '';
  return client.query(
    `
      WITH existing_url AS (
        SELECT 1
        FROM scraped_jobs
        WHERE url = $3
          AND id <> $1
        LIMIT 1
      )
      UPDATE scraped_jobs
      SET
        url = CASE
          WHEN $3 <> '' AND NOT EXISTS (SELECT 1 FROM existing_url) THEN $3
          ELSE url
        END,
        raw_job = jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(raw_job, '{linkedinUrl}', to_jsonb($2::text), true),
                    '{applyMode}',
                    to_jsonb($4::text),
                    true
                  ),
                  '{applyOnExternalSite}',
                  to_jsonb($5::boolean),
                  true
                ),
                '{applyButtonText}',
                to_jsonb($6::text),
                true
              ),
              '{applyButtonHasExternalIcon}',
              to_jsonb($7::boolean),
              true
            ),
            '{applyButtonHref}',
            to_jsonb($8::text),
            true
          ),
          '{url}',
          to_jsonb(CASE
            WHEN $3 <> '' AND NOT EXISTS (SELECT 1 FROM existing_url) THEN $3
            ELSE url
          END::text),
          true
        ),
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      row.id,
      row.linkedin_url,
      directUrl,
      classification.applyMode,
      classification.applyOnExternalSite,
      classification.applyButtonText || '',
      Boolean(classification.applyButtonHasExternalIcon),
      classification.applyButtonHref || '',
    ],
  );
}

async function mapWithConcurrency(items, concurrency, mapper) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool({
    connectionString: databaseUrl(),
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 8000,
    max: Math.max(args.concurrency + 2, 4),
    query_timeout: 30000,
  });

  const rows = await fetchRows(pool, args);
  console.log(`Backfilling ${rows.length} LinkedIn row(s) with concurrency ${args.concurrency}${args.dryRun ? ' (dry run)' : ''}.`);

  const proxyRotator = proxyRotatorFromEnv('LINKEDIN');
  if (proxyRotator.count) {
    console.log(`LinkedIn proxy rotation enabled with ${proxyRotator.count} proxy endpoint(s).`);
  }
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });

  const stats = { scanned: 0, updated: 0, external: 0, hosted: 0, unknown: 0, failed: 0 };
  try {
    await mapWithConcurrency(rows, args.concurrency, async (row, index) => {
      const context = await newLinkedInContext(browser, proxyRotator);
      const page = await context.newPage();
      try {
        const classification = await classifyLinkedInJob(page, row.linkedin_url, args.timeoutMs);
        const updateResult = await updateRow(pool, row, classification, args.dryRun);
        stats.scanned += 1;
        stats.updated += updateResult.rowCount;
        if (classification.applyMode === 'External Apply') stats.external += 1;
        else if (classification.applyMode === 'Unknown') stats.unknown += 1;
        else stats.hosted += 1;
        console.log(
          `[${index + 1}/${rows.length}] id=${row.id} ${classification.applyMode}` +
            (updateResult.rowCount ? '' : ' (not written)') +
            (classification.directUrl ? ` ${classification.directUrl}` : ''),
        );
      } catch (error) {
        stats.failed += 1;
        console.warn(`[${index + 1}/${rows.length}] id=${row.id} failed: ${error.message}`);
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    });
  } finally {
    await browser.close();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
