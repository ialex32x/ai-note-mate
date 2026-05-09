import { setTooltip } from 'obsidian';
import { t } from '../../../i18n';
import { DropdownManager } from '../dropdown-manager';
import type { ToolCapability } from '../../../services/llm-provider';
import { ALL_TOOL_CAPABILITIES } from '../../../services/llm-provider';

export interface CapabilitiesSelectorHandle {
    getAllowed(): ToolCapability[];
    /** Update UI to reflect an externally-changed allowed list (e.g. from settings tab). */
    setAllowed(allowed: ToolCapability[]): void;
}

export interface CapabilitiesSelectorOptions {
    /** Initial allowed capabilities. Falls back to all capabilities when omitted. */
    initial?: ToolCapability[];
    /**
     * Invoked whenever the user toggles a capability.
     * The handler receives the latest allowed list (a fresh array copy).
     */
    onChange?: (allowed: ToolCapability[]) => void;
}

/**
 * Setup capabilities selector using DropdownManager.
 * Extracted from SessionView.setupCapabilitiesSelector.
 */
export function createCapabilitiesSelector(
    parent: HTMLElement,
    dropdownManager: DropdownManager,
    options: CapabilitiesSelectorOptions = {},
): CapabilitiesSelectorHandle {
    // Normalize the initial selection against the canonical capability list
    // so stale/unknown entries from old settings don't leak into the UI.
    const normalize = (list: ToolCapability[] | undefined): ToolCapability[] => {
        const set = new Set<ToolCapability>(
            (list ?? ALL_TOOL_CAPABILITIES).filter(
                (c): c is ToolCapability => ALL_TOOL_CAPABILITIES.includes(c),
            ),
        );
        return ALL_TOOL_CAPABILITIES.filter(c => set.has(c));
    };
    const allowedCapabilities: ToolCapability[] = normalize(options.initial);

    const capabilitiesWrapper = parent.createEl('span', { cls: 'session-selector session-capabilities' });
    const { button, textEl } = DropdownManager.createButton({
        parent: capabilitiesWrapper,
        cls: 'session-dropdown-btn',
        ariaLabel: t('view.permissions'),
        icon: 'shield-ellipsis',
    });
    const capabilitiesBtnText = textEl;

    const capabilitiesDropdown = capabilitiesWrapper.createEl('div', {
        cls: 'session-dropdown-menu',
    });

    const capabilityOptions: Array<{ value: ToolCapability; label: string; tip: string }> = [
        { value: 'read_file', label: t('view.capReadFile'), tip: t('view.capReadFileTip') },
        { value: 'write_file', label: t('view.capWriteFile'), tip: t('view.capWriteFileTip') },
        { value: 'create_file', label: t('view.capCreateFile'), tip: t('view.capCreateFileTip') },
        { value: 'delete_file', label: t('view.capDeleteFile'), tip: t('view.capDeleteFileTip') },
        { value: 'network', label: t('view.capNetwork'), tip: t('view.capNetworkTip') },
        { value: 'multimodal_generate', label: t('view.capMultimodalGenerate'), tip: t('view.capMultimodalGenerateTip') },
        { value: 'execute', label: t('view.capExecute'), tip: t('view.capExecuteTip') },
    ];

    const capabilityCheckboxes: Map<ToolCapability, HTMLInputElement> = new Map();

    const updateBtnText = () => {
        const total = ALL_TOOL_CAPABILITIES.length;
        const selected = allowedCapabilities.length;
        if (selected === total) {
            capabilitiesBtnText.setText(t('view.permissionsAll'));
        } else if (selected === 0) {
            capabilitiesBtnText.setText(t('view.permissionsNone'));
        } else {
            capabilitiesBtnText.setText(`${selected}/${total}`);
        }
    };

    updateBtnText();

    for (const cap of capabilityOptions) {
        const itemEl = capabilitiesDropdown.createEl('label', { cls: 'session-dropdown-item' });
        setTooltip(itemEl, cap.tip);
        const checkbox = itemEl.createEl('input', { attr: { type: 'checkbox', value: cap.value } });
        checkbox.checked = allowedCapabilities.includes(cap.value);
        capabilityCheckboxes.set(cap.value, checkbox);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                if (!allowedCapabilities.includes(cap.value)) {
                    allowedCapabilities.push(cap.value);
                }
            } else {
                const idx = allowedCapabilities.indexOf(cap.value);
                if (idx >= 0) allowedCapabilities.splice(idx, 1);
            }
            updateBtnText();
            options.onChange?.([...allowedCapabilities]);
        });
        itemEl.createEl('span', { text: cap.label });
    }

    dropdownManager.registerToggle({
        wrapper: capabilitiesWrapper,
        button,
        dropdown: capabilitiesDropdown,
    });

    return {
        getAllowed: () => [...allowedCapabilities],
        setAllowed: (allowed: ToolCapability[]) => {
            const normalized = normalize(allowed);
            // Check if anything actually changed; avoid unnecessary DOM work.
            if (
                normalized.length === allowedCapabilities.length
                && normalized.every((c, i) => allowedCapabilities[i] === c)
            ) {
                return;
            }
            allowedCapabilities.length = 0;
            allowedCapabilities.push(...normalized);
            for (const [cap, checkbox] of capabilityCheckboxes) {
                const shouldCheck = allowedCapabilities.includes(cap);
                if (checkbox.checked !== shouldCheck) {
                    checkbox.checked = shouldCheck;
                }
            }
            updateBtnText();
        },
    };
}
