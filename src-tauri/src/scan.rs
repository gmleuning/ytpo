//! Finds font files (installed + folders + loose files) and reads their metadata in parallel,
//! with an on-disk cache keyed by path + size + mtime so restarts are fast.

use crate::sfnt::{self, FaceMeta};
use crate::winfonts;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const EXTS: &[&str] = &["ttf", "otf", "ttc", "otc", "woff", "woff2"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    #[serde(flatten)]
    pub meta: FaceMeta,
    pub path: String,
    /// "windows" | "user" | "folder" | "file"
    pub source: String,
    /// The folder (as configured) this file was found in, if any.
    pub folder: Option<String>,
    pub mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub faces: Vec<Face>,
    pub errors: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry { size: u64, mtime: u64, faces: Vec<FaceMeta> }

pub fn is_font(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, errors: &mut Vec<String>, depth: usize) {
    if depth > 12 { return; }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => { errors.push(format!("{}: {}", dir.display(), e)); return; }
    };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&p, out, errors, depth + 1),
            Ok(_) if is_font(&p) => out.push(p),
            _ => {}
        }
    }
}

fn stat(p: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(p).ok()?;
    let mt = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((m.len(), mt))
}

pub fn read_faces(p: &Path) -> Vec<FaceMeta> {
    let fallback = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let Ok(file) = std::fs::File::open(p) else { return Vec::new() };
    // SAFETY: read-only map; a file changing underneath only yields garbage metadata, which we tolerate.
    match unsafe { memmap2::Mmap::map(&file) } {
        Ok(map) => sfnt::inspect(&map, &fallback),
        Err(_) => std::fs::read(p).map(|d| sfnt::inspect(&d, &fallback)).unwrap_or_default(),
    }
}

pub fn scan(folders: &[String], files: &[String], installed: bool, archive: Option<&str>, cache_path: &Path) -> ScanResult {
    let mut errors = Vec::new();
    // (path, source, folder)
    let mut list: Vec<(PathBuf, String, Option<String>)> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut add = |p: PathBuf, source: &str, folder: Option<String>, list: &mut Vec<(PathBuf, String, Option<String>)>| {
        let key = p.to_string_lossy().to_lowercase();
        if let Some(&i) = seen.get(&key) {
            if list[i].2.is_none() { list[i].2 = folder; }
            return;
        }
        seen.insert(key, list.len());
        list.push((p, source.to_string(), folder));
    };
    if installed {
        for i in winfonts::installed() {
            if is_font(&i.path) { add(i.path, i.source, None, &mut list); }
        }
    }
    for f in folders {
        let mut found = Vec::new();
        let root = PathBuf::from(f);
        if !root.is_dir() { errors.push(format!("Folder not found: {f}")); continue; }
        walk(&root, &mut found, &mut errors, 0);
        for p in found { add(p, "folder", Some(f.clone()), &mut list); }
    }
    if let Some(a) = archive.filter(|a| !a.is_empty()) {
        let root = PathBuf::from(a);
        if root.is_dir() {
            let mut found = Vec::new();
            walk(&root, &mut found, &mut errors, 0);
            for p in found { add(p, "archive", Some(a.to_string()), &mut list); }
        }
    }
    for f in files {
        let p = PathBuf::from(f);
        if p.is_file() { add(p, "file", None, &mut list); } else { errors.push(format!("File not found: {f}")); }
    }

    let cache: HashMap<String, CacheEntry> = std::fs::read(cache_path).ok()
        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();

    let results: Vec<(String, Option<CacheEntry>, Vec<Face>)> = list.par_iter().map(|(p, source, folder)| {
        let key = p.to_string_lossy().into_owned();
        let Some((size, mtime)) = stat(p) else { return (key, None, Vec::new()) };
        let metas = match cache.get(&key) {
            Some(c) if c.size == size && c.mtime == mtime => c.faces.clone(),
            _ => read_faces(p),
        };
        let faces = metas.iter().cloned().map(|meta| Face {
            meta, path: key.clone(), source: source.clone(), folder: folder.clone(), mtime,
        }).collect();
        (key, Some(CacheEntry { size, mtime, faces: metas }), faces)
    }).collect();

    let mut new_cache = HashMap::new();
    let mut faces = Vec::new();
    for (k, c, f) in results {
        if let Some(c) = c { new_cache.insert(k, c); }
        faces.extend(f);
    }
    if let Some(dir) = cache_path.parent() { let _ = std::fs::create_dir_all(dir); }
    if let Ok(b) = serde_json::to_vec(&new_cache) { let _ = std::fs::write(cache_path, b); }
    ScanResult { faces, errors }
}
