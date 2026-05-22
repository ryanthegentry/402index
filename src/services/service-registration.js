import db from '../db.js'

const stmts = {}
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

export const registerUpsert = () => stmt('registerUpsert', `
  INSERT INTO services (id, name, description, url, protocol, price_sats, price_usd, payment_asset, payment_network, category, provider, source, contact_email, http_method, probe_body, health_status, status, hostname)
  VALUES (@id, @name, @description, @url, @protocol, @price_sats, @price_usd, @payment_asset, @payment_network, @category, @provider, 'self-registered', @contact_email, @http_method, @probe_body, 'healthy', 'pending', @hostname)
  ON CONFLICT(url, protocol) DO UPDATE SET
    name = excluded.name,
    description = COALESCE(excluded.description, services.description),
    price_sats = COALESCE(excluded.price_sats, services.price_sats),
    price_usd = COALESCE(excluded.price_usd, services.price_usd),
    payment_asset = COALESCE(excluded.payment_asset, services.payment_asset),
    payment_network = COALESCE(excluded.payment_network, services.payment_network),
    category = COALESCE(excluded.category, services.category),
    provider = COALESCE(excluded.provider, services.provider),
    contact_email = COALESCE(excluded.contact_email, services.contact_email),
    http_method = COALESCE(excluded.http_method, services.http_method),
    probe_body = COALESCE(excluded.probe_body, services.probe_body),
    health_status = 'healthy',
    hostname = COALESCE(excluded.hostname, services.hostname),
    status = CASE WHEN services.status = 'active' THEN 'active' ELSE 'pending' END,
    updated_at = datetime('now')
  RETURNING *
`)
