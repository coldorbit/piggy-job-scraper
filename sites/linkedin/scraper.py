#!/usr/bin/env python3
import argparse
import contextlib
import csv
import hashlib
import json
import math
import os
import re
import signal
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen


LINKEDIN_BASE_URL = "https://www.linkedin.com"
DEFAULT_LINKEDIN_SEARCHES = [
    "software engineer",
    "data engineer",
    "machine learning engineer",
    "ai engineer",
    "artificial intelligence engineer",
    "full stack engineer",
    "backend engineer",
    "frontend engineer",
    "data scientist",
]
DEFAULT_LINKEDIN_AI_SEARCH_MODEL = "gpt-4.1-mini"
DEFAULT_LINKEDIN_AI_SEARCH_LIMIT = 12
OUTPUT_FIELDS = ["title", "company", "location", "postedAt", "description", "url", "source", "sourceUrl", "scrapedAt", "listingText"]
EXCLUDED_ENGINEERING_ROLE_PATTERN = re.compile(
    r"\b(?:devops|platform|cloud)\s+(?:engineer|developer|architect|specialist|lead|manager|administrator|consultant)s?\b"
    r"|\b(?:engineer|developer|architect|specialist|lead|manager|administrator|consultant)s?\s+(?:devops|platform|cloud)\b",
    re.I,
)
NON_ENGLISH_LANGUAGES = (
    r"(?:portuguese|spanish|french|german|italian|dutch|mandarin|chinese|cantonese|japanese|korean|"
    r"vietnamese|russian|polish|turkish|arabic|hindi|bengali|urdu|hebrew|thai|indonesian|malay|tagalog|filipino)"
)
LANGUAGE_REQUIREMENT_WORDS = (
    r"(?:bilingual|fluent|fluency|language|languages|native|proficient|proficiency|required|requirement|speak|speaking|verbal|written)"
)
NON_ENGLISH_LANGUAGE_REQUIREMENT_PATTERN = re.compile(
    rf"\b{LANGUAGE_REQUIREMENT_WORDS}\b.{{0,60}}\b{NON_ENGLISH_LANGUAGES}\b"
    rf"|\b{NON_ENGLISH_LANGUAGES}\b.{{0,60}}\b{LANGUAGE_REQUIREMENT_WORDS}\b",
    re.I,
)
DISALLOWED_WORKPLACE_PATTERN = re.compile(
    r"\b(?:hybrid|on[\s-]?site|in[\s-]?office|office[\s-]?based|work\s+from\s+(?:the\s+)?office)\b",
    re.I,
)
DISALLOWED_WORKPLACE_SQL_PATTERN = (
    r"(hybrid|on[[:space:]-]?site|in[[:space:]-]?office|office[[:space:]-]?based|work[[:space:]]+from[[:space:]]+(the[[:space:]]+)?office)"
)
LINKEDIN_CLOSED_APPLICATION_PATTERN = re.compile(r"\bno\s+longer\s+accepting\s+applications\b", re.I)
LINKEDIN_HOSTED_APPLY_MODES = {"LinkedIn Apply", "Easy Apply"}
ENGLISH_SIGNAL_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "build", "by", "code", "collaborate", "data", "design", "develop",
    "engineer", "experience", "for", "from", "in", "is", "maintain", "of", "on", "or", "our", "product", "remote",
    "software", "team", "the", "to", "we", "with", "work", "you",
}
ROLE_FAMILY_PATTERNS = {
    "ai_ml": [re.compile(r"\b(?:ai|artificial intelligence|machine learning|ml|deep learning|computer vision|nlp|llm|generative ai|data scien(?:ce|tist))\b", re.I)],
    "data": [re.compile(r"\b(?:data engineer|data engineering|data analytics|analytics engineer|etl|elt|data warehouse|data pipeline|business intelligence|bi engineer|database engineer)\b", re.I)],
    "software": [re.compile(r"\b(?:software engineer|software engineering|software developer|full[ -]?stack|backend|back[ -]?end|frontend|front[ -]?end|web developer|application developer|engineer|developer|engineering)\b", re.I)],
}


def load_dotenv():
    env_path = Path(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env_list(value):
    return [item.strip() for item in re.split(r"\r?\n|,", value or "") if item.strip()]


def clean_whitespace(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def clean_description(value):
    text = re.sub(r"<[^>]*>", " ", str(value or ""))
    text = re.sub(r"!\[[^\]]*]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)]\([^)]*\)", r"\1", text)
    return clean_whitespace(re.sub(r"[*_`>#-]+", " ", text))


def sanitize(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    return value


def dataframe_records(dataframe):
    if dataframe is None or dataframe.empty:
        return []
    return [sanitize(record) for record in dataframe.to_dict(orient="records")]


def parse_args(argv):
    if argv and argv[0] == "--":
        argv = argv[1:]
    parser = argparse.ArgumentParser(description="Scrape LinkedIn jobs with python-jobspy.")
    parser.add_argument("--search", action="append", dest="searches", default=[])
    parser.add_argument("--url", action="append", dest="urls", default=[])
    parser.add_argument("--urls-file", default="")
    parser.add_argument("--output-json", default="results/linkedin/jobs.json")
    parser.add_argument("--output-csv", default="results/linkedin/jobs.csv")
    parser.add_argument("--slack-webhook-url", default=os.environ.get("SLACK_WEBHOOK_URL", ""))
    parser.add_argument("--slack-channel", default=os.environ.get("SLACK_CHANNEL", ""))
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--watch-interval-minutes", type=int, default=5)
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--detail-concurrency", type=int, default=3, help="Backward-compatible no-op.")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--timeout-ms", type=int, default=60000, help="Backward-compatible no-op.")
    parser.add_argument("--ai-enrich-searches", action="store_true", default=env_bool(os.environ.get("LINKEDIN_AI_ENRICH_SEARCHES")))
    parser.add_argument("--no-ai-enrich-searches", action="store_true")
    parser.add_argument("--ai-search-model", default=os.environ.get("LINKEDIN_AI_SEARCH_MODEL", DEFAULT_LINKEDIN_AI_SEARCH_MODEL))
    parser.add_argument("--ai-search-limit", type=int, default=int(os.environ.get("LINKEDIN_AI_SEARCH_LIMIT", DEFAULT_LINKEDIN_AI_SEARCH_LIMIT)))
    parser.add_argument("--no-slack", action="store_true")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)
    args.searches = env_list(os.environ.get("LINKEDIN_SEARCHES") or os.environ.get("LINKEDIN_SEARCH")) + args.searches
    args.urls = env_list(os.environ.get("LINKEDIN_URLS")) + args.urls
    if args.no_ai_enrich_searches:
        args.ai_enrich_searches = False
    if args.no_slack:
        args.slack_webhook_url = ""
    return args


def env_bool(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def read_url_file(path):
    if not path:
        return []
    return [line.strip() for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip() and not line.strip().startswith("#")]


def search_url(search, start=0):
    return f"{LINKEDIN_BASE_URL}/jobs-guest/jobs/api/seeMoreJobPostings/search?{urlencode({'keywords': search, 'location': 'United States', 'f_WT': '2', 'f_TPR': 'r86400', 'start': str(start)})}"


def linkedin_search_criteria():
    return {
        "must_match": [
            "remote roles in the United States",
            "software engineering, data engineering, AI/ML engineering, full-stack, backend, frontend, or data science roles",
            "posted in the last 24 hours",
            "external company application URL when available",
            "English-language listing",
        ],
        "exclude": [
            "Easy Apply or LinkedIn-hosted application-only listings",
            "hybrid, onsite, in-office, or office-based roles",
            "DevOps, platform, and cloud-focused engineering roles",
            "roles requiring non-English fluency",
            "closed listings that no longer accept applications",
        ],
    }


def enrich_linkedin_searches_with_ai(searches, args):
    base_searches = [clean_whitespace(search) for search in searches if clean_whitespace(search)]
    if not args.ai_enrich_searches:
        return base_searches

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("LINKEDIN_AI_ENRICH_SEARCHES is enabled but OPENAI_API_KEY is not set; using configured LinkedIn searches only.", file=sys.stderr, flush=True)
        return base_searches

    try:
        generated_searches = generate_linkedin_searches_with_openai(base_searches, args, api_key)
    except Exception as error:
        print(f"LinkedIn AI search enrichment failed: {error}; using configured LinkedIn searches only.", file=sys.stderr, flush=True)
        return base_searches

    searches = unique_searches([*base_searches, *generated_searches])
    if args.debug:
        added = [search for search in searches if search not in set(base_searches)]
        print(f"LinkedIn AI search enrichment added {len(added)} search term(s): {', '.join(added)}", file=sys.stderr, flush=True)
    return searches


def generate_linkedin_searches_with_openai(searches, args, api_key):
    limit = max(args.ai_search_limit, 0)
    if not limit:
        return []

    prompt = {
        "task": "Generate concise LinkedIn job search keyword phrases.",
        "existing_searches": searches,
        "criteria": linkedin_search_criteria(),
        "rules": [
            f"Return at most {limit} new search phrases.",
            "Use short keyword phrases only, not full Boolean expressions.",
            "Prefer titles and common title variants likely to find matching roles on LinkedIn.",
            "Do not include excluded workplace modes or excluded role families.",
            "Do not include location, remote, United States, posted-date, or apply-mode words; those are handled by scraper filters.",
            "Avoid duplicates or near-duplicates of existing_searches.",
        ],
    }
    request_body = {
        "model": args.ai_search_model,
        "input": [
            {
                "role": "developer",
                "content": [
                    {
                        "type": "input_text",
                        "text": "You expand job-board search keywords while preserving strict scraper criteria. Output only JSON matching the schema.",
                    }
                ],
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": json.dumps(prompt, ensure_ascii=False)}],
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "linkedin_search_enrichment",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "searches": {
                            "type": "array",
                            "items": {"type": "string"},
                        }
                    },
                    "required": ["searches"],
                },
            }
        },
    }
    request = Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(request_body).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    content = response_output_text(payload)
    parsed = json.loads(content)
    return unique_searches(sanitize_generated_search(search) for search in parsed.get("searches") or [])


def response_output_text(payload):
    for item in payload.get("output") or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if content.get("type") == "output_text" and content.get("text"):
                return content["text"]
    raise ValueError("OpenAI response did not include output_text")


def sanitize_generated_search(value):
    text = clean_whitespace(value).lower()
    text = re.sub(r"[^\w\s+/#.-]+", " ", text)
    text = clean_whitespace(text)
    if not text or len(text) > 80:
        return ""
    if DISALLOWED_WORKPLACE_PATTERN.search(text) or EXCLUDED_ENGINEERING_ROLE_PATTERN.search(text):
        return ""
    return text


def unique_searches(searches):
    output = []
    seen = set()
    for search in searches:
        text = clean_whitespace(search)
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        output.append(text)
    return output


def resolve_search_sources(args):
    urls = [*args.urls, *read_url_file(args.urls_file)]
    searches = args.searches or DEFAULT_LINKEDIN_SEARCHES
    if not urls:
        searches = enrich_linkedin_searches_with_ai(searches, args)
    source_urls = list(dict.fromkeys(urls or [search_url(search) for search in searches]))
    search_sources = []
    seen = set()
    for source_url in source_urls:
        parsed = urlparse(source_url)
        if not parsed.hostname or not parsed.hostname.endswith("linkedin.com"):
            raise ValueError(f"Expected a linkedin.com URL, got: {source_url}")
        search = clean_whitespace(parse_qs(parsed.query).get("keywords", [""])[0])
        if not search:
            raise ValueError(f"LinkedIn JobSpy scraping requires a search URL with a keywords parameter: {source_url}")
        if search not in seen:
            seen.add(search)
            search_sources.append({"search": search, "sourceUrl": source_url})
    return search_sources


def scrape_linkedin_with_jobspy(search_sources, args):
    try:
        from jobspy import scrape_jobs
    except ImportError as error:
        print("python-jobspy is not installed. Install it with `python3 -m pip install -r requirements.txt`.", file=sys.stderr)
        raise error

    all_jobs = []
    for source in search_sources:
        search = source["search"]
        print(f"Scraping LinkedIn search: {search}", flush=True)
        scrape_kwargs = {
            "site_name": "linkedin",
            "search_term": search,
            "location": "United States",
            "is_remote": True,
            "results_wanted": max(args.max_pages, 1) * 25,
            "description_format": "markdown",
            "linkedin_fetch_description": True,
            "hours_old": 24,
            "verbose": 2 if args.debug else 0,
        }
        try:
            with contextlib.redirect_stdout(sys.stderr):
                dataframe = scrape_jobs(**scrape_kwargs)
        except Exception as error:
            print(f"LinkedIn JobSpy scrape failed for {search}: {error}", file=sys.stderr)
            continue
        skipped_missing_url = 0
        for row in dataframe_records(dataframe):
            row["source_url"] = source["sourceUrl"]
            job = jobspy_row_to_job(row)
            if job:
                all_jobs.append(job)
            else:
                skipped_missing_url += 1
        if args.debug and skipped_missing_url:
            print(f"Skipped {skipped_missing_url} LinkedIn job(s) without any usable URL for {search}.", file=sys.stderr, flush=True)
        print(f"LinkedIn search returned {len(all_jobs)} candidate job(s) so far.", flush=True)
    return all_jobs


def jobspy_row_to_job(row):
    scraped_at = datetime.now(timezone.utc).isoformat()
    direct_url = external_direct_job_url(row.get("job_url_direct"))
    linkedin_url = clean_job_url(row.get("job_url"))
    job_url = direct_url or linkedin_url
    if not job_url:
        return None

    description = clean_description(row.get("description"))
    listing_text = clean_whitespace(" ".join(str(item) for item in [row.get("title"), row.get("company"), row.get("location"), row.get("job_type"), row.get("job_level"), row.get("job_function"), row.get("company_industry"), description] if item))
    return {
        "title": clean_whitespace(row.get("title")),
        "company": clean_whitespace(row.get("company")),
        "location": clean_whitespace(row.get("location") or ("Remote" if row.get("is_remote") else "")),
        "postedAt": jobspy_date_to_iso(row.get("date_posted"), scraped_at),
        "description": description,
        "url": job_url,
        "source": "LinkedIn",
        "sourceUrl": row.get("source_url") or "",
        "scrapedAt": scraped_at,
        "listingText": listing_text,
        "linkedinUrl": linkedin_url,
        "applyMode": "External Apply" if direct_url else "LinkedIn Apply",
    }


def jobspy_date_to_iso(value, fallback):
    if not value or re.match(r"^\d{4}-\d{2}-\d{2}$", str(value)):
        return fallback
    parsed = to_datetime(value)
    return parsed.isoformat() if parsed else fallback


def clean_job_url(value):
    if not value:
        return ""
    parsed = urlparse(str(value))
    if not parsed.scheme:
        parsed = urlparse(f"{LINKEDIN_BASE_URL}/{str(value).lstrip('/')}")
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def external_direct_job_url(value):
    url = clean_whitespace(value)
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    hostname = (parsed.hostname or "").lower()
    if hostname == "linkedin.com" or hostname.endswith(".linkedin.com"):
        return ""
    return url


def to_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(), tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def is_within_last_24_hours(value, now=None):
    parsed = to_datetime(value)
    if not parsed:
        return False
    age = (now or datetime.now(timezone.utc)) - parsed.astimezone(timezone.utc)
    return age >= timedelta(minutes=-5) and age <= timedelta(hours=24)


def is_excluded_engineering_role(job):
    title_text = " ".join(str(job.get(key) or "") for key in ["title", "category", "jobCategory"])
    return bool(EXCLUDED_ENGINEERING_ROLE_PATTERN.search(title_text) or EXCLUDED_ENGINEERING_ROLE_PATTERN.search(job.get("listingText") or ""))


def is_onsite_or_hybrid_role(job):
    text = clean_whitespace(" ".join(str(job.get(key) or "") for key in ["location", "listingText", "description"]))
    return bool(DISALLOWED_WORKPLACE_PATTERN.search(text))


def is_closed_linkedin_listing(job):
    text = clean_whitespace(" ".join(str(job.get(key) or "") for key in ["listingText", "description"]))
    return bool(LINKEDIN_CLOSED_APPLICATION_PATTERN.search(text))


def is_linkedin_hosted_application(job):
    return job.get("applyMode") in LINKEDIN_HOSTED_APPLY_MODES


def is_english_only_job(job):
    text = clean_whitespace(" ".join(str(job.get(key) or "") for key in ["title", "company", "location", "category", "jobCategory", "description", "listingText"]))
    if not text:
        return True
    if NON_ENGLISH_LANGUAGE_REQUIREMENT_PATTERN.search(text):
        return False
    letters = re.findall(r"[^\W\d_]", text, re.UNICODE)
    if len(letters) >= 80 and len(re.findall(r"[A-Za-z]", text)) / len(letters) < 0.75:
        return False
    words = re.findall(r"[a-z]+(?:'[a-z]+)?", text.lower())
    return len(words) < 40 or sum(1 for word in words if word in ENGLISH_SIGNAL_WORDS) / len(words) >= 0.08


def search_text_from_source_url(value):
    if not value:
        return ""
    parsed = urlparse(str(value))
    params = parse_qs(parsed.query)
    parts = [params.get(key, [""])[0] for key in ["keywords", "q", "query", "search"]]
    parts.append(parsed.path)
    return re.sub(r"[-_/+]+", " ", unquote(" ".join(part for part in parts if part)))


def role_family_for_job(job):
    text = clean_whitespace(search_text_from_source_url(job.get("sourceUrl")))
    for family in ["ai_ml", "data", "software"]:
        if any(pattern.search(text) for pattern in ROLE_FAMILY_PATTERNS[family]):
            return family
    return "software"


def tag_job_role_family(job):
    role_family = role_family_for_job(job)
    return {**job, "roleFamily": role_family, "category": role_family}


def scrape_linkedin(args):
    jobs = []
    seen_urls = set()
    now = datetime.now(timezone.utc)
    for job in scrape_linkedin_with_jobspy(resolve_search_sources(args), args):
        if (
            is_closed_linkedin_listing(job)
            or is_linkedin_hosted_application(job)
            or is_excluded_engineering_role(job)
            or is_onsite_or_hybrid_role(job)
            or not is_within_last_24_hours(job.get("postedAt"), now)
        ):
            continue
        if not job.get("title") or not job.get("url") or job["url"] in seen_urls:
            continue
        seen_urls.add(job["url"])
        jobs.append(job)
        if args.limit > 0 and len(jobs) >= args.limit:
            break
    return jobs


def ensure_parent_directory(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)


def save_json(path, jobs):
    ensure_parent_directory(path)
    Path(path).write_text(json.dumps(jobs, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def save_csv(path, jobs):
    ensure_parent_directory(path)
    with Path(path).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        for job in jobs:
            writer.writerow({field: job.get(field, "") for field in OUTPUT_FIELDS})


def database_url():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required to store scraped jobs in PostgreSQL")
    if os.environ.get("DATABASE_SSL") == "true" and "sslmode=" not in url:
        url = f"{url}{'&' if '?' in url else '?'}sslmode=require"
    return url


def ensure_jobs_table(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS scraped_jobs (
              id BIGSERIAL PRIMARY KEY, url TEXT NOT NULL UNIQUE, duplicate_key TEXT, source TEXT NOT NULL,
              source_url TEXT, title TEXT, company TEXT, location TEXT, category TEXT, posted_at TIMESTAMPTZ,
              scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), listing_text TEXT, raw_job JSONB NOT NULL,
              is_spam BOOLEAN, spam_reviewed_at TIMESTAMPTZ, is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
              hidden_at TIMESTAMPTZ, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS scraped_jobs_source ON scraped_jobs (source)")
        cur.execute("CREATE INDEX IF NOT EXISTS scraped_jobs_posted_at ON scraped_jobs (posted_at)")
        cur.execute("CREATE INDEX IF NOT EXISTS scraped_jobs_scraped_at ON scraped_jobs (scraped_at)")
        cur.execute("ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS duplicate_key TEXT")
        cur.execute("ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE")
        cur.execute("ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ")
        cur.execute("ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")
        cur.execute("ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")
        cur.execute("ALTER TABLE scraped_jobs ALTER COLUMN first_seen_at SET DEFAULT NOW()")
        cur.execute("ALTER TABLE scraped_jobs ALTER COLUMN updated_at SET DEFAULT NOW()")


def save_jobs_to_postgres(jobs):
    try:
        import psycopg
    except ImportError as error:
        print("psycopg is not installed. Install Python deps with `python3 -m pip install -r requirements.txt`.", file=sys.stderr)
        raise error

    rows = dedupe_rows([job_to_row(job) for job in jobs if job.get("url") and is_english_only_job(job)])
    with psycopg.connect(database_url()) as conn:
        ensure_jobs_table(conn)
        hide_existing_linkedin_disallowed_workplace_rows(conn)
        if not rows:
            return {"insertedOrUpdated": 0, "skippedDuplicates": 0, "savedUrls": []}
        rows_to_insert = filter_existing_rows(conn, rows)
        with conn.cursor() as cur:
            for row in rows_to_insert:
                cur.execute("""
                    INSERT INTO scraped_jobs
                      (url, duplicate_key, source, source_url, title, company, location, category, posted_at,
                       scraped_at, listing_text, raw_job, is_hidden, first_seen_at, updated_at)
                    VALUES
                      (%(url)s, %(duplicate_key)s, %(source)s, %(source_url)s, %(title)s, %(company)s,
                       %(location)s, %(category)s, %(posted_at)s, %(scraped_at)s, %(listing_text)s,
                       %(raw_job)s, FALSE, %(first_seen_at)s, %(updated_at)s)
                    ON CONFLICT (url) DO NOTHING
                """, row)
        return {"insertedOrUpdated": len(rows_to_insert), "skippedDuplicates": len(rows) - len(rows_to_insert), "savedUrls": [row["url"] for row in rows_to_insert]}


def hide_existing_linkedin_disallowed_workplace_rows(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
                UPDATE scraped_jobs
                SET is_hidden = TRUE,
                    hidden_at = COALESCE(hidden_at, NOW()),
                    updated_at = NOW()
                WHERE lower(source) = 'linkedin'
                  AND is_hidden = FALSE
                  AND (
                    COALESCE(location, '') ~* %(pattern)s
                    OR COALESCE(listing_text, '') ~* %(pattern)s
                    OR COALESCE(raw_job::text, '') ~* %(pattern)s
                  )
            """,
            {"pattern": DISALLOWED_WORKPLACE_SQL_PATTERN},
        )


def job_to_row(job):
    try:
        from psycopg.types.json import Jsonb
    except ImportError as error:
        print("psycopg is not installed. Install Python deps with `python3 -m pip install -r requirements.txt`.", file=sys.stderr)
        raise error

    tagged = tag_job_role_family(job)
    now = datetime.now(timezone.utc)
    return {
        "url": tagged.get("url"),
        "duplicate_key": duplicate_key_for_job(tagged),
        "source": tagged.get("source") or "Unknown",
        "source_url": tagged.get("sourceUrl") or None,
        "title": tagged.get("title") or None,
        "company": tagged.get("company") or None,
        "location": tagged.get("location") or None,
        "category": tagged.get("roleFamily"),
        "posted_at": to_datetime(tagged.get("postedAt")),
        "scraped_at": to_datetime(tagged.get("scrapedAt")) or now,
        "listing_text": tagged.get("listingText") or tagged.get("description") or None,
        "raw_job": Jsonb(tagged),
        "first_seen_at": now,
        "updated_at": now,
    }


def dedupe_rows(rows):
    seen = set()
    output = []
    for row in rows:
        key = source_duplicate_key(row)
        if key and key in seen:
            continue
        seen.add(key)
        output.append(row)
    return output


def filter_existing_rows(conn, rows):
    duplicate_keys = [row["duplicate_key"] for row in rows if row.get("duplicate_key")]
    urls = [row["url"] for row in rows if row.get("url")]
    existing_keys = set()
    existing_urls = set()
    with conn.cursor() as cur:
        cur.execute("SELECT duplicate_key, source, url FROM scraped_jobs WHERE duplicate_key = ANY(%s) OR url = ANY(%s)", (duplicate_keys or [""], urls or [""]))
        for duplicate_key, source, url in cur.fetchall():
            if duplicate_key:
                existing_keys.add(f"{str(source or '').lower()}:{duplicate_key}")
            if url:
                existing_urls.add(url)
    return [row for row in rows if row["url"] not in existing_urls and source_duplicate_key(row) not in existing_keys]


def source_duplicate_key(row):
    return f"{str(row.get('source') or '').lower()}:{row.get('duplicate_key')}" if row.get("duplicate_key") else ""


def duplicate_key_for_job(job):
    title = normalize_identity(job.get("title"))
    company = normalize_identity(job.get("company"))
    location = normalize_location(job.get("location"))
    identity = "|".join(part for part in [title, company, location] if part) if title and company else normalize_url(job.get("url"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def normalize_identity(value):
    text = str(value or "").lower().replace("&", " and ")
    text = re.sub(r"\b(inc|incorporated|llc|ltd|corp|corporation|co|company)\b\.?", "", text)
    return clean_whitespace(re.sub(r"[^\w]+", " ", text, flags=re.UNICODE))


def normalize_location(value):
    location = re.sub(r"\b(remote|hybrid|onsite|on site|united states|usa|us)\b", "", normalize_identity(value))
    return clean_whitespace(location) or "remote-us"


def normalize_url(value):
    parsed = urlparse(str(value or ""))
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", "")).lower()


def slack_escape(value):
    return clean_whitespace(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_slack_payload(jobs, args):
    plural = "job" if len(jobs) == 1 else "jobs"
    text = f"Found {len(jobs)} new LinkedIn {plural}"
    blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": f"*{text}*"}}]
    batch = ""
    for job in jobs:
        line = " ;; ".join([slack_escape(job.get("title") or "Untitled role"), slack_escape(job.get("company") or "Unknown company"), slack_escape(job.get("url")), slack_escape(job.get("source") or "LinkedIn")])
        next_batch = f"{batch}\n{line}" if batch else line
        if len(next_batch) > 2800 and batch:
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"```\n{batch}\n```"}})
            batch = line
        else:
            batch = next_batch
    if batch:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"```\n{batch}\n```"}})
    payload = {"text": text, "blocks": blocks}
    if args.slack_channel:
        payload["channel"] = args.slack_channel
    return payload


def post_new_jobs_to_slack(jobs, args):
    if not args.slack_webhook_url or not jobs:
        return
    body = json.dumps(build_slack_payload(jobs, args)).encode("utf-8")
    request = Request(args.slack_webhook_url, data=body, headers={"content-type": "application/json"}, method="POST")
    with urlopen(request, timeout=20) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"Slack webhook returned {response.status}: {response.read().decode('utf-8', 'replace')}")


def run_scraper(args):
    jobs = scrape_linkedin(args)
    print(f"Found {len(jobs)} LinkedIn jobs posted within the last 24 hours.", flush=True)
    save_json(args.output_json, jobs)
    save_csv(args.output_csv, jobs)
    result = save_jobs_to_postgres(jobs)
    print(f"Saved {result.get('insertedOrUpdated', 0)} LinkedIn jobs to PostgreSQL.", flush=True)
    new_jobs = [job for job in jobs if job.get("url") in set(result.get("savedUrls") or [])]
    if args.slack_webhook_url:
        try:
            post_new_jobs_to_slack(new_jobs, args)
            print(f"Posted {len(new_jobs)} new jobs to Slack.", flush=True)
        except Exception as error:
            print(f"Slack post failed: {error}", file=sys.stderr, flush=True)
    else:
        print("Slack webhook not configured; skipping Slack post.", flush=True)
    return jobs


def watch_scraper(args):
    interval_seconds = max(args.watch_interval_minutes, 1) * 60
    should_stop = False

    def stop(_signum, _frame):
        nonlocal should_stop
        should_stop = True
        print("\nStopping LinkedIn watch mode after the current wait/run finishes.", flush=True)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"Watching LinkedIn every {round(interval_seconds / 60)} minute(s). Press Ctrl+C to stop.", flush=True)
    while not should_stop:
        print(f"\n[{datetime.now(timezone.utc).isoformat()}] Checking LinkedIn for new jobs...", flush=True)
        try:
            run_scraper(args)
        except Exception as error:
            print(f"Watch run failed: {error}", file=sys.stderr, flush=True)
        if not should_stop:
            next_run = datetime.now(timezone.utc) + timedelta(seconds=interval_seconds)
            print(f"Next LinkedIn check at {next_run.isoformat()}.", flush=True)
        for _ in range(interval_seconds):
            if should_stop:
                break
            time.sleep(1)


def main(argv=None):
    load_dotenv()
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.watch:
        watch_scraper(args)
    else:
        run_scraper(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        sys.exit(1)
