# Day 6: Data & Storage — QuickNotes

## 1. Where Application Data Lives

| Storage Layer | Lifetime | Visibility / Scope | QuickNotes Use Case |
| :--- | :--- | :--- | :--- |
| **Memory (Variables)** | Tab session (lost on reload) | Current page only | Temporary input state, modal visibility |
| **`localStorage`** | Persistent until cleared | Single browser / device | User UI preferences (Dark mode), offline drafts |
| **Cookies** | Set expiry / session | Sent automatically with HTTP requests | Authentication tokens / Session IDs |
| **Server Database (RDBMS)** | Permanent (backed up) | Global (all authenticated clients) | Users, notes, tag relationships |
| **File / Object Storage (S3 / Blob)** | Permanent | Public / signed URLs | Note image attachments, PDF exports |

## 2. QuickNotes Data Model

- **Users (`users`)**: Primary entity storing account details (`id`, `name`, `email`).
- **Notes (`notes`)**: Child entity linked to `users` via `user_id` Foreign Key (**One-to-Many**).
- **Tags (`tags`)**: Categorization labels (`id`, `name`).
- **Note Tags (`note_tags`)**: Associative / bridge table linking `notes` and `tags` (**Many-to-Many**).

## 3. SQL vs NoSQL Trade-offs

- **Relational (SQL):** Best when data has structured relationships, enforces strict schemas and referential integrity (`FOREIGN KEY`), and requires ACID compliance.
- **Document (NoSQL):** Best for unstructured or rapidly changing schemas, hierarchical nested documents, or high-throughput write scaling without complex joins.

## 4. Purpose of Indexes

Indexes (such as B-Trees on `notes.user_id`) allow the database engine to find specific rows in $O(\log n)$ time rather than performing a full table scan ($O(n)$). This maintains fast lookup speeds even as data grows to millions of rows.