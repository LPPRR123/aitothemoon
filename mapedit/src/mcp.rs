//! Model Context Protocol (JSON-RPC 2.0) handler, shared by the stdio and
//! streamable-HTTP transports.

use crate::editor::Editor;
use crate::tools::{self, Out};
use base64::Engine;
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

pub struct Shared {
    pub editor: RwLock<Editor>,
    pub events: broadcast::Sender<String>,
    pub port: AtomicU16,
}

impl Shared {
    pub fn new() -> Arc<Shared> {
        let (tx, _) = broadcast::channel(4096);
        Arc::new(Shared { editor: RwLock::new(Editor::new(tx.clone())), events: tx, port: AtomicU16::new(0) })
    }
}

const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

fn ok(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn err(id: &Value, code: i64, msg: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": msg}})
}

pub fn tool_result(r: anyhow::Result<Out>) -> Value {
    match r {
        Ok(Out::Text(t)) => json!({"content": [{"type": "text", "text": t}], "isError": false}),
        Ok(Out::Image { png, caption }) => json!({
            "content": [
                {"type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&png), "mimeType": "image/png"},
                {"type": "text", "text": caption}
            ],
            "isError": false
        }),
        Err(e) => json!({"content": [{"type": "text", "text": format!("error: {e:#}")}], "isError": true}),
    }
}

/// Handle one JSON-RPC message; `None` for notifications.
pub fn handle(shared: &Shared, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let id = match id {
        Some(i) if !i.is_null() => i,
        _ => return None, // notification
    };
    Some(match method {
        "initialize" => {
            let req = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOLS[1]);
            let pv = if PROTOCOLS.contains(&req) { req } else { PROTOCOLS[1] };
            let port = shared.port.load(Ordering::Relaxed);
            let mut instr = tools::INSTRUCTIONS.to_string();
            if port > 0 {
                instr += &format!("\n\nLive 3D viewer for the user: http://localhost:{port}/");
            }
            ok(
                &id,
                json!({
                    "protocolVersion": pv,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "mapedit", "title": "mapedit · real-time Minecraft map editor", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": instr
                }),
            )
        }
        "ping" => ok(&id, json!({})),
        "tools/list" => {
            let list: Vec<Value> = tools::all()
                .iter()
                .map(|t| {
                    let mut v = json!({"name": t.name, "description": t.desc, "inputSchema": tools::schema(t)});
                    if t.kind == tools::Kind::Read {
                        v["annotations"] = json!({"readOnlyHint": true});
                    }
                    v
                })
                .collect();
            ok(&id, json!({"tools": list}))
        }
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if tools::find(name).is_none() {
                return Some(err(&id, -32602, &format!("unknown tool '{name}'")));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let r = shared.editor.write().run_tool(name, &args);
            ok(&id, tool_result(r))
        }
        "resources/list" => ok(&id, json!({"resources": []})),
        "resources/templates/list" => ok(&id, json!({"resourceTemplates": []})),
        "prompts/list" => ok(&id, json!({"prompts": []})),
        "logging/setLevel" => ok(&id, json!({})),
        _ => err(&id, -32601, &format!("method not found: {method}")),
    })
}

/// Handle a message or a batch array.
pub fn handle_any(shared: &Shared, v: &Value) -> Option<Value> {
    match v {
        Value::Array(items) => {
            let out: Vec<Value> = items.iter().filter_map(|m| handle(shared, m)).collect();
            if out.is_empty() {
                None
            } else {
                Some(Value::Array(out))
            }
        }
        _ => handle(shared, v),
    }
}

/// Blocking stdio loop (newline-delimited JSON-RPC). Logs go to stderr.
pub fn run_stdio(shared: Arc<Shared>) {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Value>(line) {
            Ok(v) => handle_any(&shared, &v),
            Err(e) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
        };
        if let Some(r) = resp {
            let _ = writeln!(stdout, "{}", r);
            let _ = stdout.flush();
        }
    }
}
