import { Notice, Setting, setIcon, type DropdownComponent } from "obsidian";
import { t } from "../../i18n";
import { createTabBar } from "../../components/settings-components";
import type { SectionContext, SettingsSection } from "./types";
import type { CustomAgentConfig } from "../types";
import { AGENTS_SECTION_ID } from "../section-ids";
import { getProfileLabel } from "./global-section";
import {
	buildMcpToolInfos,
	buildMcpToolNames,
	matchesWildcard,
} from "../../services/custom-agents";
import { createSummarizerConfig } from "../../services/chat-factory";
import { createChatCompletion } from "../../services/context-compression";
import { isAbortError } from "../../utils/abortable-request";
import type { BuiltinAgentMeta } from "../../services/sub-agent-registry";
import { getBuiltinAgentMeta, BUILTIN_AGENT_DEFAULT_DISABLED } from "../../services/sub-agent-registry";

/** Default config seeded when adding a new agent. */
function defaultAgentConfig(): CustomAgentConfig {
	return { name: "", tools: ["mcp_*"], profile: "", description: "", systemPrompt: "", disabled: false };
}

/** Computed id for a builtin agent tab (uses stable key). */
function builtinId(key: string): string { return `builtin_${key}`; }
/** Computed id for a custom agent tab. */
function customId(index: number): string { return `custom_${index}`; }

/**
 * Agents settings panel — shows both built-in sub-agents (read-only)
 * and user-defined custom agents (fully editable).
 */
export class AgentsSettingsSection implements SettingsSection {
	readonly titleKey = AGENTS_SECTION_ID;
	/** Editing target: e.g. "builtin_vault_inspector" or "custom_1". */
	private editingId = '';

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const builtins = getBuiltinAgentMeta(plugin);
		const customs = plugin.settings.agents;

		// ── Build unified tab items ────────────────────────────
		const tabItems: { id: string; name: string; tooltip?: string; isBuiltin: boolean }[] = [];

		for (const b of builtins) {
			tabItems.push({
				id: builtinId(b.key),
				name: b.name,
				tooltip: b.description,
				isBuiltin: true,
			});
		}
		for (let i = 0; i < customs.length; i++) {
			tabItems.push({
				id: customId(i),
				name: this.tabLabel(customs[i]!),
				tooltip: customs[i]!.description || undefined,
				isBuiltin: false,
			});
		}

		// ── Empty state: only custom agents count, builtins are always present ──
		if (customs.length === 0 && tabItems.length === builtins.length) {
			// Render builtins without a tabBar (only builtins, no custom agents yet).
			// Reset editingId so the next custom-agent add starts fresh.
			this.editingId = '';
			this.renderBuiltinOnly(container, builtins);
			return;
		}

		// ── Validate / default editingId ────────────────────────
		const validIds = new Set(tabItems.map(it => it.id));
		if (!validIds.has(this.editingId)) {
			this.editingId = tabItems[0]!.id;
		}
		const activeId = this.editingId;

		// ── Which item is being edited ──────────────────────────
		const editingItem = tabItems.find(it => it.id === activeId);
		const isBuiltinEditing = editingItem?.isBuiltin ?? false;

		// ── Tab bar ────────────────────────────────────────────
		const tabBar = createTabBar({
			container,
			items: tabItems.map(it => ({ id: it.id, name: it.name, tooltip: it.tooltip })),
			activeId,
			editingId: activeId,
			onTabClick: (id) => {
				this.editingId = id;
				refreshSection(this);
			},
			onAdd: async () => {
				customs.push(defaultAgentConfig());
				this.editingId = customId(customs.length - 1);
				await plugin.saveSettings();
				refreshSection(this);
			},
			addTooltip: t("settings.addAgent"),
			onDelete: isBuiltinEditing ? undefined : async () => {
				const customIdx = Number(activeId.replace('custom_', ''));
				customs.splice(customIdx, 1);
				// Pick next editing target
				if (customs.length === 0) {
					// Only builtins left — go to last builtin
					this.editingId = builtinId(builtins[builtins.length - 1]!.key);
				} else {
					this.editingId = customId(Math.min(customIdx, customs.length - 1));
				}
				await plugin.saveSettings();
				refreshSection(this);
			},
			deleteTooltip: t("settings.deleteAgentDesc"),
		});

		// ── Editor / read-only view ────────────────────────────
		if (isBuiltinEditing) {
			const builtinKey = activeId.replace('builtin_', '');
			const builtin = builtins.find(b => b.key === builtinKey);
			if (builtin) this.renderBuiltinAgentView(container, builtin);
		} else {
			const customIdx = Number(activeId.replace('custom_', ''));
			this.renderAgentEditor(container, customIdx, tabBar.refreshTabLabel);
		}
	}

	private tabLabel(agent: CustomAgentConfig): string {
		return (agent.name ?? "").trim() || t("settings.agentUntitled");
	}

	// ──────────────────────────────────────────────────────────────
	// Builtin-only state (no custom agents yet)
	// ──────────────────────────────────────────────────────────────

	private renderBuiltinOnly(container: HTMLElement, builtins: BuiltinAgentMeta[]): void {
		const { plugin, refreshSection } = this.ctx;

		for (let i = 0; i < builtins.length; i++) {
			if (i > 0) {
				container.createDiv({ cls: "oap-builtin-agent-card-divider" });
			}
			this.renderBuiltinAgentView(container, builtins[i]!);
		}

		// "Add a custom agent" button at the bottom
		const btnRow = container.createDiv({ cls: "oap-builtin-agent-add-row" });
		const addBtn = btnRow.createEl("button", { cls: "mod-cta" });
		setIcon(addBtn, "plus");
		addBtn.createSpan({ text: t("settings.addAgent") });
		addBtn.addEventListener("click", () => {
			void (async () => {
				plugin.settings.agents.push(defaultAgentConfig());
				this.editingId = customId(0);
				await plugin.saveSettings();
				refreshSection(this);
			})();
		});
	}

	// ──────────────────────────────────────────────────────────────
	// Built-in agent read-only view
	// ──────────────────────────────────────────────────────────────

	private renderBuiltinAgentView(container: HTMLElement, meta: BuiltinAgentMeta): void {
		const { plugin } = this.ctx;

		// ── Badge row: "Built-in" chip ──────────────────────────
		const badgeRow = container.createDiv({ cls: "oap-builtin-agent-badge-row" });
		const badge = badgeRow.createDiv({ cls: "oap-builtin-agent-badge" });
		setIcon(badge.createSpan({ cls: "oap-builtin-agent-badge-icon" }), "lock");
		badge.createSpan({ cls: "oap-builtin-agent-badge-text", text: t("settings.agentBuiltinBadge") });

		// ── Name (read-only) ────────────────────────────────────
		new Setting(container)
			.setName(t("settings.agentName"))
			.setDesc(t("settings.agentNameDesc"))
			.addText(text => {
				text.setValue(meta.name);
				text.setDisabled(true);
				text.inputEl.classList.add("oap-input-readonly");
			});

		// ── Enabled toggle (only for agents the user can toggle) ──
		if (meta.canToggle) {
			new Setting(container)
				.setName(t("settings.agentDisabled"))
				.setDesc(t("settings.agentDisabledDesc"))
				.addToggle(toggle => {
					const overrides = plugin.settings.builtinAgentOverrides ?? {};
					const currentDisabled = overrides[meta.key]?.disabled
						?? BUILTIN_AGENT_DEFAULT_DISABLED[meta.key]
						?? false;
					toggle.setValue(!currentDisabled);
					toggle.onChange(async (value) => {
						if (!plugin.settings.builtinAgentOverrides) {
							plugin.settings.builtinAgentOverrides = {};
						}
						const newDisabled = !value;
						const defaultDisabled = BUILTIN_AGENT_DEFAULT_DISABLED[meta.key] ?? false;
						if (newDisabled === defaultDisabled) {
							// Reverting to default — clear disabled from override
							const existing = plugin.settings.builtinAgentOverrides[meta.key];
							if (existing) {
								delete existing.disabled;
								if (Object.keys(existing).length === 0) {
									delete plugin.settings.builtinAgentOverrides[meta.key];
								}
							}
						} else {
							plugin.settings.builtinAgentOverrides[meta.key] = {
								...plugin.settings.builtinAgentOverrides[meta.key],
								disabled: newDisabled,
							};
						}
						await plugin.saveSettings();
					});
				});
		}

		// ── Profile ────────────────────────────────────────────
		new Setting(container)
			.setName(t("settings.agentProfile"))
			.setDesc(t("settings.agentProfileDesc"))
			.addDropdown((dropdown: DropdownComponent) => {
				dropdown.addOption("", t("settings.agentProfileInherited"));
				for (const p of plugin.settings.profiles) {
					dropdown.addOption(p.id, getProfileLabel(p));
				}
				const overrides = plugin.settings.builtinAgentOverrides ?? {};
				const current = overrides[meta.key]?.profile ?? "";
				const validId = current
					&& plugin.settings.profiles.some(p => p.id === current)
					? current
					: "";
				dropdown.setValue(validId);
				dropdown.onChange(async (value: string) => {
					if (!plugin.settings.builtinAgentOverrides) {
						plugin.settings.builtinAgentOverrides = {};
					}
					if (value) {
						plugin.settings.builtinAgentOverrides[meta.key] = {
							...plugin.settings.builtinAgentOverrides[meta.key],
							profile: value,
						};
					} else {
						const existing = plugin.settings.builtinAgentOverrides[meta.key];
						if (existing) {
							delete existing.profile;
							if (Object.keys(existing).length === 0) {
								delete plugin.settings.builtinAgentOverrides[meta.key];
							}
						}
					}
					await plugin.saveSettings();
				});
			});

		// ── Description (read-only) ─────────────────────────────
		this.renderReadOnlyTextField(
			container,
			t("settings.agentDescription"),
			t("settings.agentDescriptionDesc"),
			meta.description,
			5,
		);

		// ── System Prompt (read-only) ───────────────────────────
		this.renderReadOnlyTextField(
			container,
			t("settings.agentSystemPrompt"),
			t("settings.agentSystemPromptDesc"),
			meta.systemPrompt,
			10,
		);

		// ── Tools (read-only chip list) ─────────────────────────
		this.renderBuiltinToolsPreview(container, meta);
	}

	/**
	 * Render a read-only text field that looks like a disabled textarea.
	 */
	private renderReadOnlyTextField(
		container: HTMLElement,
		name: string,
		desc: string,
		value: string,
		rows: number,
	): void {
		const heading = container.createDiv({ cls: "setting-item" });
		const info = heading.createDiv({ cls: "setting-item-info" });
		info.createDiv({ cls: "setting-item-name", text: name });
		info.createDiv({ cls: "setting-item-description", text: desc });

		const wrapper = container.createDiv({ cls: "oap-agent-desc-wrapper" });
		const textarea = wrapper.createEl("textarea", {
			cls: "oap-agent-desc-textarea oap-agent-desc-textarea--readonly",
			attr: { rows: String(rows), readonly: "true" },
			text: value,
		});
		// Prevent editing but keep scroll
		textarea.addEventListener("keydown", (e) => e.preventDefault());
	}

	/**
	 * Show tool names available to a built-in agent as read-only chips.
	 */
	private renderBuiltinToolsPreview(container: HTMLElement, meta: BuiltinAgentMeta): void {
		const { toolNames } = meta;

		if (toolNames.length === 0) {
			new Setting(container)
				.setName(t("settings.agentToolsPreview"))
				.setDesc(t("settings.agentBuiltinToolsNone"));
			return;
		}

		const previewSetting = new Setting(container)
			.setName(t("settings.agentToolsPreview"))
			.setDesc(t("settings.agentBuiltinToolsCount", { count: toolNames.length }));

		const chipList = previewSetting.descEl.createDiv({
			cls: "oap-settings-chip-list",
		});
		for (const name of toolNames) {
			const chip = chipList.createDiv({
				cls: "oap-agent-tool-chip",
			});
			chip.createSpan({
				cls: "oap-agent-tool-chip-label",
				text: name,
			});
		}
	}

	// ──────────────────────────────────────────────────────────────
	// Custom agent editor (unchanged, except id format)
	// ──────────────────────────────────────────────────────────────

	private renderAgentEditor(
		container: HTMLElement,
		idx: number,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { plugin } = this.ctx;
		const agent = plugin.settings.agents[idx]!;

		// ── Name ───────────────────────────────────────────────
		new Setting(container)
			.setName(t("settings.agentName"))
			.setDesc(t("settings.agentNameDesc"))
			.addText(text => {
				text.setPlaceholder(t("settings.agentNamePlaceholder"));
				text.setValue(agent.name);
				text.onChange(async (value) => {
					agent.name = value.trim();
					await plugin.saveSettings();
					refreshTabLabel(
						customId(idx),
						this.tabLabel(agent),
						agent.description || undefined,
					);
				});
			});

		// ── Enabled toggle ─────────────────────────────────────
		new Setting(container)
			.setName(t("settings.agentDisabled"))
			.setDesc(t("settings.agentDisabledDesc"))
			.addToggle(toggle => {
				toggle.setValue(!agent.disabled);
				toggle.onChange(async (value) => {
					agent.disabled = !value;
					await plugin.saveSettings();
				});
			});

		// ── Profile ────────────────────────────────────────────
		new Setting(container)
			.setName(t("settings.agentProfile"))
			.setDesc(t("settings.agentProfileDesc"))
			.addDropdown((dropdown: DropdownComponent) => {
				dropdown.addOption("", t("settings.agentProfileInherited"));
				for (const p of plugin.settings.profiles) {
					dropdown.addOption(p.id, getProfileLabel(p));
				}
				const validId = agent.profile
					&& plugin.settings.profiles.some(p => p.id === agent.profile)
					? agent.profile
					: "";
				dropdown.setValue(validId);
				dropdown.onChange(async (value: string) => {
					agent.profile = value;
					await plugin.saveSettings();
				});
			});

		// ── Tools patterns ─────────────────────────────────────
		const toolsLines = agent.tools.join("\n");
		new Setting(container)
			.setName(t("settings.agentTools"))
			.setDesc(t("settings.agentToolsDesc"))
			.addTextArea(text => {
				text.setPlaceholder("One wildcard pattern per line");
				text.setValue(toolsLines);
				text.onChange(async (value) => {
					agent.tools = value
						.split(/[\n,]/)
						.map(s => s.trim())
						.filter(Boolean);
					await plugin.saveSettings();
				});
			});

		// ── MCP tools preview ──────────────────────────────────
		void this.renderToolsPreview(container, agent);

		// ── Description ────────────────────────────────────────
		this.renderDescriptionField(container, agent, idx, refreshTabLabel);

		// ── System Prompt ───────────────────────────────────────
		this.renderSystemPromptField(container, agent, idx, refreshTabLabel);
	}

	/**
	 * Render the description as a full-width textarea (not in a
	 * two-column Setting). A sparkle button at the top-right corner
	 * lets the user auto-generate the description from matched tools.
	 */
	private renderDescriptionField(
		container: HTMLElement,
		agent: CustomAgentConfig,
		idx: number,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { plugin } = this.ctx;

		// Heading row (mimics Setting name + desc).
		const heading = container.createDiv({
			cls: "setting-item",
		});
		const info = heading.createDiv({ cls: "setting-item-info" });
		info.createDiv({
			cls: "setting-item-name",
			text: t("settings.agentDescription"),
		});
		info.createDiv({
			cls: "setting-item-description",
			text: t("settings.agentDescriptionDesc"),
		});

		// Wrapper for textarea + hover button.
		const wrapper = container.createDiv({
			cls: "oap-agent-desc-wrapper",
		});

		const textarea = wrapper.createEl("textarea", {
			cls: "oap-agent-desc-textarea",
			attr: { rows: "5" },
			text: agent.description,
		});
		textarea.setAttribute("placeholder", t("settings.agentDescriptionPlaceholder"));

		// Hover button — sparkles icon, top-right corner.
		const genBtn = wrapper.createEl("button", {
			cls: "oap-agent-desc-gen-btn",
			attr: { "aria-label": t("settings.agentGenerateDescriptionButton") },
		});
		setIcon(genBtn, "sparkles");

		// Save on input.
		textarea.addEventListener("input", () => {
			agent.description = textarea.value;
			void (async () => {
				await plugin.saveSettings();
				refreshTabLabel(
					customId(idx),
					this.tabLabel(agent),
					agent.description || undefined,
				);
			})();
		});

		// Generate button — replaces textarea content with AI output.
		genBtn.addEventListener("click", () => {
			void (async () => {
				wrapper.classList.add("is-generating");
				genBtn.disabled = true;
				try {
					const result = await this.generateDescription(agent.tools);
					if (result !== null) {
						textarea.value = result;
						agent.description = result;
						await plugin.saveSettings();
						refreshTabLabel(
							customId(idx),
							this.tabLabel(agent),
							agent.description || undefined,
						);
					}
				} finally {
					wrapper.classList.remove("is-generating");
					genBtn.disabled = false;
				}
			})();
		});
	}

	/**
	 * Render the system prompt as a full-width textarea with a hover
	 * generate button, same layout as the description field.
	 */
	private renderSystemPromptField(
		container: HTMLElement,
		agent: CustomAgentConfig,
		idx: number,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { plugin } = this.ctx;

		// Heading row.
		const heading = container.createDiv({ cls: "setting-item" });
		const info = heading.createDiv({ cls: "setting-item-info" });
		info.createDiv({
			cls: "setting-item-name",
			text: t("settings.agentSystemPrompt"),
		});
		info.createDiv({
			cls: "setting-item-description",
			text: t("settings.agentSystemPromptDesc"),
		});

		const wrapper = container.createDiv({ cls: "oap-agent-desc-wrapper" });
		const textarea = wrapper.createEl("textarea", {
			cls: "oap-agent-desc-textarea",
			attr: { rows: "8" },
			text: agent.systemPrompt,
		});
		textarea.setAttribute("placeholder", t("settings.agentSystemPromptPlaceholder"));

		// Hover button.
		const genBtn = wrapper.createEl("button", {
			cls: "oap-agent-desc-gen-btn",
			attr: { "aria-label": t("settings.agentGenerateDescriptionButton") },
		});
		setIcon(genBtn, "sparkles");

		textarea.addEventListener("input", () => {
			agent.systemPrompt = textarea.value;
			void plugin.saveSettings();
		});

		genBtn.addEventListener("click", () => {
			void (async () => {
				wrapper.classList.add("is-generating");
				genBtn.disabled = true;
				try {
					const result = await this.generateSystemPrompt(agent.tools, agent.name);
					if (result !== null) {
						textarea.value = result;
						agent.systemPrompt = result;
						await plugin.saveSettings();
						refreshTabLabel(
							customId(idx),
							this.tabLabel(agent),
							agent.description || undefined,
						);
					}
				} finally {
					wrapper.classList.remove("is-generating");
					genBtn.disabled = false;
				}
			})();
		});
	}

	/**
	 * Call the summarizer model to produce a short description from
	 * the given tool patterns. Returns the generated text, or null
	 * when generation is not possible (no summarizer, no tools, etc.).
	 */
	private async generateDescription(patterns: readonly string[]): Promise<string | null> {
		const { plugin } = this.ctx;

		const modelConfig = createSummarizerConfig(plugin);
		if (!modelConfig) {
			new Notice(t("settings.agentGenerateDescriptionNoSummarizer"));
			return null;
		}

		const toolInfos = buildMcpToolInfos(plugin.settings.mcpServers, patterns);
		if (toolInfos.length === 0) {
			new Notice(t("settings.agentGenerateDescriptionNoTools"));
			return null;
		}

		const toolSummary = toolInfos.map(t => {
			const desc = t.description?.trim();
			return desc ? `- ${t.name}: ${desc}` : `- ${t.name}`;
		}).join('\n');

		try {
			const generatePrompt = [
				'Below is a list of tools available to an AI sub-agent. Each tool has a name and a description of what it does.',
				'',
				'Write a SHORT (2-4 sentence), high-level description of what this agent can do. This description will be shown to a main orchestrator agent so it knows when to delegate tasks to this sub-agent.',
				'',
				'Rules:',
				'- Do NOT mention specific tool names (e.g. "mcp_xxx", "grep", "fetch").',
				'- Describe the agent\'s capabilities at a conceptual level (e.g. "can search and analyse files in the vault" instead of "uses mcp_search_grep and mcp_search_find").',
				'- Focus on the OUTCOMES the agent can deliver, not the mechanics.',
				'- Keep it concise — 2 to 4 sentences maximum.',
				'- Write in English.',
				'',
				'TOOLS:',
				toolSummary,
				'',
				'Output ONLY the description text, with no additional commentary, no markdown code fences, and no preamble.',
			].join('\n');

			const generated = await createChatCompletion(
				modelConfig,
				[{ role: 'user', content: generatePrompt }],
			);

			const trimmed = generated.trim();
			if (!trimmed) {
				new Notice(t("settings.agentGenerateDescriptionEmpty"));
				return null;
			}

			return trimmed;
		} catch (err) {
			if (isAbortError(err)) return null;
			console.error("[AgentsSection] Description generation failed:", err);
			new Notice(err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	/**
	 * Call the summarizer to produce a system prompt from the agent's
	 * matched tools. Unlike {@link generateDescription}, this includes
	 * tool names and describes how to use each tool effectively.
	 */
	private async generateSystemPrompt(
		patterns: readonly string[],
		agentName: string,
	): Promise<string | null> {
		const { plugin } = this.ctx;

		const modelConfig = createSummarizerConfig(plugin);
		if (!modelConfig) {
			new Notice(t("settings.agentGenerateDescriptionNoSummarizer"));
			return null;
		}

		const toolInfos = buildMcpToolInfos(plugin.settings.mcpServers, patterns);
		if (toolInfos.length === 0) {
			new Notice(t("settings.agentGenerateDescriptionNoTools"));
			return null;
		}

		const toolSummary = toolInfos.map(t => {
			const desc = t.description?.trim();
			return desc ? `- ${t.name}: ${desc}` : `- ${t.name}`;
		}).join('\n');

		try {
			const generatePrompt = [
				`You are writing a system prompt for a sub-agent named "${agentName}". Below is the list of MCP tools it has access to.`,
				'',
				'Write a clear, instructional system prompt that:',
				'1. Introduces the agent by name and describes its role.',
				'2. Lists each tool with a brief explanation of when and how to use it.',
				'3. Includes any relevant best practices or constraints.',
				'',
				'Wrap the final response in a broad description of HOW to handle the task, not just the tool reference.',
				'',
				'TOOLS:',
				toolSummary,
				'',
				'Output ONLY the system prompt text, with no additional commentary, no markdown code fences, and no preamble.',
			].join('\n');

			const generated = await createChatCompletion(
				modelConfig,
				[{ role: 'user', content: generatePrompt }],
			);

			const trimmed = generated.trim();
			if (!trimmed) {
				new Notice(t("settings.agentGenerateDescriptionEmpty"));
				return null;
			}

			return trimmed;
		} catch (err) {
			if (isAbortError(err)) return null;
			console.error("[AgentsSection] System prompt generation failed:", err);
			new Notice(err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	/**
	 * Show which MCP tools match the agent's patterns.
	 */
	private async renderToolsPreview(
		container: HTMLElement,
		agent: CustomAgentConfig,
	): Promise<void> {
		const { plugin } = this.ctx;
		const patterns = agent.tools;

		if (patterns.length === 0) {
			new Setting(container)
				.setName(t("settings.agentToolsPreview"))
				.setDesc(t("settings.agentToolsPreviewNone"));
			return;
		}

		const mcpTools = buildMcpToolNames(plugin.settings.mcpServers);
		if (mcpTools.length === 0) {
			new Setting(container)
				.setName(t("settings.agentToolsPreview"))
				.setDesc(t("settings.agentToolsPreviewNoMcp"));
			return;
		}

		const matched: string[] = [];
		for (const toolName of mcpTools) {
			if (patterns.some(p => matchesWildcard(p, toolName))) {
				matched.push(toolName);
			}
		}

		if (matched.length === 0) {
			new Setting(container)
				.setName(t("settings.agentToolsPreview"))
				.setDesc(t("settings.agentToolsPreviewNoMatch"));
			return;
		}

		const previewSetting = new Setting(container)
			.setName(t("settings.agentToolsPreview"))
			.setDesc(t("settings.agentToolsPreviewCount", { count: matched.length }));

		const chipList = previewSetting.descEl.createDiv({
			cls: "oap-settings-chip-list",
		});
		for (const name of matched) {
			const chip = chipList.createDiv({
				cls: "oap-agent-tool-chip",
			});
			chip.createSpan({
				cls: "oap-agent-tool-chip-label",
				text: name,
			});
		}
	}
}
