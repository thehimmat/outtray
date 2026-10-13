//! The desktop app's encrypted store (ADR-0011, ADR-0013).
//!
//! Core runs in the Tauri webview and reaches storage through
//! `CommandStorage`, which sends one JSON command per `StorageProvider`
//! method. This crate executes those commands against the same SQLCipher file
//! format the Node adapter writes (proven interoperable in #114), with the
//! same schema: the migration list is `packages/core/src/migrations.json`,
//! embedded at build time, so the two stores cannot drift.
//!
//! Validation that both stores share (chunk batches, identifier keys, label
//! provenance) runs in `CommandStorage` before a command is sent, exactly as
//! it runs in the TypeScript stores. This side enforces what the database
//! enforces: documents must exist, foreign keys cascade, and every write is
//! one transaction. The shared contract suite holds both sides to one
//! behaviour.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};

const MIGRATIONS_JSON: &str = include_str!("../../../core/src/migrations.json");
const PAGE_SIZE: u64 = 4096;
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// A command failure, as `CommandStorage` maps it back to an error class.
#[derive(Debug)]
pub struct StoreError {
    /// `storage` (StorageError), `corrupt` (StorageCorruptError), `key`
    /// (DatabaseKeyError), `format` (StorageFormatError), `migration`
    /// (StorageMigrationError) or `protocol` (a malformed command).
    pub kind: &'static str,
    pub message: String,
}

impl StoreError {
    pub fn storage(message: impl Into<String>) -> Self {
        Self {
            kind: "storage",
            message: message.into(),
        }
    }
    fn protocol(message: impl Into<String>) -> Self {
        Self {
            kind: "protocol",
            message: message.into(),
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        let corrupt = matches!(
            e.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseCorrupt) | Some(rusqlite::ErrorCode::NotADatabase)
        );
        Self {
            kind: if corrupt { "corrupt" } else { "storage" },
            message: e.to_string(),
        }
    }
}

type Result<T> = std::result::Result<T, StoreError>;

/// An open store.
pub struct Store {
    conn: Connection,
}

fn arg<'a>(args: &'a Value, name: &str) -> Result<&'a Value> {
    args.get(name)
        .ok_or_else(|| StoreError::protocol(format!("missing argument {name}")))
}

fn str_arg<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    arg(args, name)?
        .as_str()
        .ok_or_else(|| StoreError::protocol(format!("{name} must be a string")))
}

fn opt_str(v: &Value, name: &str) -> Option<String> {
    v.get(name).and_then(Value::as_str).map(str::to_owned)
}

fn encode_embedding(v: &Value) -> Result<Vec<u8>> {
    let items = v
        .as_array()
        .ok_or_else(|| StoreError::protocol("embedding must be an array"))?;
    let mut out = Vec::with_capacity(items.len() * 4);
    for (i, x) in items.iter().enumerate() {
        let f = x.as_f64().filter(|f| f.is_finite()).ok_or_else(|| {
            StoreError::storage(format!("Embedding component {i} is not finite: {x}."))
        })?;
        out.extend_from_slice(&(f as f32).to_le_bytes());
    }
    Ok(out)
}

fn decode_embedding(bytes: &[u8]) -> Result<Value> {
    if bytes.len() % 4 != 0 {
        return Err(StoreError {
            kind: "migration",
            message: "embedding BLOB is not float32".into(),
        });
    }
    Ok(Value::Array(
        bytes
            .chunks_exact(4)
            .map(|c| json!(f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64))
            .collect(),
    ))
}

fn json_text(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(other) => Some(other.to_string()),
    }
}

fn parse_json(text: Option<String>, what: &str) -> Result<Value> {
    match text {
        None => Ok(Value::Null),
        Some(t) => serde_json::from_str(&t)
            .map_err(|e| StoreError::storage(format!("Stored {what} is not valid JSON: {e}."))),
    }
}

/// Open (or create) the store. `args`: `{ "path": string, "keyHex": 64 hex chars }`.
///
/// Failure modes: `corrupt` when the file is not a whole number of pages;
/// `format` when it is a plaintext SQLite file; `key` when the key does not
/// open it; `migration` when its schema is newer than this build.
pub fn open(args: &Value) -> Result<Store> {
    let path = str_arg(args, "path")?;
    let key = str_arg(args, "keyHex")?;
    if key.len() != 64 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(StoreError {
            kind: "key",
            message: "A database key must be 32 bytes of hex.".into(),
        });
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > 0 {
            let head = std::fs::read(path)
                .map(|b| b.into_iter().take(16).collect::<Vec<_>>())
                .unwrap_or_default();
            if head == SQLITE_MAGIC {
                return Err(StoreError {
                    kind: "format",
                    message: "The database file is not encrypted: it begins with the plaintext SQLite magic string.".into(),
                });
            }
        }
        if meta.len() % PAGE_SIZE != 0 {
            return Err(StoreError {
                kind: "corrupt",
                message: format!(
                    "The encrypted store at {path} is damaged ({} bytes is not a whole number of pages). It is only a cache and your documents are untouched, so delete it and re-scan.",
                    meta.len()
                ),
            });
        }
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))?;
    if let Err(e) = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    }) {
        let err = StoreError::from(e);
        return Err(
            if err.kind == "corrupt" && err.message.contains("not a database") {
                StoreError {
                    kind: "key",
                    message: format!("The database key does not open {path} ({}).", err.message),
                }
            } else {
                err
            },
        );
    }
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;")?;
    let secure: i64 = conn.query_row("PRAGMA secure_delete", [], |r| r.get(0))?;
    if secure != 1 {
        return Err(StoreError {
            kind: "format",
            message: "PRAGMA secure_delete did not stay on.".into(),
        });
    }
    let mut store = Store { conn };
    store.migrate()?;
    Ok(store)
}

impl Store {
    fn migrate(&mut self) -> Result<()> {
        let migrations: Vec<Value> = serde_json::from_str(MIGRATIONS_JSON)
            .map_err(|e| StoreError::protocol(format!("migrations.json: {e}")))?;
        let latest = migrations.len() as i64;
        let current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current > latest {
            return Err(StoreError {
                kind: "migration",
                message: format!(
                    "The database is at schema version {current}, newer than this build understands ({latest}). Upgrade Outtray, or delete the store and re-scan; it is a derived cache."
                ),
            });
        }
        for m in migrations.iter().skip(current as usize) {
            let version = m["version"].as_i64().unwrap_or(0);
            let tx = self.conn.transaction()?;
            for s in m["statements"].as_array().into_iter().flatten() {
                tx.execute_batch(s.as_str().unwrap_or(""))?;
            }
            tx.execute_batch(&format!("PRAGMA user_version = {version}"))?;
            tx.commit()?;
        }
        Ok(())
    }

    fn document_exists(tx: &Transaction, hash: &str) -> Result<bool> {
        Ok(tx
            .query_row(
                "SELECT 1 FROM documents WHERE content_hash = ?",
                [hash],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    fn document_row(row: &rusqlite::Row) -> rusqlite::Result<(Vec<Option<String>>, i64)> {
        Ok((
            vec![
                row.get("content_hash")?,
                row.get("path")?,
                row.get("type")?,
                row.get("extraction_json")?,
                row.get("reconciliation_json")?,
                row.get("extractor_key")?,
                row.get("index_key")?,
                row.get("user_type")?,
            ],
            row.get("scanned_at")?,
        ))
    }

    fn document_json((cols, scanned_at): (Vec<Option<String>>, i64)) -> Result<Value> {
        let mut it = cols.into_iter();
        let mut next = || it.next().flatten();
        let (hash, path, ty, extraction, reconciliation, extractor_key, index_key, user_type) = (
            next(),
            next(),
            next(),
            next(),
            next(),
            next(),
            next(),
            next(),
        );
        Ok(json!({
            "contentHash": hash,
            "path": path,
            "type": ty,
            "extraction": parse_json(extraction, "extraction JSON")?,
            "reconciliation": parse_json(reconciliation, "reconciliation JSON")?,
            "scannedAt": scanned_at,
            "extractorKey": extractor_key,
            "indexKey": index_key,
            "userType": user_type,
        }))
    }

    fn put_document(&mut self, d: &Value) -> Result<Value> {
        self.conn.execute(
            "INSERT INTO documents (content_hash, path, type, extraction_json, reconciliation_json, scanned_at, extractor_key, index_key, user_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(content_hash) DO UPDATE SET path = excluded.path, type = excluded.type,
               extraction_json = excluded.extraction_json, reconciliation_json = excluded.reconciliation_json,
               scanned_at = excluded.scanned_at, extractor_key = excluded.extractor_key,
               index_key = excluded.index_key, user_type = excluded.user_type",
            params![
                str_arg(d, "contentHash")?,
                str_arg(d, "path")?,
                opt_str(d, "type"),
                json_text(d.get("extraction")),
                json_text(d.get("reconciliation")),
                arg(d, "scannedAt")?.as_i64().ok_or_else(|| StoreError::protocol("scannedAt must be an integer"))?,
                opt_str(d, "extractorKey"),
                opt_str(d, "indexKey"),
                opt_str(d, "userType"),
            ],
        )?;
        Ok(Value::Null)
    }

    fn get_document(&self, hash: &str) -> Result<Value> {
        let row = self
            .conn
            .query_row(
                "SELECT * FROM documents WHERE content_hash = ?",
                [hash],
                Self::document_row,
            )
            .optional()?;
        row.map(Self::document_json)
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }

    fn list_documents(&self) -> Result<Value> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM documents ORDER BY content_hash")?;
        let rows = stmt.query_map([], Self::document_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(Self::document_json(r?)?);
        }
        Ok(Value::Array(out))
    }

    fn delete_orphans(tx: &Transaction) -> Result<()> {
        tx.execute("DELETE FROM identifiers WHERE id NOT IN (SELECT identifier_id FROM identifier_mentions)", [])?;
        Ok(())
    }

    fn delete_document(&mut self, hash: &str) -> Result<Value> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM documents WHERE content_hash = ?", [hash])?;
        Self::delete_orphans(&tx)?;
        tx.commit()?;
        Ok(Value::Null)
    }

    fn put_chunks(&mut self, hash: &str, chunks: &Value) -> Result<Value> {
        let chunks = chunks
            .as_array()
            .ok_or_else(|| StoreError::protocol("chunks must be an array"))?;
        let mut encoded = Vec::with_capacity(chunks.len());
        for c in chunks {
            encoded.push((
                arg(c, "chunkIndex")?.as_i64().unwrap_or(0),
                c.get("page").and_then(Value::as_i64),
                str_arg(c, "text")?.to_owned(),
                encode_embedding(arg(c, "embedding")?)?,
            ));
        }
        let tx = self.conn.transaction()?;
        if !Self::document_exists(&tx, hash)? {
            return Err(StoreError::storage(format!(
                "No document {hash} to attach chunks to."
            )));
        }
        tx.execute("DELETE FROM chunks WHERE document_hash = ?", [hash])?;
        for (index, page, text, embedding) in encoded {
            tx.execute(
                "INSERT INTO chunks (document_hash, chunk_index, page, text, embedding) VALUES (?, ?, ?, ?, ?)",
                params![hash, index, page, text, embedding],
            )?;
        }
        tx.commit()?;
        Ok(Value::Null)
    }

    fn list_chunks(&self) -> Result<Value> {
        let mut stmt = self.conn.prepare(
            "SELECT document_hash, chunk_index, page, text, embedding FROM chunks ORDER BY document_hash, chunk_index",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Vec<u8>>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (hash, index, page, text, blob) = r?;
            out.push(json!({"documentHash": hash, "chunkIndex": index, "page": page, "text": text, "embedding": decode_embedding(&blob)?}));
        }
        Ok(Value::Array(out))
    }

    fn insert_label(tx: &Transaction, l: &Value, document_hash: Option<&str>) -> Result<i64> {
        let id = tx.query_row(
            "INSERT INTO labels (type, embedding, provenance, document_hash, text, embed_model) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
            params![
                str_arg(l, "type")?,
                encode_embedding(arg(l, "embedding")?)?,
                str_arg(l, "provenance")?,
                document_hash.map(str::to_owned).or_else(|| opt_str(l, "documentHash")),
                opt_str(l, "text"),
                opt_str(l, "embedModel"),
            ],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    fn add_labels(&mut self, labels: &Value) -> Result<Value> {
        let labels = labels
            .as_array()
            .ok_or_else(|| StoreError::protocol("labels must be an array"))?;
        let tx = self.conn.transaction()?;
        let mut out = Vec::new();
        for l in labels {
            let id = Self::insert_label(&tx, l, None)?;
            let mut stored: Map<String, Value> = l.as_object().cloned().unwrap_or_default();
            stored.insert("id".into(), json!(id));
            out.push(Value::Object(stored));
        }
        tx.commit()?;
        Ok(Value::Array(out))
    }

    fn replace_document_labels(&mut self, hash: &str, labels: &Value) -> Result<Value> {
        let labels = labels
            .as_array()
            .ok_or_else(|| StoreError::protocol("labels must be an array"))?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM labels WHERE document_hash = ?", [hash])?;
        for l in labels {
            Self::insert_label(&tx, l, Some(hash))?;
        }
        tx.commit()?;
        Ok(Value::Null)
    }

    fn update_label_embedding(&mut self, args: &Value) -> Result<Value> {
        let id = arg(args, "id")?.as_i64().unwrap_or(-1);
        let changed = self.conn.execute(
            "UPDATE labels SET embedding = ?, embed_model = ? WHERE id = ?",
            params![
                encode_embedding(arg(args, "embedding")?)?,
                str_arg(args, "embedModel")?,
                id
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::storage(format!("No label {id}.")));
        }
        Ok(Value::Null)
    }

    fn list_labels(&self) -> Result<Value> {
        let mut stmt = self.conn.prepare(
            "SELECT id, type, embedding, provenance, document_hash, text, embed_model FROM labels ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id, ty, blob, provenance, document_hash, text, embed_model) = r?;
            out.push(json!({
                "id": id, "type": ty, "embedding": decode_embedding(&blob)?, "provenance": provenance,
                "documentHash": document_hash, "text": text, "embedModel": embed_model,
            }));
        }
        Ok(Value::Array(out))
    }

    fn put_identifiers(&mut self, hash: &str, keyed: &Value) -> Result<Value> {
        let keyed = keyed
            .as_array()
            .ok_or_else(|| StoreError::protocol("identifiers must be an array"))?;
        let tx = self.conn.transaction()?;
        if !Self::document_exists(&tx, hash)? {
            return Err(StoreError::storage(format!(
                "No document {hash} to attach identifiers to."
            )));
        }
        tx.execute(
            "DELETE FROM identifier_mentions WHERE document_hash = ?",
            [hash],
        )?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        for k in keyed {
            let key = str_arg(k, "key")?;
            let last_four: String = key
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            tx.execute(
                "INSERT INTO identifiers (normalized_value, value, last_four, value_length, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(normalized_value) DO NOTHING",
                params![key, str_arg(k, "value")?, last_four, key.chars().count() as i64, now],
            )?;
            let id: i64 = tx.query_row(
                "SELECT id FROM identifiers WHERE normalized_value = ?",
                [key],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO identifier_mentions (identifier_id, document_hash, field) VALUES (?, ?, ?)",
                params![id, hash, str_arg(k, "field")?],
            )?;
        }
        Self::delete_orphans(&tx)?;
        tx.commit()?;
        Ok(Value::Null)
    }

    fn get_identifier(&self, hash: &str, field: &str) -> Result<Value> {
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT i.value FROM identifier_mentions m JOIN identifiers i ON i.id = m.identifier_id WHERE m.document_hash = ? AND m.field = ?",
                [hash, field],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.map(Value::String).unwrap_or(Value::Null))
    }

    fn identifier_fields(&self, hash: &str) -> Result<Value> {
        let mut stmt = self.conn.prepare(
            "SELECT field FROM identifier_mentions WHERE document_hash = ? ORDER BY field",
        )?;
        let fields = stmt
            .query_map([hash], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!(fields))
    }

    fn set_review(&mut self, r: &Value) -> Result<Value> {
        let key = str_arg(r, "key")?;
        let hash = str_arg(r, "documentHash")?;
        let at = arg(r, "reviewedAt")?
            .as_i64()
            .ok_or_else(|| StoreError::protocol("reviewedAt must be an integer"))?;
        let tx = self.conn.transaction()?;
        if !Self::document_exists(&tx, hash)? {
            return Err(StoreError::storage(format!(
                "No document {hash} to mark reviewed."
            )));
        }
        tx.execute(
            "INSERT OR REPLACE INTO reviews (item_key, document_hash, reviewed_at) VALUES (?, ?, ?)",
            params![key, hash, at],
        )?;
        tx.commit()?;
        Ok(Value::Null)
    }

    fn list_reviews(&self) -> Result<Value> {
        let mut stmt = self.conn.prepare(
            "SELECT item_key, document_hash, reviewed_at FROM reviews ORDER BY item_key",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "key": r.get::<_, String>(0)?,
                "documentHash": r.get::<_, String>(1)?,
                "reviewedAt": r.get::<_, i64>(2)?,
            }))
        })?;
        Ok(Value::Array(rows.collect::<rusqlite::Result<Vec<_>>>()?))
    }
}

/// Execute one `StorageProvider` command. The op names and argument shapes
/// are `CommandStorage`'s (packages/core/src/storage-command.ts).
///
/// Failure modes: a `StoreError` whose kind maps to the TypeScript error class.
pub fn handle(store: &mut Store, op: &str, args: &Value) -> Result<Value> {
    match op {
        "putDocument" => store.put_document(arg(args, "document")?),
        "getDocument" => store.get_document(str_arg(args, "contentHash")?),
        "listDocuments" => store.list_documents(),
        "deleteDocument" => store.delete_document(str_arg(args, "contentHash")?),
        "putChunks" => store.put_chunks(str_arg(args, "contentHash")?, arg(args, "chunks")?),
        "listChunks" => store.list_chunks(),
        "addLabels" => store.add_labels(arg(args, "labels")?),
        "listLabels" => store.list_labels(),
        "replaceDocumentLabels" => {
            store.replace_document_labels(str_arg(args, "documentHash")?, arg(args, "labels")?)
        }
        "updateLabelEmbedding" => store.update_label_embedding(args),
        "putIdentifiers" => {
            store.put_identifiers(str_arg(args, "documentHash")?, arg(args, "identifiers")?)
        }
        "getIdentifier" => {
            store.get_identifier(str_arg(args, "documentHash")?, str_arg(args, "field")?)
        }
        "identifierFields" => store.identifier_fields(str_arg(args, "documentHash")?),
        "purgeIdentifiers" => Ok(json!(store.conn.execute("DELETE FROM identifiers", [])?)),
        "countIdentifiers" => Ok(json!(store.conn.query_row(
            "SELECT count(*) FROM identifiers",
            [],
            |r| r.get::<_, i64>(0)
        )?)),
        "setReview" => store.set_review(arg(args, "review")?),
        "clearReview" => {
            store.conn.execute(
                "DELETE FROM reviews WHERE item_key = ?",
                [str_arg(args, "key")?],
            )?;
            Ok(Value::Null)
        }
        "listReviews" => store.list_reviews(),
        "close" => Ok(Value::Null),
        other => Err(StoreError::protocol(format!("unknown op {other}"))),
    }
}
