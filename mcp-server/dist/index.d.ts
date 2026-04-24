#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare const USER_AGENT = "402index-mcp/0.3.0";
/**
 * Fetch JSON from the 402 Index API with retry on 5xx.
 *
 * @internal Exported for test access only. Not part of the public library API.
 * Consumers should use the MCP tool handlers (`search_services`, `get_service_detail`,
 * `list_categories`, `get_directory_stats`) which wrap this function.
 *
 * Retry behavior is controlled by the `FETCH_RETRIES` env var:
 * - unset (default): 2 attempts with 500ms backoff between
 * - `0` or `''`: 1 attempt, fail-fast (no retries)
 * - positive integer: that many attempts
 * - invalid (NaN, negative, non-finite): falls back to default 2
 *
 * 4xx responses are NEVER retried. Only 5xx triggers retry.
 * Returns `{error: true, status, message}` on final failure — does not throw.
 */
export declare function fetchJson(path: string, params?: Record<string, string>): Promise<any>;
export declare const DEFAULT_FIELDS: string[];
export declare function filterFields(services: any[], fields?: string): any[];
export declare function toCsv(services: any[]): string;
declare const server: McpServer;
export { server };
