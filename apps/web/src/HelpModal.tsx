import { useEffect } from "react";

import { DownloadApp } from "./DownloadApp.js";

type HelpModalProps = { open: boolean; onClose: () => void };

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
            <strong>Install the desktop app.</strong> This dashboard only shows hours — the app
            records them. <DownloadApp />
          </li>
          <li>
            <strong>Sign in there with this same account.</strong> Same email and password; your
            hours land in this workspace automatically.
          </li>
          <li>
            <strong>Pick a project and press start.</strong> The timer runs in the background while
            you work. Press stop when you're done and the session syncs here on its own.
          </li>
          <li>
            <strong>This dashboard adds it up.</strong> The leaderboard ranks the team, recent
            sessions list the detail, and Export CSV downloads whatever range you pick.
          </li>
        </ol>
      </section>
    </div>
  );
};
