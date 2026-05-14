import { describe, it, expect } from 'vitest';
import { createObsidianEditorTools } from '../src/services/tools/obsidian';
import {
    VAULT_EDITOR_DESCRIPTION,
    VAULT_EDITOR_PROMPT,
    VAULT_EDITOR_ROUTING_KEYWORDS,
} from '../src/services/prompts/sub-agent-prompts';
import { RESULT_VALIDATORS } from '../src/services/result-validators';

// ─────────────────────────────────────────────────────────────────────────────
// Static surface checks for the `vault_editor` sub-agent.
//
// The editor's BEHAVIOUR (does it actually refuse multi-file tasks?
// does it really call write_file with expected_pre_edit_mtime?) can only
// be exercised against a real LLM, and that's covered by the manual
// smoke steps in docs/vault-editor-subagent-plan.md §10. What CAN drift
// silently without a test is the static surface — which tools the
// sub-agent is wired with, and whether the prompt still contains the
// key phrases that anchor its contract.
//
// This file pins those. Losing any of these assertions means a future
// change could (a) accidentally give the editor structural tools like
// `delete_files` and reintroduce the routing ambiguity we closed, or
// (b) drop a prompt phrase that the real-world LLM was anchoring on,
// silently degrading end-to-end behaviour.
// ─────────────────────────────────────────────────────────────────────────────

// Stub plugin. The tool factories only touch `plugin.app` inside their
// `exec` closures, which these tests never invoke — so an empty stub is
// sufficient to collect the static tool list.
const stubPlugin = { app: {} } as unknown as Parameters<typeof createObsidianEditorTools>[0];

function getToolNames(): string[] {
    return createObsidianEditorTools(stubPlugin).map((t) => t.schema.function.name);
}

describe('createObsidianEditorTools — tool surface', () => {
    it('includes the full read-only inspection surface', () => {
        const names = new Set(getToolNames());
        // Representative sample of the read-only tools — the full
        // list is pinned by the inspector's own design. We only need
        // to confirm the editor inherits it.
        expect(names.has('read_file')).toBe(true);
        expect(names.has('read_section')).toBe(true);
        expect(names.has('grep_file')).toBe(true);
        expect(names.has('get_metadata')).toBe(true);
        expect(names.has('browse_folder')).toBe(true);
    });

    it('includes the content-write tools (replace_text, edit_lines, append, prepend, write_file)', () => {
        const names = new Set(getToolNames());
        expect(names.has('replace_text')).toBe(true);
        expect(names.has('edit_lines')).toBe(true);
        expect(names.has('append_file')).toBe(true);
        expect(names.has('prepend_file')).toBe(true);
        expect(names.has('write_file')).toBe(true);
    });

    it('EXCLUDES structural mutation tools (create / delete / rename / tag edits)', () => {
        // These stay on the main agent. Giving them to the editor would
        // re-open the routing ambiguity that made us split inspector
        // from mutator in the first place, and would let the editor
        // "tidy up" state that the main agent can't see.
        const names = new Set(getToolNames());
        expect(names.has('create_file')).toBe(false);
        expect(names.has('delete_files')).toBe(false);
        expect(names.has('delete_folder')).toBe(false);
        expect(names.has('rename_or_move_file')).toBe(false);
        expect(names.has('edit_file_tags')).toBe(false);
        expect(names.has('rename_tag')).toBe(false);
    });

    it('EXCLUDES delegate_task (no sub-agent recursion)', () => {
        // Sub-agents never get delegate_task — the orchestrator injects
        // it only on the main agent. This is a belt-and-braces check
        // that createObsidianEditorTools isn't accidentally bundling it.
        const names = new Set(getToolNames());
        expect(names.has('delegate_task')).toBe(false);
    });
});

describe('VAULT_EDITOR_PROMPT — key anchors', () => {
    // Each of these phrases is load-bearing for the editor's contract.
    // The prompt wording can evolve, but these specific commitments
    // (ONE file per task, exchange.put('result', ...), the hard limits
    // on sample_diff) should remain visible in the prompt body.
    const phrases: Array<{ pattern: string; why: string }> = [
        { pattern: 'ONE file per task', why: 'scope hard-limit that prevents editor from fanning out' },
        { pattern: "exchange", why: 'must mention the exchange tool for result emission' },
        { pattern: 'sample_diff', why: 'names the canonical diff-summary field' },
        { pattern: 'wholesale', why: 'names one of the four strategy values' },
        { pattern: 'surgical', why: 'names another strategy value' },
        { pattern: 'noop', why: 'ensures no-op path is covered' },
        { pattern: 'write_file', why: 'surfaces the wholesale-rewrite tool choice' },
        { pattern: 'replace_text', why: 'surfaces the surgical tool choice' },
        { pattern: 'expected_pre_edit_mtime', why: 'race guard is mentioned' },
        { pattern: 'do NOT', why: 'retain the refusal-style anti-patterns section' },
    ];

    for (const { pattern, why } of phrases) {
        it(`contains "${pattern}" (${why})`, () => {
            expect(VAULT_EDITOR_PROMPT).toContain(pattern);
        });
    }

    it('has a non-trivial body', () => {
        // Guard against future refactors that accidentally empty the prompt.
        expect(VAULT_EDITOR_PROMPT.length).toBeGreaterThan(1000);
    });
});

describe('VAULT_EDITOR_DESCRIPTION', () => {
    it('states the ONE-file boundary so the main agent can route correctly', () => {
        expect(VAULT_EDITOR_DESCRIPTION).toMatch(/ONE|one/);
        // Should explicitly mention what it does NOT do, since the main
        // agent's routing policy relies on that.
        expect(VAULT_EDITOR_DESCRIPTION).toMatch(/(not|NOT)/);
    });
});

describe('VAULT_EDITOR_ROUTING_KEYWORDS', () => {
    it('contains both English and CJK rewrite intents', () => {
        const kws = VAULT_EDITOR_ROUTING_KEYWORDS;
        expect(kws).toContain('reformat');
        expect(kws).toContain('translate');
        // At least one Chinese keyword:
        expect(kws.some((k) => /[一-龥]/.test(k))).toBe(true);
    });

    it('does NOT contain pure inspect verbs that belong to vault_inspector', () => {
        // If 'read' or 'search' leak into the editor routing keywords,
        // the main agent's keyword-based hint layer would start biasing
        // read-only tasks toward the editor. Guard against that drift.
        const kws = new Set(VAULT_EDITOR_ROUTING_KEYWORDS);
        expect(kws.has('read')).toBe(false);
        expect(kws.has('search')).toBe(false);
    });
});

describe('RESULT_VALIDATORS.vault_editor', () => {
    it('is registered so buildDelegatePayload enforces schema for this sub-agent', () => {
        // The orchestrator looks validators up by sub-agent name. A
        // validator file that exists but isn't plumbed into the
        // registry is a dead weight — this test ensures the wiring
        // survives refactors.
        expect(typeof RESULT_VALIDATORS['vault_editor']).toBe('function');
    });
});
