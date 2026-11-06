//! Tool registry: names, JSON schemas, and glue to the edit operations.

use crate::anvil;
use crate::blocks::{self, Kind as BKind};
use crate::editor::Editor;
use crate::ops::{self, nature, structures, terrain, water};
use crate::render;
use crate::spec::{self, Area};
use crate::world::{self, World};
use crate::zones::{self, Zones};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// Modifies one world; journaled for undo.
    Edit,
    /// Read-only.
    Read,
    /// Session-level (world management, undo, batch, IO).
    Session,
}

pub enum Out {
    Text(String),
    Image { png: Vec<u8>, caption: String },
}

impl Out {
    pub fn summary(&self) -> String {
        match self {
            Out::Text(t) => t.clone(),
            Out::Image { caption, .. } => caption.clone(),
        }
    }
}

type RunFn = fn(&mut Editor, &Value) -> Result<Out>;

pub struct Tool {
    pub name: &'static str,
    pub desc: &'static str,
    pub kind: Kind,
    pub params: Vec<(&'static str, &'static str, &'static str)>,
    pub required: &'static [&'static str],
    pub run: RunFn,
}

pub const INSTRUCTIONS: &str = r##"mapedit: real-time Minecraft world editor. Worlds live in memory; every edit is rendered live in the web viewer and can be undone. Export to a playable Java save at the end.

WORKFLOW: world_create → zones_hex (+ zone_set to give each zone a kind/name/biome) → generate base terrain with expression "y <= height(x,z)" → shape with ridge/raise/carve/pit/smooth → water (river, fill) → paint surfaces → forest/flora → road between gates → structure/paste landmarks → map/view to CHECK your work visually → export.

ARGUMENT SYNTAX
- point: "x,y,z" | "x,z" (y = surface) | gate id "G03" | zone id "Z05"; add "+N" to raise: "G03+2".
- points/path: "a → b → c" (also "->", ";", "|"), e.g. "G01 → 120,300 → G08".
- area: "all" | "zone:Z01,Z02" | "Z01" | "rect:x0,z0,x1,z1" | "circle:x,z,r" | "G03:60" (circle around anchor) | "outside". Or pass at + radius.
- pattern: "stone" | "60%stone,30%andesite,10%gravel" | block states "oak_log[axis=x]". Namespace optional.
- mask: "stone,dirt" | "!air" | "#solid" "#liquid" "#foliage" "#plant" "#wood" "#air" "#existing" | "*".
- expression (generate): variables x y z; + - * / % ^, comparisons, && || ! ?:; functions abs min max floor ceil round sqrt pow sin cos tan atan2 exp ln clamp lerp smoothstep step noise(x,z,scale) noise(x,y,z,scale) fbm(x,z,scale[,oct]) ridged(x,z,scale[,oct]) worley(x,z,scale) rand(x,z) height(x,z)=zone design heightfield, edge(x,z)=distance to zone border, zone(x,z), top(x,z)=current surface, dist(x,z,x0,z0). Expressions of the form "y <= f(x,z) && y > g(x,z)" are filled per column (fast).
- Coordinates: worlds are centred on 0,0; north = -z. Overworld y -64..319, nether 0..255. Sea level is usually 62.

Results are short summaries (counts). Use `map` (top-down image with zone labels) and `view` (3D perspective image) to see results, `probe`/`stats` for numbers, `undo` to revert, `batch` to send many calls at once."##;

const P_WORLD: (&str, &str, &str) = ("world", "string", "target world name (default: current world)");
const P_AREA: (&str, &str, &str) = ("area", "string", "area: all | zone:Z01,Z02 | rect:x0,z0,x1,z1 | circle:x,z,r | G03:60 | outside (default all, or at+radius)");
const P_AT: (&str, &str, &str) = ("at", "string", "point: x,y,z | x,z | gate G03 | zone Z05");
const P_RADIUS: (&str, &str, &str) = ("radius", "number", "radius in blocks");
const P_POINTS: (&str, &str, &str) = ("points", "string", "path 'a → b → c' of points (x,y,z | x,z | G03 | Z05), or JSON array of point strings");

macro_rules! op {
    ($f:path) => {
        |ed: &mut Editor, a: &Value| -> Result<Out> {
            let w = ed.world_mut(a)?;
            Ok(Out::Text($f(w, a)?))
        }
    };
}

fn t(name: &'static str, kind: Kind, desc: &'static str, params: Vec<(&'static str, &'static str, &'static str)>, required: &'static [&'static str], run: RunFn) -> Tool {
    Tool { name, desc, kind, params, required, run }
}

pub fn all() -> &'static [Tool] {
    static T: OnceLock<Vec<Tool>> = OnceLock::new();
    T.get_or_init(build)
}

pub fn find(name: &str) -> Option<&'static Tool> {
    let n = name.trim_start_matches("mapedit_").trim_start_matches("we_");
    all().iter().find(|t| t.name == n)
}

pub fn schema(t: &Tool) -> Value {
    let mut props = serde_json::Map::new();
    for (n, ty, d) in &t.params {
        let v = match *ty {
            "array" => json!({"type": "array", "description": d, "items": {}}),
            "any" => json!({"description": d}),
            other => json!({"type": other, "description": d}),
        };
        props.insert(n.to_string(), v);
    }
    json!({"type": "object", "properties": props, "required": t.required})
}

fn build() -> Vec<Tool> {
    use Kind::*;
    vec![
        // ------------------------------------------------------------ worlds
        t("world_create", Session, "Create an empty world (centred on 0,0) and make it current. Use dimension the_nether for nether-style worlds.", vec![
            ("name", "string", "world name, e.g. main"),
            ("size", "integer", "width and length in blocks (default 1024; e.g. 2400)"),
            ("size_x", "integer", "width override"), ("size_z", "integer", "length override"),
            ("dimension", "string", "overworld (default) | the_nether | the_end | custom name (exported as a datapack dimension)"),
            ("min_y", "integer", "bottom y (default -64; nether 0)"), ("height", "integer", "build height (default 384; nether 256)"),
            ("seed", "integer", "noise seed"), ("replace", "boolean", "replace an existing world with this name"),
        ], &["name"], world_create),
        t("world_list", Read, "List worlds.", vec![], &[], world_list),
        t("world_info", Read, "World size, bounds, y range, zones, block count, memory.", vec![P_WORLD], &[], world_info),
        t("world_select", Session, "Make a world the default target.", vec![("name", "string", "world name")], &["name"], world_select),
        t("world_delete", Session, "Delete a world (not undoable).", vec![("name", "string", "world name")], &["name"], world_delete),
        // ------------------------------------------------------------ zones
        t("zones_hex", Edit, "Lay out named hexagonal zones and gates (named connection points between neighbouring zones). rings=2 gives a 19-zone flower around 0,0; rings=-1 fills the whole map. Zones drive height(x,z) and can be referenced as areas/points.", vec![
            P_WORLD, ("spacing", "number", "centre-to-centre distance in blocks (default: fits the map)"),
            ("rings", "integer", "hex rings around the centre (default 2 → 19 zones); -1 = fill map"),
            ("labels", "string", "optional comma list of ids to assign in order (centre first, then ring by ring clockwise from east)"),
            ("outside_base", "number", "terrain height outside the flower (default 34 = sea floor)"),
        ], &[], zones_hex),
        t("zone_set", Edit, "Configure zones: preset kind (sets base height/relief/biome), name, id, biome and terrain numbers. Biome is also painted onto the zone's chunks.", vec![
            P_WORLD, ("zone", "string", "zone id(s), comma separated, or 'all'"),
            ("kind", "string", "preset: plains meadow forest hills mountains peaks plateau badlands desert valley swamp beach ocean volcano nether_wastes crimson warped"),
            ("id", "string", "new short id/label (single zone only), e.g. F2"), ("name", "string", "display name"),
            ("base", "number", "base height"), ("relief", "number", "noise amplitude"), ("scale", "number", "noise feature size"),
            ("ridged", "number", "0 smooth .. 1 ridged mountains"), ("biome", "string", "vanilla biome id, e.g. snowy_slopes"), ("notes", "string", "free text"),
        ], &["zone"], zone_set),
        t("zones_list", Read, "List zones (id, name, kind, centre, heights, biome) and gates (id, between zones, position).", vec![P_WORLD], &[], zones_list),
        // ------------------------------------------------------------ shapes
        t("generate", Edit, "Fill blocks where an expression is true, e.g. 'y <= height(x,z)' for base terrain from zones, or 'y <= 64 + 20*fbm(x,z,150)'. Column-form expressions are fast.", vec![
            P_WORLD, ("pattern", "string", "block pattern"), ("expression", "string", "boolean expression in x,y,z"),
            P_AREA, P_AT, P_RADIUS, ("mask", "string", "only replace blocks matching this mask"), ("min_y", "integer", "lower y bound"), ("max_y", "integer", "upper y bound"),
        ], &["pattern", "expression"], op!(ops::op_generate)),
        t("box", Edit, "Fill a cuboid between two corners (inclusive).", vec![P_WORLD, ("from", "string", "corner x,y,z"), ("to", "string", "corner x,y,z"), ("pattern", "string", "block pattern"), ("hollow", "boolean", "walls only"), ("mask", "string", "only replace matching blocks")], &["from", "to", "pattern"], op!(ops::op_box)),
        t("sphere", Edit, "Fill a sphere/ellipsoid. Use pattern air to dig.", vec![P_WORLD, P_AT, ("radius", "any", "radius or [rx,ry,rz]"), ("pattern", "string", "block pattern"), ("hollow", "boolean", "shell only"), ("mask", "string", "only replace matching blocks")], &["at", "pattern"], op!(ops::op_sphere)),
        t("cyl", Edit, "Fill a vertical cylinder from the point upward (negative height = downward).", vec![P_WORLD, P_AT, ("radius", "any", "radius or [rx,rz]"), ("height", "number", "height (default 1)"), ("pattern", "string", "block pattern"), ("hollow", "boolean", "walls only"), ("mask", "string", "only replace matching blocks")], &["at", "pattern"], op!(ops::op_cyl)),
        t("line", Edit, "Draw a thick 3D line/polyline of blocks (bridges, pipes, spines).", vec![P_WORLD, P_POINTS, ("radius", "number", "thickness radius (default 0.5)"), ("pattern", "string", "block pattern")], &["points", "pattern"], op!(ops::op_line)),
        t("replace", Edit, "Replace blocks matching a mask within an area and y range.", vec![P_WORLD, ("from", "string", "mask of blocks to replace"), ("pattern", "string", "new block pattern"), P_AREA, P_AT, P_RADIUS, ("min_y", "integer", "lower y"), ("max_y", "integer", "upper y")], &["from", "pattern"], op!(ops::op_replace)),
        t("biome", Edit, "Set the biome of an area (vanilla biome ids).", vec![P_WORLD, ("biome", "string", "e.g. cherry_grove"), P_AREA, P_AT, P_RADIUS], &["biome"], op!(ops::op_biome)),
        // ------------------------------------------------------------ terrain
        t("ridge", Edit, "Raise a mountain ridge along a path up to the y of its points (x,y,z), with noisy natural falloff.", vec![P_WORLD, P_POINTS, P_AT, ("radius", "number", "half-width (default 40)"), ("noisiness", "number", "0..1 (default 0.4)"), ("material", "string", "fill pattern (default keeps column materials)")], &[], op!(terrain::op_ridge)),
        t("raise", Edit, "Raise (or lower with negative height) terrain around a point or along a path with falloff.", vec![P_WORLD, P_POINTS, P_AT, ("radius", "number", "radius (default 24)"), ("height", "number", "blocks to add (negative lowers)"), ("falloff", "string", "smooth | linear | flat | sharp"), ("noisiness", "number", "0..1"), ("material", "string", "fill pattern")], &[], op!(terrain::op_raise)),
        t("smooth", Edit, "Smooth the ground heightfield.", vec![P_WORLD, P_AREA, P_AT, P_RADIUS, ("iterations", "integer", "default 3"), ("kernel", "integer", "blur radius (default 2)"), ("strength", "number", "0..1")], &[], op!(terrain::op_smooth)),
        t("flatten", Edit, "Flatten ground toward a y level (default: area average).", vec![P_WORLD, P_AREA, P_AT, P_RADIUS, ("y", "number", "target y"), ("strength", "number", "0..1"), ("feather", "number", "edge blend width for circles (default 8)"), ("material", "string", "fill pattern")], &[], op!(terrain::op_flatten)),
        t("roughen", Edit, "Add noisy bumps to the ground.", vec![P_WORLD, P_AREA, P_AT, P_RADIUS, ("amplitude", "number", "blocks (default 3)"), ("scale", "number", "noise size (default 12)"), ("feather", "number", "edge blend for circles")], &[], op!(terrain::op_roughen)),
        t("terrace", Edit, "Turn slopes into terraces/steps.", vec![P_WORLD, P_AREA, P_AT, P_RADIUS, ("step", "number", "step height (default 6)"), ("strength", "number", "0..1")], &[], op!(terrain::op_terrace)),
        t("pit", Edit, "Dig an open-pit mine: concentric terraced bowl, optional water at the bottom.", vec![P_WORLD, P_AT, ("radius", "number", "default 48"), ("depth", "number", "default 30"), ("steps", "integer", "terrace count (default 6)"), ("water_depth", "number", "flood the bottom"), ("fluid", "string", "water | lava"), ("material", "string", "wall/floor pattern")], &["at"], op!(terrain::op_pit)),
        t("carve", Edit, "Cut a canyon/trench along a path, floor = path y − depth. wall_slope 0 gives sheer cliffs.", vec![P_WORLD, P_POINTS, ("width", "number", "floor width (default 24)"), ("depth", "number", "depth below path points (default 20)"), ("wall_slope", "number", "0 = vertical walls; 1 = 45°"), ("roughness", "number", "0..1"), ("material", "string", "floor pattern")], &["points"], op!(terrain::op_carve)),
        t("paint", Edit, "Paint ground surface by rules (first match wins), e.g. rules=[{pattern:'snow_block',min_y:150},{pattern:'stone,andesite',min_slope:3},{pattern:'grass_block',depth:1},{pattern:'dirt',depth:3}] — note depth applies from the top; put the deepest-first rule last. Or a single pattern.", vec![
            P_WORLD, P_AREA, P_AT, P_RADIUS, ("rules", "array", "list of {pattern, depth, min_y, max_y, min_slope, max_slope, coverage 0..1, scale, on(mask)}"), ("pattern", "string", "single pattern instead of rules"), ("depth", "integer", "depth for single pattern"),
        ], &[], op!(terrain::op_paint)),
        t("overlay", Edit, "Place one block on top of the ground (snow layer, moss carpet, etc).", vec![P_WORLD, P_AREA, P_AT, P_RADIUS, ("pattern", "string", "block pattern"), ("on", "string", "mask for the ground block"), ("chance", "number", "0..1"), ("min_y", "integer", "only above this y")], &["pattern"], op!(terrain::op_overlay)),
        // ------------------------------------------------------------ water & roads
        t("river", Edit, "Carve a river along a path; water level is monotonic downstream. Lava rivers: fluid=lava.", vec![P_WORLD, P_POINTS, ("width", "number", "default 9"), ("depth", "number", "default 4"), ("bank", "number", "bank blend width (default 5)"), ("meander", "number", "0..1"), ("fluid", "string", "water | lava"), ("bed", "string", "river bed pattern")], &["points"], op!(water::op_river)),
        t("fill", Edit, "Fill water/lava up to a level. With 'at' and no area: connected flood from that point (follows coastlines, doesn't leak into closed basins). With area: fills every low column.", vec![P_WORLD, P_AT, P_AREA, ("level", "number", "y level (default: at point y)"), ("fluid", "string", "water | lava"), ("radius", "number", "flood limit radius"), ("connected", "boolean", "default true when only 'at' is given")], &[], op!(water::op_fill)),
        t("road", Edit, "Build a graded road along a path (gate ids work well), clearing headroom and bridging water. route=true auto-routes around steep terrain with A*.", vec![P_WORLD, P_POINTS, ("width", "number", "default 5"), ("pattern", "string", "surface pattern"), ("support", "string", "fill under the road"), ("bridge", "string", "bridge deck pattern"), ("max_grade", "number", "max rise per block (default 0.2)"), ("route", "boolean", "auto-route with A*"), ("clear", "integer", "headroom to clear (default 4)"), ("shoulder", "number", "terrain blend width (default 3)")], &["points"], op!(water::op_road)),
        // ------------------------------------------------------------ nature
        t("forest", Edit, "Scatter procedural trees with natural clumping. Types: oak birch spruce pine giant_spruce dark_oak pale_oak cherry acacia jungle dead bush red_mushroom brown_mushroom crimson_fungus warped_fungus glowcap. Weighted: '70%spruce,30%birch'. Override blocks with log/leaves for alien trees.", vec![
            P_WORLD, P_AREA, P_AT, P_RADIUS, ("types", "string", "weighted tree types"), ("spacing", "number", "min distance (default 7)"), ("density", "number", "0..1 (default 0.7)"),
            ("clump", "number", "0..1 clumping"), ("scale", "number", "size multiplier"), ("count", "integer", "max trees"), ("log", "string", "override trunk block"), ("leaves", "string", "override leaves/cap block"), ("on", "string", "ground mask"), ("max_slope", "integer", "default 3"), ("seed", "integer", "variation"),
        ], &[], op!(nature::op_forest)),
        t("tree", Edit, "Place a single tree.", vec![P_WORLD, P_AT, ("type", "string", "tree type"), ("scale", "number", "size"), ("log", "string", "trunk block"), ("leaves", "string", "leaves block"), ("seed", "integer", "variation")], &["at"], op!(nature::op_tree)),
        t("flora", Edit, "Scatter grass/flowers/fungi on top of the ground.", vec![P_WORLD, P_AREA, P_AT, P_RADIUS, ("plants", "string", "weighted pattern, e.g. '70%short_grass,10%poppy,20%dandelion'"), ("density", "number", "0..1 (default 0.25)"), ("patchiness", "number", "0..1"), ("on", "string", "ground mask")], &[], op!(nature::op_flora)),
        // ------------------------------------------------------------ structures
        t("structure", Edit, "Place a built-in procedural landmark: tower ruin house windmill fossil obelisk fortress gate well. Use points for many copies.", vec![
            P_WORLD, ("type", "string", "structure type"), P_AT, P_POINTS, ("size", "integer", "main dimension"), ("rotate", "any", "0/90/180/270 or 'random'"), ("material", "string", "main material override"), ("seed", "integer", "variation"), ("sink", "integer", "blocks to sink into the ground (default 0)"),
        ], &["type"], structure),
        t("schem_load", Session, "Load a Sponge .schem file (v2/v3) into the schematic library.", vec![("path", "string", "file path"), ("name", "string", "library name (default: file stem)")], &["path"], schem_load),
        t("schem_save", Read, "Save a library schematic to a .schem file.", vec![("name", "string", "library name"), ("path", "string", "file path")], &["name", "path"], schem_save),
        t("schem_list", Read, "List schematics in the library.", vec![], &[], schem_list),
        t("copy", Read, "Copy a cuboid into the schematic library (clipboard), optionally across worlds.", vec![P_WORLD, ("from", "string", "corner x,y,z"), ("to", "string", "corner x,y,z"), ("name", "string", "library name (default clipboard)"), ("origin", "string", "paste anchor x,y,z (default bottom centre)")], &["from", "to"], copy),
        t("paste", Edit, "Paste a library schematic at one point or many points.", vec![P_WORLD, ("name", "string", "library name (default clipboard)"), P_AT, P_POINTS, ("rotate", "any", "0/90/180/270 or 'random'"), ("ignore_air", "boolean", "default true"), ("sink", "integer", "sink into ground")], &[], paste),
        // ------------------------------------------------------------ inspection
        t("map", Read, "Render a top-down shaded map image with zone borders, zone ids and gates. Use it to check your work.", vec![P_WORLD, P_AREA, P_AT, P_RADIUS, ("size", "integer", "max pixels (default 768)"), ("mode", "string", "shaded | height | biome"), ("zones", "boolean", "draw zone borders (default true)"), ("labels", "boolean", "draw ids (default true)"), ("grid", "integer", "grid spacing in blocks (0 = none, default 200)")], &[], map),
        t("view", Read, "Render a 3D perspective image of the terrain. Default: from the south looking at the map centre. Set camera/look_at (points, gate or zone ids).", vec![P_WORLD, ("camera", "string", "camera position x,y,z"), ("look_at", "string", "target point"), ("yaw", "number", "degrees, 0 = north"), ("pitch", "number", "degrees, negative = down"), ("width", "integer", "default 960"), ("height", "integer", "default 540"), ("fov", "number", "default 70"), ("distance", "number", "view distance")], &[], view),
        t("probe", Read, "Describe a column: zone, biome, ground/top y and block layers.", vec![P_WORLD, P_AT], &["at"], probe),
        t("stats", Read, "Area statistics: height range, slopes, water coverage, top-block histogram, tree cover.", vec![P_WORLD, P_AREA, P_AT, P_RADIUS], &[], stats),
        t("history", Read, "Recent edits (undo stack).", vec![("limit", "integer", "default 20")], &[], history),
        t("undo", Session, "Undo the last edit(s), including zone changes.", vec![("steps", "integer", "default 1")], &[], |ed, a| Ok(Out::Text(ed.undo(spec::i(a, "steps", 1) as usize)?))),
        t("redo", Session, "Redo undone edit(s).", vec![("steps", "integer", "default 1")], &[], |ed, a| Ok(Out::Text(ed.redo(spec::i(a, "steps", 1) as usize)?))),
        t("batch", Session, "Run many tool calls in order: calls=[{tool:'forest', args:{...}}, ...]. Each is its own undo step. Image results are omitted.", vec![("calls", "array", "list of {tool, args}"), ("stop_on_error", "boolean", "default true")], &["calls"], batch),
        t("help", Read, "Reference: syntax, terrain presets, tree types, structures, functions, biomes.", vec![("topic", "string", "syntax | presets | trees | structures | functions | biomes")], &[], help),
        // ------------------------------------------------------------ IO
        t("export", Session, "Export worlds to a playable Minecraft Java save folder. Default mapping: first overworld world → overworld, the_nether world → nether, others → custom datapack dimensions.", vec![
            ("path", "string", "save folder (e.g. ~/.minecraft/saves/MyMap); default ./exports/<level_name>"), ("level_name", "string", "world name in the menu"),
            ("worlds", "string", "mapping 'main=overworld,outlands=the_nether' (default: auto)"), ("spawn", "string", "x,y,z (default: map centre surface)"),
            ("data_version", "integer", "chunk DataVersion (default 4189 = 1.21.4; newer games upgrade it)"), ("version_name", "string", "version name for level.dat"),
        ], &[], export),
        t("import", Session, "Import a dimension of an existing Java save (1.18+) as a new world.", vec![("path", "string", "save folder"), ("dimension", "string", "overworld | the_nether | the_end | ns:name"), ("name", "string", "new world name"), ("rect", "string", "block rect x0,z0,x1,z1 to limit the import")], &["path"], import),
    ]
}

// ---------------------------------------------------------------- worlds

fn world_create(ed: &mut Editor, a: &Value) -> Result<Out> {
    let name = spec::req_s(a, "name")?.trim().to_string();
    if name.is_empty() {
        bail!("name is empty");
    }
    let dim = spec::s(a, "dimension").unwrap_or("overworld").trim_start_matches("minecraft:").to_string();
    let nether_like = matches!(dim.as_str(), "the_nether" | "nether" | "the_end" | "end");
    let dim = match dim.as_str() {
        "nether" => "the_nether".to_string(),
        "end" => "the_end".to_string(),
        d => d.to_string(),
    };
    let size = spec::i(a, "size", 1024) as i32;
    let sx = spec::i(a, "size_x", size as i64) as i32;
    let sz = spec::i(a, "size_z", size as i64) as i32;
    if sx < 16 || sz < 16 || (sx as i64) * (sz as i64) > 8192 * 8192 {
        bail!("size must be between 16 and 8192×8192");
    }
    let min_y = spec::i(a, "min_y", if nether_like { 0 } else { -64 }) as i32;
    let height = spec::i(a, "height", if nether_like { 256 } else { 384 }) as i32;
    let seed = spec::i(a, "seed", 1337) as u32;
    if let Some(i) = ed.worlds.iter().position(|w| w.name == name) {
        if !spec::b(a, "replace", false) {
            bail!("world '{name}' exists (pass replace=true)");
        }
        ed.worlds.remove(i);
        ed.history.retain(|e| e.world != name);
        ed.redo.retain(|e| e.world != name);
    }
    let w = World::new(&name, sx, sz, min_y, height, &dim, seed);
    let (x0, z0, x1, z1) = w.bounds();
    let msg = format!("world '{name}' ({dim}) {}×{} blocks, x {x0}..{} z {z0}..{}, y {}..{}, {} chunks", x1 - x0, z1 - z0, x1 - 1, z1 - 1, w.min_y, w.max_y() - 1, w.chunks.len());
    ed.worlds.push(w);
    ed.current = ed.worlds.len() - 1;
    ed.emit(json!({"type": "worlds"}));
    Ok(Out::Text(msg))
}

fn world_list(ed: &mut Editor, _a: &Value) -> Result<Out> {
    if ed.worlds.is_empty() {
        return Ok(Out::Text("no worlds".into()));
    }
    let lines: Vec<String> = ed
        .worlds
        .iter()
        .enumerate()
        .map(|(i, w)| {
            let (sx, sz) = w.size();
            format!("{}{} ({}) {}×{}, {} zones", if i == ed.current { "* " } else { "  " }, w.name, w.dimension, sx, sz, w.zones.zones.len())
        })
        .collect();
    Ok(Out::Text(lines.join("\n")))
}

fn world_info(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world(a)?;
    let (x0, z0, x1, z1) = w.bounds();
    let v = json!({
        "name": w.name, "dimension": w.dimension, "bounds": {"x": [x0, x1 - 1], "z": [z0, z1 - 1]},
        "y": [w.min_y, w.max_y() - 1], "chunks": w.chunks.len(), "zones": w.zones.zones.len(), "gates": w.zones.gates.len(),
        "blocks": w.count_non_air(), "memory_mb": w.memory() / (1 << 20), "seed": w.seed,
    });
    Ok(Out::Text(v.to_string()))
}

fn world_select(ed: &mut Editor, a: &Value) -> Result<Out> {
    let n = spec::req_s(a, "name")?;
    ed.current = ed.worlds.iter().position(|w| w.name == n).ok_or_else(|| anyhow!("unknown world '{n}'"))?;
    ed.emit(json!({"type": "worlds"}));
    Ok(Out::Text(format!("current world: {n}")))
}

fn world_delete(ed: &mut Editor, a: &Value) -> Result<Out> {
    let n = spec::req_s(a, "name")?;
    let i = ed.worlds.iter().position(|w| w.name == n).ok_or_else(|| anyhow!("unknown world '{n}'"))?;
    ed.worlds.remove(i);
    ed.history.retain(|e| e.world != n);
    ed.redo.retain(|e| e.world != n);
    ed.current = 0;
    ed.emit(json!({"type": "worlds"}));
    Ok(Out::Text(format!("deleted world {n}")))
}

// ---------------------------------------------------------------- zones

fn zones_hex(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world_mut(a)?;
    let rings = spec::i(a, "rings", 2) as i32;
    let (sx, sz) = w.size();
    let default_spacing = if rings >= 0 { (sx.min(sz) as f64) / (2.0 * rings as f64 + 1.15) } else { 300.0 };
    let spacing = spec::f(a, "spacing", default_spacing);
    let mut z = Zones::layout_hex(w.bounds(), spacing, rings, w.seed);
    z.outside_base = spec::f(a, "outside_base", 34.0);
    let labels = spec::list(a, "labels");
    for (i, l) in labels.iter().enumerate() {
        if let Some(zn) = z.zones.get_mut(i) {
            zn.id = l.clone();
        }
    }
    z.rebuild_gates();
    let n = z.zones.len();
    let g = z.gates.len();
    w.zones = z;
    Ok(Out::Text(format!("{n} zones · {g} gates (spacing {:.0}). {}", spacing, zones_brief(&w.zones))))
}

fn zones_brief(z: &Zones) -> String {
    z.zones.iter().map(|zn| format!("{}@{:.0},{:.0}", zn.id, zn.cx, zn.cz)).collect::<Vec<_>>().join(" ")
}

fn zone_set(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world_mut(a)?;
    let sel = spec::req_s(a, "zone")?;
    let ids: Vec<usize> = if sel == "all" {
        (0..w.zones.zones.len()).collect()
    } else {
        sel.split(',').map(|s| w.zones.find(s).ok_or_else(|| anyhow!("unknown zone '{s}'"))).collect::<Result<_>>()?
    };
    if ids.is_empty() {
        bail!("no zones (call zones_hex first)");
    }
    let mut msgs = vec![];
    for &i in &ids {
        let zn = &mut w.zones.zones[i];
        if let Some(k) = spec::s(a, "kind") {
            if !Zones::apply_preset(zn, k) {
                bail!("unknown kind '{k}'. Presets: {}", zones::PRESETS.iter().map(|p| p.0).collect::<Vec<_>>().join(" "));
            }
        }
        if let Some(n) = spec::s(a, "name") {
            zn.name = n.to_string();
        }
        if let Some(n) = spec::s(a, "notes") {
            zn.notes = n.to_string();
        }
        for (k, f) in [("base", 0), ("relief", 1), ("scale", 2), ("ridged", 3)] {
            if a.get(k).is_some() {
                let v = spec::f(a, k, 0.0);
                match f {
                    0 => zn.base = v,
                    1 => zn.relief = v,
                    2 => zn.scale = v.max(8.0),
                    _ => zn.ridged = v.clamp(0.0, 1.0),
                }
            }
        }
        if let Some(b) = spec::s(a, "biome") {
            let b = if b.contains(':') { b.to_string() } else { format!("minecraft:{b}") };
            if !anvil::valid_biome(&b) {
                bail!("'{b}' is not a vanilla biome (see help topic=biomes)");
            }
            zn.biome = b;
        }
        if let Some(newid) = spec::s(a, "id") {
            if ids.len() == 1 {
                zn.id = newid.to_string();
            }
        }
        msgs.push(format!("{} {} base {:.0} relief {:.0} {}", zn.id, zn.kind, zn.base, zn.relief, zn.biome.trim_start_matches("minecraft:")));
    }
    if spec::s(a, "id").is_some() {
        w.zones.rebuild_gates();
    }
    // paint zone biomes
    let mut cells = 0;
    let wb = w.bounds();
    let infos = blocks::infos();
    let _ = infos;
    for &i in &ids {
        let bid = world::biome_id(&w.zones.zones[i].biome);
        let area = Area::Zones(vec![i]);
        let (x0, z0, x1, z1) = area.bbox(w);
        let mut x = x0 - x0.rem_euclid(4);
        while x < x1.min(wb.2) {
            let mut z = z0 - z0.rem_euclid(4);
            while z < z1.min(wb.3) {
                if area.contains(x + 2, z + 2, w) {
                    w.set_biome(x, z, bid);
                    cells += 1;
                }
                z += 4;
            }
            x += 4;
        }
    }
    Ok(Out::Text(format!("{} (biome painted on {} cells)", msgs.join("; "), cells)))
}

fn zones_list(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world(a)?;
    if w.zones.is_empty() {
        return Ok(Out::Text("no zones; call zones_hex".into()));
    }
    let mut s = String::from("zones (id | name | kind | centre | base/relief | biome):\n");
    for zn in &w.zones.zones {
        s += &format!("{} | {} | {} | {:.0},{:.0} | {:.0}/{:.0} | {}\n", zn.id, zn.name, zn.kind, zn.cx, zn.cz, zn.base, zn.relief, zn.biome.trim_start_matches("minecraft:"));
    }
    s += "gates (id: zones @ x,z):\n";
    s += &w.zones.gates.iter().map(|g| format!("{}: {}|{} @{:.0},{:.0}", g.id, g.a, g.b, g.x, g.z)).collect::<Vec<_>>().join("\n");
    Ok(Out::Text(s))
}

// ---------------------------------------------------------------- structures

fn paste_points(ed: &Editor, a: &Value) -> Result<Vec<(i32, i32, i32)>> {
    let w = ed.world(a)?;
    let infos = blocks::infos();
    let pts = if let Some(p) = a.get("points") {
        spec::points(p, w, &infos)?
    } else {
        vec![spec::point(spec::req_s(a, "at")?, w, &infos)?]
    };
    let sink = spec::i(a, "sink", 0) as i32;
    Ok(pts.iter().map(|p| (p.x.floor() as i32, p.y.floor() as i32 - sink, p.z.floor() as i32)).collect())
}

fn structure(ed: &mut Editor, a: &Value) -> Result<Out> {
    let kind = spec::req_s(a, "type")?.to_string();
    let pts = paste_points(ed, a)?;
    let size = spec::i(a, "size", 0) as i32;
    let mat = spec::s(a, "material").map(|s| s.to_string());
    let seed = spec::i(a, "seed", 1) as u64;
    let w = ed.world_mut(a)?;
    let mut total = 0;
    for (k, &p) in pts.iter().enumerate() {
        let mut rng = crate::noise::Rng::new(seed ^ ((p.0 as u64) << 20) ^ p.2 as u64 ^ k as u64);
        let s = structures::builtin(&kind, size, &mut rng, mat.as_deref())?;
        let turns = structures::turns_arg(a, rng.next_u64());
        total += structures::paste(w, &s, p, turns, true);
    }
    Ok(Out::Text(if pts.len() == 1 {
        structures::summary(&kind, total, pts[0])
    } else {
        format!("{} × {}: {} blocks", pts.len(), kind, ops::fmt_n(total))
    }))
}

fn schem_load(ed: &mut Editor, a: &Value) -> Result<Out> {
    let path = ed.resolve_path(spec::req_s(a, "path")?);
    let s = structures::load_schem(&path.to_string_lossy())?;
    let name = spec::s(a, "name").map(|s| s.to_string()).unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("schem".into()));
    let msg = format!("{name}: {}×{}×{} ({} blocks)", s.w, s.h, s.l, ops::fmt_n(s.count() as u64));
    ed.schematics.insert(name, s);
    Ok(Out::Text(msg))
}

fn schem_save(ed: &mut Editor, a: &Value) -> Result<Out> {
    let name = spec::req_s(a, "name")?;
    let s = ed.schematics.get(name).ok_or_else(|| anyhow!("no schematic '{name}'"))?;
    let path = ed.resolve_path(spec::req_s(a, "path")?);
    structures::save_schem(s, &path.to_string_lossy(), ed.data_version)?;
    Ok(Out::Text(format!("saved {name} to {}", path.display())))
}

fn schem_list(ed: &mut Editor, _a: &Value) -> Result<Out> {
    if ed.schematics.is_empty() {
        return Ok(Out::Text("library empty (schem_load or copy). Built-in structures: use the structure tool".into()));
    }
    let mut v: Vec<String> = ed.schematics.iter().map(|(n, s)| format!("{n}: {}×{}×{}", s.w, s.h, s.l)).collect();
    v.sort();
    Ok(Out::Text(v.join("\n")))
}

fn copy(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world(a)?;
    let infos = blocks::infos();
    let p1 = spec::point(spec::req_s(a, "from")?, w, &infos)?;
    let p2 = spec::point(spec::req_s(a, "to")?, w, &infos)?;
    let origin = match spec::s(a, "origin") {
        Some(o) => {
            let p = spec::point(o, w, &infos)?;
            Some((p.x as i32, p.y as i32, p.z as i32))
        }
        None => None,
    };
    let s = structures::copy(w, (p1.x as i32, p1.y as i32, p1.z as i32), (p2.x as i32, p2.y as i32, p2.z as i32), origin);
    let name = spec::s(a, "name").unwrap_or("clipboard").to_string();
    let msg = format!("copied {}×{}×{} ({} blocks) to '{name}'", s.w, s.h, s.l, ops::fmt_n(s.count() as u64));
    ed.schematics.insert(name, s);
    Ok(Out::Text(msg))
}

fn paste(ed: &mut Editor, a: &Value) -> Result<Out> {
    let name = spec::s(a, "name").unwrap_or("clipboard").to_string();
    let s = ed.schematics.get(&name).cloned().ok_or_else(|| anyhow!("no schematic '{name}' (schem_load or copy first)"))?;
    let pts = paste_points(ed, a)?;
    let ignore_air = spec::b(a, "ignore_air", true);
    let w = ed.world_mut(a)?;
    let mut total = 0;
    for (k, &p) in pts.iter().enumerate() {
        let turns = structures::turns_arg(a, (p.0 as u64).wrapping_mul(31) ^ p.2 as u64 ^ k as u64);
        total += structures::paste(w, &s, p, turns, ignore_air);
    }
    Ok(Out::Text(format!("pasted {name} × {}: {} blocks", pts.len(), ops::fmt_n(total))))
}

// ---------------------------------------------------------------- inspection

fn map(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world(a)?;
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let rect = area.bbox(w);
    let o = render::MapOpts {
        size: spec::i(a, "size", 768).clamp(64, 2048) as usize,
        mode: spec::s(a, "mode").unwrap_or("shaded").to_string(),
        zones: spec::b(a, "zones", true),
        labels: spec::b(a, "labels", true),
        grid: spec::i(a, "grid", 200) as i32,
    };
    let (png, legend) = render::render_map(w, rect, &o)?;
    Ok(Out::Image { png, caption: legend })
}

fn view(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world(a)?;
    let (cam, yaw, pitch, desc) = render::camera_from_args(w, a)?;
    let (sx, sz) = w.size();
    let o = render::ViewOpts {
        width: spec::i(a, "width", 960).clamp(64, 1920) as usize,
        height: spec::i(a, "height", 540).clamp(64, 1080) as usize,
        fov: spec::f(a, "fov", 70.0).clamp(20.0, 120.0),
        distance: spec::f(a, "distance", (sx.max(sz) as f64) * 1.2),
    };
    let png = render::render_view(w, cam, yaw, pitch, &o)?;
    Ok(Out::Image { png, caption: desc })
}

fn probe(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world(a)?;
    let infos = blocks::infos();
    let p = spec::point(spec::req_s(a, "at")?, w, &infos)?;
    let (x, z) = (p.x.floor() as i32, p.z.floor() as i32);
    if !w.in_bounds(x, z) {
        bail!("{x},{z} is outside the world {:?}", w.bounds());
    }
    let zone = w.zones.zone_at(x as f64 + 0.5, z as f64 + 0.5).map(|i| {
        let zn = &w.zones.zones[i];
        format!("{} {} ({})", zn.id, zn.name, zn.kind)
    });
    let mut runs: Vec<(i32, i32, u16)> = vec![];
    for y in (w.min_y..w.max_y()).rev() {
        let b = w.get(x, y, z);
        match runs.last_mut() {
            Some(r) if r.2 == b => r.1 = y,
            _ => runs.push((y, y, b)),
        }
    }
    let layers: Vec<String> = runs
        .iter()
        .filter(|r| !blocks::is_air(r.2))
        .take(16)
        .map(|r| {
            let n = blocks::name(r.2);
            let n = n.trim_start_matches("minecraft:");
            if r.0 == r.1 { format!("y{} {n}", r.0) } else { format!("y{}..{} {n}", r.0, r.1) }
        })
        .collect();
    Ok(Out::Text(format!(
        "column {x},{z}: zone {}, biome {}, ground y {}, top y {}, design height {:.0}\nlayers (top→down): {}",
        zone.unwrap_or_else(|| "-".into()),
        world::biome_name(w.biome(x, z)).trim_start_matches("minecraft:"),
        w.ground(x, z, &infos).map(|v| v.to_string()).unwrap_or("-".into()),
        w.top(x, z, &infos).map(|v| v.to_string()).unwrap_or("-".into()),
        w.zones.design_height(x as f64, z as f64),
        layers.join("; ")
    )))
}

fn stats(ed: &mut Editor, a: &Value) -> Result<Out> {
    let w = ed.world(a)?;
    let infos = blocks::infos();
    let area = Area::from_args(a, w, &infos)?;
    let (x0, z0, x1, z1) = area.bbox(w);
    let step = (((x1 - x0) as i64 * (z1 - z0) as i64) as f64 / 1_000_000.0).sqrt().ceil().max(1.0) as i32;
    let mut hist: HashMap<u16, u64> = HashMap::new();
    let (mut n, mut water, mut trees, mut sum, mut mn, mut mx, mut steep) = (0u64, 0u64, 0u64, 0i64, i32::MAX, i32::MIN, 0u64);
    let mut z = z0;
    while z < z1 {
        let mut x = x0;
        while x < x1 {
            if area.contains(x, z, w) {
                if let Some(t) = w.top(x, z, &infos) {
                    let b = w.get(x, t, z);
                    let g = w.ground(x, z, &infos).unwrap_or(t);
                    n += 1;
                    sum += g as i64;
                    mn = mn.min(g);
                    mx = mx.max(g);
                    match infos[b as usize].kind {
                        BKind::Liquid => water += 1,
                        BKind::Foliage | BKind::Wood => trees += 1,
                        _ => {}
                    }
                    let gb = w.get(x, g, z);
                    *hist.entry(gb).or_default() += 1;
                    let gx = w.ground(x + 2, z, &infos).unwrap_or(g);
                    if (gx - g).abs() >= 4 {
                        steep += 1;
                    }
                }
            }
            x += step;
        }
        z += step;
    }
    if n == 0 {
        return Ok(Out::Text(format!("{}: empty", area.describe(w))));
    }
    let mut h: Vec<(u16, u64)> = hist.into_iter().collect();
    h.sort_by(|a, b| b.1.cmp(&a.1));
    let top: Vec<String> = h.iter().take(10).map(|(b, c)| format!("{} {:.1}%", blocks::name(*b).trim_start_matches("minecraft:"), *c as f64 * 100.0 / n as f64)).collect();
    Ok(Out::Text(format!(
        "{} (sampled every {step} blocks, {} columns): ground y {}..{} avg {:.0}; water {:.1}%; tree canopy {:.1}%; steep {:.1}%\nground blocks: {}",
        area.describe(w), ops::fmt_n(n), mn, mx, sum as f64 / n as f64,
        water as f64 * 100.0 / n as f64, trees as f64 * 100.0 / n as f64, steep as f64 * 100.0 / n as f64, top.join(", ")
    )))
}

fn history(ed: &mut Editor, a: &Value) -> Result<Out> {
    let lim = spec::i(a, "limit", 20) as usize;
    if ed.history.is_empty() {
        return Ok(Out::Text(format!("no edits yet ({} redo)", ed.redo.len())));
    }
    let lines: Vec<String> = ed.history.iter().rev().take(lim).map(|e| format!("#{} [{}] {} → {} ({} ms)", e.id, e.world, e.tool, e.summary, e.ms)).collect();
    Ok(Out::Text(format!("{}\n({} total, {} redo available)", lines.join("\n"), ed.history.len(), ed.redo.len())))
}

fn batch(ed: &mut Editor, a: &Value) -> Result<Out> {
    let calls = match a.get("calls") {
        Some(Value::Array(c)) => c.clone(),
        Some(Value::String(s)) => serde_json::from_str::<Vec<Value>>(s)?,
        _ => bail!("calls must be an array of {{tool, args}}"),
    };
    let stop = spec::b(a, "stop_on_error", true);
    let mut out = vec![];
    for (i, c) in calls.iter().enumerate() {
        let name = c.get("tool").or_else(|| c.get("name")).and_then(|v| v.as_str()).ok_or_else(|| anyhow!("call {i} has no 'tool'"))?;
        if name == "batch" {
            bail!("nested batch not allowed");
        }
        let args = c.get("args").or_else(|| c.get("arguments")).cloned().unwrap_or(json!({}));
        match ed.run_tool(name, &args) {
            Ok(Out::Text(t)) => out.push(format!("{}. {name}: {t}", i + 1)),
            Ok(Out::Image { caption, .. }) => out.push(format!("{}. {name}: (image omitted in batch) {caption}", i + 1)),
            Err(e) => {
                out.push(format!("{}. {name}: ERROR {e}", i + 1));
                if stop {
                    out.push(format!("stopped; {} calls not run", calls.len() - i - 1));
                    break;
                }
            }
        }
    }
    Ok(Out::Text(out.join("\n")))
}

fn help(_ed: &mut Editor, a: &Value) -> Result<Out> {
    let topic = spec::s(a, "topic").unwrap_or("syntax");
    let s = match topic {
        "presets" => zones::PRESETS.iter().map(|(k, p)| format!("{k}: base {} relief {} scale {} ridged {} biome {}", p.base, p.relief, p.scale, p.ridged, p.biome)).collect::<Vec<_>>().join("\n"),
        "trees" => nature::TREE_TYPES.join(", "),
        "structures" => structures::BUILTINS.iter().map(|(k, d)| format!("{k}: {d}")).collect::<Vec<_>>().join("\n"),
        "functions" => crate::expr::FUNCS.iter().map(|f| f.2).collect::<Vec<_>>().join("\n"),
        "biomes" => anvil::VANILLA_BIOMES.join(", "),
        _ => INSTRUCTIONS.to_string(),
    };
    Ok(Out::Text(s))
}

// ---------------------------------------------------------------- IO

fn export(ed: &mut Editor, a: &Value) -> Result<Out> {
    if ed.worlds.is_empty() {
        bail!("nothing to export");
    }
    let level_name = spec::s(a, "level_name").unwrap_or("mapedit").to_string();
    let path = ed.resolve_path(spec::s(a, "path").map(|s| s.to_string()).unwrap_or_else(|| format!("exports/{level_name}")).as_str());
    let dv = spec::i(a, "data_version", ed.data_version as i64) as i32;
    let vname = spec::s(a, "version_name").unwrap_or(&ed.version_name).to_string();
    // world → dimension mapping
    let mut mapping: Vec<(usize, String)> = vec![];
    if let Some(m) = spec::s(a, "worlds") {
        for part in m.split(',') {
            let (wn, d) = part.split_once('=').ok_or_else(|| anyhow!("worlds mapping must look like main=overworld"))?;
            let i = ed.worlds.iter().position(|w| w.name == wn.trim()).ok_or_else(|| anyhow!("unknown world '{wn}'"))?;
            mapping.push((i, d.trim().to_string()));
        }
    } else {
        let mut used = std::collections::HashSet::new();
        for (i, w) in ed.worlds.iter().enumerate() {
            let want = match w.dimension.as_str() {
                "overworld" | "the_nether" | "the_end" => w.dimension.clone(),
                other => format!("mapedit:{other}"),
            };
            let d = if used.contains(&want) { format!("mapedit:{}", w.name.to_lowercase().replace(' ', "_")) } else { want };
            used.insert(d.clone());
            mapping.push((i, d));
        }
    }
    if path.join("level.dat").exists() && !spec::b(a, "overwrite", true) {
        bail!("{} already contains a save", path.display());
    }
    std::fs::create_dir_all(&path)?;
    let mut report = vec![];
    let mut custom = vec![];
    let events = ed.events.clone();
    for (i, dim) in &mapping {
        let w = &ed.worlds[*i];
        let dir = anvil::dimension_dir(&path, dim);
        let label = format!("{} → {}", w.name, dim);
        let ev = events.clone();
        let lbl = label.clone();
        let (chunks, regions, bytes) = anvil::write_regions(w, &dir, dv, &move |done, total| {
            let _ = ev.send(json!({"type": "progress", "label": lbl, "done": done, "total": total}).to_string());
        })?;
        if dim.contains(':') && !dim.starts_with("minecraft:") {
            custom.push(dim.clone());
        }
        report.push(format!("{label}: {} chunks, {regions} region files, {:.1} MB", ops::fmt_n(chunks as u64), bytes as f64 / 1e6));
    }
    let spawn = match spec::s(a, "spawn") {
        Some(s) => {
            let w = &ed.worlds[mapping[0].0];
            let p = spec::point(s, w, &blocks::infos())?;
            (p.x as i32, p.y as i32, p.z as i32)
        }
        None => {
            let w = &ed.worlds[mapping.iter().find(|m| m.1 == "overworld").map(|m| m.0).unwrap_or(mapping[0].0)];
            let y = w.top(0, 0, &blocks::infos()).unwrap_or(64) + 1;
            (0, y, 0)
        }
    };
    anvil::write_level_dat(&path, &anvil::ExportOpts { level_name: level_name.clone(), data_version: dv, version_name: vname.clone(), spawn }, &custom)?;
    ed.emit(json!({"type": "exported", "path": path.to_string_lossy()}));
    let mut msg = format!("exported '{level_name}' to {} (DataVersion {dv}, {vname})\n{}", path.display(), report.join("\n"));
    if !custom.is_empty() {
        msg += &format!("\ncustom dimensions via datapack: {} (enter with /execute in {} run tp @s 0 100 0)", custom.join(", "), custom[0]);
    }
    Ok(Out::Text(msg))
}

fn import(ed: &mut Editor, a: &Value) -> Result<Out> {
    let path = ed.resolve_path(spec::req_s(a, "path")?);
    let dim = spec::s(a, "dimension").unwrap_or("overworld");
    let name = spec::s(a, "name").map(|s| s.to_string()).unwrap_or_else(|| anvil::read_level_name(&path).unwrap_or_else(|| "imported".into()));
    let limit = match spec::s(a, "rect") {
        Some(r) => {
            let v: Vec<i32> = r.split(',').map(|s| s.trim().parse::<i32>()).collect::<Result<_, _>>()?;
            if v.len() != 4 {
                bail!("rect needs x0,z0,x1,z1");
            }
            Some((v[0].min(v[2]).div_euclid(16), v[1].min(v[3]).div_euclid(16), v[0].max(v[2]).div_euclid(16), v[1].max(v[3]).div_euclid(16)))
        }
        None => None,
    };
    if ed.worlds.iter().any(|w| w.name == name) {
        bail!("world '{name}' exists; pass another name");
    }
    let w = anvil::import(&path, dim, &name, limit)?;
    let (x0, z0, x1, z1) = w.bounds();
    let msg = format!("imported {} as '{name}': x {x0}..{} z {z0}..{} ({} chunks)", dim, x1 - 1, z1 - 1, w.chunks.len());
    w.mark_all_dirty();
    ed.worlds.push(w);
    ed.current = ed.worlds.len() - 1;
    ed.emit(json!({"type": "worlds"}));
    Ok(Out::Text(msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(ed: &mut Editor, tool: &str, args: Value) -> String {
        match ed.run_tool(tool, &args) {
            Ok(o) => o.summary(),
            Err(e) => panic!("{tool} failed: {e:#}"),
        }
    }

    /// Every tool in a realistic sequence on a small world, plus undo/redo and
    /// an export → import round trip.
    #[test]
    fn end_to_end_small_world() {
        let (tx, _rx) = tokio::sync::broadcast::channel(1024);
        let mut ed = Editor::new(tx);
        run(&mut ed, "world_create", json!({"name": "main", "size": 384}));
        run(&mut ed, "zones_hex", json!({"rings": 1, "labels": "C0,N1,N2,E1,S1,S2,W1"}));
        run(&mut ed, "zone_set", json!({"zone": "N1,N2", "kind": "mountains"}));
        run(&mut ed, "zone_set", json!({"zone": "S1,S2", "kind": "ocean"}));
        run(&mut ed, "zone_set", json!({"zone": "C0", "kind": "plains", "name": "中心"}));
        let s = run(&mut ed, "generate", json!({"pattern": "stone", "expression": "y <= height(x,z)"}));
        assert!(!s.contains("per-voxel"), "{s}");
        run(&mut ed, "ridge", json!({"points": "N1 → N2+40", "radius": 40}));
        run(&mut ed, "pit", json!({"at": "E1", "radius": 20, "depth": 12, "water_depth": 2}));
        run(&mut ed, "carve", json!({"points": "-150,-50 → 150,-60", "width": 10, "depth": 8}));
        run(&mut ed, "river", json!({"points": "N1 → C0 → S1", "width": 7}));
        run(&mut ed, "fill", json!({"at": "S2", "level": 62}));
        run(&mut ed, "paint", json!({"rules": [{"pattern": "stone", "min_slope": 4}, {"pattern": "grass_block"}]}));
        run(&mut ed, "overlay", json!({"pattern": "snow", "min_y": 120}));
        let f = run(&mut ed, "forest", json!({"area": "zone:C0,W1", "types": "70%oak,30%birch", "spacing": 6}));
        assert!(!f.starts_with("0 trees"), "{f}");
        run(&mut ed, "flora", json!({"area": "C0"}));
        run(&mut ed, "road", json!({"points": "W1 → C0 → E1", "route": true}));
        run(&mut ed, "structure", json!({"type": "house", "at": "C0", "rotate": 90}));
        run(&mut ed, "sphere", json!({"at": "0,150,0", "radius": 5, "pattern": "glass", "hollow": true}));
        run(&mut ed, "box", json!({"from": "10,80,10", "to": "14,84,14", "pattern": "60%stone_bricks,40%mossy_stone_bricks"}));
        run(&mut ed, "cyl", json!({"at": "-40,70,40", "radius": 4, "height": 10, "pattern": "oak_planks"}));
        run(&mut ed, "line", json!({"points": "0,120,0 → 20,130,20", "pattern": "bone_block", "radius": 1}));
        run(&mut ed, "replace", json!({"from": "oak_planks", "pattern": "spruce_planks"}));
        run(&mut ed, "smooth", json!({"area": "W1", "iterations": 2}));
        run(&mut ed, "raise", json!({"at": "W1", "radius": 20, "height": 6}));
        run(&mut ed, "flatten", json!({"at": "C0", "radius": 12}));
        run(&mut ed, "roughen", json!({"area": "E1", "amplitude": 2}));
        run(&mut ed, "terrace", json!({"area": "N1"}));
        run(&mut ed, "biome", json!({"area": "W1", "biome": "cherry_grove"}));
        run(&mut ed, "tree", json!({"at": "30,30", "type": "glowcap"}));
        run(&mut ed, "copy", json!({"from": "8,78,8", "to": "16,86,16", "name": "hut"}));
        run(&mut ed, "paste", json!({"name": "hut", "points": "50,50 → 60,-60", "rotate": "random"}));
        let probe = run(&mut ed, "probe", json!({"at": "C0"}));
        assert!(probe.contains("zone C0"), "{probe}");
        run(&mut ed, "stats", json!({"area": "C0"}));
        let Out::Image { png, .. } = ed.run_tool("map", &json!({"size": 128})).unwrap() else { panic!() };
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        let Out::Image { png, .. } = ed.run_tool("view", &json!({"width": 160, "height": 90})).unwrap() else { panic!() };
        assert!(png.len() > 100);
        // batch + undo/redo
        let b = run(&mut ed, "batch", json!({"calls": [{"tool": "box", "args": {"from": "0,200,0", "to": "3,203,3", "pattern": "gold_block"}}, {"tool": "nope", "args": {}}]}));
        assert!(b.contains("ERROR") && b.contains("set"), "{b}");
        let gold = crate::blocks::id("gold_block");
        assert_eq!(ed.worlds[0].get(1, 201, 1), gold);
        run(&mut ed, "undo", json!({}));
        assert_eq!(ed.worlds[0].get(1, 201, 1), crate::blocks::AIR);
        run(&mut ed, "redo", json!({}));
        assert_eq!(ed.worlds[0].get(1, 201, 1), gold);
        // zones undo
        let n = ed.worlds[0].zones.zones.len();
        run(&mut ed, "zones_hex", json!({"rings": 2}));
        assert_ne!(ed.worlds[0].zones.zones.len(), n);
        run(&mut ed, "undo", json!({}));
        assert_eq!(ed.worlds[0].zones.zones.len(), n);
        // failed edit rolls back
        assert!(ed.run_tool("box", &json!({"from": "0,0,0", "to": "1,1,1"})).is_err());
        // export + import
        let dir = std::env::temp_dir().join(format!("mapedit_e2e_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        run(&mut ed, "world_create", json!({"name": "nether", "size": 128, "dimension": "the_nether"}));
        run(&mut ed, "generate", json!({"pattern": "netherrack", "expression": "y <= 40 + 10*fbm(x,z,40)"}));
        let ex = run(&mut ed, "export", json!({"path": dir.to_string_lossy(), "level_name": "E2E"}));
        assert!(ex.contains("main → overworld") && ex.contains("nether → the_nether"), "{ex}");
        run(&mut ed, "import", json!({"path": dir.to_string_lossy(), "name": "back"}));
        let (a, b2) = (&ed.worlds[0], ed.worlds.iter().find(|w| w.name == "back").unwrap());
        for (x, z) in [(0, 0), (50, 50), (-100, 80), (10, 10)] {
            for y in [60, 70, 80, 81, 100, 130] {
                assert_eq!(a.get(x, y, z), b2.get(x, y, z), "{x},{y},{z}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schemas_are_valid() {
        for t in all() {
            let s = schema(t);
            assert_eq!(s["type"], "object");
            for r in t.required {
                assert!(s["properties"].get(*r).is_some(), "{}: required {} not in properties", t.name, r);
            }
        }
    }
}
