//! Global block-state registry.
//!
//! Every distinct block state string (e.g. `minecraft:oak_log[axis=x]`) is
//! interned into a `u16` id. Ids 0..=4 are fixed so hot loops can test them
//! without touching the registry.

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

pub type BlockId = u16;

pub const AIR: BlockId = 0;
#[allow(dead_code)]
pub const CAVE_AIR: BlockId = 1;
pub const VOID_AIR: BlockId = 2;
#[allow(dead_code)]
pub const WATER: BlockId = 3;
#[allow(dead_code)]
pub const LAVA: BlockId = 4;

#[inline]
pub fn is_air(id: BlockId) -> bool {
    id <= VOID_AIR
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Air,
    Liquid,
    /// Full opaque-ish block that terrain is made of.
    Solid,
    /// Leaves, glass, etc: rendered but light passes / trees.
    Foliage,
    /// Plants, torches, flowers: non-solid decorations.
    Plant,
    /// Tree trunks / mushroom bodies: rendered solid, but not terrain ground.
    Wood,
}

#[derive(Clone, Copy, Debug)]
pub struct BlockInfo {
    pub kind: Kind,
    pub color: [u8; 3],
}

impl BlockInfo {
    pub fn solid(&self) -> bool {
        matches!(self.kind, Kind::Solid)
    }
    /// Counts as "ground surface" for heightmaps (solid or liquid or foliage).
    pub fn opaque_top(&self) -> bool {
        matches!(self.kind, Kind::Solid | Kind::Liquid | Kind::Foliage | Kind::Wood)
    }
}

struct Registry {
    names: Vec<String>,
    map: HashMap<String, BlockId>,
    infos: Arc<Vec<BlockInfo>>,
}

fn registry() -> &'static RwLock<Registry> {
    static REG: OnceLock<RwLock<Registry>> = OnceLock::new();
    REG.get_or_init(|| {
        let mut r = Registry { names: vec![], map: HashMap::new(), infos: Arc::new(vec![]) };
        for n in [
            "minecraft:air",
            "minecraft:cave_air",
            "minecraft:void_air",
            "minecraft:water",
            "minecraft:lava",
        ] {
            r.insert(n.to_string());
        }
        RwLock::new(r)
    })
}

impl Registry {
    fn insert(&mut self, name: String) -> BlockId {
        let id = self.names.len() as BlockId;
        let info = info_for(&name);
        self.names.push(name.clone());
        self.map.insert(name, id);
        let mut infos = (*self.infos).clone();
        infos.push(info);
        self.infos = Arc::new(infos);
        id
    }
}

/// Normalise user input like `stone`, `minecraft:stone`, `oak_log[axis=x]`.
pub fn normalize(name: &str) -> String {
    let name = name.trim();
    let (base, props) = match name.find('[') {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    let base = base.trim().to_lowercase();
    let base = if base.contains(':') { base } else { format!("minecraft:{base}") };
    // Canonical ordering of properties so equal states intern to one id.
    if props.len() > 2 {
        let inner = &props[1..props.len() - 1];
        let mut kv: Vec<&str> = inner.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        kv.sort();
        if kv.is_empty() {
            return base;
        }
        format!("{base}[{}]", kv.join(","))
    } else {
        base
    }
}

/// Intern a block state (input is normalised first).
pub fn id(name: &str) -> BlockId {
    let n = normalize(name);
    // Bare water/lava means source blocks.
    let n = match n.as_str() {
        "minecraft:water[level=0]" => "minecraft:water".to_string(),
        "minecraft:lava[level=0]" => "minecraft:lava".to_string(),
        _ => n,
    };
    if let Some(&i) = registry().read().map.get(&n) {
        return i;
    }
    let mut w = registry().write();
    if let Some(&i) = w.map.get(&n) {
        return i;
    }
    if w.names.len() >= u16::MAX as usize - 1 {
        panic!("block registry full");
    }
    w.insert(n)
}

pub fn name(id: BlockId) -> String {
    registry().read().names.get(id as usize).cloned().unwrap_or_else(|| "minecraft:air".into())
}

/// Cheap snapshot of block infos for hot loops (index by id).
pub fn infos() -> Arc<Vec<BlockInfo>> {
    registry().read().infos.clone()
}

/// Split a state string into (name, properties).
pub fn split_state(state: &str) -> (String, Vec<(String, String)>) {
    match state.find('[') {
        Some(i) => {
            let props = state[i + 1..state.len().saturating_sub(1)]
                .split(',')
                .filter_map(|kv| {
                    let mut it = kv.splitn(2, '=');
                    Some((it.next()?.trim().to_string(), it.next()?.trim().to_string()))
                })
                .collect();
            (state[..i].to_string(), props)
        }
        None => (state.to_string(), vec![]),
    }
}

fn base_name(name: &str) -> &str {
    let n = name.strip_prefix("minecraft:").unwrap_or(name);
    match n.find('[') {
        Some(i) => &n[..i],
        None => n,
    }
}

fn info_for(name: &str) -> BlockInfo {
    let b = base_name(name);
    let kind = classify(b);
    BlockInfo { kind, color: color_for(b) }
}

fn classify(b: &str) -> Kind {
    if matches!(b, "air" | "cave_air" | "void_air") {
        return Kind::Air;
    }
    if matches!(b, "water" | "lava" | "bubble_column") {
        return Kind::Liquid;
    }
    if b.ends_with("_log")
        || b.ends_with("_wood")
        || b.ends_with("_stem")
        || b.ends_with("_hyphae")
        || b.ends_with("mushroom_block")
        || b.ends_with("wart_block")
        || b == "shroomlight"
        || b == "bamboo_block"
    {
        return Kind::Wood;
    }
    if b.ends_with("leaves") || b.ends_with("glass") || b.ends_with("glass_pane") || b == "ice" {
        return Kind::Foliage;
    }
    const PLANTS: &[&str] = &[
        "short_grass", "grass", "tall_grass", "fern", "large_fern", "dandelion", "poppy", "blue_orchid",
        "allium", "azure_bluet", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy",
        "cornflower", "lily_of_the_valley", "sunflower", "lilac", "rose_bush", "peony", "dead_bush",
        "brown_mushroom", "red_mushroom", "crimson_fungus", "warped_fungus", "crimson_roots", "warped_roots",
        "nether_sprouts", "torch", "wall_torch", "lantern", "soul_lantern", "sweet_berry_bush", "seagrass",
        "kelp", "kelp_plant", "sugar_cane", "vine", "glow_lichen", "moss_carpet", "snow", "pink_petals",
        "torchflower", "pitcher_plant", "spore_blossom", "hanging_roots", "cave_vines", "cave_vines_plant",
        "weeping_vines", "twisting_vines", "rail", "ladder", "lily_pad", "bush", "firefly_bush",
        "leaf_litter", "wildflowers", "short_dry_grass", "tall_dry_grass", "pale_hanging_moss",
        "closed_eyeblossom", "open_eyeblossom", "pale_moss_carpet", "chain", "iron_bars",
    ];
    if PLANTS.contains(&b)
        || b.ends_with("_sapling")
        || b.ends_with("_carpet")
        || b.ends_with("_button")
        || b.ends_with("_pressure_plate")
        || b.ends_with("_sign")
        || b.ends_with("_banner")
        || b.ends_with("_fence")
        || b.ends_with("_fence_gate")
        || b.ends_with("_wall")
        || b.ends_with("_door")
        || b.ends_with("_trapdoor")
        || b.ends_with("_coral")
        || b.ends_with("_coral_fan")
    {
        return Kind::Plant;
    }
    Kind::Solid
}

/// Approximate average texture colours for map rendering.
fn color_for(b: &str) -> [u8; 3] {
    let c: Option<u32> = match b {
        "stone" => Some(0x7d7d7d),
        "granite" => Some(0x956756),
        "diorite" => Some(0xbcbcbc),
        "andesite" => Some(0x888889),
        "deepslate" | "cobbled_deepslate" => Some(0x505053),
        "tuff" => Some(0x6c6d66),
        "calcite" => Some(0xdfe0dc),
        "cobblestone" => Some(0x7f7f7f),
        "mossy_cobblestone" => Some(0x6e775f),
        "stone_bricks" => Some(0x7a797a),
        "mossy_stone_bricks" => Some(0x737960),
        "smooth_stone" => Some(0x9f9f9f),
        "bedrock" => Some(0x555555),
        "grass_block" => Some(0x6a9a3e),
        "dirt" => Some(0x866043),
        "coarse_dirt" => Some(0x77553b),
        "rooted_dirt" => Some(0x90684c),
        "podzol" => Some(0x5b3d14),
        "mycelium" => Some(0x6f6265),
        "mud" => Some(0x3c393d),
        "packed_mud" => Some(0x8e6b50),
        "mud_bricks" => Some(0x89674f),
        "dirt_path" => Some(0x947a41),
        "farmland" => Some(0x8f6646),
        "clay" => Some(0xa0a6b3),
        "gravel" => Some(0x837f7e),
        "sand" => Some(0xdbcfa3),
        "sandstone" | "smooth_sandstone" | "cut_sandstone" => Some(0xd8cb9b),
        "red_sand" => Some(0xbe6621),
        "red_sandstone" | "smooth_red_sandstone" | "cut_red_sandstone" => Some(0xb5621f),
        "terracotta" => Some(0x985e43),
        "white_terracotta" => Some(0xd1b2a1),
        "orange_terracotta" => Some(0xa15325),
        "yellow_terracotta" => Some(0xba8523),
        "red_terracotta" => Some(0x8f3d2e),
        "brown_terracotta" => Some(0x4d3323),
        "light_gray_terracotta" => Some(0x876b62),
        "gray_terracotta" => Some(0x392a23),
        "black_terracotta" => Some(0x251610),
        "pink_terracotta" => Some(0xa14e4e),
        "purple_terracotta" => Some(0x764656),
        "blue_terracotta" => Some(0x4a3b5b),
        "cyan_terracotta" => Some(0x575b5b),
        "snow_block" | "snow" | "powder_snow" => Some(0xf9fefe),
        "ice" => Some(0x91b7fd),
        "packed_ice" => Some(0x8db4fa),
        "blue_ice" => Some(0x74a8fd),
        "water" => Some(0x3f76e4),
        "lava" => Some(0xd45a12),
        "obsidian" => Some(0x0f0b19),
        "crying_obsidian" => Some(0x220a3f),
        "magma_block" => Some(0x8e3f1f),
        "netherrack" => Some(0x612626),
        "nether_bricks" => Some(0x2c1519),
        "red_nether_bricks" => Some(0x450709),
        "crimson_nylium" => Some(0x821e1e),
        "warped_nylium" => Some(0x2b7265),
        "soul_sand" | "soul_soil" => Some(0x51402f),
        "basalt" | "polished_basalt" => Some(0x49484d),
        "smooth_basalt" => Some(0x48484e),
        "blackstone" | "polished_blackstone" | "polished_blackstone_bricks" => Some(0x2a2328),
        "glowstone" => Some(0xab8354),
        "shroomlight" => Some(0xf09246),
        "nether_wart_block" => Some(0x720203),
        "warped_wart_block" => Some(0x167879),
        "crimson_stem" | "crimson_hyphae" => Some(0x5c1a1e),
        "warped_stem" | "warped_hyphae" => Some(0x3a3a4d),
        "end_stone" | "end_stone_bricks" => Some(0xdbde9e),
        "purpur_block" => Some(0xa97da9),
        "bone_block" => Some(0xe5e1cf),
        "moss_block" => Some(0x596e2d),
        "amethyst_block" | "budding_amethyst" => Some(0x8562bf),
        "prismarine" => Some(0x63a097),
        "dark_prismarine" => Some(0x335b4b),
        "sea_lantern" => Some(0xacc8be),
        "quartz_block" => Some(0xebe5de),
        "bricks" => Some(0x966153),
        "hay_block" => Some(0xa68b0c),
        "pumpkin" => Some(0xc6761d),
        "melon" => Some(0x6f9119),
        "mushroom_stem" => Some(0xcbc4b9),
        "red_mushroom_block" => Some(0xc82e2d),
        "brown_mushroom_block" => Some(0x957051),
        "oak_log" | "oak_wood" => Some(0x6d5532),
        "spruce_log" | "spruce_wood" => Some(0x3a2611),
        "birch_log" | "birch_wood" => Some(0xd8d7d2),
        "jungle_log" | "jungle_wood" => Some(0x554319),
        "acacia_log" | "acacia_wood" => Some(0x676157),
        "dark_oak_log" | "dark_oak_wood" => Some(0x3c2e1a),
        "mangrove_log" | "mangrove_wood" => Some(0x544329),
        "cherry_log" | "cherry_wood" => Some(0x371c22),
        "pale_oak_log" | "pale_oak_wood" => Some(0x574d4b),
        "oak_planks" => Some(0xa2834f),
        "spruce_planks" => Some(0x735531),
        "birch_planks" => Some(0xc0af79),
        "jungle_planks" => Some(0xa07351),
        "acacia_planks" => Some(0xa85a32),
        "dark_oak_planks" => Some(0x432b14),
        "cherry_planks" => Some(0xe3b3ad),
        "pale_oak_planks" => Some(0xe3d9d7),
        "oak_leaves" => Some(0x4d8a2a),
        "spruce_leaves" => Some(0x3a5e3a),
        "birch_leaves" => Some(0x6a8a3e),
        "jungle_leaves" => Some(0x3b8c1e),
        "acacia_leaves" => Some(0x5b8a24),
        "dark_oak_leaves" => Some(0x3a6a1c),
        "mangrove_leaves" => Some(0x58852a),
        "azalea_leaves" => Some(0x5b7529),
        "flowering_azalea_leaves" => Some(0x6e7a43),
        "cherry_leaves" => Some(0xe5adc2),
        "pale_oak_leaves" => Some(0xa0a69c),
        "short_grass" | "grass" | "tall_grass" | "fern" | "large_fern" => Some(0x5e8f33),
        "dandelion" | "sunflower" => Some(0xe0d33a),
        "poppy" | "red_tulip" | "rose_bush" => Some(0xc3282b),
        "cornflower" => Some(0x466aeb),
        "azure_bluet" | "oxeye_daisy" | "lily_of_the_valley" | "white_tulip" => Some(0xd6dce0),
        "allium" | "lilac" => Some(0xb07fd6),
        "pink_petals" | "peony" | "pink_tulip" => Some(0xe8a2c7),
        "crimson_fungus" | "crimson_roots" => Some(0x8f1f20),
        "warped_fungus" | "warped_roots" | "nether_sprouts" => Some(0x14a28a),
        "dead_bush" => Some(0x6b4f29),
        "sugar_cane" => Some(0x93c164),
        "torch" | "lantern" => Some(0xf6c63d),
        "soul_lantern" => Some(0x56c6c8),
        "glass" => Some(0xc0dce0),
        "white_wool" | "white_concrete" => Some(0xe9ecec),
        "purple_concrete" | "purple_wool" => Some(0x641f9c),
        "magenta_concrete" => Some(0xa9309f),
        "pink_concrete" => Some(0xd5658e),
        "blue_concrete" => Some(0x2c2e8f),
        "light_blue_concrete" => Some(0x2489c6),
        "cyan_concrete" => Some(0x157788),
        "lime_concrete" => Some(0x5ea818),
        "green_concrete" => Some(0x495b24),
        "yellow_concrete" => Some(0xf0af15),
        "orange_concrete" => Some(0xe06100),
        "red_concrete" => Some(0x8e2020),
        "black_concrete" => Some(0x080a0f),
        "gray_concrete" => Some(0x36393d),
        "light_gray_concrete" => Some(0x7d7d73),
        "brown_concrete" => Some(0x603b1f),
        "iron_block" => Some(0xdcdcdc),
        "gold_block" => Some(0xf6d03d),
        "diamond_block" => Some(0x62ede4),
        "emerald_block" => Some(0x2acb57),
        "copper_block" => Some(0xc06c50),
        "oxidized_copper" => Some(0x52a284),
        "chiseled_stone_bricks" => Some(0x777677),
        "cracked_stone_bricks" => Some(0x767576),
        "polished_andesite" => Some(0x848685),
        "polished_granite" => Some(0x9a6a59),
        "polished_diorite" => Some(0xc0c1c2),
        "polished_deepslate" | "deepslate_bricks" | "deepslate_tiles" => Some(0x48484a),
        "cobblestone_wall" | "stone_brick_wall" => Some(0x7a7a7a),
        "oak_fence" => Some(0xa2834f),
        "spruce_fence" => Some(0x735531),
        "dark_oak_fence" => Some(0x432b14),
        "oak_stairs" | "oak_slab" => Some(0xa2834f),
        "spruce_stairs" | "spruce_slab" => Some(0x735531),
        "stone_brick_stairs" | "stone_brick_slab" | "cobblestone_stairs" | "cobblestone_slab" => Some(0x7a797a),
        _ => None,
    };
    if let Some(c) = c {
        return [(c >> 16) as u8, (c >> 8) as u8, c as u8];
    }
    // Heuristics by suffix / material words.
    let guess = |w: &str| b.contains(w);
    let c = if guess("leaves") {
        0x4a7a2a
    } else if guess("log") || guess("wood") || guess("stem") || guess("hyphae") {
        0x5a4328
    } else if guess("planks") || guess("stairs") || guess("slab") {
        0x9a7a4a
    } else if guess("deepslate") {
        0x505053
    } else if guess("brick") {
        0x7a6a62
    } else if guess("ore") {
        0x777777
    } else {
        hash_color(b)
    };
    [(c >> 16) as u8, (c >> 8) as u8, c as u8]
}

fn hash_color(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    // muted colour
    let r = 80 + (h & 0x7f);
    let g = 80 + ((h >> 8) & 0x7f);
    let b = 80 + ((h >> 16) & 0x7f);
    (r << 16) | (g << 8) | b
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interning() {
        assert_eq!(id("air"), AIR);
        assert_eq!(id("minecraft:water"), WATER);
        assert_eq!(id("water[level=0]"), WATER);
        let a = id("oak_log[axis=x]");
        assert_eq!(a, id("minecraft:oak_log[ axis=x ]"));
        assert_eq!(name(a), "minecraft:oak_log[axis=x]");
        let leaves = id("oak_leaves[persistent=true]");
        assert!(infos()[leaves as usize].kind == Kind::Foliage);
        let stone = id("stone");
        assert!(infos()[stone as usize].solid());
    }
}
