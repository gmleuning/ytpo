# Ytpo

*Pronounced "typo".*

A minimal, local-first font browser designed for rapid visual inspection, custom taxonomic tagging, and plaintext configuration portability.

Built to strip away bloated font-management suites, this tool focuses on a fast, distraction-free workflow: previewing local typefaces with live custom text, filtering by typographic classification and user-defined tags, hiding unused system clutter, and storing all metadata in human-readable Markdown.

A small Windows desktop app: a Rust backend ([Tauri](https://tauri.app)) that finds, reads and edits font files, around a plain HTML/CSS/JS interface in `ui/`.

---

## Running it

**Use it:** run the installer from `src-tauri/target/release/bundle/nsis/`, or run `src-tauri/target/release/ytpo.exe` directly. Settings, tags and links carry over from Typo 0.3 (the app keeps the same data folder).

**Build it** (needs [Rust](https://rustup.rs), Node.js, and the Visual Studio C++ Build Tools):

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

`npm run dev` opens the app and reloads it when you edit `ui/`. `npm run build` makes the `.exe` and the installer.

### Getting fonts in

* **Installed fonts** are shown automatically, with their real file paths, split by where they live: **Windows (all users)** (`C:\Windows\Fonts`) and **Installed by you** (`%LOCALAPPDATA%\Microsoft\Windows\Fonts`). Turn this off in Settings if you only want your own folders.
* **Font folders:** Settings → type or paste any path (hidden and system folders included), or Browse. Every font in the folder and its subfolders is shown. Nothing is copied, moved or installed.
* **Files:** Settings → *Add font files…*, or drop font files or whole folders onto the window.

The same font found in several places shows up once, with every file listed. The **Source** filter (off by default; switch it on in Settings → Sidebar) separates Windows fonts, fonts you installed, folders, added files and the archive. Use **Rescan** (Settings) (or F5) after adding fonts outside Ytpo; scans are cached, so they're quick after the first one.

---

## Core Features

* **Live Specimen Preview:** Inspect installed system fonts and local font files (`.ttf`, `.otf`, `.woff`, `.woff2`) in a clean, scrollable grid or list view.
* **Clean cards:** each card shows just the name, a **hide** button, the live sample, and its tags (if any). Hover the name for its classification.
* **Missing characters are greyed out:** when a font doesn't have a character, Windows draws it with a fallback font. Ytpo reads each font's character map and dims those characters, so you can see at a glance which fonts really support, say, `₹ ‽ ⇒` or Hangul. Two symbol presets (less common, and rare) help test this.
* **Font details:** Click a font's name to expand it. In order:
  * **Variations**: every weight and style, in the font
  * **Class**: change the classification
  * **Family**: rename the family inside its files, or group it (see below)
  * **Files**: collapsed to the first file name; open it to edit each file
  * **Tags**
  * **Archive** / **Unarchive**

  Names in other languages (e.g. the Hangul name of a Korean font) are listed too. Search matches all names and file names, so you can type a file name, an English name or a Hangul name. Fonts whose internal name is junk (like `.`) fall back to their file name.
* **Grouping split families:** older fonts often register each weight as its own family (*Franklin Gothic Book*, *Franklin Gothic Demi Cond*, *Franklin Gothic Heavy*…). In a card's details, Ytpo suggests shared name prefixes (**Group as Franklin Gothic** 6); click one, or type any group name and press Enter. The group becomes one card with every member's styles under their short names (*Demi Cond*, *Heavy Italic*), and the members' tags are merged. **Ungroup** splits it again. You choose what to group, so *DIN Alternate* can be grouped while the other DINs stay separate. Groups change nothing in the font files.
* **Editing the fonts themselves:** in the same panel:
  * **Family → Rename in N files** renames the whole family inside every file. It updates the name apps show, the full name and the PostScript name, and removes names in other languages so the new name shows everywhere.
  * Each file's block edits its **file name** on disk, the name **in apps** (Word, GIMP; name ID 1), the **full name** (name ID 4) and the **PostScript** name (name ID 6).
  * Every edit copies the original to a backups folder first (Settings → *Open backups folder*), writes the new file safely, keeps checksums valid, and drops the now-invalid digital signature.
  * Installed fonts are re-registered with Windows, including their registry entry. Apps that are already open may need restarting to show a new name.
  * Fonts in `C:\Windows\Fonts` can only be changed when Ytpo runs as administrator; fonts you installed yourself don't need that.
  * WOFF/WOFF2 web fonts can be renamed on disk but not edited inside.
  * Renaming a font breaks documents that use the old name, and some font licenses (e.g. the OFL's Reserved Font Name clause) restrict changing names.
* **Interactive Type Tester:** A persistent global text input bar to test custom strings, pangrams, or character sets across all visible typefaces simultaneously, with adjustable font size and tracking. A preset menu has pangrams, alphabets, numerals, punctuation, two symbol sets, and Korean and Japanese samples.
* **Classification & Tag Filtering:**
  * Filter by classification. The list is yours to edit in Settings → Classifications (one per line). The defaults are **Serif**, **Sans-Serif**, **Monospace**, **Display**, **Script/Handwriting**, **CJK**, **Blackletter**, **Symbol**, **Math**, **Cyrillic**, **Greek** and **Arabic**; a class only appears in the sidebar once a font has it. Classes are detected from each font's own tables (symbol character maps, CJK code pages and Unicode ranges, OS/2 family class, PANOSE, `post.isFixedPitch`), falling back to name heuristics, and can be changed per font in its details.
  * Filter by custom, user-assigned tags (e.g., `#editorial`, `#brutalist`, `#ui`, `#korean-support`). Selected tags combine with AND; an *untagged* chip finds fonts you haven't sorted yet.
* **On-the-Fly Tagging:** Open a font's details and type into the `+ tag` field. Enter, comma or space adds tags (with autocomplete from existing tags), Backspace on an empty field removes the last one, × removes a specific tag, and clicking a tag filters by it.
* **Declutter / Hide Mode:** Mark rarely used, legacy, or OS-locked system fonts as hidden to keep the active workspace focused, with a single toggle to reveal hidden fonts when needed.
* **Archive:** set an archive folder in Settings (e.g. `I:\My Drive\Archive\Fonts`). **Archive** in a font's details then, without asking (nothing is lost):
  * copies its files there and checks that each copy matches the original
  * uninstalls it from Windows, or deletes it from its font folder (added files are just un-listed)

  Archived fonts keep their tags and are hidden until you tick **Show archived**. **Unarchive** installs one again for your account; the archive copy stays. If an identical file is already in the archive it's reused, and a different file with the same name is saved as `name (2).ttf`. Fonts in `C:\Windows\Fonts` need Ytpo to run as administrator to be uninstalled. A `.ttc` file holding several families archives all of them.
* **Markdown Portability (`.md`, in Settings):** Export your entire tagging taxonomy, hidden font list, and classification overrides into a clean Markdown file, and import it back on any machine or version-control it in an Obsidian vault or Git repository.
  * **Export…** saves a `font-tags.md` wherever you choose.
  * **Import once…** (or dropping a `.md` file) is a **one-time copy**: it merges the file in (entries in the file win), but later edits to that file are not picked up.
  * **Link existing .md…** / **Link new .md…** keep a file (for example, one inside your vault) in **live, two-way sync**. Changes in Ytpo are written to the file within a second. Edits made to the file elsewhere (Obsidian, a text editor, a `git pull`) are picked up automatically within about two seconds, or as soon as you switch back to Ytpo. While linked, the file is the source of truth: it's read first on every start.
  * By default every loaded font is exported; Settings can limit it to fonts you've annotated.

Keyboard: `/` focuses search, `Esc` clears it, `F5` rescans.

**Settings** (top right) holds the theme (System / Light / Dark) and accent colour, the classification list, the Source-filter switch, font folders and added files, the archive folder, the installed-fonts switch, the Markdown taxonomy (link, import, export, scope, live reload), the backups folder, and data resets.

---

## Markdown Schema (`.md` Import / Export)

Configuration and tag states are serialized into a structured, human-editable Markdown format so your font library metadata is never locked into a proprietary database.

Every loaded font is written (or only annotated ones, if you choose that in Settings). Entries for fonts that aren't on the current machine are kept, so the file round-trips safely between machines.

Each `###` heading is the font's real family name and is the key, so don't rename headings. To change the font's name itself, use *Rename in N files* in the app. Fields:

| Field | Meaning |
|---|---|
| `Category` | Any class from your list (`Serif`, `Sans-Serif`, `CJK`, `Blackletter`…). Unknown names are kept as new classes |
| `Group` | Puts this family on a group's card (e.g. `Franklin Gothic`). A member's entry holds only this line; the group's own `###` entry holds the tags |
| `Tags` | `#tag` list |
| `Status` | `visible` or `hidden` |
| `Files` | Where the font was found. Informational: ignored on import |

The parser is lenient: it ignores unknown lines and sections, accepts `sans`/`mono`/`script`/`korean`-style category spellings, and treats the `Status` line (or, failing that, the `## Hidden Fonts` section) as the visibility.

### Example `font-tags.md`

```markdown
---
version: 1.0
exported: 2026-11-11
---

# Font Taxonomy

## Active Fonts

### Inter
- **Category:** Sans-Serif
- **Tags:** #ui, #clean, #variable
- **Status:** visible

### JetBrains Mono
- **Category:** Monospace
- **Tags:** #code, #terminal, #tabular
- **Status:** visible

### Noto Serif KR
- **Category:** CJK
- **Tags:** #editorial, #multilingual, #body
- **Status:** visible
- **Files:** D:\Fonts\Noto\NotoSerifKR-Regular.otf

### Franklin Gothic
- **Category:** Sans-Serif
- **Tags:** #editorial
- **Status:** visible

### Franklin Gothic Demi Cond
- **Group:** Franklin Gothic

## Hidden Fonts

### Arial Unicode MS
- **Category:** Sans-Serif
- **Tags:** #legacy
- **Status:** hidden
```

Font headings (`###`) use the font's family name from its `name` table (typographic family, else legacy family).

---

## Project layout

| Path | What |
|---|---|
| `ui/` | The interface: `index.html`, `style.css`, `app.js` |
| `src-tauri/src/sfnt.rs` | Reads and rewrites font binaries (TTF/OTF/TTC/WOFF): names, classification, character map, name-table rebuild |
| `src-tauri/src/scan.rs` | Finds fonts (installed, folders, files) and caches their metadata |
| `src-tauri/src/edit.rs` | Name edits and file renames, with backups (tests: `cargo test` in `src-tauri`) |
| `src-tauri/src/archive.rs` | Archive (verified copy, then uninstall or remove) and install for the current user |
| `src-tauri/src/winfonts.rs` | Windows font registry; unloading and reloading installed fonts |
| `src-tauri/src/main.rs` | The commands the UI calls |

Ytpo's own data (tags, groups, overrides, hidden flags, settings) is kept in the app's local storage and, if you link one, in your Markdown file. The scan cache and backups are in `%APPDATA%\io.github.typo-fonts\`.
