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
";

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
