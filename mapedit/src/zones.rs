//! Semantic layer: named hexagonal zones with terrain presets and named
//! gates between neighbouring zones. Tools can reference zones (`F2`) and
//! gates (`G07`) instead of raw coordinates, and `height(x,z)` in expressions
//! evaluates the blended design heightfield defined by the zones.

use crate::noise;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Zone {
    /// Short label used in tool calls ("Z03", or renamed e.g. "F2").
    pub id: String,
    /// Human name ("巨杉林").
    pub name: String,
    pub cx: f64,
    pub cz: f64,
    /// Terrain preset name.
    pub kind: String,
    pub base: f64,
    pub relief: f64,
    pub scale: f64,
    /// 0 = smooth fBm, 1 = ridged mountains.
    pub ridged: f64,
    pub biome: String,
    pub ring: i32,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Gate {
    pub id: String,
    pub a: String,
    pub b: String,
    pub x: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Zones {
    pub zones: Vec<Zone>,
    pub gates: Vec<Gate>,
    /// Centre-to-centre distance of neighbouring hexes.
    pub spacing: f64,
    /// Hex layout rings around origin (flower), or -1 if the grid fills the map.
    pub rings: i32,
    /// Terrain outside the flower (only used when rings >= 0).
    pub outside_base: f64,
    pub outside_relief: f64,
    pub seed: u32,
}

pub struct Preset {
    pub base: f64,
    pub relief: f64,
    pub scale: f64,
    pub ridged: f64,
    pub biome: &'static str,
}

pub const PRESETS: &[(&str, Preset)] = &[
    ("plains", Preset { base: 68.0, relief: 5.0, scale: 180.0, ridged: 0.0, biome: "plains" }),
    ("meadow", Preset { base: 74.0, relief: 9.0, scale: 160.0, ridged: 0.0, biome: "meadow" }),
    ("forest", Preset { base: 72.0, relief: 10.0, scale: 150.0, ridged: 0.0, biome: "forest" }),
    ("hills", Preset { base: 82.0, relief: 24.0, scale: 140.0, ridged: 0.1, biome: "windswept_hills" }),
    ("mountains", Preset { base: 130.0, relief: 70.0, scale: 240.0, ridged: 0.85, biome: "jagged_peaks" }),
    ("peaks", Preset { base: 165.0, relief: 85.0, scale: 200.0, ridged: 1.0, biome: "frozen_peaks" }),
    ("plateau", Preset { base: 108.0, relief: 7.0, scale: 200.0, ridged: 0.0, biome: "savanna_plateau" }),
    ("badlands", Preset { base: 92.0, relief: 16.0, scale: 120.0, ridged: 0.3, biome: "badlands" }),
    ("desert", Preset { base: 70.0, relief: 8.0, scale: 140.0, ridged: 0.0, biome: "desert" }),
    ("valley", Preset { base: 58.0, relief: 6.0, scale: 160.0, ridged: 0.0, biome: "plains" }),
    ("swamp", Preset { base: 61.0, relief: 2.0, scale: 80.0, ridged: 0.0, biome: "swamp" }),
    ("beach", Preset { base: 62.0, relief: 2.0, scale: 100.0, ridged: 0.0, biome: "beach" }),
    ("ocean", Preset { base: 34.0, relief: 8.0, scale: 220.0, ridged: 0.0, biome: "ocean" }),
    ("volcano", Preset { base: 112.0, relief: 40.0, scale: 180.0, ridged: 0.5, biome: "basalt_deltas" }),
    ("nether_wastes", Preset { base: 60.0, relief: 18.0, scale: 120.0, ridged: 0.2, biome: "nether_wastes" }),
    ("crimson", Preset { base: 66.0, relief: 14.0, scale: 120.0, ridged: 0.1, biome: "crimson_forest" }),
    ("warped", Preset { base: 66.0, relief: 14.0, scale: 120.0, ridged: 0.1, biome: "warped_forest" }),
];

pub fn preset(kind: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|(k, _)| *k == kind).map(|(_, p)| p)
}

const SQRT3: f64 = 1.7320508075688772;

impl Zones {
    pub fn is_empty(&self) -> bool {
        self.zones.is_empty()
    }

    fn hex_r(&self) -> f64 {
        self.spacing / SQRT3
    }

    /// Lay out pointy-top hexes. `rings >= 0` makes a hexagonal "flower"
    /// of 1 + 3·rings·(rings+1) zones centred on the origin; `rings < 0`
    /// fills the whole rectangle.
    pub fn layout_hex(bounds: (i32, i32, i32, i32), spacing: f64, rings: i32, seed: u32) -> Zones {
        let s = spacing.max(32.0);
        let (x0, z0, x1, z1) = (bounds.0 as f64, bounds.1 as f64, bounds.2 as f64, bounds.3 as f64);
        let mut cells = vec![];
        let rmax = ((z1 - z0) / (s * SQRT3 / 2.0)).ceil() as i32 + 2;
        let qmax = ((x1 - x0) / s).ceil() as i32 + rmax + 2;
        for r in -rmax..=rmax {
            for q in -qmax..=qmax {
                let ring = (q.abs() + r.abs() + (q + r).abs()) / 2;
                let cx = s * (q as f64 + r as f64 / 2.0);
                let cz = s * SQRT3 / 2.0 * r as f64;
                let keep = if rings >= 0 {
                    ring <= rings
                } else {
                    cx >= x0 - s * 0.3 && cx <= x1 + s * 0.3 && cz >= z0 - s * 0.3 && cz <= z1 + s * 0.3
                };
                if keep {
                    cells.push((cx, cz, ring));
                }
            }
        }
        // Stable ordering: by ring, then angle (flower) / by row (fill).
        if rings >= 0 {
            cells.sort_by(|a, b| {
                a.2.cmp(&b.2).then_with(|| {
                    let aa = (a.1).atan2(a.0);
                    let bb = (b.1).atan2(b.0);
                    aa.partial_cmp(&bb).unwrap()
                })
            });
        } else {
            cells.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(a.0.partial_cmp(&b.0).unwrap()));
        }
        let p = preset("plains").unwrap();
        let zones: Vec<Zone> = cells
            .iter()
            .enumerate()
            .map(|(i, &(cx, cz, ring))| Zone {
                id: format!("Z{:02}", i),
                name: String::new(),
                cx,
                cz,
                kind: "plains".into(),
                base: p.base,
                relief: p.relief,
                scale: p.scale,
                ridged: p.ridged,
                biome: format!("minecraft:{}", p.biome),
                ring,
                notes: String::new(),
            })
            .collect();
        let mut z = Zones { zones, gates: vec![], spacing: s, rings, outside_base: 34.0, outside_relief: 8.0, seed };
        z.rebuild_gates();
        z
    }

    pub fn rebuild_gates(&mut self) {
        let s = self.spacing;
        let mut gates = vec![];
        for i in 0..self.zones.len() {
            for j in i + 1..self.zones.len() {
                let (a, b) = (&self.zones[i], &self.zones[j]);
                let d = ((a.cx - b.cx).powi(2) + (a.cz - b.cz).powi(2)).sqrt();
                if d < s * 1.1 {
                    gates.push((i, j, (a.cx + b.cx) / 2.0, (a.cz + b.cz) / 2.0));
                }
            }
        }
        gates.sort_by(|a, b| a.3.partial_cmp(&b.3).unwrap().then(a.2.partial_cmp(&b.2).unwrap()));
        self.gates = gates
            .into_iter()
            .enumerate()
            .map(|(k, (i, j, x, z))| Gate { id: format!("G{:02}", k + 1), a: self.zones[i].id.clone(), b: self.zones[j].id.clone(), x, z })
            .collect();
    }

    pub fn find(&self, id: &str) -> Option<usize> {
        let id = id.trim();
        self.zones.iter().position(|z| z.id.eq_ignore_ascii_case(id) || (!z.name.is_empty() && z.name == id))
    }

    pub fn gate(&self, id: &str) -> Option<&Gate> {
        self.gates.iter().find(|g| g.id.eq_ignore_ascii_case(id.trim()))
    }

    /// Fractional hex-ring distance from the origin (flower layouts).
    fn ring_dist(&self, x: f64, z: f64) -> f64 {
        let r = self.hex_r();
        let q = (x * SQRT3 / 3.0 - z / 3.0) / r;
        let rr = (2.0 / 3.0 * z) / r;
        (q.abs() + rr.abs() + (q + rr).abs()) / 2.0
    }

    /// Nearest two zone centres: (idx1, d1, idx2, d2).
    fn nearest2(&self, x: f64, z: f64) -> Option<(usize, f64, usize, f64)> {
        let mut b1 = (usize::MAX, f64::MAX);
        let mut b2 = (usize::MAX, f64::MAX);
        for (i, zn) in self.zones.iter().enumerate() {
            let d = (zn.cx - x).powi(2) + (zn.cz - z).powi(2);
            if d < b1.1 {
                b2 = b1;
                b1 = (i, d);
            } else if d < b2.1 {
                b2 = (i, d);
            }
        }
        if b1.0 == usize::MAX {
            return None;
        }
        Some((b1.0, b1.1.sqrt(), b2.0, b2.1.sqrt()))
    }

    /// Which zone contains (x, z), if any.
    pub fn zone_at(&self, x: f64, z: f64) -> Option<usize> {
        if self.rings >= 0 && self.ring_dist(x, z) > self.rings as f64 + 0.5 {
            return None;
        }
        self.nearest2(x, z).map(|n| n.0)
    }

    /// Distance to the nearest zone border (0 on the border).
    pub fn edge_dist(&self, x: f64, z: f64) -> f64 {
        match self.nearest2(x, z) {
            Some((i, _, j, _)) if j != usize::MAX => {
                let (a, b) = (&self.zones[i], &self.zones[j]);
                let dab = ((b.cx - a.cx).powi(2) + (b.cz - a.cz).powi(2)).sqrt().max(1e-6);
                let da2 = (x - a.cx).powi(2) + (z - a.cz).powi(2);
                let db2 = (x - b.cx).powi(2) + (z - b.cz).powi(2);
                ((db2 - da2) / (2.0 * dab)).abs()
            }
            _ => 1e9,
        }
    }

    fn zone_height(&self, zn: &Zone, x: f64, z: f64) -> f64 {
        let seed = self.seed.wrapping_add(zn.scale as u32 * 31);
        let f = noise::fbm2(seed, x, z, zn.scale, 5);
        let r = noise::ridged2(seed ^ 0xabcd, x, z, zn.scale, 5) * 2.0 - 0.6;
        let n = f * (1.0 - zn.ridged) + r * zn.ridged;
        zn.base + zn.relief * n
    }

    /// Blended design heightfield.
    pub fn design_height(&self, x: f64, z: f64) -> f64 {
        let detail = 1.5 * noise::fbm2(self.seed ^ 0x5151, x, z, 18.0, 2);
        if self.zones.is_empty() {
            return 64.0 + 18.0 * noise::fbm2(self.seed, x, z, 200.0, 5) + detail;
        }
        let blend = self.spacing * 0.16;
        let d1 = self.nearest2(x, z).map(|n| n.1).unwrap_or(0.0);
        let mut sum = 0.0;
        let mut wsum = 0.0;
        for zn in &self.zones {
            let d = ((zn.cx - x).powi(2) + (zn.cz - z).powi(2)).sqrt();
            let t = (d - d1) / blend;
            if t > 3.0 {
                continue;
            }
            let w = (-t * t).exp();
            sum += w * self.zone_height(zn, x, z);
            wsum += w;
        }
        let mut h = sum / wsum.max(1e-9);
        if self.rings >= 0 {
            let rd = self.ring_dist(x, z);
            let edge = self.rings as f64 + 0.5;
            let t = ((rd - (edge - 0.25)) / 0.5).clamp(0.0, 1.0);
            let t = t * t * (3.0 - 2.0 * t);
            let out = self.outside_base + self.outside_relief * noise::fbm2(self.seed ^ 0x77, x, z, 200.0, 4);
            h = h * (1.0 - t) + out * t;
        }
        h + detail
    }

    /// Hexagon outline of a zone (pointy-top), for viewers.
    pub fn polygon(&self, i: usize) -> Vec<[f64; 2]> {
        let zn = &self.zones[i];
        let r = self.hex_r();
        (0..6)
            .map(|k| {
                let a = (30.0 + 60.0 * k as f64).to_radians();
                [zn.cx + r * a.cos(), zn.cz + r * a.sin()]
            })
            .collect()
    }

    pub fn apply_preset(zn: &mut Zone, kind: &str) -> bool {
        match preset(kind) {
            Some(p) => {
                zn.kind = kind.to_string();
                zn.base = p.base;
                zn.relief = p.relief;
                zn.scale = p.scale;
                zn.ridged = p.ridged;
                zn.biome = format!("minecraft:{}", p.biome);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flower_19() {
        let z = Zones::layout_hex((-1200, -1200, 1200, 1200), 440.0, 2, 1);
        assert_eq!(z.zones.len(), 19);
        // 19-hex flower has 42 internal edges.
        assert_eq!(z.gates.len(), 42);
        assert_eq!(z.zone_at(0.0, 0.0), Some(0));
        assert!(z.zone_at(1190.0, 1190.0).is_none());
        let h = z.design_height(10.0, 10.0);
        assert!(h > 40.0 && h < 100.0, "{h}");
    }
}
