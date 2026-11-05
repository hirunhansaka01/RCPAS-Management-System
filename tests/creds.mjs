import path from 'node:path';

// Loads the project-root .env so the test suites can read their own settings
// without those settings ever being written into this repository.
try { process.loadEnvFile(path.resolve(process.cwd(), '.env')); } catch { /* no .env: variables may already be exported */ }

/**
 * Reads a test-account password from the environment.
 *
 * No password ships with this repository. To run the end-to-end suites, copy
 * `.env.example` to `.env` and fill in the `TEST_*_PASSWORD` entries with the
 * values of the accounts you created for your own database (see
 * `pnpm db:setup-test-accounts`). The same values are read by
 * `tests/make-test-accounts.ts`, so creating the accounts and signing in as
 * them always agree.
 */
export function passwordFor(envName) {
  const value = process.env[envName];
  if (!value) {
    console.error(`\n[config] ${envName} is not set, so this suite cannot sign in.`);
    console.error('         Copy .env.example to .env and set the TEST_*_PASSWORD');
    console.error('         entries, then run "pnpm db:setup-test-accounts" first.');
    console.error('         See README.md -> "Testing".\n');
    process.exit(1);
  }
  return value;
}
