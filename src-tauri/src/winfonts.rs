//! Windows font registry: which fonts are installed (all users vs. just this user),
//! plus unloading/reloading a font file around an edit and keeping the registry in step.

use std::path::{Path, PathBuf};
use winreg::enums::*;
use winreg::RegKey;

const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";

#[derive(Clone, Debug)]
pub struct Installed {
    pub path: PathBuf,
    /// "windows" = HKLM / C:\Windows\Fonts (all users), "user" = HKCU (installed just for you)
    pub source: &'static str,
    pub reg_name: String,
}

pub fn fonts_dir() -> PathBuf {
    PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into())).join("Fonts")
}

fn hive(source: &str) -> RegKey {
    RegKey::predef(if source == "user" { HKEY_CURRENT_USER } else { HKEY_LOCAL_MACHINE })
}

pub fn installed() -> Vec<Installed> {
    let dir = fonts_dir();
    let mut out = Vec::new();
    for source in ["windows", "user"] {
        let Ok(k) = hive(source).open_subkey(KEY) else { continue };
        for (name, _) in k.enum_values().filter_map(Result::ok) {
            let Ok(data) = k.get_value::<String, _>(&name) else { continue };
            let p = PathBuf::from(&data);
            let path = if p.is_absolute() { p } else { dir.join(p) };
            out.push(Installed { path, source, reg_name: name });
        }
    }
    out
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

pub fn find(path: &Path) -> Option<Installed> {
    installed().into_iter().find(|i| same_path(&i.path, path))
}

fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(Some(0)).collect()
}

pub fn unload(path: &Path) {
    let w = wide(path);
    // An installed font may have been added more than once (session + apps); remove until gone.
    for _ in 0..8 {
        if unsafe { windows_sys::Win32::Graphics::Gdi::RemoveFontResourceW(w.as_ptr()) } == 0 { break; }
    }
}

pub fn load(path: &Path) {
    let w = wide(path);
    unsafe { windows_sys::Win32::Graphics::Gdi::AddFontResourceW(w.as_ptr()) };
    broadcast();
}

pub fn broadcast() {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let mut res = 0usize;
    unsafe { SendMessageTimeoutW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0, SMTO_ABORTIFHUNG, 1000, &mut res) };
}

/// Point the registry entry at a new file path and/or give it a new display name.
pub fn update_entry(i: &Installed, new_path: Option<&Path>, new_full: Option<&str>) -> Result<(), String> {
    let k = hive(i.source)
        .open_subkey_with_flags(KEY, KEY_READ | KEY_WRITE)
        .map_err(|_| "Couldn't update the Windows font registry (fonts installed for all users need administrator rights).".to_string())?;
    let data: String = match new_path {
        Some(p) if i.source == "user" => p.to_string_lossy().into_owned(),
        Some(p) if p.parent().is_some_and(|d| same_path(d, &fonts_dir())) => p.file_name().unwrap().to_string_lossy().into_owned(),
        Some(p) => p.to_string_lossy().into_owned(),
        None => k.get_value::<String, _>(&i.reg_name).map_err(|e| e.to_string())?,
    };
    let name = match new_full {
        Some(full) => {
            let suffix = i.reg_name.rfind(" (").map(|p| &i.reg_name[p..]).unwrap_or(" (TrueType)");
            format!("{full}{suffix}")
        }
        None => i.reg_name.clone(),
    };
    if name != i.reg_name { k.delete_value(&i.reg_name).map_err(|e| e.to_string())?; }
    k.set_value(&name, &data).map_err(|e| e.to_string())
}
