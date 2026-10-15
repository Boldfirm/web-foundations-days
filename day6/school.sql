-- Day 6 Assignment: A School Database
PRAGMA foreign_keys = ON;

-- ========================================================
-- 1. Table Definitions
-- ========================================================

-- Students Table
CREATE TABLE students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Courses Table
CREATE TABLE courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE
);

-- Enrolments Join Table (Many-to-Many: Students <-> Courses)
-- PRIMARY KEY (student_id, course_id) prevents enrolling the same student twice
CREATE TABLE enrolments (
    student_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL,
    grade TEXT DEFAULT 'In Progress',
    enrolled_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (student_id, course_id),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- Recommended Index for Foreign Key Lookups
CREATE INDEX idx_enrolments_course_id ON enrolments(course_id);

-- ========================================================
-- 2. Seed Data
-- ========================================================

-- Insert at least 3 students (including 1 student with no enrolments)
INSERT INTO students (id, name, email) VALUES
(1, 'Amina Otieno', 'amina.otieno@school.ac.ke'),
(2, 'Brian Kamau', 'brian.kamau@school.ac.ke'),
(3, 'Chidi Okafor', 'chidi.okafor@school.ac.ke'),
(4, 'Fatima Bello', 'fatima.bello@school.ac.ke');

-- Insert at least 3 courses
INSERT INTO courses (id, title, code) VALUES
(101, 'Web Development Foundations', 'CS101'),
(102, 'Database Systems & SQL', 'CS102'),
(103, 'System Architecture & Cloud', 'CS103');

-- Insert at least 5 enrolments
INSERT INTO enrolments (student_id, course_id, grade) VALUES
(1, 101, 'A'),
(1, 102, 'B+'),
(2, 101, 'B'),
(2, 103, 'A-'),
(3, 102, 'In Progress');

-- ========================================================
-- 3. Five Required Queries
-- ========================================================

-- Query 1: All courses for one student by name
SELECT 
    students.name AS student_name,
    courses.code AS course_code,
    courses.title AS course_title,
    enrolments.grade
FROM students
JOIN enrolments ON students.id = enrolments.student_id
JOIN courses ON enrolments.course_id = courses.id
WHERE students.name = 'Amina Otieno';

-- Query 2: All students enrolled on one course (e.g., 'Web Development Foundations')
SELECT 
    courses.title AS course_title,
    courses.code AS course_code,
    students.name AS student_name,
    students.email AS student_email,
    enrolments.grade
FROM courses
JOIN enrolments ON courses.id = enrolments.course_id
JOIN students ON enrolments.student_id = students.id
WHERE courses.code = 'CS101';

-- Query 3: The number of students per course
SELECT 
    courses.code AS course_code,
    courses.title AS course_title,
    COUNT(enrolments.student_id) AS total_students
FROM courses
LEFT JOIN enrolments ON courses.id = enrolments.course_id
GROUP BY courses.id, courses.code, courses.title
ORDER BY total_students DESC;

-- Query 4: Students who have no enrolments
SELECT 
    students.id AS student_id,
    students.name AS student_name,
    students.email AS student_email
FROM students
LEFT JOIN enrolments ON students.id = enrolments.student_id
WHERE enrolments.course_id IS NULL;

-- Query 5: Update one enrolment's grade
UPDATE enrolments
SET grade = 'A'
WHERE student_id = 3 AND course_id = 102;

-- Verify Query 5 update
SELECT 
    students.name,
    courses.code,
    enrolments.grade
FROM enrolments
JOIN students ON enrolments.student_id = students.id
JOIN courses ON enrolments.course_id = courses.id
WHERE enrolments.student_id = 3 AND enrolments.course_id = 102;