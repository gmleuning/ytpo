// Ytpo — minimal local-first font browser (Tauri shell around the ui/ folder).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive;
mod edit;
mod scan;
mod sfnt;
mod winfonts;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

type Res<T> = Result<T, String>;

fn data_dir(app: &tauri::AppHandle) -> Res<PathBuf> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_fonts(app: tauri::AppHandle, folders: Vec<String>, files: Vec<String>, installed: bool, archive: Option<String>) -> Res<scan::ScanResult> {
    let cache = data_dir(&app)?.join("scan-cache-v3.json");
    blocking(move || Ok(scan::scan(&folders, &files, installed, archive.as_deref(), &cache))).await
}

#[tauri::command]
async fn edit_names(app: tauri::AppHandle, path: String, index: usize, edit: edit::NameEdit) -> Res<Vec<String>> {
    let backups = data_dir(&app)?.join("backups");
    blocking(move || edit::edit_names(Path::new(&path), index, &edit, &backups)).await
}

#[derive(Serialize)]
struct Renamed { path: String, notes: Vec<String> }

#[tauri::command]
async fn rename_file(path: String, new_name: String) -> Res<Renamed> {
    blocking(move || edit::rename_file(Path::new(&path), &new_name).map(|(path, notes)| Renamed { path, notes })).await
}

#[derive(Serialize)]
struct Archived { path: String, notes: Vec<String> }

#[tauri::command]
async fn archive_font(path: String, source: String, archive_dir: String) -> Res<Archived> {
    blocking(move || archive::archive(Path::new(&path), &source, Path::new(&archive_dir)).map(|(path, notes)| Archived { path, notes })).await
}

#[tauri::command]
async fn install_font(path: String) -> Res<Vec<String>> {
    blocking(move || archive::install(Path::new(&path))).await
}

#[derive(Serialize)]
struct TextFile { text: String, mtime: u64 }

fn mtime(p: &Path) -> Option<u64> {
    Some(std::fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

#[tauri::command]
fn read_text(path: String) -> Res<TextFile> {
    let p = Path::new(&path);
    let text = std::fs::read_to_string(p).map_err(|e| format!("{path}: {e}"))?;
    Ok(TextFile { text, mtime: mtime(p).unwrap_or(0) })
}

#[tauri::command]
fn write_text(path: String, text: String) -> Res<u64> {
    let p = Path::new(&path);
    std::fs::write(p, text).map_err(|e| format!("{path}: {e}"))?;
    Ok(mtime(p).unwrap_or(0))
}

#[tauri::command]
fn file_mtime(path: String) -> Option<u64> { mtime(Path::new(&path)) }

#[tauri::command]
fn is_dir(path: String) -> bool { Path::new(&path).is_dir() }

/// Opens Explorer with the file selected (or the folder itself).
#[tauri::command]
fn reveal(path: String) {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new("explorer");
    if Path::new(&path).is_dir() { c.arg(&path); } else { c.raw_arg(format!("/select,\"{path}\"")); }
    let _ = c.spawn();
}

#[tauri::command]
fn open_backups(app: tauri::AppHandle) -> Res<()> {
    let d = data_dir(&app)?.join("backups");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let _ = std::process::Command::new("explorer").arg(d).spawn();
    Ok(())
}

#[tauri::command]
fn windows_fonts_dir() -> String { winfonts::fonts_dir().to_string_lossy().into_owned() }

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_fonts, edit_names, rename_file, archive_font, install_font, read_text, write_text, file_mtime, is_dir, reveal, open_backups, windows_fonts_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ytpo");
}
