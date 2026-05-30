WATCH_INTERVAL_MINUTES ?= 5
JOBRIGHT_MAX_SCROLLS ?= 30
REMOTEHUNTER_MAX_SCROLLS ?= 10
PYTHON ?= python3
LINKEDIN_JOBSPY_PYTHON ?= $(PYTHON)

.PHONY: help install-browsers install-python scrape scrape-jobright scrape-linkedin scrape-builtin scrape-simplify scrape-diversityjobs scrape-remoteyeah scrape-remotehunter scrape-hiringcafe backfill-linkedin-direct-urls watch watch-jobright watch-linkedin watch-builtin watch-simplify watch-diversityjobs watch-remoteyeah watch-remotehunter watch-hiringcafe docker-build docker-scrape docker-watch docker-down

help:
	@printf '%s\n' \
		'Targets:' \
		'  make install-python   Install Python deps for LinkedIn JobSpy scraper' \
		'  make watch            Watch all sources in parallel' \
		'  make scrape           Scrape all sources once' \
		'  make backfill-linkedin-direct-urls' \
		'  make docker-build     Build the Docker image' \
		'  make docker-scrape    Run all scrapers once in Docker' \
		'  make docker-watch     Watch all sources in Docker' \
		'  make docker-down      Stop Docker watcher services'

install-browsers:
	pnpm install:browsers

install-python:
	$(PYTHON) -m pip install -r requirements.txt

scrape: scrape-jobright scrape-linkedin scrape-builtin scrape-simplify scrape-diversityjobs scrape-remoteyeah scrape-remotehunter scrape-hiringcafe

scrape-jobright:
	pnpm jobright:scrape -- --max-scrolls $(JOBRIGHT_MAX_SCROLLS)

scrape-linkedin:
	$(LINKEDIN_JOBSPY_PYTHON) sites/linkedin/scraper.py

scrape-builtin:
	pnpm builtin:scrape

scrape-simplify:
	pnpm simplify:scrape

scrape-diversityjobs:
	pnpm diversityjobs:scrape

scrape-remoteyeah:
	pnpm remoteyeah:scrape

scrape-remotehunter:
	pnpm remotehunter:scrape -- --max-scrolls $(REMOTEHUNTER_MAX_SCROLLS)

scrape-hiringcafe:
	pnpm hiringcafe:scrape

backfill-linkedin-direct-urls:
	LINKEDIN_JOBSPY_PYTHON=$(LINKEDIN_JOBSPY_PYTHON) pnpm linkedin:backfill-direct-urls

watch:
	$(MAKE) -j8 watch-jobright watch-linkedin watch-builtin watch-simplify watch-diversityjobs watch-remoteyeah watch-remotehunter watch-hiringcafe

watch-jobright:
	node sites/jobright/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES) --max-scrolls $(JOBRIGHT_MAX_SCROLLS)

watch-linkedin:
	$(LINKEDIN_JOBSPY_PYTHON) sites/linkedin/scraper.py --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES)

watch-builtin:
	node sites/builtin/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES)

watch-simplify:
	node sites/simplify/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES)

watch-diversityjobs:
	node sites/diversityjobs/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES)

watch-remoteyeah:
	node sites/remoteyeah/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES)

watch-remotehunter:
	node sites/remotehunter/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES) --max-scrolls $(REMOTEHUNTER_MAX_SCROLLS)

watch-hiringcafe:
	node sites/hiringcafe/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES)

docker-build:
	docker compose build

docker-scrape:
	docker compose run --rm scrape

docker-watch:
	docker compose up -d jobright-watch linkedin-watch builtin-watch simplify-watch diversityjobs-watch remoteyeah-watch remotehunter-watch hiringcafe-watch

docker-down:
	docker compose down
