#!/usr/bin/env node
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { relayControlIntrospector } from "./auth/introspection.js";
import { ChiefRegistry } from "./chief/registry.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";

const config = loadConfig();
const database = new PostgresDatabase(config.databaseUrl);
// No repository source or authority yet: creating a chief and the evidence and
// verification routes answer 503 rather than guessing.
const app = createApp({
  database,
  introspect: relayControlIntrospector({
    relayControlUrl: config.relayControlUrl,
    secret: config.introspectSecret,
    audience: config.audience,
  }),
  adminToken: config.adminToken,
  browserOrigins: config.browserOrigins,
  operations: { registry: new ChiefRegistry({ database }) },
});
const publicServer = createServer(app.public);
const adminServer = createServer(app.admin);
publicServer.listen(config.port, config.host);
adminServer.listen(config.adminPort, config.adminHost);

function shutdown(): void {
  publicServer.close(() => adminServer.close(() => void database.close().then(() => process.exit(0))));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
