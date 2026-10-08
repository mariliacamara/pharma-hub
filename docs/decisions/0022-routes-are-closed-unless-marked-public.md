# 0022. Every route is closed unless it is marked public

- Status: Accepted
- Date: 2026-10-08

## Context

The first version applied the token guard controller by controller. A new controller
whose author forgot the guard would have been public, with no test failing. An
independent security review of this step flagged it.

## Decision

- The token guard is registered for the whole application.
- A route answers without a token only if it carries `@Public()`. Today that is the two
  health checks.
- Every other route must declare the scopes it needs with `@RequireScopes(...)`. A route
  that declares none is refused, and the mistake is logged.
- An integration test reads the routes from the running application and checks that
  each one, except the health checks, answers 401 without a token. A route added later
  is covered without anyone listing it.

## Consequences

- Forgetting a decorator closes a route instead of opening it.
- When the admin API arrives it brings a second kind of caller (a person with a
  session). The guard will then choose the check by route prefix (`/v1/plugin`,
  `/v1/admin`); "closed unless marked public" stays.
- The API reference (`/docs`) is not a route of the application and is not covered by
  the guard. It is not served in production (decision 0018), and production is now the
  mode when `NODE_ENV` is not set.

## Alternatives rejected

- Keep the guard per controller and rely on review: the failure is silent.
