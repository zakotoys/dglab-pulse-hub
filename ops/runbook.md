# Production Runbook

## Build and start

Requirements: Docker Engine with Compose v2 and at least 1 GiB of free memory.

```sh
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8080/health/ready
```

Set `PULSE_HUB_PORT` to change the host port. The default is `8080`. The API and static web service
are internal-only; Nginx is the public entry point.

## Runtime boundaries

- Nginx limits request bodies to 2 MiB, matching the application default.
- Uploaded waveform content is processed in memory. Download artifacts live in a private temporary
  directory for at most 15 minutes and are consumed once.
- There are no accounts, databases, persistent uploads, or public share URLs.
- Logs must not include request bodies, QR payloads, original filenames, or local artifact paths.

## Health and shutdown

- `/health/live` reports that the API process can answer requests.
- `/health/ready` also verifies that the private artifact store can initialize.
- Compose sends `SIGTERM`; the API stops accepting work, closes Fastify, and removes owned temporary
  artifacts. `stop_grace_period` is 20 seconds.

Stop normally with:

```sh
docker compose down --timeout 20
```

After an unclean host stop, the artifact store removes directories owned by dead processes when the
next API instance initializes.

## Upgrade and rollback

Build immutable image tags in the release pipeline before deployment. To upgrade, pull/build the
target tag and run `docker compose up -d`. There is no persistent application data migration.

To roll back, restore the previous API and web image tags and run `docker compose up -d` again.
Confirm `/health/ready`, then inspect one synthetic valid fixture and one invalid fixture through
the API.

## Incident checks

1. Check `docker compose ps` and the two health endpoints.
2. Review container exit status and sanitized logs with `docker compose logs --since 15m api nginx`.
3. Confirm disk space for the host temporary directory and Docker storage.
4. Restart only after collecting exit codes; do not preserve private artifact directories for
   debugging.
