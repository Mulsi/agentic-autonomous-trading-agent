ESCALATE

## Why

The build is in good shape, and this is a narrow escalation. One approval rule still fails: the spec has an open `[human]` criterion that nobody has signed off.

What holds:

- `gate.md` says `GATE: PASS` and `NEEDS_HUMAN: no`. All four round-3 reviews (code, quant, risk, security) PASS with no blocking findings.
- **Scope.** The diff (`3ca6158`, `78d582a`, `1939223`, 17 files) stays in scope:
  - three pure modules: `src/shared/decimal.ts`, `src/market-data/normalizer.ts` and `src/market-data/validator.ts`
  - their specs and synthetic fixtures
  - `decimal.js` 10.6.0, pinned exactly, with an 8-line lockfile change
  - `progress.md` and `tests.json`
  - the one allowed `repo-files.spec.ts` assertion move (S1a to S1b), plus new S1a assertions
- **Protected paths and safety.** Nothing changes under `src/db/`, `src/config/`, `factory/`, `.claude/`, `CLAUDE.md`, the plans or `docker-compose.yml`. No risk limit, strategy parameter, order path, entry gate, 48-entry counter or Claude boundary is touched. Money is `Decimal`. Outlier thresholds and `maxAgeMs` have no defaults.
- **The round-2 human note was carried out.** I checked the three items against the diff:
  - The zero-median cascade is fixed (`validator.ts`, `outlierVerdicts`: `reference.isZero()` gives `unjudged_zero_median`), with pinned tests and a property.
  - The "never cascades" wording is corrected in code comments and `progress.md`.
  - The reviewers' hand-offs are recorded under S1b, S1c/S1d, S3/S7a and S10b in `progress.md`.
- **Round 3** fixed the quant reviewer's remaining overclaim, which was about flat runs. The low-median probe is pinned with an independent oracle. Quant and risk both recomputed it by hand.
- **Open decisions.** The human note says "The five open decisions in `spec.md` stand as built", so I treat them as settled.

What blocks APPROVE:

1. **Criterion 31 is still `[human]` and still open.** It is the hand smoke check on the real `data.binance.vision` BTCUSDT 15m spot file for 2026-10-01. The round-2 human note settles the Open decisions but says nothing about criterion 31, and no file in the job records that it was run. The spec says no merge criterion depends on it, but the approval rule allows no `[human]` criteria. Meanwhile the diff's `progress.md` already marks S1a `[x]` done.
2. **One judgement call from round 2 changes what gets accepted.** The human note asked the builder to decide it, so this is not a defect, but a person should see it. A genuine spike right after a flat run (median zero) is **accepted** into `candles`. It is only listed in `unjudged`, not flagged. The fail-safe for entries is so far only a `progress.md` hand-off to S3/S7a: "unjudged bars are not verified input". The risk reviewer asks for a dedicated test of that when S3/S7a land.

## What a human should check

- **Criterion 31.** Either run the smoke check or explicitly waive it for this merge.
  - To run it: download BTCUSDT-15m-2026-10-01 from `data.binance.vision` by hand, verify its CHECKSUM, and run the normalizer over it outside the factory.
  - Expect 96 accepted candles, all `unit: 'us'`, with nothing quarantined and nothing missing.
  - Use a large `maxRangeMultiple`, because this is a format check, not an outlier check.
  - `build.md` has a sketch.
- **The spike-after-flat-run choice:** a zero-median spike is accepted and listed in `unjudged`. Confirm this, or ask for a floor on the reference. A floor would need a research-backed number in S1b.
- **Whether the S3/S7a hand-off is binding enough:** "`unjudged` bars are not verified entry input by default". Consider adding it to the S3/S7a backlog acceptance criteria, with the risk reviewer's requested test: a zero-median `unjudged` bar cannot be the only support for an entry.
- **Optional housekeeping:** `spec.md` (in `factory/`) still says flagged bars "never cascade". The builder could not edit it. `progress.md` and the code now state the accurate guarantee.
- **Non-blocking reviewer leftovers:**
  - the `as Parsed` cast in `validator.ts` (around line 299)
  - the round-3 test's `reference()` helper, which hard-codes window 8
