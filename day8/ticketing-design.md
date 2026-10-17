# TicketHub System Design

## 1. Requirements

### Functional requirements
- Users can browse published events and view their venue sections, prices, and seat availability.
- Users can sign in, temporarily hold an available seat, complete a purchase, and retrieve their tickets.
- A hold expires automatically after a short checkout window (for example, five minutes) unless purchase completes.
- The system prevents one seat from being sold or actively held by multiple users.
- Users can release a hold; operators can publish events and seat inventory.

### Non-functional requirements
- **Correctness:** ticket ownership and seat uniqueness are enforced transactionally in PostgreSQL, not trusted to cache state.
- **Availability:** target 99.9% monthly availability, with graceful degradation for non-critical browsing features.
- **Performance:** event/seat browsing should normally return within 300 ms p95; flash-sale admission and purchase requests must be bounded and observable.
- **Scalability:** scale stateless API servers and workers horizontally; protect downstream services from sudden load.
- **Security:** HTTPS, authenticated and authorized purchase actions, rate limits, input validation, secure payment-provider integration, and no storage of raw card data.
- **Durability and observability:** durable database backups, queue retries, metrics, logs, tracing, and tested recovery procedures.

## 2. Traffic and storage estimates

These are planning estimates; actual event popularity, retries, and request mix must be measured. Assume normal traffic has 50,000 daily active users (DAU), each making 20 read requests and 1 write (hold/purchase) per day. A flash sale admits 200,000 users over 10 minutes. For the flash estimate, assume each user generates 3 reads and 1 purchase/hold write during the window.

| Scenario / measure | Calculation | Average rate |
|---|---|---:|
| Normal reads | `50,000 × 20 ÷ 86,400 seconds` | about 12 reads/s |
| Normal writes | `50,000 × 1 ÷ 86,400 seconds` | about 0.6 writes/s |
| Flash-sale reads | `200,000 × 3 ÷ 600 seconds` | 1,000 reads/s |
| Flash-sale writes | `200,000 × 1 ÷ 600 seconds` | about 333 writes/s |

The flash-sale figures are window averages, not peak capacity. Traffic will arrive unevenly, so the waiting room smooths admission and the service should be load-tested above the estimate (for example, at twice these rates), including retries and payment callbacks.

For durable growth, assume the 50,000 DAU complete one ticket purchase per user per week on average: `50,000 × 52 = 2.6 million purchases/year`. Budget approximately 2 KB per purchase for the ticket, retained reservation, and associated row/index overhead: about **5.2 GB/year** of logical transactional data. This excludes event/seat catalogue, user accounts, logs, backups, replicas, and temporary holds; capacity planning should include those and operational headroom. A flash sale of 200,000 completed purchases would add roughly 400 MB at this estimate.

## 3. REST API (five endpoints)

All endpoints use HTTPS and JSON. Purchase/hold endpoints require authentication; the API derives the user identity from the access token rather than trusting a client-supplied user ID. Event and seat IDs are illustrative.

| Method and path | Purpose | Success status |
|---|---|---|
| `GET /api/v1/events` | List published events with cursor pagination. | `200 OK` |
| `GET /api/v1/events/{eventId}/seats` | List seats and their availability/prices for an event. | `200 OK` |
| `POST /api/v1/events/{eventId}/holds` | Request a temporary hold for one seat; returns a hold token and expiry. | `201 Created` |
| `POST /api/v1/holds/{holdId}/purchase` | Complete checkout for the authenticated user's active hold; accept an idempotency key. | `201 Created` |
| `GET /api/v1/me/tickets` | List tickets belonging to the authenticated user. | `200 OK` |

A rejected or expired hold returns `409 Conflict`; unauthenticated requests return `401 Unauthorized`; invalid input returns `400 Bad Request`. Purchase retries with the same idempotency key return the original outcome rather than issuing a second ticket.

## 4. PostgreSQL data model

The five tables are `users`, `events`, `seats`, `reservations`, and `tickets`. A user can make many reservations and own many tickets. An event has many seats; each seat belongs to one event. A reservation records a temporary claim and its status. A ticket is the durable sale record. Unique constraints and foreign keys provide final integrity protection even if application or cache logic fails.

```sql
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('draft', 'published', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seats (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    section VARCHAR(50) NOT NULL,
    row_label VARCHAR(20) NOT NULL,
    seat_number VARCHAR(20) NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    UNIQUE (event_id, section, row_label, seat_number),
    UNIQUE (event_id, id)
);

CREATE TABLE reservations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    event_id BIGINT NOT NULL,
    seat_id BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('held', 'sold', 'expired', 'released')),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, seat_id) REFERENCES seats(event_id, id),
    UNIQUE (id, seat_id)
);

CREATE UNIQUE INDEX one_active_hold_per_seat
    ON reservations (seat_id) WHERE status = 'held';

CREATE TABLE tickets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    event_id BIGINT NOT NULL,
    seat_id BIGINT NOT NULL UNIQUE,
    reservation_id BIGINT NOT NULL UNIQUE,
    purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    price_paid_cents INTEGER NOT NULL CHECK (price_paid_cents >= 0),
    FOREIGN KEY (event_id, seat_id) REFERENCES seats(event_id, id),
    FOREIGN KEY (reservation_id, seat_id) REFERENCES reservations(id, seat_id)
);

CREATE INDEX seats_by_event_idx ON seats (event_id, section, row_label, seat_number);
CREATE INDEX reservations_expiry_idx ON reservations (expires_at) WHERE status = 'held';
CREATE INDEX tickets_by_user_event_idx ON tickets (user_id, event_id);
```

The seat-position unique constraint prevents duplicate inventory rows. The partial unique index permits only one active hold per seat (expired/released holds remain as history). `tickets.seat_id UNIQUE` is the final guarantee that a seat cannot have two sales. Database transactions transition a hold to `sold` and create its ticket atomically. A scheduled expiry worker marks overdue holds `expired`; a hold is not considered reusable until the expiry transition is committed. Production payment integration should use an idempotent payment-provider request and reconcile uncertain payment outcomes before releasing inventory.

## 5. High-level architecture and component justifications

```text
                         ┌────────────────┐
                         │ Web / Mobile   │
                         │ Client         │
                         └───────┬────────┘
                                 │
                         ┌───────▼────────┐
                         │ DNS            │
                         └───────┬────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ CDN / WAF               │
                    │ static assets, edge rules│
                    └────────────┬─────────────┘
                                 │ dynamic requests
                    ┌────────────▼─────────────┐
                    │ Virtual Waiting Room    │
                    │ admission tokens / queue│
                    └────────────┬─────────────┘
                                 │ rate-limited admission
                    ┌────────────▼─────────────┐
                    │ Load Balancer            │
                    └──────┬────────────┬─────┘
                           │            │
                 ┌─────────▼───┐  ┌─────▼────────┐
                 │ App Server 1│  │ App Server 2 │  ...
                 └─────┬───┬───┘  └──┬───────┬───┘
                       │   │         │       │
                  ┌────▼┐ ┌▼─────────▼┐   ┌─▼──────────┐
                  │Redis│ │PostgreSQL │   │Message     │
                  │holds│ │primary +  │   │Queue       │
                  │cache│ │replica    │   └─────┬─────┘
                  └─────┘ └───────────┘         │
                                           ┌─────▼─────┐
                                           │Workers    │
                                           │expiry etc.│
                                           └───────────┘
```

- **CDN/WAF:** serves static files near users, absorbs cacheable traffic, and filters common edge threats before they reach the origin.
- **Virtual Waiting Room:** meters entry during a flash sale, gives users an orderly admission token, and protects the API/database from a synchronized thundering herd.
- **Redis:** provides fast, short-lived seat-hold coordination and cached event/seat reads; it is an optimization, never the authoritative sold-seat record.
- **App servers:** validate and authorize requests, run purchase rules, and scale horizontally as stateless instances behind a load balancer.
- **PostgreSQL primary and read replica:** the primary commits seat holds and ticket sales with row locks and constraints; a replica can serve suitable catalogue reads while its replication lag is monitored.
- **Message queue:** durably buffers payment reconciliation, notifications, and reservation-expiry jobs so request handling does not wait for slow work.
- **Workers:** process queued jobs with retries and idempotency, keeping background work independent of interactive API capacity.
- **Load balancer and DNS:** route traffic to healthy instances and stable endpoints; deploy across availability zones to avoid a single instance or zone being a single point of failure.

## 6. Preventing two people from buying the same seat

Redis is the fast-path admission guard; PostgreSQL is the source of truth. For a hold request, the application first attempts `SET seat:{seatId} {reservationToken} NX EX 300`. `NX` means the key is created only if absent, so one concurrent caller wins the five-minute hold and other callers receive an unavailable response. The token identifies the owner; release/expiry must compare the stored token before deleting it (a compare-and-delete Lua script), so an old request cannot clear a newer hold. Redis keys use a TTL to recover from abandoned clients. Redis failover or eviction can weaken this fast-path, so the database checks remain mandatory.

After acquiring the Redis key, the application opens a PostgreSQL transaction and selects the seat row with `SELECT ... FROM seats WHERE id = $1 FOR UPDATE`. The row lock serializes competing transactions for that seat. While holding the lock, it verifies the event is purchasable, confirms there is no ticket and no unexpired active reservation, then inserts the reservation and commits. If validation or insertion fails, it rolls back and releases only its own Redis token. Hold expiry/release also updates the database status transactionally before allowing another hold.

During purchase, the payment provider authorizes payment with an idempotency key without holding a database lock. The service then opens a short transaction, locks the reservation/seat rows, and verifies the reservation belongs to the caller and is still active. It changes the reservation to `sold` and inserts the ticket atomically. If the hold expired or the transaction fails, the authorization is voided; after commit, capture/reconciliation is handled idempotently through the queue. The unique constraint `tickets(seat_id)` prevents a duplicate sale even if two requests race, a Redis key is lost, or application code has a defect; the losing transaction rolls back and returns `409 Conflict`. Row locks provide orderly conflict handling, while unique constraints are the final invariant. Redis state can be reconstructed from active reservations; it is never used as proof that a ticket was sold.

### Two architectural trade-offs

1. **Pessimistic versus optimistic locking:** `SELECT FOR UPDATE` pessimistically holds a database lock while a purchase is validated, which is simple and safe for highly contested seats but can increase waits and reduce throughput on hot rows. Optimistic version checks allow more parallel work but make clients retry after conflicts and do not eliminate the need for a unique ticket constraint. TicketHub uses pessimistic locking for scarce-seat hold/purchase transitions and optimistic or unlocked reads for catalogue data; transactions stay short and never wait on external payment calls while holding a row lock.
2. **Virtual waiting room versus instant auto-scaling:** a waiting room adds queue time and operational complexity, but smooths a sudden flash-sale burst before it overwhelms databases and payment providers. Instant auto-scaling improves normal elasticity but has startup delay and cannot create database capacity quickly enough for a synchronized spike. TicketHub uses a waiting room with controlled admission plus autoscaling behind it; waiting-room failure has a bounded fail-closed/fail-open policy, visible status, and multi-zone redundancy rather than sending unlimited traffic to the origin.
