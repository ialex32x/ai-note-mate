import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { IChatAgent } from '../../services/chat-stream';
import { getGlobalEmbedder, type EmbedderStatus } from '../../services/embedder';
import type { MCPManager } from '../../services/mcp/mcp-manager';
import type { MCPServerStatus } from '../../services/mcp/mcp-types';
import type { ArtifactStoreStats } from '../../services/artifact-store';
import { humanizeIdentifier } from '../../utils/humanize';

/**
 * High-level embedding state as seen from the session-status panel. This
 * combines static configuration (settings) with the runtime
 * {@link EmbedderStatus} so the UI can show a single, user-meaningful value:
 *
 * - `disabled`     — no active embedding config selected ("None" in settings).
 * - `unconfigured` — a config is selected, but required credentials such as
 *                    `baseUrl` / `apiKey` are empty.
 * - everything else — fall through to the runtime embedder status.
 */
export interface EmbeddingPanelInfo {
    /** `true` when an active embedding config is selected in settings. */
    enabled: boolean;
    /**
     * `true` when the active embedding config exists and has all required
     * credentials filled in. For Gemini, only `apiKey` is required; for
     * OpenAI-compatible providers, both `baseUrl` and `apiKey` are required.
     * Ignored when {@link enabled} is `false`.
     */
    configured: boolean;
}

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
     * Compact byte formatter for the Artifacts section.
     * `0` -> "0 B", `4096` -> "4.0 KB", `1_572_864` -> "1.5 MB".
     * Kept separate from {@link formatCompact} (which is unit-less) so we
     * don't lose the explicit "B / KB / MB" suffix on small numbers.
     */
    static formatBytes(n: number): string {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * Render or update a percentage-ring indicator inside `el`.
     *
     * The ring is an inline SVG circle whose stroke fills proportionally
     * to `lastCallTotal / maxTokens`. The centre shows the percentage;
     * the tooltip shows the exact `total / max` breakdown. When the
     * per-call total is unavailable (`lastCallTotalTokens` is `undefined`
     * or 0) the ring renders at 0 % and is visually muted.
     *
     * Callers should pass the same `el` on every update — this method
     * replaces its contents but preserves the element identity so the
     * parent layout is not disrupted.
     */
    static renderContextRing(
        el: HTMLElement,
        chat: IChatAgent,
        maxTokens: number,
        tooltipText: string,
    ): void {
        el.empty();

        const lastCallTotal = chat.sessionTokenUsage.lastCallTotalTokens ?? 0;
        const pct = maxTokens > 0 && lastCallTotal > 0
            ? Math.round((lastCallTotal / maxTokens) * 100)
            : 0;

        // Don't show the ring when usage is negligible (≤3%).
        if (pct <= 3) { return; }

        // Colour tiers: ≤50 green, ≤80 amber, >80 red
        let colourVar: string;
        if (pct <= 50) {
            colourVar = 'var(--text-success)';
        } else if (pct <= 80) {
            colourVar = 'var(--text-warning)';
        } else {
            colourVar = 'var(--text-error)';
        }

        // The outer ring circumference ≈ 2π × 15.9 ≈ 99.9
        const circumference = 99.9;
        const dashOffset = circumference - (circumference * pct) / 100;

        const wrapper = el.createEl('span', { cls: 'session-context-ring' });
        if (tooltipText) {
            setTooltip(wrapper, tooltipText);
        }

        const NS = 'http://www.w3.org/2000/svg';
        const doc = activeDocument;

        const svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.classList.add('session-context-ring__svg');
        wrapper.appendChild(svg);

        // Background track
        const track = doc.createElementNS(NS, 'circle');
        track.setAttribute('cx', '18');
        track.setAttribute('cy', '18');
        track.setAttribute('r', '15.9');
        track.setAttribute('fill', 'none');
        track.setAttribute('stroke', 'var(--text-faint)');
        track.setAttribute('stroke-width', '2.5');
        track.classList.add('session-context-ring__track');
        svg.appendChild(track);

        // Foreground arc (only when there's meaningful data)
        if (pct > 0) {
            const arc = doc.createElementNS(NS, 'circle');
            arc.setAttribute('cx', '18');
            arc.setAttribute('cy', '18');
            arc.setAttribute('r', '15.9');
            arc.setAttribute('fill', 'none');
            arc.setAttribute('stroke', colourVar);
            arc.setAttribute('stroke-width', '2.5');
            arc.setAttribute('stroke-linecap', 'round');
            arc.setAttribute('stroke-dasharray', `${circumference}`);
            arc.setAttribute('stroke-dashoffset', `${dashOffset}`);
            arc.setAttribute('transform', 'rotate(-90 18 18)');
            arc.classList.add('session-context-ring__arc');
            svg.appendChild(arc);
        }

        // Centre percentage text
        const text = doc.createElementNS(NS, 'text');
        text.setAttribute('x', '18');
        text.setAttribute('y', '18');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('fill', colourVar);
        // SVG renders at 16×16 px but viewBox is 36×36 units;
        // scale factor ≈ 0.444, so use ~16–18 units to get ~7–8 px on screen.
        text.setAttribute('font-size', `${pct >= 100 ? 14 : 18}`);
        text.classList.add('session-context-ring__text');
        text.textContent = `${pct}`;
        svg.appendChild(text);
    }

    /**
     * Render the compact top-toolbar indicator into `el`.
     * Primary metric: token usage (with optional max).
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
        valueRow.setText(this.formatCompact(totalTokens));
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
     * @param embeddingInfo Optional embedding feature snapshot. Drives the
     *                    Embedding row inside the "Session" section.
     * @param artifactStats Optional snapshot from
     *                    `SessionRuntime.artifactStore.stats()`. When
     *                    provided, an "Artifacts" section surfaces the live
     *                    entry count, byte usage, and tombstone count. This
     *                    is purely runtime state (not persisted) — sourced
     *                    fresh on every panel open.
     */
    static renderPanel(
        el: HTMLElement,
        chat: IChatAgent,
        maxTokens: number,
        mcpManager?: MCPManager | null,
        embeddingInfo?: EmbeddingPanelInfo,
        artifactStats?: ArtifactStoreStats | null,
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

            this.renderRow(
                section,
                t('statusLabel.total'),
                this.formatCompact(usage.totalTokens),
                usage.totalTokens.toLocaleString(),
            );
        });

        // ── Agents section ───────────────────────────────────────────────
        // Only shown when the chat exposes a per-agent breakdown (multi-agent mode).
        const breakdown = chat.agentTokenBreakdown;
        if (breakdown && Object.keys(breakdown.subAgents).length > 0) {
            this.renderSection(el, t('status.agentsSection'), (section) => {
                this.renderRow(
                    section,
                    'Orchestrator',
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

            // Embedder status row.
            //
            // Display priority (highest first):
            //   1. `disabled`     — user turned the feature off in settings.
            //   2. `unconfigured` — feature is on, but credentials are missing.
            //   3. runtime embedder status (`unused` / `ok` / `unavailable`),
            //      shown as an icon with a tooltip describing the state.
            //
            // (1) and (2) are static states derived from settings, so they are
            // rendered as plain localized text rather than an icon, since
            // they're not really "live" indicators.
            if (embeddingInfo && !embeddingInfo.enabled) {
                this.renderRow(
                    section,
                    t('statusLabel.embedding'),
                    t('statusValue.embeddingDisabled'),
                    t('statusTooltip.embeddingDisabled'),
                );
            } else if (embeddingInfo && !embeddingInfo.configured) {
                this.renderRow(
                    section,
                    t('statusLabel.embedding'),
                    t('statusValue.embeddingUnconfigured'),
                    t('statusTooltip.embeddingUnconfigured'),
                );
            } else {
                // Runtime status: shown as an icon only (no localized text).
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
            }
        });

        // ── Artifacts section ────────────────────────────────────────────
        // Pure runtime view of `SessionRuntime.artifactStore`. Surfaces the
        // three fields exposed by `ArtifactStore.stats()`:
        //   - liveCount       (number of recoverable entries)
        //   - liveBytes       (their total serialized byte usage)
        //   - diskIndexCount  (entries on disk or evicted, kept for recall hints)
        //
        // Hidden when the store is fully empty so the panel stays focused
        // for sessions that never spilled an artifact. We treat
        // `liveCount === 0 && diskIndexCount === 0` as "nothing to show";
        // a non-zero `liveBytes` without a live count is impossible.
        if (artifactStats && (artifactStats.liveCount > 0 || artifactStats.diskIndexCount > 0)) {
            this.renderSection(el, t('status.artifactsSection'), (section) => {
                this.renderRow(
                    section,
                    t('statusLabel.artifactsLive'),
                    artifactStats.liveCount.toLocaleString(),
                    t('statusTooltip.artifactsLive'),
                );
                this.renderRow(
                    section,
                    t('statusLabel.artifactsBytes'),
                    this.formatBytes(artifactStats.liveBytes),
                    `${artifactStats.liveBytes.toLocaleString()} B`,
                );
                this.renderRow(
                    section,
                    t('statusLabel.artifactsTombstones'),
                    artifactStats.diskIndexCount.toLocaleString(),
                    t('statusTooltip.artifactsTombstones'),
                );
            });
        }

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
