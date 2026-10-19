# Deployment

The app is a Next.js 16 server (API routes, server-side secrets, and a JSON
file store under `data/`). It is designed to run as **one long-lived container**
with a persistent volume, behind a TLS-terminating reverse proxy.

## Architecture

```
GitHub repo --push/tag--> GitHub Actions (docker.yml)
                              |  builds Dockerfile
                              v
                     GHCR: ghcr.io/jayalexander03/nvresources_competitor_watchlist
                              |  docker pull
                              v
Host --> single container (Node 22, port 3000)
           +-- /app/data  <-- persistent volume (watchlist.json, notifications.json)
           +-- env from .env (secrets are never baked into the image)
```

The image is built with `output: "standalone"` and runs `node server.js` as the
non-root user `nextjs` (uid/gid `1001`). Only one
container/replica may run against a given data volume: writes are serialized by
an in-process mutex, which does not coordinate across processes.

GitHub Pages is **not** used: the app needs API routes, secrets, and a writable
disk, which Pages cannot provide. After removing the old workflow, disable it in
the repository under **Settings → Pages → Source: None**.

## Required environment variables

Create a `.env` file on the host (`.env.example` lists the public-safe subset).
Never commit it and never add secrets to the Dockerfile.

| Variable             | Required | Purpose |
| -------------------- | -------- | ------- |
| `APP_PASSWORD`       | Yes      | Password for the app UI. If unset in production, protected routes return **503**. |
| `AUTH_SECRET`        | Yes      | Secret used to sign auth sessions. Use a long random value; changing it logs everyone out. |
| `OPENROUTER_API_KEY` | Yes      | LLM calls used for source/release discovery. |
| `RESEND_API_KEY`     | Yes      | Sends notification email through Resend. |
| `RESEND_FROM`        | Yes      | Sender address, e.g. `onboarding@resend.dev` until a domain is verified. |
| `RESEND_TO`          | No       | Recipient override while the Resend domain is unverified. |
| `CRON_SECRET`        | Yes      | Bearer token for `GET /api/cron/check`. If unset in production, that endpoint returns **503**. |
| `PORT`               | No       | Defaults to `3000`. Changing it requires matching the port mapping and healthcheck. |

Generate secrets with e.g. `openssl rand -hex 32`.

## Publishing the image (GitHub Actions)

`.github/workflows/docker.yml` runs on pushes to `main`, tags matching `v*`,
and manual dispatch. It pushes to GHCR with:

- `:<sha>` for every build,
- `:latest` on the default branch,
- `:<version>` for semver tags such as `v1.2.3`.

The package is **private by default**. To make pulls anonymous, change the
package visibility in GitHub → Packages → package settings. Otherwise
authenticate on the host with a PAT that has `read:packages`:

```bash
echo "<PAT>" | docker login ghcr.io -u <github-username> --password-stdin
```

## Run with Docker

```bash
docker pull ghcr.io/jayalexander03/nvresources_competitor_watchlist:latest

docker run -d \
  --name watchlist \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v watchlist-data:/app/data \
  ghcr.io/jayalexander03/nvresources_competitor_watchlist:latest
```

`-v watchlist-data:/app/data` is required. Without it, data is lost when the
container is recreated. The image declares `VOLUME /app/data`, so Docker would
create an anonymous volume, but a named volume is easier to back up and reuse.

## Run with Compose

`docker-compose.yml` pulls the GHCR image (and can build locally):

```bash
docker compose up -d --build     # build from source and start
docker compose pull && docker compose up -d   # use the published image
docker compose logs -f app
docker compose down              # keeps the watchlist-data volume
```

The compose file mounts the named volume `watchlist-data` at `/app/data`,
loads `.env`, and exposes port 3000. It must not be scaled beyond one replica.

## Persistent volume rules

- **Single instance only.** Two containers sharing the volume can lose writes;
  the mutex only works within one Node.js process. Do not add replicas or run
  overlapping deploy/backup migrations.
- **Back up before upgrades.** With the container stopped (or accepting a
  point-in-time snapshot):

  ```bash
  docker run --rm -v watchlist-data:/data alpine tar czf - -C /data . > backup.tgz
  ```

  Restore with the app stopped:

  ```bash
  docker run --rm -i -v watchlist-data:/data alpine tar xzf - -C /data < backup.tgz
  ```

- **Bind mounts and ownership.** The process runs as uid/gid `1001`. A host
  bind mount must be writable by that user:

  ```bash
  mkdir -p ./data
  sudo chown -R 1001:1001 ./data
  docker run ... -v "$PWD/data:/app/data" ...
  ```

  On PowerShell use `-v "${PWD}/data:/app/data"`. If ownership is wrong the
  app cannot persist and writes fail at runtime. Named volumes are chowned
  automatically on first use by the image.

## First run

`data/watchlist.json` and `data/notifications.json` are created automatically
the first time the app writes them. There is no seeding step and no data is
baked into the image (`.dockerignore` excludes `data/`). The repo only ships
`data/.gitkeep`.

## Scheduled checks

The daily check is `GET /api/cron/check` (same logic as
`POST /api/watchlist/refresh`). It authenticates with
`Authorization: Bearer $CRON_SECRET`. In development the header is optional;
in production the endpoint returns **503** when `CRON_SECRET` is unset.

Option A — GitHub Actions (`.github/workflows/daily-check.yml`, 13:00 UTC):

1. Repository variable `DEPLOY_URL` = public base URL, e.g.
   `https://watchlist.example.com` (no trailing slash).
2. Repository secret `CRON_SECRET` = the same value as the container's env var.

The job is skipped when `DEPLOY_URL` is empty. GitHub may delay scheduled runs
during high load and disables schedules after 60 days without repository
activity; re-enable from the Actions tab or use a host-side scheduler.

Option B — host scheduler (cron, systemd timer, Task Scheduler):

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://watchlist.example.com/api/cron/check
```

## Reverse proxy and TLS

The container speaks plain HTTP on `0.0.0.0:3000`. Terminate TLS at a reverse
proxy (nginx, Caddy, Traefik, Cloudflare Tunnel, etc.), forward to
`127.0.0.1:3000`, and pass `Host` / `X-Forwarded-Proto` / `X-Forwarded-For`.
Do not expose port 3000 directly to the internet. `APP_PASSWORD` must be set
in production; otherwise routes protected by auth return **503** rather than
allowing access. Health checks can use the public `/login` page; `/` redirects.

## Updating

1. Push to `main` (or tag `vX.Y.Z`) → Actions publishes `:<sha>` and `:latest`.
2. On the host:

   ```bash
   docker compose pull
   docker compose up -d
   # or, without Compose:
   docker pull ghcr.io/jayalexander03/nvresources_competitor_watchlist:latest
   docker rm -f watchlist
   docker run ...   # same command as above
   ```

3. For rollback, run a previous `:<sha>` tag. Data lives on the volume, so
   recreating the container does not lose it.

## Host checklist

- [ ] Docker Engine + Compose plugin installed (image is `linux/amd64` unless
      built for another platform).
- [ ] Persistent disk/volume for `/app/data`, with enough space and backups.
- [ ] `.env` populated with all required secrets; file permissions restricted.
- [ ] Exactly one container instance per data volume.
- [ ] Outbound HTTPS allowed (OpenRouter, Resend, GitHub).
- [ ] Reverse proxy + TLS configured; only the proxy is publicly reachable.
- [ ] `DEPLOY_URL` / `CRON_SECRET` configured, or a host-side cron job.
- [ ] `docker compose ps` shows the container healthy at `/login`.

## Assumptions

- `next.config.ts` sets `output: "standalone"`; the Dockerfile copies
  `.next/standalone` and `.next/static`.
- The app resolves its data directory relative to the working directory
  (`/app/data` in the image).
- `npm ci` uses the committed `package-lock.json`; no private npm registry is
  required.
- Health checks use BusyBox `wget` from the Alpine base image and probe the
  public `/login` page.
