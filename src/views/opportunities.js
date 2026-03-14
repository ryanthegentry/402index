import { layout } from './layout.js'
import { escapeHtml } from './helpers.js'

const TYPE_LABELS = {
  gap: 'Coverage Gaps',
  protocol_gap: 'Protocol Gaps',
  single_provider: 'Single Provider',
  failing: 'Failing Services',
}

const TYPE_DESCRIPTIONS = {
  gap: 'Categories with many endpoints but few healthy ones.',
  protocol_gap: 'Categories missing L402 or x402 coverage.',
  single_provider: 'Categories dependent on a single provider.',
  failing: 'Categories with multiple down endpoints.',
}

function opportunityCard(opp) {
  const protoCoverage = `L402: ${opp.protocol_coverage.L402} | x402: ${opp.protocol_coverage.x402}`
  return `
    <div class="opportunity-card">
      <div class="opp-category">${escapeHtml(opp.category)}</div>
      <div class="opp-stats">
        <span>${opp.healthy_endpoints}/${opp.total_endpoints} healthy</span>
        <span>${protoCoverage}</span>
        <span>${opp.provider_count} provider${opp.provider_count !== 1 ? 's' : ''}</span>
      </div>
      <div class="opp-suggestion">${escapeHtml(opp.suggestion)}</div>
    </div>`
}

export function opportunitiesPage({ opportunities, protocol }) {
  const grouped = {}
  for (const opp of opportunities) {
    if (!grouped[opp.type]) grouped[opp.type] = []
    grouped[opp.type].push(opp)
  }

  const sections = Object.entries(grouped).map(([type, opps]) => `
    <section class="opp-section">
      <h2>${TYPE_LABELS[type] || type}</h2>
      <p class="opp-desc">${TYPE_DESCRIPTIONS[type] || ''}</p>
      <div class="opp-grid">
        ${opps.map(o => opportunityCard(o)).join('')}
      </div>
    </section>
  `).join('')

  const content = `
    <div class="container">
      <h1>Ecosystem Opportunities</h1>
      <p>Gaps in the 402 Index ecosystem where new providers can make an impact.</p>

      <form method="get" class="filter-form">
        <label>Protocol:
          <select name="protocol" onchange="this.form.submit()">
            <option value="">All</option>
            <option value="L402"${protocol === 'L402' ? ' selected' : ''}>L402</option>
            <option value="x402"${protocol === 'x402' ? ' selected' : ''}>x402</option>
          </select>
        </label>
      </form>

      ${opportunities.length === 0 ? '<p>No opportunities found. The ecosystem is well-covered!</p>' : sections}

      <style>
        .opp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; margin: 1rem 0 2rem; }
        .opportunity-card { background: var(--card-bg, #1a1b23); border: 1px solid var(--border, #2a2b35); border-radius: 8px; padding: 1rem; }
        .opp-category { font-weight: 600; font-size: 1.1rem; margin-bottom: 0.5rem; color: var(--accent, #6366f1); }
        .opp-stats { display: flex; gap: 1rem; font-size: 0.85rem; color: var(--text-muted, #8b8d97); margin-bottom: 0.5rem; flex-wrap: wrap; }
        .opp-suggestion { font-size: 0.9rem; line-height: 1.4; }
        .opp-section { margin-bottom: 2rem; }
        .opp-desc { color: var(--text-muted, #8b8d97); margin-top: -0.5rem; }
        .filter-form { margin: 1rem 0 2rem; }
        .filter-form select { padding: 0.3rem 0.5rem; background: var(--card-bg, #1a1b23); color: inherit; border: 1px solid var(--border, #2a2b35); border-radius: 4px; }
      </style>
    </div>`

  return layout('Opportunities', content)
}
