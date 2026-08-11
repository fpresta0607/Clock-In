import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DownloadInstaller,
  InstallerLink,
  macInstallerUrl,
  windowsInstallerUrl,
} from "./DownloadInstaller.js";

// The workflow's half of the contract. `unsigned-test-installers.yml` force
// updates this tag and clobbers these exact asset names on every run, which is
// the only reason the site can hard-code a URL. If either side is renamed
// without the other, the button 404s, so both sides are pinned here.
const tag = "https://github.com/fpresta0607/Clock-In/releases/download/unsigned-latest";

describe("installer URLs", () => {
  it("point at the fixed tag and the fixed asset names the workflow publishes", () => {
    expect(windowsInstallerUrl).toBe(`${tag}/Clock-In-UNSIGNED-TEST-windows-x64-setup.exe`);
    expect(macInstallerUrl).toBe(`${tag}/Clock-In-UNSIGNED-TEST-macos-aarch64.dmg`);
  });

  it("carry nothing that changes between runs", () => {
    // A run id, a run number, or a version in the path is the failure this
    // whole design exists to prevent: it works once and rots on the next build.
    for (const url of [windowsInstallerUrl, macInstallerUrl]) {
      expect(url).not.toMatch(/\d+\.\d+\.\d+/);
      expect(url).not.toMatch(/artifacts?\//);
    }
  });
});

describe("DownloadInstaller", () => {
  it("offers Windows as the primary download with the newest build's URL", () => {
    render(<DownloadInstaller />);

    const windows = screen.getByRole("link", { name: "Download for Windows" });
    expect(windows).toHaveAttribute("href", windowsInstallerUrl);
    expect(windows).toHaveClass("download-button");
  });

  it("says out loud that the build is unsigned, and ties it to the button", () => {
    render(<DownloadInstaller />);

    const windows = screen.getByRole("link", { name: "Download for Windows" });
    expect(windows).toHaveAccessibleDescription("Unsigned test build. Windows will ask you to confirm.");
  });

  it("keeps macOS secondary so only one link in the corner reads as the download", () => {
    render(<DownloadInstaller />);

    expect(screen.getByRole("link", { name: "Mac installer (Apple silicon)" }))
      .toHaveAttribute("href", macInstallerUrl);
    expect(screen.getAllByRole("link", { name: /download/i })).toHaveLength(1);
  });

  it("places itself where the surface asked", () => {
    const { container, rerender } = render(<DownloadInstaller placement="floating" />);
    expect(container.querySelector(".download-corner")).toHaveClass("is-floating");

    rerender(<DownloadInstaller placement="hero" />);
    expect(container.querySelector(".download-corner")).toHaveClass("is-hero");

    rerender(<DownloadInstaller />);
    expect(container.querySelector(".download-corner")).toHaveClass("is-header");
  });
});

describe("InstallerLink", () => {
  it("hands out the same installer as the button", () => {
    render(<InstallerLink />);

    expect(screen.getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });
});
