//! Procedural trees, forests and flora.

use super::{column_mask, fmt_n};
use crate::blocks::{self, BlockId, BlockInfo, Kind, AIR};
use crate::noise::{self, Rng};
use crate::spec::{self, Area, Mask, Pattern};
use crate::world::World;
use anyhow::{bail, Result};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

pub const TREE_TYPES: &[&str] = &[
    "oak", "birch", "spruce", "pine", "giant_spruce", "dark_oak", "pale_oak", "cherry", "acacia", "jungle", "dead", "bush",
    "red_mushroom", "brown_mushroom", "crimson_fungus", "warped_fungus", "glowcap",
];

struct Builder {
    blocks: Vec<(i32, i32, i32, BlockId, bool)>, // x,y,z,id,is_log
}

impl Builder {
    fn new() -> Self {
        Builder { blocks: vec![] }
    }
    fn log(&mut self, x: i32, y: i32, z: i32, id: BlockId) {
        self.blocks.push((x, y, z, id, true));
    }
    fn leaf(&mut self, x: i32, y: i32, z: i32, id: BlockId) {
        self.blocks.push((x, y, z, id, false));
    }
    fn disc(&mut self, cx: i32, y: i32, cz: i32, r: f64, id: BlockId, rng: &mut Rng, ragged: f64) {
        let ri = r.ceil() as i32;
        for dz in -ri..=ri {
            for dx in -ri..=ri {
                let d = ((dx * dx + dz * dz) as f64).sqrt();
                if d <= r && !(d > r - 1.0 && rng.chance(ragged)) {
                    self.leaf(cx + dx, y, cz + dz, id);
                }
            }
        }
    }
    fn blob(&mut self, cx: i32, cy: i32, cz: i32, rx: f64, ry: f64, id: BlockId, rng: &mut Rng) {
        let (ix, iy) = (rx.ceil() as i32, ry.ceil() as i32);
        for dy in -iy..=iy {
            for dz in -ix..=ix {
                for dx in -ix..=ix {
                    let d = (dx as f64 / rx).powi(2) + (dy as f64 / ry).powi(2) + (dz as f64 / rx).powi(2);
                    if d <= 1.0 && !(d > 0.7 && rng.chance(0.35)) {
                        self.leaf(cx + dx, cy + dy, cz + dz, id);
                    }
                }
            }
        }
    }
    /// Place into the world. Logs replace air/plants/leaves; leaves only air/plants.
    fn place(&self, w: &mut World, bx: i32, by: i32, bz: i32, infos: &[BlockInfo]) -> u64 {
        let mut n = 0;
        for &(x, y, z, id, is_log) in &self.blocks {
            let (gx, gy, gz) = (bx + x, by + y, bz + z);
            let cur = w.get(gx, gy, gz);
            let k = infos.get(cur as usize).map(|i| i.kind).unwrap_or(Kind::Air);
            let ok = match k {
                Kind::Air | Kind::Plant => true,
                Kind::Foliage => is_log,
                _ => false,
            };
            if ok && w.set(gx, gy, gz, id) {
                n += 1;
            }
        }
        n
    }
}

fn st(name: &str) -> BlockId {
    blocks::id(name)
}

fn leaves(kind: &str) -> BlockId {
    st(&format!("{kind}_leaves[persistent=true]"))
}

/// Build a tree of `kind` with base at (0,0,0) = first log block.
fn build(kind: &str, rng: &mut Rng, log_o: Option<BlockId>, leaf_o: Option<BlockId>, scale: f64) -> Result<Builder> {
    let mut b = Builder::new();
    let s = |v: i32| ((v as f64) * scale).round().max(1.0) as i32;
    match kind {
        "oak" | "birch" => {
            let log = log_o.unwrap_or(st(&format!("{kind}_log")));
            let lf = leaf_o.unwrap_or(leaves(kind));
            let h = s(rng.range(if kind == "birch" { 5 } else { 4 }, if kind == "birch" { 7 } else { 6 }));
            for y in 0..h {
                b.log(0, y, 0, log);
            }
            let r = 2.0 * scale.max(0.8);
            b.disc(0, h - 2, 0, r + 0.5, lf, rng, 0.5);
            b.disc(0, h - 1, 0, r + 0.5, lf, rng, 0.5);
            b.disc(0, h, 0, (r - 1.0).max(1.0) + 0.4, lf, rng, 0.3);
            b.disc(0, h + 1, 0, 1.0, lf, rng, 0.6);
        }
        "spruce" | "pine" | "giant_spruce" => {
            let log = log_o.unwrap_or(st("spruce_log"));
            let lf = leaf_o.unwrap_or(leaves("spruce"));
            let giant = kind == "giant_spruce";
            let h = s(match kind {
                "pine" => rng.range(11, 15),
                "giant_spruce" => rng.range(20, 28),
                _ => rng.range(7, 12),
            });
            let t = if giant { 2 } else { 1 };
            for y in 0..h {
                for dx in 0..t {
                    for dz in 0..t {
                        b.log(dx, y, dz, log);
                    }
                }
            }
            let start = match kind {
                "pine" => h * 2 / 3,
                _ => rng.range(2, 3),
            };
            let maxr = if giant { 5.5 } else if kind == "pine" { 2.2 } else { 3.2 } * scale.max(0.7);
            for y in start..=h {
                let f = 1.0 - (y - start) as f64 / (h - start + 1) as f64;
                let mut r = maxr * f;
                if (h - y) % 2 == 1 {
                    r *= 0.6;
                }
                if r < 0.6 {
                    r = 0.6;
                }
                b.disc(0, y, 0, r + if giant { 0.5 } else { 0.0 }, lf, rng, 0.25);
            }
            b.leaf(0, h + 1, 0, lf);
        }
        "dark_oak" | "pale_oak" => {
            let log = log_o.unwrap_or(st(&format!("{kind}_log")));
            let lf = leaf_o.unwrap_or(leaves(kind));
            let h = s(rng.range(6, 9));
            for y in 0..h {
                for (dx, dz) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    b.log(dx, y, dz, log);
                }
            }
            let r = 4.5 * scale.max(0.7);
            b.disc(0, h - 1, 0, r, lf, rng, 0.5);
            b.disc(0, h, 0, r + 0.3, lf, rng, 0.4);
            b.disc(0, h + 1, 0, r - 1.2, lf, rng, 0.4);
            if kind == "pale_oak" {
                // hanging moss
                for _ in 0..6 {
                    let (dx, dz) = (rng.range(-3, 3), rng.range(-3, 3));
                    b.leaf(dx, h - 2, dz, st("pale_hanging_moss"));
                }
            }
        }
        "cherry" => {
            let log = log_o.unwrap_or(st("cherry_log"));
            let lf = leaf_o.unwrap_or(leaves("cherry"));
            let h = s(rng.range(5, 7));
            for y in 0..h {
                b.log(0, y, 0, log);
            }
            for (dx, dz) in [(1, 0), (-1, 0)] {
                for k in 1..=2 {
                    b.log(dx * k, h - 2 + k, dz, log);
                }
                b.blob(dx * 3, h + 1, dz, 3.2 * scale.max(0.7), 2.0, lf, rng);
            }
        }
        "acacia" => {
            let log = log_o.unwrap_or(st("acacia_log"));
            let lf = leaf_o.unwrap_or(leaves("acacia"));
            let h = s(rng.range(5, 7));
            let (dx, dz) = [(1, 0), (-1, 0), (0, 1), (0, -1)][rng.range(0, 3) as usize];
            let mut x = 0;
            let mut z = 0;
            for y in 0..h {
                if y >= h / 2 {
                    x += dx;
                    z += dz;
                }
                b.log(x, y, z, log);
            }
            b.disc(x, h, z, 3.5 * scale.max(0.7), lf, rng, 0.3);
            b.disc(x, h + 1, z, 1.8, lf, rng, 0.2);
        }
        "jungle" => {
            let log = log_o.unwrap_or(st("jungle_log"));
            let lf = leaf_o.unwrap_or(leaves("jungle"));
            let h = s(rng.range(10, 16));
            for y in 0..h {
                b.log(0, y, 0, log);
            }
            b.blob(0, h, 0, 3.5 * scale.max(0.7), 2.5, lf, rng);
        }
        "dead" => {
            let log = log_o.unwrap_or(st("oak_log"));
            let h = s(rng.range(4, 7));
            for y in 0..h {
                b.log(0, y, 0, log);
            }
            let (dx, dz) = [(1, 0), (-1, 0), (0, 1), (0, -1)][rng.range(0, 3) as usize];
            b.log(dx, h - 2, dz, log);
            b.log(dx * 2, h - 1, dz * 2, log);
        }
        "bush" => {
            let log = log_o.unwrap_or(st("oak_log"));
            let lf = leaf_o.unwrap_or(leaves("oak"));
            b.log(0, 0, 0, log);
            b.blob(0, 1, 0, 1.8 * scale.max(0.7), 1.2, lf, rng);
        }
        "red_mushroom" | "brown_mushroom" | "glowcap" => {
            let stem = log_o.unwrap_or(st("mushroom_stem"));
            let cap = leaf_o.unwrap_or(match kind {
                "red_mushroom" => st("red_mushroom_block"),
                "brown_mushroom" => st("brown_mushroom_block"),
                _ => st("purple_wool"),
            });
            let h = s(if kind == "glowcap" { rng.range(8, 14) } else { rng.range(5, 8) });
            for y in 0..h {
                b.log(0, y, 0, stem);
            }
            let r = (if kind == "glowcap" { 4.5 } else { 3.2 }) * scale.max(0.7);
            if kind == "brown_mushroom" {
                b.disc(0, h, 0, r + 0.5, cap, rng, 0.0);
            } else {
                let ri = r.ceil() as i32;
                for dy in 0..=ri {
                    for dz in -ri..=ri {
                        for dx in -ri..=ri {
                            let d = ((dx * dx + dz * dz) as f64 + (dy as f64 * 1.6).powi(2)).sqrt();
                            if d <= r && d > r - 1.5 {
                                b.blocks.push((dx, h - 1 + dy, dz, cap, true));
                            }
                        }
                    }
                }
                if kind == "glowcap" {
                    let glow = st("shroomlight");
                    for _ in 0..5 {
                        let (dx, dz) = (rng.range(-ri + 1, ri - 1), rng.range(-ri + 1, ri - 1));
                        b.blocks.push((dx, h - 2, dz, glow, true));
                    }
                }
            }
        }
        "crimson_fungus" | "warped_fungus" => {
            let (stem, wart) = if kind == "crimson_fungus" { ("crimson_stem", "nether_wart_block") } else { ("warped_stem", "warped_wart_block") };
            let stem = log_o.unwrap_or(st(stem));
            let wart = leaf_o.unwrap_or(st(wart));
            let h = s(rng.range(6, 11));
            for y in 0..h {
                b.log(0, y, 0, stem);
            }
            let r = 3.0 * scale.max(0.7);
            for y in (h - 3)..=h {
                let rr = r * (1.0 - (y - (h - 3)) as f64 / 4.0) + 0.6;
                b.disc(0, y, 0, rr, wart, rng, 0.25);
            }
            let glow = st("shroomlight");
            for _ in 0..3 {
                b.leaf(rng.range(-2, 2), h - 2, rng.range(-2, 2), glow);
            }
        }
        other => bail!("unknown tree type '{other}'. Types: {}", TREE_TYPES.join(", ")),
    }
    Ok(b)
}

const DEFAULT_GROUND: &str = "grass_block,dirt,podzol,coarse_dirt,rooted_dirt,moss_block,mycelium,snow_block,crimson_nylium,warped_nylium,netherrack,soul_soil,mud,pale_moss_block";

/// Weighted list "70%spruce,30%birch" → [(name, cum)].
fn weighted(s: &str) -> Vec<(String, f64)> {
    let mut v = vec![];
    let mut tot = 0.0;
    for p in spec::split_top(s, ',') {
        let (w, n) = match p.find('%') {
            Some(i) => (p[..i].trim().parse::<f64>().unwrap_or(1.0), p[i + 1..].trim().to_string()),
            None => (1.0, p.trim().to_string()),
        };
        tot += w;
        v.push((n, tot));
    }
    for e in &mut v {
        e.1 /= tot.max(1e-9);
    }
    v
}

pub fn op_tree(w: &mut World, a: &Value) -> Result<String> {
    let kind = spec::s(a, "type").unwrap_or("oak");
    let infos = blocks::infos();
    let p = spec::point(spec::req_s(a, "at")?, w, &infos)?;
    let log_o = spec::s(a, "log").map(blocks::id);
    let leaf_o = spec::s(a, "leaves").map(blocks::id);
    let mut rng = Rng::new(spec::i(a, "seed", (p.x as i64) * 31 + p.z as i64) as u64);
    let b = build(kind, &mut rng, log_o, leaf_o, spec::f(a, "scale", 1.0))?;
    let infos = blocks::infos();
    let n = b.place(w, p.x.floor() as i32, p.y.floor() as i32, p.z.floor() as i32, &infos);
    Ok(format!("{kind} tree placed ({n} blocks)"))
}

/// Scatter trees in an area with natural clumping.
pub fn op_forest(w: &mut World, a: &Value) -> Result<String> {
    let types = weighted(spec::s(a, "types").or_else(|| spec::s(a, "type")).unwrap_or("oak"));
    for (t, _) in &types {
        if !TREE_TYPES.contains(&t.as_str()) {
            bail!("unknown tree type '{t}'. Types: {}", TREE_TYPES.join(", "));
        }
    }
    let log_o = spec::s(a, "log").map(blocks::id);
    let leaf_o = spec::s(a, "leaves").map(blocks::id);
    let ground = Mask::parse(spec::s(a, "on").unwrap_or(DEFAULT_GROUND))?;
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let spacing = spec::f(a, "spacing", 7.0).max(2.0);
    let density = spec::f(a, "density", 0.7).clamp(0.0, 1.0);
    let clump = spec::f(a, "clump", 0.5).clamp(0.0, 1.0);
    let max_count = spec::i(a, "count", i64::MAX) as usize;
    let max_slope = spec::i(a, "max_slope", 3) as i32;
    let scale = spec::f(a, "scale", 1.0);
    let seed = w.seed ^ (spec::i(a, "seed", 77) as u32);
    let (x0, z0, x1, z1) = area.bbox(w);
    let mut spots = vec![];
    let s = spacing as i32;
    let mut gz = z0;
    while gz < z1 {
        let mut gx = x0;
        while gx < x1 {
            let h = noise::hash2(seed, gx, gz);
            let x = gx + (noise::unit(h) * spacing) as i32;
            let z = gz + (noise::unit(noise::hash2(seed ^ 1, gx, gz)) * spacing) as i32;
            gx += s;
            if x >= x1 || z >= z1 || !area.contains(x, z, w) {
                continue;
            }
            let cl = (noise::fbm2(seed ^ 2, x as f64, z as f64, 70.0, 3) + 1.0) / 2.0;
            let p = density * ((1.0 - clump) + clump * (cl * 2.0).min(1.0) * cl * 1.6).min(1.0);
            if noise::unit(noise::hash2(seed ^ 3, x, z)) >= p {
                continue;
            }
            let Some(g) = w.ground(x, z, &infos) else { continue };
            if !ground.test(w.get(x, g, z), &infos) {
                continue;
            }
            let above = w.get(x, g + 1, z);
            if !matches!(infos[above as usize].kind, Kind::Air | Kind::Plant) {
                continue;
            }
            // slope check
            let mut sl = 0;
            for (dx, dz) in [(2, 0), (-2, 0), (0, 2), (0, -2)] {
                if let Some(n) = w.ground(x + dx, z + dz, &infos) {
                    sl = sl.max((n - g).abs());
                }
            }
            if sl > max_slope {
                continue;
            }
            spots.push((x, g + 1, z));
        }
        gz += s;
    }
    spots.truncate(max_count);
    let mut placed = 0u64;
    let mut blocks_n = 0u64;
    let mut counts: std::collections::BTreeMap<String, u64> = Default::default();
    for (i, &(x, y, z)) in spots.iter().enumerate() {
        let r = noise::unit(noise::hash2(seed ^ 4, x, z));
        let kind = &types.iter().find(|(_, c)| r < *c).unwrap_or(types.last().unwrap()).0;
        let mut rng = Rng::new((seed as u64) << 20 ^ i as u64 ^ ((x as u64) << 32) ^ z as u64);
        let sc = scale * (0.8 + 0.4 * rng.f());
        let b = build(kind, &mut rng, log_o, leaf_o, sc)?;
        let infos = blocks::infos();
        let n = b.place(w, x, y, z, &infos);
        if n > 0 {
            placed += 1;
            blocks_n += n;
            *counts.entry(kind.clone()).or_default() += 1;
        }
    }
    let detail: Vec<String> = counts.iter().map(|(k, v)| format!("{k} {v}")).collect();
    Ok(format!("{} trees ({}) in {}, {} blocks", fmt_n(placed), detail.join(", "), area.describe(w), fmt_n(blocks_n)))
}

/// Scatter single-block plants on suitable ground.
pub fn op_flora(w: &mut World, a: &Value) -> Result<String> {
    let plants_s = spec::s(a, "plants").unwrap_or("60%short_grass,10%fern,8%dandelion,8%poppy,6%oxeye_daisy,4%cornflower,4%azure_bluet");
    let plants = Pattern::parse(plants_s)?;
    let on = Mask::parse(spec::s(a, "on").unwrap_or("grass_block,moss_block,podzol,crimson_nylium,warped_nylium,mycelium,pale_moss_block"))?;
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let density = spec::f(a, "density", 0.25).clamp(0.0, 1.0);
    let patch = spec::f(a, "patchiness", 0.4).clamp(0.0, 1.0);
    let (x0, z0, x1, z1) = area.bbox(w);
    let inside = column_mask(w, &area, x0, z0, x1, z1);
    let wd = x1 - x0;
    let min_y = w.min_y;
    let seed = w.seed ^ 0xf10;
    let n = AtomicU64::new(0);
    w.par_chunks(x0, z0, x1, z1, |ch, cx, cz| {
        let mut changed = false;
        let mut cnt = 0;
        for lz in 0..16 {
            for lx in 0..16 {
                let (gx, gz) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                if gx < x0 || gz < z0 || gx >= x1 || gz >= z1 || !inside[((gz - z0) * wd + (gx - x0)) as usize] {
                    continue;
                }
                let pn = (noise::fbm2(seed, gx as f64, gz as f64, 18.0, 2) + 1.0) / 2.0;
                let p = density * ((1.0 - patch) + patch * pn * 2.0).min(1.0);
                if noise::unit(noise::hash2(seed ^ 9, gx, gz)) >= p {
                    continue;
                }
                let Some(yi) = ch.top_where(lx, lz, &infos, |b| b.kind != Kind::Air) else { continue };
                if !on.test(ch.get(lx, yi, lz), &infos) {
                    continue;
                }
                if yi + 1 >= ch.sections.len() * 16 || ch.get(lx, yi + 1, lz) != AIR {
                    continue;
                }
                let y = yi as i32 + 1 + min_y;
                if ch.set(lx, yi + 1, lz, plants.pick(gx, y, gz, seed)) {
                    changed = true;
                    cnt += 1;
                }
            }
        }
        n.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    Ok(format!("{} plants in {}", fmt_n(n.into_inner()), area.describe(w)))
}
