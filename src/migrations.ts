import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";

export function defaultMigrationsDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

export async function migrate(database: Database, directory = defaultMigrationsDirectory()): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const migrations = await Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
  const applied: string[] = [];
  await database.transaction(async (transaction) => {
    // Serializes startup jobs without requiring an extension or an external lock.
    await transaction.query("SELECT pg_advisory_xact_lock(1947182643)");
    await transaction.query(`
      CREATE TABLE IF NOT EXISTS chief_schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const migration of migrations) {
      const existing = await transaction.query<{ checksum: string }>(
        "SELECT checksum FROM chief_schema_migrations WHERE name = $1",
        [migration.name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.name} has changed`);
        }
        continue;
      }
      await transaction.exec(migration.sql);
      await transaction.query("INSERT INTO chief_schema_migrations (name, checksum) VALUES ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
      applied.push(migration.name);
    }
  });
  return applied;
}
