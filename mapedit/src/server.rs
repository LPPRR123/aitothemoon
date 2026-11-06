//! HTTP server: web viewer, binary mesh API, websocket events, and MCP over
//! streamable HTTP at /mcp.

use crate::mcp::{self, Shared};
use crate::mesh;
use crate::render;
use crate::tools::Out;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

const INDEX: &str = include_str!("../web/index.html");
const APP: &str = include_str!("../web/app.js");
const THREE: &str = include_str!("../web/vendor/three.module.min.js");
const ORBIT: &str = include_str!("../web/vendor/OrbitControls.js");

type S = State<Arc<Shared>>;
type Q = Query<HashMap<String, String>>;

fn js(s: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "application/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], s).into_response()
}

fn bin(b: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")], b).into_response()
}

fn bad(msg: impl ToString) -> Response {
    (StatusCode::BAD_REQUEST, msg.to_string()).into_response()
}

async fn blocking<F, T>(f: F) -> T
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f).await.expect("blocking task panicked")
}

pub fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/", get(|| async { Html(INDEX) }))
        .route("/app.js", get(|| async { js(APP) }))
        .route("/vendor/three.module.min.js", get(|| async { js(THREE) }))
        .route("/vendor/OrbitControls.js", get(|| async { js(ORBIT) }))
        .route("/api/state", get(state))
        .route("/api/overview", get(overview))
        .route("/api/chunk", get(chunk))
        .route("/api/probe", get(probe))
        .route("/api/map.png", get(map_png))
        .route("/api/tool", post(tool))
        .route("/ws", get(ws))
        .route("/mcp", post(mcp_post).get(|| async { StatusCode::METHOD_NOT_ALLOWED }).delete(|| async { StatusCode::OK }))
        .with_state(shared)
}

async fn state(State(sh): S) -> Response {
    let v = blocking(move || {
        let ed = sh.editor.read();
        let worlds: Vec<Value> = ed
            .worlds
            .iter()
            .map(|w| {
                let (x0, z0, x1, z1) = w.bounds();
                let zones: Vec<Value> = w
                    .zones
                    .zones
                    .iter()
                    .enumerate()
                    .map(|(i, z)| json!({"id": z.id, "name": z.name, "kind": z.kind, "cx": z.cx, "cz": z.cz, "biome": z.biome, "polygon": w.zones.polygon(i)}))
                    .collect();
                json!({
                    "name": w.name, "dimension": w.dimension, "bounds": [x0, z0, x1, z1], "min_y": w.min_y, "max_y": w.max_y(),
                    "zones": zones, "gates": w.zones.gates, "rings": w.zones.rings,
                })
            })
            .collect();
        json!({"worlds": worlds, "current": ed.current, "history": ed.history_json(), "calls": ed.calls, "port": sh.port.load(Ordering::Relaxed)})
    })
    .await;
    Json(v).into_response()
}

fn world_idx(ed: &crate::editor::Editor, q: &HashMap<String, String>) -> Option<usize> {
    match q.get("world") {
        Some(n) => ed.worlds.iter().position(|w| &w.name == n),
        None => (!ed.worlds.is_empty()).then_some(ed.current),
    }
}

async fn overview(State(sh): S, Query(q): Q) -> Response {
    blocking(move || {
        let ed = sh.editor.read();
        let Some(i) = world_idx(&ed, &q) else { return bad("no world") };
        let w = &ed.worlds[i];
        let (sx, sz) = w.size();
        let auto = ((sx.max(sz) as f64) / 640.0).ceil().max(1.0) as i32;
        let step = q.get("step").and_then(|s| s.parse().ok()).unwrap_or(auto);
        bin(mesh::overview(w, step))
    })
    .await
}

async fn chunk(State(sh): S, Query(q): Q) -> Response {
    blocking(move || {
        let ed = sh.editor.read();
        let Some(i) = world_idx(&ed, &q) else { return bad("no world") };
        let cx: i32 = q.get("cx").and_then(|s| s.parse().ok()).unwrap_or(0);
        let cz: i32 = q.get("cz").and_then(|s| s.parse().ok()).unwrap_or(0);
        bin(mesh::chunk_mesh(&ed.worlds[i], cx, cz))
    })
    .await
}

async fn probe(State(sh): S, Query(q): Q) -> Response {
    blocking(move || {
        let ed = sh.editor.read();
        let Some(i) = world_idx(&ed, &q) else { return bad("no world") };
        let w = &ed.worlds[i];
        let x: i32 = q.get("x").and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0).floor() as i32;
        let z: i32 = q.get("z").and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0).floor() as i32;
        let infos = crate::blocks::infos();
        let top = w.top(x, z, &infos);
        let block = top.map(|t| crate::blocks::name(w.get(x, t, z)));
        let zone = w.zones.zone_at(x as f64 + 0.5, z as f64 + 0.5).map(|i| {
            let zn = &w.zones.zones[i];
            json!({"id": zn.id, "name": zn.name, "kind": zn.kind})
        });
        Json(json!({"x": x, "z": z, "y": top, "block": block, "zone": zone, "biome": crate::world::biome_name(w.biome(x, z)), "chunk": [x.div_euclid(16), z.div_euclid(16)]})).into_response()
    })
    .await
}

async fn map_png(State(sh): S, Query(q): Q) -> Response {
    blocking(move || {
        let ed = sh.editor.read();
        let Some(i) = world_idx(&ed, &q) else { return bad("no world") };
        let w = &ed.worlds[i];
        let o = render::MapOpts {
            size: q.get("size").and_then(|s| s.parse().ok()).unwrap_or(512),
            mode: q.get("mode").cloned().unwrap_or("shaded".into()),
            zones: q.get("zones").map(|s| s != "0").unwrap_or(true),
            labels: true,
            grid: 0,
        };
        match render::render_map(w, w.bounds(), &o) {
            Ok((png, _)) => ([(header::CONTENT_TYPE, "image/png")], png).into_response(),
            Err(e) => bad(e),
        }
    })
    .await
}

/// Call any tool from the viewer UI (undo/redo/export/...).
async fn tool(State(sh): S, Json(body): Json<Value>) -> Response {
    let r = blocking(move || {
        let name = body.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let args = body.get("args").cloned().unwrap_or(json!({}));
        let r = sh.editor.write().run_tool(&name, &args);
        match r {
            Ok(Out::Text(t)) => json!({"ok": true, "text": t}),
            Ok(Out::Image { png, caption }) => json!({"ok": true, "text": caption, "image": base64::engine::general_purpose::STANDARD.encode(png)}),
            Err(e) => json!({"ok": false, "text": format!("{e:#}")}),
        }
    })
    .await;
    Json(r).into_response()
}

async fn ws(State(sh): S, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| ws_loop(socket, sh))
}

async fn ws_loop(mut socket: WebSocket, sh: Arc<Shared>) {
    let mut rx = sh.events.subscribe();
    let _ = socket.send(Message::Text(json!({"type": "hello"}).to_string().into())).await;
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(s) => {
                    if socket.send(Message::Text(s.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = socket.send(Message::Text(json!({"type": "resync"}).to_string().into())).await;
                }
                Err(_) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

async fn mcp_post(State(sh): S, headers: HeaderMap, body: Bytes) -> Response {
    let _ = headers;
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}}))).into_response(),
    };
    let r = blocking(move || mcp::handle_any(&sh, &v)).await;
    match r {
        Some(resp) => ([(header::CONTENT_TYPE, "application/json")], resp.to_string()).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Bind on `port` (or the next free one) and serve forever. Returns the bound port via `shared.port`.
pub async fn serve(shared: Arc<Shared>, port: u16, host: &str) -> anyhow::Result<()> {
    let mut last_err = None;
    for p in port..port.saturating_add(20) {
        match tokio::net::TcpListener::bind((host, p)).await {
            Ok(l) => {
                shared.port.store(p, Ordering::Relaxed);
                eprintln!("[mapedit] viewer: http://localhost:{p}/   MCP (HTTP): http://localhost:{p}/mcp");
                axum::serve(l, router(shared)).await?;
                return Ok(());
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(anyhow::anyhow!("could not bind a port near {port}: {:?}", last_err))
}
