// === THE ZEROFOG - SHARED JS ===

// Theme toggle
function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  var isDark = document.documentElement.classList.contains('dark');
  document.getElementById('themeToggle').textContent = isDark ? 'Light' : 'Dark';
  localStorage.setItem('zf_theme', isDark ? 'dark' : 'light');
}

// Restore saved theme (dark is default)
(function() {
  var saved = localStorage.getItem('zf_theme');
  if (saved === 'light') {
    document.documentElement.classList.remove('dark');
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = 'Dark';
  }
})();
