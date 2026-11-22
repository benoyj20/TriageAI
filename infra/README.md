# infra/

Owner: Hriday. Only Hriday deploys.

## Keys and buckets (H-03)

These need a human with the accounts. Do them once, before kickoff:

1. **OpenAI key (preferred).** Put it in `OPENAI_API_KEY`. Defaults: `OPENAI_GEN_MODEL=gpt-5.4-mini`, `OPENAI_EMBED_MODEL=text-embedding-3-small` (768 dimensions).
   **Gemini key (fallback, optional).** Create it in Google AI Studio on a project with billing enabled (the free tier allows only 30,000 embedding tokens a minute). Put it in `GEMINI_API_KEY`; `GEN_MODEL` defaults to `gemini-3.1-flash-lite`. Generation tries OpenAI first and falls back to Gemini. Embeddings use one provider only: switching means re-embedding the KB.
2. **R2 bucket.** In Cloudflare, create the bucket `sentineldesk-artifacts` and one API token with Object Read and Write on that bucket only. Put the S3 endpoint, key id and secret in the `R2_*` variables.
3. **Share the keys.** Copy `infra/env.template` to `.env` in the repo root, fill it in, and send it to the team privately (never in git, never in the repo chat history).
4. **Check access.** Each Python dev runs this from the repo root:

   ```
   pip install boto3 redis google-genai
   python infra/check_access.py
   ```

   It prints OK, SKIP or FAIL for OpenAI, Gemini, R2 and Redis, and never prints a secret.

## Local Redis (H-04)

Redis with the Query Engine (vector search), plus RedisInsight for debugging. Start Docker Desktop and create `.env` (step 3 above) first, then from the repo root:

```
docker compose --env-file .env -f infra/docker-compose.dev.yml up -d
docker compose --env-file .env -f infra/docker-compose.dev.yml ps      # wait for "healthy"
python infra/check_access.py                                           # Redis line should say OK
```

- Redis: `localhost:6379`. The password is `REDIS_PASSWORD`, and the port is bound to localhost only.
- RedisInsight: http://localhost:8001. Add a database at `localhost:6379` with the same password.
- Data survives restarts in the `redis-data` volume. To start over: `docker compose --env-file .env -f infra/docker-compose.dev.yml down -v`.

The image is pinned (`redis/redis-stack:7.4.0-v8`) so every laptop and EC2 run the same Redis. On EC2, port 6379 is never opened in the security group.

## Deploying to EC2 (H-08, H-15, H-19)

One-time box setup (Ubuntu 22.04+, t3.large, 30 GB disk):

1. Security group: allow **80** (and 443 if you add TLS) from anywhere, **22** from your IP only. Never open 6379, 8000 or 8001.
2. Install Docker: `curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER`, then log out and back in.
3. `git clone https://github.com/Dogtags27/gdg-sentinal.git && cd gdg-sentinal`, then create `.env` from `infra/env.template` with the real keys. Set `REDIS_PASSWORD` to a long random value and `MOCK_ENGINE=false`.
4. Restore the Redis index (after the ML engineer uploads `redis/dump_v1.rdb` to R2): run `docker compose --env-file .env -f infra/docker-compose.prod.yml up -d redis`, stop it, copy the file into the `redis-data` volume as `dump.rdb`, start it again.

Every deploy after that:

```
./infra/deploy.sh
```

It pulls main, rebuilds, restarts, waits for `/readyz`, and sends two warm-up tickets (`infra/warmup.py`). Check the stack at any time with `docker compose --env-file .env -f infra/docker-compose.prod.yml ps` and `curl localhost/api/v1/health`. Keep the local dev stack (`docker-compose.dev.yml`) running on one laptop as a hot spare for the demo.

Images: `Dockerfile.engine` (Python), `Dockerfile.gateway` (builds the React console and the Go binary, serves both on 8080, published on port 80). The gateway image needs `backend/go.mod` and `backend/cmd/api/main.go` from the full-stack dev, and honours `WEB_DIR` for the console files.
