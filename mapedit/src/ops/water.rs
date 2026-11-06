//! Water and roads: river, fill (lakes/sea, connected flood), road.

use super::{apply_heights, column_mask, cumulative, fmt_n, nearest_on_path, resample, HMap, EMPTY};
use crate::blocks::{self, Kind, AIR};
use crate::noise;
use crate::spec::{self, Area, Pattern, P3};
use crate::world::World;
use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::{BinaryHeap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

fn fluid_id(a: &Value) -> Result<u16> {
    let f = spec::s(a, "fluid").or_else(|| spec::s(a, "pattern")).unwrap_or("water");
    Ok(blocks::id(f))
}

fn bbox_of(pts: &[P3], r: f64, w: &World) -> (i32, i32, i32, i32) {
    let wb = w.bounds();
    let x0 = (pts.iter().map(|p| p.x).fold(f64::MAX, f64::min) - r).floor() as i32;
    let z0 = (pts.iter().map(|p| p.z).fold(f64::MAX, f64::min) - r).floor() as i32;
    let x1 = (pts.iter().map(|p| p.x).fold(f64::MIN, f64::max) + r).ceil() as i32 + 1;
    let z1 = (pts.iter().map(|p| p.z).fold(f64::MIN, f64::max) + r).ceil() as i32 + 1;
    (x0.max(wb.0), z0.max(wb.1), x1.min(wb.2), z1.min(wb.3))
}

/// River along a path; water level never rises downstream.
pub fn op_river(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let pts = spec::points(a.get("points").unwrap_or(&Value::Null), w, &infos)?;
    if pts.len() < 2 {
        bail!("river needs at least 2 points");
    }
    let width = spec::f(a, "width", 9.0).max(1.0);
    let depth = spec::f(a, "depth", 4.0).max(1.0);
    let bank = spec::f(a, "bank", 5.0).max(0.0);
    let meander = spec::f(a, "meander", 0.6);
    let fluid = fluid_id(a)?;
    let bed = Pattern::parse(spec::s(a, "bed").unwrap_or("50%gravel,30%sand,20%clay"))?;
    let infos = blocks::infos();
    let cum = cumulative(&pts);
    let bb = bbox_of(&pts, width + bank + width * meander + 4.0, w);
    let hm = HMap::read(w, bb.0, bb.1, bb.2, bb.3, &infos);
    // Water level along the path, sampled every block.
    let fine = resample(&pts);
    let fcum = cumulative(&fine);
    let mut wl: Vec<f64> = Vec::with_capacity(fine.len());
    let mut cur = f64::MAX;
    for p in &fine {
        let g = hm.get(p.x as i32, p.z as i32).map(|v| v as f64).unwrap_or(p.y - 1.0);
        let lvl = g.min(p.y - 1.0) - 1.0;
        cur = cur.min(lvl);
        wl.push(cur);
    }
    let level_at = |s: f64| -> f64 {
        let i = fcum.partition_point(|&c| c < s).min(wl.len() - 1);
        wl[i].floor()
    };
    let seed = w.seed ^ 0x51e7;
    let hw = width / 2.0;
    let mut water_lvl = vec![EMPTY; hm.y.len()];
    let mut newh = vec![EMPTY; hm.y.len()];
    for dz in 0..hm.h {
        for dx in 0..hm.w {
            let i = (dz * hm.w + dx) as usize;
            let old = hm.y[i];
            if old == EMPTY {
                continue;
            }
            let (x, z) = ((hm.x0 + dx) as f64, (hm.z0 + dz) as f64);
            let (d0, s) = nearest_on_path(&pts, &cum, x, z);
            let off = meander * width * noise::perlin2(seed, s / 60.0, 0.5);
            // signed lateral offset is unknown here; approximate meander by widening/narrowing.
            let d = (d0 - off.abs() * 0.5).max(0.0);
            let lw = hw * (1.0 + 0.25 * noise::perlin2(seed ^ 7, s / 25.0, 1.5));
            let level = level_at(s);
            if d <= lw {
                let b = level - depth * (1.0 - (d / lw).powi(2)).max(0.15);
                if b < old as f64 {
                    newh[i] = b.round() as i32;
                }
                water_lvl[i] = level as i32;
            } else if d <= lw + bank {
                let t = (d - lw) / bank.max(1e-6);
                let target = level + 1.0 + (old as f64 - level - 1.0) * t * t;
                if target < old as f64 {
                    newh[i] = target.round() as i32;
                }
            }
        }
    }
    // Lower the channel and banks (bed material only inside the channel).
    let n_cols = apply_heights(w, &hm, &newh, None, seed);
    let min_y = w.min_y;
    let water = AtomicU64::new(0);
    let wlr = &water_lvl;
    let hmr = &hm;
    w.par_chunks(bb.0, bb.1, bb.2, bb.3, |ch, cx, cz| {
        let mut changed = false;
        let mut cnt = 0;
        for lz in 0..16 {
            for lx in 0..16 {
                let (gx, gz) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                let (dx, dz) = (gx - hmr.x0, gz - hmr.z0);
                if dx < 0 || dz < 0 || dx >= hmr.w || dz >= hmr.h {
                    continue;
                }
                let lvl = wlr[(dz * hmr.w + dx) as usize];
                if lvl == EMPTY {
                    continue;
                }
                let Some(gy) = ch.top_where(lx, lz, &infos, |b| b.solid()) else { continue };
                let g = gy as i32 + min_y;
                if g < lvl {
                    changed |= ch.set(lx, gy, lz, bed.pick(gx, g, gz, seed));
                }
                for y in (g + 1)..=lvl {
                    let yi = (y - min_y) as usize;
                    let cur = ch.get(lx, yi, lz);
                    let k = infos[cur as usize].kind;
                    if matches!(k, Kind::Air | Kind::Plant | Kind::Foliage | Kind::Wood) && ch.set(lx, yi, lz, fluid) {
                        changed = true;
                        cnt += 1;
                    }
                }
            }
        }
        water.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    let (s, e) = (wl.first().copied().unwrap_or(0.0), wl.last().copied().unwrap_or(0.0));
    Ok(format!("{} {} blocks along {:.0} m; water level {:.0} → {:.0}; {} columns reshaped", fmt_n(water.into_inner()), blocks::name(fluid).trim_start_matches("minecraft:"), fcum.last().unwrap_or(&0.0), s, e, fmt_n(n_cols)))
}

/// Fill fluid up to `level`. With `at` and no `area`: connected flood from
/// that point (sea/lake that follows the coastline). Otherwise fills every
/// column of the area whose ground is below the level.
pub fn op_fill(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let fluid = fluid_id(a)?;
    let connected = a.get("area").is_none() && a.get("at").is_some() && spec::b(a, "connected", true);
    let level = match a.get("level") {
        Some(v) if v.is_number() || v.is_string() => spec::f(a, "level", 62.0) as i32,
        _ => match spec::s(a, "at") {
            Some(at) => spec::point(at, w, &infos)?.y as i32,
            None => bail!("fill needs 'level' (y) or 'at'"),
        },
    };
    let (x0, z0, x1, z1);
    let inside: Vec<bool>;
    if connected {
        let p = spec::point(spec::req_s(a, "at")?, w, &infos)?;
        let r = spec::f(a, "radius", 1e9);
        let b = w.bounds();
        let bb = ((p.x - r).floor().max(b.0 as f64) as i32, (p.z - r).floor().max(b.1 as f64) as i32, (p.x + r).ceil().min(b.2 as f64) as i32, (p.z + r).ceil().min(b.3 as f64) as i32);
        (x0, z0, x1, z1) = bb;
        let hm = HMap::read(w, x0, z0, x1, z1, &infos);
        let mut seen = vec![false; hm.y.len()];
        let (sx, sz) = (p.x.floor() as i32, p.z.floor() as i32);
        let mut q = VecDeque::new();
        if sx >= x0 && sz >= z0 && sx < x1 && sz < z1 {
            q.push_back((sx, sz));
            seen[hm.idx(sx, sz)] = true;
        }
        while let Some((x, z)) = q.pop_front() {
            for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, nz) = (x + dx, z + dz);
                if nx < x0 || nz < z0 || nx >= x1 || nz >= z1 {
                    continue;
                }
                let i = hm.idx(nx, nz);
                if seen[i] {
                    continue;
                }
                let g = hm.y[i];
                if g == EMPTY || g < level {
                    seen[i] = true;
                    q.push_back((nx, nz));
                }
            }
        }
        inside = seen;
    } else {
        let area = Area::from_args(a, w, &infos)?;
        (x0, z0, x1, z1) = area.bbox(w);
        inside = column_mask(w, &area, x0, z0, x1, z1);
    }
    let wd = x1 - x0;
    let min_y = w.min_y;
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
                let g = ch.top_where(lx, lz, &infos, |b| b.solid()).map(|v| v as i32 + min_y).unwrap_or(min_y - 1);
                for y in (g + 1)..=level {
                    let yi = (y - min_y) as usize;
                    if yi >= ch.sections.len() * 16 {
                        break;
                    }
                    let cur = ch.get(lx, yi, lz);
                    if matches!(infos[cur as usize].kind, Kind::Air | Kind::Plant) && ch.set(lx, yi, lz, fluid) {
                        changed = true;
                        cnt += 1;
                    }
                }
            }
        }
        n.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    Ok(format!("{} {} blocks up to y={}{}", fmt_n(n.into_inner()), blocks::name(fluid).trim_start_matches("minecraft:"), level, if connected { " (connected flood)" } else { "" }))
}

/// A* over a coarse grid minimising slope; returns a dense polyline.
fn route(hm: &HMap, from: P3, to: P3, cell: i32, water_y: &dyn Fn(i32, i32) -> bool) -> Vec<P3> {
    let gw = (hm.w + cell - 1) / cell;
    let gh = (hm.h + cell - 1) / cell;
    let gi = |x: i32, z: i32| ((z - hm.z0) / cell).clamp(0, gh - 1) * gw + ((x - hm.x0) / cell).clamp(0, gw - 1);
    let center = |i: i32| (hm.x0 + (i % gw) * cell + cell / 2, hm.z0 + (i / gw) * cell + cell / 2);
    let height = |i: i32| {
        let (x, z) = center(i);
        hm.get_c(x, z, 64) as f64
    };
    let (s, t) = (gi(from.x as i32, from.z as i32), gi(to.x as i32, to.z as i32));
    let n = (gw * gh) as usize;
    let mut dist = vec![f64::MAX; n];
    let mut prev = vec![-1i32; n];
    #[derive(PartialEq)]
    struct St(f64, i32);
    impl Eq for St {}
    impl PartialOrd for St {
        fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(o))
        }
    }
    impl Ord for St {
        fn cmp(&self, o: &Self) -> std::cmp::Ordering {
            o.0.partial_cmp(&self.0).unwrap_or(std::cmp::Ordering::Equal)
        }
    }
    let (tx, tz) = center(t);
    let hfun = |i: i32| {
        let (x, z) = center(i);
        (((x - tx).pow(2) + (z - tz).pow(2)) as f64).sqrt()
    };
    let mut pq = BinaryHeap::new();
    dist[s as usize] = 0.0;
    pq.push(St(hfun(s), s));
    let mut expanded = 0;
    while let Some(St(_, u)) = pq.pop() {
        if u == t {
            break;
        }
        expanded += 1;
        if expanded > 2_000_000 {
            break;
        }
        let (ux, uz) = (u % gw, u / gw);
        let hu = height(u);
        for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            let (vx, vz) = (ux + dx, uz + dz);
            if vx < 0 || vz < 0 || vx >= gw || vz >= gh {
                continue;
            }
            let v = vz * gw + vx;
            let step = cell as f64 * if dx != 0 && dz != 0 { 1.414 } else { 1.0 };
            let dh = (height(v) - hu).abs();
            let grade = dh / step;
            let (cx, cz) = center(v);
            let wet = if water_y(cx, cz) { 6.0 * step } else { 0.0 };
            let cost = step + dh * 3.0 + grade * grade * step * 25.0 + wet;
            let nd = dist[u as usize] + cost;
            if nd < dist[v as usize] {
                dist[v as usize] = nd;
                prev[v as usize] = u;
                pq.push(St(nd + hfun(v), v));
            }
        }
    }
    let mut path = vec![];
    let mut c = t;
    if prev[t as usize] < 0 && s != t {
        return vec![from, to];
    }
    while c >= 0 {
        let (x, z) = center(c);
        path.push(P3 { x: x as f64, y: 0.0, z: z as f64 });
        if c == s {
            break;
        }
        c = prev[c as usize];
    }
    path.reverse();
    if let Some(f) = path.first_mut() {
        *f = from;
    }
    if let Some(l) = path.last_mut() {
        *l = to;
    }
    // light smoothing (Chaikin)
    for _ in 0..2 {
        if path.len() < 3 {
            break;
        }
        let mut sm = vec![path[0]];
        for wnd in path.windows(2) {
            let (p, q) = (wnd[0], wnd[1]);
            sm.push(P3 { x: 0.75 * p.x + 0.25 * q.x, y: 0.0, z: 0.75 * p.z + 0.25 * q.z });
            sm.push(P3 { x: 0.25 * p.x + 0.75 * q.x, y: 0.0, z: 0.25 * p.z + 0.75 * q.z });
        }
        sm.push(*path.last().unwrap());
        path = sm;
    }
    path
}

/// Road along a path: graded elevation, cleared headroom, bridges over water.
pub fn op_road(w: &mut World, a: &Value) -> Result<String> {
    let infos = blocks::infos();
    let mut pts = spec::points(a.get("points").unwrap_or(&Value::Null), w, &infos)?;
    if pts.len() < 2 {
        bail!("road needs at least 2 points");
    }
    let width = spec::f(a, "width", 5.0).max(1.0);
    let surface = Pattern::parse(spec::s(a, "pattern").unwrap_or("70%dirt_path,20%coarse_dirt,10%gravel"))?;
    let support = Pattern::parse(spec::s(a, "support").unwrap_or("cobblestone"))?;
    let bridge = Pattern::parse(spec::s(a, "bridge").unwrap_or("spruce_planks"))?;
    let clear = spec::i(a, "clear", 4) as i32;
    let max_grade = spec::f(a, "max_grade", 0.2).max(0.02);
    let auto = spec::b(a, "route", false);
    let infos = blocks::infos();
    let wb = w.bounds();
    // Water lookup (top liquid above ground)
    let wr: &World = w;
    let is_water = |x: i32, z: i32| -> bool {
        let t = wr.top(x, z, &infos);
        let g = wr.ground(x, z, &infos);
        matches!((t, g), (Some(t), Some(g)) if t > g && infos[wr.get(x, t, z) as usize].kind == Kind::Liquid)
    };
    if auto {
        let bb = bbox_of(&pts, 160.0, w);
        let hm = HMap::read(w, bb.0, bb.1, bb.2, bb.3, &infos);
        let mut dense = vec![pts[0]];
        for seg in pts.windows(2) {
            let r = route(&hm, seg[0], seg[1], 4, &is_water);
            dense.extend(r.into_iter().skip(1));
        }
        pts = dense;
    }
    let fine = resample(&pts);
    let fcum = cumulative(&fine);
    let cum = cumulative(&pts);
    // Elevation profile: ground (or water surface + 1), averaged then grade-limited.
    let raw: Vec<f64> = fine
        .iter()
        .map(|p| {
            let (x, z) = (p.x.floor() as i32, p.z.floor() as i32);
            let g = w.ground(x, z, &infos).unwrap_or(w.min_y) as f64;
            let t = w.top(x, z, &infos).unwrap_or(w.min_y) as f64;
            if is_water(x, z) {
                t + 1.0
            } else {
                g
            }
        })
        .collect();
    let win = spec::i(a, "smooth", 10).max(0) as usize;
    let mut e: Vec<f64> = (0..raw.len())
        .map(|i| {
            let (lo, hi) = (i.saturating_sub(win), (i + win).min(raw.len() - 1));
            raw[lo..=hi].iter().sum::<f64>() / (hi - lo + 1) as f64
        })
        .collect();
    for i in 1..e.len() {
        e[i] = e[i].clamp(e[i - 1] - max_grade, e[i - 1] + max_grade);
    }
    for i in (0..e.len().saturating_sub(1)).rev() {
        e[i] = e[i].clamp(e[i + 1] - max_grade, e[i + 1] + max_grade);
    }
    // keep above water where the raw profile said water
    for i in 0..e.len() {
        let (x, z) = (fine[i].x.floor() as i32, fine[i].z.floor() as i32);
        if is_water(x, z) {
            e[i] = e[i].max(raw[i]);
        }
    }
    let elev = |s: f64| -> i32 {
        let i = fcum.partition_point(|&c| c < s).min(e.len() - 1);
        e[i].round() as i32
    };
    let hw = width / 2.0;
    let shoulder = spec::f(a, "shoulder", 3.0);
    let reach = hw + shoulder + 1.0;
    let bb = bbox_of(&pts, reach, w);
    let hm = HMap::read(w, bb.0.max(wb.0), bb.1.max(wb.1), bb.2.min(wb.2), bb.3.min(wb.3), &infos);
    let mut newh = vec![EMPTY; hm.y.len()];
    let mut road_y = vec![EMPTY; hm.y.len()];
    for dz in 0..hm.h {
        for dx in 0..hm.w {
            let i = (dz * hm.w + dx) as usize;
            let old = hm.y[i];
            let (x, z) = (hm.x0 + dx, hm.z0 + dz);
            let (d, s) = nearest_on_path(&pts, &cum, x as f64 + 0.5, z as f64 + 0.5);
            if d > reach {
                continue;
            }
            let ry = elev(s);
            let wet = is_water(x, z);
            if d <= hw {
                road_y[i] = ry;
                if !wet && old != EMPTY && (old - ry).abs() <= 12 {
                    newh[i] = ry;
                }
            } else if !wet && old != EMPTY && shoulder > 0.0 {
                let t = ((d - hw) / shoulder).clamp(0.0, 1.0);
                let v = ry as f64 + (old - ry) as f64 * t;
                newh[i] = v.round() as i32;
            }
        }
    }
    apply_heights(w, &hm, &newh, Some(&support), 11);
    let min_y = w.min_y;
    let max_y = w.max_y();
    let n = AtomicU64::new(0);
    let hmr = &hm;
    let ryr = &road_y;
    w.par_chunks(hm.x0, hm.z0, hm.x0 + hm.w, hm.z0 + hm.h, |ch, cx, cz| {
        let mut changed = false;
        let mut cnt = 0;
        for lz in 0..16 {
            for lx in 0..16 {
                let (gx, gz) = (cx * 16 + lx as i32, cz * 16 + lz as i32);
                let (dx, dz) = (gx - hmr.x0, gz - hmr.z0);
                if dx < 0 || dz < 0 || dx >= hmr.w || dz >= hmr.h {
                    continue;
                }
                let ry = ryr[(dz * hmr.w + dx) as usize];
                if ry == EMPTY || ry < min_y || ry >= max_y {
                    continue;
                }
                let yi = (ry - min_y) as usize;
                let below = if yi > 0 { ch.get(lx, yi - 1, lz) } else { AIR };
                let cur = ch.get(lx, yi, lz);
                let over_void = !infos[below as usize].solid() && !infos[cur as usize].solid();
                let id = if over_void || infos[below as usize].kind == Kind::Liquid { bridge.pick(gx, ry, gz, 5) } else { surface.pick(gx, ry, gz, 5) };
                if ch.set(lx, yi, lz, id) {
                    changed = true;
                    cnt += 1;
                }
                for k in 1..=clear {
                    let y2 = yi + k as usize;
                    if y2 >= ch.sections.len() * 16 {
                        break;
                    }
                    let b = ch.get(lx, y2, lz);
                    if !blocks::is_air(b) && infos[b as usize].kind != Kind::Liquid {
                        changed |= ch.set(lx, y2, lz, AIR);
                    }
                }
            }
        }
        n.fetch_add(cnt, Ordering::Relaxed);
        changed
    });
    Ok(format!("{} road blocks over {:.0} m{}", fmt_n(n.into_inner()), fcum.last().unwrap_or(&0.0), if auto { " (auto-routed)" } else { "" }))
}
