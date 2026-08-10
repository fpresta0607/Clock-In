import { useEffect } from "react";

import { DownloadApp } from "./DownloadApp.js";

type HelpModalProps = { open: boolean; onClose: () => void };

/// Kept word for word beside the desktop app's "what's recorded" panel: the
/// dashboard and the app must describe the same product to the same person.
const KEPT = [
  "Whether you were using your computer, away from it, or had the screen locked.",
  "The name of the app in front of you, like “chrome” or “code”. The name only.",
  "When an AI coding tool starts and finishes, and which folder it worked in.",
];

const NEVER = [
  "What you type. Not one keystroke.",
  "Pictures of your screen.",
  "The titles of your windows, files, or documents.",
  "Web addresses, or the pages you visit.",
  "Anything inside your files, messages, or email.",
];

/**
 * "How Clock-In works" dialog for the dashboard. Closes on Escape, on the
 * overlay, or on its Close button; the dashboard only renders it while open.
 */
export const HelpModal = ({ open, onClose }: HelpModalProps) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        className="card modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="card-head">
          <h2 id="help-title">How Clock-In works</h2>
          <button className="ghost" type="button" onClick={onClose} autoFocus>Close</button>
        </div>
        <ol className="help-steps">
          <li>
            <strong>Install the desktop app.</strong> This dashboard only shows hours; the app
            records them. <DownloadApp />
          </li>
          <li>
            <strong>Sign in there with this same account.</strong> Same email and password; your
            hours land in this workspace automatically.
          </li>
          <li>
            <strong>Then leave it alone.</strong> There is no timer to start and none to forget.
            While the app is open, it writes down the hours you spend at that computer, and closes
            a stretch of work when you go quiet, lock the screen, or shut down.
          </li>
          <li>
            <strong>Hours are filed under a project.</strong> If an AI coding tool is working in a
            folder matched to a project, they go there; if someone picks a project, they go there.
            Anything else lands in that person's default project, and shows up here as
            unattributed.
          </li>
          <li>
            <strong>This dashboard adds it up.</strong> The leaderboard ranks the team and recent
            sessions list the detail, for whatever range you pick.
          </li>
        </ol>

        <h3 className="help-heading">Clock-In writes down</h3>
        <ul className="record-list is-kept">
          {KEPT.map((line) => <li key={line}>{line}</li>)}
        </ul>

        <h3 className="help-heading">Clock-In never writes down</h3>
        <ul className="record-list is-never">
          {NEVER.map((line) => <li key={line}>{line}</li>)}
        </ul>

        <p className="help-foot">
          Everyone sees the same numbers. The app shows each person their own hours, added up
          exactly the way this dashboard adds up the team's, with the same split between hours filed
          under a project on purpose and hours that fell to the default. Open
          {" "}<strong>What's recorded</strong> in the app to see what it is keeping on your computer
          right now, and to switch all of it off.
        </p>
      </section>
    </div>
  );
};
