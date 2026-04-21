#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const INDEX_URL = process.env.INDEX_URL || 'https://402index.io'

async function fetchJson(path: string, params?: Record<string, string>) {
  const url = new URL(path, INDEX_URL)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
  }
  const res = await fetch(url.toString(), { headers: { 'User-Agent': '402index-mcp/0.3.0' } })
  if (!res.ok) {
    return { error: true, status: res.status, message: `API returned ${res.status}` }
  }
  return await res.json()
}

export const DEFAULT_FIELDS = ['name', 'url', 'protocol', 'price_sats', 'health_status']

export function filterFields(services: any[], fields?: string): any[] {
  if (fields === '*' || fields === 'all') return services
  const keys = fields ? fields.split(',').map((f) => f.trim()) : DEFAULT_FIELDS
  return services.map((svc) => {
    const filtered: Record<string, any> = {}
    for (const key of keys) {
      if (key in svc) filtered[key] = svc[key]
    }
    return filtered
  })
}

export function toCsv(services: any[]): string {
  if (services.length === 0) return ''
  const headers = Object.keys(services[0])
  const rows = services.map((svc) =>
    headers
      .map((h) => {
        const val = svc[h]
        if (val === null || val === undefined) return ''
        const str = String(val)
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      })
      .join(','),
  )
  return [headers.join(','), ...rows].join('\n')
}

const server = new McpServer({
  name: '402index',
  version: '0.3.0',
})

// Tool 1: Search services
server.tool(
  'search_services',
  'Search and filter paid API services in the 402 Index directory. Returns services with health status, pricing, and protocol info. Includes `related_protocols` array showing other payment rails for the same URL.',
  {
    protocol: z.enum(['L402', 'x402', 'MPP']).optional().describe('Filter by payment protocol'),
    category: z.string().optional().describe('Filter by category (prefix match — "crypto" matches "crypto/nft")'),
    health: z.enum(['healthy', 'degraded', 'down', 'unknown']).optional().describe('Filter by health status'),
    source: z
      .enum(['bazaar', 'satring', 'l402apps', 'sponge', 'l402directory', 'mpp', 'discovery', 'self-registered'])
      .optional()
      .describe('Filter by source'),
    featured: z.boolean().optional().describe('Only featured services'),
    verified: z.boolean().optional().describe('Only payment-verified services (x402: valid payment headers, L402/MPP: healthy). Domain-verified ranked first. Recommended for agents making payment decisions.'),
    q: z.string().optional().describe('Search by name, description, or URL'),
    max_price_usd: z.number().optional().describe('Maximum price in USD'),
    sort: z.enum(['name', 'price', 'latency', 'uptime']).optional().describe('Sort field'),
    order: z.enum(['asc', 'desc']).optional().describe('Sort order'),
    limit: z.number().min(1).max(200).optional().describe('Results per page (default 10, max 200)'),
    offset: z.number().min(0).optional().describe('Pagination offset'),
    fields: z
      .string()
      .optional()
      .describe('Comma-separated fields (default: name,url,protocol,price_sats,health_status). Use * for all fields.'),
    format: z
      .enum(['json', 'csv'])
      .optional()
      .describe('Response format (default: json). CSV reduces token usage by ~29% for tabular data.'),
  },
  async (params) => {
    try {
      const queryParams: Record<string, string> = {}
      if (params.protocol) queryParams.protocol = params.protocol
      if (params.category) queryParams.category = params.category
      if (params.health) queryParams.health = params.health
      if (params.source) queryParams.source = params.source
      if (params.featured) queryParams.featured = 'true'
      if (params.verified) queryParams.verified = 'true'
      if (params.q) queryParams.q = params.q
      if (params.max_price_usd !== undefined) queryParams.max_price_usd = String(params.max_price_usd)
      if (params.sort) queryParams.sort = params.sort
      if (params.order) queryParams.order = params.order
      queryParams.limit = String(params.limit ?? 10)
      if (params.offset !== undefined) queryParams.offset = String(params.offset)

      const data = await fetchJson('/api/v1/services', queryParams)

      if (data.services && Array.isArray(data.services)) {
        data.services = filterFields(data.services, params.fields)
      }

      if (params.format === 'csv' && data.services && Array.isArray(data.services)) {
        return { content: [{ type: 'text' as const, text: toCsv(data.services) }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    } catch (err: any) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: true, message: err.message, tool: 'search_services' }) },
        ],
      }
    }
  },
)

// Tool 2: Get service detail
server.tool(
  'get_service_detail',
  'Get full details for a single service including health check history, pricing, and schema information. Includes `related_services` array with sibling payment rail details.',
  {
    id: z.string().describe('Service ID (numeric or UUID)'),
  },
  async (params) => {
    try {
      const data = await fetchJson(`/api/v1/services/${encodeURIComponent(params.id)}`)
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: err.message, tool: 'get_service_detail' }),
          },
        ],
      }
    }
  },
)

// Tool 3: List categories
server.tool(
  'list_categories',
  'List all service categories with counts. Example: "What categories of paid APIs are available?"',
  {
    summary: z
      .boolean()
      .optional()
      .describe(
        'Return only category names and total counts (default: true). Set false for full protocol breakdown with subcategories.',
      ),
  },
  async (params) => {
    try {
      const data = await fetchJson('/api/v1/categories')

      if (params.summary !== false && data.categories && typeof data.categories === 'object' && !Array.isArray(data.categories)) {
        const compact = Object.entries(data.categories).map(([name, val]: [string, any]) => ({
          name,
          count: val.total ?? val.count ?? 0,
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify({ categories: compact }) }] }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    } catch (err: any) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: true, message: err.message, tool: 'list_categories' }) },
        ],
      }
    }
  },
)

// Tool 4: Get directory stats
server.tool(
  'get_directory_stats',
  'Get overall directory health and stats: total services, breakdown by protocol/health/source, and sync timestamps. Example: "How many services are in the directory?"',
  {},
  async () => {
    try {
      const data = await fetchJson('/api/v1/health')
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: err.message, tool: 'get_directory_stats' }),
          },
        ],
      }
    }
  },
)

export { server }

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[402index-mcp] Server running, connected to ${INDEX_URL}`)
}

main().catch((err) => {
  console.error('[402index-mcp] Fatal error:', err)
  process.exit(1)
})
