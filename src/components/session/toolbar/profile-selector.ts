import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../../i18n';
import { DropdownManager } from '../dropdown-manager';
import { getActiveProfile } from '../../../settings';
import { openPluginSettings } from '../../../utils/open-plugin-settings';
import { TEXT_GEN_SECTION_ID, IMAGE_GEN_SECTION_ID } from '../../../settings/section-ids';
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
            item.createEl('span', { cls: 'session-dropdown-item__model', text: p.model });
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
                item.createEl('span', { cls: 'session-dropdown-item__model', text: cfg.model });
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
