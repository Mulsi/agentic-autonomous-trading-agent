ESCALATE

## Why

The build itself looks sound. `gate.md` says `GATE: PASS` and `NEEDS_HUMAN: no`. All four round-1 reviews (code, quant, risk, security) PASS. The diff (commit `3ca6158`, 17 files) stays in scope: three pure modules (`src/shared/decimal.ts`, `src/market-data/normalizer.ts`, `src/market-data/validator.ts`), their specs and fixtures, `decimal.js` 10.6.0 pinned exactly, plus `progress.md`, `tests.json` and the one allowed `repo-files.spec.ts` assertion move. Nothing changes under `src/db/`, `src/config/`, `factory/`, `.claude/`, `CLAUDE.md`, the plans or `docker-compose.yml`. No risk limit, strategy parameter, order path or Claude boundary is touched. Money is `Decimal`, and no thresholds have defaults.

Three things still rule out an automatic APPROVE:

1. **The spec has a `[human]` criterion.** Criterion 31 is the hand smoke check on the real `data.binance.vision` BTCUSDT 15m file for 2026-10-01. The expected result is 96 candles, all unit `us`, nothing quarantined and nothing missing. The spec says no merge criterion depends on it, but the approval rule allows no `[human]` criteria at all.
2. **The spec has an Open decisions section with content.** It records five choices "from the plan's intent". The first is quarantine as a result type with no table. The fourth is the outlier rule. A person should confirm these.
3. **Reviewers flagged real concerns that were not carried forward.** The quant and risk reviewers both found that a zero median makes the outlier rule cascade (`validator.ts:192-194`). After a run of flat bars, such as a maintenance halt or zero-trade bars, `multiple × 0 = 0`, so every normal bar is flagged as `outlier` until half the window is non-zero again. With a production window of about 96 on 15m, one long halt could mark about 12h of real bars as outliers. This fails safe for entries, because the slots become missing, which means UNKNOWN. But it contradicts the spec's claim that flagged bars "never cascade", and the `progress.md` settlement repeats that claim ("flags at most the bars around it"). Neither the zero-median case nor the other hand-offs the reviewers raised appear in the `progress.md` hand-off list:
   - the true range is measured across a gap
   - "closed" depends on the caller's clock or the WebSocket `x` flag
   - quarantining off-grid metrics rows
   - capping payload size at the transport

   So they will be lost unless someone records them. They all fail safe and none of them blocks this job alone, but a person should decide whether they are hand-offs or fixes.

## What a human should check

- **Criterion 31:** run the normalizer by hand over the real BTCUSDT-15m-2026-10-01 spot file, with its CHECKSUM verified. Expect 96 accepted candles, all `unit: 'us'`, with nothing quarantined and nothing missing. `build.md` has a sketch. Use a large `maxRangeMultiple` for this format check.
- **Open decisions 1 to 5 in `spec.md`:**
  - quarantine as a result type, with persistence deferred to S1b
  - out-of-order rows sorted and counted
  - conflicting duplicates quarantine every copy
  - the outlier rule: a true-range ratio against the median of the previous `window` ratios
  - staleness as a caller-supplied `maxAgeMs`
- **The zero-median outlier cascade.** Decide whether S1b handles it (a floor on the reference, or a zero median treated as `unjudged`, plus a pinned test) or whether this job fixes it. Either way, correct the "never cascades" wording in the `progress.md` Market data settlement.
- **Add the reviewers' non-blocking hand-offs to the `progress.md` Market data hand-off list,** so S1b to S1d and S10b see them:
  - the zero median
  - the true range across a gap
  - a bar counted closed by the clock rather than the exchange (server time or the WS `x` flag)
  - off-grid metrics rows
  - payload size caps
- **Builder questions in `build.md`:**
  - a trade count string with leading zeros (`"007"`) is accepted
  - row-check failures carry no `candle` in their record
  - Decimal precision stays at the default 20 significant digits for the outlier ratio
