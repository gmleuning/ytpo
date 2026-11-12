//! Minimal sfnt (TrueType/OpenType/TTC/WOFF) reader and name-table writer.
//! Reads only what Typo needs: names, OS/2 + post bits for classification.
//! Writes: a rebuilt font file with a replaced `name` table (valid checksums, DSIG dropped).

use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;

pub type Tag = [u8; 4];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FaceMeta {
    pub index: u32,
    /// Typographic family (name ID 16, else 1) — what Typo groups by.
    pub family: String,
    pub style: String,
    pub full: String,
    pub ps: String,
    /// Legacy family (name ID 1) — what Word / GIMP list.
    pub app: String,
    /// Family names in other languages.
    pub alt: Vec<String>,
    pub cat: Option<String>,
    /// Plain sfnt (ttf/otf/ttc) — WOFF/WOFF2 can't be rewritten.
    pub editable: bool,
}

pub fn be16(d: &[u8], o: usize) -> u16 {
    d.get(o..o + 2).map_or(0, |b| u16::from_be_bytes([b[0], b[1]]))
}
pub fn be32(d: &[u8], o: usize) -> u32 {
    d.get(o..o + 4).map_or(0, |b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// Offsets of each font's table directory (one for plain fonts, n for collections).
pub fn font_offsets(d: &[u8]) -> Result<Vec<usize>, String> {
    if d.len() < 12 {
        return Err("file too small to be a font".into());
    }
    if &d[0..4] == b"ttcf" {
        let n = be32(d, 8) as usize;
        if n == 0 || n > 512 || 12 + 4 * n > d.len() {
            return Err("bad font collection header".into());
        }
        Ok((0..n).map(|i| be32(d, 12 + 4 * i) as usize).collect())
    } else {
        Ok(vec![0])
    }
}

pub struct FontRef<'a> {
    d: &'a [u8],
    woff: bool,
    /// tag -> (offset, stored length, original length)
    dir: HashMap<Tag, (usize, usize, usize)>,
}

impl<'a> FontRef<'a> {
    pub fn open(d: &'a [u8], off: usize) -> Result<Self, String> {
        let mut dir = HashMap::new();
        if d.len() >= 44 && &d[0..4] == b"wOFF" {
            let n = be16(d, 12) as usize;
            for i in 0..n {
                let p = 44 + 20 * i;
                if p + 20 > d.len() { break; }
                let tag: Tag = d[p..p + 4].try_into().unwrap();
                dir.insert(tag, (be32(d, p + 4) as usize, be32(d, p + 8) as usize, be32(d, p + 12) as usize));
            }
            return Ok(Self { d, woff: true, dir });
        }
        if off + 12 > d.len() {
            return Err("bad table directory".into());
        }
        let n = be16(d, off + 4) as usize;
        for i in 0..n {
            let p = off + 12 + 16 * i;
            if p + 16 > d.len() { break; }
            let tag: Tag = d[p..p + 4].try_into().unwrap();
            let (o, l) = (be32(d, p + 8) as usize, be32(d, p + 12) as usize);
            dir.insert(tag, (o, l, l));
        }
        Ok(Self { d, woff: false, dir })
    }

    pub fn get(&self, tag: &Tag) -> Option<Cow<'a, [u8]>> {
        let &(o, len, orig) = self.dir.get(tag)?;
        let raw = self.d.get(o..o.checked_add(len)?)?;
        if self.woff && len < orig {
            let mut out = Vec::with_capacity(orig);
            flate2::read::ZlibDecoder::new(raw).read_to_end(&mut out).ok()?;
            Some(Cow::Owned(out))
        } else {
            Some(Cow::Borrowed(raw))
        }
    }
}

#[derive(Clone, Debug)]
pub struct NameRec {
    pub plat: u16,
    pub enc: u16,
    pub lang: u16,
    pub id: u16,
    pub bytes: Vec<u8>,
}

impl NameRec {
    pub fn text(&self) -> Option<String> {
        let s = match self.plat {
            0 | 3 => {
                let u: Vec<u16> = self.bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                String::from_utf16_lossy(&u)
            }
            1 if self.lang == 0 => self.bytes.iter().map(|&b| b as char).collect(),
            _ => return None,
        };
        let s = s.replace('\0', "").trim().to_string();
        (!s.is_empty()).then_some(s)
    }
}

/// All name records (format 0, or format 1 minus language-tag records).
pub fn parse_names(t: &[u8]) -> Vec<NameRec> {
    let count = be16(t, 2) as usize;
    let str_off = be16(t, 4) as usize;
    let mut out = Vec::new();
    for i in 0..count {
        let p = 6 + 12 * i;
        if p + 12 > t.len() { break; }
        let lang = be16(t, p + 4);
        if lang >= 0x8000 { continue; }
        let len = be16(t, p + 8) as usize;
        let start = str_off + be16(t, p + 10) as usize;
        let Some(bytes) = t.get(start..start + len) else { continue };
        out.push(NameRec { plat: be16(t, p), enc: be16(t, p + 2), lang, id: be16(t, p + 6), bytes: bytes.to_vec() });
    }
    out
}

/// Preferred (English) string for a name ID.
pub fn primary(recs: &[NameRec], id: u16) -> Option<String> {
    let pick = |f: &dyn Fn(&NameRec) -> bool| recs.iter().filter(|r| r.id == id && f(r)).find_map(|r| r.text());
    pick(&|r| r.plat == 3 && r.lang == 0x409)
        .or_else(|| pick(&|r| r.plat == 1))
        .or_else(|| pick(&|r| r.plat == 0))
        .or_else(|| pick(&|_| true))
}

pub fn build_names(mut recs: Vec<NameRec>) -> Vec<u8> {
    recs.sort_by_key(|r| (r.plat, r.enc, r.lang, r.id));
    let storage = 6 + 12 * recs.len();
    let mut head = Vec::with_capacity(storage);
    let mut strings: Vec<u8> = Vec::new();
    head.extend_from_slice(&0u16.to_be_bytes());
    head.extend_from_slice(&(recs.len() as u16).to_be_bytes());
    head.extend_from_slice(&(storage as u16).to_be_bytes());
    for r in &recs {
        // share identical strings
        let off = find_sub(&strings, &r.bytes).unwrap_or_else(|| {
            strings.extend_from_slice(&r.bytes);
            strings.len() - r.bytes.len()
        });
        for v in [r.plat, r.enc, r.lang, r.id, r.bytes.len() as u16, off as u16] {
            head.extend_from_slice(&v.to_be_bytes());
        }
    }
    head.extend_from_slice(&strings);
    head
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() { return Some(0); }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Replace every record of `id` (all languages) with one English record (+ Mac Roman if it had one and the text is ASCII).
pub fn set_name(recs: &mut Vec<NameRec>, id: u16, value: &str) {
    let enc3 = recs.iter().find(|r| r.plat == 3).map_or(1, |r| r.enc);
    let had_mac = recs.iter().any(|r| r.plat == 1);
    recs.retain(|r| r.id != id);
    if value.is_empty() { return; }
    let utf16: Vec<u8> = value.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
    recs.push(NameRec { plat: 3, enc: enc3, lang: 0x409, id, bytes: utf16 });
    if had_mac && value.is_ascii() {
        recs.push(NameRec { plat: 1, enc: 0, lang: 0, id, bytes: value.as_bytes().to_vec() });
    }
}

const MONO: &[&str] = &["mono", "code", "courier", "consol", "terminal", "fixed", "typewriter"];
const CJK: &[&str] = &["cjk", "myeongjo", "batang", "gulim", "dotum", "gungsuh", "nanum", "malgun", "mincho", "meiryo",
    "yu gothic", "ms gothic", "ms pgothic", "ms mincho", "simsun", "simhei", "kaiti", "fangsong", "mingliu", "yahei",
    "jhenghei", "dengxian", "hiragino", "source han", "pretendard", "spoqa"];

fn has_cjk_chars(s: &str) -> bool {
    s.chars().any(|c| matches!(c as u32, 0x1100..=0x11FF | 0x3040..=0x30FF | 0x3130..=0x318F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF))
}
fn cjk_name(s: &str) -> bool {
    let l = s.to_lowercase();
    has_cjk_chars(s) || CJK.iter().any(|k| l.contains(k))
        || l.split(|c: char| !c.is_alphanumeric()).any(|w| matches!(w, "kr" | "jp" | "sc" | "tc" | "hk"))
}

pub fn classify(f: &FontRef, family: &str) -> Option<&'static str> {
    let l = family.to_lowercase();
    if MONO.iter().any(|k| l.contains(k)) { return Some("Monospace"); }
    let os2 = f.get(b"OS/2");
    if let Some(o) = os2.as_deref() {
        if o.len() >= 58 {
            let ur2 = be32(o, 46);
            let cp = if o.len() >= 86 { be32(o, 78) } else { 0 };
            if (cp >> 17) & 0x1f != 0 || (ur2 >> 24) & 1 != 0 || (ur2 >> 27) & 1 != 0 { return Some("CJK"); }
        }
    }
    if cjk_name(family) { return Some("CJK"); }
    if let Some(p) = f.get(b"post") {
        if p.len() >= 16 && be32(&p, 12) != 0 { return Some("Monospace"); }
    }
    let o = os2?;
    if o.len() < 42 { return None; }
    let cls = o[30];
    let pan = [o[32], o[33], o[34], o[35]];
    if pan[0] == 2 && pan[3] == 9 { return Some("Monospace"); }
    if pan[0] == 3 || cls == 10 { return Some("Script/Handwriting"); }
    if pan[0] == 4 || pan[0] == 5 || cls == 9 || cls == 12 { return Some("Display"); }
    if cls == 8 { return Some("Sans-Serif"); }
    if (1..=7).contains(&cls) { return Some("Serif"); }
    if pan[0] == 2 {
        if (11..=15).contains(&pan[1]) { return Some("Sans-Serif"); }
        if (2..=10).contains(&pan[1]) { return Some("Serif"); }
    }
    None
}

fn junk(s: &str) -> bool { !s.chars().any(|c| c.is_alphanumeric()) }

/// Metadata for every face in a font file. Never fails: unreadable files get a filename-based entry.
pub fn inspect(d: &[u8], fallback: &str) -> Vec<FaceMeta> {
    let plain = || FaceMeta { family: fallback.into(), style: "Regular".into(), full: fallback.into(), ..Default::default() };
    if d.len() >= 4 && &d[0..4] == b"wOF2" { return vec![plain()]; }
    let editable = d.len() >= 4 && &d[0..4] != b"wOFF";
    let Ok(offs) = font_offsets(d) else { return vec![plain()] };
    let mut out = Vec::new();
    for (i, off) in offs.into_iter().enumerate() {
        let Ok(f) = FontRef::open(d, off) else { continue };
        let mut m = plain();
        m.index = i as u32;
        m.editable = editable;
        if let Some(t) = f.get(b"name") {
            let recs = parse_names(&t);
            let fam = primary(&recs, 16).or_else(|| primary(&recs, 1)).unwrap_or_default();
            if !junk(&fam) { m.family = fam.clone(); }
            m.style = primary(&recs, 17).or_else(|| primary(&recs, 2)).filter(|s| !junk(s)).unwrap_or(m.style);
            m.full = primary(&recs, 4).unwrap_or_else(|| format!("{} {}", m.family, m.style));
            m.ps = primary(&recs, 6).unwrap_or_default();
            m.app = primary(&recs, 1).unwrap_or_default();
            let mut alt: Vec<String> = Vec::new();
            for r in recs.iter().filter(|r| (r.id == 1 || r.id == 16) && r.plat == 3 && r.lang != 0x409) {
                if let Some(s) = r.text() {
                    if s != fam && s != m.app && !alt.contains(&s) { alt.push(s); }
                }
            }
            m.alt = alt;
        }
        m.cat = classify(&f, &m.family).map(str::to_string);
        out.push(m);
    }
    if out.is_empty() { out.push(plain()); }
    out
}

fn align4(n: usize) -> usize { (n + 3) & !3 }

fn checksum(d: &[u8]) -> u32 {
    let mut sum = 0u32;
    for c in d.chunks(4) {
        let mut b = [0u8; 4];
        b[..c.len()].copy_from_slice(c);
        sum = sum.wrapping_add(u32::from_be_bytes(b));
    }
    sum
}

/// Rebuilds a TTF/OTF/TTC with face `target`'s name table replaced. Tables shared between
/// collection faces stay shared; DSIG is dropped (any edit invalidates it).
pub fn rebuild(d: &[u8], target: usize, new_name: Vec<u8>) -> Result<Vec<u8>, String> {
    if d.len() >= 4 && (&d[0..4] == b"wOFF" || &d[0..4] == b"wOF2") {
        return Err("WOFF/WOFF2 web fonts can't be edited — convert to .ttf/.otf first.".into());
    }
    let ttc = &d[0..4] == b"ttcf";
    let offs = font_offsets(d)?;
    if target >= offs.len() { return Err("face index out of range".into()); }
    let mut blobs: Vec<Vec<u8>> = Vec::new();
    let mut seen: HashMap<(usize, usize), usize> = HashMap::new();
    let mut head_idx: Option<usize> = None;
    let mut fonts: Vec<(u32, Vec<(Tag, usize)>)> = Vec::new();
    for (i, &off) in offs.iter().enumerate() {
        if off + 12 > d.len() { return Err("bad table directory".into()); }
        let n = be16(d, off + 4) as usize;
        let mut list = Vec::new();
        for t in 0..n {
            let p = off + 12 + 16 * t;
            if p + 16 > d.len() { return Err("truncated table directory".into()); }
            let tag: Tag = d[p..p + 4].try_into().unwrap();
            let (to, tl) = (be32(d, p + 8) as usize, be32(d, p + 12) as usize);
            if &tag == b"DSIG" { continue; }
            let idx = if i == target && &tag == b"name" {
                blobs.push(new_name.clone());
                blobs.len() - 1
            } else if let Some(&k) = seen.get(&(to, tl)) {
                k
            } else {
                let mut b = d.get(to..to + tl).ok_or("table outside file")?.to_vec();
                if &tag == b"head" && b.len() >= 12 { b[8..12].fill(0); }
                blobs.push(b);
                seen.insert((to, tl), blobs.len() - 1);
                blobs.len() - 1
            };
            if &tag == b"head" { head_idx.get_or_insert(idx); }
            list.push((tag, idx));
        }
        list.sort_by_key(|x| x.0);
        fonts.push((be32(d, off), list));
    }

    let header = if ttc { 12 + 4 * fonts.len() } else { 0 };
    let dirs: usize = fonts.iter().map(|f| 12 + 16 * f.1.len()).sum();
    let mut pos = align4(header + dirs);
    let mut boff = vec![0usize; blobs.len()];
    for (i, b) in blobs.iter().enumerate() { boff[i] = pos; pos += align4(b.len()); }
    let mut out = vec![0u8; pos];
    let put16 = |o: &mut Vec<u8>, at: usize, v: u16| o[at..at + 2].copy_from_slice(&v.to_be_bytes());
    let put32 = |o: &mut Vec<u8>, at: usize, v: u32| o[at..at + 4].copy_from_slice(&v.to_be_bytes());

    let mut dpos = header;
    if ttc {
        out[0..4].copy_from_slice(b"ttcf");
        put32(&mut out, 4, 0x0001_0000);
        put32(&mut out, 8, fonts.len() as u32);
    }
    for (fi, (ver, list)) in fonts.iter().enumerate() {
        if ttc { put32(&mut out, 12 + 4 * fi, dpos as u32); }
        let n = list.len() as u16;
        let es = if n == 0 { 0 } else { 15 - n.leading_zeros() as u16 };
        let sr = (1u16 << es) * 16;
        put32(&mut out, dpos, *ver);
        put16(&mut out, dpos + 4, n);
        put16(&mut out, dpos + 6, sr);
        put16(&mut out, dpos + 8, es);
        put16(&mut out, dpos + 10, n * 16 - sr);
        for (k, (tag, idx)) in list.iter().enumerate() {
            let p = dpos + 12 + 16 * k;
            out[p..p + 4].copy_from_slice(tag);
            put32(&mut out, p + 4, checksum(&blobs[*idx]));
            put32(&mut out, p + 8, boff[*idx] as u32);
            put32(&mut out, p + 12, blobs[*idx].len() as u32);
        }
        dpos += 12 + 16 * list.len();
    }
    for (i, b) in blobs.iter().enumerate() { out[boff[i]..boff[i] + b.len()].copy_from_slice(b); }
    if !ttc {
        if let Some(h) = head_idx {
            let adj = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
            put32(&mut out, boff[h] + 8, adj);
        }
    }
    Ok(out)
}

/// PostScript names: printable ASCII, no spaces or []{}()<>/%, max 63 chars.
pub fn valid_ps(s: &str) -> bool {
    !s.is_empty() && s.len() <= 63 && s.bytes().all(|b| (33..=126).contains(&b) && !b"[](){}<>/%".contains(&b))
}
pub fn ps_part(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_graphic() && !"[](){}<>/%".contains(*c)).collect()
}
