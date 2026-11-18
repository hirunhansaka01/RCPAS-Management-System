/**
 * Behaviour for the standalone login page (public/login.html, served at /login).
 *
 * This used to be an inline <script> block plus onsubmit/onclick attributes in the
 * markup. Moving it to a same-origin file is what allows /login to ship
 * `script-src 'self'` instead of the old `unsafe-inline` + Tailwind-CDN exception.
 */
(function () {
  document.getElementById('currentYear').textContent = new Date().getFullYear();

  function togglePasswordVisibility() {
    const input = document.getElementById('adminPassword');
    const icon = document.getElementById('eyeIcon');
    if (!input || !icon) return;

    if (input.type === 'password') {
      input.type = 'text';
      icon.textContent = 'visibility_off';
    } else {
      input.type = 'password';
      icon.textContent = 'visibility';
    }
  }

  // Real authentication: POST /api/auth/password/login with the CSRF cookie
  // echoed as the X-CSRF-Token header (same contract as the SPA), then redirect
  // into the app on success. Errors surface inline.
  function readCsrf() {
    const raw = document.cookie.split('; ').find(v => v.startsWith('__Host-rcpas_csrf='))?.split('=')[1];
    return raw ? decodeURIComponent(raw) : '';
  }

  function showError(message) {
    const box = document.getElementById('loginError');
    if (box) { box.textContent = message; box.classList.remove('hidden'); }
  }

  async function signIn() {
    const btn = document.getElementById('signInBtn');
    const text = document.getElementById('buttonText');
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    if (!btn || !text) return;

    const box = document.getElementById('loginError');
    if (box) { box.classList.add('hidden'); box.textContent = ''; }

    if (!email || !password) { showError('Enter your email and password.'); return; }

    btn.disabled = true;
    btn.classList.add('opacity-90', 'cursor-not-allowed');
    text.textContent = 'Signing in…';

    try {
      let csrf = readCsrf();
      if (!csrf) { await fetch('/api/auth/session', { credentials: 'include' }); csrf = readCsrf(); }

      const res = await fetch('/api/auth/password/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: JSON.stringify({ email, password })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Sign in failed. Please try again.');

      text.textContent = 'Signed in! Redirecting…';
      btn.classList.remove('bg-royal-navy', 'hover:bg-[#121f64]');
      btn.classList.add('bg-emerald-700');
      setTimeout(() => { window.location.assign('/'); }, 600);
    } catch (e) {
      showError(e && e.message ? e.message : 'Sign in failed. Please try again.');
      btn.disabled = false;
      btn.classList.remove('opacity-90', 'cursor-not-allowed');
      text.textContent = 'Sign in';
    }
  }

  // Wiring that used to live in inline onsubmit/onclick attributes.
  document.getElementById('loginForm').addEventListener('submit', function (event) {
    event.preventDefault();
    signIn();
  });
  document.getElementById('togglePassword').addEventListener('click', togglePasswordVisibility);
  document.getElementById('forgotLink').addEventListener('click', function (event) {
    event.preventDefault();
    alert('Contact the system administrator to reset your password.');
  });
})();
