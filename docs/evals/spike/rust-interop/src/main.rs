//! Interop spike for #75: open the store the Node CLI writes, from Rust,
//! with rusqlite's bundled SQLCipher (the build a Tauri app would use).
//!
//! Usage: outtray-sqlcipher-interop <db-path> <64-hex-char raw key>
//! Reads the schema version, the cipher settings SQLCipher reports, every
//! document's hash and type, and the label and chunk counts; then writes one
//! correction label so the Node side can prove it reads Rust's write.
use rusqlite::{Connection, OpenFlags};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("db path")?;
    let key = args.next().ok_or("raw key hex")?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    // Upstream SQLCipher 4 defaults are what `legacy = 4` selects on the Node
    // side, so only the raw key is needed: no KDF runs for a raw key.
    conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))?;
    let version: String = conn.query_row("PRAGMA cipher_version", [], |r| r.get(0))?;
    let page: String = conn.query_row("PRAGMA cipher_page_size", [], |r| r.get(0))?;
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    println!("cipher_version={version} cipher_page_size={page} user_version={user_version}");
    let mut stmt = conn.prepare("SELECT content_hash, type, index_key FROM documents ORDER BY content_hash")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?))
    })?;
    for row in rows {
        let (hash, ty, index_key) = row?;
        println!("document {hash} type={ty:?} index_key={index_key:?}");
    }
    let labels: i64 = conn.query_row("SELECT count(*) FROM labels", [], |r| r.get(0))?;
    let chunks: i64 = conn.query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))?;
    let dims: i64 = conn.query_row("SELECT length(embedding) / 4 FROM chunks LIMIT 1", [], |r| r.get(0))?;
    println!("labels={labels} chunks={chunks} embedding_dims={dims}");
    conn.execute(
        "INSERT INTO labels (type, embedding, provenance, document_hash, text, embed_model) VALUES ('statement', x'0000803f', 'correction', NULL, 'written by rust', 'rust-spike')",
        [],
    )?;
    println!("wrote one label from rust");
    Ok(())
}
