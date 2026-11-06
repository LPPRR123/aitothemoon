//! Large parametric "fantasy" features for turning concept art into worlds:
//! giant mushrooms, floating islands, sky pillars, crystals, giant trees,
//! rock rings, rib cages, skulls, arches/roots, rope bridges, glowing fissures.
//!
//! Every generator builds a sparse `Shape` in local coordinates around a base
//! point, which is then placed into the world (optionally many times across
//! an area with size jitter).

use super::fmt_n;
use crate::blocks::{self, BlockId, Kind};
use crate::noise::{self, Rng};
use crate::spec::{self, Area, Pattern, P3};
use crate::world::World;
use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::HashMap;

type V = [f64; 3];
fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, k: f64) -> V {
    [a[0] * k, a[1] * k, a[2] * k]
}
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn len(a: V) -> f64 {
    dot(a, a).sqrt()
}
fn norm(a: V) -> V {
    mul(a, 1.0 / len(a).max(1e-9))
}
fn cross(a: V, b: V) -> V {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn bezier(p0: V, p1: V, p2: V, t: f64) -> V {
    let u = 1.0 - t;
    add(add(mul(p0, u * u), mul(p1, 2.0 * u * t)), mul(p2, t * t))
}
/// Direction from azimuth (deg, 0 = north/-z, 90 = east/+x) and tilt from vertical (deg).
fn dir(azimuth: f64, tilt: f64) -> V {
    let (a, t) = (azimuth.to_radians(), tilt.to_radians());
    [a.sin() * t.sin(), t.cos(), -a.cos() * t.sin()]
}

pub struct Shape {
    pub b: HashMap<(i32, i32, i32), BlockId>,
    seed: u32,
}

impl Shape {
    fn new(seed: u32) -> Self {
        Shape { b: HashMap::new(), seed }
    }
    #[inline]
    fn set(&mut self, x: i32, y: i32, z: i32, p: &Pattern) {
        self.b.insert((x, y, z), p.pick(x, y, z, self.seed));
    }
    #[inline]
    fn set_id(&mut self, x: i32, y: i32, z: i32, id: BlockId) {
        self.b.insert((x, y, z), id);
    }
    #[inline]
    fn soft(&mut self, x: i32, y: i32, z: i32, p: &Pattern) {
        self.b.entry((x, y, z)).or_insert_with(|| p.pick(x, y, z, self.seed));
    }
    fn sphere(&mut self, c: V, r: f64, p: &Pattern) {
        let ri = r.ceil() as i32;
        let (cx, cy, cz) = (c[0].floor() as i32, c[1].floor() as i32, c[2].floor() as i32);
        for dy in -ri..=ri {
            for dz in -ri..=ri {
                for dx in -ri..=ri {
                    let q = [(cx + dx) as f64 + 0.5 - c[0], (cy + dy) as f64 + 0.5 - c[1], (cz + dz) as f64 + 0.5 - c[2]];
                    if dot(q, q) <= r * r {
                        self.set(cx + dx, cy + dy, cz + dz, p);
                    }
                }
            }
        }
    }
    /// Sweep spheres along a polyline with per-point radius.
    fn tube(&mut self, pts: &[(V, f64)], p: &Pattern) {
        for w in pts.windows(2) {
            let ((a, ra), (b, rb)) = (w[0], w[1]);
            let l = len(sub(b, a));
            let n = (l * 2.0).ceil().max(1.0) as i32;
            for i in 0..=n {
                let t = i as f64 / n as f64;
                self.sphere(add(a, mul(sub(b, a), t)), ra + (rb - ra) * t, p);
            }
        }
    }
    /// Place at world offset. `soft` = do not overwrite solid terrain.
    fn place(&self, w: &mut World, at: (i32, i32, i32), soft: bool) -> u64 {
        let infos = blocks::infos();
        let mut n = 0;
        for (&(x, y, z), &id) in &self.b {
            let (gx, gy, gz) = (at.0 + x, at.1 + y, at.2 + z);
            if soft {
                let cur = w.get(gx, gy, gz);
                if !matches!(infos[cur as usize].kind, Kind::Air | Kind::Plant | Kind::Foliage | Kind::Liquid) && !blocks::is_air(id) {
                    continue;
                }
            }
            if w.set(gx, gy, gz, id) {
                n += 1;
            }
        }
        n
    }
}

/// Invisible light blocks so the feature is lit in-game at night ("none" disables).
fn light_arg(a: &Value, d: &str) -> Result<Option<Pattern>> {
    match spec::s(a, "lights").unwrap_or(d) {
        "none" | "" | "false" => Ok(None),
        s => Ok(Some(Pattern::parse(s)?)),
    }
}

fn pat(a: &Value, k: &str, d: &str) -> Result<Pattern> {
    Pattern::parse(spec::s(a, k).unwrap_or(d))
}

fn f(a: &Value, k: &str, d: f64, scale: f64) -> f64 {
    spec::f(a, k, d) * scale
}

// ---------------------------------------------------------------- generators

fn giant_mushroom(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let h = f(a, "height", 36.0, s);
    let rc = f(a, "cap_radius", 19.0, s);
    let rs = f(a, "stem_radius", 2.6, s).max(1.0);
    let bend = spec::f(a, "bend", 0.25) * h;
    let az = rng.f() * 360.0;
    let stem = pat(a, "stem", "mushroom_stem")?;
    let cap = pat(a, "cap", "85%purple_concrete,15%magenta_concrete")?;
    let gills = pat(a, "gills", "70%magenta_stained_glass,30%purple_stained_glass")?;
    // optional emissive layer under a glass cap: glowing translucent caps
    let core = match spec::s(a, "cap_core") {
        Some(c) if c != "none" => Some(Pattern::parse(c)?),
        _ => None,
    };
    let spots = pat(a, "spots", "sea_lantern")?;
    let spot_chance = spec::f(a, "spot_chance", 0.1);
    let hang = pat(a, "hang_block", "45%purple_stained_glass,30%magenta_stained_glass,25%sea_lantern")?;
    let hang_n = spec::i(a, "hang", (rc * 1.2) as i64) as i32;
    let lights = light_arg(a, "light[level=11]")?;
    let mut sh = Shape::new(seed);
    let d = dir(az, 90.0);
    let top = [d[0] * bend, h, d[2] * bend];
    let mid = [d[0] * bend * 0.1, h * 0.55, d[2] * bend * 0.1];
    let pts: Vec<(V, f64)> = (0..=16)
        .map(|i| {
            let t = i as f64 / 16.0;
            let r = rs * (1.35 - 0.45 * t) + if t < 0.08 { rs * 0.8 * (1.0 - t / 0.08) } else { 0.0 };
            (bezier([0.0; 3], mid, top, t), r)
        })
        .collect();
    sh.tube(&pts, &stem);
    // glowing rings on the stem
    for k in 1..4 {
        let t = k as f64 / 4.5;
        let c = bezier([0.0; 3], mid, top, t);
        if rng.chance(0.6) {
            let ri = (rs * 1.3) as i32 + 1;
            for dz in -ri..=ri {
                for dx in -ri..=ri {
                    let dd = ((dx * dx + dz * dz) as f64).sqrt();
                    if (dd - rs * 1.2).abs() < 0.7 && rng.chance(0.5) {
                        sh.set(c[0] as i32 + dx, c[1] as i32, c[2] as i32 + dz, &spots);
                    }
                }
            }
        }
    }
    // cap: dome shell with drooping rim
    let ch = rc * spec::f(a, "cap_height", 0.42);
    let ri = rc.ceil() as i32 + 1;
    let (cx, cy, cz) = (top[0], top[1], top[2]);
    for dz in -ri..=ri {
        for dx in -ri..=ri {
            let d = ((dx * dx + dz * dz) as f64).sqrt();
            let rr = rc * (1.0 + 0.06 * noise::perlin2(seed, dx as f64 / 5.0, dz as f64 / 5.0));
            if d > rr {
                continue;
            }
            let u = d / rr;
            let outer = ch * (1.0 - u * u).sqrt() - ch * 0.35 * u.powi(4); // dome + droop
            let under = -ch * 0.25 * u.powi(3) - 1.0;
            let (x, z) = ((cx + dx as f64).floor() as i32, (cz + dz as f64).floor() as i32);
            let y_top = (cy + outer).round() as i32;
            let y_bot = (cy + under).round() as i32;
            if let Some(l) = &lights {
                if x.rem_euclid(4) == 0 && z.rem_euclid(4) == 0 {
                    sh.soft(x, y_top + 1, z, l);
                    sh.soft(x, y_bot - 1, z, l);
                }
            }
            for y in y_bot..=y_top {
                let is_shell = y >= y_top - 1;
                if let (Some(c), true) = (&core, y == y_top - 1 || y == y_bot + 1) {
                    if y < y_top {
                        sh.set(x, y, z, c);
                        continue;
                    }
                }
                if is_shell {
                    if noise::unit(noise::hash3(seed ^ 77, x, y, z)) < spot_chance {
                        sh.set(x, y, z, &spots);
                    } else {
                        sh.set(x, y, z, &cap);
                    }
                } else if y == y_bot {
                    sh.set(x, y, z, &gills);
                }
            }
            // glow vines from the rim underside
            if u > 0.55 && hang_n > 0 && noise::unit(noise::hash2(seed ^ 3, x, z)) < hang_n as f64 / (std::f64::consts::PI * rc * rc * 0.7) {
                let l = rng.range(2, (rc * 0.6) as i32 + 3);
                for k in 1..=l {
                    sh.soft(x, y_bot - k, z, &hang);
                }
            }
        }
    }
    Ok(sh)
}

fn floating_island(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let r = f(a, "radius", 28.0, s);
    let depth = f(a, "depth", r * 1.3 / s, s);
    let rough = spec::f(a, "roughness", 0.35);
    let top = pat(a, "top", "grass_block")?;
    let soil = pat(a, "soil", "dirt")?;
    let rock = pat(a, "rock", "60%stone,20%andesite,20%tuff")?;
    let hang = pat(a, "hang", "hanging_roots")?;
    let falls = spec::i(a, "waterfalls", 1) as i32;
    let fall_len = f(a, "fall", 60.0, 1.0) as i32;
    let fluid = blocks::id(spec::s(a, "fluid").unwrap_or("water"));
    let mut sh = Shape::new(seed);
    let ri = (r * (1.0 + rough)).ceil() as i32 + 1;
    let mut edge: Vec<(i32, i32, i32)> = vec![];
    for dz in -ri..=ri {
        for dx in -ri..=ri {
            let d = ((dx * dx + dz * dz) as f64).sqrt();
            let ang = (dz as f64).atan2(dx as f64);
            let rr = r * (1.0 + rough * 0.6 * noise::perlin2(seed, ang.cos() * 2.0 + 10.0, ang.sin() * 2.0 + 10.0) + rough * 0.25 * noise::perlin2(seed ^ 9, dx as f64 / 6.0, dz as f64 / 6.0));
            if d > rr {
                continue;
            }
            let u = d / rr;
            let y_top = (2.0 * (1.0 - u * u) + 1.5 * noise::perlin2(seed ^ 5, dx as f64 / 9.0, dz as f64 / 9.0)).round() as i32;
            let spikes = (noise::perlin2(seed ^ 7, dx as f64 / (r * 0.18).max(2.5), dz as f64 / (r * 0.18).max(2.5)) * 0.5 + 0.5).powf(1.6);
            let drop = depth * (1.0 - u).powf(0.9) * (0.35 + 1.1 * spikes) + 3.0 * noise::perlin2(seed ^ 8, dx as f64 / 2.5, dz as f64 / 2.5);
            let y_bot = y_top - 1 - drop.round() as i32;
            for y in y_bot..=y_top {
                let dpt = y_top - y;
                if dpt == 0 {
                    sh.set(dx, y, dz, &top);
                } else if dpt <= 3 {
                    sh.set(dx, y, dz, &soil);
                } else {
                    sh.set(dx, y, dz, &rock);
                }
            }
            if u > 0.2 && rng.chance(0.03) {
                let l = rng.range(1, 4);
                for k in 1..=l {
                    sh.soft(dx, y_bot - k, dz, &hang);
                }
            }
            if u > 0.85 {
                edge.push((dx, y_top, dz));
            }
        }
    }
    for _ in 0..falls.max(0) {
        if edge.is_empty() {
            break;
        }
        let (x, y, z) = edge[rng.range(0, edge.len() as i32 - 1) as usize];
        // channel + falling column just outside the rim
        let out = norm([x as f64, 0.0, z as f64]);
        let (ox, oz) = ((x as f64 + out[0] * 1.5).round() as i32, (z as f64 + out[2] * 1.5).round() as i32);
        sh.set_id(x, y, z, fluid);
        for k in 0..fall_len {
            sh.set_id(ox, y - k, oz, fluid);
        }
    }
    Ok(sh)
}

fn spire(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let r = f(a, "radius", 14.0, s);
    let h = f(a, "height", 110.0, s);
    let taper = spec::f(a, "taper", 0.25);
    let rough = spec::f(a, "roughness", 0.3);
    let rock = pat(a, "rock", "50%stone,20%andesite,15%tuff,15%cobblestone")?;
    let moss = pat(a, "moss", "70%mossy_cobblestone,30%moss_block")?;
    let moss_k = spec::f(a, "moss_chance", 0.25);
    let top = pat(a, "top", "grass_block")?;
    let vines = pat(a, "hang", "vine")?;
    let falls = spec::i(a, "waterfalls", 0) as i32;
    let mut sh = Shape::new(seed);
    let base = -8;
    let hi = h.round() as i32;
    let ri = (r * (1.0 + rough) + 2.0).ceil() as i32;
    let mut rim: Vec<(i32, i32, i32)> = vec![];
    for y in base..=hi {
        let t = (y as f64 / h).clamp(0.0, 1.0);
        // flare out at the very top (cap) and the very bottom (scree)
        let flare = if t > 0.93 { 1.0 + (t - 0.93) * 4.0 } else if t < 0.06 { 1.0 + (0.06 - t) * 5.0 } else { 1.0 };
        let ry = r * (1.0 - taper * t) * flare;
        for dz in -ri..=ri {
            for dx in -ri..=ri {
                let ang = (dz as f64).atan2(dx as f64);
                let n = noise::perlin3(seed, ang.cos() * 1.8, y as f64 / 14.0, ang.sin() * 1.8) * 0.7 + noise::perlin3(seed ^ 1, dx as f64 / 4.0, y as f64 / 5.0, dz as f64 / 4.0) * 0.3;
                let rr = ry * (1.0 + rough * n);
                let d = ((dx * dx + dz * dz) as f64).sqrt();
                if d > rr {
                    continue;
                }
                if y == hi {
                    sh.set(dx, y, dz, &top);
                    if d > rr - 1.5 {
                        rim.push((dx, y, dz));
                    }
                } else if y >= hi - 3 {
                    sh.set(dx, y, dz, &pat(a, "soil", "dirt")?);
                } else if d > rr - 1.2 && noise::unit(noise::hash3(seed ^ 4, dx, y, dz)) < moss_k * (0.5 + t) {
                    sh.set(dx, y, dz, &moss);
                } else {
                    sh.set(dx, y, dz, &rock);
                }
            }
        }
    }
    // grassy ledges sticking out of the sides
    let ledges = spec::i(a, "ledges", (h / 25.0) as i64) as i32;
    let soilp = pat(a, "soil", "dirt")?;
    for _ in 0..ledges {
        let ly = rng.range((h * 0.2) as i32, (h * 0.9) as i32);
        let az = rng.f() * std::f64::consts::TAU;
        let rr = r * (1.0 - taper * ly as f64 / h);
        let (cx, cz) = ((az.cos() * rr) as i32, (az.sin() * rr) as i32);
        let lr = (r * (0.25 + 0.25 * rng.f())).max(2.0);
        let li = lr.ceil() as i32;
        for dz in -li..=li {
            for dx in -li..=li {
                if ((dx * dx + dz * dz) as f64).sqrt() > lr {
                    continue;
                }
                sh.set(cx + dx, ly, cz + dz, &top);
                sh.set(cx + dx, ly - 1, cz + dz, &soilp);
                sh.soft(cx + dx, ly - 2, cz + dz, &rock);
            }
        }
    }
    // hanging vines from the top rim
    for &(x, y, z) in rim.iter() {
        if rng.chance(0.3) {
            let l = rng.range(3, (h * 0.25) as i32 + 4);
            let out = norm([x as f64, 0.0, z as f64]);
            let (vx, vz) = ((x as f64 + out[0]).round() as i32, (z as f64 + out[2]).round() as i32);
            for k in 1..=l {
                sh.soft(vx, y - k, vz, &vines);
            }
        }
    }
    for _ in 0..falls {
        if rim.is_empty() {
            break;
        }
        let (x, y, z) = rim[rng.range(0, rim.len() as i32 - 1) as usize];
        let out = norm([x as f64, 0.0, z as f64]);
        let (ox, oz) = ((x as f64 + out[0] * 1.5).round() as i32, (z as f64 + out[2] * 1.5).round() as i32);
        for k in 0..(h as i32 + 8) {
            sh.set_id(ox, y - k, oz, blocks::WATER);
        }
    }
    Ok(sh)
}

fn crystal(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let len0 = f(a, "length", 30.0, s);
    let r0 = f(a, "radius", 4.0, s);
    let n = spec::i(a, "cluster", 5).max(1) as usize;
    let tilt0 = spec::f(a, "tilt", 15.0);
    let shell = pat(a, "shell", "70%light_blue_stained_glass,30%cyan_stained_glass")?;
    let core = pat(a, "core", "sea_lantern")?;
    let base = pat(a, "base", "60%amethyst_block,40%calcite")?;
    let mut sh = Shape::new(seed);
    for k in 0..n {
        let (l, r, tilt, az) = if k == 0 {
            (len0, r0, tilt0 * rng.f(), rng.f() * 360.0)
        } else {
            (len0 * (0.35 + 0.5 * rng.f()), r0 * (0.45 + 0.4 * rng.f()), 15.0 + 30.0 * rng.f(), rng.f() * 360.0)
        };
        let ax = dir(az, tilt);
        let off = if k == 0 { [0.0; 3] } else { mul(dir(az, 90.0), r0 * (0.8 + rng.f())) };
        let u = norm(cross(ax, if ax[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] }));
        let v = cross(ax, u);
        let rot = rng.f() * std::f64::consts::PI;
        let ext = (l + r).ceil() as i32 + 1;
        let tip = l * 0.28;
        let c0 = add(off, [0.0, -r * 0.6, 0.0]);
        for dy in -ext..=ext {
            for dz in -ext..=ext {
                for dx in -ext..=ext {
                    let p = sub([dx as f64 + 0.5, dy as f64 + 0.5, dz as f64 + 0.5], c0);
                    let sa = dot(p, ax);
                    if sa < 0.0 || sa > l {
                        continue;
                    }
                    let (pu, pv) = (dot(p, u), dot(p, v));
                    let mut hex: f64 = 0.0;
                    for j in 0..3 {
                        let ang = rot + j as f64 * std::f64::consts::PI / 3.0;
                        hex = hex.max((pu * ang.cos() + pv * ang.sin()).abs());
                    }
                    let rr = if sa > l - tip { r * (l - sa) / tip } else { r };
                    if hex > rr {
                        continue;
                    }
                    if hex < rr * 0.45 && sa < l - tip * 0.6 {
                        sh.set(dx, dy, dz, &core);
                    } else {
                        sh.set(dx, dy, dz, &shell);
                    }
                }
            }
        }
    }
    if let Some(l) = light_arg(a, "light[level=13]")? {
        let lr = (r0 * 2.0) as i32 + 2;
        for (dx, dz) in [(lr, 0), (-lr, 0), (0, lr), (0, -lr)] {
            for y in [1, (len0 * 0.5) as i32] {
                sh.soft(dx, y, dz, &l);
            }
        }
    }
    // rocky base
    let rb = (r0 * 2.2).ceil() as i32;
    for dz in -rb..=rb {
        for dx in -rb..=rb {
            let d = ((dx * dx + dz * dz) as f64).sqrt();
            if d <= r0 * 2.2 && rng.chance(0.85) {
                let hh = ((1.0 - d / (r0 * 2.2)) * 2.0).round() as i32;
                for y in -2..=hh - 1 {
                    sh.soft(dx, y, dz, &base);
                }
            }
        }
    }
    Ok(sh)
}

struct TreeStyle {
    log: &'static str,
    leaves: &'static str,
    glow: &'static str,
    hang: &'static str,
    twist: f64,
    leafy: bool,
}

fn tree_style(name: &str) -> TreeStyle {
    match name {
        "crystal" => TreeStyle { log: "cherry_wood", leaves: "55%pink_stained_glass,30%magenta_stained_glass,15%amethyst_block", glow: "pearlescent_froglight", hang: "", twist: 0.25, leafy: true },
        "silver" => TreeStyle { log: "birch_wood", leaves: "50%white_stained_glass,30%light_gray_stained_glass,20%white_wool", glow: "sea_lantern", hang: "", twist: 0.3, leafy: true },
        "dead" | "twisted" => TreeStyle { log: "dark_oak_wood", leaves: "", glow: "", hang: "", twist: 0.7, leafy: false },
        "blood" => TreeStyle { log: "crimson_hyphae", leaves: "", glow: "", hang: "weeping_vines", twist: 0.75, leafy: false },
        "swamp" => TreeStyle { log: "dark_oak_wood", leaves: "", glow: "", hang: "pale_hanging_moss", twist: 0.55, leafy: false },
        "glow" => TreeStyle { log: "warped_hyphae", leaves: "60%warped_wart_block,40%cyan_stained_glass", glow: "shroomlight", hang: "cave_vines[berries=true]", twist: 0.35, leafy: true },
        _ => TreeStyle { log: "dark_oak_wood", leaves: "oak_leaves[persistent=true]", glow: "", hang: "vine", twist: 0.25, leafy: true },
    }
}

fn giant_tree(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let style = tree_style(spec::s(a, "style").unwrap_or("broad"));
    let h = f(a, "height", 55.0, s);
    let tr = f(a, "trunk_radius", 4.5, s).max(1.0);
    let crown = f(a, "crown_radius", h * 0.42 / s, s);
    let log = pat(a, "log", style.log)?;
    let leaves_s = spec::s(a, "leaves").unwrap_or(style.leaves);
    let leafy = style.leafy && leaves_s != "none" && !leaves_s.is_empty();
    let leaves = if leafy { Some(Pattern::parse(leaves_s)?) } else { None };
    let glow_s = spec::s(a, "glow").unwrap_or(style.glow);
    let glow = if glow_s.is_empty() || glow_s == "none" { None } else { Some(Pattern::parse(glow_s)?) };
    let hang_s = spec::s(a, "hang").unwrap_or(style.hang);
    let hang = if hang_s.is_empty() || hang_s == "none" { None } else { Some(Pattern::parse(hang_s)?) };
    let twist = spec::f(a, "twist", style.twist);
    let n_roots = spec::i(a, "roots", 6) as i32;
    let style_name = spec::s(a, "style").unwrap_or("broad");
    let lights = light_arg(a, if matches!(style_name, "silver" | "crystal" | "glow") { "light[level=12]" } else { "none" })?;
    let depth = spec::i(a, "levels", 3).clamp(1, 5) as i32;
    let mut sh = Shape::new(seed);
    let mut tips: Vec<(V, f64)> = vec![];

    // trunk
    let trunk_h = h * 0.45;
    let lean = mul(dir(rng.f() * 360.0, 90.0), h * 0.06 * twist);
    let trunk_top = add([0.0, trunk_h, 0.0], lean);
    let pts: Vec<(V, f64)> = (0..=10)
        .map(|i| {
            let t = i as f64 / 10.0;
            let wob = mul([noise::perlin2(seed, t * 3.0, 0.5), 0.0, noise::perlin2(seed ^ 1, t * 3.0, 0.5)], tr * twist);
            (add(add(mul(trunk_top, t), [0.0, 0.0, 0.0]), wob), tr * (1.0 - 0.35 * t))
        })
        .collect();
    sh.tube(&pts, &log);
    if let Some(l) = &lights {
        let ring = tr.ceil() as i32 + 2;
        let mut y = 2;
        while (y as f64) < trunk_h {
            for (dx, dz) in [(ring, 0), (-ring, 0), (0, ring), (0, -ring)] {
                sh.soft(dx, y, dz, l);
            }
            y += 6;
        }
    }
    // recursive branches
    fn branch(sh: &mut Shape, rng: &mut Rng, start: V, d: V, l: f64, r: f64, lvl: i32, max: i32, twist: f64, log: &Pattern, tips: &mut Vec<(V, f64)>) {
        let end = add(start, mul(d, l));
        let ctrl = add(add(start, mul(d, l * 0.5)), mul([rng.f() - 0.5, rng.f() * 0.4 - 0.3 * twist, rng.f() - 0.5], l * 0.5 * twist));
        let pts: Vec<(V, f64)> = (0..=8).map(|i| {
            let t = i as f64 / 8.0;
            (bezier(start, ctrl, end, t), (r * (1.0 - 0.45 * t)).max(0.6))
        }).collect();
        sh.tube(&pts, log);
        if lvl >= max {
            tips.push((end, l));
            return;
        }
        let k = rng.range(2, 4);
        for _ in 0..k {
            let az = rng.f() * 360.0;
            let tilt = 25.0 + rng.f() * 45.0 + twist * 30.0;
            let nd = norm(add(mul(d, 0.55), mul(dir(az, tilt), 0.9)));
            let nl = l * (0.55 + rng.f() * 0.2);
            branch(sh, rng, end, nd, nl, r * 0.6, lvl + 1, max, twist, log, tips);
        }
    }
    let k = rng.range(3, 5);
    for i in 0..k {
        let az = i as f64 * 360.0 / k as f64 + rng.f() * 40.0;
        let d = norm(dir(az, 40.0 + rng.f() * 25.0 + twist * 25.0));
        branch(&mut sh, rng, trunk_top, d, h * 0.35, tr * 0.55, 1, depth, twist, &log, &mut tips);
    }
    if let Some(l) = &lights {
        for (tip, _) in &tips {
            sh.soft(tip[0].round() as i32, tip[1].round() as i32 - (crown * 0.25) as i32, tip[2].round() as i32, l);
        }
    }
    // canopy
    if let Some(lv) = &leaves {
        let cr = crown / (tips.len() as f64).sqrt().max(1.0) * 1.9;
        for (tip, _) in &tips {
            let rx = cr * (0.8 + 0.4 * rng.f());
            let ry = rx * 0.6;
            let ri = rx.ceil() as i32;
            let (cx, cy, cz) = (tip[0].round() as i32, tip[1].round() as i32, tip[2].round() as i32);
            for dy in -(ry.ceil() as i32)..=(ry.ceil() as i32) {
                for dz in -ri..=ri {
                    for dx in -ri..=ri {
                        let q = (dx as f64 / rx).powi(2) + (dy as f64 / ry).powi(2) + (dz as f64 / rx).powi(2);
                        let n = 0.25 * noise::perlin3(seed ^ 11, (cx + dx) as f64 / 4.0, (cy + dy) as f64 / 4.0, (cz + dz) as f64 / 4.0);
                        if q + n <= 1.0 {
                            if let Some(g) = &glow {
                                if noise::unit(noise::hash3(seed ^ 13, cx + dx, cy + dy, cz + dz)) < 0.025 {
                                    sh.set(cx + dx, cy + dy, cz + dz, g);
                                    continue;
                                }
                            }
                            sh.soft(cx + dx, cy + dy, cz + dz, lv);
                            // hanging strands under the canopy
                            if dy == -(ry.ceil() as i32) + 1 {
                                if let Some(hg) = &hang {
                                    if noise::unit(noise::hash2(seed ^ 17, cx + dx, cz + dz)) < 0.12 {
                                        let l = 2 + (noise::hash2(seed, cx + dx, cz + dz) % 7) as i32;
                                        for k in 1..=l {
                                            sh.soft(cx + dx, cy + dy - k, cz + dz, hg);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    } else if let Some(hg) = &hang {
        for (tip, _) in &tips {
            let l = rng.range(3, 10);
            for k in 1..=l {
                sh.soft(tip[0].round() as i32, tip[1].round() as i32 - k, tip[2].round() as i32, hg);
            }
        }
    }
    // roots: arching outward into the ground
    for i in 0..n_roots {
        let az = i as f64 * 360.0 / n_roots as f64 + rng.f() * 25.0;
        let out = dir(az, 90.0);
        let reach = tr * (2.5 + rng.f() * 2.5);
        let p0 = add([0.0, tr * 1.2, 0.0], mul(out, tr * 0.4));
        let p1 = add([0.0, tr * 1.6 + reach * 0.25, 0.0], mul(out, reach * 0.55));
        let p2 = add([0.0, -tr * 0.8, 0.0], mul(out, reach));
        let pts: Vec<(V, f64)> = (0..=10).map(|j| {
            let t = j as f64 / 10.0;
            (bezier(p0, p1, p2, t), (tr * 0.55 * (1.0 - 0.6 * t)).max(0.8))
        }).collect();
        sh.tube(&pts, &log);
    }
    Ok(sh)
}

fn ring(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let big = f(a, "radius", 26.0, s);
    let small = f(a, "thickness", 5.0, s);
    let tilt = spec::f(a, "tilt", 25.0 + rng.f() * 30.0);
    let az = spec::f(a, "azimuth", rng.f() * 360.0);
    let erosion = spec::f(a, "erosion", 0.35);
    let broken = spec::f(a, "broken", 0.0);
    let m = pat(a, "material", "45%sandstone,25%smooth_sandstone,15%cut_sandstone,15%terracotta")?;
    let mut sh = Shape::new(seed);
    // ring frame: normal = dir(az, tilt)
    let nrm = dir(az, tilt);
    let u = norm(cross(nrm, if nrm[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] }));
    let v = cross(nrm, u);
    let ext = (big + small * 1.5).ceil() as i32;
    for dy in -ext..=ext {
        for dz in -ext..=ext {
            for dx in -ext..=ext {
                let p = [dx as f64 + 0.5, dy as f64 + 0.5, dz as f64 + 0.5];
                let (pu, pv, pn) = (dot(p, u), dot(p, v), dot(p, nrm));
                let rad = (pu * pu + pv * pv).sqrt();
                let ang = pv.atan2(pu);
                if broken > 0.0 && (noise::perlin2(seed ^ 5, ang.cos() * 1.5, ang.sin() * 1.5) + 1.0) / 2.0 < broken {
                    continue;
                }
                let q = ((rad - big).powi(2) + pn * pn).sqrt();
                let rr = small * (1.0 + erosion * noise::perlin3(seed, p[0] / 5.0, p[1] / 5.0, p[2] / 5.0));
                if q <= rr {
                    sh.set(dx, dy, dz, &m);
                }
            }
        }
    }
    Ok(sh)
}

fn ribcage(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let l = f(a, "length", 60.0, s);
    let h = f(a, "height", 26.0, s);
    let wdt = f(a, "width", 22.0, s);
    let n = spec::i(a, "ribs", 7).max(2) as i32;
    let t = f(a, "thickness", 1.8, s).max(0.8);
    let az = spec::f(a, "azimuth", rng.f() * 360.0);
    let bone = pat(a, "material", "85%bone_block,15%calcite")?;
    let mut sh = Shape::new(seed);
    let fwd = dir(az, 90.0);
    let side = [fwd[2], 0.0, -fwd[0]];
    // spine: arc
    let spine: Vec<(V, f64)> = (0..=20).map(|i| {
        let k = i as f64 / 20.0;
        let y = h * (0.75 + 0.25 * (std::f64::consts::PI * k).sin()) * if k > 0.8 { 1.0 - (k - 0.8) * 2.5 } else { 1.0 };
        (add(mul(fwd, (k - 0.5) * l), [0.0, y, 0.0]), t * 1.3)
    }).collect();
    sh.tube(&spine, &bone);
    for i in 0..n {
        let k = 0.12 + 0.68 * i as f64 / (n - 1) as f64;
        let top = spine[(k * 20.0).round() as usize].0;
        let size = 0.55 + 0.45 * (std::f64::consts::PI * (k - 0.05) / 0.85).sin().max(0.0);
        for sgn in [-1.0, 1.0] {
            let qmax = std::f64::consts::PI * 0.78;
            let pts: Vec<(V, f64)> = (0..=16).map(|j| {
                let q = j as f64 / 16.0 * qmax;
                let out = q.sin() * wdt * 0.5 * size;
                let down = (1.0 - q.cos()) / (1.0 - qmax.cos()) * top[1] * (0.85 + 0.15 * size);
                (add(add(top, mul(side, sgn * out)), [0.0, -down, 0.0]), t * (1.0 - 0.3 * j as f64 / 16.0))
            }).collect();
            sh.tube(&pts, &bone);
        }
    }
    Ok(sh)
}

fn skull(a: &Value, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let r = f(a, "size", 12.0, s);
    let az = spec::f(a, "azimuth", rng.f() * 360.0);
    let bone = pat(a, "material", "85%bone_block,15%calcite")?;
    let teeth = pat(a, "teeth", "calcite")?;
    let socket = pat(a, "socket", "polished_blackstone")?;
    let mut sh = Shape::new(seed);
    let fwd = dir(az, 90.0);
    let side = [fwd[2], 0.0, -fwd[0]];
    let ext = (r * 1.9).ceil() as i32;
    let c = [0.0, r * 0.9, 0.0];
    for dy in -2..=ext {
        for dz in -ext..=ext {
            for dx in -ext..=ext {
                let p = sub([dx as f64 + 0.5, dy as f64 + 0.5, dz as f64 + 0.5], c);
                let (pf, ps, py) = (dot(p, fwd), dot(p, side), p[1]);
                // boxy cranium (superellipsoid) + jaw block forward and lower
                let se = |a: f64, b: f64, c: f64| a.abs().powf(3.0) + b.abs().powf(3.0) + c.abs().powf(3.0);
                let cran = se(pf / (r * 1.0), ps / (r * 0.85), py / (r * 0.9));
                let jaw = se((pf - r * 0.55) / (r * 0.7), ps / (r * 0.62), (py + r * 0.65) / (r * 0.4));
                let inside = cran <= 1.0 || jaw <= 1.0;
                let hollow = cran <= 0.45;
                // eye sockets and nose cavity (lined dark so they read as holes)
                let eye = |sg: f64, k: f64| ((pf - r * 0.85) / (r * 0.55 * k)).powi(2) + ((ps - sg * r * 0.4) / (r * 0.27 * k)).powi(2) + ((py - r * 0.12) / (r * 0.28 * k)).powi(2) <= 1.0;
                let nose = |k: f64| ((pf - r * 0.95) / (r * 0.4 * k)).powi(2) + (ps / (r * 0.13 * k)).powi(2) + ((py + r * 0.28) / (r * 0.2 * k)).powi(2) <= 1.0;
                if !inside || hollow {
                    continue;
                }
                if eye(1.0, 1.0) || eye(-1.0, 1.0) || nose(1.0) {
                    continue;
                }
                if eye(1.0, 1.35) || eye(-1.0, 1.35) || nose(1.5) {
                    sh.set(dx, dy, dz, &socket);
                } else {
                    sh.set(dx, dy, dz, &bone);
                }
            }
        }
    }
    // dark mouth slot with a row of teeth
    for k in -4..=4 {
        let p = add(add(c, mul(fwd, r * 1.2)), mul(side, k as f64 * r * 0.12));
        let (x, z) = (p[0].round() as i32, p[2].round() as i32);
        let ytop = (c[1] - r * 0.3).round() as i32;
        for d in 0..(r * 0.3).ceil() as i32 {
            let id = if k % 2 == 0 { &teeth } else { &socket };
            sh.set(x, ytop - d, z, id);
        }
    }
    let _ = seed;
    Ok(sh)
}

/// Arch / giant root / rock bridge between two points (local coords relative to the first).
fn arch(a: &Value, p0: V, p1: V, rng: &mut Rng, s: f64, seed: u32) -> Result<Shape> {
    let h = f(a, "height", len(sub(p1, p0)) * 0.35 / s, s);
    let r0 = f(a, "thickness", 4.0, s);
    let m = pat(a, "material", "60%stone,25%andesite,15%mossy_cobblestone")?;
    let rough = spec::f(a, "roughness", 0.3);
    let mut sh = Shape::new(seed);
    let mid = add(mul(add(p0, p1), 0.5), [0.0, h * 2.0, 0.0]);
    let pts: Vec<(V, f64)> = (0..=24).map(|i| {
        let t = i as f64 / 24.0;
        let r = r0 * (1.0 + 0.5 * (1.0 - (std::f64::consts::PI * t).sin())) * (1.0 + rough * noise::perlin2(seed, t * 6.0, 0.3));
        (bezier(p0, mid, p1, t), r)
    }).collect();
    sh.tube(&pts, &m);
    let _ = rng;
    Ok(sh)
}

fn bridge(a: &Value, p0: V, p1: V, s: f64, seed: u32) -> Result<Shape> {
    let wdt = f(a, "width", 3.0, s).max(1.0);
    let sag = spec::f(a, "sag", 0.08);
    let deck = pat(a, "deck", "spruce_slab[type=bottom]")?;
    let rail = pat(a, "rail", "spruce_fence")?;
    let rope = pat(a, "rope", "chain")?;
    let mut sh = Shape::new(seed);
    let d = sub(p1, p0);
    let l = [d[0], 0.0, d[2]];
    let hl = len(l);
    let side = norm([l[2], 0.0, -l[0]]);
    let n = (hl * 1.5).ceil() as i32;
    let hw = (wdt / 2.0).floor() as i32;
    for i in 0..=n {
        let t = i as f64 / n as f64;
        let c = add(add(p0, mul(d, t)), [0.0, -sag * hl * 4.0 * t * (1.0 - t), 0.0]);
        for k in -hw..=hw {
            let q = add(c, mul(side, k as f64));
            sh.set(q[0].round() as i32, q[1].round() as i32, q[2].round() as i32, &deck);
        }
        for sg in [-1.0, 1.0] {
            let q = add(c, mul(side, sg * (hw as f64 + 1.0)));
            sh.set(q[0].round() as i32, q[1].round() as i32 + 1, q[2].round() as i32, &rail);
            if i % 6 == 0 {
                sh.set(q[0].round() as i32, q[1].round() as i32 + 2, q[2].round() as i32, &rope);
            }
        }
    }
    Ok(sh)
}

/// Glowing fissure carved into the terrain along a path (applied directly).
fn fissure(w: &mut World, a: &Value, pts: &[P3], seed: u32) -> Result<u64> {
    let width = spec::f(a, "width", 5.0);
    let depth = spec::f(a, "depth", 30.0);
    let glow = pat(a, "glow", "60%crying_obsidian,25%amethyst_block,15%magma_block")?;
    let wall = spec::f(a, "wall_glow", 0.06);
    // fill_to: fill the glow up to this many blocks below the surface (molten channel look)
    let fill_to = a.get("fill_to").and_then(|v| v.as_i64()).map(|v| v as i32);
    // cover: translucent layer on top of the glow (e.g. purple glass over froglight)
    let cover = match spec::s(a, "cover") {
        Some(c) => Some(Pattern::parse(c)?),
        None => None,
    };
    let infos = blocks::infos();
    let path = super::resample(pts);
    let cum = super::cumulative(pts);
    let r = width * 1.6 + 2.0;
    let (x0, z0) = (path.iter().map(|p| p.x).fold(f64::MAX, f64::min) - r, path.iter().map(|p| p.z).fold(f64::MAX, f64::min) - r);
    let (x1, z1) = (path.iter().map(|p| p.x).fold(f64::MIN, f64::max) + r, path.iter().map(|p| p.z).fold(f64::MIN, f64::max) + r);
    let mut n = 0;
    for z in z0 as i32..=z1 as i32 {
        for x in x0 as i32..=x1 as i32 {
            let (d, s) = super::nearest_on_path(pts, &cum, x as f64 + 0.5, z as f64 + 0.5);
            let hw = width / 2.0 * (0.6 + 0.8 * (noise::perlin2(seed, s / 9.0, 0.5) * 0.5 + 0.5)) + noise::perlin2(seed ^ 3, x as f64 / 3.0, z as f64 / 3.0);
            if d > hw {
                continue;
            }
            let Some(g) = w.ground(x, z, &infos) else { continue };
            let dd = depth * (1.0 - (d / hw).powi(2)).max(0.2) * (0.8 + 0.4 * (noise::perlin2(seed ^ 1, s / 15.0, 2.0) * 0.5 + 0.5));
            let bottom = g - dd.round() as i32;
            for y in (bottom + 2)..=g + 1 {
                if !blocks::is_air(w.get(x, y, z)) && w.set(x, y, z, blocks::AIR) {
                    n += 1;
                }
            }
            let top_fill = match fill_to {
                Some(k) => (g - k).max(bottom + 1),
                None => bottom + 1,
            };
            for y in bottom..=top_fill {
                let p = match (&cover, y == top_fill) {
                    (Some(c), true) => c,
                    _ => &glow,
                };
                w.set(x, y, z, p.pick(x, y, z, seed));
            }
            // emissive specks in the walls just outside the cut
            if d > hw - 1.5 {
                for y in bottom..g {
                    if noise::unit(noise::hash3(seed ^ 7, x, y, z)) < wall {
                        for (ox, oz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                            if infos[w.get(x + ox, y, z + oz) as usize].solid() {
                                w.set(x + ox, y, z + oz, glow.pick(x, y, z, seed ^ 1));
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(n)
}

// ---------------------------------------------------------------- tool

pub const FEATURES: &[(&str, &str)] = &[
    ("giant_mushroom", "height 36, cap_radius 19, stem_radius 2.6, bend 0.25, cap_height 0.42, stem/cap/cap_core(glowing layer under a glass cap)/gills/spots/hang_block patterns, spot_chance 0.1, hang (strand count)"),
    ("floating_island", "radius 28, depth, roughness 0.35, altitude 60 (above ground when at is x,z), top/soil/rock/hang, waterfalls 1, fall 60, fluid"),
    ("spire", "sky pillar: radius 14, height 110, taper 0.25, roughness 0.3, ledges, rock/moss/top/soil/hang, moss_chance, waterfalls 0"),
    ("crystal", "length 30, radius 4, cluster 5, tilt 15, shell/core/base patterns"),
    ("giant_tree", "style broad|crystal|silver|dead|twisted|blood|swamp|glow, height 55, trunk_radius 4.5, crown_radius, levels 3, roots 6, twist, log/leaves/glow/hang overrides (leaves:'none')"),
    ("ring", "floating rock ring: radius 26, thickness 5, tilt, azimuth, erosion 0.35, broken 0..1, material"),
    ("ribcage", "length 60, height 26, width 22, ribs 9, thickness 1.6, azimuth, material"),
    ("skull", "size 12, azimuth, material, teeth"),
    ("arch", "natural arch / giant root between 2 points: points 'a → b', height, thickness 4, roughness, material"),
    ("bridge", "rope bridge between 2 points: points 'a → b', width 3, sag 0.08, deck/rail/rope"),
    ("fissure", "glowing crack along a path: points, width 5, depth 30, glow pattern, wall_glow 0.06, fill_to (fill glow up to N blocks below the surface), cover (translucent top layer, e.g. purple glass over froglight)"),
];

/// `feature` tool: place one (at), several (points) or scatter `count` in an `area`.
pub fn op_feature(w: &mut World, a: &Value) -> Result<String> {
    let kind = spec::req_s(a, "type")?.to_string();
    if !FEATURES.iter().any(|f| f.0 == kind) {
        bail!("unknown feature '{kind}'. Features: {}", FEATURES.iter().map(|f| f.0).collect::<Vec<_>>().join(", "));
    }
    let infos = blocks::infos();
    let seed0 = spec::i(a, "seed", 7) as u32 ^ w.seed;
    let scale = spec::f(a, "scale", 1.0);
    let jitter = spec::f(a, "jitter", 0.3);
    let soft = spec::b(a, "soft", false);
    let sink = spec::f(a, "sink", if kind == "giant_tree" || kind == "spire" { 2.0 } else { 1.0 });
    // two-point features
    if matches!(kind.as_str(), "arch" | "bridge" | "fissure") {
        let pts = spec::points(a.get("points").unwrap_or(&Value::Null), w, &infos)?;
        if pts.len() < 2 {
            bail!("{kind} needs points 'a → b'");
        }
        if kind == "fissure" {
            let n = fissure(w, a, &pts, seed0)?;
            return Ok(format!("fissure carved along {} points ({} blocks removed)", pts.len(), fmt_n(n)));
        }
        let mut total = 0;
        for (i, seg) in pts.windows(2).enumerate() {
            let p0 = [0.0, -1.0, 0.0];
            let p1 = [seg[1].x - seg[0].x, seg[1].y - seg[0].y - 1.0, seg[1].z - seg[0].z];
            let mut rng = Rng::new(seed0 as u64 ^ i as u64);
            let sh = if kind == "arch" { arch(a, p0, p1, &mut rng, scale, seed0)? } else { bridge(a, [0.0, 0.0, 0.0], [p1[0], p1[1] + 1.0, p1[2]], scale, seed0)? };
            total += sh.place(w, (seg[0].x.floor() as i32, seg[0].y.floor() as i32, seg[0].z.floor() as i32), soft);
        }
        return Ok(format!("{kind}: {} blocks over {} segment(s)", fmt_n(total), pts.len() - 1));
    }
    // placement points
    let mut spots: Vec<(P3, f64)> = vec![];
    if let Some(n) = a.get("count").and_then(|v| v.as_i64()) {
        let area = Area::from_args(a, w, &infos)?;
        let (x0, z0, x1, z1) = area.bbox(w);
        let min_dist = spec::f(a, "spacing", 12.0 * scale);
        let mut rng = Rng::new(seed0 as u64 ^ 0xfeed);
        let mut tries = 0;
        while spots.len() < n as usize && tries < n * 60 {
            tries += 1;
            let x = rng.range(x0, x1 - 1);
            let z = rng.range(z0, z1 - 1);
            if !area.contains(x, z, w) || spots.iter().any(|(p, _)| (p.x - x as f64).hypot(p.z - z as f64) < min_dist) {
                continue;
            }
            let Some(g) = w.ground(x, z, &infos) else { continue };
            if infos[w.get(x, g + 1, z) as usize].kind == Kind::Liquid && kind != "floating_island" && kind != "crystal" {
                continue;
            }
            spots.push((P3 { x: x as f64, y: g as f64 + 1.0, z: z as f64 }, scale * (1.0 - jitter + 2.0 * jitter * rng.f())));
        }
    } else if let Some(p) = a.get("points") {
        for q in spec::points(p, w, &infos)? {
            spots.push((q, scale));
        }
    } else {
        spots.push((spec::point(spec::req_s(a, "at")?, w, &infos)?, scale));
    }
    let at_explicit = spec::s(a, "at").map(|s| s.split(',').count() == 3).unwrap_or(false);
    let mut total = 0;
    for (i, (p, sc)) in spots.iter().enumerate() {
        let seed = seed0.wrapping_add(i as u32 * 7919);
        let mut rng = Rng::new(seed as u64 ^ ((p.x as i64 as u64) << 21) ^ p.z as i64 as u64);
        let sh = match kind.as_str() {
            "giant_mushroom" => giant_mushroom(a, &mut rng, *sc, seed)?,
            "floating_island" => floating_island(a, &mut rng, *sc, seed)?,
            "spire" => spire(a, &mut rng, *sc, seed)?,
            "crystal" => crystal(a, &mut rng, *sc, seed)?,
            "giant_tree" => giant_tree(a, &mut rng, *sc, seed)?,
            "ring" => ring(a, &mut rng, *sc, seed)?,
            "ribcage" => ribcage(a, &mut rng, *sc, seed)?,
            "skull" => skull(a, &mut rng, *sc, seed)?,
            _ => unreachable!(),
        };
        let mut y = p.y - sink;
        if kind == "floating_island" || kind == "ring" {
            // a point given as x,y,z keeps its y; x,z points float `altitude` above the ground
            let surface = w.top(p.x.floor() as i32, p.z.floor() as i32, &infos).map(|t| t as f64 + 1.0).unwrap_or(w.min_y as f64);
            let explicit_y = at_explicit || (p.y - surface).abs() > 0.5;
            if explicit_y {
                y = p.y;
            } else {
                let alt = spec::f(a, "altitude", 60.0);
                y = p.y + alt * (0.8 + 0.4 * rng.f());
            }
        }
        total += sh.place(w, (p.x.floor() as i32, y.floor() as i32, p.z.floor() as i32), soft);
    }
    Ok(format!("{} × {kind}: {} blocks", spots.len(), fmt_n(total)))
}
