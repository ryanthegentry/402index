# RSS Feed Spec — `l402:service` Namespace

## Overview
RSS 2.0 feed at `GET /feed.xml` emitting items for L402/x402 services with a custom `l402:` XML namespace embedding payment and protocol info. Modeled on Podcasting 2.0's `podcast:value` namespace.

## Route
- **Path:** `/feed.xml` (root, not under `/api/v1`)
- **Method:** GET
- **Auth:** None (public)
- **Rate limit:** None
- **Content-Type:** `application/rss+xml; charset=utf-8`

## Query Parameters
| Param | Values | Default | Description |
|-------|--------|---------|-------------|
| protocol | `L402`, `x402` | all | Filter by protocol |
| health | `healthy`, `degraded`, `down`, `unknown` | all | Filter by health status |
| type | `new`, `changed`, `all` | `all` | `new` = registered in last 7 days |

## XML Structure
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:l402="https://402index.io/ns/l402">
  <channel>
    <title>402 Index - Paid API Directory</title>
    <link>https://402index.io</link>
    <description>New and updated paid API endpoints (L402 + x402) for AI agents</description>
    <language>en</language>
    <lastBuildDate>{RFC 2822 date}</lastBuildDate>
    <atom:link href="{self URL with query params}" rel="self" type="application/rss+xml"/>

    <item>
      <title>{service name}</title>
      <link>https://402index.io/service/{id}</link>
      <guid isPermaLink="true">https://402index.io/service/{id}</guid>
      <pubDate>{RFC 2822 date from registered_at}</pubDate>
      <description>{service description}</description>
      <category>{service category}</category>
      <l402:endpoint url="{endpoint URL}" method="{GET|POST}"/>
      <l402:protocol type="{L402|x402}" health="{healthy|degraded|down|unknown}" reliability="{0-1}"/>
      <l402:price sats="{price in sats}" usd="{price in USD}"/>
    </item>
    ...
  </channel>
</rss>
```

## Custom Namespace Tags
| Tag | Attributes | Description |
|-----|-----------|-------------|
| `l402:endpoint` | `url`, `method` | The API endpoint URL and HTTP method |
| `l402:protocol` | `type`, `health`, `reliability` | Protocol type, health status, reliability score |
| `l402:price` | `sats`, `usd` | Price in satoshis and USD |

## Security
- All dynamic values escaped with `escapeXml()` (escapes &, <, >, ", ')
- No user-controlled content rendered without escaping

## Implementation
- Template literals for XML generation (same pattern as HTML views)
- No external dependencies
- `rfcDate()` helper for ISO to RFC 2822 conversion
- Reuses `queryServices()` from `src/queries/services.js`
- Default limit: 100 items, sorted by `registered_at DESC`
