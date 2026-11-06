//! Binary meshes for the web viewer.
//!
//! Chunk mesh layout (little endian):
//!   u32 n_opaque, u32 n_water,
//!   opaque positions i16×3 (×8 fixed point, x/z chunk-local), pad to 4,
//!   opaque colours u8×4,
//!   water positions, pad, water colours.
//! Vertices form independent triangles (6 per face).

use crate::blocks::{self, BlockInfo, Kind};
use crate::noise;
use crate::render;
use crate::world::{sidx, Section, World};
use rayon::prelude::*;

const DIRS: [(i32, i32, i32, f32); 6] = [
    (0, 1, 0, 1.0),   // top
    (0, -1, 0, 0.5),  // bottom
    (1, 0, 0, 0.78),  // east
    (-1, 0, 0, 0.78), // west
    (0, 0, 1, 0.64),  // south
    (0, 0, -1, 0.64), // north
];

struct Buf {
    pos: Vec<i16>,
    col: Vec<u8>,
}

impl Buf {
    fn new() -> Self {
        Buf { pos: vec![], col: vec![] }
    }
    fn quad(&mut self, v: [[f32; 3]; 4], c: [u8; 4]) {
        for &i in &[0usize, 1, 2, 0, 2, 3] {
            self.pos.push((v[i][0] * 8.0) as i16);
            self.pos.push((v[i][1] * 8.0) as i16);
            self.pos.push((v[i][2] * 8.0) as i16);
            self.col.extend_from_slice(&c);
        }
    }
    fn n(&self) -> u32 {
        (self.pos.len() / 3) as u32
    }
}

/// Face quad corners (counter-clockwise seen from outside).
fn face(d: usize, x: f32, y: f32, z: f32, top: f32) -> [[f32; 3]; 4] {
    let (x1, y1, z1) = (x + 1.0, y + top, z + 1.0);
    match d {
        0 => [[x, y1, z], [x, y1, z1], [x1, y1, z1], [x1, y1, z]],
        1 => [[x, y, z], [x1, y, z], [x1, y, z1], [x, y, z1]],
        2 => [[x1, y, z], [x1, y1, z], [x1, y1, z1], [x1, y, z1]],
        3 => [[x, y, z], [x, y, z1], [x, y1, z1], [x, y1, z]],
        4 => [[x, y, z1], [x1, y, z1], [x1, y1, z1], [x, y1, z1]],
        _ => [[x, y, z], [x, y1, z], [x1, y1, z], [x1, y, z]],
    }
}

pub fn chunk_mesh(w: &World, cx: i32, cz: i32) -> Vec<u8> {
    let infos = blocks::infos();
    let Some(ci) = w.chunk_index(cx, cz) else { return vec![0; 8] };
    let ch = &w.chunks[ci];
    let mut op = Buf::new();
    let mut wa = Buf::new();
    let n_y = ch.sections.len() * 16;
    let grass = blocks::id("grass_block");
    let dirt_c = infos[blocks::id("dirt") as usize].color;
    let get = |lx: i32, yi: i32, lz: i32| -> u16 {
        if yi < 0 {
            return blocks::id("bedrock");
        }
        if yi as usize >= n_y {
            return blocks::AIR;
        }
        if (0..16).contains(&lx) && (0..16).contains(&lz) {
            ch.get(lx as usize, yi as usize, lz as usize)
        } else {
            w.get(cx * 16 + lx, yi + w.min_y, cz * 16 + lz)
        }
    };
    for (si, sec) in ch.sections.iter().enumerate() {
        if sec.is_all_air() {
            continue;
        }
        // Fully buried uniform solid sections can be skipped if neighbours above/below are solid too.
        let uniform_solid = matches!(sec, Section::Uniform(b) if infos[*b as usize].kind == Kind::Solid);
        if uniform_solid {
            let above = ch.sections.get(si + 1).map(|s| matches!(s, Section::Uniform(b) if infos[*b as usize].kind == Kind::Solid)).unwrap_or(false);
            let below = si == 0 || matches!(ch.sections[si - 1], Section::Uniform(b) if infos[b as usize].kind == Kind::Solid);
            let mut sides_solid = true;
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                match w.chunk_index(cx + dx, cz + dz) {
                    Some(n) => {
                        if !matches!(w.chunks[n].sections[si], Section::Uniform(b) if infos[b as usize].kind == Kind::Solid) {
                            sides_solid = false;
                        }
                    }
                    None => sides_solid = false,
                }
            }
            if above && below && sides_solid {
                continue;
            }
        }
        for ly in 0..16 {
            let yi = (si * 16 + ly) as i32;
            for lz in 0..16i32 {
                for lx in 0..16i32 {
                    let id = sec.get(sidx(lx as usize, ly, lz as usize));
                    let info: &BlockInfo = &infos[id as usize];
                    if matches!(info.kind, Kind::Air | Kind::Plant) {
                        continue;
                    }
                    let y = yi + w.min_y;
                    let jitter = 0.93 + 0.14 * noise::unit(noise::hash3(7, cx * 16 + lx, y, cz * 16 + lz)) as f32;
                    let liquid = info.kind == Kind::Liquid;
                    let top_h = if liquid && infos[get(lx, yi + 1, lz) as usize].kind != Kind::Liquid { 0.875 } else { 1.0 };
                    for (d, &(dx, dy, dz, shade)) in DIRS.iter().enumerate() {
                        let nb = get(lx + dx, yi + dy, lz + dz);
                        let nk = infos[nb as usize].kind;
                        let draw = if liquid {
                            matches!(nk, Kind::Air | Kind::Plant)
                        } else {
                            matches!(nk, Kind::Air | Kind::Plant | Kind::Liquid) || (nk == Kind::Foliage && info.kind != Kind::Foliage) || (d == 0 && top_h < 1.0)
                        };
                        if !draw {
                            continue;
                        }
                        let base = if id == grass && d >= 1 { dirt_c } else { info.color };
                        let k = shade * jitter;
                        let a = if liquid { 170 } else { 255 };
                        let c = [(base[0] as f32 * k).min(255.0) as u8, (base[1] as f32 * k).min(255.0) as u8, (base[2] as f32 * k).min(255.0) as u8, a];
                        let q = face(d, lx as f32, y as f32, lz as f32, top_h);
                        if liquid {
                            wa.quad(q, c);
                        } else {
                            op.quad(q, c);
                        }
                    }
                }
            }
        }
    }
    let mut out = Vec::with_capacity(8 + op.pos.len() * 2 + op.col.len() + wa.pos.len() * 2 + wa.col.len() + 8);
    out.extend_from_slice(&op.n().to_le_bytes());
    out.extend_from_slice(&wa.n().to_le_bytes());
    for b in [&op, &wa] {
        for p in &b.pos {
            out.extend_from_slice(&p.to_le_bytes());
        }
        while out.len() % 4 != 0 {
            out.push(0);
        }
        out.extend_from_slice(&b.col);
    }
    out
}

/// Downsampled surface for the whole world:
/// i32 x0, i32 z0, u32 nx, u32 nz, u32 step, then per sample i16 y, u8 r,g,b, u8 flags(1 = water, 2 = empty).
pub fn overview(w: &World, step: i32) -> Vec<u8> {
    let infos = blocks::infos();
    let (x0, z0, x1, z1) = w.bounds();
    let step = step.max(1);
    let nx = ((x1 - x0) / step + 1) as u32;
    let nz = ((z1 - z0) / step + 1) as u32;
    let samples: Vec<[u8; 6]> = (0..nz)
        .into_par_iter()
        .flat_map_iter(|iz| {
            let infos = &infos;
            (0..nx).map(move |ix| {
                let x = (x0 + ix as i32 * step).min(x1 - 1);
                let z = (z0 + iz as i32 * step).min(z1 - 1);
                match render::column_color(w, x, z, infos) {
                    Some((t, c)) => {
                        let water = infos[w.get(x, t, z) as usize].kind == Kind::Liquid;
                        let y = (t as i16).to_le_bytes();
                        [y[0], y[1], c[0], c[1], c[2], water as u8]
                    }
                    None => {
                        let y = (w.min_y as i16).to_le_bytes();
                        [y[0], y[1], 20, 22, 28, 2]
                    }
                }
            })
        })
        .collect();
    let mut out = Vec::with_capacity(20 + samples.len() * 6);
    out.extend_from_slice(&x0.to_le_bytes());
    out.extend_from_slice(&z0.to_le_bytes());
    out.extend_from_slice(&nx.to_le_bytes());
    out.extend_from_slice(&nz.to_le_bytes());
    out.extend_from_slice(&(step as u32).to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s);
    }
    out
}
