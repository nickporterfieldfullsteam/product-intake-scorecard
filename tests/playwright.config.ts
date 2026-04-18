import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

/**
 * Three test targets, selected by TEST_TARGET env var:
 *   - local  (default): file:// URL pointing at ../index.html
 *   - server:           http://localhost:8787/index.html (run `npm run serve` first)
 *   - live:              https://nickporterfieldfullsteam.github.io/arbiter/
 *
 * Run:
 *   npm test                  → local (file://)
 *   npm run test:server       → local server
 *   npm run test:live         → GitHub Pages
 */

const TARGET = process.env.TEST_TARGET || 'local';

function resolveBaseURL(): string {
  switch (TARGET) {
    case 'server':
      return process.env.TEST_SERVER_URL || 'http://localhost:8787';
    case 'live':
      return process.env.TEST_LIVE_URL || 'https://nickporterfieldfullsteam.github.io/arbiter';
    case 'local':
    default:
      // file:// URL to ../index.html relative to this config file
      const absPath = path.resolve(__dirname, '..', 'index.html');
      return 'file://' + absPath.split(path.sep).join('/');
  }
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,          // Tests share a Supabase workspace; keep serial for cleanliness
  workers: 1,                    // One worker; avoids concurrent DB writes stomping each other
  forbidOnly: !!process.env.CI,
  retries: 0,                    // Fail fast locally; we want to see real failures
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: resolveBaseURL(),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only auto-start a local server when TEST_TARGET=server
  webServer: TARGET === 'server' ? {
    command: 'python3 -m http.server 8787 --directory ../',
    url: 'http://localhost:8787',
    reuseExistingServer: true,
    timeout: 10_000,
  } : undefined,
});
