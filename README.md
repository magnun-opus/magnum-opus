# Magnum Opus — Phase 1.5

A simulation engine that creates a synthetic world around your application —
users, sessions, intent — and observes how the application behaves as that
world evolves. Scope: API-layer simulation against HTTP applications, with a
deterministic analyst that verifies claims rather than guessing at them.

Phase 1.5 makes the engine reproducible, gives every actor its own identity,
models client abandonment correctly, and replaces the duplicate-write
heuristic with a real oracle.

## What changed from Phase 1

| Area | Phase 1 | Phase 1.5 |
|---|---|---|
| Reproducibility | `Math.random()`, unseeded | Per-actor seeded streams; `--seed` replays a run |
| Client timeout | Aborted the request | Request continues; late responses are recorded |
| `response_received_within_wait` | Hardcoded `false`, unreachable | Genuinely races the pending request |
| Actor identity | All actors shared `sim-session` | Own session, own variables, own request bodies |
| Duplicate-write detection | Flagged the retry *shape* | Verifies distinct records exist, two ways |
| Concurrency | Batch barriers (thundering herd) | Sustained worker pool + think time |
| Event logging | `await` INSERT in the timing loop | Buffered batch writer, timestamps captured in-process |
| Transition weights | Unnormalised, `always` rolled as a peer | Normalised; `always` is a fallback |
| CI usability | Always exit 0 | `--fail-on`, exit 1 on findings |
| Tests | None | 20 unit + 3 integration |
| Dependencies | `pg`, `uuid`, `js-yaml`, `node-fetch` | `pg` only |


## Domain packs

Scaffold a project preloaded with personas and invariants for your industry:

```
npx magnum-opus init --domain banking
```

Available: `banking`, `ecommerce`, `erp`, `food-delivery`, `logistics`,
`marketplace`, `saas` — 15 personas in total.

A persona has two halves. The **endpoints** (`POST /api/transfers`) are
specific to your application and you will rename them. The **journey, the
failure branches and the invariants** are domain knowledge that is the same
for every banking application on earth — and that is the half that takes an
hour to get right. The packs ship the hard half.

What `banking` gives you, for example:

```json
"invariants": [
  { "name": "balance never negative", "type": "bounds",
    "collection": "accounts.accounts", "field": "balance", "min": 0 },
  { "name": "ledger sums to balance", "type": "conservation",
    "sum": { "collection": "ledger.entries", "field": "amount" },
    "equals": { "path": "ledger.balance" }, "tolerance": 0 },
  { "name": "no duplicate transfers", "type": "unique",
    "collection": "ledger.entries", "field": "reference" }
]
```

## Phase 4 — sophisticated personas

### Authentication

Nearly every real application starts behind a login. A persona-level `auth`
block runs once per actor, extracts a token, and carries it on every later
request — including probes.

```json
"auth": {
  "action": "POST /api/auth/login",
  "body": { "email": "{{actor.sessionId}}@example.test", "password": "hunter2" },
  "extract": { "token": "token", "userId": "userId" },
  "header": "Authorization",
  "format": "Bearer {{vars.token}}"
}
```

Login is logged as its own event, so a failure at the door reads as a login
failure rather than every endpoint mysteriously returning 401. Any field
named like a credential is redacted before it reaches the event log.

### Choosing from lists

```json
"extract": {
  "productId": { "path": "products", "pick": "random", "field": "id" },
  "price":     { "path": "products", "pick": "random", "field": "priceMinor" }
}
```

`pick` accepts `random`, `first`, `last`, or an index. Random draws come from
the actor's own seeded stream, so sixty actors make sixty different choices
and make the same ones on every replay — without this, a population is one
user run sixty times, which hides the contention bugs the tool exists to find.

Two random picks from the **same path agree on one element**. Otherwise an
actor buys one product at another's price: a persona that is silently wrong,
which is worse than one that fails loudly.

### Actor state

```json
"set": {
  "budget": { "subtract": "{{vars.price}}" },
  "polls":  { "add": 1 }
}
```

Operations: `add`, `subtract`, `multiply`, `assign` (a bare value is
shorthand for assign). Combined with `when` conditions this gives economic
actors — buy only what you can afford — and bounded loops: increment a
counter, then let `when` decide whether to poll again.

### Two more invariant types

```json
{ "name": "inventory never negative", "type": "bounds",
  "collection": "catalogue.products", "field": "stock", "min": 0 }

{ "name": "tracking number format", "type": "match",
  "collection": "shipments.shipments", "field": "trackingNumber",
  "pattern": "^SHIP-[A-Z0-9]{5,}$" }
```

`bounds` reports a single violating record rather than an aggregate — one
negative balance among ten thousand is still a broken system. `match` covers
presence and format.

Patterns interpolate, so `"^{{vars.userId}}$"` asserts that every record
belongs to the actor who asked. Substituted values are regex-escaped, so a
value containing `.` cannot silently widen the pattern.

## Phase 3 — what's new

| Capability | What it does |
|---|---|
| Epochs | Run waves of actors so world state accretes; measure how the app degrades |
| Degradation detector | Fits latency against data volume; flags missing indexes and scans |
| Chaos injection | `delay`, `reset`, `duplicate` faults, drawn from the seeded stream |
| `when` conditions | Actors carry budgets or quotas and branch on them declaratively |
| OpenAPI generation | Drafts a persona from a spec — scaffolding, not a finished persona |

### Chaos

```json
"chaos": { "enabled": true, "rate": 0.25,
           "faults": { "delay": 0.5, "reset": 0.25, "duplicate": 0.25 } }
```

Scope, stated plainly: this does not control your infrastructure, so it
cannot kill your database or partition your cluster. It models an unreliable
network between client and application — which is what actually produces the
abandonment and retry this tool examines.

`duplicate` is the fault worth having. It sends the request twice, modelling
a retrying proxy or load balancer, and the client never learns a second one
happened. Run it against the buggy sample app with latency disabled, so no
client ever times out and no client ever retries:

```
SAMPLE_APP_SLOW_RATE=0 npm run demo:all              # 0 Critical — bug invisible
SAMPLE_APP_SLOW_RATE=0 npm run demo:all -- --chaos   # 2 Critical — bug found
```

Same application, same seed. The bug is unreachable through well-behaved
client behaviour alone, and no amount of correct client code prevents it.

Every fault is drawn from the actor's seeded stream, at a constant cost of
three draws per request whether or not a fault fires — an uneven cost would
desync unrelated later decisions when fault weights change.

### Epochs and time compression

```json
"epochs": { "count": 5, "stepDays": 90, "clockHeader": "X-Simulated-Time" }
```

This cannot move your application's clock. What it does is accrete world
state in waves and measure how the application behaves as data piles up —
the class of bug no single-wave load test reaches. If your app honours a
simulated-clock header, set `clockHeader` and each wave advances it, which
gets you real time travel: expiring tokens, fiscal rollovers, retention jobs.

Latency is fitted against cumulative record count on a log-log scale:

```
log(L) = k·log(n) + c
k = Σ((x−x̄)(y−ȳ)) / Σ((x−x̄)²)      x = log n,  y = log L
```

`k ≈ 0` is constant time. `k ≈ 1` is linear — a full table scan. Findings
require R² ≥ 0.7, at least a doubling of latency, and a latency floor, so
scatter is not reported as a trend.

```
npm run demo:all -- --fixed --scan --epochs
```

```
  world state: 40,000 orders
  ...
  world state: 200,056 orders

[WARNING ] temporalDegradation
  GET /orders degrades as data accumulates: p95 rose from 21ms at 40,000
  records to 55ms at 200,056. Growth exponent k=0.67 (R²=0.84)
```

The same run with the index intact reports nothing. Note that `k` reads
lower than the theoretical 1.0 for a scan, because constant HTTP and network
overhead sits underneath every measurement and dilutes the exponent — the
threshold is tuned for observed values, not theoretical ones.

Verification runs after **each** wave, not once at the end. Verifying only at
the end measures the final world state for every epoch, which flattens the
curve and hides exactly what this mode looks for.

### Actors with state

```json
{ "to": "buy", "condition": "when",
  "when": { "path": "vars.budget", "gte": { "path": "vars.price" } } }
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`. Operands are literals or
`{ "path": "..." }` references into the actor's own state. A fixed set, for
the same reason as the invariant DSL — a config file should not execute
arbitrary code.

### Generating a persona from OpenAPI

```
npx magnum-opus generate --spec openapi.json
```

Deterministic heuristics, not AI: `GET /things/{id}` becomes a browse state,
`POST /things` becomes a write with an `intent` and a retry path, and a
resource with both `POST /things` and `GET /things` gets a probe plus a count
invariant — that pair is exactly what verifies idempotency.

It produces a **draft**. Body fields it cannot infer are marked `TODO_`, and
the spec describes shapes, not meaning: it cannot tell you what a correct
outcome looks like. Expect to edit it.

## Phase 2 — what's new

| Capability | What it does |
|---|---|
| Safety guard | Refuses non-local targets unless allowlisted **and** acknowledged |
| Installable | `npm i -D magnum-opus`, `npx magnum-opus init`, personas live in your repo |
| Invariant DSL | Declare `count`, `unique`, `conservation` rules instead of writing detectors |
| Isolation detector | Catches cross-tenant data leaks — invisible to single-user tests |
| Differential runs | `diff` two runs: what's new, fixed, unchanged |
| Flake filter | `--repeat N --min-occurrences k` discards non-reproducing findings |
| SARIF + JUnit | `--format json,sarif,junit` for GitHub code scanning and CI |
| `demo:all` | One command, no second terminal, no port collision |

## Prerequisites

- Node.js 18+ (uses the built-in `fetch` and `crypto.randomUUID`)
- Postgres 14+

## Getting started

Three commands, then fifteen minutes of decisions only you can make.

### 1. Prerequisites

Node 18+ and a running Postgres. On Windows, install from
<https://www.postgresql.org/download/windows/> and note the password and port
you choose. Or skip the install entirely:

```
docker run --name magnum-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
```

### 2. Setup

```
npm install
npx magnum-opus setup
```

`setup` prompts for your connection details, **tests them before writing
anything**, creates both databases, writes `.env`, and applies the schema.
A saved `.env` is therefore always a working `.env`.

For scripts and CI:

```
npx magnum-opus setup --non-interactive \
  --db postgres://postgres:PASSWORD@127.0.0.1:5432/magnum_opus \
  --target http://localhost:3000
```

### 3. Check the environment

```
npx magnum-opus doctor
```

```
[  ok  ] Node.js        v22.22.2
[ FAIL ] .env file      found .env.text but no .env
               Rename it:  ren .env.text .env
               (Notepad appends an extension unless "Save as type" is All Files)
[  ok  ] Database       postgres://postgres:****@127.0.0.1:5432/magnum_opus
[  ok  ] Schema         all tables present
[ FAIL ] Ports          database and target are both on 4000
```

Checks run in an order where the first failure is the actual cause — the
database before the target, because "target unreachable" is misleading when
nothing is configured yet.

### 4. Point it at your app

```
npx magnum-opus init
npx magnum-opus generate --spec openapi.json
```

Then the part that cannot be automated: mark the write you care about with
`intent`, confirm the read-back probe, and choose the invariants that matter
in your domain. A spec describes shapes; only you know what a correct outcome
means. Budget fifteen minutes.

### 5. Validate before running

```
npx magnum-opus validate
```

```
  impatient_customer
    ok    GET /products/2                    HTTP 200
    ok    POST /cart                         HTTP 201
    FAIL  POST /checkout                     HTTP 404
    FAIL  probe "orders"                     unreachable

2 of 4 endpoint(s) responded successfully.
```

One actor, no database writes, under a second. A full run against a
misconfigured target burns ninety seconds and reports a 100% error rate and
high abandonment — findings about your configuration, not your application.
`validate` tells you which endpoint is wrong before you pay for that.

### 6. Run

```
npx magnum-opus run
```

### Troubleshooting

| Symptom | Cause |
|---|---|
| `'createdb' is not recognized` | Not needed. `magnum-opus setup` creates databases over SQL. |
| `'cp' is not recognized` | Windows cmd. `setup` writes `.env` for you. |
| Blank error after a command | An old build. Current versions unwrap Windows `AggregateError`. |
| 100% error rate, high abandonment | The target is wrong. Run `doctor`, then `validate`. |
| Invariant "could not be checked" | A probe was unreachable. That is honest reporting, not a pass. |

## Running the demo

One command — boots the sample app in-process on a free port, runs the
simulation, shuts down. No second terminal, no port collision with Postgres:

```
npm run demo:all                        # buggy app  -> critical findings
npm run demo:all -- --fixed             # correct app -> none
npm run demo:all -- --fixed --leak      # correct writes, but leaks tenants
```

The third is the one worth running. Writes are perfectly idempotent, so
`duplicateWrites` reports a clean pass — and `isolation` still finds this:

```
2 Critical   0 Warning   1 Info

[CRITICAL] isolation
  GET /orders leaked data across actors: 55 response(s) served one actor data
  belonging to another. Example: the actor identified as sim-demo-all-0
  received data belonging to sim-demo-all-10.

[CRITICAL] invariantViolations
  Invariant "one order per intent" violated for 55 actor(s).

[INFO    ] duplicateWrites
  POST /checkout honoured idempotency: 8 intent(s) were retried and each
  resolved to a single record.
```

A missing `WHERE session_id = $1` is invisible to any single-user test. It
only appears when more than one actor exists at the same time.

The two-terminal form still works if you prefer it:

```
npm run sample:seed
npm run sample:start          # terminal 1
npm run demo                  # terminal 2
```

## Using it on your own application

Magnum Opus is a dev dependency of the project it tests. Your personas
describe your endpoints, so they belong in your repository:

```
cd your-project
npm install --save-dev magnum-opus
npx magnum-opus init
```

That scaffolds:

```
magnum/
  config.json
  personas/exampleCustomer.json
```

Point `baseUrl` at your app, rewrite the persona to describe a real flow,
then:

```
npx magnum-opus setup       # once — creates and migrates the event-log database
npx magnum-opus run
```

Budget an hour for the persona, not five minutes for the URL. Describing the
flow accurately is the work; everything else is configuration.

### Safety

Loopback and private (RFC1918) targets run freely. Anything public is refused
unless you do **both**: list the host in `allowedHosts`, and pass
`--i-know-this-is-not-production`. Two independent gestures, because one is
too easy to leave sitting in a committed CI file.

This tool abandons requests mid-flight and retries write intents. Against a
live system that is an incident, not a test.

### Invariants

Declare what must be true; the engine checks it after the run settles.
Probes fetch state, invariants assert over it:

```json
"probes": {
  "orders": { "action": "GET /orders?sessionId={{actor.sessionId}}" },
  "ledger": { "action": "GET /ledger?account={{actor.sessionId}}" }
},
"invariants": [
  { "name": "one order per checkout",
    "type": "count", "collection": "orders.orders",
    "atMost": { "intents": "checkout" } },

  { "name": "order ids distinct",
    "type": "unique", "collection": "orders.orders", "field": "id" },

  { "name": "ledger balances",
    "type": "conservation",
    "sum": { "collection": "ledger.entries", "field": "amount" },
    "equals": { "path": "ledger.balance" },
    "tolerance": 0 }
]
```

Three types only — `count`, `unique`, `conservation` — deliberately a closed
set rather than an expression language: easier to report on, impossible to
make non-deterministic, and no arbitrary code from a config file. Isolation
is evaluated globally rather than per actor, so it needs no declaration.

### CI

```
npx magnum-opus run --seed nightly --format json,sarif,junit --fail-on critical
```

Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` error,
`3` refused target.

### Differential runs

```
npx magnum-opus run --seed pr-482          # note the run id
npx magnum-opus diff --baseline <id> --candidate <id>
```

```
0 new   2 fixed   0 unchanged
```

Findings match on a fingerprint derived from the detector's signature —
endpoint and violation kind, never counts — so the same defect matches itself
whether it hit 14 actors or 18. `diff` exits 1 only when something is *new*,
which is what makes it a merge gate rather than a report on your backlog.

### Flake filtering

Your application, its database and the network still vary even with a fixed
seed. For a noisy target:

```
npx magnum-opus run --repeat 5 --min-occurrences 3
```

Only findings appearing in at least 3 of the 5 runs are reported. Without
this, differential mode cries wolf.

## How the duplicate-write oracle works

Every mutating state can declare an `intent`. The engine derives one
idempotency key per intent and reuses it across retries, so attempts are
grouped by what the actor *meant* rather than by sniffing a `retry` tag.

Two independent evidence sources:

1. **Observed identities.** Collect the identifying field from every response
   for that key, including `late_response` events — requests the client
   abandoned but the server completed anyway. Two distinct ids proves a
   duplicate. One id proves the key was honoured. Zero means unverified.
2. **Read-back.** After `registry.drain()` — every in-flight request settled —
   ask the application how many records exist for the actor's session.
   `actual > expected` is a duplicate even when no response was ever seen.

Findings are aggregated per endpoint. One defect affecting sixty actors is
one finding, not sixty.

## Configuration

```json
{
  "baseUrl": "http://localhost:3000",
  "personaMix": { "impatient_customer": 50, "price_checker": 30, "bulk_buyer": 20 },
  "concurrency": 25,
  "arrivalRatePerSec": null,
  "idempotency": { "enabled": true },
  "failOn": "critical",
  "detectors": {
    "duplicateWrites": { "identityFields": ["orderId", "id"] },
    "errorSpikes": { "warnAt": 0.15, "criticalAt": 0.3 },
    "abandonmentRate": { "threshold": 0.25 }
  }
}
```

`concurrency` runs a closed-model worker pool: a slot opens the moment an
actor finishes. Set `arrivalRatePerSec` instead for an open model, where
inter-arrival times are drawn from an exponential distribution
(`t = -ln(1-u)/λ`) — actors arrive whether or not the app is keeping up,
which is what builds a queue.

Set `"idempotency": { "enabled": false }` to observe how the app behaves
when clients don't send the header at all.

## Writing personas

```json
{
  "persona": "impatient_customer",
  "patience_ms": 1200,
  "variables": { "productId": { "choice": [1, 2, 3] } },
  "verification": {
    "action": "GET /orders?sessionId={{actor.sessionId}}",
    "collection": "orders"
  },
  "states": [
    {
      "name": "checkout",
      "on_enter": {
        "event_type": "http_request",
        "action": "POST /checkout",
        "intent": "checkout",
        "body": { "sessionId": "{{actor.sessionId}}" },
        "extract": { "orderId": "orderId" }
      },
      "think_ms": [100, 400],
      "transitions": [
        { "to": "checkout_success", "condition": "on_success" },
        { "to": "wait_for_response", "condition": "on_timeout" }
      ]
    },
    { "name": "checkout_success", "terminal": true, "outcome_class": "success" }
  ]
}
```

- `{{actor.sessionId}}`, `{{vars.x}}` — a string that is *exactly* one
  placeholder keeps its type; embedded placeholders stringify.
- `extract` pulls values out of a response into `vars` for later states.
- `intent` groups attempts for the idempotency oracle.
- `outcome_class` on terminal states is what detectors read, so renaming a
  state no longer silently disables a detector.
- `think_ms` is drawn from the actor's own seeded stream.

## Determinism

A single seeded PRNG is *not* reproducible under concurrency: actors
interleave in a nondeterministic order, so draw order varies. Each actor
therefore gets an independent stream derived from `(runSeed, actorIndex)`,
consumed only by that actor in the fixed order its state machine dictates.

UUIDs are deliberately *not* seeded — re-running a seed would collide on
primary keys. Cross-run diffing joins on `(actor_index, trace_sequence)`.

Note that determinism covers the *simulation*. The application under test,
its database and the network remain sources of variation; the seed removes
the engine as a variable, not the world.

## Tests

```bash
npm test              # unit + integration
npm run test:unit     # no database required
```

Integration tests boot the sample app in both modes and assert that the
seeded bug is caught, that the fixed version produces zero criticals, and
that one seed replays to an identical action sequence. They skip with a
message if Postgres is unreachable.

## Extending the detector set

Add a file to `src/analyst/detectors/`, export
`async (runId, options) => [...findings]`, and register it in the `DETECTORS`
map in `src/analyst/analyst.js`. Options come from `config.detectors.<name>`,
so thresholds stay out of the source. Findings need `severity`, `detector`,
`summary`, and should carry `evidence_trace_ids` plus an `evidence` object.

## Scope and limits

What this deliberately does not do, and what it only partly does. Kept
honest because a testing tool that overstates its reach is worse than one
that admits its edges.

**Not built**

- **Browser and UI interaction.** API layer only. Nothing here drives a
  browser, so anything that only breaks in the client is out of reach.
- **Visual dashboard.** Reports are terminal output, JSON, SARIF and JUnit.
- **Codebase scanning.** `generate` reads an OpenAPI document, not your
  source. Inferring journeys from code is guesswork; the better structural
  source is your database's own constraints.

**Partly built**

- **Chaos is client-side only.** `delay`, `reset` and `duplicate` model an
  unreliable network between client and application. There is no CPU
  pressure, no dependency failure, no killing your database — Magnum Opus
  never touches your infrastructure, which is what makes the safety guard a
  real promise rather than a hope.
- **Time compression accretes state; it does not move your clock.** Epochs
  grow the world in waves and measure how the application degrades as data
  piles up. If your app honours a simulated-clock header, set
  `epochs.clockHeader` and you get real time travel — otherwise you get
  volume, not calendar.
- **Determinism covers the simulation, not the world.** A seed removes the
  engine as a variable. Your application, its database and the network still
  vary, which is what `--repeat` and the flake filter exist for.

**Built, and worth naming because earlier drafts of this file said otherwise**

- Multi-year state accretion with a degradation detector (Phase 3)
- Persona generation from an OpenAPI document (Phase 3)
- Network chaos injection (Phase 3)

## Where it sits

Related tools point in different directions, and it is worth being precise:

- **Mock servers** (WireMock, Microcks, Mockoon) stand in for a dependency
  *your app calls*. Magnum Opus is a client that calls *your app*. They
  compose; they do not compete.
- **Load testers** (k6, Gatling, Locust) point the same way and handle
  concurrency and latency better. They do not assert business truths.
- **Deterministic simulation testing** (Antithesis, Jepsen) is the nearest
  relative and goes far deeper — whole-system determinism, hypervisor-level
  fault injection, perfect replay. It also requires containerising your
  entire stack and is aimed at distributed-systems infrastructure.

Magnum Opus sits at the accessible end of that last category: black-box over
HTTP, no changes to your application, self-hosted, aimed at business-logic
correctness in ordinary applications rather than at consensus protocols.
