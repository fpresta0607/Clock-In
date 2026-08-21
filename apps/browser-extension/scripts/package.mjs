#!/usr/bin/env node
//! Packages the built extension for distribution: stages `dist-chrome/` and
//! `dist-firefox/` (built background.js plus the variant's manifest.json) and
//! writes store-ready zips under `release/`. Dependency-free on purpose: the
//! zip writer below is the store-only (uncompressed) subset of the format,
//! which every store and browser accepts.

import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const manifestVersion = require(join(root, "manifest.chrome.json")).version;

// CRC-32 (IEEE), table-driven.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a store-only zip (no compression) from `[{ name, bytes }]`. */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, nameBytes, bytes);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory signature
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(bytes.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([header, nameBytes]));
    offset += local.length + nameBytes.length + bytes.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

function stage(variant, manifestFile) {
  const dir = join(root, `dist-${variant}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, "dist", "background.js"), join(dir, "background.js"));
  copyFileSync(join(root, manifestFile), join(dir, "manifest.json"));
  return dir;
}

function pack(variant, manifestFile, zipName) {
  const dir = stage(variant, manifestFile);
  const entries = ["background.js", "manifest.json"].map((name) => ({
    name,
    bytes: readFileSync(join(dir, name)),
  }));
  const outDir = join(root, "release");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, zipName);
  writeFileSync(out, zip(entries));
  console.log(`wrote ${out}`);
}

pack("chrome", "manifest.chrome.json", `siqshift-extension-chrome-${manifestVersion}.zip`);
pack("firefox", "manifest.firefox.json", `siqshift-extension-firefox-${manifestVersion}.zip`);
