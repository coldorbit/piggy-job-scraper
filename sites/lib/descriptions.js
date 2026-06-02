import axios from 'axios';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function decodeHtml(value) {
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

export function cleanHtmlText(value) {
  return cleanWhitespace(decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')));
}

export async function fetchHtml(url, timeoutMs, sourceName = 'detail page') {
  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      responseType: 'text',
      transformResponse: [(data) => data],
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json',
      },
    });
    return response.data;
  } catch (error) {
    if (error.response) throw new Error(`${sourceName} returned ${error.response.status} for ${url}`);
    throw error;
  }
}

export function extractDescriptionFromHtml(html) {
  const jsonDescription = extractDescriptionFromJsonScripts(html);
  if (jsonDescription) return jsonDescription;

  const escapedHtmlDescription = extractDescriptionFromEscapedHtml(html);
  if (escapedHtmlDescription) return escapedHtmlDescription;

  const selectors = [
    /<section[^>]*(?:description|job-description|jobDescription|posting|details)[^>]*>([\s\S]*?)<\/section>/i,
    /<div[^>]*(?:description|job-description|jobDescription|posting|details)[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];

  for (const pattern of selectors) {
    const text = cleanHtmlText(html.match(pattern)?.[1] || '');
    if (text.length > 150) return text;
  }

  const meta =
    matchMetaContent(html, 'description') ||
    matchMetaProperty(html, 'og:description') ||
    matchMetaProperty(html, 'twitter:description');
  return cleanHtmlText(meta);
}

export async function scrapeJobDescription(job, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const sourceName = options.sourceName || job.source || 'job';
  const url = options.urlForJob ? options.urlForJob(job) : job.url;
  if (!url || (job.description && !options.overwriteDescription)) return job;

  try {
    const html = await fetchHtml(url, timeoutMs, sourceName);
    const description = cleanWhitespace(extractDescriptionFromHtml(html)).slice(0, 20000);
    if (!description) return job;
    if (job.description && options.overwriteDescription && description.length <= job.description.length) return job;
    return {
      ...job,
      description,
      listingText: cleanWhitespace([job.listingText, description].filter(Boolean).join(' ')),
    };
  } catch (error) {
    console.warn(`${sourceName} detail scrape skipped for ${url}: ${error.message}`);
    return job;
  }
}

export async function enrichJobDescriptions(jobs, options = {}) {
  if (!jobs.length) return jobs;
  return mapWithConcurrency(jobs, options.concurrency || 3, (job) => scrapeJobDescription(job, options));
}

function extractDescriptionFromJsonScripts(html) {
  const scripts = html.match(/<script[^>]+(?:application\/ld\+json|__NEXT_DATA__)[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try {
      const found = firstDescriptionFromJson(JSON.parse(body));
      if (found) return cleanHtmlText(found);
    } catch {
      try {
        const found = firstDescriptionFromJson(JSON.parse(decodeHtml(body)));
        if (found) return cleanHtmlText(found);
      } catch {
        // Ignore scripts that are not valid JSON after entity decoding.
      }
    }
  }
  return '';
}

function firstDescriptionFromJson(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstDescriptionFromJson(item);
      if (found) return found;
    }
    return '';
  }

  if (value && typeof value === 'object') {
    for (const key of ['description', 'jobDescription', 'job_description', 'content', 'details', 'requirements_summary']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && cleanHtmlText(candidate).length > 120) return candidate;
    }
    for (const child of Object.values(value)) {
      const found = firstDescriptionFromJson(child);
      if (found) return found;
    }
  }

  return '';
}

function extractDescriptionFromEscapedHtml(html) {
  const decoded = decodeJavascriptEscapedHtml(html);
  if (decoded === html) return '';

  const startPatterns = [
    /<span\s+id=["']spandesc["'][^>]*>/i,
    /<div[^>]*(?:description|job-description|jobDescription|posting|details)[^>]*>/i,
    /<section[^>]*(?:description|job-description|jobDescription|posting|details)[^>]*>/i,
  ];

  for (const pattern of startPatterns) {
    const match = pattern.exec(decoded);
    if (!match) continue;

    const start = match.index;
    const end = firstPositiveIndex(
      [
        decoded.indexOf('<form', start),
        decoded.indexOf('id="application', start),
        decoded.indexOf("id='application", start),
        decoded.indexOf('<footer', start),
      ],
      decoded.length,
    );
    const text = cleanWhitespace(
      cleanHtmlText(decoded.slice(start, Math.min(end, start + 40000)))
        .replace(/\\+([’'"`.,;:!?()[\]{}])/g, '$1')
        .replace(/\\+/g, ' '),
    );
    if (text.length > 300) return text;
  }

  return '';
}

function decodeJavascriptEscapedHtml(value) {
  let decoded = String(value || '')
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\n|\\r|\\t/g, ' ')
    .replace(/\\-/g, '-');
  for (let index = 0; index < 3; index += 1) {
    decoded = decoded.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\//g, '/');
  }
  return decoded;
}

function firstPositiveIndex(indexes, fallback) {
  const positives = indexes.filter((index) => index > 0);
  return positives.length ? Math.min(...positives) : fallback;
}

function matchMetaContent(html, name) {
  return (
    html.match(new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRegExp(name)}["']`, 'i'))?.[1] ||
    ''
  );
}

function matchMetaProperty(html, property) {
  return (
    html.match(new RegExp(`<meta[^>]+property=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegExp(property)}["']`, 'i'))?.[1] ||
    ''
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
