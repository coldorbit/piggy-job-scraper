import 'dotenv/config';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);
const { Client } = pg;

const DEFAULT_ARGS = {
  batchSize: 1000,
  debug: false,
  dryRun: false,
  jobSpyConcurrency: 5,
  limit: 0,
  jobSpyBatchSize: 25,
  timeoutMs: 300000,
};

function parseArgs(argv) {
  const args = { ...DEFAULT_ARGS };
  const numericOptions = new Map([
    ['--batch-size', 'batchSize'],
    ['--jobspy-batch-size', 'jobSpyBatchSize'],
    ['--jobspy-concurrency', 'jobSpyConcurrency'],
    ['--limit', 'limit'],
    ['--timeout-ms', 'timeoutMs'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    if (token === '--debug') {
      args.debug = true;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    const key = numericOptions.get(token);
    if (!key) throw new Error(`Unknown option: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    args[key] = Number(value);
    if (!Number.isFinite(args[key])) throw new Error(`Expected a number for ${token}, got: ${value}`);
    index += 1;
  }

  return args;
}

function printHelp() {
  console.log(`LinkedIn direct URL backfill

Usage:
  node sites/linkedin/backfill_direct_urls.js [options]

Options:
  --batch-size N       Existing LinkedIn rows to load from DB, default 1000
  --jobspy-batch-size N
                       LinkedIn detail pages to ask JobSpy for per Python call, default 25
  --jobspy-concurrency N
                       Concurrent detail fetches inside the Python bridge, default 5
  --limit N           Maximum DB rows to update, 0 means no limit
  --timeout-ms N      Python bridge timeout, default 300000
  --dry-run           Print what would change without updating the DB
  --debug             Print JobSpy diagnostics
`);
}

async function fetchLinkedInRows(client, args) {
  const limit = args.limit > 0 ? Math.min(args.limit, args.batchSize) : args.batchSize;
  const { rows } = await client.query(
    `
      SELECT id, url, source_url, title, company, raw_job
      FROM scraped_jobs
      WHERE lower(source) = 'linkedin'
        AND url LIKE 'https://www.linkedin.com/%'
      ORDER BY scraped_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  );
  return rows;
}

async function fetchDirectUrlRows(jobIds, args) {
  if (!jobIds.length) return [];
  const helperPath = fileURLToPath(new URL('./jobspy_bridge.py', import.meta.url));
  const python = process.env.LINKEDIN_JOBSPY_PYTHON || process.env.PYTHON || 'python3';
  const config = {
    jobIds,
    debug: args.debug,
    detailConcurrency: args.jobSpyConcurrency,
  };
  const { stdout, stderr } = await execFileAsync(python, [helperPath, JSON.stringify(config)], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: args.timeoutMs,
  });

  if (args.debug && stderr) process.stderr.write(stderr);
  return JSON.parse(stdout || '[]');
}

async function fetchDirectUrls(jobIds, args) {
  const map = new Map();
  for (let index = 0; index < jobIds.length; index += args.jobSpyBatchSize) {
    const batch = jobIds.slice(index, index + args.jobSpyBatchSize);
    const rows = await fetchDirectUrlRows(batch, args);
    for (const row of rows) {
      const directUrl = directUrlFromJobSpyRow(row);
      if (directUrl) map.set(String(row.job_id), directUrl);
    }
    console.log(`Checked ${Math.min(index + batch.length, jobIds.length)} / ${jobIds.length} LinkedIn detail pages.`);
  }
  return map;
}

function linkedinJobIdFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname.endsWith('linkedin.com')) return '';
    const match = parsed.pathname.match(/\/jobs\/view\/(?:.*?-)?(\d+)\/?$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function directUrlFromJobSpyRow(row) {
  const directUrl = clean(row.job_url_direct);
  if (!directUrl || isLinkedInUrl(directUrl)) return '';
  try {
    return new URL(directUrl).toString();
  } catch {
    return '';
  }
}

function isLinkedInUrl(value) {
  try {
    return new URL(value).hostname.endsWith('linkedin.com');
  } catch {
    return false;
  }
}

function clean(value) {
  return String(value || '').trim();
}

async function updateRowUrl(client, row, directUrl, args) {
  if (args.dryRun) return true;
  const { rowCount } = await client.query(
    `
      UPDATE scraped_jobs
      SET url = $2,
          raw_job = jsonb_set(
            jsonb_set(coalesce(raw_job, '{}'::jsonb), '{url}', to_jsonb($2::text), true),
            '{linkedinUrl}',
            to_jsonb($3::text),
            true
          ),
          updated_at = now()
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM scraped_jobs existing
          WHERE existing.url = $2
            AND existing.id <> $1
        )
    `,
    [row.id, directUrl, row.url],
  );
  return rowCount === 1;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    const rows = await fetchLinkedInRows(client, args);
    const rowsWithJobIds = rows
      .map((row) => ({ ...row, linkedinJobId: linkedinJobIdFromUrl(row.url) }))
      .filter((row) => row.linkedinJobId);
    const jobIds = [...new Set(rowsWithJobIds.map((row) => row.linkedinJobId))];
    console.log(`Loaded ${rows.length} LinkedIn rows from DB; ${jobIds.length} have parseable LinkedIn job IDs.`);

    const directUrlsByJobId = await fetchDirectUrls(jobIds, args);
    console.log(`Fetched ${directUrlsByJobId.size} direct JobSpy URL(s).`);

    let matched = 0;
    let updated = 0;
    let skipped = 0;

    for (const dbRow of rowsWithJobIds) {
      const directUrl = directUrlsByJobId.get(dbRow.linkedinJobId);
      if (!directUrl || dbRow.url === directUrl) continue;
      matched += 1;

      const didUpdate = await updateRowUrl(client, dbRow, directUrl, args);
      if (didUpdate) {
        updated += 1;
        dbRow.url = directUrl;
        console.log(`${args.dryRun ? 'Would update' : 'Updated'} #${dbRow.id}: ${dbRow.title} @ ${dbRow.company}`);
      } else {
        skipped += 1;
      }

      if (args.limit > 0 && updated >= args.limit) break;
    }

    console.log(
      `${args.dryRun ? 'Dry run complete' : 'Backfill complete'}: matched ${matched}, updated ${updated}, skipped ${skipped}.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
