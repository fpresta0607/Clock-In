import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

/**
 * A stylesheet's leading `@import` block, removed.
 *
 * Both stylesheets keep every `@import` at the top, one statement per line, so
 * the block ends at the first line that is not one. Cutting to the next `;`
 * instead would end inside the Google Fonts URL, whose `wght@300;400;...` axis
 * list is semicolons: the tail would survive as a rule prelude and CSS error
 * recovery would swallow the first real rule after it.
 */
const withoutImports = (css: string): string => {
  const lines = css.split("\n");
  let first = 0;
  while (lines[first]?.trimStart().startsWith("@import")) first++;
  return lines.slice(first).join("\n");
};

/**
 * An app's real stylesheet, with its `@import`s resolved by hand.
 *
 * The pages below are served through `setContent`, which has no module
 * resolver and no network: the bare `@clock-in/shared/brand.css` import would
 * not resolve and the Google Fonts one would reach out of the test run. Both
 * are replaced here - brand.css by its own text, the font by nothing - so the
 * rules under test are the ones the app actually ships.
 */
const stylesheet = (app: "desktop" | "web"): string =>
  [repoFile("packages/shared/styles/brand.css"), withoutImports(repoFile(`apps/${app}/src/styles.css`))].join("\n");

/**
 * Inject an app's stylesheet, and prove the container it lays the rows out in
 * is the one the app renders.
 *
 * A sheet mangled on its way in still parses: CSS error recovery reads the
 * wreckage as a prelude and drops the rule after it. Every assertion below is
 * relative - an ordering, a width that grew - so a container left at its
 * default layout passes them all quietly. Each of these containers is laid out
 * by the app's own rule for it, so `display: grid` is that rule arriving.
 */
async function applyStylesheet(page: Page, app: "desktop" | "web", container: string): Promise<void> {
  await page.addStyleTag({ content: stylesheet(app) });
  const display = await page.locator(container).evaluate((element) => getComputedStyle(element).display);
  if (display !== "grid") {
    throw new Error(`${container} is not laid out by the ${app} stylesheet: display is "${display}", not "grid"`);
  }
}

/**
 * The third cell of a `.meter-row`: a share bar, or - on an agent's row - the
 * plan dial that answers a different question in the same column.
 */
const meterCell = (share: number | "quota"): string =>
  share === "quota"
    ? `<div class="quota">
         <button type="button" class="quota-trigger" aria-expanded="false">
           <svg class="quota-face" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
             <circle class="quota-track" cx="14" cy="14" r="11" fill="none" stroke-width="3"></circle>
             <text class="quota-figure" x="14" y="14" text-anchor="middle" dominant-baseline="central">62%</text>
           </svg>
           <span class="quota-meta">
             <span class="quota-plan">Max</span>
             <span class="quota-window">til 21:00</span>
           </span>
         </button>
       </div>`
    : `<span class="meter-bar" aria-hidden="true" style="--share: ${share}%"></span>`;

/** One `.meter-row`, in the markup the Today card and the Agents tab emit. */
const meterRow = (name: string, detail: string, share: number | "quota", duration: string): string => `
  <li class="meter-row">
    <span class="app-mark is-plain" aria-hidden="true"></span>
    <span class="meter-name">${name}${detail === "" ? "" : `<span class="meter-detail"> · ${detail}</span>`}</span>
    ${meterCell(share)}
    <span class="meter-duration">${duration}</span>
  </li>`;

/// Heaviest first, the order the Today card sorts them in. The agent row
/// carries a quota dial where the others carry a bar, because two of those
/// side by side is what a second column has to survive.
const TODAY_ROWS: readonly (readonly [string, string, number | "quota", string])[] = [
  ["Visual Studio Code", "", 100, "4h 12m"],
  ["Claude Code", "clock-in", "quota", "3h 06m"],
  ["Google Chrome", "", 51, "2h 09m"],
  ["Windows Terminal", "", 33, "1h 24m"],
  ["Slack", "", 18, "46m"],
  ["Everything else", "", 9, "23m"],
];

/** The Today card as the desktop app lays it out, inside the real app shell. */
export async function openTodayCard(page: Page): Promise<void> {
  await page.setContent(`
    <main class="app-shell">
      <div class="screen">
        <section class="session-stats card" aria-labelledby="today-panel-title">
          <div class="panel-head"><h2 id="today-panel-title">Today</h2></div>
          <ul class="meter-list meter-apps" data-testid="session-app-list">
            ${TODAY_ROWS.map(([name, detail, share, duration]) => meterRow(name, detail, share, duration)).join("")}
          </ul>
        </section>
      </div>
    </main>`);
  await applyStylesheet(page, "desktop", ".screen");
}

/**
 * One Agents-tab codebase group, in either app's markup for it.
 *
 * The containers differ, and the row's width comes from them: the desktop tab
 * lives in the All-stats overlay (`.modal-overlay` > `.today-card.card.modal`),
 * the web tab in the dashboard's own `.shell`. Rendering the desktop group in
 * `.screen` would measure it at a width it is never shown at.
 */
export async function openAgentsGroup(page: Page, app: "desktop" | "web"): Promise<void> {
  const open = app === "desktop"
    ? `<main class="app-shell"><div class="modal-overlay"><section class="today-card card modal">`
    : `<main class="page"><div class="shell">`;
  const close = app === "desktop" ? `</section></div></main>` : `</div></main>`;
  await page.setContent(`
    ${open}
        <section class="member-stats" data-testid="agent-shifts">
          <div class="shift-group" data-testid="shift-group">
            <div class="meter-row shift-group-head">
              <span class="project-dot" aria-hidden="true"></span>
              <span class="meter-name">clock-in<span class="meter-detail held-tag"> · 50% held</span></span>
              <span class="meter-bar" aria-hidden="true" style="--share: 75%"></span>
              <span class="meter-duration">1h 30m</span>
            </div>
            <ul class="shift-list">
              <li class="shift-row">
                <span class="shift-when">15:00</span>
                <span class="shift-facts">Claude Code · Alex · claude-opus-5 · 2 commits</span>
                <span class="shift-duration">1h 00m</span>
              </li>
            </ul>
          </div>
          <div class="shift-group" data-testid="shift-group">
            <div class="meter-row shift-group-head">
              <span class="project-dot" aria-hidden="true"></span>
              <span class="meter-name">No codebase recorded</span>
              <span class="meter-bar" aria-hidden="true" style="--share: 25%"></span>
              <span class="meter-duration">30m</span>
            </div>
            <ul class="shift-list">
              <li class="shift-row">
                <span class="shift-when">09:30</span>
                <span class="shift-facts">Codex · Alex</span>
                <span class="shift-duration">30m</span>
              </li>
            </ul>
          </div>
        </section>
    ${close}`);
  await applyStylesheet(page, app, app === "desktop" ? ".modal-overlay" : ".shell");
}
