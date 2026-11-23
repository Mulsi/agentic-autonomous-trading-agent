# Human approval (009-bulk-loader)

Approved by the human on 2026-11-23 ("Approve, merge on match"), after round 1 (gate PASS, all four reviews PASS, approver ESCALATE).

- **Migration `0004_market_data`** (`assets`, `candles`, `market_data_quarantine`): approved.
- **Criterion 34 (real-file check):** the two downloads were approved, and the orchestrator ran the check. It passed, matching every field: see `real-file-check.md`.
- **The seven open-decision choices** in `spec.md` are confirmed as built: klines only (derivatives split to S1b2, before S2c), `assets` now, a quarantine table, a bar after a gap still judged, archives in memory only, an in-repo zip reader, and writes only with a `VERIFIED` identity.
- **The four deviations are accepted:**
  - `storeFile` instead of `writeFile`.
  - Accumulated `history`; criterion 18 is amended to match.
  - Money stored via `Decimal.toFixed()`, so source trailing zeros are dropped and no later job may read tick size from a column's scale.
  - The extra `detail` summary key.
- **Production outlier window and multiple** are still unset. The human picks them for the 2022 backfill, with the multiple at least 1. Do not use the check's permissive `--outlier-multiple 1000` for a write run: it would store real spikes marked as checked. The quant reviewer recommends one monthly run per symbol and interval, so only the first `window + 1` bars of 2022-01 stay unjudged.
