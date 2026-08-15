import { useEffect } from "react";

import { InstallerLink } from "./DownloadInstaller.js";

type HelpModalProps = { open: boolean; onClose: () => void };

/// Kept word for word beside the desktop app's "what's recorded" panel: the
/// dashboard and the app must describe the same product to the same person.
const KEPT = [
  "Whether you were using your computer, away from it, or had the screen locked.",
  "The name of the app in front of you, like “chrome” or “code”. The name only.",
  "When an AI coding tool starts and finishes, and which folder it worked in.",
  "For AI coding shifts in a git repo: the branch name, and the title, commit id, and repository folder of each commit made during the shift, checked later on this machine, read-only. The repository folder is shown only to you and your workspace's admins.",
];

const NEVER = [
  "What you type. Not one keystroke.",
  "Pictures of your screen.",
  "The titles of your windows, files, or documents. Commit titles are the one exception, listed above.",
  "Web addresses, or the pages you visit.",
  "Anything inside your files, messages, or email.",
  "Anything you type into a form, chat, or document.",
  "Clock-In never reaches inside or controls your other apps.",
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
            records them. <InstallerLink />
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

        <h3 className="help-heading">How time is counted</h3>
        {/* Word-for-word the desktop app's "What's recorded" panel - one set
            of rules, told once, so no surface can contradict another. */}
        <ul className="record-list">
          <li>Your hours are wall-clock time you were actually at the machine. They can never exceed real elapsed time.</li>
          <li>Human work is the time you worked with no agent running - the share you verified yourself.</li>
          <li>The 1, 2, and 3+ agent splits are your agent-assisted share - still your hours, split by how many agents ran beside you at once.</li>
          <li>Agent time is the summed runtime of every AI tool working for you. Three agents in parallel for an hour is 3h of agent time inside 1h of yours - that ratio is your leverage, never extra hours.</li>
          <li>An agent still working while you step away keeps counting as agent time, but never as your hours.</li>
          <li>The leaderboard ranks by your hours. Agent time and leverage sit beside them, answering a different question: how much work you got out of the tools.</li>
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
