import { Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { t } from "../../i18n";
import { createTabBar, createSettingsGroupHeading } from "../../components/settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { AGENTS_SECTION_ID } from "../section-ids";
import { loadCustomAgentConfig } from "../../services/custom-agents";

/**
 * Custom agents settings panel.
 *
 * Each agent is a note in the user's vault (see {@link loadCustomAgentConfig}).
 * The list of note paths lives in {@link import('../types').NoteAssistantPluginSettings.agents};
 * this section manages that list with a profile-style tab bar (add / delete,
 * one tab per agent) and, for the selected agent, exposes:
 *   1. an editable note-path field (+ open / create helpers), and
 *   2. a READ-ONLY preview of the parsed configuration (tool patterns and
 *      prompt body).
 *
 * Authoring is intentionally done in the note itself — the note is a plain
 * markdown file with full preview / search / link-graph support — so the
 * settings UI never offers in-place editing of tools or prompt.
 */
export class AgentsSettingsSection implements SettingsSection {
	readonly titleKey = AGENTS_SECTION_ID;

	/** Default content seeded when creating an agent note from the helper. */
	private static readonly AGENT_TEMPLATE = [
		"---",
		"tools:",
		'  - "mcp_*"',
		"---",
		"",
		"You are a custom agent. Describe this agent's role, scope, and",
		"instructions here. This whole note body becomes the agent's prompt.",
		"",
	].join("\n");

	/** Index of the agent currently shown in the editor. */
	private editingIndex = 0;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const agents = plugin.settings.agents;

		// Empty state: a single call-to-action to add the first agent.
		if (agents.length === 0) {
			new Setting(container)
				.setName(t("settings.agentsEmpty"))
				.setDesc(t("settings.agentsEmptyDesc"))
				.addButton(btn => {
					btn.setIcon("plus");
					btn.setButtonText(t("settings.addAgent"));
					btn.setCta();
					btn.onClick(async () => {
						agents.push("");
						this.editingIndex = 0;
						await plugin.saveSettings();
						refreshSection(this);
					});
				});
			return;
		}

		// Clamp the editing index — deletions or external edits to the list
		// can leave it dangling past the end.
		this.editingIndex = Math.min(Math.max(this.editingIndex, 0), agents.length - 1);
		const idx = this.editingIndex;

		const tabBar = createTabBar({
			container,
			items: agents.map((path, i) => ({
				id: String(i),
				name: this.tabLabel(path),
				tooltip: path.trim() || undefined,
			})),
			// No "active" concept for agents (they are not mutually exclusive),
			// so the active id mirrors the editing id and no dot is shown.
			activeId: String(idx),
			editingId: String(idx),
			onTabClick: (id) => {
				this.editingIndex = Number(id);
				refreshSection(this);
			},
			onAdd: async () => {
				agents.push("");
				this.editingIndex = agents.length - 1;
				await plugin.saveSettings();
				refreshSection(this);
			},
			addTooltip: t("settings.addAgent"),
			onDelete: async () => {
				agents.splice(idx, 1);
				this.editingIndex = Math.min(idx, agents.length - 1);
				await plugin.saveSettings();
				refreshSection(this);
			},
			deleteTooltip: t("settings.deleteAgentDesc"),
		});

		this.renderAgentEditor(container, idx, tabBar.refreshTabLabel);
	}

	/** Tab label = note basename without extension, or a placeholder. */
	private tabLabel(path: string): string {
		const trimmed = path.trim();
		if (!trimmed) return t("settings.agentUntitled");
		const base = trimmed.split("/").pop() ?? trimmed;
		return base.replace(/\.md$/i, "");
	}

	private renderAgentEditor(
		container: HTMLElement,
		idx: number,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin } = this.ctx;
		const agents = plugin.settings.agents;

		// The read-only preview lives in its own child container so a path
		// edit can re-render it without rebuilding (and stealing focus from)
		// the path text input above.
		let previewEl: HTMLElement;

		const pathSetting = new Setting(container)
			.setName(t("settings.agentNotePath"))
			.setDesc(t("settings.agentNotePathDesc"))
			.addText(text => {
				text.setPlaceholder(t("settings.agentNotePathPlaceholder"));
				text.setValue(agents[idx] ?? "");
				text.onChange(async (value) => {
					const trimmed = value.trim();
					agents[idx] = trimmed;
					await plugin.saveSettings();
					refreshTabLabel(String(idx), this.tabLabel(trimmed), trimmed || undefined);
					this.renderPreview(previewEl, trimmed);
				});
			});

		pathSetting.addExtraButton(btn => {
			btn.setIcon("file-plus-2");
			btn.setTooltip(t("settings.agentCreateDefault"));
			btn.onClick(async () => {
				try {
					const file = await this.ensureAgentFile(agents[idx] ?? "");
					new Notice(t("settings.agentCreated", { path: file.path }));
					this.renderPreview(previewEl, file.path);
				} catch (err) {
					new Notice(err instanceof Error ? err.message : String(err));
				}
			});
		});

		pathSetting.addExtraButton(btn => {
			btn.setIcon("external-link");
			btn.setTooltip(t("settings.agentOpenNote"));
			btn.onClick(async () => {
				const raw = (agents[idx] ?? "").trim();
				const file = raw
					? app.vault.getAbstractFileByPath(normalizePath(raw))
					: null;
				if (!(file instanceof TFile)) {
					new Notice(t("settings.agentNoteMissing"));
					return;
				}
				await app.workspace.openLinkText(file.path, "", true);
			});
		});

		createSettingsGroupHeading(container, { name: t("settings.agentParsedConfig") });

		previewEl = container.createDiv();
		this.renderPreview(previewEl, agents[idx] ?? "");
	}

	/**
	 * Render the read-only parsed-config preview (tool patterns + prompt) for
	 * a single agent note into `el`. Best-effort: the async vault read must
	 * never throw to the caller — any failure renders inline so the rest of
	 * the section stays usable while the user fixes the path.
	 */
	private renderPreview(el: HTMLElement, path: string): void {
		el.empty();
		const { app } = this.ctx;

		const trimmed = path.trim();
		if (!trimmed) {
			this.renderStatus(el, t("settings.agentPathEmpty"));
			return;
		}

		this.renderStatus(el, t("settings.agentLoading"));
		void (async () => {
			try {
				const config = await loadCustomAgentConfig(app, trimmed);
				el.empty();
				if (!config) {
					this.renderStatus(el, t("settings.agentNoteMissing"));
					return;
				}
				this.renderTools(el, config.tools);
				this.renderPrompt(el, config.prompt);
			} catch (err) {
				el.empty();
				this.renderStatus(el, t("settings.agentReadFailed", {
					msg: err instanceof Error ? err.message : String(err),
				}));
			}
		})();
	}

	/** One-line status row, aligned with the surrounding Setting rows. */
	private renderStatus(el: HTMLElement, text: string): void {
		const rowEl = el.createDiv({ cls: "setting-item oap-settings-agent-status-row" });
		rowEl.createDiv({ cls: "oap-settings-status oap-settings-agent-status", text });
	}

	/** Read-only tool-pattern list. */
	private renderTools(el: HTMLElement, tools: string[]): void {
		const setting = new Setting(el).setName(t("settings.agentTools"));
		if (tools.length === 0) {
			setting.setDesc(t("settings.agentToolsNone"));
			return;
		}
		const row = setting.controlEl.createDiv({ cls: "oap-agent-tools-row" });
		for (const tool of tools) {
			row.createSpan({ cls: "oap-agent-tool-chip", text: tool });
		}
	}

	/** Read-only prompt-body preview. */
	private renderPrompt(el: HTMLElement, prompt: string): void {
		new Setting(el).setName(t("settings.agentPrompt"));
		if (!prompt) {
			this.renderStatus(el, t("settings.agentPromptEmpty"));
			return;
		}
		const pre = el.createEl("pre", { cls: "oap-agent-prompt-preview" });
		pre.createEl("code", { text: prompt });
	}

	/** Ensure an agent note exists at `path`, creating it (and any missing parent folders) from the template. */
	private async ensureAgentFile(path: string): Promise<TFile> {
		const { app } = this.ctx;
		const raw = path.trim();
		if (!raw) throw new Error(t("settings.agentNotePathEmptyError"));

		const normalized = normalizePath(raw);
		const existing = app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) return existing;
		if (existing) throw new Error(`"${normalized}" exists but is not a file.`);

		const parts = normalized.split("/");
		if (parts.length > 1) {
			const parentPath = parts.slice(0, -1).join("/");
			const parent = app.vault.getAbstractFileByPath(parentPath);
			if (!parent) {
				await app.vault.createFolder(parentPath);
			} else if (!(parent instanceof TFolder)) {
				throw new Error(`Parent "${parentPath}" exists but is not a folder.`);
			}
		}

		return app.vault.create(normalized, AgentsSettingsSection.AGENT_TEMPLATE);
	}
}
