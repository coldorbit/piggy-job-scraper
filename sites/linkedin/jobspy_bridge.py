#!/usr/bin/env python3
import contextlib
import json
import math
import sys
from datetime import date, datetime

try:
    from jobspy import scrape_jobs
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
    searches = config.get("searches") or []
    results_wanted = max(int(config.get("resultsWanted") or 1), 1)
    verbose = 2 if config.get("debug") else 0
    all_jobs = []

    for search in searches:
        with contextlib.redirect_stdout(sys.stderr):
            jobs = scrape_jobs(
                site_name="linkedin",
                search_term=search,
                location="United States",
                is_remote=True,
                results_wanted=results_wanted,
                hours_old=24,
                description_format="plain",
                linkedin_fetch_description=True,
                verbose=verbose,
            )

        source_url = config.get("sourceUrls", {}).get(search, "")
        for job in dataframe_records(jobs):
            job["source_search"] = search
            job["source_url"] = source_url
            all_jobs.append(job)

    print(json.dumps(all_jobs, ensure_ascii=False))


if __name__ == "__main__":
    main()
