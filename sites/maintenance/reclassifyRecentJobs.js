import 'dotenv/config';
import { QueryTypes, Sequelize } from 'sequelize';
import { tagJobRoleFamily } from '../lib/jobFilters.js';
import { classifyJobAttributes } from '../lib/jobAttributes.js';

const DEFAULT_HOURS = 48;
const MAX_HOURS = 24 * 31;

function parseArgs(argv) {
  let hours = DEFAULT_HOURS;
  let restoreHiddenFrom = '';
  let restoreHiddenTo = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--hours') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_HOURS) {
        throw new Error(`--hours must be an integer from 1 to ${MAX_HOURS}`);
      }
      hours = value;
      index += 1;
      continue;
    }
    if (token === '--restore-hidden-from' || token === '--restore-hidden-to') {
      const value = argv[index + 1];
      const date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) {
        throw new Error(`${token} must be a valid ISO date`);
      }
      if (token === '--restore-hidden-from') restoreHiddenFrom = date.toISOString();
      if (token === '--restore-hidden-to') restoreHiddenTo = date.toISOString();
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  if (Boolean(restoreHiddenFrom) !== Boolean(restoreHiddenTo)) {
    throw new Error('--restore-hidden-from and --restore-hidden-to must be used together');
  }
  if (
    restoreHiddenFrom &&
    new Date(restoreHiddenFrom).getTime() >= new Date(restoreHiddenTo).getTime()
  ) {
    throw new Error('--restore-hidden-from must be earlier than --restore-hidden-to');
  }

  return { hours, restoreHiddenFrom, restoreHiddenTo };
}

function createDatabaseConnection() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to update recent scraped jobs');
  }

  return new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions:
      process.env.DATABASE_SSL === 'true'
        ? {
            ssl: {
              require: true,
              rejectUnauthorized: false,
            },
          }
        : {},
  });
}

function jobFromRow(row) {
  const rawJob =
    row.raw_job && typeof row.raw_job === 'object' && !Array.isArray(row.raw_job)
      ? row.raw_job
      : {};

  return {
    ...rawJob,
    title: row.title || rawJob.title || '',
    location: row.location || rawJob.location || '',
    listingText: row.listing_text || rawJob.listingText || rawJob.description || '',
  };
}

function hiddenByMaintenanceRun(row, restoreHiddenFrom, restoreHiddenTo) {
  if (!row.is_hidden || !row.hidden_at || !restoreHiddenFrom || !restoreHiddenTo) return false;
  const hiddenAt = new Date(row.hidden_at).getTime();
  return (
    hiddenAt >= new Date(restoreHiddenFrom).getTime() &&
    hiddenAt <= new Date(restoreHiddenTo).getTime()
  );
}

async function updateRecentJobs(database, options) {
  const { hours, restoreHiddenFrom, restoreHiddenTo } = options;
  return database.transaction(async (transaction) => {
    const rows = await database.query(
      `
        SELECT
          id,
          title,
          location,
          category,
          ai_ml_area,
          seniority,
          work_mode,
          listing_text,
          raw_job,
          is_hidden,
          hidden_at
        FROM scraped_jobs
        WHERE scraped_at >= NOW() - make_interval(hours => :hours)
        ORDER BY id
        FOR UPDATE
      `,
      {
        replacements: { hours },
        transaction,
        type: QueryTypes.SELECT,
      },
    );

    const summary = {
      hours,
      reviewed: rows.length,
      rolesUpdated: 0,
      hiddenRestored: 0,
      categories: {},
    };

    for (const row of rows) {
      const job = jobFromRow(row);
      const taggedJob = tagJobRoleFamily(job);
      const attributes = classifyJobAttributes({
        ...taggedJob,
        rawJob: taggedJob,
        seniority: row.seniority,
        workMode: row.work_mode,
      });
      const attributedJob = { ...taggedJob, ...attributes };
      const restoreHidden = hiddenByMaintenanceRun(
        row,
        restoreHiddenFrom,
        restoreHiddenTo,
      );

      await database.query(
        `
          UPDATE scraped_jobs
          SET
            category = :category,
            ai_ml_area = :aiMlArea,
            seniority = :seniority,
            work_mode = :workMode,
            raw_job = CAST(:rawJob AS JSONB),
            is_hidden = CASE WHEN :restoreHidden THEN FALSE ELSE is_hidden END,
            hidden_at = CASE WHEN :restoreHidden THEN NULL ELSE hidden_at END,
            updated_at = NOW()
          WHERE id = :id
        `,
        {
          replacements: {
            id: row.id,
            category: taggedJob.roleFamily,
            aiMlArea: taggedJob.aiMlArea,
            seniority: attributedJob.seniority,
            workMode: attributedJob.workMode,
            rawJob: JSON.stringify(attributedJob),
            restoreHidden,
          },
          transaction,
          type: QueryTypes.UPDATE,
        },
      );
      summary.rolesUpdated += 1;
      summary.categories[taggedJob.roleFamily] =
        (summary.categories[taggedJob.roleFamily] || 0) + 1;
      if (restoreHidden) summary.hiddenRestored += 1;
    }

    return summary;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const database = createDatabaseConnection();

  try {
    const summary = await updateRecentJobs(database, options);
    console.log(`Recent scraped-job update complete: ${JSON.stringify(summary)}`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(`Recent scraped-job update failed: ${error.message}`);
  process.exitCode = 1;
});
