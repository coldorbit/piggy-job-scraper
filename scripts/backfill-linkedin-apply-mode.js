import 'dotenv/config';
import pg from 'pg';
import { chromium } from 'playwright';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const args = {
    concurrency: 6,
    limit: 0,
    offset: 0,
    onlyMissing: false,
    timeoutMs: 20000,
    dryRun: false,
    last24Hours: false,
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
    if (arg === '--only-missing') args.onlyMissing = true;
    if (arg === '--timeout-ms') args.timeoutMs = Number(next || args.timeoutMs);
    if (arg === '--timeout-ms') index += 1;
    if (arg === '--dry-run') args.dryRun = true;
    if (arg === '--last-24-hours') args.last24Hours = true;
  }

  args.concurrency = Math.max(1, args.concurrency || 1);
  args.limit = Math.max(0, args.limit || 0);
  args.offset = Math.max(0, args.offset || 0);
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

async function evaluateWithRetry(page, pageFunction, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.evaluate(pageFunction);
    } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|Cannot find context/.test(error.message) || attempt === attempts) break;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  throw lastError;
}

async function classifyLinkedInJob(page, linkedinUrl, timeoutMs) {
  await page.goto(linkedinUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
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
      { timeout: Math.min(timeoutMs, 5000) },
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
    const applyUrlCode = document.querySelector('code#applyUrl');
    const applyUrlContent = applyUrlCode?.textContent || '';
    const applyMatch = applyUrlContent.match(/\?url=([^"]+)/);
    return {
      applyButtonText,
      applyButtonHref: applyButton?.href || applyButton?.getAttribute('href') || '',
      applyButtonHasExternalIcon: Boolean(applyButton && !applyButtonHasTextOnly),
      applyButtonCount: applyButton ? 1 : 0,
      hasApplyButton: Boolean(applyButton),
      applyButtonHasIcon,
      applyButtonHasTextOnly,
      rawApplyUrl: applyMatch ? decodeURIComponent(applyMatch[1]) : '',
    };
  });

  const directUrl = externalDirectJobUrl(details.rawApplyUrl) || externalDirectJobUrl(details.applyButtonHref);
  const applyMode = details.hasApplyButton
    ? details.applyButtonHasTextOnly
      ? 'Easy Apply'
      : 'External Apply'
    : 'Unknown';

  return {
    ...details,
    directUrl,
    applyMode,
    applyOnExternalSite: applyMode === 'External Apply',
  };
}

async function fetchRows(client, args) {
  const limitSql = args.limit > 0 ? 'LIMIT $1 OFFSET $2' : 'OFFSET $1';
  const params = args.limit > 0 ? [args.limit, args.offset] : [args.offset];
  const missingSql = args.onlyMissing
    ? "AND COALESCE(raw_job->>'applyMode', '') IN ('', 'Unknown', 'LinkedIn Apply')"
    : '';
  const recencySql = args.last24Hours
    ? "AND COALESCE(posted_at, scraped_at) >= NOW() - INTERVAL '24 hours'"
    : '';
  const result = await client.query(
    `
      SELECT id,
             url,
             COALESCE(NULLIF(raw_job->>'linkedinUrl', ''), url) AS linkedin_url
      FROM scraped_jobs
      WHERE lower(source) = 'linkedin'
        ${missingSql}
        ${recencySql}
      ORDER BY id
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

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    userAgent: DEFAULT_USER_AGENT,
  });

  const stats = { scanned: 0, updated: 0, external: 0, hosted: 0, unknown: 0, failed: 0 };
  try {
    await mapWithConcurrency(rows, args.concurrency, async (row, index) => {
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
      }
    });
  } finally {
    await context.close();
    await browser.close();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
