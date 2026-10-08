# 0018. Build on the `boilerplate-nestjs-swc` base, with six corrections

- Status: Accepted
- Date: 2026-10-08

## Context

The owner chose `luas10c/boilerplate-nestjs-swc` as the base of the project. The first
foundation (decision 0017) had been built from the NestJS 12 generator. It was rebuilt on
the base, taken at commit `593e139`.

The base brings: NestJS 12 as ES modules, compiled with SWC; Jest 30 with `@swc/jest`;
ESLint 10 with `typescript-eslint` and `@stylistic` (no semicolons, single quotes, no
trailing commas); Zod 4 for environment variables; the `#/` import alias for `src/`; tests
under `tests/`; an API reference (Swagger document shown with Scalar) at `/docs`; Husky,
commitlint (Conventional Commits) and neostaged; a Dockerfile; a GitHub Actions workflow.

Reading and running the base showed defects. Numbers 1, 3 and 6 were reproduced by
running it; the others are visible in its files.

## Decision

Adopt the base and its conventions, and correct these points:

| # | In the base | Effect | Change |
|---|---|---|---|
| 1 | Imports have no file extension and SWC does not add one | `npm run build` succeeds, but `node dist/main.js` stops with `ERR_MODULE_NOT_FOUND`, on Node 22 and 24. The service cannot start in production | `"resolveFully": true` in `.swcrc`, and the matching `moduleNameMapper` in the Jest configuration |
| 2 | CORS is `origin: '*'` together with `credentials: true` | Any website may call the API from a visitor's browser. Wrong for a service that will use session cookies | CORS removed. The only client today calls from a server. The panel's exact origin is added when the panel exists |
| 3 | `.husky/pre-commit` runs `npx lint-staged`, but the tool installed is neostaged. And neostaged 0.2.0 runs its tasks with an empty environment (no `PATH`) | The hook does not run the configured checks. Called correctly, neostaged fails with `eslint: not found`, or `node` not found wherever Node.js is installed outside the system folders (nvm, Homebrew) | neostaged removed. The hook runs `npm run lint` and `npm run typecheck` on the whole project, which takes a few seconds at this size |
| 4 | SWC compiles without checking types, and nothing else checks them | A type error reaches production unnoticed | `npm run typecheck` (`tsc --noEmit`), run in CI |
| 5 | The Dockerfile uses `alpine:latest` and whatever Node the package manager has | The runtime version changes without anyone deciding it | `node:24-alpine`, an unprivileged user, and the migrations copied into the image |
| 6 | The coverage threshold is 100% of everything | In this project `npm run test:coverage` failed even with every line tested: decorators compiled by SWC leave branches no test can reach | Coverage is measured on code unit tests can reach; the strict threshold applies to the pure rules of each integration |

Also changed, as choices rather than corrections:

- The API reference at `/docs` is served outside production only.
- The example controller, service and test of the base were removed.
- `dotenv` was removed; `.env` is loaded with Node's own `process.loadEnvFile`.
- CI also runs on pull requests, runs lint and the type check, and has a second job that
  runs the integration tests against a PostgreSQL service.
- The log is one JSON object per line in production, and shutdown hooks are enabled so
  the database pool closes when the host stops the service.

Kept from decision 0017: Prisma pinned to exactly 7.10.0, the driver adapter, and
`prisma.config.ts`.

## Consequences

- Replaces these parts of decision 0017: Vitest, oxlint and Prettier (now Jest and ESLint);
  the hand-written environment validation (now Zod); the `.js` extension in imports (now
  added by the compiler); `.npmrc` with `legacy-peer-deps` (not needed, the base installs
  cleanly).
- The default port is 7000, as in the base.
- The runtime is Node.js 24 (`.node-version`, CI, Dockerfile). The service was also
  started on Node.js 22, but 24 is the supported version.
- Jest gives each test file its own copy of `process.env`. `tests/setup.ts` therefore
  reads `.env` itself; `process.loadEnvFile` would write to a copy the tests do not see.
- The line length of 80 in the base's ESLint configuration is not enforced by the rule
  set as written. Lines ported from the first foundation go up to 100 columns.
- The pre-commit hook checks the whole project, not only the files being committed. If
  that becomes slow, `lint-staged` is the usual tool to check staged files only.
- **The base has no licence file, and its `package.json` says `UNLICENSED`.** Without a
  licence, the default is that the author keeps all rights. It is published as a
  boilerplate, so reuse is clearly the intent, but that is not a written permission. See
  `open-questions.md`.

## Alternatives rejected

- Keep the first foundation: the owner prefers this base.
- Take the base unchanged: the service would not start (correction 1).
- Fork the base and track it as a git remote: the project diverges from the first commit;
  a link to the commit is enough to compare later.
