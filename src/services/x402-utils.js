/**
 * x402 Payment Requirements parsing and validation utilities.
 *
 * The x402 protocol returns HTTP 402 with a base64-encoded JSON payload
 * in the `PAYMENT-REQUIRED` header (case-insensitive). The payload contains
 * an `accepts` array describing acceptable payment methods.
 *
 * This module validates the structural correctness of that payload — it does
 * NOT make or verify payments.
 */

// Known USDC contract addresses by chain
const KNOWN_USDC = {
  // Base mainnet
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'Base',
  // Ethereum mainnet
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'Ethereum',
  // Arbitrum One
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'Arbitrum',
  // Optimism
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'Optimism',
  // Polygon
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'Polygon',
  // Base Sepolia (testnet)
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'Base Sepolia',
}

/**
 * Parse the PAYMENT-REQUIRED header from an x402 402 response.
 * The header value is a base64-encoded JSON string.
 *
 * @param {string|null} headerValue - Raw header value (base64-encoded JSON)
 * @returns {{ valid: boolean, accepts: Array|null, error: string|null, raw: object|null }}
 */
export function parsePaymentRequired(headerValue) {
  if (!headerValue) {
    return { valid: false, accepts: null, error: 'missing PAYMENT-REQUIRED header', raw: null }
  }

  let decoded
  try {
    decoded = Buffer.from(headerValue, 'base64').toString('utf-8')
  } catch {
    return { valid: false, accepts: null, error: 'invalid base64 encoding', raw: null }
  }

  let parsed
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return { valid: false, accepts: null, error: 'invalid JSON in decoded payload', raw: null }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, accepts: null, error: 'decoded payload is not an object', raw: parsed }
  }

  const accepts = parsed.accepts
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { valid: false, accepts: null, error: 'missing or empty accepts array', raw: parsed }
  }

  return { valid: true, accepts, error: null, raw: parsed }
}

/**
 * Check if an EVM address (0x-prefixed, 40 hex chars) is valid format.
 * @param {string} address
 * @returns {boolean}
 */
export function isValidEvmAddress(address) {
  if (!address || typeof address !== 'string') return false
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

/**
 * Check if a Solana address is valid format (base58, 32-44 chars).
 * @param {string} address
 * @returns {boolean}
 */
export function isValidSolanaAddress(address) {
  if (!address || typeof address !== 'string') return false
  // Solana addresses are base58 encoded, 32-44 characters
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
}

/**
 * Check if an asset address is structurally valid (EVM or Solana).
 * @param {string} address
 * @returns {boolean}
 */
export function isValidAssetAddress(address) {
  return isValidEvmAddress(address) || isValidSolanaAddress(address)
}

/**
 * Check if a payment address (payTo) is structurally valid.
 * @param {string} address
 * @returns {boolean}
 */
export function isValidPaymentAddress(address) {
  return isValidEvmAddress(address) || isValidSolanaAddress(address)
}

/**
 * Check if the asset address is a known USDC contract.
 * @param {string} address
 * @returns {{ known: boolean, chain: string|null }}
 */
export function isKnownUSDC(address) {
  if (!address) return { known: false, chain: null }
  const lower = address.toLowerCase()
  const chain = KNOWN_USDC[lower] || null
  return { known: !!chain, chain }
}

/**
 * Extract the facilitator URL from an accepts entry.
 * @param {object} entry - An accepts array entry
 * @returns {string|null}
 */
export function extractFacilitatorUrl(entry) {
  if (!entry) return null

  // x402 spec: facilitatorData.facilitatorUrl or extra.facilitatorUrl
  if (entry.extra?.facilitatorUrl) return entry.extra.facilitatorUrl

  // Some implementations nest under facilitatorData
  if (entry.facilitatorData) {
    if (typeof entry.facilitatorData === 'string') {
      // Some embed a URL directly
      try {
        const parsed = JSON.parse(entry.facilitatorData)
        if (parsed?.facilitatorUrl) return parsed.facilitatorUrl
      } catch {
        // Not JSON — might be the URL itself
        if (entry.facilitatorData.startsWith('http')) return entry.facilitatorData
      }
    } else if (entry.facilitatorData.facilitatorUrl) {
      return entry.facilitatorData.facilitatorUrl
    }
  }

  return null
}

/**
 * Validate all payment requirements from a parsed PAYMENT-REQUIRED payload.
 * Checks structural validity of each accepts entry.
 *
 * @param {Array} accepts - The accepts array from parsePaymentRequired
 * @returns {{ valid: boolean, assetKnown: boolean, entries: Array, facilitatorUrls: string[] }}
 */
export function validatePaymentRequirements(accepts) {
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { valid: false, assetKnown: false, entries: [], facilitatorUrls: [] }
  }

  const entries = []
  const facilitatorUrls = []
  let anyValid = false
  let anyAssetKnown = false

  for (const entry of accepts) {
    const result = {
      hasPayTo: false,
      payToValid: false,
      hasAsset: false,
      assetValid: false,
      assetKnown: false,
      assetChain: null,
      hasNetwork: false,
      hasAmount: false,
      facilitatorUrl: null,
      valid: false,
    }

    // payTo (required)
    if (entry.payTo) {
      result.hasPayTo = true
      result.payToValid = isValidPaymentAddress(entry.payTo)
    }

    // asset (required — the token contract address)
    if (entry.asset) {
      result.hasAsset = true
      result.assetValid = isValidAssetAddress(entry.asset)
      const usdcCheck = isKnownUSDC(entry.asset)
      result.assetKnown = usdcCheck.known
      result.assetChain = usdcCheck.chain
      if (usdcCheck.known) anyAssetKnown = true
    }

    // network (optional but expected — CAIP-2 chain ID)
    if (entry.network) {
      result.hasNetwork = true
    }

    // amount (V2) or maxAmountRequired (V1) — the price
    if ((entry.maxAmountRequired != null && entry.maxAmountRequired !== '') ||
        (entry.amount != null && entry.amount !== '')) {
      result.hasAmount = true
    }

    // facilitator URL
    result.facilitatorUrl = extractFacilitatorUrl(entry)
    if (result.facilitatorUrl) {
      facilitatorUrls.push(result.facilitatorUrl)
    }

    // An entry is valid if it has payTo + asset + amount
    result.valid = result.hasPayTo && result.payToValid && result.hasAsset && result.assetValid && result.hasAmount
    if (result.valid) anyValid = true

    entries.push(result)
  }

  return {
    valid: anyValid,
    assetKnown: anyAssetKnown,
    entries,
    facilitatorUrls: [...new Set(facilitatorUrls)],
  }
}
