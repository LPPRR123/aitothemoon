//! In-memory voxel world: bounded grid of chunks, each a stack of 16³
//! palette-compressed sections (same layout as Minecraft's Anvil format).

use crate::blocks::{self, BlockId, BlockInfo, AIR};
use crate::zones::Zones;
use parking_lot::{Mutex, RwLock};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

// ---------------------------------------------------------------- biomes

fn biome_reg() -> &'static RwLock<(Vec<String>, HashMap<String, u16>)> {
    static R: OnceLock<RwLock<(Vec<String>, HashMap<String, u16>)>> = OnceLock::new();
    R.get_or_init(|| {
        let mut v = (vec![], HashMap::new());
        v.0.push("minecraft:plains".to_string());
        v.1.insert("minecraft:plains".to_string(), 0);
        RwLock::new(v)
    })
}

pub fn biome_id(name: &str) -> u16 {
    let n = name.trim().to_lowercase();
    let n = if n.contains(':') { n } else { format!("minecraft:{n}") };
    if let Some(&i) = biome_reg().read().1.get(&n) {
        return i;
    }
    let mut w = biome_reg().write();
    if let Some(&i) = w.1.get(&n) {
        return i;
    }
    let i = w.0.len() as u16;
    w.0.push(n.clone());
    w.1.insert(n, i);
    i
}

pub fn biome_name(id: u16) -> String {
    biome_reg().read().0.get(id as usize).cloned().unwrap_or_else(|| "minecraft:plains".into())
}

// ---------------------------------------------------------------- section

#[derive(Clone)]
pub enum Section {
    Uniform(BlockId),
    P8 { palette: Vec<BlockId>, data: Box<[u8; 4096]> },
    Raw(Box<[BlockId; 4096]>),
}

#[inline]
pub fn sidx(lx: usize, ly: usize, lz: usize) -> usize {
    (ly << 8) | (lz << 4) | lx
}

impl Section {
    #[inline]
    pub fn get(&self, i: usize) -> BlockId {
        match self {
            Section::Uniform(b) => *b,
            Section::P8 { palette, data } => palette[data[i] as usize],
            Section::Raw(d) => d[i],
        }
    }

    /// Returns true if the block changed.
    #[inline]
    pub fn set(&mut self, i: usize, id: BlockId) -> bool {
        match self {
            Section::Uniform(b) => {
                if *b == id {
                    return false;
                }
                let palette = vec![*b, id];
                let mut data = Box::new([0u8; 4096]);
                data[i] = 1;
                *self = Section::P8 { palette, data };
                true
            }
            Section::P8 { palette, data } => {
                let cur = palette[data[i] as usize];
                if cur == id {
                    return false;
                }
                if let Some(p) = palette.iter().position(|&b| b == id) {
                    data[i] = p as u8;
                    return true;
                }
                if palette.len() < 256 {
                    palette.push(id);
                    data[i] = (palette.len() - 1) as u8;
                    return true;
                }
                let mut raw = Box::new([0u16; 4096]);
                for (j, r) in raw.iter_mut().enumerate() {
                    *r = palette[data[j] as usize];
                }
                raw[i] = id;
                *self = Section::Raw(raw);
                true
            }
            Section::Raw(d) => {
                if d[i] == id {
                    return false;
                }
                d[i] = id;
                true
            }
        }
    }

    pub fn is_all_air(&self) -> bool {
        matches!(self, Section::Uniform(b) if blocks::is_air(*b))
    }

    /// Re-pack: drop unused palette entries, collapse to Uniform when possible.
    pub fn compact(&mut self) {
        let mut used: Vec<BlockId> = Vec::new();
        let mut seen = HashSet::new();
        for i in 0..4096 {
            let b = self.get(i);
            if seen.insert(b) {
                used.push(b);
            }
        }
        if used.len() == 1 {
            *self = Section::Uniform(used[0]);
            return;
        }
        if used.len() <= 256 {
            let map: HashMap<BlockId, u8> = used.iter().enumerate().map(|(i, &b)| (b, i as u8)).collect();
            let mut data = Box::new([0u8; 4096]);
            for (i, d) in data.iter_mut().enumerate() {
                *d = map[&self.get(i)];
            }
            *self = Section::P8 { palette: used, data };
        }
    }

    #[cfg(test)]
    pub fn palette(&self) -> Vec<BlockId> {
        match self {
            Section::Uniform(b) => vec![*b],
            Section::P8 { palette, .. } => palette.clone(),
            Section::Raw(d) => {
                let mut s: Vec<BlockId> = d.iter().copied().collect::<HashSet<_>>().into_iter().collect();
                s.sort();
                s
            }
        }
    }
}

// ---------------------------------------------------------------- chunk

#[derive(Clone)]
pub struct Chunk {
    pub sections: Vec<Section>,
    /// Biome per 4×4 column cell (index = (z>>2)*4 + (x>>2)), applied to all heights.
    pub biomes: [u16; 16],
    pub version: u64,
}

impl Chunk {
    pub fn new(n_sections: usize) -> Self {
        Chunk { sections: vec![Section::Uniform(AIR); n_sections], biomes: [0; 16], version: 0 }
    }

    /// `yi` is the y index relative to world min_y.
    #[inline]
    pub fn get(&self, lx: usize, yi: usize, lz: usize) -> BlockId {
        match self.sections.get(yi >> 4) {
            Some(s) => s.get(sidx(lx, yi & 15, lz)),
            None => AIR,
        }
    }

    #[inline]
    pub fn set(&mut self, lx: usize, yi: usize, lz: usize, id: BlockId) -> bool {
        match self.sections.get_mut(yi >> 4) {
            Some(s) => s.set(sidx(lx, yi & 15, lz), id),
            None => false,
        }
    }

    /// Highest y index matching `pred`, scanning down from the top.
    pub fn top_where(&self, lx: usize, lz: usize, infos: &[BlockInfo], pred: impl Fn(&BlockInfo) -> bool) -> Option<usize> {
        for si in (0..self.sections.len()).rev() {
            let s = &self.sections[si];
            if let Section::Uniform(b) = s {
                if pred(&infos[*b as usize]) {
                    return Some(si * 16 + 15);
                }
                continue;
            }
            for ly in (0..16).rev() {
                let b = s.get(sidx(lx, ly, lz));
                if pred(&infos[b as usize]) {
                    return Some(si * 16 + ly);
                }
            }
        }
        None
    }

    /// Approximate heap size in bytes.
    pub fn memory(&self) -> usize {
        64 + self
            .sections
            .iter()
            .map(|s| match s {
                Section::Uniform(_) => 4,
                Section::P8 { palette, .. } => 4096 + palette.len() * 2,
                Section::Raw(_) => 8192,
            })
            .sum::<usize>()
    }

    pub fn compact(&mut self) {
        for s in &mut self.sections {
            if !matches!(s, Section::Uniform(_)) {
                s.compact();
            }
        }
    }
}

// ---------------------------------------------------------------- world

pub struct World {
    pub name: String,
    /// "overworld" | "the_nether" | "the_end"
    pub dimension: String,
    pub min_cx: i32,
    pub min_cz: i32,
    pub cw: i32,
    pub ch: i32,
    pub min_y: i32,
    pub n_sections: usize,
    pub chunks: Vec<Chunk>,
    pub zones: Zones,
    pub seed: u32,
    journal: Mutex<Option<HashMap<usize, Chunk>>>,
    dirty: Mutex<HashSet<usize>>,
}

pub type Snapshot = HashMap<usize, Chunk>;

impl World {
    /// World of `size_x × size_z` blocks centred on the origin.
    pub fn new(name: &str, size_x: i32, size_z: i32, min_y: i32, height: i32, dimension: &str, seed: u32) -> Self {
        let cw = ((size_x + 15) / 16).max(1);
        let ch = ((size_z + 15) / 16).max(1);
        let n_sections = ((height + 15) / 16).max(1) as usize;
        let min_y = min_y.div_euclid(16) * 16;
        World {
            name: name.to_string(),
            dimension: dimension.to_string(),
            min_cx: -(cw / 2),
            min_cz: -(ch / 2),
            cw,
            ch,
            min_y,
            n_sections,
            chunks: (0..(cw * ch)).map(|_| Chunk::new(n_sections)).collect(),
            zones: Zones::default(),
            seed,
            journal: Mutex::new(None),
            dirty: Mutex::new(HashSet::new()),
        }
    }

    pub fn from_chunks(name: &str, dimension: &str, min_cx: i32, min_cz: i32, cw: i32, ch: i32, min_y: i32, n_sections: usize, chunks: Vec<Chunk>) -> Self {
        World {
            name: name.into(),
            dimension: dimension.into(),
            min_cx,
            min_cz,
            cw,
            ch,
            min_y,
            n_sections,
            chunks,
            zones: Zones::default(),
            seed: 1,
            journal: Mutex::new(None),
            dirty: Mutex::new(HashSet::new()),
        }
    }

    pub fn max_y(&self) -> i32 {
        self.min_y + self.n_sections as i32 * 16
    }

    /// Block bounds: (x0, z0, x1, z1), exclusive upper.
    pub fn bounds(&self) -> (i32, i32, i32, i32) {
        (self.min_cx * 16, self.min_cz * 16, (self.min_cx + self.cw) * 16, (self.min_cz + self.ch) * 16)
    }

    pub fn size(&self) -> (i32, i32) {
        (self.cw * 16, self.ch * 16)
    }

    #[inline]
    pub fn chunk_index(&self, cx: i32, cz: i32) -> Option<usize> {
        let ix = cx - self.min_cx;
        let iz = cz - self.min_cz;
        if ix < 0 || iz < 0 || ix >= self.cw || iz >= self.ch {
            return None;
        }
        Some((iz * self.cw + ix) as usize)
    }

    pub fn chunk_pos(&self, idx: usize) -> (i32, i32) {
        let idx = idx as i32;
        (self.min_cx + idx % self.cw, self.min_cz + idx / self.cw)
    }

    #[inline]
    pub fn in_bounds(&self, x: i32, z: i32) -> bool {
        self.chunk_index(x.div_euclid(16), z.div_euclid(16)).is_some()
    }

    #[inline]
    pub fn get(&self, x: i32, y: i32, z: i32) -> BlockId {
        let yi = y - self.min_y;
        if yi < 0 || yi >= self.n_sections as i32 * 16 {
            return AIR;
        }
        match self.chunk_index(x.div_euclid(16), z.div_euclid(16)) {
            Some(i) => self.chunks[i].get(x.rem_euclid(16) as usize, yi as usize, z.rem_euclid(16) as usize),
            None => AIR,
        }
    }

    /// Journal-aware single block write.
    pub fn set(&mut self, x: i32, y: i32, z: i32, id: BlockId) -> bool {
        let yi = y - self.min_y;
        if yi < 0 || yi >= self.n_sections as i32 * 16 {
            return false;
        }
        let Some(i) = self.chunk_index(x.div_euclid(16), z.div_euclid(16)) else { return false };
        let (lx, lz) = (x.rem_euclid(16) as usize, z.rem_euclid(16) as usize);
        if self.chunks[i].get(lx, yi as usize, lz) == id {
            return false;
        }
        if let Some(j) = self.journal.lock().as_mut() {
            j.entry(i).or_insert_with(|| self.chunks[i].clone());
        }
        self.chunks[i].set(lx, yi as usize, lz, id);
        self.chunks[i].version += 1;
        self.dirty.lock().insert(i);
        true
    }

    /// Highest solid-or-liquid-or-foliage y at (x,z).
    pub fn top(&self, x: i32, z: i32, infos: &[BlockInfo]) -> Option<i32> {
        self.top_where(x, z, infos, |b| b.opaque_top())
    }

    /// Highest *solid* y at (x,z) (ignores water, leaves, plants).
    pub fn ground(&self, x: i32, z: i32, infos: &[BlockInfo]) -> Option<i32> {
        self.top_where(x, z, infos, |b| b.solid())
    }

    pub fn top_where(&self, x: i32, z: i32, infos: &[BlockInfo], pred: impl Fn(&BlockInfo) -> bool) -> Option<i32> {
        let i = self.chunk_index(x.div_euclid(16), z.div_euclid(16))?;
        self.chunks[i]
            .top_where(x.rem_euclid(16) as usize, z.rem_euclid(16) as usize, infos, pred)
            .map(|yi| yi as i32 + self.min_y)
    }

    pub fn set_biome(&mut self, x: i32, z: i32, biome: u16) {
        if let Some(i) = self.chunk_index(x.div_euclid(16), z.div_euclid(16)) {
            let cell = ((z.rem_euclid(16) >> 2) * 4 + (x.rem_euclid(16) >> 2)) as usize;
            if self.chunks[i].biomes[cell] != biome {
                if let Some(j) = self.journal.lock().as_mut() {
                    j.entry(i).or_insert_with(|| self.chunks[i].clone());
                }
                self.chunks[i].biomes[cell] = biome;
                self.chunks[i].version += 1;
                self.dirty.lock().insert(i);
            }
        }
    }

    pub fn biome(&self, x: i32, z: i32) -> u16 {
        match self.chunk_index(x.div_euclid(16), z.div_euclid(16)) {
            Some(i) => self.chunks[i].biomes[((z.rem_euclid(16) >> 2) * 4 + (x.rem_euclid(16) >> 2)) as usize],
            None => 0,
        }
    }

    /// Run `f` in parallel over every chunk intersecting the block rect
    /// [x0,x1)×[z0,z1). `f(chunk, cx, cz)` returns whether it changed anything.
    pub fn par_chunks<F>(&mut self, x0: i32, z0: i32, x1: i32, z1: i32, f: F) -> usize
    where
        F: Fn(&mut Chunk, i32, i32) -> bool + Sync,
    {
        let (bx0, bz0, bx1, bz1) = self.bounds();
        let (x0, z0, x1, z1) = (x0.max(bx0), z0.max(bz0), x1.min(bx1), z1.min(bz1));
        if x0 >= x1 || z0 >= z1 {
            return 0;
        }
        let (cx0, cz0, cx1, cz1) = (x0.div_euclid(16), z0.div_euclid(16), (x1 - 1).div_euclid(16), (z1 - 1).div_euclid(16));
        let (min_cx, min_cz, cw) = (self.min_cx, self.min_cz, self.cw);
        let journaling = self.journal.lock().is_some();
        let journal = &self.journal;
        let dirty = &self.dirty;
        let changed = std::sync::atomic::AtomicUsize::new(0);
        self.chunks.par_iter_mut().enumerate().for_each(|(i, chunk)| {
            let cx = min_cx + i as i32 % cw;
            let cz = min_cz + i as i32 / cw;
            if cx < cx0 || cx > cx1 || cz < cz0 || cz > cz1 {
                return;
            }
            let before = if journaling && !journal.lock().as_ref().map(|j| j.contains_key(&i)).unwrap_or(true) {
                Some(chunk.clone())
            } else {
                None
            };
            if f(chunk, cx, cz) {
                chunk.version += 1;
                changed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                dirty.lock().insert(i);
                if let Some(b) = before {
                    if let Some(j) = journal.lock().as_mut() {
                        j.entry(i).or_insert(b);
                    }
                }
            }
        });
        changed.into_inner()
    }

    pub fn begin_journal(&self) {
        *self.journal.lock() = Some(HashMap::new());
    }

    pub fn end_journal(&self) -> Snapshot {
        self.journal.lock().take().unwrap_or_default()
    }

    /// Swap snapshot chunks into the world; returns the chunks they replaced.
    pub fn restore(&mut self, snap: Snapshot) -> Snapshot {
        let mut prev = HashMap::new();
        for (i, mut c) in snap {
            if i < self.chunks.len() {
                c.version = self.chunks[i].version + 1;
                prev.insert(i, std::mem::replace(&mut self.chunks[i], c));
                self.dirty.lock().insert(i);
            }
        }
        prev
    }

    pub fn take_dirty(&self) -> Vec<usize> {
        let mut d = self.dirty.lock();
        let v: Vec<usize> = d.drain().collect();
        v
    }

    pub fn compact_all(&mut self) {
        self.chunks.par_iter_mut().for_each(|c| c.compact());
    }

    pub fn mark_all_dirty(&self) {
        let mut d = self.dirty.lock();
        for i in 0..self.chunks.len() {
            d.insert(i);
        }
    }

    /// Rough memory estimate in bytes.
    pub fn memory(&self) -> usize {
        self.chunks.iter().map(|c| c.memory()).sum()
    }

    pub fn count_non_air(&self) -> u64 {
        self.chunks
            .par_iter()
            .map(|c| {
                c.sections
                    .iter()
                    .map(|s| match s {
                        Section::Uniform(b) => {
                            if blocks::is_air(*b) {
                                0
                            } else {
                                4096
                            }
                        }
                        _ => (0..4096).filter(|&i| !blocks::is_air(s.get(i))).count() as u64,
                    })
                    .sum::<u64>()
            })
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn set_get_journal() {
        let mut w = World::new("t", 64, 64, -64, 384, "overworld", 1);
        assert_eq!(w.bounds(), (-32, -32, 32, 32));
        let stone = blocks::id("stone");
        w.begin_journal();
        assert!(w.set(-1, 10, 5, stone));
        assert_eq!(w.get(-1, 10, 5), stone);
        let snap = w.end_journal();
        assert_eq!(snap.len(), 1);
        w.restore(snap);
        assert_eq!(w.get(-1, 10, 5), AIR);
    }

    #[test]
    fn palette_overflow() {
        let mut s = Section::Uniform(AIR);
        for i in 0..300u16 {
            let id = blocks::id(&format!("test_block_{i}"));
            s.set(i as usize, id);
        }
        assert!(matches!(s, Section::Raw(_)));
        s.compact();
        assert_eq!(s.palette().len(), 301); // 300 + remaining air
    }
}
