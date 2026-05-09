import { App, DropdownComponent, SecretComponent, Setting, setIcon, setTooltip } from "obsidian";
import { t } from "../i18n";

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
export type TabClickCallback = (id: string) => void;

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
	onAdd?: () => void;
	/** Tooltip for add button */
	addTooltip?: string;
	/** Callback to duplicate the current item; if provided, duplicate button is shown */
	onDuplicate?: () => void;
	/** Tooltip for duplicate button */
	duplicateTooltip?: string;
	/** Callback to delete item button; if provided, delete button is shown */
	onDelete?: () => void;
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
			onTabClick(item.id);
			tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
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
	requestAnimationFrame(updateScrollBtns);

	// Add button
	if (onAdd) {
		const addBtn = tabActions.createEl('button', { cls: 'oap-profile-tabs__action-btn clickable-icon' });
		setIcon(addBtn, 'plus');
		if (addTooltip) {
			setTooltip(addBtn, addTooltip);
		}
		addBtn.addEventListener('click', () => onAdd());
	}

	// Duplicate button
	if (onDuplicate) {
		const duplicateBtn = tabActions.createEl('button', { cls: 'oap-profile-tabs__action-btn clickable-icon' });
		setIcon(duplicateBtn, 'copy');
		if (duplicateTooltip) {
			setTooltip(duplicateBtn, duplicateTooltip);
		}
		duplicateBtn.addEventListener('click', () => onDuplicate());
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
				onDelete();
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
			dropdown.onChange(async (value: string) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Field Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an API key field with SecretComponent.
 */
export function createApiKeyField(options: ApiKeyFieldOptions): Setting {
	const { container, app, name, desc, value, onChange, sessionRestartRequired } = options;

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

	if (sessionRestartRequired) {
		markSettingRequiresSessionRestart(setting);
	}

	return setting;
}

/**
 * Creates a text input field.
 */
export function createTextField(options: TextFieldOptions): Setting {
	const { container, name, desc, placeholder, value, onChange, sessionRestartRequired } = options;

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

	if (sessionRestartRequired) {
		markSettingRequiresSessionRestart(setting);
	}

	return setting;
}

/**
 * Creates a toggle field.
 */
export function createToggleField(options: ToggleFieldOptions): Setting {
	const { container, name, desc, value, onChange, sessionRestartRequired } = options;

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

	if (sessionRestartRequired) {
		markSettingRequiresSessionRestart(setting);
	}

	return setting;
}

/**
 * Creates a dropdown field.
 */
export function createDropdownField(options: DropdownFieldOptions): Setting {
	const { container, name, desc, options: dropdownOptions, value, onChange, sessionRestartRequired } = options;

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

	if (sessionRestartRequired) {
		markSettingRequiresSessionRestart(setting);
	}

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

/**
 * Scroll active tab into view within a tab bar container.
 * @param containerEl The settings container element
 * @param tabBarSelector CSS selector for the tab bar scroll container
 */
export function scrollActiveTabIntoView(
	containerEl: HTMLElement,
	tabBarSelector: string
): void {
	const scrollContainer = containerEl.querySelector<HTMLElement>(tabBarSelector);
	const activeTab = scrollContainer?.querySelector<HTMLButtonElement>(
		'.oap-profile-tab:has(.oap-profile-tab__active-dot)'
	);
	if (scrollContainer && activeTab) {
		activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
	}
}
