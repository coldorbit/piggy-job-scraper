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
JOBRIGHT_MAX_SCROLLS=30
REMOTEHUNTER_MAX_SCROLLS=10
```

LinkedIn-only Playwright proxy rotation can be enabled with one proxy URL per line or a comma-separated list:

```text
LINKEDIN_PROXY_URLS=http://user:pass@proxy1.example.com:8080,http://user:pass@proxy2.example.com:8080
```

If credentials are shared across all proxy endpoints, use `LINKEDIN_PROXY_USERNAME` and `LINKEDIN_PROXY_PASSWORD` instead of embedding credentials in each URL.

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
pnpm linkedin:watch -- --watch-interval-minutes 10
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
docker compose up -d jobright-watch linkedin-watch builtin-watch simplify-watch diversityjobs-watch remoteyeah-watch remotehunter-watch hiringcafe-watch
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
docker compose up -d jobright-watch linkedin-watch builtin-watch simplify-watch diversityjobs-watch remoteyeah-watch remotehunter-watch hiringcafe-watch
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

Scraped jobs are inserted into PostgreSQL table `scraped_jobs`. Duplicate detection is handled by PostgreSQL using the scraper's duplicate key logic, without deleting existing rows during normal runs.
