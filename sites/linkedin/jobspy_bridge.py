#!/usr/bin/env python3
import contextlib
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from types import SimpleNamespace

try:
    from jobspy import scrape_jobs
    from jobspy.linkedin import DescriptionFormat, LinkedIn
except ImportError as error:
    print(
        "python-jobspy is not installed. Install it with `python3 -m pip install -r requirements.txt`.",
        file=sys.stderr,
    )
    raise error


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
    records = dataframe.to_dict(orient="records")
    return [sanitize(record) for record in records]


def main():
    config = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    if config.get("jobIds"):
        print(
            json.dumps(
                fetch_linkedin_details(
                    config.get("jobIds"),
                    max_workers=max(int(config.get("detailConcurrency") or 1), 1),
                ),
                ensure_ascii=False,
            )
        )
        return

    searches = config.get("searches") or []
    results_wanted = max(int(config.get("resultsWanted") or 1), 1)
    hours_old = config.get("hoursOld")
    verbose = 2 if config.get("debug") else 0
    all_jobs = []

    for search in searches:
        scrape_args = {
            "site_name": "linkedin",
            "search_term": search,
            "location": "United States",
            "is_remote": True,
            "results_wanted": results_wanted,
            "description_format": "markdown",
            "linkedin_fetch_description": True,
            "verbose": verbose,
        }
        if hours_old is not None:
            scrape_args["hours_old"] = int(hours_old)

        try:
            with contextlib.redirect_stdout(sys.stderr):
                jobs = scrape_jobs(**scrape_args)
        except Exception as error:
            print(f"LinkedIn JobSpy scrape failed for {search}: {error}", file=sys.stderr)
            continue

        source_url = config.get("sourceUrls", {}).get(search, "")
        for job in dataframe_records(jobs):
            job["source_search"] = search
            job["source_url"] = source_url
            all_jobs.append(job)

    print(json.dumps(all_jobs, ensure_ascii=False))


def linkedin_detail_row(job_id):
    scraper = LinkedIn()
    scraper.scraper_input = SimpleNamespace(description_format=DescriptionFormat.MARKDOWN)
    try:
        details = scraper._get_job_details(str(job_id))
    except Exception as error:
        print(f"LinkedIn JobSpy detail fetch failed for {job_id}: {error}", file=sys.stderr)
        details = {}

    return {
        "job_id": str(job_id),
        "job_url": f"https://www.linkedin.com/jobs/view/{job_id}",
        "job_url_direct": sanitize(details.get("job_url_direct")),
    }


def fetch_linkedin_details(job_ids, max_workers=1):
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        return list(executor.map(linkedin_detail_row, job_ids))


if __name__ == "__main__":
    main()
