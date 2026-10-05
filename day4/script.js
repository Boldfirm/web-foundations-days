// ---------- 1. Select the required elements ----------
const noteText = document.querySelector("#note-text");
const charCount = document.querySelector("#char-count");
const wordCount = document.querySelector("#word-count");
const clearBtn = document.querySelector("#clear-btn");
const themeToggle = document.querySelector("#theme-toggle");

const DRAFT_KEY = "day4_note_draft";
const THEME_KEY = "day4_theme_pref";

// ---------- 2. Update character & word counts ----------
function updateCounts() {
  const text = noteText.value;
  const numChars = text.length;

  // Split on whitespace and filter empty tokens to accurately count words
  const trimmed = text.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;

  charCount.textContent = `${numChars} / 200 characters`;
  wordCount.textContent = words === 1 ? "1 word" : `${words} words`;

  // Threshold classes: > 200 takes precedence over > 180
  if (numChars > 200) {
    charCount.className = "over";
  } else if (numChars > 180) {
    charCount.className = "warning";
  } else {
    charCount.className = "";
  }
}

// ---------- 3. Storage & State Functions ----------
function saveDraft() {
  localStorage.setItem(DRAFT_KEY, noteText.value);
}

function clearAll() {
  noteText.value = "";
  localStorage.removeItem(DRAFT_KEY);
  updateCounts();
  noteText.focus();
}

function applyTheme(isDark) {
  if (isDark) {
    document.body.classList.add("dark");
    themeToggle.textContent = "Light mode";
  } else {
    document.body.classList.remove("dark");
    themeToggle.textContent = "Dark mode";
  }
}

// ---------- 4. Event Listeners ----------

// Input event: update counts and save draft continuously
noteText.addEventListener("input", () => {
  updateCounts();
  saveDraft();
});

// Escape key: clears draft if pressed inside textarea
noteText.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearAll();
  }
});

// Clear button
clearBtn.addEventListener("click", clearAll);

// Theme toggle button
themeToggle.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  themeToggle.textContent = isDark ? "Light mode" : "Dark mode";
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
});

// ---------- 5. Initialization on Page Load ----------
function init() {
  // Restore theme
  const savedTheme = localStorage.getItem(THEME_KEY);
  applyTheme(savedTheme === "dark");

  // Restore draft
  const savedDraft = localStorage.getItem(DRAFT_KEY);
  if (savedDraft !== null) {
    noteText.value = savedDraft;
  }

  // Draw initial counters
  updateCounts();
}

init();