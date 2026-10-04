// --- Starting Data ---
let notes = [
  { id: 1, text: "Buy milk and bread", category: "personal" },
  { id: 2, text: "Finish the Day 3 assignment", category: "study" },
  { id: 3, text: "Email the project report to Grace", category: "work" },
  { id: 4, text: "Revise JavaScript arrays", category: "study" },
  { id: 5, text: "Call mum", category: "personal" },
];

// 1. searchNotes(word): returns array of notes containing word, case-insensitive
function searchNotes(word) {
  const query = word.toLowerCase();
  return notes.filter((note) => note.text.toLowerCase().includes(query));
}

// 2. longestNote(): returns the note object with the most characters, or null
function longestNote() {
  if (notes.length === 0) return null;
  return notes.reduce((longest, current) => {
    return current.text.length > longest.text.length ? current : longest;
  });
}

// 3. countByCategory(): counts notes per category
function countByCategory() {
  const counts = {};
  for (const note of notes) {
    counts[note.category] = (counts[note.category] || 0) + 1;
  }
  return counts;
}

// 4. getSummary(): returns formatted summary sentence
function getSummary() {
  const total = notes.length;
  const word = total === 1 ? "note" : "notes";
  const counts = countByCategory();

  const personal = counts.personal || 0;
  const work = counts.work || 0;
  const study = counts.study || 0;

  return `${total} ${word}: ${personal} personal, ${work} work, ${study} study.`;
}

// 5. isDuplicate(text): returns true if trimmed, case-insensitive text matches an existing note
function isDuplicate(text) {
  const clean = text.trim().toLowerCase();
  return notes.some((note) => note.text.trim().toLowerCase() === clean);
}

// 6. addNote(text, category): validates, checks duplicates, category, and adds
function addNote(text, category) {
  const cleanText = text ? text.trim() : "";
  const allowedCategories = ["personal", "work", "study"];

  if (cleanText.length < 1 || cleanText.length > 200) {
    console.log("❌ Note rejected: text must be between 1 and 200 characters.");
    return false;
  }

  if (isDuplicate(cleanText)) {
    console.log(`❌ Note rejected: duplicate note "${cleanText}".`);
    return false;
  }

  if (!allowedCategories.includes(category)) {
    console.log(`❌ Note rejected: invalid category "${category}". Must be personal, work, or study.`);
    return false;
  }

  const newNote = {
    id: Date.now(),
    text: cleanText,
    category: category,
  };

  notes.push(newNote);
  console.log(`✅ Note added: "${newNote.text}" [${newNote.category}]`);
  return true;
}

// --- Test Cases ---

console.log("--- 1. Testing searchNotes ---");
console.log(searchNotes("day")); 
// Expected: Array with 1 note (Finish the Day 3 assignment)
console.log(searchNotes("gym")); 
// Expected: [] (edge case: no matches)

console.log("\n--- 2. Testing longestNote ---");
console.log(longestNote()); 
// Expected: Note with id 3 ("Email the project report to Grace" - 33 chars)
const tempNotes = notes;
notes = [];
console.log(longestNote()); 
// Expected: null (edge case: empty array)
notes = tempNotes; // restore

console.log("\n--- 3. Testing countByCategory ---");
console.log(countByCategory()); 
// Expected: { personal: 2, study: 2, work: 1 }

console.log("\n--- 4. Testing getSummary ---");
console.log(getSummary()); 
// Expected: "5 notes: 2 personal, 1 work, 2 study."
const backup = notes;
notes = [{ id: 99, text: "Solo note", category: "work" }];
console.log(getSummary()); 
// Expected: "1 note: 0 personal, 1 work, 0 study." (edge case: singular 'note')
notes = backup; // restore

console.log("\n--- 5. Testing isDuplicate ---");
console.log(isDuplicate("  call mum  ")); 
// Expected: true (matches id 5, ignoring casing and surrounding spaces)
console.log(isDuplicate("Buy eggs")); 
// Expected: false (edge case: novel text)

console.log("\n--- 6. Testing addNote ---");
console.log(addNote("Walk the dog", "personal")); 
// Expected: true, logs ✅ Note added
console.log(addNote("Call mum", "personal")); 
// Expected: false, logs ❌ Note rejected: duplicate note (edge case: duplicate)
console.log(addNote("   ", "study")); 
// Expected: false, logs ❌ Note rejected: text must be between 1 and 200 characters (edge case: empty/spaces)
console.log(addNote("Read book", "fitness")); 
// Expected: false, logs ❌ Note rejected: invalid category (edge case: invalid category)