import { useEffect, useId, useRef, useState } from "react";

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
 * Where the button is sitting, which decides how loud it is allowed to be:
 *
 * - `header` is the dashboard masthead, a single row of small controls it has
 *   to sit inside without breaking. There it is one compact pill matching its
 *   neighbours, and everything else it has to say lives behind that pill.
 * - `hero` is the post-sign-up screen, whose whole job is handing out the app,
 *   so there the button is the page and says all of it at once.
 *
 * There is deliberately no floating variant: a download control pinned over a
 * sign-in card is nobody's next step on that page.
 */
type Placement = "header" | "hero";

type DownloadInstallerProps = { placement?: Placement };

const DownloadIcon = () => (
  <svg className="download-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      d="M8 1.75v8.5m0 0L4.75 7M8 10.25L11.25 7M2.5 12.75h11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The masthead pill. One control the height of the Sign out button beside it,
 * opening everything that used to be stacked underneath it in the header: the
 * unsigned-build warning and the Mac build.
 */
const HeaderMenu = () => {
  const panelId = useId();
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="download-menu" ref={root}>
      <button
        className="ghost download-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        // The SmartScreen warning is still on the control itself, not only
        // inside the panel: a visitor who never opens the panel can still meet
        // it on hover, and it is what the button is described by either way.
        title={unsignedNote}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <DownloadIcon />
        Download
        <span className="download-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="card glass download-panel" id={panelId}>
          <p className="download-note" id={noteId}>{unsignedNote}</p>
          <a className="download-choice is-primary" href={windowsInstallerUrl} rel="noreferrer" aria-describedby={noteId}>
            Download for Windows
          </a>
          {/* Secondary on purpose, and deliberately not called "download":
              Windows is the platform that matters, and only one link in here
              should read like the download. */}
          <a className="download-choice" href={macInstallerUrl} rel="noreferrer" aria-describedby={noteId}>
            Mac installer (Apple silicon)
          </a>
        </div>
      )}
    </div>
  );
};

/**
 * The one component that hands out the desktop app. Every surface that offers
 * the installer renders this, so there is no second button quietly serving a
 * different build.
 */
export const DownloadInstaller = ({ placement = "header" }: DownloadInstallerProps) => {
  const noteId = useId();
  if (placement === "header") return <HeaderMenu />;
  return (
    <div className="download-corner is-hero">
      <a className="download-button" href={windowsInstallerUrl} rel="noreferrer" aria-describedby={noteId}>
        Download for Windows
      </a>
      <p className="download-note" id={noteId}>{unsignedNote}</p>
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
