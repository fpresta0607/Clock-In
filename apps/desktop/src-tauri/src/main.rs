// Keeps Windows from opening a console window behind the app. Unconditional on
// purpose: this was gated on `not(debug_assertions)`, but the installer people
// actually download is a `tauri build --debug` bundle
// (`.github/workflows/unsigned-test-installers.yml`), so the gate compiled the
// attribute out of exactly the build that ships and every install opened a
// terminal behind the window.
//
// Nothing is lost for development: the subsystem only decides whether Windows
// *allocates* a console, so `tauri dev`, which pipes the child's stdout, still
// shows the host's output.
#![windows_subsystem = "windows"]

fn main() {
    clock_in_desktop_lib::run()
}
