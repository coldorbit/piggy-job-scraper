const EXCLUDED_ENGINEERING_ROLE_PATTERN =
  /\b(?:devops|platform|cloud)\s+(?:engineer|developer|architect|specialist|lead|manager|administrator|consultant)s?\b|\b(?:engineer|developer|architect|specialist|lead|manager|administrator|consultant)s?\s+(?:devops|platform|cloud)\b/i;
const NON_ENGLISH_LANGUAGES =
  '(?:portuguese|spanish|french|german|italian|dutch|mandarin|chinese|cantonese|japanese|korean|vietnamese|russian|polish|turkish|arabic|hindi|bengali|urdu|hebrew|thai|indonesian|malay|tagalog|filipino)';
const LANGUAGE_REQUIREMENT_WORDS =
  '(?:bilingual|fluent|fluency|language|languages|native|proficient|proficiency|required|requirement|speak|speaking|verbal|written)';
const NON_ENGLISH_LANGUAGE_REQUIREMENT_PATTERN = new RegExp(
  `\\b${LANGUAGE_REQUIREMENT_WORDS}\\b.{0,60}\\b${NON_ENGLISH_LANGUAGES}\\b|\\b${NON_ENGLISH_LANGUAGES}\\b.{0,60}\\b${LANGUAGE_REQUIREMENT_WORDS}\\b`,
  'i',
);
const ENGLISH_SIGNAL_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'build',
  'by',
  'code',
  'collaborate',
  'data',
  'design',
  'develop',
  'engineer',
  'experience',
  'for',
  'from',
  'in',
  'is',
  'maintain',
  'of',
  'on',
  'or',
  'our',
  'product',
  'remote',
  'software',
  'team',
  'the',
  'to',
  'we',
  'with',
  'work',
  'you',
]);
const SEARCH_CONTEXT_ROLE_FAMILY_PATTERNS = {
  ai_ml: [
    /\b(?:ai|artificial intelligence|machine learning|ml|deep learning|computer vision|nlp|llm|generative ai|data scien(?:ce|tist))\b/i,
  ],
  data: [
    /\b(?:data engineer|data engineering|data analytics|analytics engineer|etl|elt|data warehouse|data pipeline|business intelligence|bi engineer|database engineer)\b/i,
  ],
  software: [
    /\b(?:software engineer|software engineering|software developer|full[ -]?stack|backend|back[ -]?end|frontend|front[ -]?end|web developer|application developer|engineer|developer|engineering)\b/i,
  ],
};

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isExcludedEngineeringRole(job) {
  const titleText = [job?.title, job?.category, job?.jobCategory].filter(Boolean).join(' ');
  if (EXCLUDED_ENGINEERING_ROLE_PATTERN.test(titleText)) return true;

  const listingText = String(job?.listingText || '');
  return EXCLUDED_ENGINEERING_ROLE_PATTERN.test(listingText);
}

export function filterExcludedEngineeringRoles(jobs) {
  return jobs.filter((job) => !isExcludedEngineeringRole(job));
}

export function isEnglishOnlyJob(job) {
  const text = jobTextForLanguageFilter(job);
  if (!text) return true;
  if (NON_ENGLISH_LANGUAGE_REQUIREMENT_PATTERN.test(text)) return false;
  return looksMostlyEnglish(text);
}

export function filterEnglishOnlyJobs(jobs) {
  return jobs.filter(isEnglishOnlyJob);
}

export function roleFamilyForJob(job) {
  return roleFamilyForSearchContext(
    [
      searchTextFromSourceUrl(job?.sourceUrl),
      job?.search,
      job?.searchQuery,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function tagJobRoleFamily(job) {
  const roleFamily = roleFamilyForJob(job);
  return {
    ...job,
    roleFamily,
    category: roleFamily,
  };
}

export function tagJobsWithRoleFamily(jobs) {
  return jobs.map(tagJobRoleFamily);
}

function jobTextForLanguageFilter(job) {
  if (!job) return '';
  const rawJobText = typeof job.rawJob === 'string' ? job.rawJob : JSON.stringify(job.rawJob || '');
  return cleanWhitespace(
    [
      job.title,
      job.company,
      job.location,
      job.category,
      job.jobCategory,
      job.description,
      job.listingText,
      rawJobText,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function looksMostlyEnglish(text) {
  const normalized = cleanWhitespace(text);
  if (!normalized) return true;

  const letters = normalized.match(/\p{L}/gu) || [];
  if (letters.length >= 80) {
    const latinLetters = normalized.match(/\p{Script=Latin}/gu) || [];
    if (latinLetters.length / letters.length < 0.75) return false;
  }

  const words = normalized.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
  if (words.length < 40) return true;

  let signalCount = 0;
  for (const word of words) {
    if (ENGLISH_SIGNAL_WORDS.has(word)) signalCount += 1;
  }

  return signalCount / words.length >= 0.08;
}

function roleFamilyForSearchContext(text) {
  const normalized = cleanWhitespace(text);
  for (const family of ['ai_ml', 'data', 'software']) {
    if (SEARCH_CONTEXT_ROLE_FAMILY_PATTERNS[family].some((pattern) => pattern.test(normalized))) return family;
  }
  return 'software';
}

function searchTextFromSourceUrl(value) {
  if (!value) return '';

  try {
    const url = new URL(String(value));
    const searchParts = [
      url.searchParams.get('keywords'),
      url.searchParams.get('q'),
      url.searchParams.get('query'),
      url.searchParams.get('search'),
      searchQueryFromSearchState(url.searchParams.get('searchState')),
      url.pathname,
    ];
    return decodeURIComponent(searchParts.filter(Boolean).join(' ')).replace(/[-_/+]+/g, ' ');
  } catch {
    return String(value).replace(/[-_/+]+/g, ' ');
  }
}

function searchQueryFromSearchState(value) {
  if (!value) return '';

  try {
    const state = JSON.parse(value);
    return cleanWhitespace(state?.searchQuery || state?.query || state?.keywords || state?.search || '');
  } catch {
    return '';
  }
}
