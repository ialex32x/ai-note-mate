import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { IChatAgent } from '../../services/chat-stream';
import { getGlobalEmbedder, type EmbedderStatus } from '../../services/embedder';
import type { MCPManager } from '../../services/mcp/mcp-manager';
import type { MCPServerStatus } from '../../services/mcp/mcp-types';
import { humanizeIdentifier } from '../../utils/humanize';

/**
 * Session status display (top toolbar).
 *
 * - `render()` renders the compact top-toolbar indicator (token usage).
 * - `renderPanel()` renders the structured pop-up panel shown when the user
 *   clicks the indicator. The panel is expected to be managed by the shared
 *   `DropdownManager` (click-to-open, click-outside-to-close).
 *
 * Adding a new session-status field later only requires extending
 * `renderPanel()`; the top-toolbar indicator stays focused on the primary
 * metric (token usage).
 */
export class SessionStatusDisplay {
    /** Compact number formatter: 12345 -> "12.3K", 1_200_000 -> "1.2M" */
    static formatCompact(n: number): string {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return String(n);
    }

    /**
     * Render the compact top-toolbar indicator into `el`.
     * Primary metric: token usage (with optional max / percentage).
     */
    static render(el: HTMLElement, chat: IChatAgent, maxTokens: number): void {
        const { totalTokens } = chat.sessionTokenUsage;

        el.empty();

        const container = el.createEl('div', { cls: 'session-status-display' });

        // Icon
        const iconRow = container.createEl('span', { cls: 'session-status-display__icon' });
        setIcon(iconRow, 'activity');

        // Value: primary indicator (token usage)
        const valueRow = container.createEl('span', { cls: 'session-status-display__value' });
        if (maxTokens > 0) {
            const pct = Math.round((totalTokens / maxTokens) * 100);
            valueRow.setText(`${this.formatCompact(totalTokens)} / ${this.formatCompact(maxTokens)} (${pct}%)`);
        } else {
            valueRow.setText(this.formatCompact(totalTokens));
        }
    }

    /**
     * Render the structured session-status panel into `el`.
     * `el` is expected to be the dropdown body (already styled with
     * `.session-dropdown-menu .session-dropdown-menu--toolbar .session-status-panel`).
     *
     * Adding a new section: push another block inside this method.
     *
     * @param mcpManager  Optional MCP manager. When provided, an "MCP servers"
     *                    section is appended that lists each configured server
     *                    and its current connection status. This is a live
     *                    view only (not persisted) — the panel is re-rendered
     *                    on demand from the manager's current state.
     */
    static renderPanel(
        el: HTMLElement,
        chat: IChatAgent,
        maxTokens: number,
        mcpManager?: MCPManager | null,
    ): void {
        el.empty();

        const usage = chat.sessionTokenUsage;

        // ── Token Usage section ──────────────────────────────────────────
        this.renderSection(el, t('status.tokenSection'), (section) => {
            this.renderRow(
                section,
                t('statusLabel.prompt'),
                this.formatCompact(usage.promptTokens),
                usage.promptTokens.toLocaleString(),
            );
            this.renderRow(
                section,
                t('statusLabel.completion'),
                this.formatCompact(usage.completionTokens),
                usage.completionTokens.toLocaleString(),
            );

            let totalText = this.formatCompact(usage.totalTokens);
            let totalTooltip = usage.totalTokens.toLocaleString();
            if (maxTokens > 0) {
                const pct = Math.round((usage.totalTokens / maxTokens) * 100);
                totalText = `${this.formatCompact(usage.totalTokens)} / ${this.formatCompact(maxTokens)} (${pct}%)`;
                totalTooltip = `${usage.totalTokens.toLocaleString()} / ${maxTokens.toLocaleString()} (${pct}%)`;
            }
            this.renderRow(section, t('statusLabel.total'), totalText, totalTooltip);
        });

        // ── Agents section ───────────────────────────────────────────────
        // Only shown when the chat exposes a per-agent breakdown (multi-agent mode).
        const breakdown = chat.agentTokenBreakdown;
        if (breakdown && Object.keys(breakdown.subAgents).length > 0) {
            this.renderSection(el, t('status.agentsSection'), (section) => {
                this.renderRow(
                    section,
                    t('statusLabel.mainAgent'),
                    this.formatCompact(breakdown.main.totalTokens),
                    breakdown.main.totalTokens.toLocaleString(),
                );
                // Sub-agent rows: label uses the raw agent name (a stable
                // English id tied to tool dispatch, not a translatable string).
                for (const [name, u] of Object.entries(breakdown.subAgents)) {
                    this.renderRow(
                        section,
                        humanizeIdentifier(name),
                        this.formatCompact(u.totalTokens),
                        u.totalTokens.toLocaleString(),
                    );
                }
            });
        }

        // ── Session section ────────────────────────────────────────────
        this.renderSection(el, t('status.sessionSection'), (section) => {
            this.renderRow(section, t('statusLabel.messages'), chat.messages.length.toLocaleString());
            const summariesCount = chat.summaries?.length ?? 0;
            this.renderRow(section, t('statusLabel.summaries'), summariesCount.toLocaleString());

            // Embedder status: shown as an icon only (no localized text).
            // A tooltip on hover conveys the textual meaning of the state.
            // Only rendered when the embedder singleton has been initialized.
            const embedder = getGlobalEmbedder();
            if (embedder) {
                this.renderIconRow(
                    section,
                    t('statusLabel.embedding'),
                    this.iconForEmbedderStatus(embedder.status),
                    this.tooltipForEmbedderStatus(embedder.status, embedder.lastErrorMessage),
                );
            }
        });

        // ── MCP servers section ──────────────────────────────────────────
        // Display-only view of configured MCP servers and their live
        // connection status. Sourced from `MCPManager` rather than the
        // chat session — this is not part of session persistence; we just
        // re-use the panel surface to expose runtime status.
        if (mcpManager) {
            const states = mcpManager.getServerStates();
            if (states.length > 0) {
                this.renderSection(el, t('status.mcpSection'), (section) => {
                    for (const state of states) {
                        this.renderIconRow(
                            section,
                            state.config.name || state.config.id,
                            this.iconForMcpStatus(state.status),
                            this.tooltipForMcpStatus(state.status, state.error),
                        );
                    }
                });
            }
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────

    /**
     * Map an {@link EmbedderStatus} to a Lucide icon id.
     * The status is expressed visually only — no localized text is used.
     */
    private static iconForEmbedderStatus(status: EmbedderStatus): string {
        switch (status) {
            case 'ok': return 'check-circle';
            case 'unavailable': return 'alert-circle';
            case 'unused':
            default: return 'circle-dashed';
        }
    }

    /**
     * Localized tooltip text corresponding to an {@link EmbedderStatus}.
     * Used on hover of the status icon to convey the icon's meaning.
     *
     * When the service is `unavailable`, a short reason (if known) is
     * appended on a new line so users have a hint at what went wrong.
     */
    private static tooltipForEmbedderStatus(
        status: EmbedderStatus,
        errorMessage?: string | null,
    ): string {
        switch (status) {
            case 'ok': return t('statusTooltip.embeddingOk');
            case 'unavailable': {
                const base = t('statusTooltip.embeddingUnavailable');
                return errorMessage ? `${base}\n${errorMessage}` : base;
            }
            case 'unused':
            default: return t('statusTooltip.embeddingUnused');
        }
    }

    /**
     * Map an {@link MCPServerStatus} to a Lucide icon id.
     * Mirrors the visual language used elsewhere for connection states:
     *   connected     -> check-circle
     *   connecting    -> loader (spinning is not animated here; status is
     *                    conveyed by shape + tooltip)
     *   error         -> alert-circle
     *   disconnected  -> circle-dashed
     */
    private static iconForMcpStatus(status: MCPServerStatus): string {
        switch (status) {
            case 'connected': return 'check-circle';
            case 'connecting': return 'loader';
            case 'error': return 'alert-circle';
            case 'disconnected':
            default: return 'circle-dashed';
        }
    }

    /**
     * Localized tooltip text for an {@link MCPServerStatus}.
     * For `error`, the server-reported message (if any) is appended on a
     * new line so users can diagnose connection failures.
     */
    private static tooltipForMcpStatus(
        status: MCPServerStatus,
        errorMessage?: string | null,
    ): string {
        switch (status) {
            case 'connected': return t('statusTooltip.mcpConnected');
            case 'connecting': return t('statusTooltip.mcpConnecting');
            case 'error': {
                const base = t('statusTooltip.mcpError');
                return errorMessage ? `${base}\n${errorMessage}` : base;
            }
            case 'disconnected':
            default: return t('statusTooltip.mcpDisconnected');
        }
    }    private static renderSection(
        parent: HTMLElement,
        title: string,
        body: (section: HTMLElement) => void,
    ): void {
        const section = parent.createEl('div', { cls: 'session-status-panel__section' });
        section.createEl('div', { cls: 'session-status-panel__title', text: title });
        body(section);
    }

    /**
     * Render a label/value row.
     *
     * If {@link tooltip} is provided, it is attached to the value element so
     * that hovering reveals extra detail (e.g. the exact number behind a
     * compact `K`/`M` abbreviation).
     */
    private static renderRow(
        parent: HTMLElement,
        label: string,
        value: string,
        tooltip?: string,
    ): void {
        const row = parent.createEl('div', { cls: 'session-status-panel__row' });
        row.createEl('span', { cls: 'session-status-panel__label', text: label });
        const valueEl = row.createEl('span', { cls: 'session-status-panel__value', text: value });
        if (tooltip) {
            setTooltip(valueEl, tooltip);
        }
    }

    /**
     * Render a row whose value is an icon rather than text.
     * Used for runtime status fields that should be conveyed visually.
     *
     * If {@link tooltip} is provided, it is attached to the icon element via
     * Obsidian's `setTooltip()` so the hover text explains what the icon means.
     */
    private static renderIconRow(
        parent: HTMLElement,
        label: string,
        iconId: string,
        tooltip?: string,
    ): void {
        const row = parent.createEl('div', { cls: 'session-status-panel__row' });
        row.createEl('span', { cls: 'session-status-panel__label', text: label });
        const valueEl = row.createEl('span', {
            cls: 'session-status-panel__value session-status-panel__value--icon',
        });
        setIcon(valueEl, iconId);
        if (tooltip) {
            setTooltip(valueEl, tooltip);
        }
    }
}
