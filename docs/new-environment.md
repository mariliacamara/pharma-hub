# Setting up a new environment

A checklist to repeat, step by step, what was done for the first environment on Railway
on 2026-10-08. It was written to set up the Zincomed environment after the test one.
Last updated 2026-10-08.

No real value is written here. Everything between `<` and `>` is a placeholder. The
real values live in Railway's variables and in a password manager, and nowhere else:
not in this repository, not in a chat, not in an issue.

If a step fails, the table "What went wrong the first time" in
[`operations.md`](operations.md) lists the symptoms seen on the first deploy and
their fixes.

## What is never copied from another environment

Each environment has its own. Reusing one from the test environment defeats its purpose.

| Thing | In a new environment |
|---|---|
| Database | Starts empty. The first deploy creates the tables |
| Password of `pharma_hub_app` | A new one |
| Master key (`CREDENTIALS_MASTER_KEY`) | A new one |
| Plugin tokens | Issued again; the old ones do not exist here |
| The store's KuantoKusta key | Typed in again with `kk:set-key` |
| The store's offers | Copied again from KuantoKusta with `kk:sync-offers` |

## Have at hand before starting

- [ ] Access to the GitHub repository and to the Railway account that will own the
      environment (decide whose account pays for it).
- [ ] `psql` and `openssl` on your computer, and a copy of this repository.
- [ ] A password manager entry for this environment.
- [ ] The store's KuantoKusta Seller API key (from the KuantoKusta back office).

## 1. Project and database

- [ ] Create a new Railway project.
- [ ] Add a **PostgreSQL** database to it. Keep the name Railway gives it (`Postgres`).

## 2. Service

- [ ] Add a service from the GitHub repository `mariliacamara/pharma-hub`, branch
      `main`. Railway finds the `Dockerfile` by itself.
- [ ] The first deploy fails, because the variables are not set yet. That is expected.

## 3. Database role for the service

Railway's own user (`postgres`) is a superuser, and the service refuses to start with
it (decision 0016). The service needs its own, weaker role.

- [ ] In the database's settings, enable public networking and copy
      `DATABASE_PUBLIC_URL`. Do not paste it anywhere but your own terminal.
- [ ] Generate a password of letters and digits only: `openssl rand -hex 24`.
      Save it in the password manager.
- [ ] From the repository folder:

      ```bash
      psql "<DATABASE_PUBLIC_URL>" -v app_password='<password>' -f db/roles.sql
      ```

      It answers `CREATE ROLE`.
- [ ] Disable public networking again.

## 4. Master key

- [ ] Generate it: `openssl rand -base64 32` (44 characters).
- [ ] **Save it in the password manager before anything else.** Without this exact
      value the stored KuantoKusta keys cannot be read again.

## 5. Variables of the service

- [ ] Set these three:

      | Variable | Value |
      |---|---|
      | `DATABASE_URL` | `postgresql://pharma_hub_app:<password>@postgres.railway.internal:5432/railway` |
      | `DATABASE_MIGRATION_URL` | The database's own `DATABASE_URL` (user `postgres`, internal address) |
      | `CREDENTIALS_MASTER_KEY` | `1:<the 44 characters from step 4>` |

- [ ] Confirm the host, port and database name in the database's variables (`PGHOST`,
      `PGPORT`, `PGDATABASE`). Write the address out; the `${{Postgres...}}` references
      did not work the first time.
- [ ] **Do not create `NODE_ENV`.** Without it the service runs as production: logs in
      JSON and no public API reference at `/docs`.
- [ ] Do not create `PORT`. Railway sets it.

Optional, for the price collection. Leave them out unless there is a reason:

| Variable | When to set it |
|---|---|
| `KK_COLLECTION_DAILY_AT` | A time such as `06:30` (Portugal time) turns the daily collection on. **Leave it out until KuantoKusta has agreed to daily page reads.** Without it, a collection runs only when someone asks for one |
| `KK_COLLECTOR_USER_AGENT` | Only if KuantoKusta asks the hub to identify itself with a specific name |

## 6. Settings of the service

- [ ] **Pre-deploy Command**: `npx prisma migrate deploy`
- [ ] **Healthcheck Path**: `/health/ready`

## 7. Deploy and check

- [ ] Deploy. In the **Deploy Logs** (not the Build Logs) look for:
      - `No pending migrations to apply` or a list of applied migrations;
      - `Database connection ready; role is subject to Row Level Security`;
      - `Seller API at seller.kuantokusta.pt`;
      - `Collection worker started` and `Daily collection is off`.
- [ ] Give the service a public address (the service's networking settings). Use the
      port Railway suggests. Which port was chosen on the first deploy was not written
      down; the service listens on the `PORT` Railway gives it, and on 7000 without one.
- [ ] Open `https://<public address>/health/ready`. It answers `{"status":"ok"}`.
- [ ] Open `https://<public address>/docs`. It must answer "not found". If the API
      reference opens, a `NODE_ENV` variable exists: delete it.

## 8. The store

In the service's **Console** tab on Railway (it worked on 2026-10-08):

```bash
node dist/cli.js store:create --slug zincomed --name Zincomed --brand "ZincoGroup Hub"
node dist/cli.js kk:set-key --store zincomed        # asks for the key; it is not shown
node dist/cli.js kk:sync-offers --store zincomed
node dist/cli.js kk:status --store zincomed
```

- [ ] `store:create` answers `Store created: zincomed (Zincomed)`.
- [ ] `kk:set-key` answers that KuantoKusta accepted the key, with its last four
      characters. Type or paste the key only when asked; never after the command.
- [ ] `kk:sync-offers` shows how many offers were copied. On the test environment, on
      2026-10-08: 346 returned, 346 new, none skipped.
- [ ] `kk:status` shows the key as configured and the number of offers.

## 9. Token for the WordPress plugin

```bash
node dist/cli.js token:issue --store zincomed --label "WordPress plugin"
```

- [ ] Copy the token (`phk_...`) straight into the plugin's settings. It is shown once.
      If it is lost: `token:revoke --store zincomed --prefix <first 8 characters>` and
      issue another.

## 10. First price collection

```bash
node dist/cli.js kk:collect --store zincomed
node dist/cli.js kk:runs --store zincomed
```

- [ ] `kk:collect` puts a collection in the queue; the running service carries it out.
      It reads one product page every few seconds, so a few hundred offers take about
      half an hour.
- [ ] `kk:runs` shows how far it is and how it ended.

## What to keep, and where

| Thing | Where it lives | Keep a copy? |
|---|---|---|
| Password of `pharma_hub_app` | Inside `DATABASE_URL`, in Railway | Password manager |
| Master key | `CREDENTIALS_MASTER_KEY`, in Railway | **Password manager, always** |
| Database admin password | The database's variables, in Railway | No. Railway holds it |
| KuantoKusta key | The hub's database, encrypted | No. KuantoKusta's back office has it |
| Plugin token | The plugin's settings in WordPress | No. Issue a new one instead |
| Public address of the service | Railway | Written in the plugin's settings |

## Two environments with the same store

The test environment holds the real Zincomed key and a copy of its offers.

- KuantoKusta limits requests per key. Two environments copying offers with the same
  key at the same time share that limit.
- Each environment that runs a collection reads the same product pages again. Do not
  run collections in both, and never turn the daily collection on in both.
- When the Zincomed environment is in use, delete the test project on Railway, or at
  least its database. There is no command to remove a stored key.
