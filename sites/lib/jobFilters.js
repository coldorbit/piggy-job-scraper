const EXCLUDED_ENGINEERING_ROLE_PATTERN =
  /\b(?:devops|platform|cloud)\s+(?:engineer|developer|architect|specialist|lead|manager|administrator|consultant)s?\b|\b(?:engineer|developer|architect|specialist|lead|manager|administrator|consultant)s?\s+(?:devops|platform|cloud)\b/i;
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
const NON_ENGLISH_SIGNAL_WORDS = new Set([
  'con',
  'de',
  'del',
  'des',
  'di',
  'el',
  'en',
  'et',
  'la',
  'las',
  'le',
  'les',
  'los',
  'para',
  'por',
  'und',
  'une',
  'vous',
]);
export const AI_ML_JOB_SEARCHES = [
  'machine learning engineer',
  'ai engineer',
  'artificial intelligence engineer',
  'data scientist',
  'applied scientist',
  'research scientist machine learning',
  'deep learning engineer',
];

const AI_ML_AREA_PATTERNS = [
  {
    category: 'multimodal_ml',
    patterns: [/\bmulti[- ]?modal(?:ity)?\b/i],
  },
  {
    category: 'generative_ai',
    patterns: [
      /\b(?:gen(?:erative)?[ -]?ai|large language models?|llms?|foundation models?|prompt engineer(?:ing)?|diffusion models?)\b/i,
      /\b(?:retrieval[ -]?augmented generation|rag)\b/i,
    ],
  },
  {
    category: 'speech_audio_ml',
    patterns: [
      /\b(?:speech|audio|acoustic|voice ai|voice recognition|speaker recognition)\b/i,
      /\b(?:automatic speech recognition|asr|text[ -]?to[ -]?speech|tts)\b/i,
    ],
  },
  {
    category: 'recommendation_systems',
    patterns: [
      /\b(?:recommendation systems?|recommender systems?|recommendations?|recommenders?|personalization)\b/i,
      /\b(?:learning to rank|ranking systems?|ads relevance)\b/i,
    ],
  },
  {
    category: 'time_series_forecasting',
    patterns: [
      /\b(?:time[ -]?series|forecasting|forecast models?|demand forecast(?:ing)?|demand prediction)\b/i,
    ],
  },
  {
    category: 'anomaly_fraud_detection',
    patterns: [
      /\b(?:anomaly detection|anomalous behavior|outlier detection|fraud|fraudulent)\b/i,
      /\b(?:financial crime|anti[ -]?money laundering)\b/i,
    ],
  },
  {
    category: 'graph_ml',
    patterns: [
      /\b(?:graph machine learning|graph ml|graph neural networks?|gnns?|knowledge graphs?|geometric deep learning)\b/i,
    ],
  },
  {
    category: 'robotics_control',
    patterns: [
      /\b(?:robotics?|robotic systems?|control systems?|controls? engineer(?:ing)?|control theory|motion planning)\b/i,
      /\b(?:autonomous systems?|autonomous vehicles?|reinforcement learning)\b/i,
    ],
  },
  {
    category: 'computer_vision',
    patterns: [
      /\b(?:computer vision|machine vision|visual perception|image recognition|image segmentation)\b/i,
      /\b(?:object detection|object tracking|video understanding|optical character recognition|ocr)\b/i,
    ],
  },
  {
    category: 'nlp',
    patterns: [
      /\b(?:natural language processing|nlp|computational linguistics|language understanding)\b/i,
      /\b(?:text classification|text mining|information extraction|named entit(?:y|ies)|semantic search)\b/i,
    ],
  },
  {
    category: 'tabular_ml',
    patterns: [
      /\b(?:tabular (?:data|machine learning|ml)|structured data model(?:ing|ling)?|gradient boost(?:ing|ed)?)\b/i,
      /\b(?:xgboost|lightgbm|catboost)\b/i,
    ],
  },
];

const AI_ML_TITLE_PATTERN =
  /\b(?:ai|artificial intelligence|machine learning|ml|deep learning|data scientist|applied scientist|computer vision|machine vision|natural language processing|nlp|large language models?|llms?|generative ai|multi[- ]?modal|graph neural networks?|gnns?|reinforcement learning)\b/i;
const AI_ML_DESCRIPTION_PATTERN =
  /\b(?:ai|artificial intelligence|machine learning|ml|deep learning|data science|neural networks?|computer vision|machine vision|natural language processing|nlp|large language models?|llms?|foundation models?|generative ai|multi[- ]?modal|graph neural networks?|gnns?|reinforcement learning|gradient boost(?:ing|ed)?|xgboost|lightgbm|catboost)\b/i;
const AI_ML_WORK_PATTERN =
  /\b(?:build|building|built|create|creating|develop|developing|design|designing|deploy|deploying|implement|implementing|improve|improving|optimize|optimizing|own|owning|research|researching|train|training|trained|productioniz(?:e|ing)|model|models|modeling|modelling|inference|prediction|predictive)\b/i;
const AI_ML_MODELING_PATTERN =
  /\b(?:model|models|modeling|modelling|train|training|trained|inference|prediction|predictive|neural networks?|learning algorithms?)\b/i;

const SEARCH_CONTEXT_ROLE_FAMILY_PATTERNS = {
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
  return looksMostlyEnglish(text);
}

export function filterEnglishOnlyJobs(jobs) {
  return jobs.filter(isEnglishOnlyJob);
}

export function isAiMlJob(job) {
  const titleText = cleanWhitespace(job?.title);
  const descriptionText = cleanWhitespace([job?.description, job?.listingText].filter(Boolean).join(' '));
  return hasAiMlEvidence(titleText, descriptionText);
}

export function filterAiMlJobs(jobs) {
  return jobs.filter(isAiMlJob);
}

export function roleFamilyForJob(job) {
  return classifyJob(job).roleFamily;
}

export function aiMlAreaForJob(job) {
  return classifyJob(job).aiMlArea;
}

export function tagJobRoleFamily(job) {
  const { roleFamily, aiMlArea } = classifyJob(job);
  return {
    ...job,
    roleFamily,
    category: roleFamily,
    aiMlArea: aiMlArea || null,
  };
}

export function tagJobsWithRoleFamily(jobs) {
  return jobs.map(tagJobRoleFamily);
}

function classifyJob(job) {
  const titleText = cleanWhitespace(job?.title);
  const searchText = cleanWhitespace(
    [
      searchTextFromSourceUrl(job?.sourceUrl),
      job?.search,
      job?.searchQuery,
    ]
      .filter(Boolean)
      .join(' '),
  );
  const descriptionText = cleanWhitespace(job?.description || job?.listingText);
  const descriptionArea = aiMlAreaForDescription(descriptionText);
  const searchArea = singleAiMlAreaForText(searchText);
  const isAiMl = hasAiMlEvidence(titleText, descriptionText);

  if (isAiMl) {
    return {
      roleFamily: aiMlRoleCategoryForTitle(titleText),
      aiMlArea: descriptionArea || searchArea || 'other_ai_ml',
    };
  }

  const titleRoleFamily = roleFamilyForTitle(titleText);
  const roleFamily = titleRoleFamily || roleFamilyForSearchContext(searchText);
  return {
    roleFamily,
    aiMlArea: '',
  };
}

function aiMlRoleCategoryForTitle(title) {
  const normalized = cleanWhitespace(title);
  if (/\bdata scientist(?:s)?\b/i.test(normalized)) return 'data_scientist';
  if (/\bapplied scientist(?:s)?\b/i.test(normalized)) return 'applied_scientist';
  if (
    /\b(?:research scientist|machine learning scientist|ml scientist|ai scientist|artificial intelligence scientist)s?\b/i.test(
      normalized,
    )
  ) {
    return 'research_scientist';
  }
  if (/\b(?:engineer|developer|architect)\b/i.test(normalized)) return 'ml_engineer';
  return 'other_ai_ml';
}

function jobTextForLanguageFilter(job) {
  if (!job) return '';
  const description = cleanWhitespace(job.description);
  if (description.length >= 80) return description;

  const listingText = cleanWhitespace(job.listingText);
  if (listingText.length >= 80) return listingText;

  return cleanWhitespace([job.title, job.category, job.jobCategory, description, listingText].filter(Boolean).join(' '));
}

function looksMostlyEnglish(text) {
  const normalized = cleanWhitespace(text);
  if (!normalized) return true;

  const letters = normalized.match(/\p{L}/gu) || [];
  if (letters.length >= 20) {
    const latinLetters = normalized.match(/\p{Script=Latin}/gu) || [];
    if (latinLetters.length / letters.length < 0.75) return false;
  }

  const words = normalized.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
  if (words.length < 12) return true;

  let signalCount = 0;
  let nonEnglishSignalCount = 0;
  for (const word of words) {
    if (ENGLISH_SIGNAL_WORDS.has(word)) signalCount += 1;
    if (NON_ENGLISH_SIGNAL_WORDS.has(word)) nonEnglishSignalCount += 1;
  }

  if (signalCount / words.length >= 0.08) return true;
  if (words.length < 40 && nonEnglishSignalCount <= 1) return true;
  return false;
}

function roleFamilyForSearchContext(text) {
  const normalized = cleanWhitespace(text);
  for (const family of ['data', 'software']) {
    if (SEARCH_CONTEXT_ROLE_FAMILY_PATTERNS[family].some((pattern) => pattern.test(normalized))) return family;
  }
  return 'software';
}

function roleFamilyForTitle(title) {
  const normalized = cleanWhitespace(title);
  if (!normalized) return '';

  const titleRoleFamilyPatterns = {
    data: [
      /\b(?:data engineer|data engineering|analytics engineer|data analyst|business intelligence|bi engineer|etl|elt|data warehouse|data pipeline|database engineer|database administrator|dba)\b/i,
    ],
    software: [
      /\b(?:software engineer|software developer|full[ -]?stack|backend|back[ -]?end|frontend|front[ -]?end|web developer|application developer|mobile developer|ios developer|android developer|qa engineer|quality assurance|test engineer|sdet)\b/i,
    ],
  };

  for (const family of ['data', 'software']) {
    if (titleRoleFamilyPatterns[family].some((pattern) => pattern.test(normalized))) return family;
  }
  return '';
}

function aiMlAreasForText(text) {
  const normalized = cleanWhitespace(text);
  if (!normalized) return [];

  return AI_ML_AREA_PATTERNS.filter(({ patterns }) =>
    patterns.some((pattern) => pattern.test(normalized)),
  ).map(({ category }) => category);
}

function aiMlAreaForText(text) {
  const matches = aiMlAreasForText(text);
  if (matches.includes('multimodal_ml')) return 'multimodal_ml';
  return matches.length === 1 ? matches[0] : '';
}

function aiMlAreaForDescription(text) {
  const normalized = cleanWhitespace(text);
  if (!normalized) return '';

  const scores = AI_ML_AREA_PATTERNS.map(({ category, patterns }) => ({
    category,
    score: patterns.reduce(
      (total, pattern) => total + patternMatchCount(pattern, normalized),
      0,
    ),
  })).filter(({ score }) => score > 0);
  if (!scores.length) return '';

  // "Multimodal" is itself a precise specialty even when the description also
  // names its component modalities, such as vision, language, or speech.
  if (scores.some(({ category }) => category === 'multimodal_ml')) return 'multimodal_ml';

  const highestScore = Math.max(...scores.map(({ score }) => score));
  const winners = scores.filter(({ score }) => score === highestScore);
  return winners.length === 1 ? winners[0].category : '';
}

function patternMatchCount(pattern, text) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].length;
}

function singleAiMlAreaForText(text) {
  return aiMlAreaForText(text);
}

function hasAiMlEvidence(titleText, descriptionText) {
  const normalizedTitle = cleanWhitespace(titleText);
  const normalizedDescription = cleanWhitespace(descriptionText);

  if (AI_ML_TITLE_PATTERN.test(normalizedTitle)) return true;
  if (hasExplicitAiMlResponsibility(normalizedDescription)) return true;

  return descriptionSegments(normalizedDescription).some(
    (segment) =>
      aiMlAreasForText(segment).length > 0 &&
      AI_ML_MODELING_PATTERN.test(segment),
  );
}

function hasExplicitAiMlResponsibility(text) {
  return descriptionSegments(text)
    .some(
      (segment) =>
        AI_ML_DESCRIPTION_PATTERN.test(segment) &&
        AI_ML_WORK_PATTERN.test(segment),
    );
}

function descriptionSegments(text) {
  return String(text || '').split(/(?:[.!?;]|\r?\n)+/);
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
