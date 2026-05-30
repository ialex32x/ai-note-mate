import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../../i18n';
import { DropdownManager } from '../dropdown-manager';
import { getActiveProfile } from '../../../settings';
import { openPluginSettings } from '../../../utils/open-plugin-settings';
import { TEXT_GEN_SECTION_ID, IMAGE_GEN_SECTION_ID } from '../../../settings/section-ids';
import { getModelIconDef } from '../../../utils/model-icons';
import type { ModelIconDef, SvgDefElement } from '../../../utils/model-icons';
import type NoteAssistantPlugin from 'main';

export interface ProfileSelectorHandle {
    /** Remove settings-change subscription. Called from SessionView.onClose. */
    dispose(): void;
}

/**
 * Append a small gear button to a section header inside the profile
 * dropdown. Clicking it opens the plugin settings panel and scrolls to
 * the requested section, mirroring the deep-link entry points used by
 * onboarding tips. Closes the dropdown first so it doesn't dangle on
 * top of the (now focused) settings modal.
 */
function appendSectionSettingsAction(
    header: HTMLElement,
    plugin: NoteAssistantPlugin,
    dropdownManager: DropdownManager,
    sectionId: string,
) {
    const btn = header.createEl('button', {
        cls: 'session-dropdown-section-header__action',
        attr: { type: 'button', 'aria-label': t('view.openSettingsSection') },
    });
    setIcon(btn, 'settings');
    setTooltip(btn, t('view.openSettingsSection'));
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownManager.closeActive();
        openPluginSettings(plugin.app, plugin.manifest.id, sectionId);
    });
}

/** Minimal interface covering the runtime API of Obsidian-created SVG elements. */
interface SvgEl {
    createSvg(tag: string, options: { attr: Record<string, string> }): SvgEl;
}

/**
 * Recursively append a {@link SvgDefElement} tree into a parent SVG element.
 */
function appendSvgDefElement(parent: SvgEl, def: SvgDefElement): void {
    const el = parent.createSvg(def.tag, { attr: def.attr });
    if (def.children) {
        for (const child of def.children) {
            appendSvgDefElement(el, child);
        }
    }
}

/**
 * Build a vendor-logo SVG element from a {@link ModelIconDef} definition.
 *
 * Uses Obsidian's global {@link createSvg} function (declared in the
 * obsidian type definitions) to construct the element tree with the
 * correct SVG namespace — no innerHTML or DOMParser involved.
 *
 * The brand colour from the definition is applied directly as the SVG
 * fill / stroke value so CSS overrides (e.g. the generic `.icon-size`
 * mixin) cannot strip it.  Multi-colour icons may supply per-path
 * attribute overrides and {@code <defs>} children (gradients, etc.).
 */
function buildSvgIcon(def: ModelIconDef): SVGSVGElement {
    const svgAttrs: Record<string, string | number | boolean | null> = {
        viewBox: '0 0 24 24',
    };

    if (def.type === 'stroke') {
        svgAttrs.fill = 'none';
        svgAttrs.stroke = def.color;
        svgAttrs['stroke-width'] = '2';
        svgAttrs['stroke-linecap'] = 'round';
        svgAttrs['stroke-linejoin'] = 'round';
    } else {
        svgAttrs.fill = def.color;
    }

    // Global createSvg() — declared by obsidian types, available without import.
    const svg = createSvg('svg', { attr: svgAttrs });

    // Add <defs> if present (e.g. gradients for multi-colour logos)
    if (def.defs && def.defs.length > 0) {
        const defsEl = svg.createSvg('defs') as unknown as SvgEl;
        for (const defEntry of def.defs) {
            appendSvgDefElement(defsEl, defEntry);
        }
    }

    for (let i = 0; i < def.paths.length; i++) {
        const attrs: Record<string, string> = { d: def.paths[i]! };
        const override = def.pathAttrs?.[i];
        if (override) {
            Object.assign(attrs, override);
        }
        svg.createSvg('path', { attr: attrs });
    }

    return svg;
}

/**
 * Append a model-name span to `parent`.  When the model string matches a
 * known provider keyword the span is preceded by the vendor's logo SVG.
 */
function appendModelName(parent: HTMLElement, model: string): void {
    const def = getModelIconDef(model);
    if (def) {
        const iconEl = parent.createEl('span', { cls: 'session-dropdown-item__model-icon' });
        iconEl.appendChild(buildSvgIcon(def));
    }
    parent.createEl('span', { cls: 'session-dropdown-item__model', text: model });
}

/**
 * Setup profile selector using DropdownManager.
 * Extracted from SessionView.setupProfileSelector.
 *
 * Side effect: subscribes to plugin.onSettingsChange to keep button text in sync.
 * The returned handle exposes dispose() to unsubscribe.
 */
export function createProfileSelector(
    parent: HTMLElement,
    plugin: NoteAssistantPlugin,
    dropdownManager: DropdownManager,
): ProfileSelectorHandle {
    const profileWrapper = parent.createEl('span', { cls: 'session-selector session-profile-selector' });
    const { button, textEl } = DropdownManager.createButton({
        parent: profileWrapper,
        cls: 'session-dropdown-btn',
        ariaLabel: t('settings.textGenSection'),
    });
    const profileBtnEl = button;
    const profileBtnTextEl = textEl;

    const profileDropdownEl = profileWrapper.createEl('div', {
        cls: 'session-dropdown-menu',
    });

    const activeProfile = getActiveProfile(plugin.settings);
    profileBtnTextEl.setText(activeProfile.name);

    const rebuildProfileDropdown = () => {
        profileDropdownEl.empty();
        const current = plugin.settings;
        const currentActive = getActiveProfile(current);
        profileBtnTextEl.setText(currentActive.name);

        // Profiles Section
        const profilesHeader = profileDropdownEl.createEl('div', {
            cls: 'session-dropdown-section-header',
        });
        profilesHeader.createEl('span', { cls: 'session-dropdown-section-header__text', text: t('settings.textGenSection') });
        appendSectionSettingsAction(profilesHeader, plugin, dropdownManager, TEXT_GEN_SECTION_ID);

        // Effective insights extractor id: dedicated profile when set
        // and valid, otherwise the summarizer.
        const dedicatedInsightsId = current.insightsProfileId;
        const effectiveInsightsId =
            dedicatedInsightsId && current.profiles.some(pr => pr.id === dedicatedInsightsId)
                ? dedicatedInsightsId
                : current.summarizerProfileId;

        for (const p of current.profiles) {
            const item = profileDropdownEl.createEl('div', { cls: 'session-dropdown-item' });
            const checkIcon = item.createEl('span', { cls: 'session-dropdown-item__check' });
            item.createEl('span', { text: p.name });
            appendModelName(item, p.model);
            if (p.id === current.summarizerProfileId) {
                const badge = item.createEl('span', {
                    cls: 'session-dropdown-item__badge session-dropdown-item__badge--summarizer',
                });
                setIcon(badge, 'scroll-text');
                setTooltip(badge, t('view.profileSummarizerBadge'));
            }
            if (effectiveInsightsId && p.id === effectiveInsightsId) {
                const badge = item.createEl('span', {
                    cls: 'session-dropdown-item__badge session-dropdown-item__badge--insights',
                });
                setIcon(badge, 'lightbulb');
                setTooltip(badge, t('view.profileInsightsBadge'));
            }
            if (p.id === current.activeProfileId) {
                item.addClass('session-dropdown-item--active');
                setIcon(checkIcon, 'check');
            }
            item.addEventListener('click', () => {
                plugin.settings.activeProfileId = p.id;
                void plugin.saveSettings();
                profileBtnTextEl.setText(p.name);
                DropdownManager.updateActiveState(
                    profileDropdownEl.querySelectorAll('.session-dropdown-item'),
                    item,
                    'session-dropdown-item'
                );
                dropdownManager.closeActive();
            });
        }

        // Image Generation Section
        const imageGenHeader = profileDropdownEl.createEl('div', {
            cls: 'session-dropdown-section-header',
        });
        imageGenHeader.createEl('span', { cls: 'session-dropdown-section-header__text', text: t('settings.imageGenSection') });
        appendSectionSettingsAction(imageGenHeader, plugin, dropdownManager, IMAGE_GEN_SECTION_ID);

        const imageGenConfigs = current.imageGenConfigs;
        if (imageGenConfigs.length === 0) {
            const noConfigItem = profileDropdownEl.createEl('div', {
                cls: 'session-dropdown-item session-dropdown-item--disabled',
            });
            noConfigItem.createEl('span', { text: t('settings.imageGenEmpty') });
        } else {
            for (const cfg of imageGenConfigs) {
                const item = profileDropdownEl.createEl('div', { cls: 'session-dropdown-item' });
                const checkIcon = item.createEl('span', { cls: 'session-dropdown-item__check' });
                item.createEl('span', { text: cfg.name });
                appendModelName(item, cfg.model);
                if (cfg.id === current.activeImageGenId) {
                    item.addClass('session-dropdown-item--active');
                    setIcon(checkIcon, 'check');
                }
                item.addEventListener('click', () => {
                    plugin.settings.activeImageGenId = cfg.id;
                    void plugin.saveSettings();
                    DropdownManager.updateActiveState(
                        profileDropdownEl.querySelectorAll('.session-dropdown-item'),
                        item,
                        'session-dropdown-item'
                    );
                    dropdownManager.closeActive();
                });
            }
        }
    };

    dropdownManager.registerToggle({
        wrapper: profileWrapper,
        button: profileBtnEl,
        dropdown: profileDropdownEl,
        onOpen: rebuildProfileDropdown,
    });

    // Keep button text in sync with active profile
    const onSettingsChanged = () => {
        const p = getActiveProfile(plugin.settings);
        profileBtnTextEl.setText(p.name);
    };
    plugin.onSettingsChange(onSettingsChanged);

    return {
        dispose: () => {
            plugin.offSettingsChange(onSettingsChanged);
        },
    };
}
