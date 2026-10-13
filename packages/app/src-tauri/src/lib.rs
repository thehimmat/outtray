//! The Outtray desktop shell (ADR-0001, ADR-0013).
//!
//! Core runs in the webview. This side holds only what the webview cannot:
//! the encrypted store (`outtray-store`, held to the shared contract suite),
//! the database key in the macOS Keychain, and read-only file access (list a
//! folder, read a file). The page only asks for the folder the user picked;
//! enforcing that on this side is #123. There is no command that writes,
//! moves or deletes a document: the agent proposes, the human acts (ADR-0008).
//!
//! The store and key are the CLI's: same file under
//! `~/Library/Application Support/outtray/`, same Keychain item, so the app
//! and the CLI see one store.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Response;

/// The Keychain item the CLI also uses (`KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT` in core).
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "outtray";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "database-key";

/// The open store, if any.
#[derive(Default)]
struct StoreState(Mutex<Option<outtray_store::Store>>);

fn error(kind: &str, message: impl Into<String>) -> Value {
    json!({ "kind": kind, "message": message.into() })
}

/// `~/Library/Application Support/outtray`, the CLI's data directory
/// (`appDataDir` in core). macOS only, as ADR-0011 decided.
fn data_dir() -> Result<PathBuf, Value> {
    if !cfg!(target_os = "macos") {
        return Err(error(
            "storage",
            "Outtray stores its data under macOS Application Support; this platform is not supported (ADR-0011).",
        ));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| error("storage", "HOME is not set."))?;
    Ok(PathBuf::from(home).join("Library/Application Support/outtray"))
}

/// Create the data directory owner-only, as `ensureAppDataDir` does.
fn ensure_dir(dir: &PathBuf) -> Result<(), Value> {
    std::fs::create_dir_all(dir).map_err(|e| error("storage", e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| error("storage", e.to_string()))?;
    }
    Ok(())
}

/// The database key as hex: read from the Keychain, or created there on first
/// run. A missing key with an existing database is refused, never replaced,
/// because a new key could not open the old file (the CLI's rule).
#[cfg(target_os = "macos")]
fn database_key(database_exists: bool) -> Result<String, Value> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => {
            String::from_utf8(bytes).map_err(|_| error("key", "The Keychain item is not hex."))
        }
        Err(e) if e.code() == -25300 => {
            if database_exists {
                return Err(error(
                    "key",
                    "A database exists but its key is not in the Keychain, so nothing can decrypt it. Outtray will not overwrite it. The store is a derived cache and your documents are untouched: delete the file and re-scan.",
                ));
            }
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).map_err(|e| error("key", e.to_string()))?;
            let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
            // A native call: the key never appears in a process argument list (#82).
            set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, hex.as_bytes())
                .map_err(|e| error("key", e.to_string()))?;
            Ok(hex)
        }
        Err(e) => Err(error("key", format!("The Keychain refused: {e}"))),
    }
}

#[cfg(not(target_os = "macos"))]
fn database_key(_database_exists: bool) -> Result<String, Value> {
    Err(error(
        "key",
        "The database key lives in the macOS Keychain; this platform is not supported.",
    ))
}

/// Open the store the CLI also uses. Ignores any path or key the webview
/// sends: both come from this side, so the key never reaches JavaScript.
#[tauri::command]
fn store_open(state: tauri::State<StoreState>) -> Result<(), Value> {
    let dir = data_dir()?;
    ensure_dir(&dir)?;
    let path = dir.join("outtray.db");
    let exists = std::fs::metadata(&path)
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    let key = database_key(exists)?;
    let store = outtray_store::open(&json!({ "path": path.to_string_lossy(), "keyHex": key }))
        .map_err(|e| error(e.kind, e.message))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    *state
        .0
        .lock()
        .map_err(|_| error("storage", "The store lock is poisoned."))? = Some(store);
    Ok(())
}

/// One `StorageProvider` command (`CommandStorage` in core).
#[tauri::command]
fn store_command(state: tauri::State<StoreState>, op: String, args: Value) -> Result<Value, Value> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| error("storage", "The store lock is poisoned."))?;
    let store = guard
        .as_mut()
        .ok_or_else(|| error("storage", "Storage is closed."))?;
    let result = outtray_store::handle(store, &op, &args).map_err(|e| error(e.kind, e.message));
    if op == "close" {
        *guard = None;
    }
    result
}

/// The regular files directly in `folder`. Read-only.
#[tauri::command]
fn list_folder(folder: String) -> Result<Vec<String>, Value> {
    let entries = std::fs::read_dir(&folder)
        .map_err(|e| error("storage", format!("Cannot read {folder}: {e}")))?;
    Ok(entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect())
}

/// The bytes of one file, as raw IPC (no JSON number arrays). Read-only.
#[tauri::command]
fn read_file(path: String) -> Result<Response, Value> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| error("storage", format!("Cannot read {path}: {e}")))
}

/// The identifier-storage opt-in from `config.json` beside the store, read
/// the way `readSettings` reads it: only a literal true turns it on.
#[tauri::command]
fn read_settings() -> Value {
    let on = data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("config.json")).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("identifierStorage").and_then(Value::as_bool))
        .unwrap_or(false);
    json!({ "identifierStorage": on })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(StoreState::default())
        .invoke_handler(tauri::generate_handler![
            store_open,
            store_command,
            list_folder,
            read_file,
            read_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Outtray shell");
}
