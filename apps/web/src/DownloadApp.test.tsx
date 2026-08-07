import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assetFor, detectPlatform, DownloadApp } from "./DownloadApp.js";

const windowsUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const macUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

const assets = [
  { name: "Clock-In_0.1.0_x64_en-US.msi", browser_download_url: "https://example.com/clock-in.msi" },
  { name: "Clock-In_0.1.0_x64-setup.exe", browser_download_url: "https://example.com/clock-in-setup.exe" },
  { name: "Clock-In_0.1.0_aarch64.dmg", browser_download_url: "https://example.com/clock-in.dmg" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectPlatform", () => {
  it("recognizes Windows and macOS user agents", () => {
    expect(detectPlatform(windowsUa)).toBe("windows");
    expect(detectPlatform(macUa)).toBe("macos");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBeUndefined();
  });
});

describe("assetFor", () => {
  it("prefers the MSI on Windows and the DMG on macOS", () => {
    expect(assetFor(assets, "windows")?.browser_download_url).toBe("https://example.com/clock-in.msi");
    expect(assetFor(assets, "macos")?.browser_download_url).toBe("https://example.com/clock-in.dmg");
  });

  it("falls back to the NSIS exe when no MSI exists, and to nothing without a platform", () => {
    const withoutMsi = assets.filter((asset) => !asset.name.endsWith(".msi"));
    expect(assetFor(withoutMsi, "windows")?.browser_download_url).toBe("https://example.com/clock-in-setup.exe");
    expect(assetFor(assets, undefined)).toBeUndefined();
  });
});

describe("DownloadApp", () => {
  it("points at the platform installer once the latest release loads", async () => {
    Object.defineProperty(window.navigator, "userAgent", { value: macUa, configurable: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ assets }),
    }));
    render(<DownloadApp />);

    const link = screen.getByRole("link", { name: /download/i });
    await waitFor(() => expect(link).toHaveAttribute("href", "https://example.com/clock-in.dmg"));
  });

  it("falls back to the releases page when the lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<DownloadApp />);

    const link = screen.getByRole("link", { name: /download/i });
    await waitFor(() => expect(link).toHaveAttribute("href", "https://github.com/fpresta0607/Clock-In/releases/latest"));
  });
});
