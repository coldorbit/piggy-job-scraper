import crypto from 'node:crypto';
import { DataTypes, Op, Sequelize } from 'sequelize';
import {
  filterEnglishOnlyJobs,
  isEnglishOnlyJob,
  tagJobRoleFamily,
} from './jobFilters.js';
import { classifyJobAttributes } from './jobAttributes.js';

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
      dialectOptions: {
        connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 10_000,
        ...(process.env.DATABASE_SSL === 'true'
          ? {
              ssl: {
                require: true,
                rejectUnauthorized: false,
              },
            }
          : {}),
      },
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
      aiMlArea: {
        type: DataTypes.TEXT,
        field: 'ai_ml_area',
      },
      seniority: DataTypes.TEXT,
      workMode: {
        type: DataTypes.TEXT,
        field: 'work_mode',
      },
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
  await ensureAiMlAreaColumn();
  await ensureJobAttributeColumns();
  await ensureHiddenJobColumns();
  await runOptionalExistingRowCleanup();
  initialized = true;
}

export async function saveJobsToPostgres(jobs) {
  try {
    await ensureJobsTable();

    const jobsWithUrls = jobs.filter((job) => job?.url);
    const languageFilteredJobs = filterEnglishOnlyJobs(jobsWithUrls);
    const rows = dedupeRows(languageFilteredJobs.map(jobToRow));
    if (!rows.length) return { insertedOrUpdated: 0, savedUrls: [] };
    const filteredRows = await filterExistingRows(rows);
    if (!filteredRows.length) {
      return {
        insertedOrUpdated: 0,
        skippedDuplicates: rows.length,
        savedUrls: [],
      };
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
  const attributes = classifyJobAttributes({
    ...taggedJob,
    rawJob: taggedJob,
  });
  const attributedJob = { ...taggedJob, ...attributes };
  const isHidden = Boolean(attributedJob.isHidden);
  return {
    url: attributedJob.url,
    duplicateKey: duplicateKeyForJob(attributedJob),
    source: attributedJob.source || 'Unknown',
    sourceUrl: attributedJob.sourceUrl || null,
    title: attributedJob.title || null,
    company: attributedJob.company || null,
    location: attributedJob.location || null,
    category: attributedJob.roleFamily,
    aiMlArea: attributedJob.aiMlArea,
    seniority: attributedJob.seniority,
    workMode: attributedJob.workMode,
    postedAt: toDate(attributedJob.postedAt),
    scrapedAt: toDate(attributedJob.scrapedAt) || new Date(),
    listingText: attributedJob.listingText || attributedJob.description || null,
    rawJob: attributedJob,
    isHidden,
    hiddenAt: isHidden ? new Date() : null,
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
}

export async function backfillJobAttributes({ batchSize = 500, force = false, dryRun = false } = {}) {
  await ensureJobsTable();
  const ScrapedJob = getScrapedJobModel();
  const summary = { reviewed: 0, changed: 0, unchanged: 0, seniority: {}, workMode: {}, dryRun };
  let lastId = 0;
  let rows;

  do {
    const missingAttribute = {
      [Op.or]: [
        { seniority: { [Op.is]: null } },
        { seniority: 'unknown' },
        { workMode: { [Op.is]: null } },
        { workMode: 'unknown' },
      ],
    };
    rows = await ScrapedJob.findAll({
      attributes: ['id', 'title', 'location', 'listingText', 'rawJob', 'seniority', 'workMode'],
      where: {
        id: { [Op.gt]: lastId },
        ...(force ? {} : missingAttribute),
      },
      order: [['id', 'ASC']],
      limit: batchSize,
    });
    if (!rows.length) break;
    lastId = rows.at(-1).id;

    const updatesByAttributes = new Map();
    for (const row of rows) {
      const attributes = classifyJobAttributes({
        ...(row.rawJob || {}),
        title: row.title,
        location: row.location,
        listingText: row.listingText,
        rawJob: row.rawJob,
        seniority: !force && row.seniority !== 'unknown' ? row.seniority : undefined,
        workMode: !force && row.workMode !== 'unknown' ? row.workMode : undefined,
      });
      summary.reviewed += 1;
      summary.seniority[attributes.seniority] = (summary.seniority[attributes.seniority] || 0) + 1;
      summary.workMode[attributes.workMode] = (summary.workMode[attributes.workMode] || 0) + 1;
      if (attributes.seniority === row.seniority && attributes.workMode === row.workMode) {
        summary.unchanged += 1;
        continue;
      }
      summary.changed += 1;
      const key = `${attributes.seniority}:${attributes.workMode}`;
      const update = updatesByAttributes.get(key) || { ...attributes, ids: [] };
      update.ids.push(row.id);
      updatesByAttributes.set(key, update);
    }

    if (!dryRun) {
      await getSequelize().transaction(async (transaction) => {
        await Promise.all([...updatesByAttributes.values()].map((update) =>
          ScrapedJob.update(
            { seniority: update.seniority, workMode: update.workMode },
            { where: { id: { [Op.in]: update.ids } }, transaction, silent: true },
          ),
        ));
      });
    }
  } while (rows.length === batchSize);

  return summary;
}

async function ensureAiMlAreaColumn() {
  const sequelize = getSequelize();
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('scraped_jobs');

  if (!table.ai_ml_area) {
    await queryInterface.addColumn('scraped_jobs', 'ai_ml_area', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }
}

async function ensureJobAttributeColumns() {
  const queryInterface = getSequelize().getQueryInterface();
  const table = await queryInterface.describeTable('scraped_jobs');

  if (!table.seniority) {
    await queryInterface.addColumn('scraped_jobs', 'seniority', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }

  if (!table.work_mode) {
    await queryInterface.addColumn('scraped_jobs', 'work_mode', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }
}

async function runOptionalExistingRowCleanup() {
  if (envFlag('DELETE_EXISTING_DUPLICATE_JOBS')) {
    await deleteExistingDuplicateRows();
  }

  if (envFlag('DELETE_EXISTING_NON_ENGLISH_JOBS')) {
    await deleteExistingNonEnglishRows();
  }
}

function envFlag(name) {
  return String(process.env[name] || '').toLowerCase() === 'true';
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
