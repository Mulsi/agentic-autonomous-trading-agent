# Human approval (008-normalizer)

Approved by the human on 2026-11-23 via `/factory approve`, after round 3 (gate PASS, all four round-3 reviews PASS, approver ESCALATE).

- **Criterion 31 (real-file smoke check): deferred to S1b, not waived.** S1b builds the bulk loader that downloads and CHECKSUM-verifies `data.binance.vision` files. Its spec must include running the normalizer over the real BTCUSDT 15m spot file for 2026-10-01 as a required criterion, expecting 96 accepted candles in µs with nothing quarantined or missing.
- **Spike right after a flat run: accepted as built.** It is listed in `unjudged`, not flagged. S3 and S7a must not count `unjudged` bars as verified entry input, and their specs must include a test that such a bar cannot be the only support for an entry signal.
- **`spec.md` still says "never cascades".** It is left as the record of what was asked. `progress.md` and the `validator.ts` comment carry the corrected wording.
