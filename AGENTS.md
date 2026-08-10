# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Verifying the Tauri crate locally

`apps/desktop/src-tauri` links against system webview and tray libraries, so *any* cargo
command that builds it — `check`, `clippy`, `test`, not just a Tauri build — fails until those
are installed. On Debian/Ubuntu:

```bash
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libappindicator3-dev librsvg2-dev patchelf libssl-dev
```

Run the same three commands CI's `rust` job runs (`.github/workflows/ci.yml`), all with
`--manifest-path apps/desktop/src-tauri/Cargo.toml`: `cargo fmt --check`, `cargo clippy
--all-targets -- -D warnings`, and `cargo test`. Only `fmt` works without the packages above,
and the first build of the dependency tree takes several minutes.

Declare a module `pub mod` when nothing in `lib.rs` consumes all of its API, or `-D warnings`
fails the lib target on `dead_code` — that is why `quota` and `spool` are public.

## Adding a Tauri command

A new command touches four places, and missing any one of them fails at runtime rather than at
compile time: the `#[tauri::command]` function, its entry in `tauri::generate_handler![…]`, a
decoder plus `TimerBridge` method in `apps/desktop/src/bridge.ts`, and the `bridgeFor` test
double in `apps/desktop/src/App.test.tsx`. Payload structs use
`#[serde(rename_all = "camelCase")]`; the bridge decoders are strict on purpose and reject a
shape the UI could not render.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
