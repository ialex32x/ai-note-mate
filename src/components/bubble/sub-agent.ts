/**
 * Sub-agent presentation helpers.
 *
 * Maps an internal sub-agent name (e.g. `vault_inspector`) to the
 * human-readable label shown in the chat UI. Kept framework-free so the
 * bubble renderer and any other surface can resolve a label without
 * pulling in renderer state.
 */

/** Return a human-readable label for a sub-agent (e.g. `vault_inspector` → "Vault Reader"). */
export function getSubAgentLabel(agentName: string): string {
    switch (agentName) {
        case 'vault_inspector': return 'Vault Reader';
        case 'vault_editor': return 'Vault Editor';
        case 'web': return 'Web';
        case 'code': return 'Code';
        default: return agentName.startsWith('custom_') ? agentName.slice(7) : agentName;
    }
}
