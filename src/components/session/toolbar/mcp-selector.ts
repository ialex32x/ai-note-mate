import { setIcon, setTooltip, IconName } from 'obsidian';
import { t } from '../../../i18n';
import { DropdownManager } from '../dropdown-manager';
import type NoteAssistantPlugin from 'main';

export interface McpSelectorHandle {
    /** Currently enabled server IDs (live reference; do not mutate from outside) */
    getEnabledServers(): Set<string>;
    /** Clear all per-session MCP selections (called during session switch) */
    reset(): void;
    /** Unsubscribe from MCP manager state changes */
    dispose(): void;
}

function getMcpStatusIcon(status: string): { iconName: IconName; iconColor: string } {
    switch (status) {
        case 'connected':
            return { iconName: 'check-circle', iconColor: 'mod-success' };
        case 'connecting':
            return { iconName: 'loader', iconColor: 'mod-muted' };
        case 'error':
            return { iconName: 'alert-circle', iconColor: 'mod-error' };
        default:
            return { iconName: 'x-circle', iconColor: 'mod-muted' };
    }
}

/**
 * Setup MCP tools selector using DropdownManager.
 * Extracted from SessionView.setupMcpSelector.
 *
 * Owns per-session MCP selection state:
 * - enabledServers: reflect current user selection (server-level toggle)
 * When a server is enabled, all its tools are automatically enabled.
 */
export function createMcpSelector(
    parent: HTMLElement,
    plugin: NoteAssistantPlugin,
    dropdownManager: DropdownManager,
): McpSelectorHandle {
    const enabledServers: Set<string> = new Set();

    const mcpWrapper = parent.createEl('span', { cls: 'session-selector session-mcp-tools' });
    const { button, textEl } = DropdownManager.createButton({
        parent: mcpWrapper,
        cls: 'session-dropdown-btn',
        ariaLabel: t('view.mcpTools'),
        icon: 'plug',
    });
    const mcpBtnEl = button;
    const mcpBtnTextEl = textEl;
    mcpBtnTextEl.setText(t('view.mcpTools'));

    const mcpDropdown = mcpWrapper.createEl('div', { cls: 'session-dropdown-menu' });

    const rebuildMcpDropdown = () => {
        mcpDropdown.empty();
        const states = plugin.mcpManager?.getServerStates() ?? [];

        if (states.length === 0) {
            mcpDropdown.createEl('div', { cls: 'session-empty-state', text: t('view.mcpNoServers') });
            return;
        }

        // Rebuild enabledServers from current checkbox state.
        // Programmatic `.checked = true` does NOT fire the `change` event,
        // so we must synchronise the Set ourselves after setting visual state.
        const newEnabledServers = new Set<string>();

        for (const serverState of states) {
            const sid = serverState.config.id;
            const isConnected = serverState.status === 'connected' && serverState.tools.length > 0;
            const serverItem = mcpDropdown.createEl('div', { cls: 'session-mcp-tools__server-item' });

            const serverCb = serverItem.createEl('input', { attr: { type: 'checkbox' } });
            if (!isConnected) serverCb.disabled = true;

            const shouldEnable = isConnected && enabledServers.has(sid);
            serverCb.checked = shouldEnable;

            // Sync data state with visual state
            if (shouldEnable) {
                newEnabledServers.add(sid);
            }

            serverCb.addEventListener('change', () => {
                if (serverCb.checked) {
                    enabledServers.add(sid);
                } else {
                    enabledServers.delete(sid);
                }
            });

            const serverLabel = serverItem.createEl('label', {
                cls: 'session-mcp-tools__server-label',
                text: serverState.config.name,
            });
            serverLabel.prepend(serverCb);

            // Status icon
            const statusIcon = serverItem.createEl('span', { cls: 'session-mcp-tools__status-icon' });
            const { iconName, iconColor } = getMcpStatusIcon(serverState.status);
            setIcon(statusIcon, iconName);
            if (iconColor) statusIcon.addClass(iconColor);

            // Tool count badge
            serverItem.createEl('span', {
                cls: 'session-mcp-tools__count',
                text: String(serverState.tools.length),
            });

            // Collapse toggle button (chevron, default collapsed)
            const collapseBtn = serverItem.createEl('span', {
                cls: 'session-mcp-tools__collapse-btn',
            });
            setIcon(collapseBtn, 'chevron-down');
            setTooltip(collapseBtn, t('view.mcpExpandTools'));

            // Tool list container (read-only, no checkboxes), default collapsed
            const toolListEl = mcpDropdown.createEl('div', {
                cls: 'session-mcp-tools__tool-list',
            });

            let expanded = false;
            collapseBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                expanded = !expanded;
                toolListEl.classList.toggle('session-mcp-tools__tool-list--expanded', expanded);
                collapseBtn.classList.toggle('session-mcp-tools__collapse-btn--expanded', expanded);
            });

            for (const tool of serverState.tools) {
                const toolItem = toolListEl.createEl('div', { cls: 'session-dropdown-item session-mcp-tools__tool-item' });
                const toolLabel = toolItem.createEl('span', {
                    cls: 'session-mcp-tools__tool-label',
                    text: tool.name,
                });
                setTooltip(toolLabel, tool.description ?? tool.name);
            }
        }

        // Replace the live Set with the rebuilt one
        enabledServers.clear();
        for (const id of newEnabledServers) enabledServers.add(id);
    };

    dropdownManager.registerToggle({
        wrapper: mcpWrapper,
        button: mcpBtnEl,
        dropdown: mcpDropdown,
        onOpen: rebuildMcpDropdown,
    });

    // Initialize the enabled Set immediately so that MCP tools are available
    // even before the user opens the dropdown for the first time.
    rebuildMcpDropdown();

    // Subscribe to MCP manager state changes
    const onMcpStateChanged = () => {
        // Full rebuild handles both disconnections (removing stale entries)
        // and new connections (adding newly available servers/tools).
        if (mcpDropdown.classList.contains('session-dropdown-menu--open')) {
            rebuildMcpDropdown();
        } else {
            // Dropdown is closed — update Set without rebuilding DOM
            const states = plugin.mcpManager?.getServerStates() ?? [];

            // Remove entries for servers that are no longer connected
            for (const sid of [...enabledServers]) {
                const state = states.find(s => s.config.id === sid);
                if (!state || state.status !== 'connected') {
                    enabledServers.delete(sid);
                }
            }

            // Auto-enable servers that just connected
            for (const state of states) {
                const sid = state.config.id;
                const isConnected = state.status === 'connected' && state.tools.length > 0;
                if (!isConnected || enabledServers.has(sid)) continue;

                enabledServers.add(sid);
            }
        }
    };
    plugin.mcpManager?.onChange(onMcpStateChanged);

    return {
        getEnabledServers: () => enabledServers,
        reset: () => {
            enabledServers.clear();
        },
        dispose: () => {
            plugin.mcpManager?.offChange(onMcpStateChanged);
        },
    };
}
