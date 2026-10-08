# 0017. NestJS 12 defaults, Prisma pinned to 7, npm workaround

- Status: Partly superseded by [0018](0018-build-on-the-boilerplate-nestjs-swc.md). Still in force: Prisma pinned to 7.10.0, the driver adapter, `prisma.config.ts`
- Date: 2026-10-08

## Context

The project was created on 2026-10-08, when the current releases were NestJS 12 and
Prisma 7.10, with Prisma 8 published as a release candidate under the `latest` tag of
the `prisma` package.

## Decision

- Follow what the NestJS 12 generator produces: ES modules, TypeScript 6, Vitest,
  oxlint, Prettier.
- Pin `prisma`, `@prisma/client` and `@prisma/adapter-pg` to exactly 7.10.0. Prisma 7
  connects through a driver adapter (`pg`) and is configured in `prisma.config.ts`.
- Environment variables are validated by a small hand-written function, and `.env` is
  loaded with Node's own `process.loadEnvFile`, to keep dependencies few.
- `.npmrc` sets `legacy-peer-deps=true`.

## Consequences

- An unpinned `npm install prisma` would bring in the Prisma 8 release candidate, whose
  command line is different. Upgrading is a deliberate step.
- Imports between project files need the `.js` extension, as ES modules require.
- `legacy-peer-deps` hides peer dependency conflicts. It is there because npm 10.9.4
  crashes without it; remove it when a newer npm installs cleanly.
- The project was built and tested on Node.js 22.

## Alternatives rejected

- CommonJS and Jest, as in older NestJS projects: against the grain of the current
  generator, for no benefit here.
- `@nestjs/config` plus a validation library: more dependencies than three variables need.
