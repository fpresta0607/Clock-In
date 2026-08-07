import { useEffect, useState } from "react";

const releasesPage = "https://github.com/fpresta0607/Clock-In/releases/latest";
const latestReleaseApi = "https://api.github.com/repos/fpresta0607/Clock-In/releases/latest";

type Platform = "windows" | "macos";

type ReleaseAsset = { name: string; browser_download_url: string };

export const detectPlatform = (userAgent: string): Platform | undefined => {
  if (/windows/i.test(userAgent)) return "windows";
  if (/macintosh|mac os/i.test(userAgent)) return "macos";
  return undefined;
};

export const assetFor = (
  assets: readonly ReleaseAsset[],
  platform: Platform | undefined,
): ReleaseAsset | undefined => {
  if (platform === "windows") {
    return assets.find((asset) => asset.name.endsWith(".msi")) ?? assets.find((asset) => asset.name.endsWith(".exe"));
  }
  if (platform === "macos") {
    return assets.find((asset) => asset.name.endsWith(".dmg"));
  }
  return undefined;
};

type DownloadAppProps = { className?: string };

/**
 * Links to the newest desktop installer from GitHub Releases, guessing the
 * visitor's platform. Falls back to the releases page when there is no
 * published release yet or the lookup fails.
 */
export const DownloadApp = ({ className = "ghost" }: DownloadAppProps) => {
  const [href, setHref] = useState(releasesPage);
  const [platform, setPlatform] = useState<Platform | undefined>();

  useEffect(() => {
    const detected = detectPlatform(window.navigator.userAgent);
    setPlatform(detected);
    let cancelled = false;
    fetch(latestReleaseApi)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((release: { assets?: ReleaseAsset[] } | undefined) => {
        if (cancelled) return;
        const asset = assetFor(release?.assets ?? [], detected);
        if (asset !== undefined) setHref(asset.browser_download_url);
      })
      .catch(() => {
        // Offline or rate-limited: the releases-page fallback is fine.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label =
    platform === "windows" ? "Download for Windows" : platform === "macos" ? "Download for Mac" : "Download the app";

  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
};
