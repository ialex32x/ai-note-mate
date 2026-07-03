import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { IChatAgent } from '../../services/chat-stream';
import { getGlobalEmbedder, type EmbedderStatus } from '../../services/embedder';
import type { MCPManager } from '../../services/mcp/mcp-manager';
import type { MCPServerStatus } from '../../services/mcp/mcp-types';
import type { ArtifactStoreStats } from '../../services/artifact-store';
import {
    computeContextPercent,
    formatContextTooltip,
    breakdownTotalTokens,
    formatBreakdownTokens,
    breakdownPercent,
    formatBreakdownPercent,
} from '../../utils/context-usage';
import { formatCompact, formatBytes } from '../../utils/format';
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
 * - `render()` renders the compact top-toolbar indicator (context usage ring).
 * - `renderPanel()` renders the structured pop-up panel shown when the user
 *   clicks the indicator. The panel is expected to be managed by the shared
 *   `DropdownManager` (click-to-open, click-outside-to-close).
 *
 * Adding a new session-status field later only requires extending
 * `renderPanel()`; the top-toolbar indicator stays focused on the primary
 * metric (context usage).
 */
export class SessionStatusDisplay {
    /**
     * Render the compact top-toolbar indicator into `el`.
     * Shows the single-turn context-window usage as a percentage
     * ring whose arc fills proportionally to usage. The centre
     * displays the percentage; the tooltip on hover reveals the
     * exact token breakdown.
     */
    static render(el: HTMLElement, chat: IChatAgent, maxTokens: number): void {
        const pct = computeContextPercent(chat, maxTokens);
        const tooltipText = formatContextTooltip(chat, maxTokens);

        el.empty();
        setTooltip(el, tooltipText || '');

        const container = el.createEl('div', { cls: 'session-status-display' });

        // Colour tiers: ≤50 green, ≤80 amber, >80 red; faint when empty
        let colourVar: string;
        if (pct <= 0) {
            colourVar = 'var(--text-faint)';
        } else if (pct <= 50) {
            colourVar = 'var(--text-success)';
        } else if (pct <= 80) {
            colourVar = 'var(--text-warning)';
        } else {
            colourVar = 'var(--text-error)';
        }

        // The outer ring circumference ≈ 2π × 15.9 ≈ 99.9
        const circumference = 99.9;
        const dashOffset = circumference - (circumference * pct) / 100;

        const wrapper = container.createEl('span', { cls: 'session-context-ring' });

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

        // Foreground arc
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

        // Centre percentage text (omit when usage rounds to 0, i.e. < 1%)
        if (pct >= 1) {
            const fontSize = pct >= 100 ? 14 : 18;
            // Optical vertical centering — numeral glyphs sit low within the
            // em-box even when dominant-baseline is "central".
            const yCenter = 18 - fontSize * 0.1;

            const text = doc.createElementNS(NS, 'text');
            text.setAttribute('transform', `translate(18 ${yCenter})`);
            text.setAttribute('x', '0');
            text.setAttribute('y', '0');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.setAttribute('fill', colourVar);
            // SVG renders at 16×16 px but viewBox is 36×36 units;
            // scale factor ≈ 0.444, so use ~16–18 units to get ~7–8 px on screen.
            text.setAttribute('font-size', `${fontSize}`);
            text.classList.add('session-context-ring__text');
            text.textContent = `${pct}`;
            svg.appendChild(text);
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
                formatCompact(usage.promptTokens),
                usage.promptTokens.toLocaleString(),
            );
            this.renderRow(
                section,
                t('statusLabel.completion'),
                formatCompact(usage.completionTokens),
                usage.completionTokens.toLocaleString(),
            );

            this.renderRow(
                section,
                t('statusLabel.total'),
                formatCompact(usage.totalTokens),
                usage.totalTokens.toLocaleString(),
            );

            // Single-turn context usage
            const ctxValue = formatContextTooltip(chat, maxTokens);
            if (ctxValue) {
                this.renderRow(
                    section,
                    t('statusLabel.context'),
                    ctxValue,
                );
            } else {
                this.renderRow(
                    section,
                    t('statusLabel.context'),
                    `0 / ${maxTokens > 0 ? formatCompact(maxTokens) : '—'} (0%)`,
                );
            }

            // Cached prompt tokens (prompt-cache hit, discounted/free)
            if (usage.cachedPromptTokens > 0) {
                const pct = usage.promptTokens > 0
                    ? Math.round((usage.cachedPromptTokens / usage.promptTokens) * 100)
                    : 0;
                this.renderRow(
                    section,
                    t('statusLabel.cachedPrompt'),
                    formatCompact(usage.cachedPromptTokens),
                    `${usage.cachedPromptTokens.toLocaleString()} (${pct}%)`,
                );
            }
        });

        // ── Context Composition section ────────────────────────────────────
        // Shows the last turn's estimated token split across context layers:
        // system prompt (memory/skills/baseline/suffix), conversation history,
        // summaries, and tool schemas.
        const ctxBreakdown = chat.contextBreakdown;
        if (ctxBreakdown) {
            const total = breakdownTotalTokens(ctxBreakdown);
            this.renderSection(el, t('status.contextCompositionSection'), (section) => {
                // System Prompt sub-group
                const sp = ctxBreakdown.systemPrompt;
                const spTotal = sp.memory + sp.skills + sp.baseline + sp.suffix;
                if (spTotal > 0) {
                    this.renderRow(
                        section,
                        t('statusLabel.systemPrompt'),
                        formatBreakdownTokens(spTotal),
                        `${spTotal.toLocaleString()} (${formatBreakdownPercent(breakdownPercent(spTotal, total))})`,
                    );
                    if (sp.memory > 0) {
                        this.renderRow(
                            section,
                            `  ${t('statusLabel.memory')}`,
                            formatBreakdownTokens(sp.memory),
                        );
                    }
                    if (sp.skills > 0) {
                        this.renderRow(
                            section,
                            `  ${t('statusLabel.skills')}`,
                            formatBreakdownTokens(sp.skills),
                        );
                    }
                    if (sp.baseline > 0) {
                        this.renderRow(
                            section,
                            `  ${t('statusLabel.systemPrompt')} (base)`,
                            formatBreakdownTokens(sp.baseline),
                        );
                    }
                    if (sp.suffix > 0) {
                        this.renderRow(
                            section,
                            `  ${t('statusLabel.suffix')}`,
                            formatBreakdownTokens(sp.suffix),
                        );
                    }
                }

                // Conversation history
                const conv = ctxBreakdown.conversation;
                const convTotal = conv.user + conv.assistant + conv.tool;
                if (convTotal > 0) {
                    this.renderRow(
                        section,
                        t('statusLabel.conversation'),
                        formatBreakdownTokens(convTotal),
                        `${convTotal.toLocaleString()} (${formatBreakdownPercent(breakdownPercent(convTotal, total))})`,
                    );
                }

                // Summaries
                if (ctxBreakdown.summaries > 0) {
                    this.renderRow(
                        section,
                        t('statusLabel.summaries'),
                        formatBreakdownTokens(ctxBreakdown.summaries),
                    );
                }

                // Tool schemas
                if (ctxBreakdown.toolSchemas > 0) {
                    this.renderRow(
                        section,
                        t('statusLabel.toolSchemas'),
                        formatBreakdownTokens(ctxBreakdown.toolSchemas),
                    );
                }
            });
        }

        // ── Agents section ───────────────────────────────────────────────
        // Only shown when the chat exposes a per-agent breakdown (multi-agent mode).
        const breakdown = chat.agentTokenBreakdown;
        if (breakdown && Object.keys(breakdown.subAgents).length > 0) {
            this.renderSection(el, t('status.agentsSection'), (section) => {
                this.renderRow(
                    section,
                    'Orchestrator',
                    formatCompact(breakdown.main.totalTokens),
                    breakdown.main.totalTokens.toLocaleString(),
                );
                // Sub-agent rows: label uses the raw agent name (a stable
                // English id tied to tool dispatch, not a translatable string).
                for (const [name, u] of Object.entries(breakdown.subAgents)) {
                    this.renderRow(
                        section,
                        humanizeIdentifier(name),
                        formatCompact(u.totalTokens),
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
                // Runtime status. Only rendered when the embedder singleton has
                // been initialized.
                //
                // When working normally (`ok`), show the estimated token ratio
                // (API calls / total processed) as a compact value so the user
                // can see how much the cache is saving. For other states
                // (`unused`, `unavailable`), keep the icon-only approach.
                const embedder = getGlobalEmbedder();
                if (embedder) {
                    const status = embedder.status;
                    if (status === 'ok') {
                        const api = formatCompact(embedder.apiTokenCount);
                        const total = formatCompact(embedder.totalTokenCount);
                        this.renderRow(
                            section,
                            t('statusLabel.embedding'),
                            t('statusValue.embeddingTokens', { api, total }),
                            t('statusTooltip.embeddingTokens', {
                                apiExact: embedder.apiTokenCount.toLocaleString(),
                                totalExact: embedder.totalTokenCount.toLocaleString(),
                            }),
                        );
                    } else {
                        this.renderIconRow(
                            section,
                            t('statusLabel.embedding'),
                            this.iconForEmbedderStatus(status),
                            this.tooltipForEmbedderStatus(status, embedder.lastErrorMessage),
                        );
                    }
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
                    formatBytes(artifactStats.liveBytes),
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
