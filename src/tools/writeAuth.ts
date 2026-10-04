import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { MCP_SCOPE, MCP_WRITE_SCOPE } from "../auth/scopes.js";
import { errorResponse } from "./response.js";

/** HTTP mode's protected-resource metadata, or null in stdio mode (no OAuth). */
export type WriteAuth = { resourceMetadataUrl: string } | null;

/** Tool `_meta` advertising that the tool needs the write scope. */
export function writeToolMeta(writeAuth: WriteAuth) {
  return writeAuth === null ? {} : {
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE, MCP_WRITE_SCOPE] }],
    },
  };
}

/**
 * In HTTP mode, the error result for a caller without the write scope, or null
 * when the call may proceed.
 */
export function writeScopeError(
  writeAuth: WriteAuth,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  action: string,
) {
  if (writeAuth === null || extra.authInfo?.scopes.includes(MCP_WRITE_SCOPE)) {
    return null;
  }
  return {
    ...errorResponse(
      new Error(`${action} requires ${MCP_WRITE_SCOPE}; reconnect with write access`),
    ),
    _meta: {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${writeAuth.resourceMetadataUrl}", ` +
        `error="insufficient_scope", ` +
        `error_description="${action} requires write access", ` +
        `scope="${MCP_SCOPE} ${MCP_WRITE_SCOPE}"`,
      ],
    },
  };
}
