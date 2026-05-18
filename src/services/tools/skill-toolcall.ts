import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";

/**
 * Create skill-related tool collection.
 *
 * Currently exposes a single tool, `load_skill`, which implements the
 * progressive-disclosure pattern for skills: the system prompt only
 * advertises skill names + descriptions, and the model calls this tool
 * to retrieve the full body of a specific skill before following it.
 *
 * @param plugin Plugin instance (provides access to the shared SkillManager)
 * @returns Array of registered tools
 */
export function createSkillTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        loadSkill(plugin),
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: load_skill
// ─────────────────────────────────────────────────────────────────────────────

function loadSkill(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "load_skill",
                description:
                    "Load the full procedure of a skill listed in the system prompt's " +
                    "'## Available Skills' catalogue. Call this BEFORE executing a skill, " +
                    "and ONLY when that skill's procedure has not already been provided " +
                    "earlier in the current conversation \u2014 catalogue entries tagged " +
                    "`[loaded]` (or any skill auto-loaded above the catalogue via the " +
                    "'Skill Pre-Loaded For This Turn' banner) are already in your " +
                    "context; reuse them directly without re-calling this tool. The only " +
                    "reason to re-call for a `[loaded]` skill is if the user indicates " +
                    "the skill has been modified and the latest version is needed. Pass " +
                    "the skill name verbatim as it appears in the catalogue. Do not " +
                    "guess skill contents.",
                parameters: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description:
                                "The exact skill name as advertised in 'Available Skills'. " +
                                "Matching is case-insensitive.",
                        },
                    },
                    required: ["name"],
                },
            },
        },
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const rawName = args["name"];
            if (typeof rawName !== "string" || !rawName.trim()) {
                return {
                    success: false,
                    type: "text",
                    content: "Missing required parameter: 'name' (non-empty string).",
                };
            }
            const name = rawName.trim();

            const manager = plugin.skillManager;

            // Pick up any on-disk edits the user may have made since the
            // skill was last loaded. Safe no-op when mtime is unchanged
            // or the skill is frozen (e.g. built-in).
            await manager.refreshSkillIfStale(name);

            const skill = manager.getSkill(name);
            if (!skill || skill.disabled) {
                const available = manager.getSkills().map(s => s.name);
                const hint = available.length > 0
                    ? ` Available skills: ${available.join(", ")}.`
                    : " No skills are currently available.";
                return {
                    success: false,
                    type: "text",
                    content: `Skill "${name}" not found or disabled.${hint}`,
                };
            }

            const instructions = manager.buildSkillInstructions(skill.name);
            if (!instructions) {
                return {
                    success: false,
                    type: "text",
                    content: `Failed to build instructions for skill "${skill.name}".`,
                };
            }

            manager.activateSkill(skill.name);

            return {
                success: true,
                type: "text",
                content: instructions,
            };
        },
    };
}
