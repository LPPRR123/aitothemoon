//! Minecraft Java "Anvil" save format: export worlds to a playable save
//! (region .mca files + level.dat) and import existing saves.
//!
//! Chunks are written in the 1.18+ format (sections with paletted
//! `block_states` / `biomes`), `isLightOn = 0` so the game relights them and
//! no heightmaps (the game recomputes them). Newer game versions upgrade the
//! chunks on load via DataFixerUpper, so targeting a well-known DataVersion is
//! the most robust choice.

use crate::blocks::{self, BlockId, AIR};
use crate::world::{self, Chunk, Section, World};
use anyhow::{anyhow, bail, Context, Result};
use fastnbt::Value as Nbt;
use flate2::read::{GzDecoder, ZlibDecoder};
use flate2::write::{GzEncoder, ZlibEncoder};
use rayon::prelude::*;
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const DEFAULT_DATA_VERSION: i32 = 4189; // 1.21.4
pub const DEFAULT_VERSION_NAME: &str = "1.21.4";

pub const VANILLA_BIOMES: &[&str] = &[
    "badlands", "bamboo_jungle", "basalt_deltas", "beach", "birch_forest", "cherry_grove", "cold_ocean", "crimson_forest",
    "dark_forest", "deep_cold_ocean", "deep_dark", "deep_frozen_ocean", "deep_lukewarm_ocean", "deep_ocean", "desert",
    "dripstone_caves", "end_barrens", "end_highlands", "end_midlands", "eroded_badlands", "flower_forest", "forest",
    "frozen_ocean", "frozen_peaks", "frozen_river", "grove", "ice_spikes", "jagged_peaks", "jungle", "lukewarm_ocean",
    "lush_caves", "mangrove_swamp", "meadow", "mushroom_fields", "nether_wastes", "ocean", "old_growth_birch_forest",
    "old_growth_pine_taiga", "old_growth_spruce_taiga", "pale_garden", "plains", "river", "savanna", "savanna_plateau",
    "small_end_islands", "snowy_beach", "snowy_plains", "snowy_slopes", "snowy_taiga", "soul_sand_valley",
    "sparse_jungle", "stony_peaks", "stony_shore", "sunflower_plains", "swamp", "taiga", "the_end", "the_void",
    "warm_ocean", "warped_forest", "windswept_forest", "windswept_gravelly_hills", "windswept_hills",
    "windswept_savanna", "wooded_badlands",
];

pub fn valid_biome(name: &str) -> bool {
    let n = name.strip_prefix("minecraft:").unwrap_or(name);
    VANILLA_BIOMES.contains(&n)
}

fn c(pairs: Vec<(&str, Nbt)>) -> Nbt {
    Nbt::Compound(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn bits_for(n: usize, min: u32) -> u32 {
    if n <= 1 {
        return 0;
    }
    let b = usize::BITS - (n - 1).leading_zeros();
    b.max(min)
}

fn pack(indices: &[u32], bits: u32) -> Vec<i64> {
    let per = 64 / bits as usize;
    let mut out = vec![0i64; indices.len().div_ceil(per)];
    for (i, &v) in indices.iter().enumerate() {
        let (li, off) = (i / per, (i % per) as u32 * bits);
        out[li] |= ((v as u64) << off) as i64;
    }
    out
}

fn unpack(data: &[i64], bits: u32, n: usize) -> Vec<u32> {
    let per = 64 / bits as usize;
    let mask = (1u64 << bits) - 1;
    (0..n)
        .map(|i| {
            let (li, off) = (i / per, (i % per) as u32 * bits);
            data.get(li).map(|&l| ((l as u64) >> off) & mask).unwrap_or(0) as u32
        })
        .collect()
}

fn state_nbt(id: BlockId) -> Nbt {
    let name = blocks::name(id);
    let (n, props) = blocks::split_state(&name);
    if props.is_empty() {
        c(vec![("Name", Nbt::String(n))])
    } else {
        let p: HashMap<String, Nbt> = props.into_iter().map(|(k, v)| (k, Nbt::String(v))).collect();
        c(vec![("Name", Nbt::String(n)), ("Properties", Nbt::Compound(p))])
    }
}

fn chunk_nbt(ch: &Chunk, cx: i32, cz: i32, min_y: i32, dv: i32, biome_names: &HashMap<u16, String>) -> Nbt {
    let mut sections = vec![];
    // Biome palette is the same for every section of the chunk.
    let mut bpal: Vec<u16> = vec![];
    for &b in &ch.biomes {
        if !bpal.contains(&b) {
            bpal.push(b);
        }
    }
    let bnames: Vec<Nbt> = bpal.iter().map(|b| Nbt::String(biome_names.get(b).cloned().unwrap_or_else(|| "minecraft:plains".into()))).collect();
    let bbits = bits_for(bpal.len(), 1);
    let bdata = if bbits > 0 {
        let idx: Vec<u32> = (0..64)
            .map(|i| {
                let (x, z) = (i & 3, (i >> 2) & 3);
                let b = ch.biomes[z * 4 + x];
                bpal.iter().position(|&p| p == b).unwrap() as u32
            })
            .collect();
        Some(pack(&idx, bbits))
    } else {
        None
    };
    for (si, s) in ch.sections.iter().enumerate() {
        let sy = (min_y >> 4) + si as i32;
        let block_states = match s {
            Section::Uniform(b) => c(vec![("palette", Nbt::List(vec![state_nbt(*b)]))]),
            _ => {
                let mut pal: Vec<BlockId> = vec![];
                let mut map: HashMap<BlockId, u32> = HashMap::new();
                let idx: Vec<u32> = (0..4096)
                    .map(|i| {
                        let b = s.get(i);
                        *map.entry(b).or_insert_with(|| {
                            pal.push(b);
                            (pal.len() - 1) as u32
                        })
                    })
                    .collect();
                if pal.len() == 1 {
                    c(vec![("palette", Nbt::List(vec![state_nbt(pal[0])]))])
                } else {
                    let bits = bits_for(pal.len(), 4);
                    c(vec![
                        ("palette", Nbt::List(pal.iter().map(|&b| state_nbt(b)).collect())),
                        ("data", Nbt::LongArray(fastnbt::LongArray::new(pack(&idx, bits)))),
                    ])
                }
            }
        };
        let mut biomes = vec![("palette", Nbt::List(bnames.clone()))];
        if let Some(d) = &bdata {
            biomes.push(("data", Nbt::LongArray(fastnbt::LongArray::new(d.clone()))));
        }
        sections.push(c(vec![("Y", Nbt::Byte(sy as i8)), ("block_states", block_states), ("biomes", c(biomes))]));
    }
    c(vec![
        ("DataVersion", Nbt::Int(dv)),
        ("xPos", Nbt::Int(cx)),
        ("zPos", Nbt::Int(cz)),
        ("yPos", Nbt::Int(min_y >> 4)),
        ("Status", Nbt::String("minecraft:full".into())),
        ("LastUpdate", Nbt::Long(0)),
        ("InhabitedTime", Nbt::Long(0)),
        ("isLightOn", Nbt::Byte(0)),
        ("sections", Nbt::List(sections)),
        ("block_entities", Nbt::List(vec![])),
        ("block_ticks", Nbt::List(vec![])),
        ("fluid_ticks", Nbt::List(vec![])),
        ("structures", c(vec![("References", c(vec![])), ("starts", c(vec![]))])),
    ])
}

/// Write one dimension's region files. Returns (chunks, region files, bytes).
pub fn write_regions(w: &World, dir: &Path, dv: i32, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<(usize, usize, u64)> {
    std::fs::create_dir_all(dir)?;
    // Biome names (fallback to plains for non-vanilla).
    let mut biome_names = HashMap::new();
    for ch in &w.chunks {
        for &b in &ch.biomes {
            biome_names.entry(b).or_insert_with(|| {
                let n = world::biome_name(b);
                if valid_biome(&n) {
                    n
                } else {
                    "minecraft:plains".into()
                }
            });
        }
    }
    let mut regions: BTreeMap<(i32, i32), Vec<usize>> = BTreeMap::new();
    for i in 0..w.chunks.len() {
        let (cx, cz) = w.chunk_pos(i);
        regions.entry((cx >> 5, cz >> 5)).or_default().push(i);
    }
    let total = w.chunks.len();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<Result<u64>> = regions
        .par_iter()
        .map(|(&(rx, rz), idxs)| -> Result<u64> {
            let mut header = vec![0u8; 8192];
            let mut body: Vec<u8> = vec![];
            for &i in idxs {
                let (cx, cz) = w.chunk_pos(i);
                let nbt = chunk_nbt(&w.chunks[i], cx, cz, w.min_y, dv, &biome_names);
                let raw = fastnbt::to_bytes(&nbt).map_err(|e| anyhow!("nbt: {e}"))?;
                let mut z = ZlibEncoder::new(vec![], flate2::Compression::fast());
                z.write_all(&raw)?;
                let comp = z.finish()?;
                let len = comp.len() + 1;
                let mut payload = Vec::with_capacity(len + 4);
                payload.extend_from_slice(&(len as u32).to_be_bytes());
                payload.push(2); // zlib
                payload.extend_from_slice(&comp);
                let sectors = payload.len().div_ceil(4096);
                if sectors > 255 {
                    bail!("chunk {cx},{cz} too large for region file");
                }
                payload.resize(sectors * 4096, 0);
                let offset = 2 + body.len() / 4096;
                body.extend_from_slice(&payload);
                let hi = ((cz & 31) * 32 + (cx & 31)) as usize * 4;
                header[hi..hi + 4].copy_from_slice(&(((offset as u32) << 8) | sectors as u32).to_be_bytes());
                let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if n % 512 == 0 {
                    progress(n, total);
                }
            }
            let path = dir.join(format!("r.{rx}.{rz}.mca"));
            let mut f = std::fs::File::create(&path)?;
            f.write_all(&header)?;
            f.write_all(&body)?;
            Ok((8192 + body.len()) as u64)
        })
        .collect();
    let mut bytes = 0;
    for r in results {
        bytes += r?;
    }
    progress(total, total);
    Ok((total, regions.len(), bytes))
}

pub fn dimension_dir(save: &Path, dim: &str) -> PathBuf {
    match dim {
        "overworld" | "minecraft:overworld" => save.join("region"),
        "the_nether" | "nether" | "minecraft:the_nether" => save.join("DIM-1").join("region"),
        "the_end" | "end" | "minecraft:the_end" => save.join("DIM1").join("region"),
        other => {
            let (ns, name) = other.split_once(':').unwrap_or(("mapedit", other));
            save.join("dimensions").join(ns).join(name).join("region")
        }
    }
}

fn void_flat(biome: &str) -> Nbt {
    c(vec![
        ("type", Nbt::String("minecraft:flat".into())),
        (
            "settings",
            c(vec![
                ("biome", Nbt::String(biome.into())),
                ("layers", Nbt::List(vec![])),
                ("lakes", Nbt::Byte(0)),
                ("features", Nbt::Byte(0)),
                ("structure_overrides", Nbt::List(vec![])),
            ]),
        ),
    ])
}

pub struct ExportOpts {
    pub level_name: String,
    pub data_version: i32,
    pub version_name: String,
    pub spawn: (i32, i32, i32),
    /// Day time ticks (6000 = noon, 13000 = dusk, 18000 = midnight).
    pub day_time: i64,
    /// false = freeze the time of day (eternal night etc.).
    pub daylight_cycle: bool,
}

/// Write level.dat (void flat generator outside the edited area).
pub fn write_level_dat(save: &Path, o: &ExportOpts, custom_dims: &[String]) -> Result<()> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut dims: HashMap<String, Nbt> = HashMap::new();
    dims.insert("minecraft:overworld".into(), c(vec![("type", Nbt::String("minecraft:overworld".into())), ("generator", void_flat("minecraft:the_void"))]));
    dims.insert("minecraft:the_nether".into(), c(vec![("type", Nbt::String("minecraft:the_nether".into())), ("generator", void_flat("minecraft:nether_wastes"))]));
    dims.insert("minecraft:the_end".into(), c(vec![("type", Nbt::String("minecraft:the_end".into())), ("generator", void_flat("minecraft:the_end"))]));
    let mut packs = vec![Nbt::String("vanilla".into())];
    if !custom_dims.is_empty() {
        packs.push(Nbt::String("file/mapedit".into()));
    }
    let data = c(vec![
        ("DataVersion", Nbt::Int(o.data_version)),
        ("version", Nbt::Int(19133)),
        (
            "Version",
            c(vec![
                ("Id", Nbt::Int(o.data_version)),
                ("Name", Nbt::String(o.version_name.clone())),
                ("Series", Nbt::String("main".into())),
                ("Snapshot", Nbt::Byte(0)),
            ]),
        ),
        ("LevelName", Nbt::String(o.level_name.clone())),
        ("GameType", Nbt::Int(1)),
        ("Difficulty", Nbt::Byte(1)),
        ("DifficultyLocked", Nbt::Byte(0)),
        ("hardcore", Nbt::Byte(0)),
        ("allowCommands", Nbt::Byte(1)),
        ("initialized", Nbt::Byte(1)),
        ("LastPlayed", Nbt::Long(now)),
        ("Time", Nbt::Long(o.day_time)),
        ("DayTime", Nbt::Long(o.day_time)),
        ("SpawnX", Nbt::Int(o.spawn.0)),
        ("SpawnY", Nbt::Int(o.spawn.1)),
        ("SpawnZ", Nbt::Int(o.spawn.2)),
        ("SpawnAngle", Nbt::Float(0.0)),
        ("WasModded", Nbt::Byte(0)),
        ("raining", Nbt::Byte(0)),
        ("thundering", Nbt::Byte(0)),
        ("clearWeatherTime", Nbt::Int(0)),
        ("DataPacks", c(vec![("Enabled", Nbt::List(packs)), ("Disabled", Nbt::List(vec![]))])),
        (
            "GameRules",
            c(vec![
                ("doDaylightCycle", Nbt::String(if o.daylight_cycle { "true" } else { "false" }.into())),
                ("doMobSpawning", Nbt::String("true".into())),
                ("doFireTick", Nbt::String("false".into())),
            ]),
        ),
        (
            "WorldGenSettings",
            c(vec![("seed", Nbt::Long(0)), ("generate_features", Nbt::Byte(0)), ("bonus_chest", Nbt::Byte(0)), ("dimensions", Nbt::Compound(dims))]),
        ),
    ]);
    let root = c(vec![("Data", data)]);
    let raw = fastnbt::to_bytes(&root).map_err(|e| anyhow!("nbt: {e}"))?;
    let f = std::fs::File::create(save.join("level.dat"))?;
    let mut gz = GzEncoder::new(f, flate2::Compression::default());
    gz.write_all(&raw)?;
    gz.finish()?;
    // Datapack for custom dimensions (flat void, overworld dimension type).
    if !custom_dims.is_empty() {
        let dp = save.join("datapacks").join("mapedit");
        std::fs::create_dir_all(&dp)?;
        std::fs::write(
            dp.join("pack.mcmeta"),
            r#"{"pack":{"description":"mapedit custom dimensions","pack_format":61,"supported_formats":{"min_inclusive":48,"max_inclusive":999},"min_format":48,"max_format":999}}"#,
        )?;
        for d in custom_dims {
            let (ns, name) = d.split_once(':').unwrap_or(("mapedit", d));
            let dir = dp.join("data").join(ns).join("dimension");
            std::fs::create_dir_all(&dir)?;
            std::fs::write(
                dir.join(format!("{name}.json")),
                r#"{"type":"minecraft:overworld","generator":{"type":"minecraft:flat","settings":{"biome":"minecraft:the_void","layers":[],"lakes":false,"features":false,"structure_overrides":[]}}}"#,
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- import

fn get<'a>(m: &'a HashMap<String, Nbt>, k: &str) -> Option<&'a Nbt> {
    m.get(k)
}

fn state_from_nbt(v: &Nbt) -> String {
    let Nbt::Compound(m) = v else { return "minecraft:air".into() };
    let name = match get(m, "Name") {
        Some(Nbt::String(s)) => s.clone(),
        _ => "minecraft:air".into(),
    };
    match get(m, "Properties") {
        Some(Nbt::Compound(p)) if !p.is_empty() => {
            let mut kv: Vec<String> = p
                .iter()
                .map(|(k, v)| match v {
                    Nbt::String(s) => format!("{k}={s}"),
                    other => format!("{k}={other:?}"),
                })
                .collect();
            kv.sort();
            format!("{name}[{}]", kv.join(","))
        }
        _ => name,
    }
}

fn read_chunk_sections(nbt: &Nbt, min_sy: i32, n_sections: usize) -> Result<Chunk> {
    let Nbt::Compound(root) = nbt else { bail!("chunk root not compound") };
    // Pre-1.18 chunks are nested under "Level".
    let root = match get(root, "Level") {
        Some(Nbt::Compound(l)) => l,
        _ => root,
    };
    let mut ch = Chunk::new(n_sections);
    let secs = match get(root, "sections").or_else(|| get(root, "Sections")) {
        Some(Nbt::List(l)) => l,
        _ => return Ok(ch),
    };
    let mut biome_set = false;
    for s in secs {
        let Nbt::Compound(s) = s else { continue };
        let y = match get(s, "Y") {
            Some(Nbt::Byte(b)) => *b as i32,
            Some(Nbt::Int(i)) => *i,
            _ => continue,
        };
        let si = y - min_sy;
        if si < 0 || si as usize >= n_sections {
            continue;
        }
        if let Some(Nbt::Compound(bs)) = get(s, "block_states") {
            let pal: Vec<BlockId> = match get(bs, "palette") {
                Some(Nbt::List(p)) => p.iter().map(|v| blocks::id(&state_from_nbt(v))).collect(),
                _ => vec![AIR],
            };
            let sec = if pal.len() <= 1 {
                Section::Uniform(*pal.first().unwrap_or(&AIR))
            } else {
                let data: Vec<i64> = match get(bs, "data") {
                    Some(Nbt::LongArray(d)) => d.iter().copied().collect(),
                    _ => vec![],
                };
                let bits = bits_for(pal.len(), 4);
                let idx = unpack(&data, bits, 4096);
                let mut sec = Section::Uniform(AIR);
                for (i, &p) in idx.iter().enumerate() {
                    sec.set(i, *pal.get(p as usize).unwrap_or(&AIR));
                }
                sec
            };
            ch.sections[si as usize] = sec;
        }
        if !biome_set {
            if let Some(Nbt::Compound(b)) = get(s, "biomes") {
                let pal: Vec<u16> = match get(b, "palette") {
                    Some(Nbt::List(p)) => p.iter().map(|v| if let Nbt::String(s) = v { world::biome_id(s) } else { 0 }).collect(),
                    _ => vec![0],
                };
                if pal.len() == 1 {
                    ch.biomes = [pal[0]; 16];
                } else if let Some(Nbt::LongArray(d)) = get(b, "data") {
                    let d: Vec<i64> = d.iter().copied().collect();
                    let idx = unpack(&d, bits_for(pal.len(), 1), 64);
                    for (cell, b) in ch.biomes.iter_mut().enumerate() {
                        // sample the top layer of this section (y=3)
                        *b = *pal.get(idx[48 + cell] as usize).unwrap_or(&0);
                    }
                }
                // prefer biomes from a section near the surface: keep updating until a non-air section
                biome_set = !matches!(ch.sections[si as usize], Section::Uniform(b) if blocks::is_air(b));
            }
        }
    }
    Ok(ch)
}

/// Import one dimension of a save. Optional chunk-rect limit (cx0,cz0,cx1,cz1 inclusive).
pub fn import(save: &Path, dim: &str, name: &str, limit: Option<(i32, i32, i32, i32)>) -> Result<World> {
    let dir = dimension_dir(save, dim);
    let (min_y, height) = match dim {
        "the_nether" | "nether" | "minecraft:the_nether" | "the_end" | "end" | "minecraft:the_end" => (0, 256),
        _ => (-64, 384),
    };
    let n_sections = (height / 16) as usize;
    let mut found: Vec<(i32, i32, Nbt)> = vec![];
    let entries = std::fs::read_dir(&dir).with_context(|| format!("no region folder at {}", dir.display()))?;
    let files: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|e| e == "mca").unwrap_or(false)).collect();
    let per_file: Vec<Result<Vec<(i32, i32, Nbt)>>> = files
        .par_iter()
        .map(|p| -> Result<Vec<(i32, i32, Nbt)>> {
            let data = std::fs::read(p)?;
            let mut out = vec![];
            if data.len() < 8192 {
                return Ok(out);
            }
            for i in 0..1024 {
                let e = u32::from_be_bytes([data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]]);
                let (off, cnt) = ((e >> 8) as usize * 4096, (e & 0xff) as usize);
                if off == 0 || cnt == 0 || off + 5 > data.len() {
                    continue;
                }
                let len = u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]) as usize;
                let ctype = data[off + 4];
                let body = &data[off + 5..(off + 4 + len).min(data.len())];
                let mut raw = vec![];
                match ctype {
                    1 => {
                        GzDecoder::new(body).read_to_end(&mut raw)?;
                    }
                    2 => {
                        ZlibDecoder::new(body).read_to_end(&mut raw)?;
                    }
                    3 => raw = body.to_vec(),
                    other => bail!("unsupported chunk compression type {other} in {}", p.display()),
                }
                let nbt: Nbt = fastnbt::from_bytes(&raw).map_err(|e| anyhow!("chunk nbt: {e}"))?;
                let (cx, cz) = match &nbt {
                    Nbt::Compound(m) => {
                        let m2 = match m.get("Level") {
                            Some(Nbt::Compound(l)) => l,
                            _ => m,
                        };
                        let gi = |k: &str| match m2.get(k) {
                            Some(Nbt::Int(v)) => *v,
                            _ => 0,
                        };
                        (gi("xPos"), gi("zPos"))
                    }
                    _ => continue,
                };
                if let Some((a, b, c2, d)) = limit {
                    if cx < a || cz < b || cx > c2 || cz > d {
                        continue;
                    }
                }
                out.push((cx, cz, nbt));
            }
            Ok(out)
        })
        .collect();
    for r in per_file {
        found.extend(r?);
    }
    if found.is_empty() {
        bail!("no chunks found in {}", dir.display());
    }
    let (mut x0, mut z0, mut x1, mut z1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for (cx, cz, _) in &found {
        x0 = x0.min(*cx);
        z0 = z0.min(*cz);
        x1 = x1.max(*cx);
        z1 = z1.max(*cz);
    }
    let (cw, chh) = (x1 - x0 + 1, z1 - z0 + 1);
    if (cw as i64) * (chh as i64) > 250_000 {
        bail!("save covers {}×{} chunks; pass a smaller 'rect' to import", cw, chh);
    }
    let parsed: Vec<(i32, i32, Result<Chunk>)> = found.par_iter().map(|(cx, cz, n)| (*cx, *cz, read_chunk_sections(n, min_y >> 4, n_sections))).collect();
    let mut chunks: Vec<Chunk> = (0..(cw * chh)).map(|_| Chunk::new(n_sections)).collect();
    for (cx, cz, ch) in parsed {
        chunks[((cz - z0) * cw + (cx - x0)) as usize] = ch?;
    }
    let mut w = World::from_chunks(name, dim.trim_start_matches("minecraft:"), x0, z0, cw, chh, min_y, n_sections, chunks);
    w.compact_all();
    Ok(w)
}

pub fn read_level_name(save: &Path) -> Option<String> {
    let raw = std::fs::read(save.join("level.dat")).ok()?;
    let mut d = vec![];
    GzDecoder::new(&raw[..]).read_to_end(&mut d).ok()?;
    let v: Nbt = fastnbt::from_bytes(&d).ok()?;
    if let Nbt::Compound(m) = v {
        if let Some(Nbt::Compound(data)) = m.get("Data") {
            if let Some(Nbt::String(s)) = data.get("LevelName") {
                return Some(s.clone());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pack_roundtrip() {
        let idx: Vec<u32> = (0..4096).map(|i| (i * 7 % 37) as u32).collect();
        let bits = bits_for(37, 4);
        assert_eq!(bits, 6);
        let p = pack(&idx, bits);
        assert_eq!(p.len(), 4096usize.div_ceil(10));
        assert_eq!(unpack(&p, bits, 4096), idx);
    }

    #[test]
    fn export_import_roundtrip() {
        let dir = std::env::temp_dir().join(format!("mapedit_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut w = World::new("t", 64, 64, -64, 384, "overworld", 1);
        let (stone, log) = (blocks::id("stone"), blocks::id("oak_log[axis=x]"));
        for x in -32i32..32 {
            for z in -32..32 {
                for y in -64..(60 + (x + z).rem_euclid(5)) {
                    w.set(x, y, z, stone);
                }
            }
        }
        w.set(3, 70, -5, log);
        w.set_biome(3, -5, world::biome_id("desert"));
        let dv = DEFAULT_DATA_VERSION;
        let (n, r, _) = write_regions(&w, &dimension_dir(&dir, "overworld"), dv, &|_, _| {}).unwrap();
        assert_eq!(n, 16);
        assert_eq!(r, 4); // chunks -2..1 span regions -1 and 0 on each axis
        write_level_dat(&dir, &ExportOpts { level_name: "T".into(), data_version: dv, version_name: "1.21.4".into(), spawn: (0, 80, 0), day_time: 18000, daylight_cycle: false }, &[]).unwrap();
        assert_eq!(read_level_name(&dir).as_deref(), Some("T"));
        let w2 = import(&dir, "overworld", "t2", None).unwrap();
        assert_eq!(w2.bounds(), w.bounds());
        for (x, y, z) in [(3, 70, -5), (0, 59, 0), (-32, -64, 31), (10, 63, 10), (31, 100, 31)] {
            assert_eq!(w2.get(x, y, z), w.get(x, y, z), "at {x},{y},{z}");
        }
        assert_eq!(world::biome_name(w2.biome(3, -5)), "minecraft:desert");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
