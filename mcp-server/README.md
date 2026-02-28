# 402 Index MCP Server

MCP server for AI agent service discovery via the [402 Index](https://402index.io) directory.

## Tools

| Tool | Description |
|------|-------------|
| `search_services` | Search/filter paid API services (protocol, category, health, price, etc.) |
| `get_service_detail` | Get full details for a single service including health check history |
| `list_categories` | List all categories with service counts |
| `get_directory_stats` | Directory health, totals, sync timestamps |

## Setup

```bash
cd mcp-server
npm install
npm run build
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "402index": {
      "command": "node",
      "args": ["/path/to/402index/mcp-server/dist/index.js"],
      "env": {
        "INDEX_URL": "https://402index.io"
      }
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json` or run:

```bash
claude mcp add 402index node /path/to/402index/mcp-server/dist/index.js
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "402index": {
      "command": "node",
      "args": ["/path/to/402index/mcp-server/dist/index.js"]
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEX_URL` | `https://402index.io` | Base URL of the 402 Index API |

## Example Prompts

- "Find healthy L402 weather APIs under $0.01"
- "What categories of paid APIs are available?"
- "Show me details for service 42"
- "How many services are in the directory?"
