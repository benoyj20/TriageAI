#!/usr/bin/env bash
# Deploy main on the EC2 box. Hriday only.
#   ./infra/deploy.sh                  pull, build, restore Redis on first run, start, warm up
#   ./infra/deploy.sh --no-pull        deploy what is on disk
#   RESTORE_REDIS=1 ./infra/deploy.sh  reload the Redis index from R2 (after a re-index)
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose --env-file .env -f infra/docker-compose.prod.yml"

[ -f .env ] || { echo "Missing .env in $(pwd). Copy infra/env.template and fill it in."; exit 1; }
# Server-only secret: generated here once, never leaves the box.
grep -q '^REDIS_PASSWORD=..' .env || echo "REDIS_PASSWORD=$(openssl rand -hex 24)" >> .env
grep -q '^API_DOMAIN=..' .env || { echo "Set API_DOMAIN (e.g. api.example.com) in .env"; exit 1; }
API_DOMAIN="$(grep '^API_DOMAIN=' .env | tail -1 | cut -d= -f2-)"

if [ "${1:-}" != "--no-pull" ]; then
  git pull --ff-only
fi
echo "Deploying $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"

$COMPOSE build

# First deploy (or RESTORE_REDIS=1): load the prebuilt index snapshot from R2 into the Redis volume.
has_dump() { docker run --rm -v sentineldesk_redis-data:/data alpine test -s /data/dump.rdb; }
if [ "${RESTORE_REDIS:-0}" = "1" ] || ! has_dump; then
  echo "Restoring the Redis index from R2 (redis/dump_v1.rdb)"
  $COMPOSE stop redis >/dev/null 2>&1 || true
  docker volume create sentineldesk_redis-data >/dev/null
  $COMPOSE run --rm --no-deps -v sentineldesk_redis-data:/data engine \
    python -m engine.app.common.r2 get redis/dump_v1.rdb /data/dump.rdb
fi

$COMPOSE up -d --remove-orphans
$COMPOSE ps

python3 infra/warmup.py "https://${API_DOMAIN}" --wait 300 || {
  echo "Warm-up failed. Recent logs:"
  $COMPOSE logs --tail=60 engine gateway caddy
  exit 1
}
echo "Deployed $(git rev-parse --short HEAD) at https://${API_DOMAIN}"
