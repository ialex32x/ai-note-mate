import type { App } from "obsidian";
import type NoteAssistantPlugin from "../../main";

/**
 * Context passed to every settings section.
 * Provides shared plugin access and a callback to re-render all sections.
 */
export interface SectionContext {
	readonly app: App;
	readonly plugin: NoteAssistantPlugin;
	/** Re-render the whole settings tab (equivalent to PluginSettingTab.display()). */
	readonly refreshAll: () => void;
	/**
	 * Re-render only the current settings section in place. Prefer this over
	 * `refreshAll` for intra-section UI changes (tab switch, add/remove items,
	 * provider-type change) — it avoids rebuilding the whole settings tab and
	 * keeps scroll position / hover / focus in other sections stable.
	 *
	 * The callback is bound by the host when the section is rendered; calling
	 * it before the first render is a no-op.
	 */
	readonly refreshSection: (section: SettingsSection) => void;
	/** The root container element of the settings tab. */
	readonly containerEl: HTMLElement;
}

/**
 * A settings section represents one bordered block in the settings tab
 * (e.g. Global / Profile / Embedding / ...). The outer container and the
 * section header/title are created by the settings tab host; `render`
 * populates the inner content only.
 */
export interface SettingsSection {
	/** i18n key used by the host to fetch the section title via `t(...)`. */
	readonly titleKey: string;
	/** Render the section body into the given container. */
	render(container: HTMLElement): void;
	/**
	 * Optional: render action buttons into the section header right area.
	 * If not implemented, the header only shows the section title.
	 */
	renderHeaderActions?(container: HTMLElement): void;
	/**
	 * Optional: release any resources (event listeners, timers, etc.) that
	 * the section acquired during `render`. Called by the settings tab host
	 * when the tab is closed or fully rebuilt. Implementations should be
	 * idempotent.
	 */
	dispose?(): void;
}
