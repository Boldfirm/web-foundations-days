# SnapShare System Design & Scaling Plan

## 1. Assumptions & User Base
* **Total Registered Users:** 10,000,000 (10 million).
* **Daily Active Ratio:** 10% of registered users are active daily.
* **Daily Active Users (DAU):** 
  $$\text{DAU} = 10{,}000{,}000 \times 0.10 = 1{,}000{,}000\text{ users/day}$$
* **User Activity per Day:**
  * Each active user uploads **1 photo/day**.
  * Each active user views **50 feed pages/day**.
* **File Sizes:**
  * Average original photo size: **2 MB**.
  * Generated thumbnail size: **50 KB** (0.05 MB).
  * Total binary storage per upload: 2 MB + 0.05 MB = 2.05 MB.
* **Time Conversion Approximation:** 1 day $\approx 100{,}000$ seconds.
* **Traffic Multiplier:** Peak traffic is estimated at **5x** average traffic.

---

## 2. Traffic & Storage Calculations

### Uploads per Second (Writes)
* **Daily Volume:** 
  $$1{,}000{,}000\text{ active users} \times 1\text{ photo/day} = 1{,}000{,}000\text{ uploads/day}$$
* **Average Uploads/sec:** 
  $$\frac{1{,}000{,}000\text{ uploads}}{100{,}000\text{ seconds}} = 10\text{ uploads/sec}$$
* **Peak Uploads/sec (5x):** 
  $$10\text{ uploads/sec} \times 5 = 50\text{ uploads/sec}$$

### Feed Views per Second (Reads)
* **Daily Volume:** 
  $$1{,}000{,}000\text{ active users} \times 50\text{ views/day} = 50{,}000{,}000\text{ views/day}$$
* **Average Feed Views/sec:** 
  $$\frac{50{,}000{,}000\text{ views}}{100{,}000\text{ seconds}} = 500\text{ views/sec}$$
* **Peak Feed Views/sec (5x):** 
  $$500\text{ views/sec} \times 5 = 2{,}500\text{ views/sec}$$

### Photo Storage per Year
* **Daily Storage Ingestion:** 
  $$1{,}000{,}000\text{ photos} \times 2.05\text{ MB} = 2{,}050{,}000\text{ MB/day} = 2.05\text{ TB/day}$$
* **Annual Storage (365 days):** 
  $$2.05\text{ TB/day} \times 365\text{ days} \approx 748.25\text{ TB/year}$$

---

## 3. Workload Characterization: Read-Heavy vs. Write-Heavy
* **Read-to-Write Ratio:** 
  $$\frac{50{,}000{,}000\text{ feed reads}}{1{,}000{,}000\text{ photo uploads}} = 50:1$$
* **Verdict:** SnapShare is an overwhelmingly **read-heavy** system.
* **Architectural Implications:** 
  * The system must prioritize read optimization through aggressive in-memory caching (Redis) for timelines, follower graphs, and active user metadata.
  * A Content Delivery Network (CDN) edge tier is required to offload media traffic from origin servers.
  * Relational database writes are isolated to a single primary database, while read traffic is offloaded to horizontal read replicas.

---

## 4. Storage Strategy: Database vs. Object Storage
Storing raw binary photos as BLOBs directly inside a relational database causes severe disk bloat, exhausts RAM buffer pools, slows down indexing, and makes database backups and replication impractical.

Instead, binary media (original images and generated thumbnails) is stored in **cloud object storage** (such as Amazon S3 or Google Cloud Storage). The relational database stores only structured metadata, such as `photo_id`, `user_id`, `caption`, `created_at`, and the public object storage `image_url` string.

---

## 5. System Architecture Diagram

```text
                     [ Users / Mobile & Web Clients ]
                                    │
           ┌────────────────────────┴────────────────────────┐
           │ Static assets & photos                          │ Dynamic API requests
           ▼                                                 ▼
    ┌──────────────┐                                ┌─────────────────┐
    │  CDN (Edge)  │                                │  Load Balancer  │
    └──────┬───────┘                                └────────┬────────┘
           │                                                 │
           │ (origin fetch on cache miss)                    │
           ▼                                ┌────────────────┼────────────────┐
    ┌──────────────┐                        ▼                ▼                ▼
    │Object Storage│                 ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ (Amazon S3)  │                 │App Server 1 │  │App Server 2 │  │App Server 3 │
    └──────▲───────┘                 └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
           │                                │                │                │
           │                                └────────┬───────┴────────────────┘
           │                                         │
           │                       ┌─────────────────┼─────────────────┐
           │                       │ Reads / Inval.  │ Writes          │ Enqueue Jobs
           │                       ▼                 ▼                 ▼
           │              ┌─────────────────┐ ┌───────────────┐ ┌───────────────┐
           │              │ In-Memory Cache │ │Primary Database│ │ Message Queue │
           │              │     (Redis)     │ │ (PostgreSQL)  │ │(RabbitMQ/SQS) │
           │              └─────────────────┘ └───────┬───────┘ └───────┬───────┘
           │                                          │                 │
           │ write thumbnails              Replication│ (WAL)   Consume │ Jobs
           │                                          ▼                 ▼
    ┌──────┴───────┐                         ┌─────────────────┐ ┌───────────────┐
    │ Worker Fleet │                         │  Read Replica   │ │ Worker Fleet  │
    │(Image Resizer)                         │  (Feed Queries) │ │ (Thumbnailer) │
    └──────────────┘                         └─────────────────┘ └───────────────┘
```

---

## 6. One-Sentence Component Explanations
* **CDN (Content Delivery Network):** Caches and serves static assets, photos, and thumbnails from geographically distributed edge servers near users to minimize latency.
* **Load Balancer:** Distributes incoming HTTP/HTTPS traffic across healthy application servers to eliminate single points of failure and balance resource usage.
* **App Servers (Stateless):** Execute core application logic, authenticate user sessions, handle metadata validation, and remain stateless so requests can be routed to any instance.
* **In-Memory Cache (Redis):** Caches user feeds, follower graphs, and session tokens in RAM to satisfy high-frequency read queries in sub-millisecond time.
* **Primary Database (PostgreSQL):** Handles all relational database writes and transactional updates, serving as the single source of truth for structured metadata.
* **Read Replica:** Replicates data asynchronously from the primary database to handle feed reads and offload query strain from the write-master.
* **Object Storage (Amazon S3):** Stores raw binary image payloads and thumbnails cost-effectively with high durability and virtually unlimited horizontal capacity.
* **Message Queue (RabbitMQ / SQS):** Buffers background tasks asynchronously so application servers can return fast responses without blocking on image processing.
* **Worker Fleet:** Consumes thumbnail-generation tasks from the message queue, resizes the original images, and writes the resulting thumbnails back to object storage.

---

## 7. Step-by-Step Upload Flow

### Direct-to-Storage Architecture (Presigned URLs)
To handle 50 peak uploads per second (100 MB/s sustained bandwidth) without saturating application server network interfaces, SnapShare uses **presigned URLs** to decouple binary streaming from API operations:

```text
[Client] ──1. Request Upload URL──> [App Server]
[Client] <──2. Return Presigned S3 URL & Photo ID── [App Server]
[Client] ──3. Stream 2 MB Binary File Directly──> [Object Storage (S3)]
[Client] ──4. Confirm Upload (POST /photos/complete)──> [App Server]
                                                            │
                                  ┌─────────────────────────┴─────────────────────────┐
                                  ▼                                                   ▼
                         5. Commit Metadata                                  6. Enqueue Thumbnail Job
                            [Primary DB]                                         [Message Queue]
                                                                                        │
                                                                                        │ 7. Worker consumes
                                                                                        ▼
                                                                                 [Worker Fleet]
                                                                                        │
                                                                                8. Resize & save 50 KB
                                                                                        ▼
                                                                                [Object Storage (S3)]
```

### Detailed Lifecycle:
1. **Upload Request:** The client sends a lightweight `POST /api/v1/photos/upload-request` to the application server with metadata (file name, content-type, byte size).
2. **Presigned URL Generation:** The application server validates authentication and generates a cryptographically signed, short-lived (5-minute) S3 presigned URL along with a reserved `photo_id`.
3. **Direct Binary Upload:** The client uploads the 2 MB raw photo directly to Amazon S3 via `PUT <presigned-url>`. This offloads heavy binary traffic entirely from the application tier.
4. **Upload Confirmation:** Once S3 confirms the upload, the client sends a completion request (`POST /api/v1/photos/:id/complete`) to the application server.
5. **Metadata Persistence:** The application server marks the photo status as active in the **Primary Database** (`photo_id`, `user_id`, `s3_url`, `created_at`).
6. **Task Enqueuing:** The application server pushes a task payload directly to the **Message Queue** (`{"event": "create_thumbnail", "photo_id": 101, "source_key": "photos/raw/101.jpg"}`).
7. **Immediate Client Acknowledgment:** The application server invalidates the user's cached timeline in Redis and returns `HTTP 201 Created` with the photo metadata. Total round-trip time for the client is under 50 ms.
8. **Asynchronous Background Processing:** An idle worker from the worker fleet pulls the job off the queue, fetches the 2 MB image from Object Storage, renders the 50 KB thumbnail, uploads it to `photos/thumbs/101.jpg`, and writes the thumbnail URL back to the database.

---

## 8. Architectural Trade-offs & Fault Tolerance

### Trade-off 1: Direct-to-S3 Presigned URLs vs. App Server Proxying
* **Decision:** We use presigned URLs for client uploads directly to S3 rather than proxying the 2 MB files through application servers.
* **Trade-off:** Direct uploads require client-side logic to handle a two-step handshake (get URL -> upload to S3 -> confirm). In return, application servers are completely freed from memory and network saturation, allowing a small cluster of web servers to support 50+ concurrent uploads per second without degradation.

### Trade-off 2: Eventual Consistency vs. Strict Read Consistency
* **Decision:** Read replicas and Redis caches serve feed traffic to handle 2,500 peak reads/second.
* **Trade-off:** Replication lag (typically 10–50 ms) means a follower may not see a newly published photo for a few moments. For a social photo-sharing app, high availability and low latency outweigh the need for immediate cross-region consistency.

### Avoiding Single Points of Failure (SPOF)
* **Application Tier:** Stateless application servers sit behind redundant load balancers across multiple Availability Zones. If an application node crashes, health checks drop it from the pool within seconds, and clients retry against surviving nodes.
* **Database Tier:** A Primary PostgreSQL node replicates to read replicas with automated standby failover (e.g., AWS RDS Multi-AZ). If the primary fails, the standby is promoted automatically with minimal downtime.
* **Storage & Queue:** Object storage and managed message queues provide built-in multi-datacenter data replication and automatic scaling.
