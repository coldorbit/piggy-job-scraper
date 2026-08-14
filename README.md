# Sites Scraper

Standalone deployment project for the site scrapers. It contains only the Node.js scraping code and the Docker/Compose files needed to run it on EC2.

## Requirements

- Node.js 18+
- pnpm
- Docker and Docker Compose for EC2 deployment
- PostgreSQL database and `DATABASE_URL` in `.env`

## Environment

Create `sites-scraper/.env`:

```text
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
DATABASE_SSL=true
```

Optional runtime settings:

```text
WATCH_INTERVAL_MINUTES=5
JOBRIGHT_WATCH_INTERVAL_MINUTES=10
JOBRIGHT_CA_START_DELAY_SECONDS=300
JOBRIGHT_UK_START_DELAY_SECONDS=600
JOBRIGHT_DETAIL_CONCURRENCY=2
JOBRIGHT_MAX_SCROLLS=30
JOBRIGHT_US_URLS=
JOBRIGHT_CA_URLS=
JOBRIGHT_UK_URLS=
JOBRIGHT_US_STORAGE_STATE=.auth/jobright-us.json
JOBRIGHT_CA_STORAGE_STATE=.auth/jobright-ca.json
JOBRIGHT_UK_STORAGE_STATE=.auth/jobright-uk.json
REMOTEHUNTER_MAX_SCROLLS=10
```

Jobright runs US, Canada, and UK as separate scrapers. Listing searches use signed-out browser contexts so Jobright preserves each search URL instead of redirecting to account recommendations. Saved sessions at `.auth/jobright-us.json`, `.auth/jobright-ca.json`, and `.auth/jobright-uk.json` are used only to enrich job detail pages.

The Docker watchers stagger Canada by five minutes and UK by ten minutes, and run Jobright every ten minutes by default. Jobright source loads also use jittered delays, retry backoff, and a circuit breaker after three consecutive source failures to avoid request bursts. Override these deployment defaults with `JOBRIGHT_WATCH_INTERVAL_MINUTES`, `JOBRIGHT_CA_START_DELAY_SECONDS`, `JOBRIGHT_UK_START_DELAY_SECONDS`, and `JOBRIGHT_DETAIL_CONCURRENCY`.

Existing rows are preserved by default during scraper startup. Destructive cleanup can be enabled only when you explicitly intend to prune old data:

```text
DELETE_EXISTING_DUPLICATE_JOBS=false
DELETE_EXISTING_NON_ENGLISH_JOBS=false
```

## Local Usage

```bash
pnpm install
pnpm install:browsers
pnpm scrape
pnpm watch
```

Run one source:

```bash
pnpm jobright:scrape -- --max-scrolls 30
pnpm jobright:ca:scrape -- --max-scrolls 30
pnpm jobright:uk:scrape -- --max-scrolls 30
pnpm builtin:watch -- --watch-interval-minutes 10
```

## Docker

Build the image:

```bash
docker compose build
```

Run all scrapers once:

```bash
docker compose run --rm scrape
```

Start all watcher containers:

```bash
docker compose up -d --remove-orphans jobright-watch jobright-ca-watch jobright-uk-watch builtin-watch remotehunter-watch hiringcafe-watch
```

View logs:

```bash
docker compose logs -f
```

Stop watchers:

```bash
docker compose down
```

## EC2 Deployment

On the EC2 instance:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker "$USER"
```

Log out and back in so the Docker group applies, then deploy:

```bash
git clone <your-repo-url>
cd scraper/sites-scraper
cp .env.example .env
```

Edit `.env`, then run:

```bash
docker compose build
docker compose up -d --remove-orphans jobright-watch jobright-ca-watch jobright-uk-watch builtin-watch remotehunter-watch hiringcafe-watch
```

## GitHub Actions Deployment

The workflow in `.github/workflows/deploy.yml` builds the Docker image, pushes it to GHCR, copies `docker-compose.yml` to EC2, and restarts the watcher services with the new image.

Add these repository secrets in GitHub:

```text
EC2_HOST=<your-ec2-public-dns-or-ip>
EC2_USER=<ssh-user>
EC2_SSH_KEY=<private-ssh-key-for-that-user>
EC2_DEPLOY_PATH=/home/<ssh-user>/sites-scraper
GHCR_TOKEN=<classic-pat-with-read:packages>
GHCR_USERNAME=<github-username-or-org>
```

Optional:

```text
EC2_SSH_PORT=22
```

The workflow uses `GITHUB_TOKEN` to push to GHCR and `GHCR_TOKEN` on EC2 to pull the image. Keep the runtime `.env` file on the EC2 instance at `EC2_DEPLOY_PATH/.env`; the workflow intentionally does not copy secrets such as `DATABASE_URL`.

On EC2, make sure Docker Compose is installed and the SSH user can run Docker:

```bash
docker compose version
docker ps
```

Scraped jobs are inserted into PostgreSQL table `scraped_jobs`. Search queries and
source URLs help discover jobs and may provide an AI/ML specialty fallback, but
they do not make an unrelated search result an AI/ML role. Duplicate detection is
handled by PostgreSQL using the scraper's duplicate key logic, without deleting
existing rows during normal runs.

The `category` column identifies the role type. Explicit data and software titles
remain in those role families even when their descriptions mention AI/ML:

- `software`
- `data`
- `ml_engineer`
- `data_scientist`
- `applied_scientist`
- `research_scientist`
- `other_ai_ml` when the role type is unclear

The separate `ai_ml_area` column identifies what an AI/ML role works on. It is
classified primarily from the full job description rather than the title:

- `computer_vision`
- `nlp`
- `speech_audio_ml`
- `recommendation_systems`
- `time_series_forecasting`
- `anomaly_fraud_detection`
- `graph_ml`
- `robotics_control`
- `generative_ai`
- `multimodal_ml`
- `tabular_ml`
- `other_ai_ml` when the description does not provide enough evidence for a specialty

To reapply the current role and AI/ML specialty rules to recently scraped rows:

```bash
pnpm jobs:reclassify-recent -- --hours 48
```

Every stored job also receives normalized `seniority` and `work_mode` values.
Seniority uses `intern`, `entry_level`, `junior`, `mid_level`, `senior`, `lead`,
`staff`, `principal`, `manager`, `director`, `executive`, or `unknown`. Work mode
uses `remote`, `hybrid`, `onsite`, or `unknown`.

After deploying the schema/attribute changes, backfill existing rows before
recalculating job-profile scores in `piggy-web`:

```bash
pnpm jobs:backfill-attributes
cd ../piggy-web/api
pnpm ranking:recalculate
```

Use `--dry-run` on either command to review counts without updating rows. Pass
`--force` to `jobs:backfill-attributes` when classification rules change and all
jobs must be reevaluated.
