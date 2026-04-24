// DEPRECATION: 'golem' / GOLEM_* / 'golem-gateway' / X-Golem-Gateway-Secret
// are accepted for backwards compatibility until v1.0.0. New integrations
// must use 'partner' / PARTNER_GATEWAY_* / 'partner-gateway' / X-Partner-Gateway-Secret.
export const DEPRECATED_ENV_URL = 'GOLEM_INTERNAL_URL'
export const DEPRECATED_ENV_API_KEY = 'GOLEM_API_KEY'
export const DEPRECATED_ENV_SECRET = 'GOLEM_GATEWAY_SECRET'
export const DEPRECATED_HEADER = 'x-golem-gateway-secret'
export const DEPRECATED_PROVIDER = 'golem-gateway'
export const DEPRECATED_GATEWAY = 'golem'
