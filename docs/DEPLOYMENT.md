# Deployment

This describes the hackathon deployment. The project now runs locally (see [Run it locally](../README.md#run-it-locally) in the root README); the deploy files are kept in [`infra/`](../infra/) for reference.

```
Browser ──► Vercel (React console, <domain>)
              │  /api/*  rewrite (same origin, no CORS)
              ▼
           EC2 (api.<domain>)
           Caddy :443 (Let's Encrypt) ─► Go gateway :8080 ─► Python engine :8000 ─► Redis Stack :6379
                                         PII mask, rate limit   OpenAI first, Gemini fallback   hierarchical index
           Cloudflare R2: models/v1 (classifier + thresholds), redis/dump_v1.rdb (index snapshot)
```

Only Caddy is public (80/443). The gateway, engine and Redis talk on the internal Docker network.

## What lives where

| Piece | Where | Built from |
|---|---|---|
| Console | Vercel project, root directory `frontend/` | `frontend/vercel.json` |
| Gateway, engine, Redis, Caddy | one EC2 instance, docker compose | `infra/docker-compose.prod.yml` |
| Trained classifier + thresholds | R2 `models/v1/`, pulled by the engine at start | `python -m ml.train` |
| Redis index (≈42k chunks, OpenAI 768-d vectors) | R2 `redis/dump_v1.rdb`, restored on first deploy | `python -m ml.indexing.build_index --snapshot` |
| Secrets | `.env` on the EC2 box only (copied from your laptop) | `infra/env.template` |

## One-time setup

1. **EC2:** Ubuntu 24.04, t3.medium (2 vCPU, 4 GB), 30 GB gp3, an Elastic IP. Security group inbound: 22, 80, 443 from anywhere. SSH is key-only, and fail2ban is installed by the bootstrap.
2. **DNS** at your registrar:
   - `api.<domain>`: A record pointing to the EC2 Elastic IP.
   - `<domain>` (or `app.<domain>`): the records Vercel shows when you add the domain to the project.
3. **Bootstrap the box:** `ssh ubuntu@<ip> 'bash -s' < infra/ec2_bootstrap.sh`. It installs Docker, fail2ban and swap, and clones the repo to `/opt/sentineldesk`.
4. **Secrets:** copy your `.env` to `/opt/sentineldesk/.env` and add `API_DOMAIN=api.<domain>`. `deploy.sh` generates `REDIS_PASSWORD` on the box when `.env` doesn't set one, so delete the laptop value (`change-me-locally` from the template) first.
5. **Vercel:** set `"destination"` in `frontend/vercel.json` to `https://api.<domain>/api/:path*`. Then either `npx vercel --prod` from `frontend/`, or import the repo in the Vercel dashboard with root directory `frontend`. No environment variables are needed.

## Every deploy

```
ssh ubuntu@<ip> 'cd /opt/sentineldesk && ./infra/deploy.sh'
```

The script:
1. Pulls main.
2. Builds the images.
3. Restores the Redis snapshot from R2 on the first run.
4. Starts the stack.
5. Waits for `/api/v1/health` over HTTPS and sends two warm-up tickets.

## Re-indexing or retraining

Run these on a laptop with `.env`:

```
python -m ml.split && python -m ml.train && python -m ml.indexing.embed
python -m ml.indexing.retrieval_quality            # writes retrieval_threshold + route_alpha
python -m engine.app.common.r2 upload ml/artifacts/models/v1 models/v1
# build the index in a local Redis Stack, then upload its dump.rdb:
python -m ml.indexing.build_index --url redis://:<pw>@localhost:6379 --snapshot
python -m engine.app.common.r2 put <dump.rdb> redis/dump_v1.rdb
```

Then on the box run `RESTORE_REDIS=1 ./infra/deploy.sh`. Restart the engine to pick up new models.

## Checks

- `curl https://api.<domain>/api/v1/health` returns `status: ok` and `mode: live`.
- The engine's `/healthz` lists every stage as `real`.
- `docker compose --env-file .env -f infra/docker-compose.prod.yml logs -f engine` shows the classifier loading and the gate thresholds.
