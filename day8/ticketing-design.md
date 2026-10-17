# TicketHub Event Ticketing System Design

## Executive summary

TicketHub sells assigned seats for live events.
The normal product serves event discovery, seat maps, and ticket retrieval.
Flash sales create a different workload: many people compete for a fixed,
small inventory within a few minutes.

The design deliberately separates traffic shaping from correctness.
A Cloudflare edge layer and a Virtual Waiting Room protect the API from
unbounded bursts. Stateless application servers handle admitted requests.
Redis provides fast, temporary coordination, but PostgreSQL remains the
authoritative record. Database row locks serialize contested seat changes,
and named relational constraints prevent duplicate active holds and sales.

This document describes one production-oriented design, including the
assumptions that should be validated with load tests and operational data.

## 1. Requirements

### 1.1 Functional requirements

1. Customers can browse published events, event details, venue sections,
   prices, and seat availability.
2. Customers can create an account, authenticate, and view their own bookings
   and issued tickets.
3. A customer can place a temporary hold on one or more available seats.
4. A hold has an explicit expiry, initially five minutes after creation.
5. A customer can release a hold or complete checkout before it expires.
6. A completed purchase produces one durable ticket for each purchased seat.
7. A customer can safely retry a purchase after a timeout by reusing the same
   idempotency key.
8. The API can show a customer's booking and ticket status without exposing
   another customer's private data.
9. Event operators can create events, configure seats and prices, and publish
   or cancel events through authorized operational tooling.
10. Expired holds are released by a background expiry process and can then be
    acquired by another customer.
11. The service can send confirmations and perform payment reconciliation
    asynchronously after a purchase request has been accepted.
12. Event browsing remains useful if ticket purchasing is paused or a flash
    sale is temporarily gated.

### 1.2 Non-functional requirements

#### Speed

- Target p95 below 250 ms for event catalogue and cached seat-map reads during
  ordinary load.
- Target p95 below 1 second for an admitted hold or purchase API response,
  excluding external payment settlement and email delivery.
- During flash sales, communicate queue position and estimated wait instead
  of allowing requests to accumulate without feedback.
- Use CDN caching for public, versioned content and bounded short-lived
  caching for event metadata and availability summaries.

#### Correctness

- A physical seat may have at most one active booking hold at a time.
- A physical seat may have at most one issued ticket ever for a given event.
- The database is authoritative for booking and ticket ownership.
- Redis availability or lock state must never be interpreted as proof of sale.
- Ownership, seat, booking, and ticket relationships are enforced with foreign
  keys and unique constraints, in addition to application checks.
- Hold expiry is based on a database timestamp and state transition, not only
  on the disappearance of a Redis key.

#### Fairness

- The Virtual Waiting Room admits customers at a controlled rate.
- When the sale opens, eligible customers enter the waiting room using a
  documented, auditable ordering policy (for example, randomized ordering
  within the pre-sale arrival window).
- Admission tokens are signed, short-lived, bound to the sale and customer,
  and checked by the API; they cannot be forged to skip the queue.
- Rate limits and bot controls apply per account, IP range, and sale.
- A user cannot increase their position by refreshing or opening many tabs.
- Fairness policy must be communicated before a sale; it must not silently
  prioritize faster networks or repeated retries.

#### Availability and recovery

- Target 99.9% monthly availability for the customer-facing service.
- Run edge, load-balancing, application, queue, and database standby
  capabilities across availability zones.
- A cache failure may reduce performance but must not erase or corrupt a sale.
- A queue or email failure may delay secondary work but must not duplicate a
  committed ticket.
- Maintain encrypted backups and point-in-time recovery, and regularly test
  database restoration and failover.

#### Idempotency

- Mutating endpoints accept an `Idempotency-Key` header.
- The key is stored with the authenticated customer and operation result.
- Repeating a key with the same request returns the original result.
- Repeating the same key with a different request body returns a conflict.
- The payment provider receives a stable idempotency key for authorization
  and capture/void operations.
- Queue consumers are idempotent because messages can be delivered more than
  once.

#### Security and operability

- Enforce HTTPS, authenticated sessions, role-based operator access, and
  per-resource authorization.
- Do not store raw payment-card numbers or security codes.
- Validate all IDs, prices, quantities, request sizes, and state transitions.
- Record structured logs, traces, and metrics with request and sale IDs.
- Alert on queue depth, lock waits, payment errors, replica lag, and rates of
  rejected or duplicate booking attempts.
- Do not expose stack traces, payment secrets, or another customer's booking
  data in API responses or logs.

## 2. Capacity and traffic estimates

These estimates are explicit planning assumptions, not a substitute for
production telemetry or a load test. Rates shown are averages over the stated
window; flash-sale bursts can be materially higher.

### 2.1 Baseline daily traffic

Assumptions:

- 50,000 daily active users (DAU).
- 500,000 page views each day across event pages, seat maps, account pages,
  and ticket views.
- 5,000 completed ticket sales per day.
- 86,400 seconds in a day.
- For an initial storage model, each sale consumes about 2 KB of logical
  booking/ticket row and index space. This is a deliberately rough average.

Calculations:

| Measure | Calculation | Baseline estimate |
|---|---|---:|
| Page views per day | Given workload | 500,000 |
| Average page views per second | `500,000 / 86,400` | 5.79 views/s |
| Sales per day | Given workload | 5,000 |
| Average completed sales per second | `5,000 / 86,400` | 0.058 sales/s |
| Annual sales | `5,000 × 365` | 1,825,000 sales/year |
| Logical sale data per year | `1,825,000 × 2 KB` | about 3.65 GB/year |

The page-view count is not the same as HTTP request count. A page can issue
several API calls and static asset requests; CDN caching reduces origin
requests, while API and seat-map traffic must be measured separately.

### 2.2 Ten-minute flash sale

Assumptions:

- 200,000 concurrent users are competing during one ten-minute sale window.
- There are 20,000 sellable seats in the event.
- For the required average write estimate, each waiting customer attempts one
  hold or purchase operation during the 600-second window.
- Retries, seat-map refreshes, payment callbacks, and bot traffic can add load
  beyond the first-attempt estimate.

Calculations:

| Measure | Calculation | Flash-sale estimate |
|---|---|---:|
| Competing users | Given workload | 200,000 |
| Available seats | Given inventory | 20,000 |
| Demand-to-supply ratio | `200,000 / 20,000` | 10 users per seat |
| Window length | Given workload | 600 seconds |
| Average write attempts per second | `200,000 / 600` | about 333 writes/s |
| Maximum successful sales | Seat inventory limit | 20,000 tickets |
| Average successful sales if all seats sell evenly | `20,000 / 600` | about 33.3 sales/s |
| Logical data for 20,000 tickets | `20,000 × 2 KB` | about 40 MB |

The 333 writes/s figure is incoming hold/purchase attempt pressure, not a
promise that every write can succeed. Inventory caps successful tickets at
20,000; the remaining customers must receive a clear unavailable result or
remain in the waiting-room flow for another available seat or sale.

### 2.3 Capacity and load-test plan

- Size the waiting room and API for at least twice the measured expected
  arrival rate, then validate queueing and database saturation under a
  realistic burst profile.
- Test at 333 write attempts/s plus read refreshes, retries, and payment
  callbacks; separately test short spikes above the ten-minute average.
- Measure database transactions per second, lock wait duration, connection
  pool utilization, queue depth, Redis latency, and error rate.
- Ensure purchase retries do not amplify traffic or create duplicate payment
  authorizations.
- Reserve headroom for one application-zone failure and a queue consumer
  restart during the sale.
- Recalculate storage using real row sizes, audit retention, indexes,
  replication, logs, backups, and the number of events and seats provisioned.

## 3. REST API

All routes are HTTPS JSON endpoints under `/api/v1`. Authenticated routes
require a bearer access token. The service derives `user_id` from the token;
clients cannot purchase on behalf of an arbitrary user by supplying an ID.
Identifiers below are illustrative integers. Timestamps are UTC ISO 8601.

All write requests include an idempotency key:

```http
Authorization: Bearer <access-token>
Content-Type: application/json
Idempotency-Key: 5fc699c7-1b37-44a7-bd95-2be74d42b3bc
```

Common error statuses:

| Status | Meaning |
|---|---|
| `400 Bad Request` | Invalid JSON, field, quantity, or state transition. |
| `401 Unauthorized` | Missing, invalid, or expired authentication. |
| `403 Forbidden` | Authenticated caller lacks access to this resource or operation. |
| `404 Not Found` | Event, seat, booking, or ticket is unknown or not visible to caller. |
| `409 Conflict` | Seat is held/sold, idempotency key conflicts, or booking expired. |
| `429 Too Many Requests` | User, IP, or sale admission rate limit exceeded. |
| `503 Service Unavailable` | Sale is paused or a critical dependency is unavailable. |

### Endpoint 1: List published events

```http
GET /api/v1/events?limit=20&cursor=eyJpZCI6MTIwfQ
```

No request body is required. `limit` is capped by the service, and `cursor`
is an opaque continuation token.

Example response:

```json
{
  "data": [
    {
      "id": 501,
      "name": "Harbor Arena Live",
      "starts_at": "2027-04-12T19:30:00Z",
      "status": "published",
      "venue_name": "Harbor Arena"
    }
  ],
  "next_cursor": null
}
```

Success status: `200 OK`.
Only published events are visible through this public listing.

### Endpoint 2: List an event's seats

```http
GET /api/v1/events/501/seats?section=lower
```

No request body is required. The API returns current availability as a
short-lived view. Seat availability is advisory; a hold request is the
authoritative attempt to claim a seat.

Example response:

```json
{
  "event_id": 501,
  "generated_at": "2027-04-01T12:00:00Z",
  "seats": [
    {
      "id": 8012,
      "section": "lower",
      "row": "B",
      "number": "14",
      "price_cents": 12500,
      "currency": "USD",
      "availability": "available"
    },
    {
      "id": 8013,
      "section": "lower",
      "row": "B",
      "number": "15",
      "price_cents": 12500,
      "currency": "USD",
      "availability": "held"
    }
  ]
}
```

Success status: `200 OK`.
The response may be cached briefly and can become stale immediately after it
is generated.

### Endpoint 3: Hold one or more seats

```http
POST /api/v1/events/501/bookings
Authorization: Bearer <access-token>
Idempotency-Key: 5fc699c7-1b37-44a7-bd95-2be74d42b3bc
Content-Type: application/json
```

Request schema:

```json
{
  "seat_ids": [8012],
  "admission_token": "signed-sale-admission-token"
}
```

`seat_ids` must be non-empty and within the configured per-customer limit.
The token is issued by the Virtual Waiting Room and is scoped to this sale.

Example response:

```json
{
  "booking_id": 91004,
  "event_id": 501,
  "status": "held",
  "seat_ids": [8012],
  "hold_expires_at": "2027-04-01T12:05:00Z",
  "total_price_cents": 12500,
  "currency": "USD"
}
```

Success status: `201 Created`.
The server returns `409 Conflict` if any requested seat cannot be held.
The service either holds the complete requested set or none of it.

### Endpoint 4: Purchase a booking

```http
POST /api/v1/bookings/91004/purchase
Authorization: Bearer <access-token>
Idempotency-Key: d6335582-36ed-4f5f-b993-c97cf7bf8368
Content-Type: application/json
```

Request schema:

```json
{
  "payment_method_token": "provider-token-abc"
}
```

Raw payment card data is never accepted or stored by TicketHub. The token is
created by the payment provider's secure client-side flow.

Example response:

```json
{
  "booking_id": 91004,
  "status": "confirmed",
  "tickets": [
    {
      "ticket_id": 330081,
      "seat_id": 8012,
      "event_id": 501,
      "status": "issued"
    }
  ],
  "purchased_at": "2027-04-01T12:02:16Z"
}
```

Success status: `201 Created`.
An expired hold or sold seat returns `409 Conflict`. If payment processing
is still being reconciled, the API may return `202 Accepted` with the booking
in `payment_pending`; the client can poll the booking or tickets endpoint.
The idempotency key ensures a retry returns the same operation result.

### Endpoint 5: List the authenticated user's tickets

```http
GET /api/v1/me/tickets?limit=20&cursor=eyJpZCI6MzMwfQ
Authorization: Bearer <access-token>
```

No request body is required. The identity scope is taken from the bearer
token, never from a user ID query parameter.

Example response:

```json
{
  "data": [
    {
      "ticket_id": 330081,
      "event_id": 501,
      "event_name": "Harbor Arena Live",
      "seat": {
        "section": "lower",
        "row": "B",
        "number": "14"
      },
      "status": "issued",
      "purchased_at": "2027-04-01T12:02:16Z"
    }
  ],
  "next_cursor": null
}
```

Success status: `200 OK`.
An account with no tickets receives an empty `data` array.

## 4. Five-table PostgreSQL data model

PostgreSQL is the durable source of truth because seat allocation involves
relationships, transactions, row locks, and uniqueness rules. Redis and queue
data can be rebuilt or replayed; committed booking and ticket rows cannot be
replaced by best-effort cache state.

### 4.1 ASCII ERD

```text
+------------------+             +------------------+
| users            |             | events           |
|------------------|             |------------------|
| PK id            |             | PK id            |
| UQ email         |             | name             |
| created_at       |             | starts_at        |
+--------+---------+             | status           |
         | 1                      +--------+---------+
         |                                 | 1
         |                                  |
         | N                                | N
+--------v---------+  N       1  +----------v-------+
| bookings         +-------------+ seats            |
|------------------|             |------------------|
| PK id            |             | PK id            |
| FK user_id       |             | FK event_id      |
| FK event_id      |             | section/row/seat |
| FK seat_id       |             | price_cents      |
| status/expiry    |             | UQ event+position|
| idempotency_key  |             +----------+-------+
+--------+---------+                        | 1
         | 1                                  |
         |                                    | 1
         | 0..1                               | 0..1
+--------v---------+             +------------v-----+
| tickets          |             | uq seat ticket   |
|------------------|             | enforced by      |
| PK id            |             | UNIQUE(seat_id)  |
| FK booking_id    |             +------------------+
| FK user_id       |
| FK event_id      |
| FK seat_id       |
| purchased_at     |
+------------------+
```

Relationship summary:

- One user can create many bookings and own many tickets.
- One event has many seats; each seat belongs to exactly one event.
- A seat can have many historical booking rows, but at most one active hold
  at a time.
- A confirmed booking produces at most one ticket for each seat. This design
  models one seat per booking to keep the invariants explicit.
- Each ticket references its booking, customer, event, and seat so ownership
  and sale relationships can be audited.

### 4.2 PostgreSQL DDL

The DDL below creates exactly five application tables: `users`, `events`,
`seats`, `bookings`, and `tickets`. Named constraints make the critical
correctness invariants visible to operators and reviewers.

```sql
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    venue_name VARCHAR(200) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_events_status
        CHECK (status IN ('draft', 'published', 'cancelled'))
);

CREATE TABLE seats (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    section VARCHAR(50) NOT NULL,
    row_label VARCHAR(20) NOT NULL,
    seat_number VARCHAR(20) NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_seat_position
        UNIQUE (event_id, section, row_label, seat_number),
    CONSTRAINT uq_event_seat_id
        UNIQUE (event_id, id)
);

CREATE TABLE bookings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    event_id BIGINT NOT NULL,
    seat_id BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'held',
    hold_expires_at TIMESTAMPTZ,
    idempotency_key VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_booking_event_seat
        FOREIGN KEY (event_id, seat_id)
        REFERENCES seats(event_id, id),
    CONSTRAINT ck_booking_status
        CHECK (status IN (
            'held',
            'payment_pending',
            'confirmed',
            'expired',
            'released',
            'failed'
        )),
    CONSTRAINT uq_booking_user_idempotency
        UNIQUE (user_id, idempotency_key),
    CONSTRAINT uq_booking_identity
        UNIQUE (id, user_id, event_id, seat_id)
);

CREATE UNIQUE INDEX uq_active_seat_hold
    ON bookings (seat_id)
    WHERE status IN ('held', 'payment_pending');

CREATE INDEX ix_bookings_expiry
    ON bookings (hold_expires_at)
    WHERE status = 'held';

CREATE INDEX ix_bookings_user_created
    ON bookings (user_id, created_at DESC, id DESC);

CREATE TABLE tickets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id),
    event_id BIGINT NOT NULL,
    seat_id BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'issued',
    price_paid_cents INTEGER NOT NULL CHECK (price_paid_cents >= 0),
    purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_seat_ticket
        UNIQUE (seat_id),
    CONSTRAINT uq_ticket_booking
        UNIQUE (booking_id),
    CONSTRAINT fk_ticket_booking_owner_seat
        FOREIGN KEY (booking_id, user_id, event_id, seat_id)
        REFERENCES bookings(id, user_id, event_id, seat_id),
    CONSTRAINT fk_ticket_event_seat
        FOREIGN KEY (event_id, seat_id)
        REFERENCES seats(event_id, id),
    CONSTRAINT ck_ticket_status
        CHECK (status IN ('issued', 'cancelled', 'refunded'))
);

CREATE INDEX ix_seats_event_location
    ON seats (event_id, section, row_label, seat_number);

CREATE INDEX ix_tickets_user_purchased
    ON tickets (user_id, purchased_at DESC, id DESC);

CREATE INDEX ix_tickets_event
    ON tickets (event_id);
```

### 4.3 Constraint and index behavior

- `uq_event_seat_position` prevents duplicate physical inventory rows within
  one event.
- `uq_active_seat_hold` is a partial unique index: only rows in `held` or
  `payment_pending` participate. A released, expired, or failed historical
  row does not prevent a later booking.
- PostgreSQL partial-index predicates cannot safely use a moving expression
  such as `now()`. Therefore, expiry is a state transition: an expiry worker
  marks an overdue booking `expired` in a transaction before that seat can be
  held again.
- `uq_seat_ticket` is the final invariant that no two ticket rows can sell the
  same seat, even if application and cache layers race.
- `uq_booking_user_idempotency` makes a repeated booking request for the same
  user and key resolve to one booking.
- `uq_ticket_booking` prevents one booking from creating multiple tickets.
- `fk_ticket_booking_owner_seat` ensures ticket user, event, and seat match
  the source booking.
- `ix_bookings_expiry` supports the worker scanning expired holds.
- `ix_seats_event_location` supports rendering a venue seat map.
- `ix_tickets_user_purchased` supports efficient customer ticket history.

## 5. High-level architecture and component justifications

### 5.1 Architecture diagram

```text
                                  +----------------------+
                                  | Browser / Mobile App|
                                  +----------+-----------+
                                             |
                                             | HTTPS
                                             v
                                  +----------------------+
                                  | DNS / Anycast Edge   |
                                  +----------+-----------+
                                             |
                                             v
                    +-------------------------------------------+
                    | Cloudflare CDN / WAF / Bot Rules          |
                    | Static assets, DDoS absorption, edge cache|
                    +--------------------+----------------------+
                                         |
                   +---------------------+----------------------+
                   |                                            |
                   | static/cacheable reads                     | sale API traffic
                   v                                            v
        +------------------------+                 +--------------------------+
        | CDN cached event data  |                 | Virtual Waiting Room     |
        | versioned JS/CSS/images|                 | fair queue and admission |
        +------------------------+                 +------------+-------------+
                                                                |
                                                                | signed token,
                                                                | bounded rate
                                                                v
                                                     +------------------------+
                                                     | Regional Load Balancer |
                                                     +-----------+------------+
                                                                 |
                                              +------------------+------------------+
                                              |                                     |
                                              v                                     v
                                  +------------------------+           +------------------------+
                                  | Stateless App Server A |           | Stateless App Server B |
                                  | API / auth / validation|           | API / auth / validation|
                                  +-----+-------------+----+           +----+-------------+-----+
                                        |             |                     |             |
                     cached reads /    |             | authoritative        |             |
                     SETNX hold guard  |             | transactions         |             |
                                        v             v                     v             v
                               +----------------+  +---------------------------+
                               | Redis Cluster  |  | PostgreSQL Primary        |
                               | cache + locks  |  | bookings and tickets truth|
                               +----------------+  +-------------+-------------+
                                                                |
                                                                | streaming replication
                                                                v
                                                     +--------------------------+
                                                     | PostgreSQL Read Replicas |
                                                     | event/catalogue reads    |
                                                     +--------------------------+

              App Server A and B
                       |
                       | transactional outbox / durable publish
                       v
            +---------------------------+
            | Durable Message Queue     |
            | payment / expiry / email  |
            +-------------+-------------+
                          |
              +-----------+----------------+
              |                            |
              v                            v
    +-----------------------+    +--------------------------+
    | Expiry Worker Pool    |    | Payment / Notification   |
    | release stale holds   |    | Worker Pool              |
    +-----------------------+    +--------------------------+
```

The diagram shows separate paths for cacheable browsing and sale writes.
Requests that can change seat ownership still pass through the API and the
primary database; they are never served as authoritative cache results.

### 5.2 Component justifications

#### Cloudflare CDN / WAF

- Delivers static application assets from edge locations near customers.
- Caches public event descriptions and images with explicit cache lifetimes.
- Absorbs common denial-of-service traffic before it reaches the application.
- Applies WAF rules, bot signals, and rate limits at the network edge.
- Does not cache authenticated booking or payment responses as public content.
- Provides an edge control point for showing a sale-paused or queued response.

#### Virtual Waiting Room queue

- Holds sale traffic outside the core API until the service has capacity.
- Applies the published fairness policy and issues short-lived signed tokens.
- Controls admission rate using measured database and app-server health.
- Prevents every browser from refreshing the seat map or hitting PostgreSQL
  at the exact sale-open instant.
- Allows the service to pause admission without dropping already committed
  bookings.
- Uses replicated state and a documented degraded-mode policy; it must not
  fail open to unlimited origin traffic during a flash sale.

#### Stateless application servers

- Authenticate users, validate admission tokens, enforce authorization, and
  implement event, booking, and ticket business rules.
- Run as at least two instances across availability zones behind a load
  balancer.
- Keep session state in signed tokens or shared stores rather than process
  memory so any healthy instance can serve the next request.
- Scale horizontally for admitted traffic, while the waiting room protects
  downstream databases from scale-up lag.
- Return clear errors and idempotent results when a request is retried.

#### Redis cache and distributed lock

- Serves short-lived event and seat-map summaries to reduce repeated database
  reads.
- Attempts a fast `SET key token NX EX ttl` pre-hold for contested seats.
- Associates a random reservation token with each lock and uses atomic
  compare-and-delete to prevent an old owner releasing a newer lock.
- Uses TTLs to recover abandoned pre-holds after clients disconnect.
- Is treated as an optimization and coordination hint, not durable proof of
  availability, ownership, or sale.
- On Redis outage, the app reduces admission and relies on the PostgreSQL
  transaction and constraints for correctness.

#### PostgreSQL primary

- Stores users, events, seats, bookings, and tickets durably.
- Serializes contested booking transitions through `SELECT FOR UPDATE`.
- Enforces partial unique active-hold and unique ticket constraints.
- Commits booking and ticket state atomically and supports idempotency records.
- Is the authoritative place from which caches and worker state can be rebuilt.
- Uses backups, point-in-time recovery, health monitoring, and a tested
  failover procedure.

#### PostgreSQL read replicas

- Serve eligible read-only event and seat catalogue queries to offload the
  write primary.
- Are not used to decide whether a seat can be sold because replication lag
  could show stale availability.
- Route read-after-write queries to the primary when the customer must observe
  their latest booking.
- Monitor replay lag and remove unhealthy replicas from the read pool.
- Can support failover planning, but replicas do not replace independent
  backups or restore tests.

#### Message queue and workers

- Buffers payment reconciliation, confirmation messages, and hold-expiry work
  outside the synchronous request path.
- Applies backpressure and retries transient failures without making a web
  request wait for email or downstream settlement.
- Workers are idempotent because at-least-once delivery can repeat a message.
- A transactional outbox in PostgreSQL can ensure committed booking changes
  are eventually published even if the app process fails after commit.
- Dead-letter queues and alerts make persistently failing jobs visible for
  controlled replay rather than silently dropping them.

## 6. Three-layer double-booking safeguard

No single cache or application check is sufficient for a high-demand seat
sale. TicketHub uses three layers. The layers are intentionally redundant:
Redis reduces contention, row locks serialize authoritative state changes,
and relational constraints reject impossible duplicate states.

### Layer 1: In-memory pre-hold fast path with Redis SETNX and TTL

For a candidate seat, the app attempts:

```text
SET seat-hold:{event_id}:{seat_id} {random_booking_token} NX EX 300
```

- `NX` creates the key only if no key currently exists.
- `EX 300` automatically removes a stale pre-hold after five minutes.
- Exactly one contender receives success from this fast-path on a healthy
  Redis primary; the others are asked to choose another seat or retry through
  the waiting-room flow.
- The value is a random token linked to the booking attempt, not a user
  supplied value.
- Release uses a compare-and-delete Lua script: delete only if the stored
  token equals the caller's token.
- A plain `DEL` is unsafe: a delayed request from an old holder might delete
  a lock acquired by a newer customer after expiry.
- The app must still validate against PostgreSQL after acquiring Redis.
- If Redis loses data, evicts a key, fails over, or is unavailable, the
  database row lock and unique indexes still protect the sale.
- The Redis key is released after a failed database transaction and is
  refreshed only according to the configured hold policy.

The Redis lock is a low-latency gate, not a distributed transaction with
PostgreSQL. There can be a gap between setting a Redis key and committing a
booking. That gap is safe because only a committed database booking counts;
the client receives success only after the database transaction has committed.

### Layer 2: Authoritative database transaction with pessimistic row locking

After the fast-path succeeds, the app performs a short transaction on the
PostgreSQL primary:

```sql
BEGIN;

SELECT id, event_id, status, hold_expires_at
FROM seats
WHERE event_id = :event_id
  AND id = :seat_id
FOR UPDATE;

-- Check whether a ticket already exists for the seat.
-- Find active booking rows for the seat.
-- Mark any expired held booking as expired.
-- Insert the new booking with a database-calculated expiry.

COMMIT;
```

The actual implementation uses parameterized SQL and validates the event and
customer before commit.

Transaction sequence:

1. Verify the admission token, user, event sale window, and idempotency key.
2. Begin a transaction on the primary database.
3. Lock the canonical seat row with `SELECT ... FOR UPDATE`.
4. Check for an existing ticket for that seat.
5. Check active booking state under the lock.
6. If an old hold's database expiry has passed, transition it to `expired`
   within the transaction; do not rely on Redis TTL alone.
7. Insert a new `held` booking with `hold_expires_at` set from database time.
8. Commit, then return the booking ID and expiry to the customer.
9. If any check or insert fails, roll back and release only the matching
   Redis pre-hold token.

Concurrent requests for the same seat serialize on the seat row. The
transaction does not hold locks while waiting on external payment calls.
For multi-seat bookings, seat rows must be locked in deterministic sorted ID
order to reduce deadlock risk; if any seat cannot be acquired, the complete
booking transaction rolls back.

### Layer 3: Relational engine constraints

The constraints are the final invariant even if a caller bypasses the Redis
fast path or application code contains a race:

- `uq_active_seat_hold` allows no more than one booking with an active status
  (`held` or `payment_pending`) for a seat.
- `uq_seat_ticket` allows no more than one ticket row for a seat.
- Foreign keys ensure the seat belongs to the referenced event and a ticket
  matches its booking, user, event, and seat.
- `uq_booking_user_idempotency` ensures repeated booking attempts using the
  same user's idempotency key do not create separate bookings.

If two requests still race into an insert, PostgreSQL rejects the loser with
a unique-constraint violation. The application maps that violation to
`409 Conflict`, rolls back the transaction, and returns a safe response.
Constraint violations are expected concurrency outcomes and are measured,
not treated as successful purchases.

### Purchase transition and payment boundary

1. The customer requests purchase for their own active booking with an
   idempotency key.
2. The payment provider authorizes using its idempotency mechanism; raw card
   data never passes through TicketHub.
3. A short database transaction locks the booking and seat rows, checks that
   the booking is still active and unexpired, and changes the booking state.
4. The transaction inserts the ticket and sets the booking to `confirmed`.
   `uq_seat_ticket` is enforced before commit.
5. The service writes an outbox event in the same transaction so a worker can
   capture/reconcile payment and send confirmation.
6. On transaction failure, payment authorization is voided or reconciled.
   External payment calls are never made while row locks are held.
7. On a duplicate retry, the same idempotency key returns the existing
   booking/ticket outcome rather than inserting or charging again.

The detailed provider protocol should distinguish authorization, capture,
void, and refunds. An uncertain provider response is reconciled idempotently
before releasing inventory; a timeout is not treated as proof that payment
failed.

### Expiry and cache invalidation

- Redis TTL only clears the pre-hold key; it does not change PostgreSQL state.
- The expiry worker selects overdue held bookings and updates their status
  under a row lock.
- A new hold can reclaim a seat only after the old active booking has been
  transitioned to `expired` in the database.
- Booking commit, release, expiry, and ticket issue invalidate or update
  affected seat-map cache entries.
- Cache keys include the event and seat-map version; cache miss always falls
  back to an authoritative read.
- A delayed invalidation can show stale availability temporarily, but the
  hold transaction prevents the stale display from becoming a duplicate sale.

## 7. Architectural trade-offs

### 7.1 Pessimistic row locking vs. optimistic concurrency control (OCC)

#### Pessimistic row locking

With pessimistic locking, `SELECT FOR UPDATE` obtains a row lock before
changing a seat's booking state.

Advantages:

- Makes the winner of a contested seat explicit and easy to reason about.
- Serializes state transitions before application logic commits a hold.
- Works naturally with the partial unique index and ticket unique constraint.
- Reduces repeated failed writes and client retries on extremely hot seats.

Costs:

- Contenders wait on the same row, increasing latency during peak contention.
- Long transactions can reduce throughput and create lock queues.
- Incorrect lock ordering across several seats can cause deadlocks.
- Database connection and lock capacity become critical operational limits.

Mitigations:

- Keep transactions short and perform no network or payment calls while
  holding locks.
- Lock multiple seat rows in stable ascending seat-ID order.
- Bound lock waits and return a retryable conflict/timeout response.
- Monitor lock wait time, deadlocks, active connections, and transaction age.

#### Optimistic concurrency control

With OCC, each seat or booking has a version number. The application reads
the version, then updates only if the version has not changed:

```sql
UPDATE seats
SET version = version + 1
WHERE id = :seat_id
  AND version = :expected_version;
```

Advantages:

- Reads do not acquire long-lived row locks.
- Performs well when conflicts are rare and the same records are not hot.
- Can increase parallelism for low-contention event administration and
  catalogue updates.

Costs:

- The losing caller must retry after a version conflict.
- Many simultaneous retries on one scarce seat can amplify database load.
- OCC alone does not prevent a second ticket row unless the database still
  enforces `uq_seat_ticket`.

Decision:

TicketHub uses pessimistic row locking for seat hold and purchase transitions
because flash-sale contention is known and correctness is more important than
letting every caller proceed optimistically. OCC remains appropriate for
low-contention event metadata and other updates. The unique constraints stay
in place under either strategy.

### 7.2 Virtual Waiting Room vs. instant elastic auto-scaling

#### Virtual Waiting Room

Advantages:

- Shapes a sudden arrival wave before it reaches the application and primary
  database.
- Applies sale fairness and provides customer-facing wait status.
- Lets operators pause or reduce admission if payment or database health
  degrades.
- Prevents a thundering herd that autoscaling cannot absorb quickly enough.

Costs:

- Adds queueing delay and another distributed system to operate.
- Requires token security, queue fairness, monitoring, and a clear failure
  policy.
- Customers may abandon while waiting; the wait experience must be honest.

#### Instant elastic auto-scaling

Advantages:

- Scales application capacity with normal load without placing every user in
  a queue.
- Keeps the ordinary customer experience direct when the service has spare
  capacity.

Costs:

- New instances have startup and warm-up delays.
- Autoscaling application servers does not instantly scale the database,
  Redis, payment provider, or network connection pools.
- A large synchronized burst can overwhelm a downstream dependency before
  scaling reacts.
- More application instances can increase database connections and worsen
  contention rather than solve it.

Decision:

TicketHub combines a Virtual Waiting Room with autoscaling behind it. The
waiting room limits admitted request rate to measured safe capacity; autoscale
adds app and worker capacity as sustained demand grows. The waiting room runs
redundantly across zones, admission tokens are signed and short-lived, and
failure behavior is explicit. During an uncertain control-plane failure, the
service fails closed for new purchase admission while keeping public event
information available, rather than sending an unlimited flash-sale burst to
the database.

### 7.3 Additional trade-off: cache freshness vs. read capacity

Short-lived Redis caching lowers read latency and reduces catalogue load.
However, seat availability can be stale. TicketHub caches display summaries,
not the result of a seat ownership decision. A stale seat can be displayed as
available, but the transactional hold endpoint may still return `409
Conflict`; the client refreshes the view. Cache invalidation on every booking
transition improves the experience but cannot be the correctness mechanism.

### 7.4 Additional trade-off: replica reads vs. read-after-write consistency

Read replicas distribute catalogue queries, but their replication can lag.
TicketHub uses replicas for public event metadata and suitable seat-map reads,
but routes a customer's immediate booking and ticket confirmation reads to
the primary or uses a consistency token. This costs some primary capacity in
exchange for predictable read-after-write behavior.

## Operational checklist

- Run a sale rehearsal with 200,000 simulated participants, 20,000 seats,
  realistic retries, and payment-provider sandbox latency.
- Prove that exactly one ticket is committed for every seat under concurrent
  purchase attempts.
- Verify a Redis restart, database failover, worker restart, and queue
  redelivery do not create duplicate bookings, charges, or tickets.
- Confirm the waiting room's fairness rules and fail-closed mode with product
  and operations teams before sale day.
- Track p50/p95/p99 API latency, DB lock waits, connection saturation, Redis
  errors, queue depth, and payment authorization/capture mismatches.
- Test backup restoration and document the person responsible for a controlled
  sale pause and resume.
- Review retention and privacy rules for account, payment-reference, audit,
  and ticket data.

## Summary

TicketHub separates high-volume arrival management from transactional
inventory correctness. The CDN and waiting room reduce and shape load.
Redis offers a fast pre-hold but is disposable. PostgreSQL serializes
authoritative changes and enforces `uq_active_seat_hold` and `uq_seat_ticket`.
Idempotency, durable queue processing, observability, and recovery procedures
complete the design for both normal traffic and a contested flash sale.
