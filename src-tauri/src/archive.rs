//! Archive: copy a font file to the archive folder (verified), then uninstall it or remove the original.
//! Install: put an archived font back, installed for the current user (no admin needed).

use crate::scan;
use crate::winfonts::{self, Installed};
use std::path::{Path, PathBuf};

fn io_err(e: std::io::Error, p: &Path) -> String { format!("{}: {}", p.display(), e) }

/// Copies `path` into `dir`, reusing an identical copy if one is already there,
/// otherwise picking a free "name (2).ext" style name. Returns the archive path.
pub fn copy_verified(path: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| io_err(e, dir))?;
    let data = std::fs::read(path).map_err(|e| io_err(e, path))?;
    let name = path.file_name().ok_or("bad file name")?.to_string_lossy().into_owned();
    let (stem, ext) = match name.rsplit_once('.') { Some((s, e)) => (s.to_string(), format!(".{e}")), None => (name.clone(), String::new()) };
    for n in 1..1000 {
        let dest = dir.join(if n == 1 { name.clone() } else { format!("{stem} ({n}){ext}") });
        match std::fs::read(&dest) {
            Ok(existing) if existing == data => return Ok(dest), // already archived
            Ok(_) => continue,                                  // different file with that name
            Err(_) => {
                std::fs::write(&dest, &data).map_err(|e| io_err(e, &dest))?;
                let back = std::fs::read(&dest).map_err(|e| io_err(e, &dest))?;
                if back != data {
                    let _ = std::fs::remove_file(&dest);
                    return Err(format!("The copy in {} didn't match the original; nothing was removed.", dir.display()));
                }
                return Ok(dest);
            }
        }
    }
    Err("Couldn't find a free file name in the archive folder.".into())
}

/// Uninstalls an installed font: unload, remove its registry entry, delete the file.
/// Any failure puts things back as they were.
fn uninstall(path: &Path, inst: &Installed) -> Result<(), String> {
    winfonts::unload(path);
    if let Err(e) = winfonts::remove_entry(inst) {
        winfonts::load(path);
        return Err(e);
    }
    if let Err(e) = std::fs::remove_file(path) {
        let _ = winfonts::restore_entry(inst);
        winfonts::load(path);
        return Err(format!("Couldn't delete {} ({e}). It may be in use: close apps using this font and try again.", path.display()));
    }
    winfonts::broadcast();
    Ok(())
}

pub fn archive(path: &Path, source: &str, dir: &Path) -> Result<(String, Vec<String>), String> {
    if winfonts::same_path(path.parent().unwrap_or(path), dir) {
        return Err("That file is already in the archive folder.".into());
    }
    let dest = copy_verified(path, dir)?;
    let mut notes = Vec::new();
    match source {
        "windows" | "user" => match winfonts::find(path) {
            Some(inst) => uninstall(path, &inst)?,
            None => notes.push(format!("{} was no longer registered; archived copy made.", path.display())),
        },
        "folder" => std::fs::remove_file(path).map_err(|e| format!("Archived, but couldn't delete the original {}: {e}", path.display()))?,
        _ => {} // added files: the original stays put
    }
    Ok((dest.to_string_lossy().into_owned(), notes))
}

/// Installs a font file for the current user: copy into the per-user Fonts folder, register, load.
pub fn install(path: &Path) -> Result<Vec<String>, String> {
    let faces = scan::read_faces(path);
    if faces.is_empty() { return Err(format!("{} isn't a readable font.", path.display())); }
    let dir = winfonts::user_fonts_dir();
    std::fs::create_dir_all(&dir).map_err(|e| io_err(e, &dir))?;
    let file = path.file_name().ok_or("bad file name")?;
    let dest = dir.join(file);
    let data = std::fs::read(path).map_err(|e| io_err(e, path))?;
    match std::fs::read(&dest) {
        Ok(existing) if existing == data => {}
        Ok(_) => return Err(format!("A different font file named {} is already installed.", file.to_string_lossy())),
        Err(_) => std::fs::write(&dest, &data).map_err(|e| io_err(e, &dest))?,
    }
    let mut names: Vec<String> = Vec::new();
    for f in &faces { if !names.contains(&f.full) { names.push(f.full.clone()); } }
    let kind = if data.get(0..4) == Some(b"OTTO") { "OpenType" } else { "TrueType" };
    let reg_name = format!("{} ({kind})", names.join(" & "));
    winfonts::add_user_entry(&reg_name, &dest)?;
    winfonts::load(&dest);
    Ok(vec!["Installed for your account. Apps that are already open may need restarting to see it.".into()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_folder_font_moves_it_and_dedupes() {
        let Ok(d) = std::fs::read(winfonts::fonts_dir().join("georgia.ttf")) else { return };
        let root = std::env::temp_dir().join(format!("typo-arch-{}", std::process::id()));
        let (src, arch) = (root.join("src"), root.join("arch"));
        std::fs::create_dir_all(&src).unwrap();
        let p = src.join("g.ttf");
        std::fs::write(&p, &d).unwrap();
        let (dest, _) = archive(&p, "folder", &arch).unwrap();
        assert!(Path::new(&dest).exists() && !p.exists());
        // same bytes again -> reuses the existing archive copy
        std::fs::write(&p, &d).unwrap();
        let (dest2, _) = archive(&p, "folder", &arch).unwrap();
        assert_eq!(dest, dest2);
        // different bytes, same name -> "g (2).ttf"
        let mut other = d.clone(); other.push(0);
        std::fs::write(&p, &other).unwrap();
        let (dest3, _) = archive(&p, "folder", &arch).unwrap();
        assert!(dest3.ends_with("g (2).ttf"), "{dest3}");
        // added files are copied but never deleted
        std::fs::write(&p, &d).unwrap();
        archive(&p, "file", &arch).unwrap();
        assert!(p.exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
