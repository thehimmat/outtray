//! Line-delimited JSON over stdio around `outtray_store::Store`, so the
//! TypeScript contract suite can drive the exact command layer the Tauri app
//! calls (ADR-0013). Test and development use only; the app calls `handle`
//! in process.
//!
//! Request:  {"id": 1, "op": "open", "args": {"path": "...", "keyHex": "..."}}
//! Response: {"id": 1, "ok": <value>} or {"id": 1, "error": {"kind": "...", "message": "..."}}
use outtray_store::{handle, open, Store};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let mut store: Option<Store> = None;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    json!({"id": null, "error": {"kind": "protocol", "message": e.to_string()}})
                );
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let op = request.get("op").and_then(Value::as_str).unwrap_or("");
        let args = request.get("args").cloned().unwrap_or(json!({}));
        let result = if op == "open" {
            open(&args).map(|s| {
                store = Some(s);
                Value::Null
            })
        } else if let Some(s) = store.as_mut() {
            let r = handle(s, op, &args);
            if op == "close" {
                store = None;
            }
            r
        } else {
            Err(outtray_store::StoreError::storage("Storage is closed."))
        };
        let response = match result {
            Ok(value) => json!({"id": id, "ok": value}),
            Err(e) => json!({"id": id, "error": {"kind": e.kind, "message": e.message}}),
        };
        let _ = writeln!(stdout, "{response}");
        let _ = stdout.flush();
    }
}
