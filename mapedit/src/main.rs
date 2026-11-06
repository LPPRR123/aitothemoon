//! mapedit — a real-time Minecraft map editor driven by AI agents over MCP.

mod anvil;
mod blocks;
mod editor;
mod expr;
mod mcp;
mod mesh;
mod noise;
mod ops;
mod raytrace;
mod render;
mod server;
mod spec;
mod tools;
mod world;
mod zones;

use serde_json::{json, Value};
use std::sync::Arc;

const USAGE: &str = "mapedit — real-time Minecraft map editor for AI agents (MCP)

USAGE:
  mapedit mcp   [--port 8848] [--host 127.0.0.1] [--no-viewer]
        MCP over stdio (for Claude Code / Claude Desktop / any MCP client)
        plus the live 3D viewer at http://localhost:PORT/
  mapedit serve [--port 8848] [--host 127.0.0.1]
        Viewer + MCP over streamable HTTP at http://localhost:PORT/mcp
  mapedit run SCRIPT.json [--out DIR] [--serve] [--port 8848]
        Run a JSON list of {\"tool\": ..., \"args\": {...}} calls. Images are
        written to DIR (default ./run-output). --serve keeps the viewer open.
  mapedit tools
        Print the tool list as Markdown.
  mapedit diff SAVE_A SAVE_B [--dim overworld]
        Compare two saves block by block (e.g. our export vs. the same world
        after Minecraft re-saved it). Properties the game adds are ignored.
";

/// Same block if names match and every property set in `a` has the same value in `b`.
fn same_state(a: &str, b: &str) -> bool {
    let (na, pa) = blocks::split_state(a);
    let (nb, pb) = blocks::split_state(b);
    if na != nb {
        return false;
    }
    pa.iter().all(|(k, v)| pb.iter().any(|(k2, v2)| k2 == k && v2 == v))
}

fn diff(a: &str, b: &str, dim: &str) -> anyhow::Result<bool> {
    let wa = anvil::import(std::path::Path::new(a), dim, "a", None)?;
    let wb = anvil::import(std::path::Path::new(b), dim, "b", None)?;
    println!("A: bounds {:?} y {}..{}  B: bounds {:?} y {}..{}", wa.bounds(), wa.min_y, wa.max_y(), wb.bounds(), wb.min_y, wb.max_y());
    let (x0, z0, x1, z1) = wa.bounds();
    let mut same_cache: std::collections::HashMap<(u16, u16), bool> = Default::default();
    let mut total: u64 = 0;
    let mut bad: u64 = 0;
    let mut pairs: std::collections::HashMap<(String, String), u64> = Default::default();
    let mut example: std::collections::HashMap<(String, String), (i32, i32, i32)> = Default::default();
    for z in z0..z1 {
        for x in x0..x1 {
            for y in wa.min_y..wa.max_y() {
                let (ia, ib) = (wa.get(x, y, z), wb.get(x, y, z));
                if blocks::is_air(ia) && blocks::is_air(ib) {
                    continue;
                }
                total += 1;
                let ok = *same_cache.entry((ia, ib)).or_insert_with(|| ia == ib || same_state(&blocks::name(ia), &blocks::name(ib)));
                if !ok {
                    bad += 1;
                    let k = (blocks::name(ia), blocks::name(ib));
                    example.entry(k.clone()).or_insert((x, y, z));
                    *pairs.entry(k).or_default() += 1;
                }
            }
        }
    }
    println!("compared {total} non-air positions, {bad} differ ({:.4}%)", bad as f64 * 100.0 / total.max(1) as f64);
    let mut v: Vec<_> = pairs.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    for ((ba, bb), n) in v.iter().take(25) {
        let e = example[&(ba.clone(), bb.clone())];
        println!("  {n:>10} × {ba}  →  {bb}   e.g. {},{},{}", e.0, e.1, e.2);
    }
    Ok(bad == 0)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn spawn_server(shared: Arc<mcp::Shared>, port: u16, host: String) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
        if let Err(e) = rt.block_on(server::serve(shared, port, &host)) {
            eprintln!("[mapedit] viewer server error: {e:#}");
        }
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("help");
    let port: u16 = flag(&args, "--port").or_else(|| std::env::var("MAPEDIT_PORT").ok()).and_then(|p| p.parse().ok()).unwrap_or(8848);
    let host = flag(&args, "--host").unwrap_or_else(|| "127.0.0.1".into());
    match cmd {
        "mcp" => {
            let shared = mcp::Shared::new();
            if !has(&args, "--no-viewer") {
                spawn_server(shared.clone(), port, host);
                // give the server a moment to bind so `initialize` can report the URL
                for _ in 0..50 {
                    if shared.port.load(std::sync::atomic::Ordering::Relaxed) != 0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            mcp::run_stdio(shared);
        }
        "serve" => {
            let shared = mcp::Shared::new();
            let h = spawn_server(shared, port, host);
            let _ = h.join();
        }
        "run" => {
            let Some(path) = args.get(1) else {
                eprintln!("{USAGE}");
                std::process::exit(2);
            };
            let src = std::fs::read_to_string(path).unwrap_or_else(|e| {
                eprintln!("cannot read {path}: {e}");
                std::process::exit(2)
            });
            let calls: Vec<Value> = match serde_json::from_str::<Value>(&src) {
                Ok(Value::Array(a)) => a,
                Ok(Value::Object(o)) => o.get("calls").and_then(|c| c.as_array()).cloned().unwrap_or_default(),
                _ => {
                    eprintln!("script must be a JSON array of {{tool, args}}");
                    std::process::exit(2)
                }
            };
            let out = std::path::PathBuf::from(flag(&args, "--out").unwrap_or_else(|| "run-output".into()));
            std::fs::create_dir_all(&out).ok();
            let shared = mcp::Shared::new();
            let serve = has(&args, "--serve");
            let h = if serve { Some(spawn_server(shared.clone(), port, host)) } else { None };
            let t0 = std::time::Instant::now();
            let mut failed = 0;
            for (i, c) in calls.iter().enumerate() {
                let tool = c.get("tool").and_then(|v| v.as_str()).unwrap_or("");
                let a = c.get("args").cloned().unwrap_or(json!({}));
                let t = std::time::Instant::now();
                let r = shared.editor.write().run_tool(tool, &a);
                let ms = t.elapsed().as_millis();
                match r {
                    Ok(tools::Out::Text(s)) => println!("[{:>2}] {tool} ({ms} ms): {s}", i + 1),
                    Ok(tools::Out::Image { png, caption }) => {
                        let f = out.join(format!("{:02}_{tool}.png", i + 1));
                        let _ = std::fs::write(&f, png);
                        println!("[{:>2}] {tool} ({ms} ms): {} -> {}", i + 1, caption, f.display());
                    }
                    Err(e) => {
                        failed += 1;
                        println!("[{:>2}] {tool} ({ms} ms): ERROR {e:#}", i + 1);
                    }
                }
            }
            println!("done: {} calls, {} failed, {:.1}s", calls.len(), failed, t0.elapsed().as_secs_f64());
            if let Some(h) = h {
                eprintln!("[mapedit] viewer still running; Ctrl+C to quit");
                let _ = h.join();
            }
            if failed > 0 {
                std::process::exit(1);
            }
        }
        "diff" => {
            let (Some(a), Some(b)) = (args.get(1), args.get(2)) else {
                eprintln!("{USAGE}");
                std::process::exit(2);
            };
            let dim = flag(&args, "--dim").unwrap_or_else(|| "overworld".into());
            match diff(a, b, &dim) {
                Ok(true) => println!("IDENTICAL"),
                Ok(false) => std::process::exit(1),
                Err(e) => {
                    eprintln!("diff failed: {e:#}");
                    std::process::exit(2);
                }
            }
        }
        "tools" => {
            for t in tools::all() {
                let params: Vec<String> = t.params.iter().map(|p| format!("`{}`", p.0)).collect();
                println!("- **{}** — {} {}", t.name, t.desc, if params.is_empty() { String::new() } else { format!("Params: {}", params.join(", ")) });
            }
        }
        _ => {
            eprintln!("{USAGE}");
        }
    }
}
