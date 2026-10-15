-- Day 6: QuickNotes Queries & Operations

-- ========================================================
-- 1. INSERT (Seed Initial Data)
-- ========================================================

-- Insert sample users
INSERT INTO users (id, name, email) VALUES
(1, 'Amina Otieno', 'amina@example.com'),
(2, 'Brian Kamau', 'brian@example.com');

-- Insert sample notes
INSERT INTO notes (id, user_id, title, content, category) VALUES
(1, 1, 'HTTP Methods', 'Revise GET, POST, PUT, DELETE before class', 'study'),
(2, 1, 'Groceries', 'Buy milk, eggs, and bread', 'personal'),
(3, 2, 'Project Report', 'Finish system design capstone presentation', 'work');

-- Insert tags
INSERT INTO tags (id, name) VALUES
(10, 'exams'),
(11, 'urgent'),
(12, 'shopping');

-- Associate notes with tags (note_tags bridge)
INSERT INTO note_tags (note_id, tag_id) VALUES
(1, 10), -- Note 1 is tagged 'exams'
(1, 11), -- Note 1 is tagged 'urgent'
(2, 11), -- Note 2 is tagged 'urgent'
(2, 12); -- Note 2 is tagged 'shopping'

-- ========================================================
-- 2. SELECT & JOINS
-- ========================================================

-- A. Basic retrieval: Fetch all notes for a specific user
SELECT id, title, content, category, created_at
FROM notes
WHERE user_id = 1;

-- B. One-to-Many JOIN: Get all notes with author details
SELECT 
    notes.id AS note_id,
    notes.title,
    notes.content,
    users.name AS author_name,
    users.email AS author_email
FROM notes
INNER JOIN users ON notes.user_id = users.id;

-- C. Many-to-Many JOIN: Retrieve all notes with their assigned tags
SELECT 
    notes.id AS note_id,
    notes.title,
    tags.name AS tag_name
FROM notes
INNER JOIN note_tags ON notes.id = note_tags.note_id
INNER JOIN tags ON note_tags.tag_id = tags.id
ORDER BY notes.id;

-- D. Aggregate Query: Count how many notes belong to each user
SELECT 
    users.name,
    COUNT(notes.id) AS total_notes
FROM users
LEFT JOIN notes ON users.id = notes.user_id
GROUP BY users.id, users.name;

-- ========================================================
-- 3. UPDATE
-- ========================================================

-- Update content and category for note #2
UPDATE notes
SET content = 'Buy almond milk, brown eggs, and whole wheat bread',
    category = 'groceries'
WHERE id = 2;

-- ========================================================
-- 4. DELETE
-- ========================================================

-- Remove a tag association from a note
DELETE FROM note_tags
WHERE note_id = 2 AND tag_id = 12;

-- Delete a note (cascades to note_tags due to ON DELETE CASCADE)
DELETE FROM notes
WHERE id = 3;