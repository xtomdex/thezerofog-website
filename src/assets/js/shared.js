// === THE ZEROFOG - SHARED JS ===

// Theme toggle (button click)
function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  var isDark = document.documentElement.classList.contains('dark');
  document.getElementById('themeToggle').textContent = isDark ? 'Light' : 'Dark';
  localStorage.setItem('zf_theme', isDark ? 'dark' : 'light');
}

// On DOM ready: sync toggle button text to whatever theme is active
// (initial theme class is set by inline script in <head> before paint - see base.njk)
(function() {
  var btn = document.getElementById('themeToggle');
  if (!btn) return;
  var isDark = document.documentElement.classList.contains('dark');
  btn.textContent = isDark ? 'Light' : 'Dark';
})();

// Listen for OS theme changes when user has not explicitly chosen via toggle
(function() {
  if (!window.matchMedia) return;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (!mq.addEventListener) return;
  mq.addEventListener('change', function(e) {
    if (localStorage.getItem('zf_theme')) return; // user has explicit choice, respect it
    if (e.matches) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    var btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = e.matches ? 'Light' : 'Dark';
  });
})();
