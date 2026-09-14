import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, loadHttpConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { LoseItClient } from "./loseit/client.js";
import { registerLoseItTypes } from "./loseit/types.js";
import { APP_NAME } from "./meta.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  registerLoseItTypes();

  const transportMode = process.env["MCP_TRANSPORT"]?.trim().toLowerCase();
  if (transportMode === "http") {
    const running = await startHttpServer(loadHttpConfig());
    const shutdown = async () => {
      await running.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }
  if (transportMode && transportMode !== "stdio") {
    throw new Error(
      `Invalid MCP_TRANSPORT "${transportMode}"; expected "stdio" or "http"`,
    );
  }

  const config = loadConfig();
  const client = new LoseItClient(config);
  await client.initialize();

  const server = createServer(client);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`${APP_NAME} is running on stdio`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exit(1);
});
