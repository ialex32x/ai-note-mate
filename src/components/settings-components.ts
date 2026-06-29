import {
	App,
	DropdownComponent,
	Notice,
	SecretComponent,
	Setting,
	setIcon,
	setTooltip,
	TextComponent,
} from "obsidian";
import { t } from "../i18n";
import { ModelSelectorModal } from "../modals/model-selector-modal";
import { resolveSecret } from "../utils/secret-helper";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Item for tab bar display */
export interface TabItem {
	id: string;
	name: string;
	/** Optional additional info to show in tooltip */
	tooltip?: string;
}

/** Callback when a tab is clicked */
export type TabClickCallback = (id: string) => void | Promise<void>;

/** Options for creating a tab bar */
export interface TabBarOptions<T extends TabItem> {
	/** Container element to append the tab bar to */
	container: HTMLElement;
	/** Items to display as tabs */
	items: T[];
	/** ID of the currently active (selected for use) item */
	activeId: string;
	/** ID of the item being edited */
	editingId: string;
	/** Callback when a tab is clicked */
	onTabClick: TabClickCallback;
	/** Tooltip for the active indicator dot */
	activeDotTooltip?: string;
	/** Additional CSS class for the tab bar container */
	extraClass?: string;
	/** Callback to add item button */
	onAdd?: () => void | Promise<void>;
	/** Tooltip for add button */
	addTooltip?: string;
	/** Callback to duplicate the current item; if provided, duplicate button is shown */
	onDuplicate?: () => void | Promise<void>;
	/** Tooltip for duplicate button */
	duplicateTooltip?: string;
	/** Callback to delete item button; if provided, delete button is shown */
	onDelete?: () => void | Promise<void>;
	/** Tooltip for delete button */
	deleteTooltip?: string;
	/** Whether to disable delete button (e.g., when only one item) */
	disableDelete?: boolean;
}

/** Options for creating an active config dropdown */
export interface ActiveDropdownOptions<T extends TabItem> {
	/** Container element to append the setting to */
	container: HTMLElement;
	/** Setting name */
	name: string;
	/** Setting description */
	desc: string;
	/** Items to display in dropdown */
	items: T[];
	/** Currently active item ID */
	activeId: string;
	/** Callback when selection changes */
	onChange: (id: string) => void;
	/** Optional callback to get label for each item */
	getLabel?: (item: T) => string;
}

/** Options for creating an API key field */
export interface ApiKeyFieldOptions {
	/** Container element to append the setting to */
	container: HTMLElement;
	/** App instance for SecretComponent */
	app: App;
	/** Setting name */
	name: string;
	/** Setting description */
	desc?: string;
	/** Current API key value */
	value: string;
	/** Callback when value changes */
	onChange: (value: string) => void | Promise<void>;
	/** Whether this setting requires a session restart to take effect */
	sessionRestartRequired?: boolean;
	/** Whether this setting controls an experimental feature */
	experimental?: boolean;
	/** Whether this setting is an advanced parameter */
	advanced?: boolean;
}

/** Options for creating a text field */
export interface TextFieldOptions {
	/** Container element to append the setting to */
	container: HTMLElement;
	/** Setting name */
	name: string;
	/** Setting description */
	desc?: string;
	/** Placeholder text */
	placeholder?: string;
	/** Current value */
	value: string;
	/** Callback when value changes */
	onChange: (value: string) => void | Promise<void>;
	/** Whether this setting requires a session restart to take effect */
	sessionRestartRequired?: boolean;
	/** Whether this setting controls an experimental feature */
	experimental?: boolean;
	/** Whether this setting is an advanced parameter */
	advanced?: boolean;
}

/** Options for creating a toggle field */
export interface ToggleFieldOptions {
	/** Container element to append the setting to */
	container: HTMLElement;
	/** Setting name */
	name: string;
	/** Setting description */
	desc?: string;
	/** Current value */
	value: boolean;
	/** Callback when value changes */
	onChange: (value: boolean) => void | Promise<void>;
	/** Whether this setting requires a session restart to take effect */
	sessionRestartRequired?: boolean;
	/** Whether this setting controls an experimental feature */
	experimental?: boolean;
	/** Whether this setting is an advanced parameter */
	advanced?: boolean;
}

/**
 * Options for creating a model input field that pairs a free-form text
 * input with a refresh button. The refresh button fetches the list of
 * available models (via {@link listModels}) and opens a searchable
 * picker; the chosen value is written back into the text input and
 * forwarded through {@link onChange}.
 *
 * Shared by both the Profile section (chat/embedding LLM providers) and
 * the Image Generation section so the two surfaces stay in sync.
 */
export interface ModelFieldOptions {
	/** Container element to append the setting to */
	container: HTMLElement;
	/** App instance — required because the picker is a Modal */
	app: App;
	/** Setting name. Defaults to the localized "Model" label. */
	name?: string;
	/** Setting description */
	desc?: string;
	/** Placeholder text */
	placeholder?: string;
	/** Current model value */
	value: string;
	/**
	 * Returns the current SecretComponent reference for the API key.
	 * Used as a getter (not a captured value) so re-evaluating it
	 * after the user edits the key in the same section picks up the
	 * fresh reference instead of a stale one.
	 *
	 * When this returns a reference that does not resolve to a non-empty
	 * secret, the picker is short-circuited with an "API key required"
	 * notice — the same pre-flight check the provider-side listing path
	 * relies on to avoid forwarding empty keys to upstream SDKs.
	 */
	getApiKey: () => string;
	/** Async function that returns the list of available models. */
	listModels: () => Promise<string[]>;
	/** Called when the model value changes (via typing or selecting from picker). */
	onChange: (value: string) => void | Promise<void>;
	/** Whether this setting requires a session restart to take effect */
	sessionRestartRequired?: boolean;
	/** Whether this setting controls an experimental feature */
	experimental?: boolean;
	/** Whether this setting is an advanced parameter */
	advanced?: boolean;
}

/** Options for creating a dropdown field */
export interface DropdownFieldOptions {
	/** Container element to append the setting to */
	container: HTMLElement;
	/** Setting name */
	name: string;
	/** Setting description */
	desc?: string;
	/** Dropdown options as { value: label } */
	options: Record<string, string>;
	/** Current value */
	value: string;
	/** Callback when value changes */
	onChange: (value: string) => void | Promise<void>;
	/** Whether this setting requires a session restart to take effect */
	sessionRestartRequired?: boolean;
	/** Whether this setting controls an experimental feature */
	experimental?: boolean;
	/** Whether this setting is an advanced parameter */
	advanced?: boolean;
}

/** Return type for createTabBar */
export interface TabBarResult {
	/** The tab bar element */
	tabBar: HTMLElement;
	/** Map of item ID to tab element */
	tabElMap: Map<string, HTMLButtonElement>;
	/** Function to refresh a single tab's label */
	refreshTabLabel: (id: string, name: string, tooltip?: string) => void;
	/** The dropdown component if created */
	scrollLeftBtn: HTMLButtonElement;
	scrollRightBtn: HTMLButtonElement;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Bar Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a reusable tab bar with scroll buttons and add/delete actions.
 */
export function createTabBar<T extends TabItem>(options: TabBarOptions<T>): TabBarResult {
	const {
		container,
		items,
		activeId,
		editingId,
		onTabClick,
		activeDotTooltip,
		extraClass,
		onAdd,
		addTooltip,
		onDuplicate,
		duplicateTooltip,
		onDelete,
		deleteTooltip,
		disableDelete,
	} = options;

	const tabBarClass = extraClass ? `oap-profile-tabs ${extraClass}` : 'oap-profile-tabs';
	const tabBar = container.createDiv({ cls: tabBarClass });
	const tabScroll = tabBar.createDiv({ cls: 'oap-profile-tabs__scroll' });
	const tabElMap = new Map<string, HTMLButtonElement>();

	// Create tabs
	for (const item of items) {
		const isEditing = item.id === editingId;
		const isActive = item.id === activeId;

		const tab = tabScroll.createEl('button', {
			cls: `oap-profile-tab${isEditing ? ' oap-profile-tab--active' : ''}`,
		});

		if (isActive && activeDotTooltip) {
			const dot = tab.createSpan({ cls: 'oap-profile-tab__active-dot' });
			setTooltip(dot, activeDotTooltip);
		}

		const label = tab.createSpan({ cls: 'oap-profile-tab__label' });
		label.textContent = item.name || 'Unnamed';
		if (item.tooltip) {
			setTooltip(tab, item.tooltip);
		}

		tab.addEventListener('click', () => {
			void onTabClick(item.id);
		});

		tabElMap.set(item.id, tab);
	}

	// Tab bar action buttons (outside scroll area)
	const tabActions = tabBar.createDiv({ cls: 'oap-profile-tabs__actions' });

	// Scroll helper buttons
	const scrollStep = 200;
	const updateScrollBtns = () => {
		const { scrollLeft, scrollWidth, clientWidth } = tabScroll;
		scrollLeftBtn.classList.toggle('is-disabled', scrollLeft <= 0);
		scrollRightBtn.classList.toggle('is-disabled', scrollLeft + clientWidth >= scrollWidth - 1);
	};

	// Observe scroll events and initial state
	const scrollObserver = new MutationObserver(updateScrollBtns);
	scrollObserver.observe(tabScroll, { childList: true, subtree: true });
	tabScroll.addEventListener('scroll', updateScrollBtns, { passive: true });

	const scrollLeftBtn = tabActions.createEl('button', { cls: 'oap-profile-tabs__action-btn clickable-icon' });
	setIcon(scrollLeftBtn, 'chevron-left');
	setTooltip(scrollLeftBtn, 'Scroll left');
	scrollLeftBtn.addEventListener('click', () => {
		tabScroll.scrollBy({ left: -scrollStep, behavior: 'smooth' });
	});

	const scrollRightBtn = tabActions.createEl('button', { cls: 'oap-profile-tabs__action-btn clickable-icon' });
	setIcon(scrollRightBtn, 'chevron-right');
	setTooltip(scrollRightBtn, 'Scroll right');
	scrollRightBtn.addEventListener('click', () => {
		tabScroll.scrollBy({ left: scrollStep, behavior: 'smooth' });
	});

	// Initial state – hide both buttons if tabs don't overflow
	window.requestAnimationFrame(updateScrollBtns);

	// Add button
	if (onAdd) {
		const addBtn = tabActions.createEl('button', { cls: 'oap-profile-tabs__action-btn clickable-icon' });
		setIcon(addBtn, 'plus');
		if (addTooltip) {
			setTooltip(addBtn, addTooltip);
		}
		addBtn.addEventListener('click', () => void onAdd());
	}

	// Duplicate button
	if (onDuplicate) {
		const duplicateBtn = tabActions.createEl('button', { cls: 'oap-profile-tabs__action-btn clickable-icon' });
		setIcon(duplicateBtn, 'copy');
		if (duplicateTooltip) {
			setTooltip(duplicateBtn, duplicateTooltip);
		}
		duplicateBtn.addEventListener('click', () => void onDuplicate());
	}

	// Delete button
	if (onDelete) {
		const deleteBtn = tabActions.createEl('button', { cls: 'oap-profile-tabs__action-btn clickable-icon oap-profile-tabs__action-btn--warning' });
		setIcon(deleteBtn, 'trash');
		if (deleteTooltip) {
			setTooltip(deleteBtn, deleteTooltip);
		}
		if (disableDelete) {
			deleteBtn.classList.add('is-disabled');
		}
		deleteBtn.addEventListener('click', () => {
			if (!disableDelete) {
				void onDelete();
			}
		});
	}

	// Helper function to refresh a single tab's label
	const refreshTabLabel = (id: string, name: string, tooltip?: string) => {
		const tabEl = tabElMap.get(id);
		if (tabEl) {
			const labelEl = tabEl.querySelector('.oap-profile-tab__label');
			if (labelEl) {
				labelEl.textContent = name || 'Unnamed';
			}
			if (tooltip) {
				setTooltip(tabEl, tooltip);
			}
		}
	};



	return {
		tabBar,
		tabElMap,
		refreshTabLabel,
		scrollLeftBtn,
		scrollRightBtn,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Dropdown Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a dropdown for selecting the active config/profile.
 */
export function createActiveDropdown<T extends TabItem>(
	options: ActiveDropdownOptions<T>
): DropdownComponent {
	const { container, name, desc, items, activeId, onChange, getLabel } = options;

	let dropdown: DropdownComponent;

	new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addDropdown((d: DropdownComponent) => {
			dropdown = d;
			for (const item of items) {
				const label = getLabel ? getLabel(item) : (item.name || 'Unnamed');
				dropdown.addOption(item.id, label);
			}
			dropdown.setValue(activeId);
			dropdown.onChange((value: string) => {
				onChange(value);
			});
		});

	return dropdown!;
}

/**
 * Refreshes dropdown options in-place while preserving selection.
 */
export function refreshDropdownOptions<T extends TabItem>(
	dropdown: DropdownComponent,
	items: T[],
	getLabel?: (item: T) => string
): void {
	const currentValue = dropdown.getValue();
	const selectEl = dropdown.selectEl;
	selectEl.empty();

	for (const item of items) {
		const label = getLabel ? getLabel(item) : (item.name || 'Unnamed');
		const opt = selectEl.createEl('option', { text: label });
		opt.value = item.id;
	}

	// Restore selection if the value still exists
	if (items.some(item => item.id === currentValue)) {
		selectEl.value = currentValue;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Field Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds a visual indicator to a setting to show it requires a session restart.
 *
 * Layer 1: A `refresh-cw` icon badge appended to the setting name, with a
 *          tooltip explaining the setting only takes effect on next session.
 * Layer 2: A small text hint appended to the setting description.
 */
export function markSettingRequiresSessionRestart(setting: Setting): void {
	// Layer 1: Icon badge
	const badge = setting.nameEl.createSpan({ cls: 'oap-session-restart-badge' });
	setIcon(badge, 'refresh-cw');
	setTooltip(badge, t('settings.sessionRestartRequired'));

	// Layer 2: Text hint in description
	const hint = setting.descEl.createSpan({ cls: 'oap-session-restart-hint' });
	hint.textContent = t('settings.sessionRestartHint');
}

/**
 * Adds a visual indicator to a setting to show it controls an experimental
 * feature whose behavior and safety guarantees may change in future versions.
 *
 * Layer 1: A `flask-conical` icon badge appended to the setting name, with a
 *          tooltip describing the experimental status.
 * Layer 2: A small text hint appended to the setting description.
 */
export function markSettingExperimental(setting: Setting): void {
	// Layer 1: Icon badge
	const badge = setting.nameEl.createSpan({ cls: 'oap-experimental-badge' });
	setIcon(badge, 'flask-conical');
	setTooltip(badge, t('settings.experimental'));

	// Layer 2: Text hint in description
	const hint = setting.descEl.createSpan({ cls: 'oap-experimental-hint' });
	hint.textContent = t('settings.experimentalHint');
}

/**
 * Adds a visual indicator to a setting to show it is an advanced parameter
 * that should only be changed when you understand its effect.
 *
 * Layer 1: A `settings-2` icon badge appended to the setting name, with a
 *          tooltip describing the advanced status.
 * Layer 2: A small text hint appended to the setting description.
 */
export function markSettingAdvanced(setting: Setting): void {
	// Layer 1: Icon badge
	const badge = setting.nameEl.createSpan({ cls: 'oap-advanced-badge' });
	setIcon(badge, 'settings-2');
	setTooltip(badge, t('settings.advanced'));

	// Layer 2: Text hint in description
	const hint = setting.descEl.createSpan({ cls: 'oap-advanced-hint' });
	hint.textContent = t('settings.advancedHint');
}

/** Whether advanced-marked settings should be rendered in the settings UI. */
let advancedSettingsVisible = false;

/** Sync visibility flag before rendering any settings section. */
export function setAdvancedSettingsVisible(visible: boolean): void {
	advancedSettingsVisible = visible;
}

export function isAdvancedSettingsVisible(): boolean {
	return advancedSettingsVisible;
}

/**
 * Hide a section heading when advanced settings are off. Use for groups
 * whose child fields are all marked `advanced`.
 */
export function applyAdvancedOnlyGroupHeading(setting: Setting): void {
	if (!advancedSettingsVisible) {
		setting.settingEl.addClass('oap-setting--advanced-collapsed');
	}
}

/**
 * Adds a visual indicator to a setting to show it is deprecated and may be
 * removed in a future version. Users should migrate to the recommended
 * alternative.
 *
 * Layer 1: An `archive` icon badge appended to the setting name, with a
 *          tooltip describing the deprecated status.
 * Layer 2: A small text hint appended to the setting description.
 */
export function markSettingDeprecated(setting: Setting): void {
	// Layer 1: Icon badge
	const badge = setting.nameEl.createSpan({ cls: 'oap-deprecated-badge' });
	setIcon(badge, 'archive');
	setTooltip(badge, t('settings.deprecated'));

	// Layer 2: Text hint in description
	const hint = setting.descEl.createSpan({ cls: 'oap-deprecated-hint' });
	hint.textContent = t('settings.deprecatedHint');
}

/** Shared visual class for in-section group dividers (Artifacts, MCP servers, …). */
export function markSettingsGroupHeading(setting: Setting): void {
	setting.settingEl.addClass('oap-settings-group-heading');
}

/**
 * Section divider inside a settings section body. Applies
 * {@link markSettingsGroupHeading} styling so group titles stand out from
 * regular setting rows.
 */
export function createSettingsGroupHeading(
	container: HTMLElement,
	options: {
		name: string;
		desc?: string;
		/** Hide when advanced settings are off (use when all child fields are advanced). */
		advancedOnly?: boolean;
	},
): Setting {
	const setting = new Setting(container).setName(options.name);
	if (options.desc) setting.setDesc(options.desc);
	setting.setHeading();
	markSettingsGroupHeading(setting);
	if (options.advancedOnly) {
		applyAdvancedOnlyGroupHeading(setting);
	}
	return setting;
}

interface SettingIndicatorOptions {
	sessionRestartRequired?: boolean;
	experimental?: boolean;
	advanced?: boolean;
	deprecated?: boolean;
}

function applySettingIndicators(setting: Setting, options: SettingIndicatorOptions): void {
	const { sessionRestartRequired, experimental, advanced, deprecated } = options;

	if (deprecated) {
		markSettingDeprecated(setting);
	}
	if (sessionRestartRequired) {
		markSettingRequiresSessionRestart(setting);
	}
	if (experimental) {
		markSettingExperimental(setting);
	}
	if (advanced) {
		if (advancedSettingsVisible) {
			markSettingAdvanced(setting);
		} else {
			setting.settingEl.addClass('oap-setting--advanced-collapsed');
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Field Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an API key field with SecretComponent.
 */
export function createApiKeyField(options: ApiKeyFieldOptions): Setting {
	const { container, app, name, desc, value, onChange, sessionRestartRequired, experimental, advanced } = options;

	const setting = new Setting(container)
		.setName(name);

	if (desc) {
		setting.setDesc(desc);
	}

	setting.addComponent(el => new SecretComponent(app, el)
		.setValue(value)
		.onChange(async (newValue) => {
			await onChange(newValue);
		}));

	applySettingIndicators(setting, { sessionRestartRequired, experimental, advanced });

	return setting;
}

/**
 * Creates a text input field.
 */
export function createTextField(options: TextFieldOptions): Setting {
	const { container, name, desc, placeholder, value, onChange, sessionRestartRequired, experimental, advanced } = options;

	const setting = new Setting(container)
		.setName(name);

	if (desc) {
		setting.setDesc(desc);
	}

	setting.addText(text => {
		if (placeholder) {
			text.setPlaceholder(placeholder);
		}
		text.setValue(value);
		text.onChange(async (newValue) => {
			await onChange(newValue);
		});
	});

	applySettingIndicators(setting, { sessionRestartRequired, experimental, advanced });

	return setting;
}

/**
 * Creates a toggle field.
 */
export function createToggleField(options: ToggleFieldOptions): Setting {
	const { container, name, desc, value, onChange, sessionRestartRequired, experimental, advanced } = options;

	const setting = new Setting(container)
		.setName(name);

	if (desc) {
		setting.setDesc(desc);
	}

	setting.addToggle(toggle => {
		toggle.setValue(value);
		toggle.onChange(async (newValue) => {
			await onChange(newValue);
		});
	});

	applySettingIndicators(setting, { sessionRestartRequired, experimental, advanced });

	return setting;
}

/**
 * Creates a dropdown field.
 */
export function createDropdownField(options: DropdownFieldOptions): Setting {
	const { container, name, desc, options: dropdownOptions, value, onChange, sessionRestartRequired, experimental, advanced } = options;

	const setting = new Setting(container)
		.setName(name);

	if (desc) {
		setting.setDesc(desc);
	}

	setting.addDropdown(dropdown => {
		for (const [optValue, optLabel] of Object.entries(dropdownOptions)) {
			dropdown.addOption(optValue, optLabel);
		}
		dropdown.setValue(value);
		dropdown.onChange(async (newValue: string) => {
			await onChange(newValue);
		});
	});

	applySettingIndicators(setting, { sessionRestartRequired, experimental, advanced });

	return setting;
}

/**
 * Creates a model input field with a "refresh + pick from list" button.
 *
 * Layout:
 *   [ text input ............ ] [ ⟳ refresh ]
 *
 * Behaviour:
 *  1. Typing in the input fires {@link ModelFieldOptions.onChange} on every
 *     change (mirrors {@link createTextField}).
 *  2. Clicking the refresh button:
 *     - Validates the API key via {@link ModelFieldOptions.getApiKey} +
 *       {@link resolveSecret}. Empty → "API key required" notice, no fetch.
 *     - Calls {@link ModelFieldOptions.listModels}. Empty list → notice.
 *     - Opens {@link ModelSelectorModal} for a searchable picker. The chosen
 *       value is written into the input AND forwarded through `onChange`
 *       (so the caller's persist / refresh-label logic runs identically to
 *       the typing path).
 *
 * Errors raised by `listModels` are logged and surfaced as a generic
 * "fetch failed" notice — provider-specific error reporting is the
 * caller's responsibility (typically the underlying SDK already returns
 * a descriptive message).
 */
export function createModelFieldWithSelector(options: ModelFieldOptions): Setting {
	const {
		container,
		app,
		name,
		desc,
		placeholder,
		value,
		getApiKey,
		listModels,
		onChange,
		sessionRestartRequired,
		experimental,
		advanced,
	} = options;

	const setting = new Setting(container)
		.setName(name ?? t('common.model'));

	if (desc) {
		setting.setDesc(desc);
	}

	// Capture the TextComponent via closure so the modal-selection branch
	// can update the input value reactively without re-querying the DOM.
	let textComponent: TextComponent | null = null;

	setting.addText(text => {
		textComponent = text;
		if (placeholder) {
			text.setPlaceholder(placeholder);
		}
		text.setValue(value);
		text.onChange(async (newValue) => {
			await onChange(newValue);
		});
	});

	setting.addButton(btn => btn
		.setIcon('refresh-cw')
		.setTooltip(t('settings.refreshModels'))
		.onClick(async () => {
			const apiKey = resolveSecret(app, getApiKey());
			if (!apiKey) {
				new Notice(t('settings.apiKeyRequired'));
				return;
			}

			try {
				const models = await listModels();
				if (models.length === 0) {
					new Notice(t('settings.noModelsAvailable'));
					return;
				}

				const current = textComponent?.getValue() ?? value;
				const selected = await new ModelSelectorModal(app, models, current).waitForResult();
				if (selected) {
					textComponent?.setValue(selected);
					// Reuse the same onChange handler so the caller's persist /
					// refresh-label / refresh-dropdown logic runs identically
					// to the typing path. Otherwise the displayed tab labels
					// and active-config dropdowns would lag behind the change.
					await onChange(selected);
				}
			} catch (e) {
				console.error('Failed to list models:', e);
				new Notice(t('settings.refreshModelsFailed'));
			}
		}));

	applySettingIndicators(setting, { sessionRestartRequired, experimental, advanced });

	return setting;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a settings section container with a header.
 *
 * The section is laid out as:
 *   <div.oap-settings-section>
 *     <div.oap-settings-header>
 *       <h5>title</h5>
 *       <div.oap-settings-header-actions>  ← optional action buttons
 *     </div>
 *     <div.oap-settings-section__body>  ← returned element
 *   </div>
 *
 * The returned element is the **body** container. Callers should populate
 * their fields into it; the host can call `.empty()` on the body to re-render
 * the section without disturbing the header (avoids visual flicker).
 */
export function createSettingsSection(
	container: HTMLElement,
	title: string,
	extraClass?: string
): { body: HTMLElement; headerActions: HTMLElement } {
	const section = container.createDiv({ cls: 'oap-settings-section' });
	if (extraClass) {
		section.addClass(extraClass);
	}
	const header = section.createDiv({ cls: 'oap-settings-header' });
	header.createEl('h5', { text: title });
	const headerActions = header.createDiv({ cls: 'oap-settings-header-actions' });
	const body = section.createDiv({ cls: 'oap-settings-section__body' });
	return { body, headerActions };
}

/**
 * Creates a "Add" button setting.
 */
export function createAddButton(
	container: HTMLElement,
	buttonText: string,
	onClick: () => void | Promise<void>,
	icon?: string
): Setting {
	return new Setting(container)
		.addButton(btn => {
			btn.setButtonText(buttonText);
			if (icon) {
				btn.setIcon(icon);
			}
			btn.onClick(async () => {
				await onClick();
			});
		});
}


