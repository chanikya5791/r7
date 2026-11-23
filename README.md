# ShopLite API test suite (r7)

Black-box tests for the **running** ShopLite stack: the Users (r6), Catalog (r3) and Orders (r2) APIs, and the
jobs worker (r4) through its effects. Every response is checked for status and shape (zod contracts in
`src/schemas.ts`, mirroring each service's `openapi.yaml`). Also includes a **Postman / Newman** collection. See
the [infra repo (r5)](../r5) for the whole system.

## Run

```bash
# Start the stack first (in r5): make up
npm ci
npm test                 # everything (about 25 s)
npm run test:users       # or test:catalog, test:orders, test:flows
npm run test:newman      # the Postman collection
```

Before any test runs, the suite checks that every service is healthy and stops with a clear message if not.
Point it at another deployment with the variables in `.env.example` (`USERS_API_URL`, `CATALOG_API_URL`,
`ORDERS_API_URL`, `JOBS_HEALTH_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ASYNC_TIMEOUT_MS`). With `CI=true`, a JUnit
report is written to `reports/junit.xml`.

Each test creates its own users and products, so the suite can run repeatedly and in parallel against the same
stack.

## What is covered (84 tests)

| File | Covers |
|---|---|
| `tests/health.test.ts` | Every service's `/health` and its dependencies, JSON 404s, `X-Request-Id` echo |
| `tests/users.test.ts` | Registration (normalisation, duplicates, validation, malformed JSON, no self-promotion to admin), login, `/users/me`, tampered and `alg: none` tokens, admin-only listing, paging, per-user access |
| `tests/catalog.test.ts` | Product CRUD, read-public / write-admin rules, SKU conflicts, validation, SKU cannot change, filters, search with regex characters, sorting, paging, categories, report access |
| `tests/orders.test.ts` | Pricing from the catalog (client prices ignored), validation, 422 unknown product, 409 stock, idempotency (replay, concurrency, per-user scope), visibility rules, cancel rules |
| `tests/flows.test.ts` | Across services through Kafka: `PENDING → PROCESSED` with stock and timeline; two orders racing for the last unit; stock disappearing before processing; cancel after processing (stock returned); cancel while pending; activity privacy; one JWT working across APIs; the daily report |

## Postman / Newman

`postman/shoplite.postman_collection.json` with `postman/local.postman_environment.json`: health checks; admin
login; create a product; register and log in a customer; place an order; replay it with the same
`Idempotency-Key`; poll until `PROCESSED`; check stock and timeline; cancel; cancel again (409); then error
cases (401, 409, 422, 400, 403) and clean-up. Import both files into Postman, or run `npm run test:newman`.

## CI

- `.github/workflows/ci.yml` type-checks the suite.
- `.github/workflows/full-stack.yml` checks out all seven repos at the same branch, starts the stack with r5's
  `make up`, and runs this suite and the Newman collection. For private repos, add a `SHOPLITE_REPOS_TOKEN`
  secret with read access to r1–r7.
