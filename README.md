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

Scraped jobs are inserted into PostgreSQL table `scraped_jobs`. Duplicate detection is handled by PostgreSQL using the scraper's duplicate key logic.
