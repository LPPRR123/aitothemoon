//! Voxel ray tracer for the `view` tool: true 3D (overhangs, floating
//! islands, arches), translucent glass/water, emissive blocks with local
//! glow, sun/moon shadows, time of day, fog and bloom.

use crate::blocks::{self, BlockInfo, Kind};
use crate::noise;
use crate::render::Image;
use crate::spec::P3;
use crate::world::{sidx, Section, World};
use anyhow::Result;
use rayon::prelude::*;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Time {
    Day,
    Dusk,
    Night,
}

impl Time {
    pub fn parse(s: &str) -> Time {
        match s {
            "night" | "midnight" | "夜" | "夜晚" => Time::Night,
            "dusk" | "sunset" | "dawn" | "黄昏" => Time::Dusk,
            _ => Time::Day,
        }
    }
}

pub struct RtOpts {
    pub width: usize,
    pub height: usize,
    pub fov: f64,
    pub distance: f64,
    pub time: Time,
    /// Override sky/fog colour (e.g. blood-red sky).
    pub sky: Option<[f64; 3]>,
    pub fog: f64,
    pub bloom: f64,
    pub shadows: bool,
    /// Sun (or moon) direction override: (azimuth deg, 0 = north, elevation deg).
    pub sun: Option<(f64, f64)>,
    /// Ambient light multiplier.
    pub ambient: f64,
    /// Camera-to-target distance; fog thins out for far-away overview shots.
    pub focus: f64,
}

type V = [f64; 3];
#[inline]
fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn mul(a: V, k: f64) -> V {
    [a[0] * k, a[1] * k, a[2] * k]
}
#[inline]
fn hadamard(a: V, b: V) -> V {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}
#[inline]
fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: V) -> V {
    let l = dot(a, a).sqrt().max(1e-12);
    mul(a, 1.0 / l)
}
fn lerp3(a: V, b: V, t: f64) -> V {
    add(mul(a, 1.0 - t), mul(b, t))
}
fn col(c: [u8; 3]) -> V {
    // sRGB-ish to linear-ish (gamma 2)
    let f = |v: u8| (v as f64 / 255.0).powi(2);
    [f(c[0]), f(c[1]), f(c[2])]
}

struct Light {
    sun_dir: V,
    sun_col: V,
    ambient: V,
    sky_top: V,
    sky_horizon: V,
    fog_col: V,
    night: bool,
}

fn lighting(o: &RtOpts) -> Light {
    let mut l = match o.time {
        Time::Day => Light {
            sun_dir: norm([-0.45, 0.8, 0.4]),
            sun_col: [1.0, 0.96, 0.88],
            ambient: [0.36, 0.40, 0.48],
            sky_top: [0.12, 0.30, 0.78],
            sky_horizon: [0.52, 0.68, 0.92],
            fog_col: [0.58, 0.68, 0.86],
            night: false,
        },
        Time::Dusk => Light {
            sun_dir: norm([-0.8, 0.22, 0.3]),
            sun_col: [1.0, 0.62, 0.35],
            ambient: [0.25, 0.22, 0.30],
            sky_top: [0.17, 0.20, 0.45],
            sky_horizon: [0.98, 0.58, 0.36],
            fog_col: [0.78, 0.55, 0.48],
            night: false,
        },
        Time::Night => Light {
            sun_dir: norm([0.35, 0.75, -0.45]),
            sun_col: [0.26, 0.30, 0.46],
            ambient: [0.06, 0.07, 0.13],
            sky_top: [0.005, 0.01, 0.035],
            sky_horizon: [0.03, 0.05, 0.12],
            fog_col: [0.03, 0.04, 0.10],
            night: true,
        },
    };
    if let Some((az, el)) = o.sun {
        let (a, e) = (az.to_radians(), el.to_radians());
        l.sun_dir = norm([a.sin() * e.cos(), e.sin(), -a.cos() * e.cos()]);
    }
    l.ambient = mul(l.ambient, o.ambient);
    if let Some(s) = o.sky {
        l.sky_horizon = s;
        l.sky_top = mul(s, 0.35);
        l.fog_col = mul(s, 0.8);
        l.ambient = add(mul(l.ambient, 0.6), mul(s, 0.12));
    }
    l
}

struct Ctx<'a> {
    w: &'a World,
    infos: &'a [BlockInfo],
    lo: V,
    hi: V,
    light: Option<LightVol>,
}

/// Minecraft-style block light (0..15) flood-filled from emissive blocks in a
/// box around the camera: light passes through air, plants, liquids, glass
/// and leaves, losing one level per block.
struct LightVol {
    x0: i32,
    y0: i32,
    z0: i32,
    nx: i32,
    ny: i32,
    nz: i32,
    data: Vec<u8>,
}

impl LightVol {
    fn build(w: &World, infos: &[BlockInfo], cx: f64, cz: f64, r: i32) -> LightVol {
        let (bx0, bz0, bx1, bz1) = w.bounds();
        let x0 = (cx as i32 - r).max(bx0);
        let z0 = (cz as i32 - r).max(bz0);
        let x1 = (cx as i32 + r).min(bx1);
        let z1 = (cz as i32 + r).min(bz1);
        let (nx, nz) = ((x1 - x0).max(1), (z1 - z0).max(1));
        let ny = w.n_sections as i32 * 16;
        let y0 = w.min_y;
        let mut lv = LightVol { x0, y0, z0, nx, ny, nz, data: vec![0; (nx * ny * nz) as usize] };
        let pass = |id: u16| {
            let i = &infos[id as usize];
            matches!(i.kind, Kind::Air | Kind::Plant | Kind::Liquid | Kind::Foliage) || i.translucent
        };
        // seed from emissive blocks (skip uniform sections without emitters)
        let mut queue: Vec<(i32, i32, i32)> = vec![];
        for cz in z0.div_euclid(16)..=((z1 - 1).div_euclid(16)) {
            for cxx in x0.div_euclid(16)..=((x1 - 1).div_euclid(16)) {
                let Some(ci) = w.chunk_index(cxx, cz) else { continue };
                for (si, s) in w.chunks[ci].sections.iter().enumerate() {
                    if let Section::Uniform(b) = s {
                        if infos[*b as usize].emit == 0 {
                            continue;
                        }
                    }
                    for ly in 0..16 {
                        for lz in 0..16 {
                            for lx in 0..16 {
                                let id = s.get(sidx(lx, ly, lz));
                                let e = infos[id as usize].emit;
                                if e == 0 {
                                    continue;
                                }
                                let (x, y, z) = (cxx * 16 + lx as i32, y0 + si as i32 * 16 + ly as i32, cz * 16 + lz as i32);
                                if let Some(i) = lv.idx(x, y, z) {
                                    if lv.data[i] < e {
                                        lv.data[i] = e;
                                        queue.push((x, y, z));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // BFS by decreasing level
        let mut head = 0;
        while head < queue.len() {
            let (x, y, z) = queue[head];
            head += 1;
            let l = lv.data[lv.idx(x, y, z).unwrap()];
            if l <= 1 {
                continue;
            }
            for (dx, dy, dz) in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)] {
                let (nx2, ny2, nz2) = (x + dx, y + dy, z + dz);
                let Some(i) = lv.idx(nx2, ny2, nz2) else { continue };
                if lv.data[i] >= l - 1 {
                    continue;
                }
                if !pass(w.get(nx2, ny2, nz2)) {
                    continue;
                }
                lv.data[i] = l - 1;
                queue.push((nx2, ny2, nz2));
            }
        }
        lv
    }
    #[inline]
    fn idx(&self, x: i32, y: i32, z: i32) -> Option<usize> {
        let (dx, dy, dz) = (x - self.x0, y - self.y0, z - self.z0);
        if dx < 0 || dy < 0 || dz < 0 || dx >= self.nx || dy >= self.ny || dz >= self.nz {
            return None;
        }
        Some(((dy * self.nz + dz) * self.nx + dx) as usize)
    }
    #[inline]
    fn get(&self, x: i32, y: i32, z: i32) -> Option<u8> {
        self.idx(x, y, z).map(|i| self.data[i])
    }
}

impl<'a> Ctx<'a> {
    #[inline]
    fn section(&self, x: i32, y: i32, z: i32) -> Option<&'a Section> {
        let yi = y - self.w.min_y;
        if yi < 0 || yi >= self.w.n_sections as i32 * 16 {
            return None;
        }
        let ci = self.w.chunk_index(x.div_euclid(16), z.div_euclid(16))?;
        self.w.chunks[ci].sections.get((yi >> 4) as usize)
    }
    #[inline]
    fn block(&self, x: i32, y: i32, z: i32) -> u16 {
        match self.section(x, y, z) {
            Some(s) => s.get(sidx(x.rem_euclid(16) as usize, (y - self.w.min_y).rem_euclid(16) as usize, z.rem_euclid(16) as usize)),
            None => blocks::AIR,
        }
    }
}

/// Ray/AABB slab test: returns (t_enter, t_exit).
fn slab(o: V, d: V, lo: V, hi: V) -> Option<(f64, f64)> {
    let mut t0: f64 = 0.0;
    let mut t1: f64 = f64::MAX;
    for i in 0..3 {
        if d[i].abs() < 1e-12 {
            if o[i] < lo[i] || o[i] > hi[i] {
                return None;
            }
        } else {
            let a = (lo[i] - o[i]) / d[i];
            let b = (hi[i] - o[i]) / d[i];
            let (a, b) = if a < b { (a, b) } else { (b, a) };
            t0 = t0.max(a);
            t1 = t1.min(b);
            if t0 > t1 {
                return None;
            }
        }
    }
    Some((t0, t1))
}

pub struct Hit {
    pub t: f64,
    pub id: u16,
    pub normal: [i32; 3],
    pub pos: [i32; 3],
}

/// March from `o` along `d` up to `tmax`; call `f` on each non-air block.
/// `f` returns true to stop. Uniform-air sections are skipped wholesale.
fn march(c: &Ctx, o: V, d: V, tmax: f64, mut f: impl FnMut(&Hit) -> bool) {
    let Some((t_in, t_out)) = slab(o, d, c.lo, c.hi) else { return };
    let tend = t_out.min(tmax);
    let mut t = t_in + 1e-6;
    let mut normal = [0i32; 3];
    // pick entry face normal if we started outside
    if t_in > 0.0 {
        let p = add(o, mul(d, t_in));
        for i in 0..3 {
            if (p[i] - c.lo[i]).abs() < 1e-6 {
                normal[i] = -1;
            } else if (p[i] - c.hi[i]).abs() < 1e-6 {
                normal[i] = 1;
            }
        }
    }
    'outer: while t < tend {
        let p = add(o, mul(d, t));
        let mut cell = [p[0].floor() as i32, p[1].floor() as i32, p[2].floor() as i32];
        // Section skip: if this 16³ section is all air, jump to its exit.
        if let Some(s) = c.section(cell[0], cell[1], cell[2]) {
            if s.is_all_air() {
                let sx = cell[0].div_euclid(16) * 16;
                let sy = (cell[1] - c.w.min_y).div_euclid(16) * 16 + c.w.min_y;
                let sz = cell[2].div_euclid(16) * 16;
                let lo = [sx as f64, sy as f64, sz as f64];
                let hi = [lo[0] + 16.0, lo[1] + 16.0, lo[2] + 16.0];
                if let Some((_, te)) = slab(o, d, lo, hi) {
                    // normal of the exit face (becomes entry normal of next cell)
                    let pe = add(o, mul(d, te));
                    normal = [0; 3];
                    for i in 0..3 {
                        if (pe[i] - hi[i]).abs() < 1e-6 && d[i] > 0.0 {
                            normal[i] = -1;
                        } else if (pe[i] - lo[i]).abs() < 1e-6 && d[i] < 0.0 {
                            normal[i] = 1;
                        }
                    }
                    t = te.max(t) + 1e-6;
                    continue 'outer;
                }
            }
        } else {
            break;
        }
        // Block DDA inside this section.
        let step = [d[0].signum() as i32, d[1].signum() as i32, d[2].signum() as i32];
        let mut tmaxv = [0.0f64; 3];
        let mut tdelta = [0.0f64; 3];
        for i in 0..3 {
            if d[i].abs() < 1e-12 {
                tmaxv[i] = f64::MAX;
                tdelta[i] = f64::MAX;
            } else {
                let next = if d[i] > 0.0 { cell[i] as f64 + 1.0 } else { cell[i] as f64 };
                tmaxv[i] = (next - o[i]) / d[i];
                tdelta[i] = 1.0 / d[i].abs();
            }
        }
        let sec_of = |cl: &[i32; 3]| (cl[0].div_euclid(16), (cl[1] - c.w.min_y).div_euclid(16), cl[2].div_euclid(16));
        let start_sec = sec_of(&cell);
        loop {
            let id = c.block(cell[0], cell[1], cell[2]);
            if !blocks::is_air(id) {
                let h = Hit { t, id, normal, pos: cell };
                if f(&h) {
                    return;
                }
            }
            // advance
            let axis = if tmaxv[0] < tmaxv[1] {
                if tmaxv[0] < tmaxv[2] { 0 } else { 2 }
            } else if tmaxv[1] < tmaxv[2] {
                1
            } else {
                2
            };
            t = tmaxv[axis];
            if t >= tend {
                return;
            }
            cell[axis] += step[axis];
            tmaxv[axis] += tdelta[axis];
            normal = [0; 3];
            normal[axis] = -step[axis];
            if sec_of(&cell) != start_sec {
                t += 1e-6;
                continue 'outer;
            }
        }
    }
}

fn in_shadow(c: &Ctx, p: V, dir: V) -> bool {
    let mut hit = false;
    march(c, p, dir, 260.0, |h| {
        let i = &c.infos[h.id as usize];
        if matches!(i.kind, Kind::Solid | Kind::Wood | Kind::Foliage) && !i.translucent {
            hit = true;
            return true;
        }
        false
    });
    hit
}

/// Light from nearby emissive blocks (cheap fixed-pattern sampling).
fn local_glow(c: &Ctx, p: [i32; 3], n: [i32; 3]) -> V {
    const OFFS: [[i32; 3]; 26] = [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
        [2, 0, 0], [-2, 0, 0], [0, 2, 0], [0, -2, 0], [0, 0, 2], [0, 0, -2],
        [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
        [3, 1, 0], [-3, 1, 0], [0, 1, 3], [0, 1, -3], [0, 3, 0], [0, -3, 0],
    ];
    let base = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
    let mut acc = [0.0; 3];
    for o in OFFS.iter() {
        let q = [base[0] + o[0], base[1] + o[1], base[2] + o[2]];
        let id = c.block(q[0], q[1], q[2]);
        let inf = &c.infos[id as usize];
        if inf.emit > 0 {
            let d2 = (o[0] * o[0] + o[1] * o[1] + o[2] * o[2]) as f64 + 1.0;
            let k = inf.emit as f64 / 15.0 / d2 * 1.6;
            acc = add(acc, mul(col(inf.color), k));
        }
    }
    acc
}

fn sky(l: &Light, d: V, o: &RtOpts) -> (V, V) {
    let t = d[1].clamp(-0.2, 1.0).max(0.0).powf(0.6);
    let mut s = lerp3(l.sky_horizon, l.sky_top, t);
    let mut emit = [0.0; 3];
    // sun / moon disc
    let sd = dot(d, l.sun_dir);
    if l.night {
        if sd > 0.9978 {
            // moon: white, tinted toward the sky colour (red sky → blood moon)
            let m = match o.sky {
                Some(s) => {
                    let mx = s[0].max(s[1]).max(s[2]).max(1e-6);
                    let sat = [s[0] / mx, s[1] / mx, s[2] / mx];
                    let k = if sat[0] > 0.9 && sat[1] < 0.4 { 0.92 } else { 0.2 };
                    lerp3([0.95, 0.95, 0.9], sat, k)
                }
                None => [0.95, 0.95, 0.88],
            };
            s = add(s, mul(m, 1.6));
            emit = mul(m, 1.2);
        } else if sd > 0.993 {
            let g = (sd - 0.993) / 0.0048;
            emit = mul([0.5, 0.5, 0.6], g * 0.4);
            s = add(s, emit);
        }
        // stars
        if d[1] > 0.02 {
            let (sx, sy, sz) = ((d[0] * 900.0) as i32, (d[1] * 900.0) as i32, (d[2] * 900.0) as i32);
            let h = noise::hash3(99, sx, sy, sz);
            if h % 997 == 0 {
                let b = 0.4 + noise::unit(h) * 0.6;
                s = add(s, [b, b, b]);
            }
        }
    } else if sd > 0.9985 {
        s = add(s, mul(l.sun_col, 2.0));
        emit = mul(l.sun_col, 0.8);
    }
    (s, emit)
}

/// Trace one primary ray: returns (colour, emissive part for bloom).
fn trace(c: &Ctx, l: &Light, o: &RtOpts, eye: V, d: V) -> (V, V) {
    let mut color = [0.0; 3];
    let mut emis = [0.0; 3];
    let mut trans = 1.0;
    let mut dist = o.distance;
    let mut water_layers = 0;
    let mut glass_layers = 0;
    // absolute distance fog: fog=0.3 → ~17% at 100 blocks, ~60% at 500
    let fog_density = (0.0002 + o.fog * 0.006) * (250.0 / o.focus.max(250.0));
    march(c, eye, d, o.distance, |h| {
        let inf = &c.infos[h.id as usize];
        if inf.invisible {
            return false;
        }
        // plants, lanterns, flowers: a small box inside the cell, not a full cube
        if inf.kind == Kind::Plant {
            let (bx, by, bz) = (h.pos[0] as f64, h.pos[1] as f64, h.pos[2] as f64);
            if slab(eye, d, [bx + 0.3, by, bz + 0.3], [bx + 0.7, by + 0.55, bz + 0.7]).is_none() {
                return false;
            }
        }
        let albedo = col(inf.color);
        let p = add(eye, mul(d, h.t));
        let n = [h.normal[0] as f64, h.normal[1] as f64, h.normal[2] as f64];
        // lighting
        let ndl = dot(n, l.sun_dir).max(0.0);
        let mut direct = 0.0;
        if ndl > 0.0 {
            direct = ndl;
            if o.shadows && h.t < 600.0 {
                let sp = add(p, mul(n, 0.02));
                if in_shadow(c, sp, l.sun_dir) {
                    direct = 0.0;
                }
            }
        }
        let side = match h.normal {
            [0, 1, 0] => 1.0,
            [0, -1, 0] => 0.55,
            [1, 0, 0] | [-1, 0, 0] => 0.82,
            _ => 0.72,
        };
        let mut glow = if h.t < 260.0 { local_glow(c, h.pos, h.normal) } else { [0.0; 3] };
        if let (Some(lv), 0) = (&c.light, inf.emit) {
            let q = [h.pos[0] + h.normal[0], h.pos[1] + h.normal[1], h.pos[2] + h.normal[2]];
            if let Some(l) = lv.get(q[0], q[1], q[2]) {
                let k = (l as f64 / 15.0).powi(2) * 0.8;
                glow = add(mul(glow, 0.6), mul([1.0, 0.9, 0.78], k));
            }
        }
        let jitter = 0.92 + 0.16 * noise::unit(noise::hash3(5, h.pos[0], h.pos[1], h.pos[2]));
        let lit = add(mul(l.ambient, side), mul(l.sun_col, direct));
        let lit = add(lit, glow);
        let mut shade = mul(hadamard(albedo, lit), jitter);
        let em = inf.emit as f64 / 15.0;
        if em > 0.0 {
            let e = mul(albedo, 0.35 + em * 1.25);
            shade = add(shade, e);
            emis = add(emis, mul(e, trans));
        }
        let alpha = if inf.kind == Kind::Liquid && inf.emit == 0 {
            water_layers += 1;
            if water_layers > 1 {
                // inside water: only fog it a bit more
                0.18
            } else {
                0.55
            }
        } else if inf.translucent {
            glass_layers += 1;
            if glass_layers > 6 {
                1.0
            } else {
                0.42
            }
        } else {
            1.0
        };
        // distance fog per layer
        let fogk = 1.0 - (-h.t * fog_density).exp();
        let shade = lerp3(shade, l.fog_col, fogk.clamp(0.0, 1.0));
        color = add(color, mul(shade, trans * alpha));
        trans *= 1.0 - alpha;
        if trans < 0.03 || water_layers > 10 {
            dist = h.t;
            trans = 0.0;
            return true;
        }
        false
    });
    if trans > 0.0 {
        let (s, e) = sky(l, d, o);
        let fogk = if dist < o.distance { 1.0 - (-dist * fog_density).exp() } else { 0.0 };
        color = add(color, mul(lerp3(s, l.fog_col, fogk), trans));
        emis = add(emis, mul(e, trans));
    }
    (color, emis)
}

pub fn render(w: &World, cam: P3, yaw_deg: f64, pitch_deg: f64, o: &RtOpts) -> Result<Vec<u8>> {
    let infos = blocks::infos();
    let (x0, z0, x1, z1) = w.bounds();
    let l = lighting(o);
    // block light matters at night / dusk; build it around the camera
    let light = if o.time != Time::Day || o.ambient < 1.0 {
        let r = (o.distance as i32).clamp(32, 192);
        let fwd_x = cam.x + yaw_deg.to_radians().sin() * r as f64 * 0.6;
        let fwd_z = cam.z - yaw_deg.to_radians().cos() * r as f64 * 0.6;
        Some(LightVol::build(w, &infos, fwd_x, fwd_z, r))
    } else {
        None
    };
    let c = Ctx { w, infos: &infos, lo: [x0 as f64, w.min_y as f64, z0 as f64], hi: [x1 as f64, w.max_y() as f64, z1 as f64], light };
    let (yaw, pitch) = (yaw_deg.to_radians(), pitch_deg.to_radians());
    let f = [yaw.sin() * pitch.cos(), pitch.sin(), -yaw.cos() * pitch.cos()];
    let r = [yaw.cos(), 0.0, yaw.sin()];
    let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    let (wd, ht) = (o.width, o.height);
    let tanw = (o.fov.to_radians() / 2.0).tan();
    let aspect = wd as f64 / ht as f64;
    let eye = [cam.x, cam.y, cam.z];
    let rows: Vec<Vec<(V, V)>> = (0..ht)
        .into_par_iter()
        .map(|py| {
            (0..wd)
                .map(|px| {
                    let sx = ((px as f64 + 0.5) / wd as f64) * 2.0 - 1.0;
                    let sy = 1.0 - ((py as f64 + 0.5) / ht as f64) * 2.0;
                    let d = norm(add(add(f, mul(r, sx * tanw)), mul(u, sy * tanw / aspect)));
                    trace(&c, &l, o, eye, d)
                })
                .collect()
        })
        .collect();
    // bloom: blur the emissive buffer and add it back
    let mut em: Vec<V> = rows.iter().flat_map(|r| r.iter().map(|p| p.1)).collect();
    if o.bloom > 0.0 {
        let rad = ((wd.max(ht) as f64) / 150.0).ceil().max(2.0) as i32;
        for _ in 0..3 {
            em = blur(&em, wd, ht, rad, true);
            em = blur(&em, wd, ht, rad, false);
        }
    }
    let mut img = Image::new(wd, ht, [0, 0, 0]);
    for (py, row) in rows.iter().enumerate() {
        for (px, (c0, _)) in row.iter().enumerate() {
            let b = em[py * wd + px];
            let v = add(*c0, mul(b, o.bloom * 1.2));
            // tone map + gamma
            let tm = |x: f64| ((x / (1.0 + x * 0.35)).max(0.0).sqrt() * 255.0).clamp(0.0, 255.0) as u8;
            img.px[py * wd + px] = [tm(v[0]), tm(v[1]), tm(v[2])];
        }
    }
    img.png()
}

fn blur(src: &[V], w: usize, h: usize, r: i32, horiz: bool) -> Vec<V> {
    let mut out = vec![[0.0; 3]; src.len()];
    let norm = 1.0 / (2 * r + 1) as f64;
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, o) in row.iter_mut().enumerate() {
            let mut acc = [0.0; 3];
            for k in -r..=r {
                let (sx, sy) = if horiz { ((x as i32 + k).clamp(0, w as i32 - 1) as usize, y) } else { (x, (y as i32 + k).clamp(0, h as i32 - 1) as usize) };
                acc = add(acc, src[sy * w + sx]);
            }
            *o = mul(acc, norm);
        }
    });
    out
}
