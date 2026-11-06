//! Edit operations. Each returns a short human/LLM-readable summary.

pub mod nature;
pub mod structures;
pub mod terrain;
pub mod water;

use crate::blocks::{self, BlockInfo, Kind, AIR};
use crate::expr::{Ctx, Expr};
use crate::spec::{self, Area, Mask, Pattern, P3};
use crate::world::{Chunk, World};
use anyhow::{bail, Result};
use rayon::prelude::*;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

pub fn fmt_n(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------- heightmaps

/// Ground heightmap of a rectangle: highest *solid* block per column
/// (ignores water, leaves, logs, plants). `i32::MIN` = empty column.
pub struct HMap {
    pub x0: i32,
    pub z0: i32,
    pub w: i32,
    pub h: i32,
    pub y: Vec<i32>,
}

pub const EMPTY: i32 = i32::MIN;

impl HMap {
    pub fn read(world: &World, x0: i32, z0: i32, x1: i32, z1: i32, infos: &[BlockInfo]) -> HMap {
        let (w, h) = ((x1 - x0).max(0), (z1 - z0).max(0));
        let y: Vec<i32> = (0..h)
            .into_par_iter()
            .flat_map_iter(|dz| {
                (0..w).map(move |dx| world.ground(x0 + dx, z0 + dz, infos).unwrap_or(EMPTY))
            })
            .collect();
        HMap { x0, z0, w, h, y }
    }

    #[inline]
    pub fn get(&self, x: i32, z: i32) -> Option<i32> {
        let (dx, dz) = (x - self.x0, z - self.z0);
        if dx < 0 || dz < 0 || dx >= self.w || dz >= self.h {
            return None;
        }
        let v = self.y[(dz * self.w + dx) as usize];
        if v == EMPTY {
            None
        } else {
            Some(v)
        }
    }

    /// Clamped lookup (edges extend outward); falls back to `d`.
    pub fn get_c(&self, x: i32, z: i32, d: i32) -> i32 {
        let x = x.clamp(self.x0, self.x0 + self.w - 1);
        let z = z.clamp(self.z0, self.z0 + self.h - 1);
        self.get(x, z).unwrap_or(d)
    }

    pub fn idx(&self, x: i32, z: i32) -> usize {
        ((z - self.z0) * self.w + (x - self.x0)) as usize
    }

    /// Max height difference to the 4 neighbours.
    pub fn slope(&self, x: i32, z: i32) -> i32 {
        let Some(c) = self.get(x, z) else { return 0 };
        let mut m = 0;
        for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let n = self.get_c(x + dx, z + dz, c);
            m = m.max((n - c).abs());
        }
        m
    }
}

/// Write a new ground height for each column. `newh[i]` uses `hm` indexing;
/// `EMPTY` means unchanged. When raising, the column is filled with
/// `material` (or the existing surface/subsurface blocks); when lowering the
/// surface block is moved down so grass stays grass.
pub fn apply_heights(world: &mut World, hm: &HMap, newh: &[i32], material: Option<&Pattern>, seed: u32) -> u64 {
    let infos = blocks::infos();
    let (min_y, max_y) = (world.min_y, world.max_y() - 1);
    let stone = blocks::id("stone");
    let dirt = blocks::id("dirt");
    let cols = AtomicU64::new(0);
    world.par_chunks(hm.x0, hm.z0, hm.x0 + hm.w, hm.z0 + hm.h, |ch: &mut Chunk, cx, cz| {
        let mut changed = false;
        for lz in 0..16 {
            for lx in 0..16 {
                let (gx, gz) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                let dx = gx - hm.x0;
                let dz = gz - hm.z0;
                if dx < 0 || dz < 0 || dx >= hm.w || dz >= hm.h {
                    continue;
                }
                let i = (dz * hm.w + dx) as usize;
                let nh = newh[i];
                if nh == EMPTY {
                    continue;
                }
                let nh = nh.clamp(min_y, max_y);
                let old = hm.y[i];
                if old == nh {
                    continue;
                }
                let yi = |y: i32| (y - min_y) as usize;
                let (surf, sub) = if old == EMPTY {
                    (stone, stone)
                } else {
                    let s = ch.get(lx, yi(old), lz);
                    let b = if old - 1 >= min_y { ch.get(lx, yi(old - 1), lz) } else { stone };
                    let b = if infos[b as usize].solid() { b } else { dirt };
                    (s, b)
                };
                let old_eff = if old == EMPTY { min_y - 1 } else { old };
                if nh > old_eff {
                    // Clear a plant sitting on the old surface first.
                    for y in (old_eff + 1)..=nh {
                        let id = match material {
                            Some(p) => p.pick(gx, y, gz, seed),
                            None => {
                                if y == nh {
                                    surf
                                } else if nh - y <= 3 {
                                    sub
                                } else {
                                    // deep fill: stone unless the column was e.g. sand everywhere
                                    if infos[sub as usize].solid() && blocks::name(sub).contains("stone") { sub } else { stone }
                                }
                            }
                        };
                        changed |= ch.set(lx, yi(y), lz, id);
                    }
                } else {
                    for y in (nh + 1)..=old_eff {
                        changed |= ch.set(lx, yi(y), lz, AIR);
                    }
                    let top = match material {
                        Some(p) => p.pick(gx, nh, gz, seed),
                        None => surf,
                    };
                    changed |= ch.set(lx, yi(nh), lz, top);
                    // drop floating plants
                    let above = old_eff + 1;
                    if above <= max_y {
                        let b = ch.get(lx, yi(above), lz);
                        if infos[b as usize].kind == Kind::Plant {
                            changed |= ch.set(lx, yi(above), lz, AIR);
                        }
                    }
                }
                cols.fetch_add(1, Ordering::Relaxed);
            }
        }
        changed
    });
    cols.into_inner()
}

// ---------------------------------------------------------------- shapes

/// Fill all voxels inside a 3D predicate within a bbox, optionally masked.
fn fill_where<F>(world: &mut World, bb: (i32, i32, i32, i32, i32, i32), pattern: &Pattern, mask: Option<&Mask>, seed: u32, inside: F) -> u64
where
    F: Fn(i32, i32, i32) -> bool + Sync,
{
    let infos = blocks::infos();
    let table = mask.map(|m| m.table(&infos));
    let (x0, y0, z0, x1, y1, z1) = bb;
    let (min_y, max_y) = (world.min_y, world.max_y());
    let (y0, y1) = (y0.max(min_y), y1.min(max_y));
    let n = AtomicU64::new(0);
    world.par_chunks(x0, z0, x1, z1, |ch, cx, cz| {
        let mut changed = false;
        let mut cnt = 0;
        for lz in 0..16 {
            let gz = cz * 16 + lz as i32;
            if gz < z0 || gz >= z1 {
                continue;
            }
            for lx in 0..16 {
                let gx = cx * 16 + lx as i32;
                if gx < x0 || gx >= x1 {
                    continue;
                }
                for y in y0..y1 {
                    if !inside(gx, y, gz) {
                        continue;
                    }
                    let yi = (y - min_y) as usize;
                    if let Some(t) = &table {
                        let cur = ch.get(lx, yi, lz);
                        if !t.get(cur as usize).copied().unwrap_or(false) {
                            continue;
                        }
                    }
                    if ch.set(lx, yi, lz, pattern.pick(gx, y, gz, seed)) {
                        changed = true;
                        cnt += 1;
                    }
                }
            }
        }
        n.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    n.into_inner()
}

fn mask_arg(a: &Value) -> Result<Option<Mask>> {
    Ok(match spec::s(a, "mask").or_else(|| spec::s(a, "replace")) {
        Some(m) if !m.trim().is_empty() => Some(Mask::parse(m)?),
        _ => None,
    })
}

fn verb(p: &Pattern) -> &'static str {
    if p.single().map(blocks::is_air).unwrap_or(false) {
        "removed"
    } else {
        "set"
    }
}

pub fn op_box(w: &mut World, a: &Value) -> Result<String> {
    let pattern = Pattern::parse(spec::req_s(a, "pattern")?)?;
    let mask = mask_arg(a)?;
    let infos = blocks::infos();
    let p1 = spec::point(spec::req_s(a, "from")?, w, &infos)?;
    let p2 = spec::point(spec::req_s(a, "to")?, w, &infos)?;
    let hollow = spec::b(a, "hollow", false);
    let (x0, x1) = (p1.x.min(p2.x).floor() as i32, p1.x.max(p2.x).floor() as i32);
    let (y0, y1) = (p1.y.min(p2.y).floor() as i32, p1.y.max(p2.y).floor() as i32);
    let (z0, z1) = (p1.z.min(p2.z).floor() as i32, p1.z.max(p2.z).floor() as i32);
    let n = fill_where(w, (x0, y0, z0, x1 + 1, y1 + 1, z1 + 1), &pattern, mask.as_ref(), w.seed, |x, y, z| {
        !hollow || x == x0 || x == x1 || y == y0 || y == y1 || z == z0 || z == z1
    });
    Ok(format!("{} blocks {}", fmt_n(n), verb(&pattern)))
}

pub fn op_sphere(w: &mut World, a: &Value) -> Result<String> {
    let pattern = Pattern::parse(spec::req_s(a, "pattern")?)?;
    let mask = mask_arg(a)?;
    let infos = blocks::infos();
    let c = spec::point(spec::req_s(a, "at")?, w, &infos)?;
    let (rx, ry, rz) = radii(a, 8.0);
    let hollow = spec::b(a, "hollow", false);
    let bb = ((c.x - rx).floor() as i32, (c.y - ry).floor() as i32, (c.z - rz).floor() as i32, (c.x + rx).ceil() as i32 + 1, (c.y + ry).ceil() as i32 + 1, (c.z + rz).ceil() as i32 + 1);
    let n = fill_where(w, bb, &pattern, mask.as_ref(), w.seed, |x, y, z| {
        let d = ((x as f64 + 0.5 - c.x) / rx).powi(2) + ((y as f64 + 0.5 - c.y) / ry).powi(2) + ((z as f64 + 0.5 - c.z) / rz).powi(2);
        if hollow {
            let inner = ((x as f64 + 0.5 - c.x) / (rx - 1.0).max(0.5)).powi(2) + ((y as f64 + 0.5 - c.y) / (ry - 1.0).max(0.5)).powi(2) + ((z as f64 + 0.5 - c.z) / (rz - 1.0).max(0.5)).powi(2);
            d <= 1.0 && inner > 1.0
        } else {
            d <= 1.0
        }
    });
    Ok(format!("{} blocks {}", fmt_n(n), verb(&pattern)))
}

fn radii(a: &Value, d: f64) -> (f64, f64, f64) {
    match a.get("radius").or_else(|| a.get("radii")) {
        Some(Value::Array(v)) => {
            let f: Vec<f64> = v.iter().filter_map(|x| x.as_f64()).collect();
            match f.len() {
                1 => (f[0], f[0], f[0]),
                2 => (f[0], f[0], f[1]),
                n if n >= 3 => (f[0], f[1], f[2]),
                _ => (d, d, d),
            }
        }
        Some(Value::Number(n)) => {
            let r = n.as_f64().unwrap_or(d);
            (r, r, r)
        }
        Some(Value::String(s)) => {
            let f: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            match f.len() {
                1 => (f[0], f[0], f[0]),
                2 => (f[0], f[0], f[1]),
                n if n >= 3 => (f[0], f[1], f[2]),
                _ => (d, d, d),
            }
        }
        _ => (d, d, d),
    }
}

pub fn op_cyl(w: &mut World, a: &Value) -> Result<String> {
    let pattern = Pattern::parse(spec::req_s(a, "pattern")?)?;
    let mask = mask_arg(a)?;
    let infos = blocks::infos();
    let c = spec::point(spec::req_s(a, "at")?, w, &infos)?;
    let (rx, _, rz) = radii(a, 8.0);
    let height = spec::f(a, "height", 1.0);
    let hollow = spec::b(a, "hollow", false);
    let (ya, yb) = if height >= 0.0 { (c.y.floor() as i32, (c.y + height).floor() as i32) } else { ((c.y + height).floor() as i32, c.y.floor() as i32) };
    let bb = ((c.x - rx).floor() as i32, ya, (c.z - rz).floor() as i32, (c.x + rx).ceil() as i32 + 1, yb, (c.z + rz).ceil() as i32 + 1);
    let n = fill_where(w, bb, &pattern, mask.as_ref(), w.seed, |x, _y, z| {
        let d = ((x as f64 + 0.5 - c.x) / rx).powi(2) + ((z as f64 + 0.5 - c.z) / rz).powi(2);
        if hollow {
            let inner = ((x as f64 + 0.5 - c.x) / (rx - 1.0).max(0.5)).powi(2) + ((z as f64 + 0.5 - c.z) / (rz - 1.0).max(0.5)).powi(2);
            d <= 1.0 && inner > 1.0
        } else {
            d <= 1.0
        }
    });
    Ok(format!("{} blocks {}", fmt_n(n), verb(&pattern)))
}

pub fn op_line(w: &mut World, a: &Value) -> Result<String> {
    let pattern = Pattern::parse(spec::req_s(a, "pattern")?)?;
    let infos = blocks::infos();
    let pts = spec::points(a.get("points").unwrap_or(&Value::Null), w, &infos)?;
    if pts.len() < 2 {
        bail!("line needs at least 2 points");
    }
    let r = spec::f(a, "radius", 0.5).max(0.5);
    let mut n = 0u64;
    for seg in pts.windows(2) {
        let (p, q) = (seg[0], seg[1]);
        let len = ((q.x - p.x).powi(2) + (q.y - p.y).powi(2) + (q.z - p.z).powi(2)).sqrt();
        let steps = (len * 2.0).ceil().max(1.0) as i32;
        for s in 0..=steps {
            let t = s as f64 / steps as f64;
            let (cx, cy, cz) = (p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t);
            let ri = r.ceil() as i32;
            for dy in -ri..=ri {
                for dz in -ri..=ri {
                    for dx in -ri..=ri {
                        if (dx * dx + dy * dy + dz * dz) as f64 <= r * r {
                            let (x, y, z) = (cx.floor() as i32 + dx, cy.floor() as i32 + dy, cz.floor() as i32 + dz);
                            if w.set(x, y, z, pattern.pick(x, y, z, w.seed)) {
                                n += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(format!("{} blocks set along {} points", fmt_n(n), pts.len()))
}

pub fn op_replace(w: &mut World, a: &Value) -> Result<String> {
    let pattern = Pattern::parse(spec::req_s(a, "pattern")?)?;
    let from = Mask::parse(spec::s(a, "from").or_else(|| spec::s(a, "mask")).unwrap_or("#existing"))?;
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let (x0, z0, x1, z1) = area.bbox(w);
    let ymin = spec::i(a, "min_y", w.min_y as i64) as i32;
    let ymax = spec::i(a, "max_y", w.max_y() as i64 - 1) as i32;
    let wref: &World = w;
    let inside: Vec<bool> = column_mask(wref, &area, x0, z0, x1, z1);
    let wd = x1 - x0;
    let n = fill_where(w, (x0, ymin, z0, x1, ymax + 1, z1), &pattern, Some(&from), 7, |x, _, z| inside[((z - z0) * wd + (x - x0)) as usize]);
    Ok(format!("{} blocks replaced in {}", fmt_n(n), area.describe(w)))
}

/// Precompute area membership per column for a bbox.
pub fn column_mask(w: &World, area: &Area, x0: i32, z0: i32, x1: i32, z1: i32) -> Vec<bool> {
    let wd = (x1 - x0).max(0);
    (0..(z1 - z0).max(0))
        .into_par_iter()
        .flat_map_iter(|dz| (0..wd).map(move |dx| area.contains(x0 + dx, z0 + dz, w)))
        .collect()
}

/// `generate`: fill where `expression` is true (non-zero).
pub fn op_generate(w: &mut World, a: &Value) -> Result<String> {
    let pattern = Pattern::parse(spec::req_s(a, "pattern")?)?;
    let src = spec::req_s(a, "expression")?;
    let e = Expr::parse(src)?;
    let mask = mask_arg(a)?;
    let infos = blocks::infos();
    let table = mask.as_ref().map(|m| m.table(&infos));
    let area = Area::from_args(a, w, &infos)?;
    let (x0, z0, x1, z1) = area.bbox(w);
    let inside = column_mask(w, &area, x0, z0, x1, z1);
    let wd = x1 - x0;
    let top_hm = if src.contains("top(") { Some(HMap::read(w, x0 - 2, z0 - 2, x1 + 2, z1 + 2, &infos)) } else { None };
    let zones = w.zones.clone();
    let seed = w.seed;
    let (min_y, max_y) = (w.min_y, w.max_y() - 1);
    let lo = spec::i(a, "min_y", min_y as i64) as i32;
    let hi = spec::i(a, "max_y", max_y as i64) as i32;
    let colform = e.column_form();
    let topf = |x: i32, z: i32| -> f64 { top_hm.as_ref().map(|h| h.get_c(x, z, 0) as f64).unwrap_or(0.0) };
    let ctx = Ctx { zones: &zones, seed, top: if top_hm.is_some() { Some(&topf) } else { None } };
    let n = AtomicU64::new(0);
    let single = pattern.single();
    w.par_chunks(x0, z0, x1, z1, |ch, cx, cz| {
        let mut changed = false;
        let mut cnt = 0u64;
        for lz in 0..16 {
            for lx in 0..16 {
                let (gx, gz) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                if gx < x0 || gz < z0 || gx >= x1 || gz >= z1 || !inside[((gz - z0) * wd + (gx - x0)) as usize] {
                    continue;
                }
                let (fx, fz) = (gx as f64, gz as f64);
                let ok = |ch: &Chunk, yi: usize| -> bool {
                    match &table {
                        Some(t) => t.get(ch.get(lx, yi, lz) as usize).copied().unwrap_or(false),
                        None => true,
                    }
                };
                if let Some(cf) = &colform {
                    let (ya, yb) = cf.range(fx, fz, lo.max(min_y), hi.min(max_y), &ctx);
                    for y in ya..=yb {
                        let yi = (y - min_y) as usize;
                        if !ok(ch, yi) {
                            continue;
                        }
                        let id = single.unwrap_or_else(|| pattern.pick(gx, y, gz, seed));
                        if ch.set(lx, yi, lz, id) {
                            changed = true;
                            cnt += 1;
                        }
                    }
                } else {
                    for y in lo.max(min_y)..=hi.min(max_y) {
                        if e.eval(fx, y as f64, fz, &ctx) == 0.0 {
                            continue;
                        }
                        let yi = (y - min_y) as usize;
                        if !ok(ch, yi) {
                            continue;
                        }
                        if ch.set(lx, yi, lz, pattern.pick(gx, y, gz, seed)) {
                            changed = true;
                            cnt += 1;
                        }
                    }
                }
            }
        }
        n.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    w.compact_all();
    Ok(format!("{} blocks{}", fmt_n(n.into_inner()), if colform.is_some() { "" } else { " (per-voxel)" }))
}

pub fn op_biome(w: &mut World, a: &Value) -> Result<String> {
    let biome = spec::req_s(a, "biome")?;
    let bid = crate::world::biome_id(biome);
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let (x0, z0, x1, z1) = area.bbox(w);
    let mut n = 0;
    let mut x = x0 - x0.rem_euclid(4);
    while x < x1 {
        let mut z = z0 - z0.rem_euclid(4);
        while z < z1 {
            if area.contains(x + 2, z + 2, w) {
                w.set_biome(x, z, bid);
                n += 1;
            }
            z += 4;
        }
        x += 4;
    }
    Ok(format!("biome {} set on {} 4×4 cells", crate::world::biome_name(bid), fmt_n(n)))
}

/// Resample a polyline at ~1 block spacing.
pub fn resample(pts: &[P3]) -> Vec<P3> {
    let mut out = vec![];
    for seg in pts.windows(2) {
        let (p, q) = (seg[0], seg[1]);
        let len = ((q.x - p.x).powi(2) + (q.z - p.z).powi(2)).sqrt();
        let n = len.ceil().max(1.0) as usize;
        for i in 0..n {
            let t = i as f64 / n as f64;
            out.push(P3 { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
        }
    }
    if let Some(l) = pts.last() {
        out.push(*l);
    }
    out
}

/// Distance from (x,z) to a polyline; returns (dist, index into resampled path).
pub fn nearest_on_path(path: &[P3], cum: &[f64], x: f64, z: f64) -> (f64, f64) {
    // `path` is the coarse polyline, `cum` its cumulative lengths.
    let mut best = (f64::MAX, 0.0);
    for i in 0..path.len().saturating_sub(1) {
        let (p, q) = (path[i], path[i + 1]);
        let (dx, dz) = (q.x - p.x, q.z - p.z);
        let l2 = dx * dx + dz * dz;
        let t = if l2 > 0.0 { (((x - p.x) * dx + (z - p.z) * dz) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (px, pz) = (p.x + dx * t, p.z + dz * t);
        let d = ((x - px).powi(2) + (z - pz).powi(2)).sqrt();
        if d < best.0 {
            best = (d, cum[i] + t * l2.sqrt());
        }
    }
    if path.len() == 1 {
        let d = ((x - path[0].x).powi(2) + (z - path[0].z).powi(2)).sqrt();
        best = (d, 0.0);
    }
    best
}

pub fn cumulative(path: &[P3]) -> Vec<f64> {
    let mut c = vec![0.0];
    for i in 1..path.len() {
        let d = ((path[i].x - path[i - 1].x).powi(2) + (path[i].z - path[i - 1].z).powi(2)).sqrt();
        c.push(c[i - 1] + d);
    }
    c
}
