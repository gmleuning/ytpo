//! Editing font files: names inside the font, and the file name on disk.
//! Every write keeps a backup and replaces the file atomically.

use crate::sfnt;
use crate::winfonts;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NameEdit {
    /// Rename the family: replaces `from` with `to` in names 1, 4, 16, 18, 21 and the PostScript name.
    pub rename_family: Option<(String, String)>,
    /// Exact values: keys are name IDs ("1" family as apps show it, "4" full name, "6" PostScript, "16" typographic family).
    #[serde(default)]
    pub set: HashMap<String, String>,
}

fn friendly(e: std::io::Error, path: &Path) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied if path.starts_with(winfonts::fonts_dir()) || path.to_string_lossy().to_lowercase().starts_with(&winfonts::fonts_dir().to_string_lossy().to_lowercase()) =>
            "This font is installed for all users in C:\\Windows\\Fonts, which only an administrator can change. Run Typo as administrator to edit it.".into(),
        std::io::ErrorKind::PermissionDenied => format!("Access denied: {} (is it read-only or open in another app?)", path.display()),
        _ => format!("{}: {}", path.display(), e),
    }
}

pub fn backup(path: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let dest = dir.join(format!("{ts}-{}", path.file_name().unwrap().to_string_lossy()));
    std::fs::copy(path, &dest).map_err(|e| friendly(e, path))?;
    Ok(dest)
}

/// Applies a name edit to one face; returns the new bytes of the whole file.
pub fn apply(data: &[u8], index: usize, edit: &NameEdit) -> Result<Vec<u8>, String> {
    let offs = sfnt::font_offsets(data)?;
    let off = *offs.get(index).ok_or("face index out of range")?;
    let f = sfnt::FontRef::open(data, off)?;
    let name = f.get(b"name").ok_or("font has no name table")?;
    let mut recs = sfnt::parse_names(&name);

    if let Some((from, to)) = &edit.rename_family {
        let (from, to) = (from.trim(), to.trim());
        if to.is_empty() { return Err("The new family name is empty.".into()); }
        if from != to {
            for id in [1u16, 4, 16, 18, 21] {
                if let Some(v) = sfnt::primary(&recs, id) {
                    if v.contains(from) { sfnt::set_name(&mut recs, id, &v.replacen(from, to, 1)); }
                    else if id == 16 || id == 21 { sfnt::set_name(&mut recs, id, to); }
                }
            }
            if sfnt::primary(&recs, 1).is_some_and(|v| !v.contains(to)) {
                // Legacy family didn't contain the old name (e.g. a localized-only name): set it outright.
                sfnt::set_name(&mut recs, 1, to);
            }
            let (pf, pt) = (sfnt::ps_part(from), sfnt::ps_part(to));
            if let Some(ps) = sfnt::primary(&recs, 6) {
                let new = if !pf.is_empty() && ps.contains(&pf) { ps.replacen(&pf, &pt, 1) }
                    else { match ps.split_once('-') { Some((_, st)) => format!("{pt}-{st}"), None => pt.clone() } };
                if sfnt::valid_ps(&new) { sfnt::set_name(&mut recs, 6, &new); }
            }
        }
    }
    for (k, v) in &edit.set {
        let id: u16 = k.parse().map_err(|_| format!("bad name id {k}"))?;
        let v = v.trim();
        if id == 6 && !sfnt::valid_ps(v) {
            return Err("PostScript names must be 1–63 plain ASCII characters with no spaces or []{}()<>/%.".into());
        }
        if v.is_empty() && matches!(id, 1 | 4 | 6) { return Err("That name can't be empty.".into()); }
        sfnt::set_name(&mut recs, id, v);
    }
    sfnt::rebuild(data, index, sfnt::build_names(recs))
}

/// Write `bytes` over `path` safely (temp file + rename).
fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("typo-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| friendly(e, path))?;
    std::fs::rename(&tmp, path).map_err(|e| { let _ = std::fs::remove_file(&tmp); friendly(e, path) })
}

/// Edit names in a font file. Installed fonts are unloaded first and re-registered after.
pub fn edit_names(path: &Path, index: usize, edit: &NameEdit, backup_dir: &Path) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    let data = std::fs::read(path).map_err(|e| friendly(e, path))?;
    let out = apply(&data, index, edit)?;
    // Verify the result parses before touching the original.
    let check = sfnt::inspect(&out, "");
    if check.len() <= index { return Err("Internal error: rebuilt font failed to parse; nothing was changed.".into()); }

    backup(path, backup_dir)?;
    let inst = winfonts::find(path);
    if inst.is_some() { winfonts::unload(path); }
    let res = replace_file(path, &out);
    if inst.is_some() { winfonts::load(path); }
    res?;
    if let Some(i) = inst {
        let single = sfnt::font_offsets(&out).map(|o| o.len() == 1).unwrap_or(false);
        if single {
            if let Err(e) = winfonts::update_entry(&i, None, Some(&check[0].full)) { notes.push(e); }
        }
        notes.push("Apps that are already open may need restarting to show the new name.".into());
    }
    Ok(notes)
}

/// Rename the file on disk (same folder). Keeps the extension if the new name has none.
pub fn rename_file(path: &Path, new_name: &str) -> Result<(String, Vec<String>), String> {
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("File names can't be empty or contain / \\ : * ? \" < > |".into());
    }
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let has_ext = Path::new(new_name).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(&ext));
    let file = if has_ext || ext.is_empty() { new_name.to_string() } else { format!("{new_name}.{ext}") };
    let dest = path.with_file_name(&file);
    if winfonts::same_path(&dest, path) { return Ok((path.to_string_lossy().into_owned(), Vec::new())); }
    if dest.exists() && !dest.to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy()) {
        return Err(format!("{file} already exists in that folder."));
    }
    let mut notes = Vec::new();
    let inst = winfonts::find(path);
    if inst.is_some() { winfonts::unload(path); }
    let res = std::fs::rename(path, &dest).map_err(|e| friendly(e, path));
    if let Some(i) = &inst {
        let now = if res.is_ok() { &dest } else { path };
        winfonts::load(now);
        if res.is_ok() {
            if let Err(e) = winfonts::update_entry(i, Some(&dest), None) { notes.push(e); }
        }
    }
    res?;
    Ok((dest.to_string_lossy().into_owned(), notes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font(name: &str) -> Option<Vec<u8>> { std::fs::read(winfonts::fonts_dir().join(name)).ok() }

    #[test]
    fn rename_family_roundtrip_ttf() {
        let Some(d) = font("georgia.ttf") else { return };
        let edit = NameEdit { rename_family: Some(("Georgia".into(), "Gorgeous".into())), ..Default::default() };
        let out = apply(&d, 0, &edit).unwrap();
        let m = &sfnt::inspect(&out, "x")[0];
        assert_eq!(m.family, "Gorgeous");
        assert_eq!(m.app, "Gorgeous");
        assert_eq!(m.full, "Gorgeous");
        assert_eq!(m.ps, "Gorgeous");
        assert_eq!(m.cat.as_deref(), Some("Serif"));
        // whole-file checksum must be 0xB1B0AFBA
        let mut sum = 0u32;
        for c in out.chunks(4) { let mut b = [0u8; 4]; b[..c.len()].copy_from_slice(c); sum = sum.wrapping_add(u32::from_be_bytes(b)); }
        assert_eq!(sum, 0xB1B0_AFBA);
    }

    #[test]
    fn set_exact_names_and_drop_localized() {
        let Some(d) = font("malgun.ttf") else { return };
        let before = &sfnt::inspect(&d, "x")[0];
        assert!(!before.alt.is_empty(), "malgun has a Korean name");
        let mut set = HashMap::new();
        set.insert("1".into(), "Malgun Test".into());
        set.insert("6".into(), "MalgunTest-Regular".into());
        let out = apply(&d, 0, &NameEdit { set, ..Default::default() }).unwrap();
        let m = &sfnt::inspect(&out, "x")[0];
        assert_eq!(m.app, "Malgun Test");
        assert_eq!(m.ps, "MalgunTest-Regular");
        assert!(m.alt.is_empty(), "localized family names removed: {:?}", m.alt);
        assert_eq!(m.cat.as_deref(), Some("CJK"));
    }

    #[test]
    fn edit_second_face_of_collection() {
        let Some(d) = font("batang.ttc") else { return };
        let before = sfnt::inspect(&d, "x");
        assert!(before.len() > 1);
        let mut set = HashMap::new();
        set.insert("4".into(), "Second Face Test".into());
        let out = apply(&d, 1, &NameEdit { set, ..Default::default() }).unwrap();
        let after = sfnt::inspect(&out, "x");
        assert_eq!(after.len(), before.len());
        assert_eq!(after[1].full, "Second Face Test");
        assert_eq!(after[0].full, before[0].full, "other faces untouched");
        assert!(out.len() < d.len() + 4096, "shared tables stay shared");
    }

    #[test]
    fn rejects_bad_postscript() {
        let Some(d) = font("arial.ttf") else { return };
        let mut set = HashMap::new();
        set.insert("6".into(), "Has Space".into());
        assert!(apply(&d, 0, &NameEdit { set, ..Default::default() }).is_err());
    }

    #[test]
    fn rename_and_edit_on_disk_with_backup() {
        let Some(d) = font("consola.ttf") else { return };
        let dir = std::env::temp_dir().join(format!("typo-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("c.ttf");
        std::fs::write(&p, &d).unwrap();
        let edit = NameEdit { rename_family: Some(("Consolas".into(), "Console Test".into())), ..Default::default() };
        edit_names(&p, 0, &edit, &dir.join("backups")).unwrap();
        assert_eq!(crate::scan::read_faces(&p)[0].family, "Console Test");
        assert_eq!(std::fs::read_dir(dir.join("backups")).unwrap().count(), 1);
        let (np, _) = rename_file(&p, "ConsoleTest").unwrap();
        assert!(np.ends_with("ConsoleTest.ttf"));
        assert!(Path::new(&np).exists() && !p.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
