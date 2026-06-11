WATCH_INTERVAL_MINUTES ?= 5
JOBRIGHT_MAX_SCROLLS ?= 30
REMOTEHUNTER_MAX_SCROLLS ?= 10

.PHONY: help install-browsers install-python scrape scrape-jobright scrape-linkedin scrape-builtin scrape-simplify scrape-diversityjobs scrape-remoteyeah scrape-remotehunter scrape-hiringcafe watch watch-jobright watch-linkedin watch-builtin watch-simplify watch-diversityjobs watch-remoteyeah watch-remotehunter watch-hiringcafe docker-build docker-scrape docker-watch docker-down

help:
	@printf '%s\n' \
		'Targets:' \
		'  make install-python   Install Python deps for legacy helper scripts' \
		'  make watch            Watch all sources in parallel' \
		'  make scrape           Scrape all sources once' \
		'  make docker-build     Build the Docker image' \
		'  make docker-scrape    Run all scrapers once in Docker' \
		'  make docker-watch     Watch all sources in Docker' \
		'  make docker-down      Stop Docker watcher services'

install-browsers:
	pnpm install:browsers

install-python:
	python3 -m pip install -r requirements.txt

scrape: scrape-jobright scrape-builtin scrape-simplify scrape-diversityjobs scrape-remoteyeah scrape-remotehunter scrape-hiringcafe

scrape-jobright:
	pnpm jobright:scrape -- --max-scrolls $(JOBRIGHT_MAX_SCROLLS)

scrape-linkedin:
	@printf '%s\n' 'LinkedIn scraper disabled; skipping.'

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

watch:
	$(MAKE) -j7 watch-jobright watch-builtin watch-simplify watch-diversityjobs watch-remoteyeah watch-remotehunter watch-hiringcafe

watch-jobright:
	node sites/jobright/scraper.js --watch --watch-interval-minutes $(WATCH_INTERVAL_MINUTES) --max-scrolls $(JOBRIGHT_MAX_SCROLLS)

watch-linkedin:
	@printf '%s\n' 'LinkedIn scraper disabled; skipping watch.'

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
	docker compose up -d jobright-watch builtin-watch simplify-watch diversityjobs-watch remoteyeah-watch remotehunter-watch hiringcafe-watch

docker-down:
	docker compose down
