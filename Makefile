# Each target installs dependencies itself, so all of them work on a clean
# checkout. Recipes source factory/env.sh because non-interactive shells have no
# node or pnpm. The paths are relative, so a repo path with spaces is fine.
SHELL := /bin/bash
APP := local-trading-agent-backend

.PHONY: test lint typecheck

test lint typecheck:
	@. ./factory/env.sh && cd $(APP) && pnpm install --frozen-lockfile && pnpm $@
