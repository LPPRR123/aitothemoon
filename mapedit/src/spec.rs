//! Compact, LLM-friendly argument syntax: block patterns, masks, points,
//! paths and areas.

use crate::blocks::{self, BlockId, BlockInfo, Kind};
use crate::noise;
use crate::world::World;
use anyhow::{anyhow, bail, Result};
use serde_json::Value;

/// Split on top-level separators, ignoring those inside `[...]`.
pub fn split_top(s: &str, sep: char) -> Vec<String> {
    let mut out = vec![];
    let mut depth = 0;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '[' => depth += 1,
            ']' => depth -= 1,
            _ => {}
        }
        if ch == sep && depth == 0 {
            out.push(cur.trim().to_string());
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

// ---------------------------------------------------------------- pattern

/// Weighted random block pattern: `stone`, `60%stone,40%andesite`, `stone,gravel`.
#[derive(Clone, Debug)]
pub struct Pattern {
    pub entries: Vec<(BlockId, f64)>,
}

impl Pattern {
    pub fn parse(s: &str) -> Result<Pattern> {
        let parts = split_top(s, ',');
        if parts.is_empty() {
            bail!("empty block pattern");
        }
        let mut entries = vec![];
        let mut total = 0.0;
        for p in parts {
            let (w, name) = match p.find('%') {
                Some(i) if p[..i].trim().parse::<f64>().is_ok() => (p[..i].trim().parse::<f64>()?, p[i + 1..].trim().to_string()),
                _ => (1.0, p),
            };
            if name.is_empty() {
                bail!("empty block name in pattern '{s}'");
            }
            total += w;
            entries.push((blocks::id(&name), total));
        }
        for e in &mut entries {
            e.1 /= total;
        }
        Ok(Pattern { entries })
    }

    pub fn single(&self) -> Option<BlockId> {
        if self.entries.len() == 1 {
            Some(self.entries[0].0)
        } else {
            None
        }
    }

    #[inline]
    pub fn pick(&self, x: i32, y: i32, z: i32, seed: u32) -> BlockId {
        if self.entries.len() == 1 {
            return self.entries[0].0;
        }
        let r = noise::unit(noise::hash3(seed ^ 0x9a7, x, y, z));
        for &(id, c) in &self.entries {
            if r < c {
                return id;
            }
        }
        self.entries.last().unwrap().0
    }
}

// ---------------------------------------------------------------- mask

#[derive(Clone, Debug)]
enum MaskItem {
    Block(BlockId),
    /// Match by base name ignoring block-state properties.
    BaseName(String),
    Kind(Kind),
    Existing,
    Any,
}

/// Block mask: `stone,dirt`, `!air`, `#solid`, `#existing`, `#liquid`, `#foliage`, `#plant`, `*`.
#[derive(Clone, Debug)]
pub struct Mask {
    neg: bool,
    items: Vec<MaskItem>,
}

impl Mask {
    pub fn parse(s: &str) -> Result<Mask> {
        let s = s.trim();
        let (neg, s) = match s.strip_prefix('!') {
            Some(r) => (true, r),
            None => (false, s),
        };
        let mut items = vec![];
        for p in split_top(s, ',') {
            let item = match p.as_str() {
                "*" => MaskItem::Any,
                "#existing" | "#nonair" => MaskItem::Existing,
                "#solid" => MaskItem::Kind(Kind::Solid),
                "#liquid" => MaskItem::Kind(Kind::Liquid),
                "#foliage" | "#leaves" => MaskItem::Kind(Kind::Foliage),
                "#plant" | "#plants" => MaskItem::Kind(Kind::Plant),
                "#wood" => MaskItem::Kind(Kind::Wood),
                "#air" | "air" => MaskItem::Kind(Kind::Air),
                _ if p.starts_with('#') => bail!("unknown mask tag {p}; use #solid #liquid #foliage #plant #air #existing"),
                _ if p.contains('[') => MaskItem::Block(blocks::id(&p)),
                _ => MaskItem::BaseName(blocks::normalize(&p)),
            };
            items.push(item);
        }
        Ok(Mask { neg, items })
    }

    pub fn test(&self, id: BlockId, infos: &[BlockInfo]) -> bool {
        let Some(info) = infos.get(id as usize) else { return self.neg };
        let hit = self.items.iter().any(|it| match it {
            MaskItem::Any => true,
            MaskItem::Existing => info.kind != Kind::Air,
            MaskItem::Kind(k) => info.kind == *k,
            MaskItem::Block(b) => *b == id,
            MaskItem::BaseName(n) => {
                let full = blocks::name(id);
                full == *n || full.split('[').next() == Some(n.as_str())
            }
        });
        hit != self.neg
    }

    /// Precompute a lookup table for all currently registered ids (fast path).
    pub fn table(&self, infos: &[BlockInfo]) -> Vec<bool> {
        (0..infos.len()).map(|i| self.test(i as BlockId, infos)).collect()
    }
}

// ---------------------------------------------------------------- points

#[derive(Clone, Copy, Debug)]
pub struct P3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Parse one point: `x,y,z` | `x,z` (y = surface) | gate `G07` | zone `F2`.
/// Optional `+dy` suffix: `G07+3`.
pub fn point(s: &str, w: &World, infos: &[BlockInfo]) -> Result<P3> {
    let s = s.trim();
    let (s, dy) = match s.rfind('+') {
        Some(i) if i > 0 && !s[..i].ends_with(',') && s[i + 1..].trim().parse::<f64>().is_ok() && !s[..i].contains(',') => {
            (&s[..i], s[i + 1..].trim().parse::<f64>()?)
        }
        _ => (s, 0.0),
    };
    let surface = |x: f64, z: f64| w.top(x.floor() as i32, z.floor() as i32, infos).map(|y| y as f64 + 1.0).unwrap_or(w.min_y as f64);
    let nums: Vec<&str> = s.split(',').map(|p| p.trim()).collect();
    let parsed: Option<Vec<f64>> = nums.iter().map(|n| n.parse::<f64>().ok()).collect();
    if let Some(v) = parsed {
        return match v.len() {
            2 => Ok(P3 { x: v[0], y: surface(v[0], v[1]) + dy, z: v[1] }),
            3 => Ok(P3 { x: v[0], y: v[1] + dy, z: v[2] }),
            _ => bail!("point '{s}' must be 'x,y,z' or 'x,z'"),
        };
    }
    if let Some(g) = w.zones.gate(s) {
        return Ok(P3 { x: g.x, y: surface(g.x, g.z) + dy, z: g.z });
    }
    if let Some(i) = w.zones.find(s) {
        let zn = &w.zones.zones[i];
        return Ok(P3 { x: zn.cx, y: surface(zn.cx, zn.cz) + dy, z: zn.cz });
    }
    bail!("cannot parse point '{s}': use 'x,y,z', 'x,z', a gate id like G03, or a zone id")
}

/// Points from a string path (`a → b → c`, `a -> b`, `a; b`, `a | b`) or a JSON array.
pub fn points(v: &Value, w: &World, infos: &[BlockInfo]) -> Result<Vec<P3>> {
    let items: Vec<String> = match v {
        Value::String(s) => {
            let s = s.replace("->", "→").replace(';', "→").replace('|', "→").replace(" · ", "→");
            s.split('→').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
        }
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::String(s) => Ok(s.clone()),
                Value::Array(n) => Ok(n.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")),
                _ => Err(anyhow!("points array must contain strings")),
            })
            .collect::<Result<_>>()?,
        _ => bail!("points must be a string like 'x,y,z → x,y,z' or an array"),
    };
    items.iter().map(|p| point(p, w, infos)).collect()
}

// ---------------------------------------------------------------- areas

#[derive(Clone, Debug)]
pub enum Area {
    All,
    Rect(i32, i32, i32, i32),
    Circle(f64, f64, f64),
    Zones(Vec<usize>),
    /// Everything not covered by a zone (flower layouts).
    Outside,
}

impl Area {
    /// `all` | `rect:x0,z0,x1,z1` | `circle:x,z,r` | `zone:F1,F2` | `F2` | `G03:60` | `outside`
    pub fn parse(s: &str, w: &World, infos: &[BlockInfo]) -> Result<Area> {
        let s = s.trim();
        if s.is_empty() || s == "all" || s == "*" {
            return Ok(Area::All);
        }
        if s == "outside" {
            return Ok(Area::Outside);
        }
        if let Some(r) = s.strip_prefix("rect:") {
            let v: Vec<i32> = r.split(',').map(|p| p.trim().parse::<f64>().map(|f| f.round() as i32)).collect::<Result<_, _>>()?;
            if v.len() != 4 {
                bail!("rect needs x0,z0,x1,z1");
            }
            return Ok(Area::Rect(v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]) + 1, v[1].max(v[3]) + 1));
        }
        if let Some(r) = s.strip_prefix("circle:") {
            let parts: Vec<&str> = r.split(',').collect();
            if parts.len() == 3 {
                let v: Vec<f64> = parts.iter().map(|p| p.trim().parse::<f64>()).collect::<Result<_, _>>()?;
                return Ok(Area::Circle(v[0], v[1], v[2]));
            }
            if parts.len() == 2 {
                let p = point(parts[0], w, infos)?;
                return Ok(Area::Circle(p.x, p.z, parts[1].trim().parse()?));
            }
            bail!("circle needs x,z,r or ID,r");
        }
        let zs = s.strip_prefix("zone:").or_else(|| s.strip_prefix("zones:")).unwrap_or(s);
        // `G03:60` / `F2:100` => circle around an anchor
        if let Some((a, r)) = zs.split_once(':') {
            if let Ok(r) = r.trim().parse::<f64>() {
                let p = point(a, w, infos)?;
                return Ok(Area::Circle(p.x, p.z, r));
            }
        }
        let mut ids = vec![];
        for id in zs.split(',') {
            match w.zones.find(id) {
                Some(i) => ids.push(i),
                None => bail!("unknown zone '{id}' (zones: {})", w.zones.zones.iter().map(|z| z.id.as_str()).collect::<Vec<_>>().join(", ")),
            }
        }
        Ok(Area::Zones(ids))
    }

    /// Build from tool args: `area`, or `at` + `radius`.
    pub fn from_args(a: &Value, w: &World, infos: &[BlockInfo]) -> Result<Area> {
        if let Some(s) = a.get("area").and_then(|v| v.as_str()) {
            return Area::parse(s, w, infos);
        }
        if let Some(at) = a.get("at").and_then(|v| v.as_str()) {
            let p = point(at, w, infos)?;
            let r = a.get("radius").and_then(|v| v.as_f64()).unwrap_or(32.0);
            return Ok(Area::Circle(p.x, p.z, r));
        }
        Ok(Area::All)
    }

    pub fn contains(&self, x: i32, z: i32, w: &World) -> bool {
        match self {
            Area::All => true,
            Area::Rect(x0, z0, x1, z1) => x >= *x0 && x < *x1 && z >= *z0 && z < *z1,
            Area::Circle(cx, cz, r) => {
                let (dx, dz) = (x as f64 + 0.5 - cx, z as f64 + 0.5 - cz);
                dx * dx + dz * dz <= r * r
            }
            Area::Zones(ids) => match w.zones.zone_at(x as f64 + 0.5, z as f64 + 0.5) {
                Some(i) => ids.contains(&i),
                None => false,
            },
            Area::Outside => w.zones.zone_at(x as f64 + 0.5, z as f64 + 0.5).is_none(),
        }
    }

    /// Block bbox [x0,x1)×[z0,z1), clipped to the world.
    pub fn bbox(&self, w: &World) -> (i32, i32, i32, i32) {
        let b = w.bounds();
        let r = match self {
            Area::All | Area::Outside => b,
            Area::Rect(x0, z0, x1, z1) => (*x0, *z0, *x1, *z1),
            Area::Circle(cx, cz, r) => ((cx - r).floor() as i32, (cz - r).floor() as i32, (cx + r).ceil() as i32 + 1, (cz + r).ceil() as i32 + 1),
            Area::Zones(ids) => {
                let rad = w.zones.spacing / 1.7320508 + 2.0;
                let mut bb = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
                for &i in ids {
                    let zn = &w.zones.zones[i];
                    bb.0 = bb.0.min((zn.cx - rad) as i32);
                    bb.1 = bb.1.min((zn.cz - rad) as i32);
                    bb.2 = bb.2.max((zn.cx + rad) as i32 + 1);
                    bb.3 = bb.3.max((zn.cz + rad) as i32 + 1);
                }
                bb
            }
        };
        (r.0.max(b.0), r.1.max(b.1), r.2.min(b.2), r.3.min(b.3))
    }

    pub fn describe(&self, w: &World) -> String {
        match self {
            Area::All => "whole world".into(),
            Area::Outside => "outside the zones".into(),
            Area::Rect(a, b, c, d) => format!("rect {a},{b}..{},{}", c - 1, d - 1),
            Area::Circle(x, z, r) => format!("circle r={r} at {x:.0},{z:.0}"),
            Area::Zones(ids) => format!("zone {}", ids.iter().map(|&i| w.zones.zones[i].id.clone()).collect::<Vec<_>>().join(",")),
        }
    }
}

// ---------------------------------------------------------------- arg helpers

pub fn s<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(|v| v.as_str())
}

pub fn req_s<'a>(a: &'a Value, k: &str) -> Result<&'a str> {
    s(a, k).ok_or_else(|| anyhow!("missing string argument '{k}'"))
}

pub fn f(a: &Value, k: &str, d: f64) -> f64 {
    match a.get(k) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(d),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(d),
        _ => d,
    }
}

pub fn i(a: &Value, k: &str, d: i64) -> i64 {
    f(a, k, d as f64).round() as i64
}

pub fn b(a: &Value, k: &str, d: bool) -> bool {
    match a.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        _ => d,
    }
}

/// Comma list or JSON array of strings.
pub fn list(a: &Value, k: &str) -> Vec<String> {
    match a.get(k) {
        Some(Value::String(s)) => split_top(s, ',').into_iter().filter(|x| !x.is_empty()).collect(),
        Some(Value::Array(v)) => v.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).collect(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patterns() {
        let p = Pattern::parse("60%stone,40%andesite").unwrap();
        assert_eq!(p.entries.len(), 2);
        let p = Pattern::parse("oak_log[axis=x,foo=bar]").unwrap();
        assert!(p.single().is_some());
        let infos = blocks::infos();
        let m = Mask::parse("!air").unwrap();
        assert!(m.test(blocks::id("stone"), &blocks::infos()));
        assert!(!m.test(blocks::AIR, &infos));
        let m = Mask::parse("oak_log").unwrap();
        assert!(m.test(blocks::id("oak_log[axis=z]"), &blocks::infos()));
    }
    #[test]
    fn points_and_areas() {
        let mut w = World::new("t", 256, 256, -64, 384, "overworld", 1);
        w.zones = crate::zones::Zones::layout_hex(w.bounds(), 80.0, 1, 1);
        let infos = blocks::infos();
        let ps = points(&Value::String("0,70,0 → 10,20 -> G01".into()), &w, &infos).unwrap();
        assert_eq!(ps.len(), 3);
        assert_eq!(ps[0].y, 70.0);
        let a = Area::parse("Z00", &w, &infos).unwrap();
        assert!(a.contains(0, 0, &w));
        let a = Area::parse("G01:10", &w, &infos).unwrap();
        assert!(matches!(a, Area::Circle(..)));
    }
}
