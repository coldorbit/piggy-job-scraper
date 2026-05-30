import crypto from 'node:crypto';
import { DataTypes, Op, Sequelize } from 'sequelize';
import { filterEnglishOnlyJobs, isEnglishOnlyJob, tagJobRoleFamily } from './jobFilters.js';

let sequelize;
let ScrapedJob;
let initialized = false;

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required to store scraped jobs in PostgreSQL');
  }
  return url;
}

function getSequelize() {
  if (!sequelize) {
    sequelize = new Sequelize(databaseUrl(), {
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

  return sequelize;
}

function getScrapedJobModel() {
  if (ScrapedJob) return ScrapedJob;

  ScrapedJob = getSequelize().define(
    'ScrapedJob',
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      url: {
        type: DataTypes.TEXT,
        allowNull: false,
        unique: true,
      },
      duplicateKey: {
        type: DataTypes.TEXT,
        field: 'duplicate_key',
      },
      source: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      sourceUrl: {
        type: DataTypes.TEXT,
        field: 'source_url',
      },
      title: DataTypes.TEXT,
      company: DataTypes.TEXT,
      location: DataTypes.TEXT,
      category: DataTypes.TEXT,
      postedAt: {
        type: DataTypes.DATE,
        field: 'posted_at',
      },
      scrapedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        field: 'scraped_at',
      },
      listingText: {
        type: DataTypes.TEXT,
        field: 'listing_text',
      },
      rawJob: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'raw_job',
      },
      isSpam: {
        type: DataTypes.BOOLEAN,
        field: 'is_spam',
      },
      spamReviewedAt: {
        type: DataTypes.DATE,
        field: 'spam_reviewed_at',
      },
      isHidden: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_hidden',
      },
      hiddenAt: {
        type: DataTypes.DATE,
        field: 'hidden_at',
      },
      firstSeenAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        field: 'first_seen_at',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'updated_at',
      },
    },
    {
      tableName: 'scraped_jobs',
      underscored: true,
      createdAt: 'firstSeenAt',
      updatedAt: 'updatedAt',
      indexes: [
        { fields: ['source'] },
        { fields: ['posted_at'] },
        { fields: ['scraped_at'] },
      ],
    },
  );

  return ScrapedJob;
}

export async function ensureJobsTable() {
  if (initialized) return;
  await getScrapedJobModel().sync();
  await ensureDuplicateKeyColumn();
  await ensureHiddenJobColumns();
  await deleteExistingNonEnglishRows();
  await deleteExistingJobrightNonAutofillApplyRows();
  await backfillRoleFamilies();
  initialized = true;
}

export async function saveJobsToPostgres(jobs) {
  try {
    await ensureJobsTable();

    const languageFilteredJobs = filterEnglishOnlyJobs(jobs.filter((job) => job?.url));
    const rows = dedupeRows(languageFilteredJobs.map(jobToRow));
    if (!rows.length) return { insertedOrUpdated: 0 };
    const filteredRows = await filterExistingRows(rows);
    if (!filteredRows.length) {
      return { insertedOrUpdated: 0, skippedDuplicates: rows.length, savedUrls: [] };
    }

    await getScrapedJobModel().bulkCreate(filteredRows, {
      ignoreDuplicates: true,
    });

    return {
      insertedOrUpdated: filteredRows.length,
      skippedDuplicates: rows.length - filteredRows.length,
      savedUrls: filteredRows.map((row) => row.url),
    };
  } finally {
    await closePostgresConnection();
  }
}

export async function closePostgresConnection() {
  if (!sequelize) return;
  await sequelize.close();
  sequelize = undefined;
  ScrapedJob = undefined;
  initialized = false;
}

function jobToRow(job) {
  const taggedJob = tagJobRoleFamily(job);
  return {
    url: taggedJob.url,
    duplicateKey: duplicateKeyForJob(taggedJob),
    source: taggedJob.source || 'Unknown',
    sourceUrl: taggedJob.sourceUrl || null,
    title: taggedJob.title || null,
    company: taggedJob.company || null,
    location: taggedJob.location || null,
    category: taggedJob.roleFamily,
    postedAt: toDate(taggedJob.postedAt),
    scrapedAt: toDate(taggedJob.scrapedAt) || new Date(),
    listingText: taggedJob.listingText || taggedJob.description || null,
    rawJob: taggedJob,
    isHidden: false,
    updatedAt: new Date(),
  };
}

async function ensureDuplicateKeyColumn() {
  const sequelize = getSequelize();
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('scraped_jobs');

  if (!table.duplicate_key) {
    await queryInterface.addColumn('scraped_jobs', 'duplicate_key', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }

  await backfillDuplicateKeys();
  await deleteExistingDuplicateRows();
}

async function ensureHiddenJobColumns() {
  const sequelize = getSequelize();
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('scraped_jobs');

  if (!table.is_hidden) {
    await queryInterface.addColumn('scraped_jobs', 'is_hidden', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  }

  if (!table.hidden_at) {
    await queryInterface.addColumn('scraped_jobs', 'hidden_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
  }
}

async function backfillDuplicateKeys() {
  const ScrapedJob = getScrapedJobModel();
  let rows;

  do {
    rows = await ScrapedJob.findAll({
      attributes: ['id', 'url', 'title', 'company', 'location', 'rawJob'],
      where: {
        duplicateKey: { [Op.is]: null },
      },
      limit: 1000,
    });

    for (let index = 0; index < rows.length; index += 25) {
      const batch = rows.slice(index, index + 25);
      await Promise.all(
        batch.map((row) =>
          row.update({
            duplicateKey: duplicateKeyForJob({
              ...row.rawJob,
              url: row.url,
              title: row.title,
              company: row.company,
              location: row.location,
            }),
          }),
        ),
      );
    }
  } while (rows.length === 1000);
}

async function deleteExistingDuplicateRows() {
  await getSequelize().query(`
    DELETE FROM scraped_jobs newer
    USING scraped_jobs older
    WHERE newer.duplicate_key IS NOT NULL
      AND newer.duplicate_key = older.duplicate_key
      AND lower(newer.source) = lower(older.source)
      AND newer.id > older.id
  `);
}

async function deleteExistingNonEnglishRows() {
  const ScrapedJob = getScrapedJobModel();
  let rows;
  let lastId = 0;

  do {
    rows = await ScrapedJob.findAll({
      attributes: ['id', 'title', 'company', 'location', 'category', 'listingText', 'rawJob'],
      where: { id: { [Op.gt]: lastId } },
      order: [['id', 'ASC']],
      limit: 1000,
    });
    if (rows.length) lastId = rows.at(-1).id;

    const nonEnglishIds = rows
      .filter(
        (row) =>
          !isEnglishOnlyJob({
            title: row.title,
            company: row.company,
            location: row.location,
            category: row.category,
            listingText: row.listingText,
            rawJob: row.rawJob,
          }),
      )
      .map((row) => row.id);

    if (nonEnglishIds.length) {
      await ScrapedJob.destroy({ where: { id: { [Op.in]: nonEnglishIds } } });
    }
  } while (rows.length === 1000);
}

async function deleteExistingJobrightNonAutofillApplyRows() {
  const [, metadata] = await getSequelize().query(`
    DELETE FROM scraped_jobs
    WHERE lower(source) = 'jobright'
      AND COALESCE(raw_job ->> 'listingText', listing_text, '') ~* 'apply[[:space:]]+now'
      AND lower(COALESCE(raw_job ->> 'applyMode', '')) <> 'apply with autofill'
      AND COALESCE(raw_job ->> 'listingText', listing_text, '') !~* 'apply.{0,40}auto[[:space:]]*fill'
  `);
  const deletedCount = Number(metadata?.rowCount || 0);
  if (deletedCount) {
    console.log(`Deleted ${deletedCount} existing Jobright Apply Now-only card jobs.`);
  }
}

async function backfillRoleFamilies() {
  const ScrapedJob = getScrapedJobModel();
  let rows;
  let lastId = 0;

  do {
    rows = await ScrapedJob.findAll({
      attributes: ['id', 'url', 'sourceUrl', 'title', 'company', 'location', 'category', 'listingText', 'rawJob'],
      where: { id: { [Op.gt]: lastId } },
      order: [['id', 'ASC']],
      limit: 1000,
    });
    if (rows.length) lastId = rows.at(-1).id;

    for (let index = 0; index < rows.length; index += 25) {
      const batch = rows.slice(index, index + 25);
      await Promise.all(
        batch.map((row) => {
          const taggedJob = tagJobRoleFamily({
            ...(row.rawJob || {}),
            url: row.url,
            sourceUrl: row.sourceUrl,
            title: row.title,
            company: row.company,
            location: row.location,
            category: row.category,
            listingText: row.listingText,
          });

          if (row.category === taggedJob.roleFamily && row.rawJob?.roleFamily === taggedJob.roleFamily) {
            return Promise.resolve();
          }

          return row.update({
            category: taggedJob.roleFamily,
            rawJob: {
              ...(row.rawJob || {}),
              roleFamily: taggedJob.roleFamily,
              category: taggedJob.roleFamily,
            },
          });
        }),
      );
    }
  } while (rows.length === 1000);
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = sourceDuplicateKey(row);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function filterExistingRows(rows) {
  const duplicateKeys = rows.map((row) => row.duplicateKey).filter(Boolean);
  const urls = rows.map((row) => row.url).filter(Boolean);
  if (!duplicateKeys.length && !urls.length) return rows;

  const existingRows = await getScrapedJobModel().findAll({
    attributes: ['duplicateKey', 'source', 'url'],
    where: {
      [Op.or]: [
        ...(duplicateKeys.length ? [{ duplicateKey: { [Op.in]: duplicateKeys } }] : []),
        ...(urls.length ? [{ url: { [Op.in]: urls } }] : []),
      ],
    },
  });
  const existingKeys = new Set(existingRows.map(sourceDuplicateKey).filter(Boolean));
  const existingUrls = new Set(existingRows.map((row) => row.url).filter(Boolean));

  return rows.filter((row) => !existingUrls.has(row.url) && !existingKeys.has(sourceDuplicateKey(row)));
}

function sourceDuplicateKey(row) {
  if (!row?.duplicateKey) return '';
  return `${String(row.source || '').toLowerCase()}:${row.duplicateKey}`;
}

function duplicateKeyForJob(job) {
  const title = normalizeIdentity(job.title);
  const company = normalizeIdentity(job.company);
  const location = normalizeLocation(job.location);
  const identity = title && company ? [title, company, location].filter(Boolean).join('|') : normalizeUrl(job.url);
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function normalizeIdentity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|ltd|corp|corporation|co|company)\b\.?/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocation(value) {
  const location = normalizeIdentity(value)
    .replace(/\b(remote|hybrid|onsite|on site|united states|usa|us)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return location || 'remote-us';
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.search = '';
    url.hash = '';
    return url.toString().toLowerCase();
  } catch {
    return normalizeIdentity(value);
  }
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
