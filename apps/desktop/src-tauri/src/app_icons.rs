//! Real OS icons for the executables the usage meter lists.
//!
//! The webview cannot read another program's icon; only the host can ask the
//! shell. A name resolves to an executable path by preferring a running
//! process — a live match is the very binary being measured — and falling
//! back to the registry's App Paths entries, so an app that is not running
//! right now still gets its icon. Every failure is per name: the batch
//! always answers, with `None` where nothing could be resolved.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::monitor::lock;

/// Resolved icons, kept for the process lifetime. Extraction walks the
/// process table, the registry, and disk; an executable's icon does not
/// change while Clock-In runs, so each name is paid for once.
static ICON_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

/// The most names one call resolves. The UI asks for at most a screenful of
/// rows; anything past this answers None instead of walking the process
/// table on an attacker-chosen scale.
const MAX_BATCH: usize = 64;

/// The longest plausible executable name. Longer strings answer None without
/// being probed or cached, so they cannot grow the cache unboundedly.
const MAX_NAME_LENGTH: usize = 64;

/// PNG data URIs (`data:image/png;base64,...`) for each requested process
/// name, keyed exactly as asked. A name whose icon cannot be resolved maps
/// to `None`; the batch itself never fails.
pub fn lookup(process_names: Vec<String>) -> HashMap<String, Option<String>> {
    let mut icons = HashMap::with_capacity(process_names.len().min(MAX_BATCH));
    for (index, name) in process_names.into_iter().enumerate() {
        let icon = match normalize(&name) {
            Some(normalized) if index < MAX_BATCH => cached_icon(&normalized),
            _ => None,
        };
        icons.insert(name, icon);
    }
    icons
}

/// One process running right now: its executable name and when it started.
pub struct RunningProcess {
    pub process_name: String,
    pub process_id: u32,
    /// Unix seconds, or `None` when the OS refused the handle.
    pub started_at: Option<u64>,
}

/// Every process on this machine. Used to find agents that work without ever
/// owning a window, which no foreground sample can see.
pub fn running_processes() -> Vec<RunningProcess> {
    platform::running_processes()
}

fn cached_icon(normalized: &str) -> Option<String> {
    let cache = ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(known) = lock(cache).get(normalized) {
        return known.clone();
    }
    // Extracted outside the lock: the probe hits disk and the registry, and
    // an occasional duplicate probe costs less than serializing every caller.
    let icon = platform::icon_data_uri(normalized);
    lock(cache)
        .entry(normalized.to_string())
        .or_insert(icon)
        .clone()
}

/// One canonical spelling — lowercase with an `.exe` suffix — keys the cache
/// and every OS-side comparison, or None for anything that is not a bare
/// executable name: path separators and dot-dot would otherwise flow into a
/// registry subkey path, and oversized strings would bloat the lifetime cache.
fn normalize(name: &str) -> Option<String> {
    let mut normalized = name.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > MAX_NAME_LENGTH
        || normalized.contains(['\\', '/', ':'])
        || normalized.contains("..")
    {
        return None;
    }
    if !normalized.ends_with(".exe") {
        normalized.push_str(".exe");
    }
    Some(normalized)
}

#[cfg(windows)]
mod platform {
    //! Shell-icon extraction, manually verified like the monitor's Win32
    //! code: resolve a path, ask `SHGetFileInfoW` for the large icon, read
    //! its pixels back through GDI, and encode a PNG.

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_SUCCESS, FILETIME, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    };
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// An icon's pixels as RGBA rows, top to bottom.
    struct Pixels {
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    }

    /// The large shell icon of `name` (normalized: lowercase, `.exe`) as a
    /// PNG data URI, or `None` at the first unresolvable step.
    pub fn icon_data_uri(name: &str) -> Option<String> {
        if name.is_empty() {
            return None;
        }
        let path = running_process_path(name)
            .or_else(|| app_paths_entry(name))
            .or_else(|| windows_shipped_path(name))?;
        let pixels = extract_pixels(&path)?;
        let png = encode_png(&pixels)?;
        Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
    }

    /// The full image path of a running process whose executable name matches
    /// `name`. Preferred over the registry so the icon shown is the binary
    /// the meter actually measured.
    fn running_process_path(name: &str) -> Option<String> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return None;
            }
            let result = (|| {
                let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                entry.dwSize = std::mem::size_of_val(&entry) as u32;
                if Process32FirstW(snapshot, &mut entry) == 0 {
                    return None;
                }
                loop {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let exe_name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                    if exe_name.eq_ignore_ascii_case(name) {
                        // An elevated process refuses the query handle; keep
                        // scanning — another instance may allow it.
                        if let Some(path) = process_image_path(entry.th32ProcessID) {
                            return Some(path);
                        }
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        return None;
                    }
                }
            })();
            CloseHandle(snapshot);
            result
        }
    }

    /// Every running process, with its start time where the OS allows it.
    /// An elevated process refuses the handle; the name is still true, so the
    /// entry stays and only its start time is unknown.
    pub fn running_processes() -> Vec<super::RunningProcess> {
        let mut processes = Vec::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return processes;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len());
                    processes.push(super::RunningProcess {
                        process_name: String::from_utf16_lossy(&entry.szExeFile[..end]),
                        process_id: entry.th32ProcessID,
                        started_at: process_started_at(entry.th32ProcessID),
                    });
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
        processes
    }

    /// When a process started, in unix seconds. `GetProcessTimes` reports
    /// 100-nanosecond ticks since 1601, so the epoch is shifted here.
    fn process_started_at(process_id: u32) -> Option<u64> {
        const TICKS_PER_SECOND: u64 = 10_000_000;
        /// Seconds between the Win32 epoch (1601-01-01) and the unix one.
        const EPOCH_DIFFERENCE_SECONDS: u64 = 11_644_473_600;
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return None;
            }
            let mut created = std::mem::zeroed::<FILETIME>();
            let mut exited = std::mem::zeroed::<FILETIME>();
            let mut kernel = std::mem::zeroed::<FILETIME>();
            let mut user = std::mem::zeroed::<FILETIME>();
            let ok = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
            CloseHandle(process);
            if ok == 0 {
                return None;
            }
            let ticks = ((created.dwHighDateTime as u64) << 32) | u64::from(created.dwLowDateTime);
            (ticks / TICKS_PER_SECOND).checked_sub(EPOCH_DIFFERENCE_SECONDS)
        }
    }

    fn process_image_path(process_id: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return None;
            }
            let mut buffer = [0u16; 1024];
            let mut length = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
            CloseHandle(process);
            if ok == 0 || length == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buffer[..length as usize]))
        }
    }

    /// Where Windows keeps the tools it ships. Task Manager and friends run
    /// elevated, so the process handle is refused, and they carry no App Paths
    /// entry either - without this they would draw a blank tile despite the
    /// icon sitting in plain sight on disk. `name` is already known to be a
    /// bare file name, so neither join can escape these directories.
    fn windows_shipped_path(name: &str) -> Option<String> {
        let root = std::env::var("SystemRoot").ok()?;
        let root = std::path::Path::new(&root);
        for directory in ["System32", "SysWOW64", ""] {
            let candidate = root.join(directory).join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }

    /// The install path advertised under
    /// `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<name>`.
    /// `RegGetValueW` expands REG_EXPAND_SZ values itself; installers
    /// sometimes quote the path, so surrounding quotes are stripped.
    /// Per-user installs register under HKCU, machine-wide ones under HKLM.
    /// VS Code and Chrome are usually per-user, so reading only HKLM left
    /// their rows iconless whenever the app was not running at that moment.
    fn app_paths_entry(name: &str) -> Option<String> {
        app_paths_entry_in(HKEY_CURRENT_USER, name)
            .or_else(|| app_paths_entry_in(HKEY_LOCAL_MACHINE, name))
    }

    fn app_paths_entry_in(root: HKEY, name: &str) -> Option<String> {
        let subkey: Vec<u16> =
            format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{name}\0")
                .encode_utf16()
                .collect();
        let mut buffer = [0u16; 1024];
        let mut byte_count = (buffer.len() * std::mem::size_of::<u16>()) as u32;
        let status = unsafe {
            RegGetValueW(
                root,
                subkey.as_ptr(),
                // The key's default value holds the executable path.
                std::ptr::null(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut byte_count,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = (byte_count as usize / std::mem::size_of::<u16>()).min(buffer.len());
        let value = String::from_utf16_lossy(&buffer[..units]);
        let path = value.trim_end_matches('\0').trim().trim_matches('"');
        (!path.is_empty()).then(|| path.to_string())
    }

    /// `SHGetFileInfoW` is documented to require COM on the calling thread,
    /// and this code runs on blocking-pool threads that never initialized it.
    /// S_OK and S_FALSE each take a reference this guard must give back; a
    /// failed init (someone else's incompatible mode) is left untouched.
    struct ComGuard {
        owns_reference: bool,
    }

    impl ComGuard {
        fn new() -> Self {
            let result =
                unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
            Self {
                owns_reference: result >= 0,
            }
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owns_reference {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn extract_pixels(path: &str) -> Option<Pixels> {
        let _com = ComGuard::new();
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let listed = unsafe {
            SHGetFileInfoW(
                wide.as_ptr(),
                0,
                &mut info,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if listed == 0 || info.hIcon.is_null() {
            return None;
        }
        let pixels = icon_pixels(info.hIcon);
        unsafe { DestroyIcon(info.hIcon) };
        pixels
    }

    /// Reads an icon's pixels. `GetIconInfo` hands over two bitmaps that are
    /// the caller's to free, which is why the conversion is split out: the
    /// deletes must run on every exit path after a successful `GetIconInfo`.
    fn icon_pixels(icon: HICON) -> Option<Pixels> {
        let mut info: ICONINFO = unsafe { std::mem::zeroed() };
        if unsafe { GetIconInfo(icon, &mut info) } == 0 {
            return None;
        }
        let pixels = color_bitmap_pixels(&info);
        unsafe {
            if !info.hbmColor.is_null() {
                DeleteObject(info.hbmColor);
            }
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask);
            }
        }
        pixels
    }

    fn color_bitmap_pixels(info: &ICONINFO) -> Option<Pixels> {
        // No color plane means a 1bpp icon. Modern executables never ship
        // one, and rendering it would look broken next to real icons.
        if info.hbmColor.is_null() {
            return None;
        }
        let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
        let copied = unsafe {
            GetObjectW(
                info.hbmColor,
                std::mem::size_of::<BITMAP>() as i32,
                (&mut bitmap as *mut BITMAP).cast(),
            )
        };
        if copied == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
            return None;
        }
        let (width, height) = (bitmap.bmWidth, bitmap.bmHeight);
        let mut bgra = bitmap_bits_32bpp(info.hbmColor, width, height)?;
        // A color plane drawn without an alpha channel reads back all-zero
        // alpha; its shape lives in the AND mask, where white marks the
        // transparent pixels. With no readable mask either, fully opaque
        // beats fully invisible.
        if bgra.chunks_exact(4).all(|pixel| pixel[3] == 0) {
            let mask = bitmap_bits_32bpp(info.hbmMask, width, height);
            for (index, pixel) in bgra.chunks_exact_mut(4).enumerate() {
                pixel[3] = match &mask {
                    Some(mask) if mask[index * 4] != 0 => 0x00,
                    _ => 0xFF,
                };
            }
        }
        // GDI hands out BGRA; PNG wants RGBA.
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        Some(Pixels {
            width: width as u32,
            height: height as u32,
            rgba: bgra,
        })
    }

    /// The bitmap's pixels as 32bpp BGRA via `GetDIBits`. The negative height
    /// asks GDI for top-down rows, so no flip is needed afterwards.
    fn bitmap_bits_32bpp(bitmap: HBITMAP, width: i32, height: i32) -> Option<Vec<u8>> {
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return None;
            }
            let copied = GetDIBits(
                screen,
                bitmap,
                0,
                height as u32,
                pixels.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            );
            ReleaseDC(std::ptr::null_mut(), screen);
            (copied == height).then_some(pixels)
        }
    }

    fn encode_png(pixels: &Pixels) -> Option<Vec<u8>> {
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, pixels.width, pixels.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&pixels.rgba).ok()?;
        writer.finish().ok()?;
        Some(png)
    }
}

#[cfg(not(windows))]
mod platform {
    //! Icon extraction is a Win32 shell affair. Other platforms answer `None`
    //! for every name and the UI keeps its fallback glyph.

    pub fn icon_data_uri(_name: &str) -> Option<String> {
        None
    }

    pub fn running_processes() -> Vec<super::RunningProcess> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_normalize_case_insensitively_and_grow_an_exe_suffix() {
        assert_eq!(normalize("chrome.exe").as_deref(), Some("chrome.exe"));
        assert_eq!(normalize("CHROME.EXE").as_deref(), Some("chrome.exe"));
        assert_eq!(normalize("Code").as_deref(), Some("code.exe"));
        assert_eq!(normalize(" Code.EXE ").as_deref(), Some("code.exe"));
    }

    #[test]
    fn names_that_are_not_bare_executables_are_refused() {
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize("..\\Policies\\Explorer"), None);
        assert_eq!(normalize("tools/thing.exe"), None);
        assert_eq!(normalize("C:autorun.exe"), None);
        assert_eq!(normalize(&"x".repeat(65)), None);
    }

    /// Everything past the batch cap answers None without a probe, so one
    /// call cannot walk the process table at an attacker-chosen scale.
    #[test]
    fn oversized_batches_answer_none_past_the_cap() {
        let names: Vec<String> = (0..MAX_BATCH + 3)
            .map(|index| format!("not-a-real-app-{index}"))
            .collect();

        let icons = lookup(names.clone());

        assert_eq!(icons.len(), MAX_BATCH + 3);
        assert_eq!(icons[&names[MAX_BATCH]], None);
        assert_eq!(icons[&names[MAX_BATCH + 2]], None);
    }

    /// The batch contract: every requested name gets an entry under exactly
    /// the key that was sent, and unresolvable names yield `None` instead of
    /// failing the call.
    #[test]
    fn every_requested_name_gets_an_answer_keyed_exactly_as_it_was_asked() {
        let names = vec![String::new(), "Definitely-Not-A-Real-App-98765".to_string()];

        let icons = lookup(names.clone());

        assert_eq!(icons.len(), 2);
        assert_eq!(icons[""], None);
        assert_eq!(icons["Definitely-Not-A-Real-App-98765"], None);
    }
}
