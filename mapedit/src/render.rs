//! Images for the agent (and humans): shaded top-down map with zone labels,
//! and a perspective "voxel space" 3D view. Both return PNG bytes.

use crate::blocks::{self, BlockInfo, Kind};
use crate::spec::{self, P3};
use crate::world::World;
use anyhow::Result;
use rayon::prelude::*;

pub struct Image {
    pub w: usize,
    pub h: usize,
    pub px: Vec<[u8; 3]>,
}

impl Image {
    pub fn new(w: usize, h: usize, c: [u8; 3]) -> Self {
        Image { w, h, px: vec![c; w * h] }
    }
    #[inline]
    pub fn put(&mut self, x: i32, y: i32, c: [u8; 3]) {
        if x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h {
            self.px[y as usize * self.w + x as usize] = c;
        }
    }
    pub fn png(&self) -> Result<Vec<u8>> {
        let mut out = vec![];
        {
            let mut enc = png::Encoder::new(&mut out, self.w as u32, self.h as u32);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header()?;
            let raw: Vec<u8> = self.px.iter().flat_map(|p| p.iter().copied()).collect();
            wr.write_image_data(&raw)?;
        }
        Ok(out)
    }
    pub fn text(&mut self, x: i32, y: i32, s: &str, scale: i32, fg: [u8; 3], bg: Option<[u8; 3]>) {
        let s = s.to_uppercase();
        let wpx = s.chars().count() as i32 * 4 * scale;
        if let Some(b) = bg {
            for yy in (y - scale)..(y + 6 * scale) {
                for xx in (x - scale)..(x + wpx) {
                    self.put(xx, yy, b);
                }
            }
        }
        for (i, ch) in s.chars().enumerate() {
            let g = glyph(ch);
            for (row, bits) in g.iter().enumerate() {
                for col in 0..3 {
                    if bits & (4 >> col) != 0 {
                        for sy in 0..scale {
                            for sx in 0..scale {
                                self.put(x + (i as i32 * 4 + col) * scale + sx, y + row as i32 * scale + sy, fg);
                            }
                        }
                    }
                }
            }
        }
    }
}

fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [7, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 7],
        '2' => [7, 1, 7, 4, 7],
        '3' => [7, 1, 7, 1, 7],
        '4' => [5, 5, 7, 1, 1],
        '5' => [7, 4, 7, 1, 7],
        '6' => [7, 4, 7, 5, 7],
        '7' => [7, 1, 1, 1, 1],
        '8' => [7, 5, 7, 5, 7],
        '9' => [7, 5, 7, 1, 7],
        'A' => [2, 5, 7, 5, 5],
        'B' => [6, 5, 6, 5, 6],
        'C' => [3, 4, 4, 4, 3],
        'D' => [6, 5, 5, 5, 6],
        'E' => [7, 4, 6, 4, 7],
        'F' => [7, 4, 6, 4, 4],
        'G' => [3, 4, 5, 5, 3],
        'H' => [5, 5, 7, 5, 5],
        'I' => [7, 2, 2, 2, 7],
        'J' => [1, 1, 1, 5, 2],
        'K' => [5, 5, 6, 5, 5],
        'L' => [4, 4, 4, 4, 7],
        'M' => [5, 7, 7, 5, 5],
        'N' => [6, 5, 5, 5, 5],
        'O' => [2, 5, 5, 5, 2],
        'P' => [6, 5, 6, 4, 4],
        'Q' => [2, 5, 5, 6, 3],
        'R' => [6, 5, 6, 5, 5],
        'S' => [3, 4, 2, 1, 6],
        'T' => [7, 2, 2, 2, 2],
        'U' => [5, 5, 5, 5, 7],
        'V' => [5, 5, 5, 5, 2],
        'W' => [5, 5, 7, 7, 5],
        'X' => [5, 5, 2, 5, 5],
        'Y' => [5, 5, 2, 2, 2],
        'Z' => [7, 1, 2, 4, 7],
        '-' => [0, 0, 7, 0, 0],
        '.' => [0, 0, 0, 0, 2],
        ',' => [0, 0, 0, 2, 4],
        ':' => [0, 2, 0, 2, 0],
        '=' => [0, 7, 0, 7, 0],
        '_' => [0, 0, 0, 0, 7],
        '/' => [1, 1, 2, 4, 4],
        _ => [0, 0, 0, 0, 0],
    }
}

/// (top y, colour) of a column as seen from above; water tinted by depth.
pub fn column_color(w: &World, x: i32, z: i32, infos: &[BlockInfo]) -> Option<(i32, [u8; 3])> {
    let t = w.top(x, z, infos)?;
    let b = w.get(x, t, z);
    let info = &infos[b as usize];
    let mut c = info.color;
    if info.kind == Kind::Liquid && !blocks::name(b).contains("lava") {
        let g = w.ground(x, z, infos).unwrap_or(t - 20);
        let depth = (t - g).clamp(0, 24) as f32 / 24.0;
        let gc = infos[w.get(x, g, z) as usize].color;
        let k = 0.45 + 0.5 * depth;
        for i in 0..3 {
            c[i] = (gc[i] as f32 * (1.0 - k) + c[i] as f32 * k) as u8;
        }
    }
    Some((t, c))
}

fn shade(c: [u8; 3], k: f32) -> [u8; 3] {
    [(c[0] as f32 * k).clamp(0.0, 255.0) as u8, (c[1] as f32 * k).clamp(0.0, 255.0) as u8, (c[2] as f32 * k).clamp(0.0, 255.0) as u8]
}

pub struct MapOpts {
    pub size: usize,
    pub mode: String,
    pub zones: bool,
    pub labels: bool,
    pub grid: i32,
}

/// Shaded top-down map of a rect. Returns (png, legend text).
pub fn render_map(w: &World, rect: (i32, i32, i32, i32), o: &MapOpts) -> Result<(Vec<u8>, String)> {
    let infos = blocks::infos();
    let (x0, z0, x1, z1) = rect;
    let (bw, bh) = ((x1 - x0).max(1) as f64, (z1 - z0).max(1) as f64);
    let scale = (bw.max(bh) / o.size as f64).max(1.0 / 8.0);
    let (iw, ih) = ((bw / scale).round().max(1.0) as usize, (bh / scale).round().max(1.0) as usize);
    let sample = |px: usize, pz: usize| -> (i32, i32) { ((x0 as f64 + (px as f64 + 0.5) * scale).floor() as i32, (z0 as f64 + (pz as f64 + 0.5) * scale).floor() as i32) };
    let cols: Vec<Option<(i32, [u8; 3], u16)>> = (0..ih)
        .into_par_iter()
        .flat_map_iter(|pz| {
            let infos = &infos;
            (0..iw).map(move |px| {
                let (x, z) = sample(px, pz);
                column_color(w, x, z, infos).map(|(t, c)| (t, c, w.biome(x, z)))
            })
        })
        .collect();
    let (mut hmin, mut hmax) = (i32::MAX, i32::MIN);
    for c in cols.iter().flatten() {
        hmin = hmin.min(c.0);
        hmax = hmax.max(c.0);
    }
    let mut img = Image::new(iw, ih, [18, 20, 26]);
    let hat = |px: i32, pz: i32| -> Option<i32> {
        if px < 0 || pz < 0 || px as usize >= iw || pz as usize >= ih {
            return None;
        }
        cols[pz as usize * iw + px as usize].map(|c| c.0)
    };
    for pz in 0..ih {
        for px in 0..iw {
            let Some((t, c, biome)) = cols[pz * iw + px] else { continue };
            let col = match o.mode.as_str() {
                "height" => {
                    let v = ((t - hmin) as f32 / (hmax - hmin).max(1) as f32 * 255.0) as u8;
                    [v, v, v]
                }
                "biome" => {
                    let n = crate::world::biome_name(biome);
                    let mut h: u32 = 2166136261;
                    for b in n.bytes() {
                        h = (h ^ b as u32).wrapping_mul(16777619);
                    }
                    [(80 + (h & 0x9f)) as u8, (80 + ((h >> 8) & 0x9f)) as u8, (80 + ((h >> 16) & 0x9f)) as u8]
                }
                _ => {
                    // hillshade, light from north-west
                    let (pi, zi) = (px as i32, pz as i32);
                    let l = hat(pi - 1, zi).unwrap_or(t);
                    let u = hat(pi, zi - 1).unwrap_or(t);
                    let d = ((l - t) + (u - t)) as f32 / scale as f32;
                    let k = (1.0 - d * 0.12).clamp(0.55, 1.35);
                    let hk = 0.85 + 0.3 * ((t - hmin) as f32 / (hmax - hmin).max(1) as f32);
                    shade(c, k * hk)
                }
            };
            img.put(px as i32, pz as i32, col);
        }
    }
    // grid
    if o.grid > 0 {
        let g = o.grid;
        let mut gx = x0.div_euclid(g) * g;
        while gx < x1 {
            let px = ((gx - x0) as f64 / scale) as i32;
            for pz in (0..ih as i32).step_by(2) {
                let i = pz as usize * iw + px.clamp(0, iw as i32 - 1) as usize;
                let c = img.px[i];
                img.put(px, pz, shade(c, if gx == 0 { 0.4 } else { 0.7 }));
            }
            gx += g;
        }
        let mut gz = z0.div_euclid(g) * g;
        while gz < z1 {
            let pz = ((gz - z0) as f64 / scale) as i32;
            for px in (0..iw as i32).step_by(2) {
                let i = pz.clamp(0, ih as i32 - 1) as usize * iw + px as usize;
                let c = img.px[i];
                img.put(px, pz, shade(c, if gz == 0 { 0.4 } else { 0.7 }));
            }
            gz += g;
        }
    }
    let mut legend = format!(
        "map of x {x0}..{} z {z0}..{} ({}×{} px, 1 px = {:.2} blocks, north = up, +x = right). surface y range {}..{}.",
        x1 - 1,
        z1 - 1,
        iw,
        ih,
        scale,
        if hmin == i32::MAX { 0 } else { hmin },
        if hmax == i32::MIN { 0 } else { hmax }
    );
    let to_px = |x: f64, z: f64| (((x - x0 as f64) / scale) as i32, ((z - z0 as f64) / scale) as i32);
    if o.zones && !w.zones.is_empty() {
        // zone borders
        let zid: Vec<i32> = (0..ih)
            .into_par_iter()
            .flat_map_iter(|pz| (0..iw).map(move |px| {
                let (x, z) = sample(px, pz);
                w.zones.zone_at(x as f64 + 0.5, z as f64 + 0.5).map(|i| i as i32).unwrap_or(-1)
            }))
            .collect();
        for pz in 0..ih {
            for px in 0..iw {
                let a = zid[pz * iw + px];
                let r = if px + 1 < iw { zid[pz * iw + px + 1] } else { a };
                let d = if pz + 1 < ih { zid[(pz + 1) * iw + px] } else { a };
                if a != r || a != d {
                    img.put(px as i32, pz as i32, [250, 250, 240]);
                }
            }
        }
        if o.labels {
            let sc = if iw >= 700 { 2 } else { 1 };
            for g in &w.zones.gates {
                let (gx, gz) = to_px(g.x, g.z);
                for dy in -2..=2 {
                    for dx in -2..=2 {
                        img.put(gx + dx, gz + dy, [255, 200, 40]);
                    }
                }
                img.text(gx + 4, gz - 2, &g.id, sc, [255, 220, 120], Some([30, 24, 10]));
            }
            for zn in &w.zones.zones {
                let (zx, zz) = to_px(zn.cx, zn.cz);
                let label = &zn.id;
                img.text(zx - (label.len() as i32 * 2 * sc), zz - 3 * sc, label, sc + 1, [255, 255, 255], Some([20, 20, 30]));
            }
            legend.push_str(" white lines = zone borders, white labels = zone ids at zone centres, yellow squares = gates.");
        }
    }
    Ok((img.png()?, legend))
}

pub struct ViewOpts {
    pub width: usize,
    pub height: usize,
    pub fov: f64,
    pub distance: f64,
}

/// Perspective heightfield render (voxel-space style).
pub fn render_view(w: &World, cam: P3, yaw_deg: f64, pitch_deg: f64, o: &ViewOpts) -> Result<Vec<u8>> {
    let infos = blocks::infos();
    let (wd, ht) = (o.width, o.height);
    let focal = (wd as f64 / 2.0) / (o.fov.to_radians() / 2.0).tan();
    let yaw = yaw_deg.to_radians();
    let horizon = ht as f64 / 2.0 + pitch_deg.to_radians().tan() * focal;
    let sky_top = [94u8, 140, 210];
    let sky_bot = [196u8, 214, 236];
    let fog = sky_bot;
    let columns: Vec<Vec<[u8; 3]>> = (0..wd)
        .into_par_iter()
        .map(|sx| {
            let mut col = vec![[0u8; 3]; ht];
            for (y, c) in col.iter_mut().enumerate() {
                let t = y as f32 / ht as f32;
                *c = [
                    (sky_top[0] as f32 * (1.0 - t) + sky_bot[0] as f32 * t) as u8,
                    (sky_top[1] as f32 * (1.0 - t) + sky_bot[1] as f32 * t) as u8,
                    (sky_top[2] as f32 * (1.0 - t) + sky_bot[2] as f32 * t) as u8,
                ];
            }
            let off = ((sx as f64 - wd as f64 / 2.0) / focal).atan();
            let ang = yaw + off;
            let (dx, dz) = (ang.sin(), -ang.cos());
            let cosf = off.cos();
            let mut ybuf = ht as i32;
            let mut dist = 1.0;
            while dist < o.distance && ybuf > 0 {
                let (x, z) = (cam.x + dx * dist, cam.z + dz * dist);
                let (xi, zi) = (x.floor() as i32, z.floor() as i32);
                if let Some((t, c)) = column_color(w, xi, zi, &infos) {
                    let depth = dist * cosf;
                    let sy = (horizon + (cam.y - (t as f64 + 1.0)) * focal / depth) as i32;
                    if sy < ybuf {
                        // slope shading
                        let tx = w.top(xi + 1, zi, &infos).unwrap_or(t);
                        let tz = w.top(xi, zi - 1, &infos).unwrap_or(t);
                        let k = (1.0 + ((t - tx) as f32 * 0.08) + ((tz - t) as f32 * -0.08)).clamp(0.6, 1.3);
                        let fogk = ((dist / o.distance).powf(1.6) as f32).min(1.0) * 0.85;
                        let sc = shade(c, k);
                        let fc = [
                            (sc[0] as f32 * (1.0 - fogk) + fog[0] as f32 * fogk) as u8,
                            (sc[1] as f32 * (1.0 - fogk) + fog[1] as f32 * fogk) as u8,
                            (sc[2] as f32 * (1.0 - fogk) + fog[2] as f32 * fogk) as u8,
                        ];
                        for y in sy.max(0)..ybuf {
                            col[y as usize] = fc;
                        }
                        ybuf = sy.max(0);
                    }
                }
                dist += (dist * 0.006).max(0.5);
            }
            col
        })
        .collect();
    let mut img = Image::new(wd, ht, [0, 0, 0]);
    for (x, col) in columns.iter().enumerate() {
        for (y, c) in col.iter().enumerate() {
            img.px[y * wd + x] = *c;
        }
    }
    img.png()
}

/// Resolve a camera from tool args. Returns (cam, yaw, pitch, description).
pub fn camera_from_args(w: &World, a: &serde_json::Value) -> Result<(P3, f64, f64, String)> {
    let infos = blocks::infos();
    let (bx0, bz0, bx1, bz1) = w.bounds();
    let (cxm, czm) = ((bx0 + bx1) as f64 / 2.0, (bz0 + bz1) as f64 / 2.0);
    let size = ((bx1 - bx0).max(bz1 - bz0)) as f64;
    let target = match spec::s(a, "look_at") {
        Some(t) => spec::point(t, w, &infos)?,
        None => {
            let y = w.top(cxm as i32, czm as i32, &infos).unwrap_or(64) as f64;
            P3 { x: cxm, y, z: czm }
        }
    };
    let cam = match spec::s(a, "camera") {
        Some(c) => spec::point(c, w, &infos)?,
        None => {
            // from the south, elevated
            let back = spec::f(a, "back", size * 0.45);
            let up = spec::f(a, "up", size * 0.22);
            P3 { x: target.x, y: target.y + up, z: target.z + back }
        }
    };
    let (dx, dy, dz) = (target.x - cam.x, target.y - cam.y, target.z - cam.z);
    let yaw = match a.get("yaw") {
        Some(v) if v.is_number() => v.as_f64().unwrap(),
        _ => dx.atan2(-dz).to_degrees(),
    };
    let pitch = match a.get("pitch") {
        Some(v) if v.is_number() => v.as_f64().unwrap(),
        _ => (dy / (dx * dx + dz * dz).sqrt().max(1.0)).atan().to_degrees(),
    };
    Ok((cam, yaw, pitch, format!("camera {:.0},{:.0},{:.0} yaw {:.0}° pitch {:.0}°", cam.x, cam.y, cam.z, yaw, pitch)))
}
