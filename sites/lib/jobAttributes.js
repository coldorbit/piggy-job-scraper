export const JOB_SENIORITY_VALUES = [
  'intern', 'entry_level', 'junior', 'mid_level', 'senior', 'lead',
  'staff', 'principal', 'manager', 'director', 'executive', 'unknown',
];

export const JOB_WORK_MODE_VALUES = ['remote', 'hybrid', 'onsite', 'unknown'];

const SENIORITY_ALIASES = new Map([
  ['internship', 'intern'], ['intern', 'intern'],
  ['entry', 'entry_level'], ['entry_level', 'entry_level'], ['new_grad', 'entry_level'], ['graduate', 'entry_level'],
  ['junior', 'junior'], ['jr', 'junior'],
  ['mid', 'mid_level'], ['mid_level', 'mid_level'], ['intermediate', 'mid_level'],
  ['senior', 'senior'], ['sr', 'senior'],
  ['lead', 'lead'], ['team_lead', 'lead'], ['staff', 'staff'], ['principal', 'principal'],
  ['manager', 'manager'], ['management', 'manager'], ['director', 'director'], ['head', 'director'],
  ['executive', 'executive'], ['vp', 'executive'], ['vice_president', 'executive'], ['c_level', 'executive'],
  ['unknown', 'unknown'], ['not_specified', 'unknown'],
]);

const WORK_MODE_ALIASES = new Map([
  ['remote', 'remote'], ['fully_remote', 'remote'], ['work_from_home', 'remote'], ['wfh', 'remote'],
  ['hybrid', 'hybrid'], ['onsite', 'onsite'], ['on_site', 'onsite'],
  ['in_office', 'onsite'], ['office', 'onsite'], ['unknown', 'unknown'], ['not_specified', 'unknown'],
]);

const SENIORITY_RULES = [
  { value: 'executive', pattern: /\b(?:chief|c[- ]level|vice president|vp)\b/i },
  { value: 'director', pattern: /\b(?:director|head of)\b/i },
  { value: 'manager', pattern: /\b(?:manager|management)\b/i },
  { value: 'principal', pattern: /\bprincipal\b/i },
  { value: 'staff', pattern: /\bstaff\b/i },
  { value: 'lead', pattern: /\b(?:lead|tech lead|team lead)\b/i },
  { value: 'senior', pattern: /\b(?:senior|sr\.?)(?:\b|\s)/i },
  { value: 'junior', pattern: /\b(?:junior|jr\.?)(?:\b|\s)/i },
  { value: 'entry_level', pattern: /\b(?:entry[- ]level|new grad(?:uate)?|graduate role)\b/i },
  { value: 'intern', pattern: /\b(?:intern|internship|co[- ]?op)\b/i },
  { value: 'mid_level', pattern: /\b(?:mid[- ]level|intermediate)\b/i },
];

export function normalizeJobSeniority(value) {
  const normalized = normalizedValue(value);
  if (!normalized) return '';
  if (SENIORITY_ALIASES.has(normalized)) return SENIORITY_ALIASES.get(normalized);
  return SENIORITY_RULES.find(({ pattern }) => pattern.test(clean(value)))?.value || '';
}

export function inferJobSeniority({ title, seniority, seniorityLevel, rawJob } = {}) {
  const explicit = firstValue(seniority, seniorityLevel, nestedValue(rawJob, [
    'seniority', 'seniorityLevel', 'seniority_level', 'experienceLevel', 'experience_level',
  ]));
  const explicitSeniority = normalizeJobSeniority(explicit);
  if (explicitSeniority && explicitSeniority !== 'unknown') return explicitSeniority;
  return SENIORITY_RULES.find(({ pattern }) => pattern.test(clean(title)))?.value || 'unknown';
}

export function normalizeJobWorkMode(value) {
  if (typeof value === 'boolean') return value ? 'remote' : 'unknown';
  const normalized = normalizedValue(value);
  if (!normalized) return '';
  if (WORK_MODE_ALIASES.has(normalized)) return WORK_MODE_ALIASES.get(normalized);
  if (/\bhybrid\b/i.test(clean(value))) return 'hybrid';
  if (/\b(?:on[- ]?site|in[- ]office|office[- ]based)\b/i.test(clean(value))) return 'onsite';
  if (/\b(?:fully remote|remote|work from home|wfh)\b/i.test(clean(value))) return 'remote';
  return '';
}

export function inferJobWorkMode({ location, listingText, workMode, workplaceType, rawJob } = {}) {
  const explicit = firstValue(workMode, workplaceType, nestedValue(rawJob, [
    'workMode', 'work_mode', 'workplaceType', 'workplace_type', 'remoteType', 'remote_type', 'isRemote', 'is_remote',
  ]));
  const explicitMode = normalizeJobWorkMode(explicit);
  if (explicitMode && explicitMode !== 'unknown') return explicitMode;
  const locationMode = normalizeJobWorkMode(location);
  if (locationMode && locationMode !== 'unknown') return locationMode;

  const description = clean(listingText).slice(0, 50_000);
  if (/\bhybrid (?:role|position|schedule|work|arrangement)\b|\bwork(?:ing)? in a hybrid model\b/i.test(description)) return 'hybrid';
  if (/\b(?:on[- ]?site|in[- ]office|office[- ]based) (?:role|position|schedule|work|arrangement)\b|\bmust work (?:on[- ]?site|in (?:the )?office)\b/i.test(description)) return 'onsite';
  if (/\b(?:fully remote|remote-first|remote (?:role|position|opportunity)|work from home|work remotely)\b/i.test(description)) return 'remote';
  return 'unknown';
}

export function classifyJobAttributes(job = {}) {
  return { seniority: inferJobSeniority(job), workMode: inferJobWorkMode(job) };
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedValue(value) {
  return clean(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? '';
}

function nestedValue(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return '';
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const found = nestedValue(child, keys, depth + 1);
    if (found !== '') return found;
  }
  return '';
}
