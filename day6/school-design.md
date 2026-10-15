# School Database System Design

## 1. Table Explanations

- **`students`**: Stores basic biographical and authentication data for individual learners (`id`, `name`, `email`, `created_at`). `email` is strictly unique.
- **`courses`**: Stores the curriculum catalog (`id`, `title`, `code`). The `code` column (e.g., `CS101`) is unique to prevent duplicate course offerings.
- **`enrolments`**: The junction/bridge entity capturing student enrollment in a course. It maintains relationship attributes, specifically the student's current `grade` and enrollment timestamp (`enrolled_at`).

## 2. Entity Relationships & Join Table Justification

- **Relationship Type**: The relationship between students and courses is **Many-to-Many ($N:M$)**. One student can register for multiple courses, and one course can hold multiple students.
- **Why a Join Table is Required**: Relational databases cannot directly link two tables in an $N:M$ relationship without either storing un-indexable comma-separated lists (violating First Normal Form) or causing massive data duplication. The `enrolments` join table decomposes the $N:M$ relationship into two clean **One-to-Many ($1:N$)** relationships:
  - `students` (1) to `enrolments` (Many)
  - `courses` (1) to `enrolments` (Many)
- **Duplicate Prevention**: Defining a composite primary key `PRIMARY KEY (student_id, course_id)` ensures that a student cannot accidentally be registered for the exact same course more than once.

## 3. Recommended Index & Rationale

- **Index**: `CREATE INDEX idx_enrolments_course_id ON enrolments(course_id);`
- **Reason**: The composite primary key `(student_id, course_id)` already indexes queries filtering by `student_id`. However, queries filtering or aggregating by course (such as *Query 2: All students on one course* and *Query 3: Count of students per course*) join directly on `course_id`. Without an index on `course_id`, the database engine must execute an $O(n)$ full table scan of `enrolments`. This index enables logarithmic $O(\log n)$ B-tree lookups when generating course rosters and class sizes.

## 4. Architecture Selection: SQL vs. NoSQL

For this school management system, **SQL (Relational)** is the optimal choice. Academic enrollment data is inherently relational, structured, and bounded by strict business rules where referential integrity is critical. A relational engine enforces key invariants out of the box: a student cannot enroll in a nonexistent course (`FOREIGN KEY`), duplicate student emails are prevented (`UNIQUE`), and duplicate course registrations are blocked (`PRIMARY KEY`). Furthermore, school reporting heavily relies on multi-table aggregations (`JOIN`, `GROUP BY`, `COUNT`) to produce transcripts and course rosters. A document NoSQL store would require either embedding courses inside student documents (duplicating course titles and leading to update anomalies) or manual, non-transactional referential integrity handling in application code.