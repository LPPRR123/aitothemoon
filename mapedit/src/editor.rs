//! Editor session: worlds, undo/redo history, schematic library, events.

use crate::ops::structures::Schematic;
use crate::tools::{self, Kind, Out};
use crate::world::{Snapshot, World};
use crate::zones::Zones;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::broadcast;

/// Undo history limits: entry count and total snapshot memory.
pub const MAX_HISTORY: usize = 500;
pub const MAX_HISTORY_BYTES: usize = 2 << 30;

pub struct HistoryEntry {
    pub id: u64,
    pub tool: String,
    pub args: Value,
    pub summary: String,
    pub world: String,
    pub ms: u64,
    pub snap: Snapshot,
    pub zones: Option<Zones>,
}

pub struct Editor {
    pub worlds: Vec<World>,
    pub current: usize,
    pub history: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
    pub schematics: HashMap<String, Schematic>,
    pub events: broadcast::Sender<String>,
    pub next_id: u64,
    pub calls: u64,
    pub data_version: i32,
    pub version_name: String,
    pub workdir: std::path::PathBuf,
}

impl Editor {
    pub fn new(events: broadcast::Sender<String>) -> Self {
        Editor {
            worlds: vec![],
            current: 0,
            history: vec![],
            redo: vec![],
            schematics: HashMap::new(),
            events,
            next_id: 1,
            calls: 0,
            data_version: crate::anvil::DEFAULT_DATA_VERSION,
            version_name: crate::anvil::DEFAULT_VERSION_NAME.into(),
            workdir: std::env::current_dir().unwrap_or_default(),
        }
    }

    pub fn emit(&self, v: Value) {
        let _ = self.events.send(v.to_string());
    }

    pub fn world_index(&self, args: &Value) -> Result<usize> {
        if self.worlds.is_empty() {
            bail!("no world yet: call world_create first (e.g. world_create name=main size=1024)");
        }
        match args.get("world").and_then(|v| v.as_str()) {
            Some(n) if !n.is_empty() => self.worlds.iter().position(|w| w.name == n).ok_or_else(|| {
                anyhow!("unknown world '{n}'. Worlds: {}", self.worlds.iter().map(|w| w.name.as_str()).collect::<Vec<_>>().join(", "))
            }),
            _ => Ok(self.current.min(self.worlds.len() - 1)),
        }
    }

    pub fn world(&self, args: &Value) -> Result<&World> {
        let i = self.world_index(args)?;
        Ok(&self.worlds[i])
    }

    pub fn world_mut(&mut self, args: &Value) -> Result<&mut World> {
        let i = self.world_index(args)?;
        Ok(&mut self.worlds[i])
    }

    pub fn resolve_path(&self, p: &str) -> std::path::PathBuf {
        let p = if let Some(rest) = p.strip_prefix("~/") {
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest)
        } else {
            std::path::PathBuf::from(p)
        };
        if p.is_absolute() {
            p
        } else {
            self.workdir.join(p)
        }
    }

    /// Run a tool by name with journaling, history and events.
    pub fn run_tool(&mut self, name: &str, args: &Value) -> Result<Out> {
        let tool = tools::find(name).ok_or_else(|| anyhow!("unknown tool '{name}'"))?;
        self.calls += 1;
        let t0 = Instant::now();
        let res = match tool.kind {
            Kind::Edit => {
                let wi = self.world_index(args)?;
                let zones_before = self.worlds[wi].zones.clone();
                self.worlds[wi].begin_journal();
                let r = (tool.run)(self, args);
                let snap = self.worlds[wi].end_journal();
                match r {
                    Ok(out) => {
                        let zones_changed = serde_json::to_string(&zones_before).ok() != serde_json::to_string(&self.worlds[wi].zones).ok();
                        let entry = HistoryEntry {
                            id: self.next_id,
                            tool: name.to_string(),
                            args: args.clone(),
                            summary: out.summary(),
                            world: self.worlds[wi].name.clone(),
                            ms: t0.elapsed().as_millis() as u64,
                            snap,
                            zones: if zones_changed { Some(zones_before) } else { None },
                        };
                        self.next_id += 1;
                        self.emit(json!({"type": "log", "entry": entry_json(&entry)}));
                        if zones_changed {
                            self.emit(json!({"type": "zones", "world": entry.world}));
                        }
                        self.history.push(entry);
                        self.redo.clear();
                        self.trim_history();
                        Ok(out)
                    }
                    Err(e) => {
                        // roll back partial edits
                        self.worlds[wi].restore(snap);
                        Err(e)
                    }
                }
            }
            Kind::Read | Kind::Session => (tool.run)(self, args),
        };
        self.flush_dirty();
        let ms = t0.elapsed().as_millis() as u64;
        self.emit(json!({"type": "call", "tool": name, "ok": res.is_ok(), "ms": ms, "calls": self.calls}));
        res
    }

    fn trim_history(&mut self) {
        let size = |e: &HistoryEntry| e.snap.values().map(|c| c.memory()).sum::<usize>();
        let mut total: usize = self.history.iter().map(size).sum();
        while self.history.len() > 1 && (self.history.len() > MAX_HISTORY || total > MAX_HISTORY_BYTES) {
            total -= size(&self.history[0]);
            self.history.remove(0);
        }
    }

    pub fn flush_dirty(&self) {
        for w in &self.worlds {
            let d = w.take_dirty();
            if d.is_empty() {
                continue;
            }
            let chunks: Value = if d.len() > 4000 {
                json!("all")
            } else {
                Value::Array(d.iter().map(|&i| {
                    let (cx, cz) = w.chunk_pos(i);
                    json!([cx, cz])
                }).collect())
            };
            self.emit(json!({"type": "dirty", "world": w.name, "chunks": chunks}));
        }
    }

    fn swap(&mut self, mut e: HistoryEntry) -> Result<HistoryEntry> {
        let wi = self.worlds.iter().position(|w| w.name == e.world).ok_or_else(|| anyhow!("world '{}' no longer exists", e.world))?;
        let prev = self.worlds[wi].restore(std::mem::take(&mut e.snap));
        e.snap = prev;
        if let Some(z) = e.zones.take() {
            e.zones = Some(std::mem::replace(&mut self.worlds[wi].zones, z));
            self.emit(json!({"type": "zones", "world": e.world}));
        }
        self.flush_dirty();
        Ok(e)
    }

    pub fn undo(&mut self, steps: usize) -> Result<String> {
        let mut done = vec![];
        for _ in 0..steps.max(1) {
            let Some(e) = self.history.pop() else { break };
            let e = self.swap(e)?;
            done.push(format!("{} ({})", e.tool, e.summary));
            self.redo.push(e);
        }
        if done.is_empty() {
            bail!("nothing to undo");
        }
        self.emit(json!({"type": "history"}));
        Ok(format!("undid {}: {}", done.len(), done.join("; ")))
    }

    pub fn redo(&mut self, steps: usize) -> Result<String> {
        let mut done = vec![];
        for _ in 0..steps.max(1) {
            let Some(e) = self.redo.pop() else { break };
            let e = self.swap(e)?;
            done.push(e.tool.clone());
            self.history.push(e);
        }
        if done.is_empty() {
            bail!("nothing to redo");
        }
        self.emit(json!({"type": "history"}));
        Ok(format!("redid {}: {}", done.len(), done.join("; ")))
    }

    pub fn history_json(&self) -> Value {
        json!({
            "entries": self.history.iter().map(entry_json).collect::<Vec<_>>(),
            "redo": self.redo.len(),
        })
    }
}

pub fn entry_json(e: &HistoryEntry) -> Value {
    json!({"id": e.id, "tool": e.tool, "args": e.args, "summary": e.summary, "world": e.world, "ms": e.ms, "chunks": e.snap.len()})
}
