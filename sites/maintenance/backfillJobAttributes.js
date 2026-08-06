import 'dotenv/config';
import { backfillJobAttributes, closePostgresConnection } from '../lib/postgres.js';

function parseArgs(argv) {
  const options = { batchSize: 500, force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--force') options.force = true;
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--batch-size') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 5000) {
        throw new Error('--batch-size must be an integer from 1 to 5000');
      }
      options.batchSize = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }
  return options;
}

async function main() {
  try {
    const summary = await backfillJobAttributes(parseArgs(process.argv.slice(2)));
    console.log(`Scraped-job attribute backfill complete: ${JSON.stringify(summary)}`);
  } finally {
    await closePostgresConnection();
  }
}

main().catch((error) => {
  console.error(`Scraped-job attribute backfill failed: ${error.message}`);
  process.exitCode = 1;
});
