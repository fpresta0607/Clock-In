import { useEffect } from "react";

import { AgentRuntimeIcon } from "./agent-icons.js";
import { sourceLabel } from "./agent-sources.js";
import type { BrowserHealth, MonitorStatus } from "./bridge.js";

/// What the panel says is happening right now. `paused` is "switched on but
/// the host is not running the tasks" (signed out, unsupported platform);
/// `stalled` is "the tasks are up but this machine has stopped being
/// sampled"; `unknown` is "the host did not answer the status call at all".
///
/// This is the one place the recording state is decided. Every surface reads
/// it, so no two parts of the app can disagree about whether recording is on.
export type RecordingState = "on" | "stalled" | "paused" | "off" | "unknown";

export const recordingState = (status: MonitorStatus | undefined): RecordingState => {
  if (status === undefined) return "unknown";
  if (!status.enabled) return "off";
  if (!status.running) return "paused";
  // `running` only says the tasks were started. Claiming "on" from it alone is
  // what let a dead poll task look healthy while nothing was being recorded.
  return status.observing ? "on" : "stalled";
};

const HEADLINE: Record<RecordingState, string> = {
  on: "Recording is on",
  stalled: "Recording has stopped responding",
  paused: "Recording is on, but not running right now",
  off: "Recording is off",
  unknown: "Clock-In can't check this computer",
};

const SUMMARY: Record<RecordingState, string> = {
  on: "Clock-In is writing your hours down for you, for as long as this app is open. There is nothing to start and nothing to stop.",
  stalled: "Clock-In has not looked at this computer for a while, so hours are not being written down right now. Restarting the app fixes it.",
  paused: "It starts again on its own.",
  off: "Clock-In is writing nothing down and no hours are being recorded on this computer.",
  unknown: "It can't say what it is doing at the moment.",
};

const COMPUTER_STATE: Record<RecordingState, string> = {
  on: "On, looks every 30 seconds",
  stalled: "Not responding",
  paused: "Waiting to start",
  off: "Off",
  unknown: "Unknown",
};

const KEPT = [
  "Whether you were using this computer, away from it, or had the screen locked.",
  "The name of the app in front of you, like “chrome” or “code”. The name only.",
  // The remote is part of what is recorded: identity is keyed on the repository,
  // and the repository is named by its remote. This wording is deliberately the
  // wording README's "What is collected" will carry - one rule told once - and
  // is ahead of it here: README's matching update lands with the
  // agent-identity-by-remote work that made the remote part of identity.
  "When an AI coding tool starts and finishes, which folder it worked in, and - when that folder is in a git repository - that repository's root and its origin remote URL with any embedded credentials removed, which is what names the repository it worked in.",
  "For AI coding shifts in a git repo: the branch name, and the title, commit id, and repository folder of each commit made during the shift, checked later on this machine, read-only. The repository folder is shown only to you and your workspace's admins.",
  "For AI coding shifts that keep a session log: the number of tokens used and which model the tool ran, read from that log on this computer. The numbers and the model name only.",
];

const NEVER = [
  "What you type. Not one keystroke.",
  "Pictures of your screen.",
  "The titles of your windows, files, or documents. Commit titles are the one exception, listed above.",
  "Browsing addresses, history, or page content. A repository's origin remote URL is not browsing: it names which repository an agent worked, and is listed above.",
  "Anything inside your files, messages, or email. Token counts and model names from an AI tool's own session log are the one exception, listed above.",
  "Anything you type into a form, chat, or document.",
  "Clock-In never reaches inside or controls your other apps.",
];

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type RecordingPanelProps = {
  open: boolean;
  onClose: () => void;
  /// `undefined` when the host never answered `monitor_status`.
  status: MonitorStatus | undefined;
  /// The project the open stretch of work is being filed under.
  projectName?: string | undefined;
  /// Where time lands when nothing names a project.
  defaultProjectName?: string | undefined;
  /// Paste-it-yourself instructions from a `Connect` that could not merge,
  /// keyed by CLI source.
  hookSnippets: Readonly<Record<string, string>>;
  /// One card per installed browser, in the state order a setup flows through.
  browsers: ReadonlyArray<BrowserHealth>;
  onTurnOnRecording: () => void;
  onConnectAgent: (source: string) => void;
  /// The [Add extension] click: open that browser's store page.
  onConnectBrowser: (browserId: string) => void;
  /// The [Repair] click: re-register the host for that browser.
  onRepairBrowser: (browserId: string) => void;
};

/**
 * "What Clock-In is recording": the transparency surface. It answers, in this
 * order, what is happening right now, which sources are switched on, what is
 * and is not written down, and how the whole thing works. Every failing state
 * carries the one button that fixes it rather than instructions to follow.
 */
export const RecordingPanel = ({
  open,
  onClose,
  status,
  projectName,
  defaultProjectName,
  hookSnippets,
  browsers,
  onTurnOnRecording,
  onConnectAgent,
  onConnectBrowser,
  onRepairBrowser,
}: RecordingPanelProps) => {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const state = recordingState(status);
  const backlog = status === undefined
    ? 0
    : status.segmentBacklog + status.agentBacklog + status.sessionBacklog;
  const current = status?.currentSession ?? null;
  // A browser without a released extension id is not installed to connect, so
  // it contributes no card.
  const visibleBrowsers = browsers.filter((browser) => browser.state !== "disabled");

  return (
    <div className="modal-overlay recording-overlay" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-title"
        className="card modal recording-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-head">
          <h2 id="recording-title">What Clock-In is recording</h2>
          <button
            className="outline-button modal-close"
            type="button"
            aria-label="Close what's recorded"
            onClick={onClose}
            autoFocus
          >
            ✕
          </button>
        </div>

        <div className="recording-now">
          <p className="recording-headline">
            <span className={`monitor-dot is-${state}`} aria-hidden="true" />
            <strong>{HEADLINE[state]}</strong>
          </p>
          <p className="subtle">{SUMMARY[state]}</p>
          {current !== null && (
            <p className="subtle" data-testid="panel-current">
              Right now your time is going to <strong>{projectName ?? "a project"}</strong>
              {current.attribution === "agent"
                ? ", because that is the folder your AI tool is working in."
                : current.attribution === "selected"
                  ? ", because you picked it."
                  : ", because nothing else said otherwise."}
            </p>
          )}
          {state === "off" && (
            <button className="signal-button recording-fix" type="button" onClick={onTurnOnRecording}>
              Turn recording on
            </button>
          )}
        </div>

        <h3>What&apos;s switched on</h3>
        {status === undefined ? (
          <p className="subtle">Clock-In will show this as soon as it can reach the recorder on this computer.</p>
        ) : (
          <>
            <ul className="source-list">
              <li className="source-row">
                <span className="source-name">This computer</span>
                <span className={`source-state ${state === "on" ? "is-on" : "is-off"}`}>{COMPUTER_STATE[state]}</span>
              </li>
              {/* State, not a to-do list. Clock-In connects what it can on
                  startup, so a row only carries a button when a person really
                  is the only one who can finish it. */}
              {status.hooks.map((hook) => (
                <li key={hook.source} className="source-row">
                  <span className="source-name">
                    <AgentRuntimeIcon source={hook.source} />
                    {sourceLabel(hook.source)}
                  </span>
                  {hook.detected ? (
                    <span className="source-state is-on">Connected</span>
                  ) : !hook.installed ? (
                    <span className="source-state is-absent">Not on this computer</span>
                  ) : hook.needsYou ? (
                    <>
                      <span className="source-state is-off">Needs a hand</span>
                      <button type="button" className="source-fix" onClick={() => onConnectAgent(hook.source)}>
                        Show me how
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="source-state is-off">Not connected</span>
                      <button type="button" className="source-fix" onClick={() => onConnectAgent(hook.source)}>
                        Connect
                      </button>
                    </>
                  )}
                  {hookSnippets[hook.source] !== undefined && (
                    <>
                      <p className="source-note">
                        Clock-In can&apos;t switch this one on by itself. Copy the lines below into that tool&apos;s own
                        settings file.
                      </p>
                      <pre className="hook-snippet">{hookSnippets[hook.source]}</pre>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {visibleBrowsers.length === 0 ? (
              <p className="subtle">Nothing else is connected. Clock-In does not watch your web browser.</p>
            ) : (
              <ul className="source-list">
                {visibleBrowsers.map((browser) => (
                  <li key={browser.browser} className="source-row">
                    <span className="source-name">{browser.label}</span>
                    {browser.state === "connected" ? (
                      <span className="source-state is-on">Connected</span>
                    ) : browser.state === "registered" ? (
                      <>
                        <span className="source-state is-off">Not connected</span>
                        <button
                          type="button"
                          className="source-fix"
                          onClick={() => onConnectBrowser(browser.browser)}
                        >
                          Add extension
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="source-state is-off">Needs a hand</span>
                        <button
                          type="button"
                          className="source-fix"
                          onClick={() => onRepairBrowser(browser.browser)}
                        >
                          Repair
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <h3>Clock-In writes down</h3>
        <ul className="record-list is-kept">
          {KEPT.map((line) => <li key={line}>{line}</li>)}
        </ul>

        <h3>How time is counted</h3>
      {/* The same four sentences the web dashboard's help speaks - one set
          of rules, told once, so no surface can contradict another. */}
      <ul className="record-list">
          <li>Your hours are wall-clock time you were actually at the machine. They can never exceed real elapsed time.</li>
          <li>Human work is the time you worked with no agent running - the share you verified yourself.</li>
          <li>The 1, 2, and 3+ agent splits are your agent-assisted share - still your hours, split by how many agents ran beside you at once.</li>
          <li>Agent time is the summed runtime of every AI tool working for you. Three agents in parallel for an hour is 3h of agent time inside 1h of yours - that ratio is your leverage, never extra hours.</li>
          <li>An agent still working while you step away keeps counting as agent time, but never as your hours.</li>
          <li>The leaderboard ranks by your hours. Agent time and leverage sit beside them, answering a different question: how much work you got out of the tools.</li>
      </ul>

      <h3>Clock-In never writes down</h3>
        <ul className="record-list is-never">
          {NEVER.map((line) => <li key={line}>{line}</li>)}
        </ul>

        <h3>How Clock-In works</h3>
        <ol className="help-steps">
          <li>
            <strong>You do nothing.</strong> While this app is open and recording is on, Clock-In writes down the
            hours you spend at this computer. There is no button to press and no timer to forget.
          </li>
          <li>
            <strong>A stretch of work ends when you stop.</strong> Go quiet for a while, lock the screen, or shut
            the computer down, and that stretch is closed at the moment you stopped. Quiet time is never counted.
          </li>
          <li>
            <strong>Your hours are filed under a project.</strong> If an AI tool is working in a folder you have
            matched to a project, they go there. Otherwise they go to
            {" "}<strong>{defaultProjectName ?? "your default project"}</strong>, and you can pick a different one
            whenever you like.
          </li>
          <li>
            <strong>You see what your team sees.</strong> The same hours, added up the same way, on the Clock-In
            website. Hours filed under a project on purpose are counted separately from hours that just fell to the
            default, so nobody has to guess.
          </li>
        </ol>

        <p className="recording-foot">
          Your hours are saved on this computer first, then sent to your workspace every few minutes.
          {status?.lastUploadAt != null && ` Last sent at ${clockTime(status.lastUploadAt)}.`}
          {backlog > 0 && ` ${backlog} ${backlog === 1 ? "note is" : "notes are"} still waiting to be sent.`}
        </p>

        {status !== undefined && (
          <details className="recording-diagnostics" data-testid="recording-diagnostics">
            <summary>Technical details</summary>
            {/* The proof surface for the recording chain. Each line is one link,
                so "nothing is being recorded" can be read off the screen instead
                of inferred from an empty report days later. */}
            <dl className="diagnostic-list">
              <div>
                <dt>Last look at this computer</dt>
                <dd data-testid="diagnostic-poll">
                  {status.lastPollAgeSeconds === null
                    ? "Never - this computer has not been sampled yet"
                    : `${status.lastPollAgeSeconds}s ago`}
                </dd>
              </div>
              <div>
                <dt>Waiting to be sent</dt>
                <dd data-testid="diagnostic-backlog">
                  {status.segmentBacklog} app {status.segmentBacklog === 1 ? "note" : "notes"},{" "}
                  {status.sessionBacklog} {status.sessionBacklog === 1 ? "stretch" : "stretches"},{" "}
                  {status.agentBacklog} AI {status.agentBacklog === 1 ? "note" : "notes"}
                </dd>
              </div>
              <div>
                <dt>Last sent to your workspace</dt>
                <dd data-testid="diagnostic-upload">
                  {status.lastUploadAt === null ? "Never" : clockTime(status.lastUploadAt)}
                </dd>
              </div>
            </dl>
          </details>
        )}
      </section>
    </div>
  );
};
