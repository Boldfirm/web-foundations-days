# SnapShare System Design & Scaling Plan

## 1. Assumptions & User Base
* **Total Registered Users:** 10,000,000 (10 million).
* **Daily Active Ratio:** 10% of registered users are active daily.
* **Daily Active Users (DAU):** 
  $$\text{DAU} = 10{,}000{,}000 \times 0.10 = 1{,}000{,}000\text{ active users/day}$$
* **User Activity per Day:**
  * Each active user uploads **1 photo/day**.
  * Each active user views **50 feed pages/day**.
* **File Sizes:**
  * Average original photo size: **2 MB**.
  * Generated thumbnail size: **50 KB** (0.05 MB).
  * Total binary storage per upload: $2\text{ MB} + 0.05\text{ MB} = 2.05\text{ MB}$.
* **Time Conversion Approximation:** 1 day $\approx 100{,}000$ seconds.
* **Traffic Multiplier:** Peak traffic is estimated at **$5\times$** average traffic.

---

## 2. Traffic & Storage Calculations

### Uploads per Second (Writes)
* **Daily Volume:** 
  $$1{,}000{,}000\text{ active users} \times 1\text{ photo/day} = 1{,}000{,}000\text{ uploads/day}$$
* **Average Uploads/sec:** 
  $$\frac{1{,}000{,}000\text{ uploads}}{100{,}000\text{ seconds}} = 10\text{ uploads/sec}$$
* **Peak Uploads/sec ($5\times$):** 
  $$10\text{ uploads/sec} \times 5 = 50\text{ uploads/sec}$$

### Feed Views per Second (Reads)
* **Daily Volume:** 
  $$1{,}000{,}000\text{ active users} \times 50\text{ views/day} = 50{,}000{,}000\text{ views/day}$$
* **Average Feed Views/sec:** 
  $$\frac{50{,}000{,}000\text{ views}}{100{,}000\text{ seconds}} = 500\text{ views/sec}$$
* **Peak Feed Views/sec ($5\times$):** 
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