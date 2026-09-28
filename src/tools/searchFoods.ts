import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { extractFoodSearch } from "../loseit/foodSearch.js";
import { GwtParseError } from "../loseit/gwt.js";
import { StructParseError } from "../loseit/structReader.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { errorResponse, textResponse } from "./response.js";

export function registerSearchFoodsTool(server: McpServer, client: LoseItClient): void {
  server.registerTool(
    "loseit_search_foods",
    {
      title: "Search Foods",
      description:
        "Search the Lose It food database before logging a food. Returns foodId, name, " +
        "brand and source for matching foods; foodId identifies the exact food rather than " +
        "guessing from its name. Non-food results (such as previous meals and section " +
        "headers) are excluded from foods but included in totalResults.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Food name to search for."),
        limit: z.number().int().min(10).max(200).optional().describe(
          "Maximum search results requested from Lose It; defaults to 20.",
        ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ query, limit }) => {
      try {
        const { raw } = await client.gwtRpcWithParams("searchFoods", [
          { kind: "string", value: query },
          { kind: "string", value: "en-US" },
          { kind: "int", value: limit ?? 20 },
          { kind: "boolean", value: true },
          { kind: "boolean", value: true },
        ]);
        return textResponse({ query, ...extractFoodSearch(raw, client.getGwtRegistry()) });
      } catch (error) {
        if (error instanceof GwtParseError || error instanceof StructParseError) {
          return errorResponse(error);
        }
        throw error;
      }
    },
  );
}
