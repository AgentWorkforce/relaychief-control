#!/usr/bin/env node
import { PostgresDatabase } from "./database.js";
import { migrate } from "./migrations.js";

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL is required");
const database = new PostgresDatabase(url);
try {
  console.log("[relaychief-control] applied migrations", await migrate(database));
} finally {
  await database.close();
}
