//! Schematics (Sponge .schem v2/v3 load, v2 save), copy/paste with rotation,
//! and built-in procedural landmarks.

use super::fmt_n;
use crate::blocks::{self, BlockId, AIR};
use crate::noise::Rng;
use crate::spec;
use crate::world::World;
use anyhow::{anyhow, bail, Context, Result};
use fastnbt::Value as Nbt;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};

#[derive(Clone)]
pub struct Schematic {
    pub w: i32,
    pub h: i32,
    pub l: i32,
    pub blocks: Vec<BlockId>,
    /// Paste point inside the schematic (x, y, z).
    pub origin: (i32, i32, i32),
}

impl Schematic {
    pub fn new(w: i32, h: i32, l: i32) -> Self {
        Schematic { w, h, l, blocks: vec![AIR; (w * h * l).max(0) as usize], origin: (w / 2, 0, l / 2) }
    }
    #[inline]
    fn i(&self, x: i32, y: i32, z: i32) -> Option<usize> {
        if x < 0 || y < 0 || z < 0 || x >= self.w || y >= self.h || z >= self.l {
            return None;
        }
        Some(((y * self.l + z) * self.w + x) as usize)
    }
    pub fn get(&self, x: i32, y: i32, z: i32) -> BlockId {
        self.i(x, y, z).map(|i| self.blocks[i]).unwrap_or(AIR)
    }
    pub fn set(&mut self, x: i32, y: i32, z: i32, id: BlockId) {
        if let Some(i) = self.i(x, y, z) {
            self.blocks[i] = id;
        }
    }
    pub fn count(&self) -> usize {
        self.blocks.iter().filter(|&&b| !blocks::is_air(b)).count()
    }
}

// ---------------------------------------------------------------- rotation

fn rotate_state(state: &str, turns: i32) -> String {
    let t = turns.rem_euclid(4);
    if t == 0 || !state.contains('[') {
        return state.to_string();
    }
    let (name, props) = blocks::split_state(state);
    let dirs = ["north", "east", "south", "west"];
    let rot = |d: &str| -> String {
        match dirs.iter().position(|x| *x == d) {
            Some(i) => dirs[(i + t as usize) % 4].to_string(),
            None => d.to_string(),
        }
    };
    let mut out: Vec<(String, String)> = vec![];
    let mut sides: HashMap<String, String> = HashMap::new();
    for (k, v) in &props {
        match k.as_str() {
            "facing" => out.push((k.clone(), rot(v))),
            "axis" if t % 2 == 1 => out.push((k.clone(), match v.as_str() { "x" => "z".into(), "z" => "x".into(), o => o.into() })),
            "rotation" => {
                let r: i32 = v.parse().unwrap_or(0);
                out.push((k.clone(), ((r + 4 * t) % 16).to_string()));
            }
            "north" | "east" | "south" | "west" => {
                sides.insert(rot(k), v.clone());
            }
            _ => out.push((k.clone(), v.clone())),
        }
    }
    for (k, v) in sides {
        out.push((k, v));
    }
    out.sort();
    format!("{}[{}]", name, out.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","))
}

/// Paste with rotation (quarter turns clockwise seen from above).
pub fn paste(w: &mut World, s: &Schematic, at: (i32, i32, i32), turns: i32, ignore_air: bool) -> u64 {
    let t = turns.rem_euclid(4);
    let mut cache: HashMap<BlockId, BlockId> = HashMap::new();
    let mut n = 0;
    for y in 0..s.h {
        for z in 0..s.l {
            for x in 0..s.w {
                let b = s.get(x, y, z);
                if ignore_air && blocks::is_air(b) {
                    continue;
                }
                let (rx, rz) = (x - s.origin.0, z - s.origin.2);
                let (px, pz) = match t {
                    0 => (rx, rz),
                    1 => (-rz, rx),
                    2 => (-rx, -rz),
                    _ => (rz, -rx),
                };
                let id = *cache.entry(b).or_insert_with(|| if t == 0 { b } else { blocks::id(&rotate_state(&blocks::name(b), t)) });
                if w.set(at.0 + px, at.1 + y - s.origin.1, at.2 + pz, id) {
                    n += 1;
                }
            }
        }
    }
    n
}

pub fn copy(w: &World, p1: (i32, i32, i32), p2: (i32, i32, i32), origin: Option<(i32, i32, i32)>) -> Schematic {
    let (x0, y0, z0) = (p1.0.min(p2.0), p1.1.min(p2.1), p1.2.min(p2.2));
    let (x1, y1, z1) = (p1.0.max(p2.0), p1.1.max(p2.1), p1.2.max(p2.2));
    let mut s = Schematic::new(x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1);
    for y in y0..=y1 {
        for z in z0..=z1 {
            for x in x0..=x1 {
                s.set(x - x0, y - y0, z - z0, w.get(x, y, z));
            }
        }
    }
    s.origin = match origin {
        Some(o) => (o.0 - x0, o.1 - y0, o.2 - z0),
        None => (s.w / 2, 0, s.l / 2),
    };
    s
}

// ---------------------------------------------------------------- .schem IO

fn get<'a>(c: &'a HashMap<String, Nbt>, k: &str) -> Option<&'a Nbt> {
    c.get(k)
}
fn num(v: Option<&Nbt>) -> i64 {
    match v {
        Some(Nbt::Byte(b)) => *b as i64,
        Some(Nbt::Short(s)) => *s as i64,
        Some(Nbt::Int(i)) => *i as i64,
        Some(Nbt::Long(l)) => *l,
        _ => 0,
    }
}

pub fn load_schem(path: &str) -> Result<Schematic> {
    let raw = std::fs::read(path).with_context(|| format!("reading {path}"))?;
    let data = if raw.starts_with(&[0x1f, 0x8b]) {
        let mut d = vec![];
        GzDecoder::new(&raw[..]).read_to_end(&mut d)?;
        d
    } else {
        raw
    };
    let root: Nbt = fastnbt::from_bytes(&data).map_err(|e| anyhow!("bad NBT: {e}"))?;
    let Nbt::Compound(mut c) = root else { bail!("schematic root is not a compound") };
    if let Some(Nbt::Compound(inner)) = c.remove("Schematic") {
        c = inner; // v3
    }
    let (w, h, l) = (num(get(&c, "Width")) as i32, num(get(&c, "Height")) as i32, num(get(&c, "Length")) as i32);
    if w <= 0 || h <= 0 || l <= 0 {
        bail!("not a Sponge schematic (missing Width/Height/Length)");
    }
    let (palette, data) = match get(&c, "Blocks") {
        Some(Nbt::Compound(b)) => (get(b, "Palette").cloned(), get(b, "Data").cloned()),
        _ => (get(&c, "Palette").cloned(), get(&c, "BlockData").cloned()),
    };
    let Some(Nbt::Compound(pal)) = palette else { bail!("schematic has no Palette") };
    let Some(Nbt::ByteArray(bytes)) = data else { bail!("schematic has no block data") };
    let mut map: HashMap<i64, BlockId> = HashMap::new();
    for (k, v) in &pal {
        map.insert(num(Some(v)), blocks::id(k));
    }
    let mut s = Schematic::new(w, h, l);
    let bytes: Vec<u8> = bytes.iter().map(|&b| b as u8).collect();
    let mut i = 0usize;
    let mut idx = 0usize;
    while i < bytes.len() && idx < s.blocks.len() {
        let mut v: i64 = 0;
        let mut shift = 0;
        loop {
            let b = bytes[i];
            i += 1;
            v |= ((b & 0x7f) as i64) << shift;
            shift += 7;
            if b & 0x80 == 0 || i >= bytes.len() {
                break;
            }
        }
        s.blocks[idx] = *map.get(&v).unwrap_or(&AIR);
        idx += 1;
    }
    s.origin = (w / 2, 0, l / 2);
    Ok(s)
}

pub fn save_schem(s: &Schematic, path: &str, data_version: i32) -> Result<()> {
    let mut pal: HashMap<BlockId, i32> = HashMap::new();
    let mut bytes: Vec<i8> = vec![];
    for &b in &s.blocks {
        let n = pal.len() as i32;
        let mut v = *pal.entry(b).or_insert(n) as u32;
        loop {
            let mut byte = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                byte |= 0x80;
            }
            bytes.push(byte as i8);
            if v == 0 {
                break;
            }
        }
    }
    let palette: HashMap<String, Nbt> = pal.iter().map(|(b, i)| (blocks::name(*b), Nbt::Int(*i))).collect();
    let mut root = HashMap::new();
    root.insert("Version".into(), Nbt::Int(2));
    root.insert("DataVersion".into(), Nbt::Int(data_version));
    root.insert("Width".into(), Nbt::Short(s.w as i16));
    root.insert("Height".into(), Nbt::Short(s.h as i16));
    root.insert("Length".into(), Nbt::Short(s.l as i16));
    root.insert("PaletteMax".into(), Nbt::Int(pal.len() as i32));
    root.insert("Palette".into(), Nbt::Compound(palette));
    root.insert("BlockData".into(), Nbt::ByteArray(fastnbt::ByteArray::new(bytes)));
    root.insert("Offset".into(), Nbt::IntArray(fastnbt::IntArray::new(vec![-s.origin.0, -s.origin.1, -s.origin.2])));
    root.insert("BlockEntities".into(), Nbt::List(vec![]));
    let out = fastnbt::to_bytes(&Nbt::Compound(root)).map_err(|e| anyhow!("{e}"))?;
    if let Some(dir) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let f = std::fs::File::create(path)?;
    let mut gz = GzEncoder::new(f, flate2::Compression::default());
    gz.write_all(&out)?;
    gz.finish()?;
    Ok(())
}

// ---------------------------------------------------------------- built-ins

pub const BUILTINS: &[(&str, &str)] = &[
    ("tower", "stone watchtower with crenellations (size = height, default 16)"),
    ("ruin", "broken mossy stone walls (size = footprint, default 11)"),
    ("house", "small timber cottage (size = width, default 7)"),
    ("windmill", "stone base, wooden body and 4 sails (size = height, default 14)"),
    ("fossil", "giant bone spine arc with ribs (size = length, default 40)"),
    ("obelisk", "tapering stone needle (size = height, default 20)"),
    ("fortress", "nether-brick fort with corner towers (size = side, default 31)"),
    ("gate", "stone archway, good for zone gates (size = width, default 7)"),
    ("well", "cobblestone well with roof (size ignored)"),
];

pub fn builtin(kind: &str, size: i32, rng: &mut Rng, mat: Option<&str>) -> Result<Schematic> {
    let id = |n: &str| blocks::id(n);
    let m = |d: &str| blocks::id(mat.unwrap_or(d));
    let s = match kind {
        "tower" => {
            let h = if size > 0 { size } else { 16 };
            let r = 3;
            let mut s = Schematic::new(2 * r + 3, h + 4, 2 * r + 3);
            let (cx, cz) = (r + 1, r + 1);
            let wall = m("stone_bricks");
            let mossy = id("mossy_stone_bricks");
            let floor = id("spruce_planks");
            for y in 0..h {
                for z in 0..s.l {
                    for x in 0..s.w {
                        let d = (((x - cx).pow(2) + (z - cz).pow(2)) as f64).sqrt();
                        if d <= r as f64 + 0.5 && d > r as f64 - 0.7 {
                            s.set(x, y, z, if rng.chance(0.15) { mossy } else { wall });
                        } else if d <= r as f64 - 0.7 && (y == 0 || y % 6 == 5) {
                            s.set(x, y, z, floor);
                        }
                    }
                }
            }
            // top platform + crenellations
            for z in 0..s.l {
                for x in 0..s.w {
                    let d = (((x - cx).pow(2) + (z - cz).pow(2)) as f64).sqrt();
                    if d <= r as f64 + 1.5 {
                        s.set(x, h, z, wall);
                        if d > r as f64 + 0.5 && (x + z) % 2 == 0 {
                            s.set(x, h + 1, z, wall);
                        }
                    }
                }
            }
            s.set(cx, h + 1, cz, id("lantern"));
            for y in 1..3 {
                s.set(cx, y, cz - r, AIR); // door
            }
            s.origin = (cx, 0, cz);
            s
        }
        "ruin" => {
            let n = if size > 0 { size } else { 11 };
            let mut s = Schematic::new(n, 6, n);
            let mats = [id("stone_bricks"), id("mossy_stone_bricks"), id("cracked_stone_bricks"), id("cobblestone"), id("mossy_cobblestone")];
            for z in 0..n {
                for x in 0..n {
                    let edge = x == 0 || z == 0 || x == n - 1 || z == n - 1;
                    if edge {
                        let hh = rng.range(0, 5);
                        for y in 0..hh {
                            s.set(x, y, z, mats[rng.range(0, 4) as usize]);
                        }
                    } else if rng.chance(0.3) {
                        s.set(x, 0, z, mats[rng.range(0, 4) as usize]);
                    }
                }
            }
            s
        }
        "house" => {
            let wdt = if size > 0 { size.max(5) } else { 7 };
            let len = wdt + 2;
            let wall_h = 4;
            let roof_h = wdt / 2 + 1;
            let mut s = Schematic::new(wdt + 2, wall_h + roof_h + 2, len + 2);
            let (planks, log, glass, roof) = (m("oak_planks"), id("oak_log"), id("glass_pane"), id("spruce_planks"));
            let cob = id("cobblestone");
            for z in 1..=len {
                for x in 1..=wdt {
                    s.set(x, 0, z, cob);
                    let edge_x = x == 1 || x == wdt;
                    let edge_z = z == 1 || z == len;
                    if edge_x || edge_z {
                        for y in 1..=wall_h {
                            let corner = edge_x && edge_z;
                            let b = if corner { log } else if y == 2 && ((edge_x && z % 3 == 0) || (edge_z && x % 3 == 0)) { glass } else { planks };
                            s.set(x, y, z, b);
                        }
                    }
                }
            }
            // door
            s.set(wdt / 2 + 1, 1, 1, AIR);
            s.set(wdt / 2 + 1, 2, 1, AIR);
            // gable roof along z
            for k in 0..=roof_h {
                for z in 0..=len + 1 {
                    for x in [k, wdt + 1 - k] {
                        s.set(x, wall_h + 1 + k, z, roof);
                    }
                    if k > 0 {
                        for x in (k + 1)..(wdt + 1 - k) {
                            if z == 1 || z == len {
                                s.set(x, wall_h + k, z, planks);
                            }
                        }
                    }
                }
            }
            s.set(wdt / 2 + 1, wall_h, len / 2, id("lantern"));
            s.origin = (wdt / 2 + 1, 0, len / 2 + 1);
            s
        }
        "windmill" => {
            let h = if size > 0 { size.max(10) } else { 14 };
            let sail = h * 2 / 3;
            let mut s = Schematic::new(2 * sail + 3, h + sail + 2, 9);
            let c = sail + 1;
            let (stone, wood, wool, fence) = (id("cobblestone"), m("spruce_planks"), id("white_wool"), id("oak_fence"));
            for y in 0..h {
                let r = if y < h / 3 { 3 } else { 2 };
                for z in 0..9 {
                    for x in (c - 4)..=(c + 4) {
                        let d = (((x - c).pow(2) + (z - 4i32).pow(2)) as f64).sqrt();
                        if d <= r as f64 + 0.5 && d > r as f64 - 0.6 {
                            s.set(x, y, z, if y < h / 3 { stone } else { wood });
                        }
                    }
                }
            }
            for z in 2..=6 {
                for x in (c - 2)..=(c + 2) {
                    s.set(x, h, z, id("dark_oak_planks"));
                }
            }
            // hub + sails in the x-y plane at z = 0
            let hub_y = h - 2;
            s.set(c, hub_y, 1, id("oak_log[axis=z]"));
            s.set(c, hub_y, 0, id("oak_log[axis=z]"));
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                for k in 1..=sail {
                    let (x, y) = (c + dx * k, hub_y + dy * k);
                    s.set(x, y, 0, fence);
                    if k > 2 {
                        let (ox, oy) = (-dy, dx); // sail cloth to one side
                        s.set(x + ox, y + oy, 0, wool);
                        s.set(x + 2 * ox, y + 2 * oy, 0, wool);
                    }
                }
            }
            s.origin = (c, 0, 4);
            s
        }
        "fossil" => {
            let len = if size > 0 { size.max(12) } else { 40 };
            let ht = len / 3;
            let mut s = Schematic::new(len + 2, ht + 6, 13);
            let bone = id("bone_block");
            for i in 0..len {
                let t = i as f64 / (len - 1) as f64;
                let y = (ht as f64 * (std::f64::consts::PI * t).sin() * 0.9) as i32 + 1;
                s.set(i + 1, y, 6, id("bone_block[axis=x]"));
                if i % 3 == 0 && t > 0.1 && t < 0.85 {
                    let rib = (5.0 * (std::f64::consts::PI * t).sin()) as i32 + 2;
                    for k in 1..=rib {
                        let dy = -(k * k) / (rib + 2);
                        s.set(i + 1, y + dy, 6 + k, bone);
                        s.set(i + 1, y + dy, 6 - k, bone);
                    }
                }
            }
            // skull
            for dy in 0..3 {
                for dz in -1..=1 {
                    for dx in 0..3 {
                        s.set(len - 2 + dx.min(1), 1 + dy, 6 + dz, bone);
                    }
                }
            }
            s.origin = (len / 2, 0, 6);
            s
        }
        "obelisk" => {
            let h = if size > 0 { size } else { 20 };
            let mut s = Schematic::new(7, h + 2, 7);
            let b = m("polished_blackstone_bricks");
            for y in 0..h {
                let r = if y < 2 { 3 } else if y < h / 3 { 2 } else if y < h - 3 { 1 } else { 0 };
                for z in (3 - r)..=(3 + r) {
                    for x in (3 - r)..=(3 + r) {
                        s.set(x, y, z, b);
                    }
                }
            }
            s.set(3, h, 3, id("glowstone"));
            s.origin = (3, 0, 3);
            s
        }
        "fortress" => {
            let n = if size > 0 { size.max(15) } else { 31 };
            let wall_h = 7;
            let mut s = Schematic::new(n + 4, wall_h + 6, n + 4);
            let (b, nb) = (m("nether_bricks"), id("red_nether_bricks"));
            let o = 2;
            for z in 0..n {
                for x in 0..n {
                    let edge = x == 0 || z == 0 || x == n - 1 || z == n - 1;
                    s.set(x + o, 0, z + o, b);
                    if edge {
                        for y in 1..=wall_h {
                            s.set(x + o, y, z + o, if y == wall_h && (x + z) % 2 == 0 { AIR } else { b });
                        }
                    }
                }
            }
            for (cx, cz) in [(0, 0), (n - 1, 0), (0, n - 1), (n - 1, n - 1)] {
                for y in 0..wall_h + 4 {
                    for dz in -2i32..=2 {
                        for dx in -2i32..=2 {
                            if dx.abs() == 2 || dz.abs() == 2 || y == wall_h + 3 {
                                s.set(cx + o + dx, y, cz + o + dz, nb);
                            }
                        }
                    }
                }
                s.set(cx + o, wall_h + 4, cz + o, id("soul_lantern"));
            }
            for y in 1..4 {
                s.set(n / 2 + o, y, o, AIR);
            }
            s.origin = (n / 2 + o, 0, n / 2 + o);
            s
        }
        "gate" => {
            let wdt = if size > 0 { size.max(3) } else { 7 };
            let h = wdt + 2;
            let mut s = Schematic::new(wdt + 2, h + 2, 3);
            let b = m("stone_bricks");
            for y in 0..h {
                for z in 0..3 {
                    s.set(0, y, z, b);
                    s.set(wdt + 1, y, z, b);
                }
            }
            for x in 0..wdt + 2 {
                for z in 0..3 {
                    s.set(x, h, z, b);
                    s.set(x, h + 1, z, if x % 2 == 0 { b } else { AIR });
                }
            }
            s.set(1, h - 1, 1, id("lantern[hanging=true]"));
            s.set(wdt, h - 1, 1, id("lantern[hanging=true]"));
            s.origin = (wdt / 2 + 1, 0, 1);
            s
        }
        "well" => {
            let mut s = Schematic::new(5, 6, 5);
            let (c, f, w) = (id("cobblestone"), id("oak_fence"), id("water"));
            for z in 0..5 {
                for x in 0..5 {
                    let edge = x == 0 || z == 0 || x == 4 || z == 4;
                    s.set(x, 0, z, c);
                    if edge {
                        s.set(x, 1, z, c);
                    } else {
                        s.set(x, 1, z, w);
                    }
                    s.set(x, 5, z, id("oak_slab"));
                }
            }
            for (x, z) in [(0, 0), (4, 0), (0, 4), (4, 4)] {
                for y in 2..5 {
                    s.set(x, y, z, f);
                }
            }
            s.origin = (2, 0, 2);
            s
        }
        other => bail!("unknown structure '{other}'. Built-ins: {}", BUILTINS.iter().map(|b| b.0).collect::<Vec<_>>().join(", ")),
    };
    Ok(s)
}

/// Rotation argument: 0/90/180/270 degrees or "random".
pub fn turns_arg(a: &Value, seed: u64) -> i32 {
    match a.get("rotate") {
        Some(Value::String(s)) if s == "random" => (seed % 4) as i32,
        Some(_) => (spec::f(a, "rotate", 0.0) / 90.0).round() as i32,
        None => 0,
    }
}

pub fn summary(name: &str, n: u64, at: (i32, i32, i32)) -> String {
    format!("{name}: {} blocks at {},{},{}", fmt_n(n), at.0, at.1, at.2)
}
