#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare const DEFAULT_FIELDS: string[];
export declare function filterFields(services: any[], fields?: string): any[];
export declare function toCsv(services: any[]): string;
declare const server: McpServer;
export { server };
