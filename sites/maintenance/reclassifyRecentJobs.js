import 'dotenv/config';
import { QueryTypes, Sequelize } from 'sequelize';
import { isAiMlJob, tagJobRoleFamily } from '../lib/jobFilters.js';

const DEFAULT_HOURS = 48;
const MAX_HOURS = 24 * 31;

function parseArgs(argv) {
  let hours = DEFAULT_HOURS;

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
    throw new Error(`Unknown option: ${token}`);
  }

  return { hours };
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
    listingText: row.listing_text || rawJob.listingText || rawJob.description || '',
  };
}

async function updateRecentJobs(database, hours) {
  return database.transaction(async (transaction) => {
    const rows = await database.query(
      `
        SELECT
          id,
          title,
          category,
          ai_ml_area,
          listing_text,
          raw_job,
          is_hidden
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
      aiMlUpdated: 0,
      nonAiMlHidden: 0,
      nonAiMlAlreadyHidden: 0,
    };

    for (const row of rows) {
      const job = jobFromRow(row);

      if (isAiMlJob(job)) {
        const taggedJob = tagJobRoleFamily(job);
        await database.query(
          `
            UPDATE scraped_jobs
            SET
              category = :category,
              ai_ml_area = :aiMlArea,
              raw_job = CAST(:rawJob AS JSONB),
              updated_at = NOW()
            WHERE id = :id
          `,
          {
            replacements: {
              id: row.id,
              category: taggedJob.roleFamily,
              aiMlArea: taggedJob.aiMlArea,
              rawJob: JSON.stringify(taggedJob),
            },
            transaction,
            type: QueryTypes.UPDATE,
          },
        );
        summary.aiMlUpdated += 1;
        continue;
      }

      if (row.is_hidden) {
        summary.nonAiMlAlreadyHidden += 1;
        continue;
      }

      await database.query(
        `
          UPDATE scraped_jobs
          SET
            is_hidden = TRUE,
            hidden_at = COALESCE(hidden_at, NOW()),
            updated_at = NOW()
          WHERE id = :id
        `,
        {
          replacements: { id: row.id },
          transaction,
          type: QueryTypes.UPDATE,
        },
      );
      summary.nonAiMlHidden += 1;
    }

    return summary;
  });
}

async function main() {
  const { hours } = parseArgs(process.argv.slice(2));
  const database = createDatabaseConnection();

  try {
    const summary = await updateRecentJobs(database, hours);
    console.log(`Recent scraped-job update complete: ${JSON.stringify(summary)}`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(`Recent scraped-job update failed: ${error.message}`);
  process.exitCode = 1;
});
