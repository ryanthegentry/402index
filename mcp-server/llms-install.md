# Installing the 402 Index MCP Server

## Installation

Install globally via npm:

```bash
npm install -g @402index/mcp-server
```

This installs the `mcp-server` binary. Verify it works:

```bash
mcp-server
```

You should see: `[402index-mcp] Server running, connected to https://402index.io`

Press Ctrl+C to stop the test.

## MCP Configuration

Add this to the MCP settings:

```json
{
  "mcpServers": {
    "402index": {
      "command": "mcp-server"
    }
  }
}
```

No API key or environment variables are required. The server connects to the public 402 Index API at https://402index.io.

## Important

Do NOT use `npx @402index/mcp-server` — there is a known npm bug with scoped package bin resolution that causes `npx` to fail silently. Use the global install (`npm install -g`) instead.

## Verify

After configuration, confirm the server connects by checking MCP server health. The `search_services` tool should be available. Try:

```
Search 402index for healthy image generation services
```

## Available Tools

- `search_services` — Search 15,000+ paid APIs by keyword, protocol, category, health, price
- `get_service_detail` — Full details for a specific service
- `list_categories` — Browse API categories
- `get_directory_stats` — Directory-wide stats and health summary
