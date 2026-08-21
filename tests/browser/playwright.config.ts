import { defineConfig, devices } from "@playwright/test";

/**
 * The layout suite. A stylesheet rule and a shader uniform are claims about
 * what a page looks like, and neither jsdom nor a source-text assertion can
 * check one: jsdom has no layout engine and no WebGL. These run in a real
 * Chromium instead, against the apps' real stylesheets and the real shader.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5195/" } }],
  // The shader spec needs the real app on a real page, so it gets the built
  // bundle rather than the dev server: `vite dev` re-optimizes its dependency
  // graph on a cold start and reloads the page mid-navigation, which raced
  // these specs, and a preview server has no optimizer and no HMR to race.
  // The bundle is also what actually ships.
  //
  // A dedicated port: 5173 carries WSL and Docker proxies on this project's
  // machines and has failed runs that had nothing to do with the app. The base
  // URLs point at a closed port on purpose - the sign-in screen renders the
  // background without ever reaching a service, and the suite must not talk to
  // one. `reuseExistingServer` stays off in both directions: a preview server
  // left over from a previous run would be serving a previous build.
  webServer: {
    command: "pnpm --filter @siqshift/web build && pnpm --filter @siqshift/web exec vite preview --port 5195 --strictPort",
    cwd: "../..",
    url: "http://localhost:5195/",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      VITE_AUTH_BASE_URL: "http://127.0.0.1:9/auth",
      VITE_API_BASE_URL: "http://127.0.0.1:9/api",
    },
  },
});
