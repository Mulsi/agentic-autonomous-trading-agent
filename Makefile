# Each target installs dependencies itself, so all of them work on a clean
# checkout. Recipes source factory/env.sh because non-interactive shells have no
# node or pnpm. The paths are relative, so a repo path with spaces is fine.
SHELL := /bin/bash
APP := local-trading-agent-backend

# The compose database. docker-compose.yml and .env.example carry the same
# fixed local-development values; none of them is a secret.
DB_URL := postgresql://trader:local-dev-only@127.0.0.1:55432/trader

# Docker Desktop's CLI can be missing from a non-interactive PATH, like node.
DOCKER_BIN := /usr/local/bin:/Applications/Docker.app/Contents/Resources/bin

.PHONY: test lint typecheck db-up

test lint typecheck:
	@. ./factory/env.sh && cd $(APP) && pnpm install --frozen-lockfile && pnpm $@

# Starts Postgres, waits until it is healthy, then applies the committed
# migrations. Safe to run again. Any failure stops the target non-zero (D11).
# Nothing reads .env: --env-file /dev/null keeps compose from loading one, the
# migration URL is set here, and db:migrate stops drizzle-kit from loading one.
# An image Docker already has under the exact reference in docker-compose.yml
# is never pulled: up gets --pull never, because a pull can hang in Docker's
# credential helper (S0f). --pull missing is not enough: compose still pulls a
# digest-pinned image whose local tag differs. Without the image, compose
# pulls as before, so a clean checkout still works.
db-up:
	@set -eo pipefail; \
	export PATH="$$PATH:$(DOCKER_BIN)"; \
	if ! command -v docker >/dev/null; then \
	  echo "db-up: docker not found. Install Docker Desktop." >&2; exit 1; \
	fi; \
	if ! docker info --format '{{.ServerVersion}}' >/dev/null; then \
	  echo "db-up: cannot reach the Docker daemon. Start Docker Desktop." >&2; exit 1; \
	fi; \
	image="$$(docker compose --env-file /dev/null --file docker-compose.yml config --images)" || { \
	  echo "db-up: cannot read the image reference from docker-compose.yml." >&2; exit 1; \
	}; \
	if [ -z "$$image" ] || [[ "$$image" =~ [[:space:]] ]]; then \
	  echo "db-up: docker-compose.yml must name exactly one image reference." >&2; exit 1; \
	fi; \
	if docker image inspect "$$image" >/dev/null 2>&1; then \
	  pull=(--pull never); \
	else \
	  pull=(); \
	fi; \
	docker compose --env-file /dev/null --file docker-compose.yml up --detach --wait --wait-timeout 120 "$${pull[@]}"; \
	. ./factory/env.sh; \
	cd $(APP); \
	pnpm install --frozen-lockfile; \
	if ! DATABASE_URL='$(DB_URL)' pnpm db:migrate; then \
	  echo "db-up: pnpm db:migrate failed. drizzle-kit does not print the driver error." >&2; exit 1; \
	fi
