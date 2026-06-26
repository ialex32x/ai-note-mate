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

/** Default config seeded when adding a new agent. */
function defaultAgentConfig(): CustomAgentConfig {
	return { name: "", tools: ["mcp_*"], profile: "", description: "", systemPrompt: "", disabled: false };
}

/**
 * Custom agents (sub-agents) settings panel.
 */
export class AgentsSettingsSection implements SettingsSection {
	readonly titleKey = AGENTS_SECTION_ID;
	private editingIndex = 0;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const agents = plugin.settings.agents;

		if (agents.length === 0) {
			new Setting(container)
				.setName(t("settings.agentsEmpty"))
				.setDesc(t("settings.agentsEmptyDesc"))
				.addButton(btn => {
					btn.setIcon("plus");
					btn.setButtonText(t("settings.addAgent"));
					btn.setCta();
					btn.onClick(async () => {
						agents.push(defaultAgentConfig());
						this.editingIndex = 0;
						await plugin.saveSettings();
						refreshSection(this);
					});
				});
			return;
		}

		this.editingIndex = Math.min(Math.max(this.editingIndex, 0), agents.length - 1);
		const idx = this.editingIndex;

		const tabBar = createTabBar({
			container,
			items: agents.map((agent, i) => ({
				id: String(i),
				name: this.tabLabel(agent),
				tooltip: agent.description || undefined,
			})),
			activeId: String(idx),
			editingId: String(idx),
			onTabClick: (id) => {
				this.editingIndex = Number(id);
				refreshSection(this);
			},
			onAdd: async () => {
				agents.push(defaultAgentConfig());
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

	private tabLabel(agent: CustomAgentConfig): string {
		return (agent.name ?? "").trim() || t("settings.agentUntitled");
	}

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
						String(idx),
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
				// Ensure the stored ID is still valid; fall back to inherited.
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

		// ── Description (full-width textarea + hover generate button) ──
		this.renderDescriptionField(container, agent, idx, refreshTabLabel);

		// ── System Prompt (full-width textarea + hover generate button) ──
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
		const heading = container.createEl("div", {
			cls: "setting-item",
		});
		const info = heading.createEl("div", { cls: "setting-item-info" });
		info.createEl("div", {
			cls: "setting-item-name",
			text: t("settings.agentDescription"),
		});
		info.createEl("div", {
			cls: "setting-item-description",
			text: t("settings.agentDescriptionDesc"),
		});

		// Wrapper for textarea + hover button.
		const wrapper = container.createEl("div", {
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
					String(idx),
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
							String(idx),
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
		const heading = container.createEl("div", { cls: "setting-item" });
		const info = heading.createEl("div", { cls: "setting-item-info" });
		info.createEl("div", {
			cls: "setting-item-name",
			text: t("settings.agentSystemPrompt"),
		});
		info.createEl("div", {
			cls: "setting-item-description",
			text: t("settings.agentSystemPromptDesc"),
		});

		const wrapper = container.createEl("div", { cls: "oap-agent-desc-wrapper" });
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
							String(idx),
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

		const chipList = previewSetting.descEl.createEl("div", {
			cls: "oap-settings-chip-list",
		});
		for (const name of matched) {
			const chip = chipList.createEl("div", {
				cls: "oap-agent-tool-chip",
			});
			chip.createEl("span", {
				cls: "oap-agent-tool-chip-label",
				text: name,
			});
		}
	}
}
