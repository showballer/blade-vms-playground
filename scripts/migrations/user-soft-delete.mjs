/** Additive and idempotent: this migration never deletes users or business records. */
export async function migrateUserSoftDelete(db) {
  const [columns] = await db.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='deleted_at'");
  if (!columns.length) {
    try { await db.query("ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL"); }
    catch (error) { if (error.code !== "ER_DUP_FIELDNAME") throw error; }
  }
}
