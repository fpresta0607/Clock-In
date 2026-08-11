import { useId } from "react";

const downloadBase = "https://github.com/fpresta0607/Clock-In/releases/download/unsigned-latest";

/**
 * The permanent links to the newest desktop installer.
 *
 * They are constants, not a GitHub API lookup, because
 * `.github/workflows/unsigned-test-installers.yml` republishes the
 * `unsigned-latest` prerelease under these exact file names on every run. The
 * tag never moves and the names never change, so the newest build is always
 * behind the same URL. That buys us a link with no request, no loading state,
 * no empty-href flash, and nothing to break when GitHub's 60-per-hour
 * anonymous rate limit is spent by whoever shares the visitor's IP.
 *
 * Workflow-run artifacts cannot be used here at all: GitHub requires
 * authentication to download one, and the people who need this button are
 * signed out.
 */
export const windowsInstallerUrl = `${downloadBase}/Clock-In-UNSIGNED-TEST-windows-x64-setup.exe`;
export const macInstallerUrl = `${downloadBase}/Clock-In-UNSIGNED-TEST-macos-aarch64.dmg`;

/// Said once, in one place, so the site cannot end up warning about the
/// SmartScreen prompt in one corner and staying quiet about it in another.
export const unsignedNote = "Unsigned test build. Windows will ask you to confirm.";

/**
 * Where the button is sitting, which is all that changes about it:
 *
 * - `floating` pins it to the top-right of the viewport, for the surfaces
 *   (sign-in, create-account) whose own layout is centred and owns no corner.
 * - `header` puts it in the dashboard masthead, which is already the top-right
 *   corner of that page.
 * - `hero` is the big centred call to action on the post-sign-up screen.
 */
type Placement = "floating" | "header" | "hero";

type DownloadInstallerProps = { placement?: Placement };

/**
 * The one component that hands out the desktop app. Every surface that offers
 * the installer renders this, so there is no second button quietly serving a
 * different build.
 */
export const DownloadInstaller = ({ placement = "header" }: DownloadInstallerProps) => {
  const noteId = useId();
  return (
    <div className={`download-corner is-${placement}`}>
      <a className="download-button" href={windowsInstallerUrl} rel="noreferrer" aria-describedby={noteId}>
        Download for Windows
      </a>
      <p className="download-note" id={noteId}>{unsignedNote}</p>
      {/* Secondary on purpose, and deliberately not called "download": Windows
          is the platform that matters, and the primary button should be the
          only thing in this corner that reads like one. */}
      <a className="download-secondary" href={macInstallerUrl} rel="noreferrer">
        Mac installer (Apple silicon)
      </a>
    </div>
  );
};

/**
 * The same installer as a plain link, for running prose. Kept beside the
 * button so both read from `windowsInstallerUrl`.
 */
export const InstallerLink = () => (
  <a className="link" href={windowsInstallerUrl} rel="noreferrer">
    Download for Windows
  </a>
);
