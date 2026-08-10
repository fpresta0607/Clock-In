import { useEffect } from "react";

import { sourceLabel } from "./agent-sources.js";
import type { MonitorStatus } from "./bridge.js";

/// What the panel says is happening right now. `paused` is "switched on but
/// the host is not running the tasks" (signed out, unsupported platform);
/// `unknown` is "the host did not answer the status call at all".
export type RecordingState = "on" | "paused" | "off" | "unknown";

export const recordingState = (status: MonitorStatus | undefined): RecordingState => {
  if (status === undefined) return "unknown";
  if (!status.enabled) return "off";
  return status.running ? "on" : "paused";
};

const HEADLINE: Record<RecordingState, string> = {
  on: "Recording is on",
  paused: "Recording is on, but not running right now",
  off: "Recording is off",
  unknown: "Clock-In can't check this computer",
};

const SUMMARY: Record<RecordingState, string> = {
  on: "Clock-In is keeping a quiet note of when this computer was busy, so your hours have something behind them.",
  paused: "It starts again on its own. Your hours keep counting either way.",
  off: "Clock-In is noting nothing about this computer. Your timer still works and your hours still count. They just won't be marked as backed up.",
  unknown: "It can't say what it is recording at the moment. Your timer still works and your hours still count.",
};

const COMPUTER_STATE: Record<RecordingState, string> = {
  on: "On, looks every 30 seconds",
  paused: "Waiting to start",
  off: "Off",
  unknown: "Unknown",
};

const KEPT = [
  "Whether you were using this computer, away from it, or had the screen locked.",
  "The name of the app in front of you, like “chrome” or “code”. The name only.",
  "When an AI coding tool starts and finishes, and which folder it worked in.",
  "The moments you press start and stop.",
];

const NEVER = [
  "What you type. Not one keystroke.",
  "Pictures of your screen.",
  "The titles of your windows, files, or documents.",
  "Web addresses, or the pages you visit.",
  "Anything inside your files, messages, or email.",
];

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type RecordingPanelProps = {
  open: boolean;
  onClose: () => void;
  /// `undefined` when the host never answered `monitor_status`.
  status: MonitorStatus | undefined;
  /// Paste-it-yourself instructions from a `Connect` that could not merge,
  /// keyed by CLI source.
  hookSnippets: Readonly<Record<string, string>>;
  onTurnOnRecording: () => void;
  onConnectAgent: (source: string) => void;
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
  hookSnippets,
  onTurnOnRecording,
  onConnectAgent,
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
  const backlog = status === undefined ? 0 : status.segmentBacklog + status.agentBacklog;

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
          {state === "off" && (
            <button className="signal-button recording-fix" type="button" onClick={onTurnOnRecording}>
              Turn recording on
            </button>
          )}
        </div>

        <h3>What's switched on</h3>
        {status === undefined ? (
          <p className="subtle">Clock-In will show this as soon as it can reach the recorder on this computer.</p>
        ) : (
          <>
            <ul className="source-list">
              <li className="source-row">
                <span className="source-name">This computer</span>
                <span className={`source-state ${state === "on" ? "is-on" : "is-off"}`}>{COMPUTER_STATE[state]}</span>
              </li>
              {status.hooks.map((hook) => (
                <li key={hook.source} className="source-row">
                  <span className="source-name">{sourceLabel(hook.source)}</span>
                  {hook.detected ? (
                    <span className="source-state is-on">Connected</span>
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
                        Clock-In can't switch this one on by itself. Copy the lines below into that tool's own
                        settings file.
                      </p>
                      <pre className="hook-snippet">{hookSnippets[hook.source]}</pre>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p className="subtle">Nothing else is connected. Clock-In does not watch your web browser.</p>
          </>
        )}

        <h3>Clock-In writes down</h3>
        <ul className="record-list is-kept">
          {KEPT.map((line) => <li key={line}>{line}</li>)}
        </ul>

        <h3>Clock-In never writes down</h3>
        <ul className="record-list is-never">
          {NEVER.map((line) => <li key={line}>{line}</li>)}
        </ul>

        <h3>How Clock-In works</h3>
        <ol className="help-steps">
          <li>
            <strong>You press start.</strong> Those are your hours, and only you decide when they begin.
          </li>
          <li>
            <strong>Clock-In takes notes in the background.</strong> It never starts the timer for you. It only stops
            it if you lock the screen or stay away a long time, and it says so when it did.
          </li>
          <li>
            <strong>Your hours go to your workspace with the notes beside them.</strong> Hours the notes back up are
            marked as backed up. The rest still count as hours.
          </li>
          <li>
            <strong>You see what your team sees.</strong> The same hours, added up the same way, on the Clock-In
            website.
          </li>
        </ol>

        <p className="recording-foot">
          Notes are saved on this computer first, then sent to your workspace every few minutes.
          {status?.lastUploadAt != null && ` Last sent at ${clockTime(status.lastUploadAt)}.`}
          {backlog > 0 && ` ${backlog} ${backlog === 1 ? "note is" : "notes are"} still waiting to be sent.`}
        </p>
      </section>
    </div>
  );
};
