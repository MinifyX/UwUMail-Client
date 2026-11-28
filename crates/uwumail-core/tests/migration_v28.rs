//! Regression: migrations must only ever be appended. Inserting one in the
//! middle shifts every later index, so an existing database (user_version N)
//! re-runs a migration whose table already exists and the app won't start.
//! Here we reproduce a v28 database that already has the shipments table and
//! check that opening it applies the new migrations cleanly.
use uwumail_core::store::Store;

#[test]
fn opens_a_version_28_database() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("uwumail.db");
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL);
             CREATE TABLE messages (id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
             CREATE TABLE shipments (account_id TEXT NOT NULL, id TEXT NOT NULL,
                 json TEXT NOT NULL, PRIMARY KEY (account_id, id));
             CREATE TABLE shipment_notices (account_id TEXT NOT NULL,
                 shipment_id TEXT NOT NULL, status TEXT NOT NULL,
                 PRIMARY KEY (account_id, shipment_id, status));
             PRAGMA user_version = 28;",
        )
        .unwrap();
    }

    Store::open(&db).expect("migrations must apply to a v28 database");

    let conn = rusqlite::Connection::open(&db).unwrap();
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(messages)")
        .unwrap()
        .query_map([], |r| r.get(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(cols.iter().any(|c| c == "report_abuse_json"), "report abuse migration missing");
    assert!(cols.iter().any(|c| c == "pgp_signed"), "pgp migration missing");
    let pgp_keys: i64 = conn
        .query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='pgp_keys'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(pgp_keys, 1, "pgp_keys table missing");
}
