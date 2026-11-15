//! Shipments this device found in the mail of mailboxes whose server keeps none (see
//! `shipments`), and which shipment statuses were already notified, for every mailbox.

use rusqlite::params;

use super::Store;
use crate::error::Result;
use crate::shipments::Shipment;

/// The migration of this feature, appended to `MIGRATIONS`.
pub(super) const MIGRATION: &str = r#"
CREATE TABLE shipments (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);
-- A status of a shipment that notified once (or was already there when notifying began).
CREATE TABLE shipment_notices (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    shipment_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (account_id, shipment_id, status)
);
"#;

impl Store {
    /// The shipments this device keeps for an account; one it can't read is left out.
    pub fn local_shipments(&self, account_id: &str) -> Result<Vec<Shipment>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached("SELECT json FROM shipments WHERE account_id = ?1 ORDER BY rowid")?;
        let rows = stmt.query_map([account_id], |row| row.get::<_, String>(0))?;
        let mut list = Vec::new();
        for json in rows {
            if let Ok(mut shipment) = serde_json::from_str::<Shipment>(&json?) {
                shipment.account_id = account_id.to_owned();
                list.push(shipment);
            }
        }
        Ok(list)
    }

    /// Keeps exactly `list` as the account's shipments.
    pub fn replace_local_shipments(&self, account_id: &str, list: &[Shipment]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM shipments WHERE account_id = ?1", [account_id])?;
        {
            let mut insert = tx.prepare_cached("INSERT INTO shipments (account_id, id, json) VALUES (?1, ?2, ?3)")?;
            for shipment in list {
                insert.execute(params![account_id, shipment.id, serde_json::to_string(shipment)?])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Notes that a shipment's status notified; `false` when it already had.
    pub fn note_shipment_notice(&self, account_id: &str, shipment_id: &str, status: &str) -> Result<bool> {
        let added = self.conn().execute(
            "INSERT OR IGNORE INTO shipment_notices (account_id, shipment_id, status) VALUES (?1, ?2, ?3)",
            params![account_id, shipment_id, status],
        )?;
        Ok(added > 0)
    }

    /// Forgets the notices of shipments that are gone.
    pub fn retain_shipment_notices(&self, account_id: &str, keep: &[String]) -> Result<()> {
        let keep = serde_json::to_string(keep)?;
        self.conn().execute(
            "DELETE FROM shipment_notices WHERE account_id = ?1
               AND shipment_id NOT IN (SELECT value FROM json_each(?2))",
            params![account_id, keep],
        )?;
        Ok(())
    }
}
