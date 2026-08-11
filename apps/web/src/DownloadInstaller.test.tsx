import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  DownloadInstaller,
  InstallerLink,
  macInstallerUrl,
  unsignedNote,
  windowsInstallerUrl,
} from "./DownloadInstaller.js";

/**
 * The contract under test is the release the workflow publishes, which is a
 * machine-consumed declarative artifact: `unsigned-test-installers.yml` is read
 * by GitHub Actions, and its `publish` job decides the one tag and the two file
 * names that make up the URLs this app hard-codes. Nothing else checks that the
 * two sides agree. The rendered-href tests below compare the constant to
 * itself, so a rename on either side alone would leave every test green and
 * 404 the Download button in production.
 *
 * So the workflow is parsed into a model and asked what it actually publishes,
 * rather than searched for strings.
 */
const workflowPath = ((relative: string): string => {
  // Walked up from the vitest root rather than `import.meta.url`, which Vite
  // rewrites to a non-file URL, and rather than a fixed number of `..` hops.
  for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find ${relative} above ${process.cwd()}`);
})(".github/workflows/unsigned-test-installers.yml");

type Job = { env?: Record<string, string>; steps?: { name?: string; run?: string }[] };
type PublishedRelease = { tag: string; assetNames: readonly string[]; stagingDir: string; uploadGlob: string };

const publishedRelease = (): PublishedRelease => {
  const workflow = parseYaml(readFileSync(workflowPath, "utf8")) as { jobs?: Record<string, Job> };
  const publish = workflow.jobs?.publish;
  expect(publish, "the workflow has no `publish` job").toBeDefined();
  const scriptOf = (name: string): string =>
    publish?.steps?.find((step) => step.name === name)?.run ?? "";

  // The staging step names every asset exactly once, as `take <pattern> <name>`,
  // and copies it into the directory the upload step then uploads.
  const staging = scriptOf("Stage the release assets under their permanent names");
  const assetNames = [...staging.matchAll(/^\s*take\s+'[^']*'\s+(\S+)\s*$/gm)]
    .flatMap(([, name]) => (name === undefined ? [] : [name]));
  const [, stagingDir = ""] = /cp "\$found" "([^/"]+)\//.exec(staging) ?? [];
  const [, uploadGlob = ""] = /gh release upload "\$TAG" (\S+)/.exec(scriptOf("Publish the prerelease")) ?? [];

  return { tag: publish?.env?.TAG ?? "", assetNames, stagingDir, uploadGlob };
};

/** `https://…/releases/download/<tag>/<asset>` split back into its two halves. */
const releaseRefOf = (url: string): { tag: string; assetName: string } => {
  const segments = new URL(url).pathname.split("/");
  return { tag: segments.at(-2) ?? "", assetName: segments.at(-1) ?? "" };
};

describe("installer URLs", () => {
  it("name the tag and the assets the workflow's publish job actually publishes", () => {
    const release = publishedRelease();

    // Fail loudly rather than vacuously if the workflow is restructured so that
    // nothing can be derived from it: an empty model would satisfy nothing.
    expect(release.tag).not.toBe("");
    expect(release.assetNames.length).toBeGreaterThanOrEqual(2);
    // What is staged is what is uploaded, so a staged name is a published name.
    expect(release.uploadGlob).toBe(`${release.stagingDir}/*`);

    for (const url of [windowsInstallerUrl, macInstallerUrl]) {
      const { tag, assetName } = releaseRefOf(url);
      expect(tag).toBe(release.tag);
      expect(release.assetNames).toContain(assetName);
    }
  });
});

describe("DownloadInstaller in the masthead", () => {
  const openMenu = async () => {
    const person = userEvent.setup();
    render(<DownloadInstaller />);
    await person.click(screen.getByRole("button", { name: /download/i }));
    return person;
  };

  it("is one control, with nothing else of its own on screen beside it", () => {
    const { container } = render(<DownloadInstaller />);

    // The whole point of the rework: the header row holds a single element from
    // this component, not a button plus a wrapped note plus a stacked link.
    const trigger = screen.getByRole("button", { name: /download/i });
    expect(container.querySelector(".download-menu")?.children).toHaveLength(1);
    expect(trigger).toHaveClass("ghost");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toBe("Download");
  });

  it("warns about the unsigned build before anything is downloaded", async () => {
    // Discoverable without opening anything…
    render(<DownloadInstaller />);
    expect(screen.getByRole("button", { name: /download/i })).toHaveAttribute("title", unsignedNote);

    // …and stated in the panel, tied to both installers.
    const person = userEvent.setup();
    await person.click(screen.getByRole("button", { name: /download/i }));
    for (const name of ["Download for Windows", "Mac installer (Apple silicon)"]) {
      expect(screen.getByRole("link", { name })).toHaveAccessibleDescription(unsignedNote);
    }
  });

  it("offers Windows as the primary download with the newest build's URL", async () => {
    await openMenu();

    const windows = screen.getByRole("link", { name: "Download for Windows" });
    expect(windows).toHaveAttribute("href", windowsInstallerUrl);
    expect(windows).toHaveClass("is-primary");
  });

  it("carries the Mac build in the same panel, secondary to Windows", async () => {
    await openMenu();

    const mac = screen.getByRole("link", { name: "Mac installer (Apple silicon)" });
    expect(mac).toHaveAttribute("href", macInstallerUrl);
    expect(mac).not.toHaveClass("is-primary");
    expect(screen.getAllByRole("link", { name: /download/i })).toHaveLength(1);
  });

  it("says whether the panel is open, and closes again", async () => {
    const person = await openMenu();
    const trigger = screen.getByRole("button", { name: /download/i });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", screen.getByRole("link", { name: "Download for Windows" }).closest(".download-panel")?.id);

    await person.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Download for Windows" })).not.toBeInTheDocument();
  });

  it("closes when the click lands anywhere else", async () => {
    const person = await openMenu();

    await person.click(document.body);

    expect(screen.getByRole("button", { name: /download/i })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("DownloadInstaller in the welcome hero", () => {
  it("still says everything at once, because that page is the download", () => {
    const { container } = render(<DownloadInstaller placement="hero" />);

    expect(container.querySelector(".download-corner")).toHaveClass("is-hero");
    const windows = screen.getByRole("link", { name: "Download for Windows" });
    expect(windows).toHaveAttribute("href", windowsInstallerUrl);
    expect(windows).toHaveClass("download-button");
    expect(windows).toHaveAccessibleDescription(unsignedNote);
    expect(screen.getByRole("link", { name: "Mac installer (Apple silicon)" }))
      .toHaveAttribute("href", macInstallerUrl);
  });
});

describe("InstallerLink", () => {
  it("hands out the same installer as the button", () => {
    render(<InstallerLink />);

    expect(screen.getByRole("link", { name: "Download for Windows" }))
      .toHaveAttribute("href", windowsInstallerUrl);
  });
});
