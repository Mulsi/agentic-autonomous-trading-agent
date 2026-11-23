# Real-file check (criterion 34, carried from S1a criterion 31)

Run by the orchestrator on 2026-11-23, after the human approved the two downloads from `data.binance.vision` (`BTCUSDT-15m-2026-10-01.zip.CHECKSUM`, 92 bytes; `BTCUSDT-15m-2026-10-01.zip`, 5,615 bytes). Branch `factory/009-bulk-loader` at `2c00bdc`. The archives stayed in memory, the run was a dry run, and nothing was written to a database or to disk.

## Command

From the job worktree root:

```sh
. factory/env.sh
cd local-trading-agent-backend
pnpm build
env -i PATH="$PATH" HOME="$HOME" node dist/backfill.js --dry-run \
  --symbol BTCUSDT --interval 15m --period daily \
  --from 2026-10-01 --to 2026-10-01 \
  --outlier-window 4 --outlier-multiple 1000
echo "exit=$?"
```

## Output

`pnpm build` exited 0. The check exited 0 with nothing on stderr. Stdout:

```json
{"file":"BTCUSDT-15m-2026-10-01.zip","sha256":"4329590fe606ba6f2d5eff81d5d553972514a201909784225fe8fbff1e663b48","header":false,"rows":96,"accepted":96,"open":0,"quarantined":{},"missing":[],"unjudged":5,"duplicatesCollapsed":0,"outOfOrder":0,"timeUnits":{"us":96,"ms":0,"unreadable":0},"firstOpenTimeMs":1790812800000,"lastOpenTimeMs":1790898300000,"lastCloseTimeMs":1790899199999,"written":false,"inserted":0,"alreadyStored":0,"storedConflicts":0,"outlier":{"window":4,"maxRangeMultiple":1000,"provisional":true},"status":"loaded","checksum":"verified","detail":null}
```

## Result: PASS

Every field in the criterion 34 table matches: `status` loaded, `checksum` verified, `rows` 96, `accepted` 96, `open` 0, `quarantined` {}, `missing` [], `timeUnits` {"us":96,"ms":0,"unreadable":0}, first and last open times 1790812800000 and 1790898300000, last close 1790899199999, `duplicatesCollapsed` 0, `outOfOrder` 0, `unjudged` 5, `written` false, and `outlier` {"window":4,"maxRangeMultiple":1000,"provisional":true}.

Keys outside the table: `header` false, `inserted` 0, `alreadyStored` 0, `storedConflicts` 0, and `detail` null, as the build and the reviews expected. This confirms that the real bulk file uses µs timestamps, which the S1a fixtures modelled.
