/**
 * Static stylesheet for the standalone login page (public/login.html, served at /login).
 *
 * The page used to compile Tailwind in the browser from cdn.tailwindcss.com with an
 * inline config, which forced `script-src 'unsafe-inline' https://cdn.tailwindcss.com`
 * into the login CSP - the last policy exception in the application. This config bakes
 * exactly the same utilities, palette, fonts, shadows and plugins (forms,
 * container-queries) into public/login.css so /login can ship the same strict
 * `script-src 'self'` policy as the SPA.
 *
 * Regenerate with `pnpm build:login` after editing public/login.html or public/login.js
 * (it runs automatically as part of `pnpm build`).
 */
module.exports = {
  content: ['./public/login.html', './public/login.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: '#FAF8FF',
        'royal-navy': '#000945',
        'navy-container': '#121f64',
        'navy-light': '#172574',
        gold: '#ea9e1a',
        'gold-light': '#ffb953',
        'gold-container': '#fdae2d',
        'gold-dark': '#825500',
        'border-subtle': '#E2E7FF',
        'border-input': '#CBD5E1',
        'text-primary': '#131b2e',
        'text-secondary': '#454650',
        'text-muted': '#767682',
      },
      fontFamily: {
        headline: ['Plus Jakarta Sans', 'Inter', 'sans-serif'],
        serif: ['Cinzel', 'serif'],
        body: ['Inter', 'sans-serif'],
      },
      boxShadow: {
        'gold-glow': '0 4px 20px -2px rgba(234, 158, 26, 0.35)',
        'navy-glow': '0 8px 24px -4px rgba(18, 31, 100, 0.35)',
        'card-clean': '0 10px 40px -10px rgba(0, 9, 69, 0.06)',
      },
    },
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')],
};
