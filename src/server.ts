#!/usr/bin/env node
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { relayControlIntrospector } from "./auth/introspection.js";
import { GithubBindings, NangoGithubRepositories, nangoClient } from "./chief/github.js";
import { ChiefRegistry } from "./chief/registry.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";

const config = loadConfig();
const database = new PostgresDatabase(config.databaseUrl);
const githubBindings = new GithubBindings(database);
const nango = config.nango ? nangoClient(config.nango) : null;
const repositories = nango
  ? new NangoGithubRepositories({ binding: (context) => githubBindings.get(context), nango })
  : undefined;
// No authority yet: the evidence and verification routes answer 503 rather than
// guessing. Without Nango, creating a chief does the same.
const app = createApp({
  database,
  introspect: relayControlIntrospector({
    relayControlUrl: config.relayControlUrl,
    secret: config.introspectSecret,
    audience: config.audience,
  }),
  adminToken: config.adminToken,
  browserOrigins: config.browserOrigins,
  operations: { registry: new ChiefRegistry({ database, ...(repositories ? { repositories } : {}) }), githubBindings },
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
