//! Heightfield brushes (Axiom-style): ridge, raise, smooth, flatten,
//! roughen, terrace, pit, carve, paint, overlay.

use super::{apply_heights, column_mask, cumulative, fmt_n, nearest_on_path, HMap, EMPTY};
use crate::blocks::{self, Kind, AIR};
use crate::noise;
use crate::spec::{self, Area, Mask, Pattern, P3};
use crate::world::World;
use anyhow::{bail, Result};
use rayon::prelude::*;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

fn smooth01(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Weight for normalised distance t = d/r.
fn falloff(t: f64, kind: &str) -> f64 {
    if t >= 1.0 {
        return 0.0;
    }
    match kind {
        "linear" => 1.0 - t,
        "flat" => 1.0 - smooth01((t - 0.7) / 0.3),
        "sharp" => (1.0 - t).powi(2),
        _ => 1.0 - smooth01(t),
    }
}

fn interp_y(path: &[P3], cum: &[f64], s: f64) -> f64 {
    for i in 0..path.len().saturating_sub(1) {
        if s <= cum[i + 1] || i + 2 == path.len() {
            let seg = (cum[i + 1] - cum[i]).max(1e-9);
            let t = ((s - cum[i]) / seg).clamp(0.0, 1.0);
            return path[i].y + (path[i + 1].y - path[i].y) * t;
        }
    }
    path.first().map(|p| p.y).unwrap_or(64.0)
}

fn path_arg(w: &World, a: &Value) -> Result<Vec<P3>> {
    let infos = blocks::infos();
    if let Some(p) = a.get("points") {
        let pts = spec::points(p, w, &infos)?;
        if pts.is_empty() {
            bail!("points is empty");
        }
        return Ok(pts);
    }
    if let Some(at) = spec::s(a, "at") {
        return Ok(vec![spec::point(at, w, &infos)?]);
    }
    bail!("need 'points' (path like 'x,y,z → x,y,z') or 'at'")
}

fn path_bbox(pts: &[P3], r: f64) -> (i32, i32, i32, i32) {
    let x0 = pts.iter().map(|p| p.x).fold(f64::MAX, f64::min) - r;
    let z0 = pts.iter().map(|p| p.z).fold(f64::MAX, f64::min) - r;
    let x1 = pts.iter().map(|p| p.x).fold(f64::MIN, f64::max) + r;
    let z1 = pts.iter().map(|p| p.z).fold(f64::MIN, f64::max) + r;
    (x0.floor() as i32, z0.floor() as i32, x1.ceil() as i32 + 1, z1.ceil() as i32 + 1)
}

fn clip(w: &World, b: (i32, i32, i32, i32)) -> (i32, i32, i32, i32) {
    let wb = w.bounds();
    (b.0.max(wb.0), b.1.max(wb.1), b.2.min(wb.2), b.3.min(wb.3))
}

fn material(a: &Value) -> Result<Option<Pattern>> {
    Ok(match spec::s(a, "material").or_else(|| spec::s(a, "pattern")) {
        Some(m) if !m.is_empty() => Some(Pattern::parse(m)?),
        _ => None,
    })
}

/// Compute new heights for each column in a bbox from a closure.
fn heights_from<F>(hm: &HMap, f: F) -> Vec<i32>
where
    F: Fn(i32, i32, i32) -> Option<f64> + Sync,
{
    (0..hm.h)
        .into_par_iter()
        .flat_map_iter(|dz| {
            let f = &f;
            (0..hm.w).map(move |dx| {
                let (x, z) = (hm.x0 + dx, hm.z0 + dz);
                let old = hm.y[(dz * hm.w + dx) as usize];
                if old == EMPTY {
                    return EMPTY;
                }
                match f(x, z, old) {
                    Some(v) => v.round() as i32,
                    None => EMPTY,
                }
            })
        })
        .collect()
}

fn summary(cols: u64, verb: &str) -> String {
    format!("{} columns {}", fmt_n(cols), verb)
}

/// Raise a mountain ridge up to the y of the path points.
pub fn op_ridge(w: &mut World, a: &Value) -> Result<String> {
    let pts = path_arg(w, a)?;
    let r = spec::f(a, "radius", 40.0).max(2.0);
    let noisiness = spec::f(a, "noisiness", 0.4);
    let mat = material(a)?;
    let cum = cumulative(&pts);
    let bb = clip(w, path_bbox(&pts, r * 1.3));
    let infos = blocks::infos();
    let hm = HMap::read(w, bb.0, bb.1, bb.2, bb.3, &infos);
    let seed = w.seed ^ 0x51d6e;
    let newh = heights_from(&hm, |x, z, old| {
        let (fx, fz) = (x as f64, z as f64);
        let (d, s) = nearest_on_path(&pts, &cum, fx, fz);
        let warp = noisiness * r * 0.35 * noise::fbm2(seed, fx, fz, r * 0.8, 3);
        let t = (d + warp) / r;
        if t >= 1.0 {
            return None;
        }
        let peak = interp_y(&pts, &cum, s) + noisiness * r * 0.25 * (noise::ridged2(seed ^ 3, fx, fz, r * 0.5, 4) * 2.0 - 0.8);
        let wgt = falloff(t, "smooth").powf(0.8);
        let target = old as f64 + (peak - old as f64) * wgt;
        if target > old as f64 {
            Some(target)
        } else {
            None
        }
    });
    let n = apply_heights(w, &hm, &newh, mat.as_ref(), seed);
    Ok(summary(n, "raised into ridge"))
}

/// Add `height` (negative lowers) with a falloff around a point or path.
pub fn op_raise(w: &mut World, a: &Value) -> Result<String> {
    let pts = path_arg(w, a)?;
    let r = spec::f(a, "radius", 24.0).max(1.0);
    let hgt = spec::f(a, "height", 8.0);
    let kind = spec::s(a, "falloff").unwrap_or("smooth").to_string();
    let noisiness = spec::f(a, "noisiness", 0.0);
    let mat = material(a)?;
    let cum = cumulative(&pts);
    let bb = clip(w, path_bbox(&pts, r));
    let infos = blocks::infos();
    let hm = HMap::read(w, bb.0, bb.1, bb.2, bb.3, &infos);
    let seed = w.seed ^ 0x7a15e;
    let newh = heights_from(&hm, |x, z, old| {
        let (d, _) = nearest_on_path(&pts, &cum, x as f64, z as f64);
        let wgt = falloff(d / r, &kind);
        if wgt <= 0.0 {
            return None;
        }
        let n = 1.0 + noisiness * noise::fbm2(seed, x as f64, z as f64, r * 0.5, 3);
        Some(old as f64 + hgt * wgt * n)
    });
    let n = apply_heights(w, &hm, &newh, mat.as_ref(), seed);
    Ok(summary(n, if hgt >= 0.0 { "raised" } else { "lowered" }))
}

/// Gaussian-ish blur of the ground heightfield inside an area.
pub fn op_smooth(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let iters = spec::i(a, "iterations", 3).clamp(1, 50) as usize;
    let rad = spec::i(a, "kernel", 2).clamp(1, 8) as i32;
    let strength = spec::f(a, "strength", 1.0).clamp(0.0, 1.0);
    let (x0, z0, x1, z1) = area.bbox(w);
    let m = rad * iters as i32 + 1;
    let wb = w.bounds();
    let hm = HMap::read(w, (x0 - m).max(wb.0), (z0 - m).max(wb.1), (x1 + m).min(wb.2), (z1 + m).min(wb.3), &infos);
    let mut cur: Vec<f64> = hm.y.iter().map(|&v| if v == EMPTY { f64::NAN } else { v as f64 }).collect();
    for _ in 0..iters {
        let src = cur.clone();
        cur = (0..hm.h)
            .into_par_iter()
            .flat_map_iter(|dz| {
                let src = &src;
                (0..hm.w).map(move |dx| {
                    let c = src[(dz * hm.w + dx) as usize];
                    if c.is_nan() {
                        return c;
                    }
                    let (mut s, mut n) = (0.0, 0.0);
                    for oz in -rad..=rad {
                        for ox in -rad..=rad {
                            let (xx, zz) = (dx + ox, dz + oz);
                            if xx < 0 || zz < 0 || xx >= hm.w || zz >= hm.h {
                                continue;
                            }
                            let v = src[(zz * hm.w + xx) as usize];
                            if !v.is_nan() {
                                s += v;
                                n += 1.0;
                            }
                        }
                    }
                    s / n
                })
            })
            .collect();
    }
    let mask = column_mask(w, &area, hm.x0, hm.z0, hm.x0 + hm.w, hm.z0 + hm.h);
    let newh: Vec<i32> = (0..hm.y.len())
        .map(|i| {
            if !mask[i] || hm.y[i] == EMPTY {
                EMPTY
            } else {
                (hm.y[i] as f64 + (cur[i] - hm.y[i] as f64) * strength).round() as i32
            }
        })
        .collect();
    let n = apply_heights(w, &hm, &newh, None, 0);
    Ok(summary(n, &format!("smoothed in {}", area.describe(w))))
}

fn area_weight(area: &Area, x: i32, z: i32, feather: f64) -> f64 {
    match area {
        Area::Circle(cx, cz, r) if feather > 0.0 => {
            let d = ((x as f64 + 0.5 - cx).powi(2) + (z as f64 + 0.5 - cz).powi(2)).sqrt();
            1.0 - smooth01((d - (r - feather)) / feather)
        }
        _ => 1.0,
    }
}

pub fn op_flatten(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let strength = spec::f(a, "strength", 1.0).clamp(0.0, 1.0);
    let feather = spec::f(a, "feather", 8.0);
    let mat = material(a)?;
    let (x0, z0, x1, z1) = area.bbox(w);
    let hm = HMap::read(w, x0, z0, x1, z1, &infos);
    let y = match a.get("y") {
        Some(v) if v.is_number() => v.as_f64().unwrap(),
        _ => {
            let v: Vec<i32> = hm.y.iter().cloned().filter(|&v| v != EMPTY).collect();
            if v.is_empty() {
                64.0
            } else {
                v.iter().map(|&v| v as f64).sum::<f64>() / v.len() as f64
            }
        }
    };
    let wr: &World = w;
    let newh = heights_from(&hm, |x, z, old| {
        if !area.contains(x, z, wr) {
            return None;
        }
        let k = strength * area_weight(&area, x, z, feather);
        Some(old as f64 + (y - old as f64) * k)
    });
    let n = apply_heights(w, &hm, &newh, mat.as_ref(), 3);
    Ok(format!("{} to y={:.0}", summary(n, "flattened"), y))
}

pub fn op_roughen(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let amp = spec::f(a, "amplitude", 3.0);
    let scale = spec::f(a, "scale", 12.0).max(1.0);
    let feather = spec::f(a, "feather", 0.0);
    let (x0, z0, x1, z1) = area.bbox(w);
    let hm = HMap::read(w, x0, z0, x1, z1, &infos);
    let seed = w.seed ^ 0x2016;
    let wr: &World = w;
    let newh = heights_from(&hm, |x, z, old| {
        if !area.contains(x, z, wr) {
            return None;
        }
        let k = area_weight(&area, x, z, feather);
        Some(old as f64 + amp * k * noise::fbm2(seed, x as f64, z as f64, scale, 3))
    });
    let n = apply_heights(w, &hm, &newh, None, seed);
    Ok(summary(n, &format!("roughened in {}", area.describe(w))))
}

pub fn op_terrace(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let step = spec::f(a, "step", 6.0).max(2.0);
    let strength = spec::f(a, "strength", 0.85).clamp(0.0, 1.0);
    let (x0, z0, x1, z1) = area.bbox(w);
    let hm = HMap::read(w, x0, z0, x1, z1, &infos);
    let wr: &World = w;
    let newh = heights_from(&hm, |x, z, old| {
        if !area.contains(x, z, wr) {
            return None;
        }
        let o = old as f64;
        let q = (o / step).floor() * step;
        let frac = (o - q) / step;
        let t = q + step * frac.powf(1.0 + 6.0 * strength);
        Some(t)
    });
    let n = apply_heights(w, &hm, &newh, None, 0);
    Ok(summary(n, "terraced"))
}

/// Open-pit mine: concentric terraced bowl.
pub fn op_pit(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let c = spec::point(spec::req_s(a, "at")?, w, &infos)?;
    let r = spec::f(a, "radius", 48.0).max(4.0);
    let depth = spec::f(a, "depth", 30.0).max(1.0);
    let steps = spec::i(a, "steps", 6).max(1) as f64;
    let water = spec::f(a, "water_depth", 0.0);
    let fluid = blocks::id(spec::s(a, "fluid").unwrap_or("water"));
    let wall = material(a)?;
    let bb = clip(w, ((c.x - r) as i32 - 1, (c.z - r) as i32 - 1, (c.x + r) as i32 + 2, (c.z + r) as i32 + 2));
    let hm = HMap::read(w, bb.0, bb.1, bb.2, bb.3, &infos);
    let rim = hm.get(c.x as i32, c.z as i32).map(|v| v as f64).unwrap_or(c.y - 1.0);
    let seed = w.seed ^ 0x917;
    let newh = heights_from(&hm, |x, z, old| {
        let (fx, fz) = (x as f64 + 0.5, z as f64 + 0.5);
        let d = ((fx - c.x).powi(2) + (fz - c.z).powi(2)).sqrt();
        let d = d * (1.0 + 0.06 * noise::fbm2(seed, fx, fz, r * 0.4, 2));
        if d >= r {
            return None;
        }
        let k = ((1.0 - d / r) * steps).ceil().min(steps);
        let level = rim - depth * k / steps;
        if level < old as f64 {
            Some(level)
        } else {
            None
        }
    });
    let n = apply_heights(w, &hm, &newh, wall.as_ref(), seed);
    let mut wn = 0;
    if water > 0.0 {
        let bottom = (rim - depth) as i32;
        let wl = bottom + water as i32;
        let ri = r as i32;
        for z in (c.z as i32 - ri)..=(c.z as i32 + ri) {
            for x in (c.x as i32 - ri)..=(c.x as i32 + ri) {
                if ((x as f64 + 0.5 - c.x).powi(2) + (z as f64 + 0.5 - c.z).powi(2)).sqrt() > r {
                    continue;
                }
                for y in bottom + 1..=wl {
                    if blocks::is_air(w.get(x, y, z)) && w.set(x, y, z, fluid) {
                        wn += 1;
                    }
                }
            }
        }
    }
    Ok(format!("{} ({} steps, rim y={:.0}, floor y={:.0}{})", summary(n, "excavated"), steps, rim, rim - depth, if wn > 0 { format!(", {} {} blocks", fmt_n(wn), blocks::name(fluid).trim_start_matches("minecraft:")) } else { String::new() }))
}

/// Carve a canyon / trench along a path down to `depth` below the path points.
pub fn op_carve(w: &mut World, a: &Value) -> Result<String> {
    let pts = path_arg(w, a)?;
    let width = spec::f(a, "width", 24.0).max(1.0);
    let depth = spec::f(a, "depth", 20.0);
    let slope = spec::f(a, "wall_slope", 0.0).max(0.0);
    let rough = spec::f(a, "roughness", 0.3);
    let floor_mat = material(a)?;
    let cum = cumulative(&pts);
    let reach = width / 2.0 * (1.0 + rough) + if slope > 0.0 { depth / slope } else { 0.0 } + 2.0;
    let bb = clip(w, path_bbox(&pts, reach));
    let infos = blocks::infos();
    let hm = HMap::read(w, bb.0, bb.1, bb.2, bb.3, &infos);
    let seed = w.seed ^ 0xca7e;
    let newh = heights_from(&hm, |x, z, old| {
        let (d, s) = nearest_on_path(&pts, &cum, x as f64, z as f64);
        let hw = width / 2.0 * (1.0 + rough * noise::fbm2(seed, s, 0.0, 30.0, 3));
        let floor = interp_y(&pts, &cum, s) - 1.0 - depth + 2.0 * rough * noise::fbm2(seed ^ 9, x as f64, z as f64, 10.0, 2);
        let level = if d <= hw {
            floor
        } else if slope > 0.0 {
            floor + (d - hw) * slope
        } else {
            return None;
        };
        if level < old as f64 {
            Some(level)
        } else {
            None
        }
    });
    let n = apply_heights(w, &hm, &newh, floor_mat.as_ref(), seed);
    Ok(summary(n, "carved"))
}

#[derive(Debug)]
struct Rule {
    pattern: Pattern,
    depth: i32,
    min_y: i32,
    max_y: i32,
    min_slope: i32,
    max_slope: i32,
    coverage: f64,
    scale: f64,
    only: Option<Mask>,
}

fn parse_rules(a: &Value) -> Result<Vec<Rule>> {
    let rules = match a.get("rules") {
        Some(Value::Array(r)) => r.clone(),
        Some(Value::String(s)) => serde_json::from_str::<Vec<Value>>(s)?,
        _ => match spec::s(a, "pattern") {
            Some(p) => vec![serde_json::json!({"pattern": p, "depth": spec::i(a, "depth", 1), "coverage": spec::f(a, "coverage", 1.0)})],
            None => bail!("paint needs 'rules' (array) or 'pattern'"),
        },
    };
    rules
        .iter()
        .map(|r| {
            Ok(Rule {
                pattern: Pattern::parse(spec::req_s(r, "pattern")?)?,
                depth: spec::i(r, "depth", 1).max(1) as i32,
                min_y: spec::i(r, "min_y", -10000) as i32,
                max_y: spec::i(r, "max_y", 10000) as i32,
                min_slope: spec::i(r, "min_slope", 0) as i32,
                max_slope: spec::i(r, "max_slope", 1000) as i32,
                coverage: spec::f(r, "coverage", 1.0),
                scale: spec::f(r, "scale", 20.0),
                only: match spec::s(r, "on") {
                    Some(m) => Some(Mask::parse(m)?),
                    None => None,
                },
            })
        })
        .collect()
}

/// Rule-based surface painting by height, slope and noise patches.
pub fn op_paint(w: &mut World, a: &Value) -> Result<String> {
    let rules = parse_rules(a)?;
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let (x0, z0, x1, z1) = area.bbox(w);
    let wb = w.bounds();
    let hm = HMap::read(w, (x0 - 1).max(wb.0), (z0 - 1).max(wb.1), (x1 + 1).min(wb.2), (z1 + 1).min(wb.3), &infos);
    let inside = column_mask(w, &area, x0, z0, x1, z1);
    let wd = x1 - x0;
    let seed = w.seed ^ 0xbe11;
    let min_y = w.min_y;
    let cols = AtomicU64::new(0);
    w.par_chunks(x0, z0, x1, z1, |ch, cx, cz| {
        let mut changed = false;
        let mut cnt = 0;
        for lz in 0..16 {
            for lx in 0..16 {
                let (gx, gz) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                if gx < x0 || gz < z0 || gx >= x1 || gz >= z1 || !inside[((gz - z0) * wd + (gx - x0)) as usize] {
                    continue;
                }
                let Some(g) = hm.get(gx, gz) else { continue };
                let slope = hm.slope(gx, gz);
                let top = ch.get(lx, (g - min_y) as usize, lz);
                for (ri, r) in rules.iter().enumerate() {
                    if g < r.min_y || g > r.max_y || slope < r.min_slope || slope > r.max_slope {
                        continue;
                    }
                    if let Some(m) = &r.only {
                        if !m.test(top, &infos) {
                            continue;
                        }
                    }
                    if r.coverage < 1.0 {
                        let n = noise::fbm2(seed.wrapping_add(ri as u32 * 31), gx as f64, gz as f64, r.scale, 3);
                        if (n + 1.0) / 2.0 > r.coverage {
                            continue;
                        }
                    }
                    for k in 0..r.depth {
                        let y = g - k;
                        if y < min_y {
                            break;
                        }
                        let yi = (y - min_y) as usize;
                        if !infos[ch.get(lx, yi, lz) as usize].solid() {
                            break;
                        }
                        changed |= ch.set(lx, yi, lz, r.pattern.pick(gx, y, gz, seed));
                    }
                    cnt += 1;
                    break;
                }
            }
        }
        cols.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    Ok(summary(cols.into_inner(), &format!("painted in {}", area.describe(w))))
}

/// Place a layer on top of the ground (e.g. snow, moss_carpet) where air.
pub fn op_overlay(w: &mut World, a: &Value) -> Result<String> {
    let pattern = Pattern::parse(spec::req_s(a, "pattern")?)?;
    let on = match spec::s(a, "on") {
        Some(m) => Some(Mask::parse(m)?),
        None => None,
    };
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let chance = spec::f(a, "chance", 1.0);
    let min_y_f = spec::i(a, "min_y", -10000) as i32;
    let (x0, z0, x1, z1) = area.bbox(w);
    let inside = column_mask(w, &area, x0, z0, x1, z1);
    let wd = x1 - x0;
    let (min_y, max_y) = (w.min_y, w.max_y());
    let seed = w.seed ^ 0x0e1a;
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
                let Some(yi) = ch.top_where(lx, lz, &infos, |b| b.solid() || b.kind == Kind::Foliage || b.kind == Kind::Liquid) else { continue };
                let top = ch.get(lx, yi, lz);
                if infos[top as usize].kind == Kind::Liquid {
                    continue;
                }
                if let Some(m) = &on {
                    if !m.test(top, &infos) {
                        continue;
                    }
                }
                let y = yi as i32 + min_y + 1;
                if y >= max_y || y < min_y_f {
                    continue;
                }
                if chance < 1.0 && noise::unit(noise::hash2(seed, gx, gz)) >= chance {
                    continue;
                }
                let yi1 = yi + 1;
                if ch.get(lx, yi1, lz) == AIR && ch.set(lx, yi1, lz, pattern.pick(gx, y, gz, seed)) {
                    changed = true;
                    cnt += 1;
                }
            }
        }
        n.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    Ok(format!("{} blocks overlaid in {}", fmt_n(n.into_inner()), area.describe(w)))
}
