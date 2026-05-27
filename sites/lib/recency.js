export const LAST_24_HOURS_MS = 24 * 60 * 60 * 1000;

export function isWithinLast24Hours(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return false;
  const ageMs = now.getTime() - date.getTime();
  return ageMs >= -5 * 60 * 1000 && ageMs <= LAST_24_HOURS_MS;
}

export function parseRelativePostedAt(value, now = new Date()) {
  const text = clean(value).toLowerCase();
  if (!text) return null;
  if (/\b(just now|today|moments ago)\b/i.test(text)) return now;

  const match = text.match(
    /(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months)\s+ago/i,
  );
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
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

export function recentJobWithPostedAt(job, now = new Date()) {
  const postedAt =
    toDate(job.postedAt) ||
    parseRelativePostedAt(job.postedText, now) ||
    parseRelativePostedAt(job.listingText, now);

  if (!isWithinLast24Hours(postedAt, now)) return null;
  return {
    ...job,
    postedAt: postedAt.toISOString(),
  };
}

export function filterJobsPostedWithinLast24Hours(jobs, now = new Date()) {
  return jobs.map((job) => recentJobWithPostedAt(job, now)).filter(Boolean);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
