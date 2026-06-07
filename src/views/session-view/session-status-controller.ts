import type { IChatAgent } from '../../services/chat-stream';
import type { MCPManager } from '../../services/mcp/mcp-manager';
import type { ArtifactStoreStats } from '../../services/artifact-store';
import type { SessionManager } from '../../session-manager';
import { getActiveEmbeddingConfig, getActiveProfile } from '../../settings';
import type { NoteAssistantPluginSettings } from '../../settings/types';
import { inferModelContextWindow } from '../../services/model-context-window';
import { SessionStatusDisplay, type EmbeddingPanelInfo } from '../../components/session';
import type { DropdownManager } from '../../components/session/dropdown-manager';
import { updateSessionTitle as renderSessionTitle, handleTitleClick } from './session-title-editor';

export interface SessionStatusControllerDeps {
    sessionTitleEl: HTMLElement;
    sessionStatusEl: HTMLElement;
    sessionStatusMainEl: HTMLElement;
    sessionStatusPanelEl: HTMLElement;
    sessionManager: SessionManager;
    mcpManager: MCPManager | undefined;
    settings: NoteAssistantPluginSettings;
    dropdownManager: DropdownManager;
    /** Accessor for the current chat agent; may return undefined. */
    chat: () => IChatAgent | undefined;
    /** Accessor for artifact store stats; may return null. */
    artifactStats: () => ArtifactStoreStats | null;
    /** Whether the session is currently streaming. */
    isStreaming: () => boolean;
}

/**
 * Manages the toolbar session title and the session-status indicator
 * (compact context-usage badge and detailed dropdown panel).
 *
 * Owns the DOM element references and all rendering logic so the view
 * delegates to this controller instead of operating on DOM fields directly.
 */
export class SessionStatusController {
    private readonly deps: SessionStatusControllerDeps;

    /**
     * MCP-manager change listener that refreshes the session-status
     * panel while it is open. Registered in the constructor and
     * unregistered in {@link dispose}.
     */
    private _onMcpStateChanged: (() => void) | null = null;

    constructor(deps: SessionStatusControllerDeps) {
        this.deps = deps;

        // Wire MCP state listener so connection/disconnection events
        // update the panel live without requiring a manual reopen.
        if (deps.mcpManager) {
            const mcp = deps.mcpManager;
            this._onMcpStateChanged = () => {
                const chat = deps.chat();
                if (!chat) return;
                if (!deps.dropdownManager.isActive(deps.sessionStatusEl)) return;
                const profile = getActiveProfile(deps.settings);
                const max = profile.maxTokens > 0
                    ? profile.maxTokens
                    : inferModelContextWindow(profile.model);
                SessionStatusDisplay.renderPanel(
                    deps.sessionStatusPanelEl,
                    chat,
                    max,
                    mcp,
                    this.computeEmbeddingPanelInfo(),
                    deps.artifactStats(),
                );
            };
            mcp.onChange(this._onMcpStateChanged);
        }
    }

    // ── Title ──────────────────────────────────────────────────────────

    /** Refresh the toolbar title element from the active session. */
    updateTitle(): void {
        renderSessionTitle(this.deps.sessionTitleEl, this.deps.sessionManager);
    }

    /** Handle click on session title to enable inline renaming. */
    handleTitleClick(container: HTMLElement): void {
        handleTitleClick({
            container,
            sessionTitleEl: this.deps.sessionTitleEl,
            sessionManager: this.deps.sessionManager,
            isStreaming: this.deps.isStreaming,
            refreshDisplay: () => this.updateTitle(),
        });
    }

    // ── Status display ─────────────────────────────────────────────────

    /**
     * Refresh the session-status indicator in the input toolbar:
     * the compact context-usage badge and (when open) the detailed
     * dropdown panel.
     */
    updateStatusDisplay(): void {
        const chat = this.deps.chat();
        if (!chat) {
            this.deps.sessionStatusMainEl.empty();
            if (this.deps.dropdownManager.isActive(this.deps.sessionStatusEl)) {
                this.deps.sessionStatusPanelEl.empty();
            }
            return;
        }

        const profile = getActiveProfile(this.deps.settings);
        const max = profile.maxTokens > 0
            ? profile.maxTokens
            : inferModelContextWindow(profile.model);

        SessionStatusDisplay.render(this.deps.sessionStatusMainEl, chat, max);

        // Keep the panel in sync when it is currently open.
        if (this.deps.dropdownManager.isActive(this.deps.sessionStatusEl)) {
            SessionStatusDisplay.renderPanel(
                this.deps.sessionStatusPanelEl,
                chat,
                max,
                this.deps.mcpManager ?? null,
                this.computeEmbeddingPanelInfo(),
                this.deps.artifactStats(),
            );
        }
    }

    /**
     * Snapshot of the embedding feature's high-level state for the
     * session-status panel. We only consider it "configured" when both
     * the active config exists and its required credentials are
     * non-empty:
     *
     *   - For Gemini, only `apiKey` is required (`baseUrl` is ignored).
     *   - For OpenAI-compatible providers, both `baseUrl` and `apiKey`.
     *
     * When no active config is selected ("None" in the global dropdown,
     * i.e. `activeEmbeddingId` is empty), the feature is treated as
     * disabled.
     */
    computeEmbeddingPanelInfo(): EmbeddingPanelInfo {
        const settings = this.deps.settings;
        if (!settings.activeEmbeddingId) {
            return { enabled: false, configured: false };
        }
        const config = getActiveEmbeddingConfig(settings);
        if (!config) {
            return { enabled: true, configured: false };
        }
        const apiKey = config.apiKey?.trim() ?? '';
        const baseUrl = config.baseUrl?.trim() ?? '';
        const needsBaseUrl = config.type !== 'gemini';
        const configured = apiKey.length > 0 && (!needsBaseUrl || baseUrl.length > 0);
        return { enabled: true, configured };
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /** Unregister the MCP state listener. Call before the view tears down. */
    dispose(): void {
        if (this._onMcpStateChanged && this.deps.mcpManager) {
            this.deps.mcpManager.offChange(this._onMcpStateChanged);
            this._onMcpStateChanged = null;
        }
    }
}
