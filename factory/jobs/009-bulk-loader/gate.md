GATE: PASS
NEEDS_HUMAN: yes

## Checks
- PASS `pnpm install --frozen-lockfile`
- PASS `pnpm test`
- PASS `pnpm lint`
- PASS `pnpm build`

## Test integrity
- PASS no test deleted or skipped

## Tripwires
- PASS none

## Protected paths
These changes need a human:
```
local-trading-agent-backend/src/db/migrations/0004_market_data.sql
local-trading-agent-backend/src/db/migrations/meta/0004_snapshot.json
local-trading-agent-backend/src/db/migrations/meta/_journal.json
```
