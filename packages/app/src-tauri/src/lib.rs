//! The Outtray desktop shell (ADR-0001, ADR-0013).
//!
//! Core runs in the webview. This side holds only what the webview cannot:
//! the encrypted store (`outtray-store`, held to the shared contract suite),
//! the database key in the macOS Keychain, the native folder picker, and
//! read-only access to the folders the user picked there and nothing else
//! (`folder_scope`, #123). There is no command that writes, moves or deletes
//! a document: the agent proposes, the human acts (ADR-0008).
//!
//! The page can write and purge remembered ID numbers but never read one: the
//! store bridge refuses `getIdentifier`, and a number is revealed only by
//! `reveal_identifier`, in a native dialog (ADR-0013 amendment 1).
//!
//! The store and key are the CLI's: same file under
//! `~/Library/Application Support/outtray/`, same Keychain item, so the app
//! and the CLI see one store.

mod folder_scope;

use folder_scope::FolderScope;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The Keychain item the CLI also uses (`KEYCHAIN_SERVICE`, `KEYCHAIN_ACCOUNT` in core).
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "outtray";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "database-key";

/// Store operations the page may not run (ADR-0013 amendment 1). The page
/// renders text extracted from documents, so it must not be able to read a
/// remembered ID number; it can still write and purge them.
const PAGE_DENIED_OPS: &[&str] = &["getIdentifier"];

/// The extraction fields that hold an ID number (`IDENTIFIER_FIELDS` in core).
const IDENTIFIER_FIELDS: &[&str] = &["id_number", "policy_number", "account_number"];

fn page_may_run(op: &str) -> bool {
    !PAGE_DENIED_OPS.contains(&op)
}

/// `config.json` as core's `writeSettings` writes it.
fn settings_json(identifier_storage: bool) -> String {
    let body = serde_json::to_string_pretty(&json!({ "identifierStorage": identifier_storage }))
        .unwrap_or_default();
    format!("{body}\n")
}

/// The open store, if any.
#[derive(Default)]
struct StoreState(Mutex<Option<outtray_store::Store>>);

/// The folders the user picked, the only ones the page may read.
#[derive(Default)]
struct ScopeState(Mutex<FolderScope>);

fn scope_error(message: String) -> Value {
    error("storage", message)
}

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

/// The store file, and whether it already holds a database.
fn database_path() -> Result<(PathBuf, bool), Value> {
    let path = data_dir()?.join("outtray.db");
    let exists = std::fs::metadata(&path)
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    Ok((path, exists))
}

/// Open the store the CLI also uses, creating it on first run.
fn open_store() -> Result<outtray_store::Store, Value> {
    ensure_dir(&data_dir()?)?;
    let (path, exists) = database_path()?;
    let key = database_key(exists)?;
    let store = outtray_store::open(&json!({ "path": path.to_string_lossy(), "keyHex": key }))
        .map_err(|e| error(e.kind, e.message))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(store)
}

/// Run one store operation on the open store, or on one opened (and closed
/// again) for just this call.
fn with_store(state: &StoreState, op: &str, args: &Value) -> Result<Value, Value> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| error("storage", "The store lock is poisoned."))?;
    if let Some(store) = guard.as_mut() {
        return outtray_store::handle(store, op, args).map_err(|e| error(e.kind, e.message));
    }
    let mut store = open_store()?;
    let result = outtray_store::handle(&mut store, op, args).map_err(|e| error(e.kind, e.message));
    let _ = outtray_store::handle(&mut store, "close", &json!({}));
    result
}

/// Open the store the CLI also uses. Ignores any path or key the webview
/// sends: both come from this side, so the key never reaches JavaScript.
#[tauri::command]
fn store_open(state: tauri::State<StoreState>) -> Result<(), Value> {
    let store = open_store()?;
    *state
        .0
        .lock()
        .map_err(|_| error("storage", "The store lock is poisoned."))? = Some(store);
    Ok(())
}

/// One `StorageProvider` command (`CommandStorage` in core).
#[tauri::command]
fn store_command(state: tauri::State<StoreState>, op: String, args: Value) -> Result<Value, Value> {
    if !page_may_run(&op) {
        return Err(error(
            "denied",
            format!("The page may not run {op}; a number is revealed only in its own window."),
        ));
    }
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

/// Show the native folder picker and allow the chosen folder. Resolves its
/// resolved path, or null when the user cancels. The picker is the only way a
/// folder becomes readable, so the page cannot widen its own access.
#[tauri::command]
async fn pick_folder(
    app: tauri::AppHandle,
    scope: tauri::State<'_, ScopeState>,
) -> Result<Option<String>, Value> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a folder of documents")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| error("storage", e.to_string()))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| error("storage", e.to_string()))?;
    let resolved = scope
        .0
        .lock()
        .map_err(|_| error("storage", "The folder scope lock is poisoned."))?
        .allow(&path)
        .map_err(scope_error)?;
    Ok(Some(resolved.to_string_lossy().into_owned()))
}

/// The regular files directly in a picked folder. Read-only.
#[tauri::command]
fn list_folder(scope: tauri::State<ScopeState>, folder: String) -> Result<Vec<String>, Value> {
    let folder = scope
        .0
        .lock()
        .map_err(|_| error("storage", "The folder scope lock is poisoned."))?
        .folder(Path::new(&folder))
        .map_err(scope_error)?;
    let entries = std::fs::read_dir(&folder)
        .map_err(|e| error("storage", format!("Cannot read {}: {e}", folder.display())))?;
    Ok(entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect())
}

/// The bytes of one file directly in a picked folder, as raw IPC (no JSON
/// number arrays). Read-only.
#[tauri::command]
fn read_file(scope: tauri::State<ScopeState>, path: String) -> Result<Response, Value> {
    let path = scope
        .0
        .lock()
        .map_err(|_| error("storage", "The folder scope lock is poisoned."))?
        .file(Path::new(&path))
        .map_err(scope_error)?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| error("storage", format!("Cannot read {}: {e}", path.display())))
}

/// The identifier-storage opt-in from `config.json` beside the store, read
/// the way `readSettings` reads it: only a literal true turns it on.
fn current_identifier_storage() -> bool {
    data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("config.json")).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("identifierStorage").and_then(Value::as_bool))
        .unwrap_or(false)
}

#[tauri::command]
fn read_settings() -> Value {
    json!({ "identifierStorage": current_identifier_storage() })
}

/// What the native confirmation says before remembering ID numbers is turned
/// on. The page shows the full disclosure; this gate is here so a page that
/// misbehaves still cannot turn it on without the person agreeing.
const TURN_ON_CONFIRMATION: &str = "Remember ID numbers?\n\nEach passport, policy or account number Outtray reads from now on is kept in full, once, in the encrypted database on this Mac, and shown only when you reveal it. Turning this off later deletes them.";

/// Turn remembering ID numbers on or off, written the way core's
/// `writeSettings` writes it (owner-only, through a rename). On asks first in
/// a native dialog and changes nothing if the person declines. Off deletes
/// every remembered number, but only when a database exists, so turning it
/// off never creates a store or a Keychain key. Resolves the setting as it now
/// stands and how many numbers were deleted.
#[tauri::command]
async fn write_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreState>,
    identifier_storage: bool,
) -> Result<Value, Value> {
    if identifier_storage {
        let agreed = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .message(TURN_ON_CONFIRMATION)
                .title("Outtray")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Remember them".into(),
                    "Cancel".into(),
                ))
                .blocking_show()
        })
        .await
        .map_err(|e| error("storage", e.to_string()))?;
        if !agreed {
            return Ok(json!({ "identifierStorage": current_identifier_storage(), "purged": 0 }));
        }
    }
    let dir = data_dir()?;
    ensure_dir(&dir)?;
    let temp = dir.join(format!(".config.json.{}.tmp", std::process::id()));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|e| error("storage", format!("Cannot write settings: {e}")))?;
        file.write_all(settings_json(identifier_storage).as_bytes())
            .map_err(|e| error("storage", format!("Cannot write settings: {e}")))?;
    }
    std::fs::rename(&temp, dir.join("config.json"))
        .map_err(|e| error("storage", format!("Cannot write settings: {e}")))?;
    let (_, exists) = database_path()?;
    let purged = if identifier_storage || !exists {
        json!(0)
    } else {
        with_store(&state, "purgeIdentifiers", &json!({}))?
    };
    Ok(json!({ "identifierStorage": identifier_storage, "purged": purged }))
}

/// Show one remembered ID number in a native dialog (ADR-0013 amendment 1).
/// The number stays on this side: the page learns only `shown` or
/// `not_stored`. `label` names the document in the dialog.
#[tauri::command]
async fn reveal_identifier(
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreState>,
    document_hash: String,
    field: String,
    label: String,
) -> Result<Value, Value> {
    if !IDENTIFIER_FIELDS.contains(&field.as_str()) {
        return Err(error(
            "storage",
            format!("{field} is not an ID number field."),
        ));
    }
    let (_, exists) = database_path()?;
    if !exists {
        return Ok(json!({ "status": "not_stored" }));
    }
    let value = with_store(
        &state,
        "getIdentifier",
        &json!({ "documentHash": document_hash, "field": field }),
    )?;
    let Some(number) = value.as_str().map(str::to_owned) else {
        return Ok(json!({ "status": "not_stored" }));
    };
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(format!("{label}\n\n{number}"))
            .title("ID number")
            .kind(MessageDialogKind::Info)
            .blocking_show();
    })
    .await
    .map_err(|e| error("storage", e.to_string()))?;
    Ok(json!({ "status": "shown" }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(StoreState::default())
        .manage(ScopeState::default())
        .invoke_handler(tauri::generate_handler![
            store_open,
            store_command,
            pick_folder,
            list_folder,
            read_file,
            read_settings,
            write_settings,
            reveal_identifier
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Outtray shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_cannot_read_a_remembered_number() {
        assert!(!page_may_run("getIdentifier"));
    }

    #[test]
    fn the_page_can_still_write_purge_and_count_them() {
        for op in [
            "putIdentifiers",
            "purgeIdentifiers",
            "countIdentifiers",
            "identifierFields",
            "listDocuments",
            "close",
        ] {
            assert!(page_may_run(op), "{op}");
        }
    }

    #[test]
    fn settings_are_written_as_core_writes_them() {
        assert_eq!(settings_json(true), "{\n  \"identifierStorage\": true\n}\n");
        assert_eq!(
            settings_json(false),
            "{\n  \"identifierStorage\": false\n}\n"
        );
    }
}
