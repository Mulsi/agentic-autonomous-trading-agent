# Research

Python 3.12, managed by [uv](https://docs.astral.sh/uv/). This folder is for exploratory work: notebooks, statistics and plots. It is not part of the TypeScript build, lint, typecheck or test run, and no `package.json` script or `make` target calls it.

## Boundary (SLICE_1_PLAN D13)

- **Offline only.** Research runs by hand, outside the trading process, and never on a schedule the agent depends on.
- **Reads from Postgres.** Its input is the data the app has already stored.
- **Never writes to trading tables.** It does not insert, update or delete anything the app reads or writes. The database enforces this: research connects only as `research_reader`, a role that can read and cannot write.
- **Never in the live decision path.** Nothing the agent does at run time waits on, imports or calls Python.
- **Outputs are data.** Parameter proposals, reports and findings affect trading only after the TypeScript replay reproduces them. Logic used in live trading and replay exists once, in TypeScript; it is never reimplemented here.

## Layout

- `notebooks/`: Jupyter notebooks.
- `reports/`: generated reports.

## Database access

Research connects only as `research_reader`, never as `trader`. `trader` is the superuser that the app and `make db-up` use.

```
postgresql://research_reader:research-local-dev-only@127.0.0.1:55432/trader
```

- The migrations create the role on the Postgres server they run against, and grant it, in each migrated database, `CONNECT`, `USAGE` on `public` and `SELECT` on every table in `public`, including tables that later migrations add. It has no other privilege: no insert, update, delete or truncate, and no `CREATE` in any schema. Its sessions also default to read-only transactions.
- The password is a fixed local-development value, like `trader`'s. The app never loads it.

## Use

```sh
cd research
uv sync          # creates .venv from uv.lock
uv run python    # or a notebook kernel from .venv
```

There are no dependencies yet. The first research task adds them with `uv add`, including the Postgres driver it connects with.
