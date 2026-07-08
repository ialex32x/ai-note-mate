/**
 * Memory consolidation — one-shot LLM pass that merges related non-critical
 * entries and deletes obsolete ones when the pool grows beyond the configured
 * threshold.
 *
 * Triggered after auto-extraction (see {@link ../memory-runner}) so the
 * summarizer call is piggybacked on the same cheap-model profile and the
 * same runtime lifecycle. Consolidation is gated by:
 *   1. Threshold: non-critical count > {@link memoryConsolidateThreshold}
 *   2. Cooldown: at least {@link memoryConsolidateCooldownHours} since the
 *      last successful run (persisted to `sessions/state.json`)
 *
 * Hard guarantees:
 *   - Only non-critical entries are touched. Critical entries are read-only.
 *   - Never throws. All paths are wrapped in try/catch with console logging.
 *   - Empty output / parse failure → no-op (don't break the chat turn).
 *   - Per-op isolation: one failed store operation does not block the rest.
 */

import type NoteAssistantPlugin from '../../main';
import type { MinimalModelConfig } from '../llm-provider';
import { createInsightsConfig } from '../chat-factory';
import { createChatCompletion } from '../context-compression';
import { stripCallouts } from './body-sanitizer';
import { stripCriticalSuffix } from './heading-format';
import { MEMORY_CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationUserPrompt } from './prompts';
import type { MemoryEntry } from './memory-note-parser';
import { isMemoryConfigured, MemoryStoreError } from './memory-store';
import { isAbortError } from '../../utils/abortable-request';

const MAX_HEADING_LEN = 60;
const MAX_BODY_LEN = 600;
/** Vault-relative path to the plugin-wide runtime state cache. */
const STATE_FILE = 'state.json';

/**
 * Module-level guard to prevent concurrent consolidation runs from
 * multiple sessions. When one session triggers consolidation, any
 * concurrent callers skip (the first run will update the cooldown
 * timestamp, so the next turn across all sessions will see it).
 */
let consolidationInProgress = false;

/** Shape of `sessions/state.json`. */
interface PluginRuntimeState {
	memoryLastConsolidatedTime: number;
}

interface ConsolidationOp {
	op: 'upsert' | 'delete';
	heading: string;
	critical?: boolean;
	body?: string;
}

/**
 * Check whether consolidation should run and, if so, execute it.
 *
 * Called after auto-extraction has applied its own upserts/deletes so the
 * pool count is current. The `signal` ties the LLM call to the owning
 * runtime's lifecycle.
 */
export async function maybeConsolidateMemories(
	plugin: NoteAssistantPlugin,
	signal?: AbortSignal,
): Promise<void> {
	const settings = plugin.settings;

	// Gate 1: feature must be enabled and configured
	if (!isMemoryConfigured(plugin)) return;

	const threshold = Math.max(0, settings.memoryConsolidateThreshold | 0);
	if (threshold <= 0) return;

	// Gate 2: threshold must be exceeded
	const store = plugin.memoryStore;
	let entries: MemoryEntry[];
	try {
		entries = await store.refreshEntries();
	} catch (err) {
		console.warn('[Memory] consolidator failed to read entries:', err);
		return;
	}

	const nonCritical = entries.filter(e => !e.critical);
	if (nonCritical.length <= threshold) return;

	// Gate 3: cooldown must have expired
	const cooldownMs = Math.max(0, settings.memoryConsolidateCooldownHours | 0) * 3600_000;
	const lastRun = await loadLastConsolidatedTime(plugin);
	const now = Date.now();
	if (cooldownMs > 0 && lastRun > 0 && (now - lastRun) < cooldownMs) {
		return;
	}

	// Gate 4: need a model config
	const modelConfig = createInsightsConfig(plugin);
	if (!modelConfig) {
		console.warn('[Memory] consolidation skipped: no insights model configured');
		return;
	}

	// Gate 5: prevent concurrent consolidation across multiple sessions.
	// The first caller proceeds; any concurrent callers skip so we don't
	// double-spend tokens or race on the memory file.
	if (consolidationInProgress) {
		console.warn('[Memory] consolidation skipped: another run is already in progress');
		return;
	}
	consolidationInProgress = true;

	try {
		console.warn(`[Memory] consolidation triggered: ${nonCritical.length} non-critical entries (threshold=${threshold})`);

		let ops: ConsolidationOp[];
		try {
			ops = await runConsolidation(modelConfig, entries, nonCritical.length, threshold, signal);
		} catch (err) {
			if (isAbortError(err)) throw err;
			console.warn('[Memory] consolidation LLM call failed:', err);
			return;
		}

		if (ops.length === 0) {
			// Pool is already clean — still bump the timestamp so we respect cooldown.
			await persistLastConsolidatedTime(plugin, now);
			return;
		}

		// Apply operations — per-op isolation so one failure doesn't block others.
		let appliedUpserts = 0;
		let appliedDeletes = 0;
		// Index critical headings for a fast guard: the LLM is instructed not
		// to touch critical entries, but we enforce it here as a safety net.
		const criticalHeadings = new Set(
			entries.filter(e => e.critical).map(e => e.logicalHeading.toLowerCase()),
		);
		for (const op of ops) {
			try {
				if (op.op === 'upsert') {
					// Only upsert non-critical entries.
					await store.upsert(op.heading, false, op.body ?? '');
					appliedUpserts++;
				} else {
					// Safety net: refuse to delete critical entries even if
					// the LLM mistakenly emitted a delete for one.
					if (criticalHeadings.has(op.heading.toLowerCase())) {
						console.warn(`[Memory] consolidation refused to delete critical entry "${op.heading}"`);
						continue;
					}
					await store.delete(op.heading);
					appliedDeletes++;
				}
			} catch (err) {
				if (err instanceof MemoryStoreError) {
					console.warn(`[Memory] consolidation op failed (kind=${err.kind}, op=${op.op} "${op.heading}"):`, err.message);
				} else {
					console.warn(`[Memory] consolidation op failed (op=${op.op} "${op.heading}"):`, err);
				}
			}
		}

		// Persist the timestamp even on partial success — the cooldown still
		// applies to avoid thrashing on a problematic pool.
		await persistLastConsolidatedTime(plugin, now);

		console.warn(`[Memory] consolidation complete: ${appliedUpserts} upserts, ${appliedDeletes} deletes applied`);
	} finally {
		consolidationInProgress = false;
	}
}

// ─── Core LLM call ─────────────────────────────────────────────────────────

async function runConsolidation(
	modelConfig: MinimalModelConfig,
	entries: ReadonlyArray<MemoryEntry>,
	count: number,
	threshold: number,
	signal?: AbortSignal,
): Promise<ConsolidationOp[]> {
	const existingForPrompt = entries.map(e => ({
		heading: e.logicalHeading,
		critical: e.critical,
		body: stripCallouts(e.body),
	}));

	const system = MEMORY_CONSOLIDATION_SYSTEM_PROMPT
		.replace('{count}', String(count))
		.replace('{threshold}', String(threshold));
	const userPrompt = buildConsolidationUserPrompt(existingForPrompt);

	const raw = await createChatCompletion(modelConfig, [
		{ role: 'system', content: system },
		{ role: 'user', content: userPrompt },
	], signal);

	if (!raw || !raw.trim()) return [];

	const parsed = parseConsolidationJson(raw);
	if (!parsed) return [];

	return normalizeConsolidationOps(parsed);
}

// ─── JSON parsing (tolerant of code fences / surrounding prose) ────────────

function parseConsolidationJson(raw: string): unknown[] | null {
	const trimmed = raw.trim();
	const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	const candidate = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;

	const direct = tryParseArray(candidate);
	if (direct) return direct;

	// Find first balanced `[...]` substring.
	const start = candidate.indexOf('[');
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < candidate.length; i++) {
		const ch = candidate[i];
		if (escape) { escape = false; continue; }
		if (ch === '\\' && inString) { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === '[') depth++;
		else if (ch === ']') {
			depth--;
			if (depth === 0) {
				const slice = candidate.slice(start, i + 1);
				const arr = tryParseArray(slice);
				if (arr) return arr;
				break;
			}
		}
	}
	return null;
}

function tryParseArray(s: string): unknown[] | null {
	try {
		const v = JSON.parse(s) as unknown;
		return Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

// ─── Normalisation ─────────────────────────────────────────────────────────

function normalizeConsolidationOps(raw: unknown[]): ConsolidationOp[] {
	const out: ConsolidationOp[] = [];
	const seenHeadings = new Set<string>();

	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') continue;
		const obj = entry as Record<string, unknown>;

		const op = typeof obj.op === 'string' ? obj.op.toLowerCase() : '';
		const headingRaw = typeof obj.heading === 'string' ? obj.heading : '';
		const heading = stripCriticalSuffix(headingRaw).slice(0, MAX_HEADING_LEN).trim();
		if (!heading) continue;

		// Deduplicate within this batch.
		const dedupeKey = `${op}::${heading.toLowerCase()}`;
		if (seenHeadings.has(dedupeKey)) continue;
		seenHeadings.add(dedupeKey);

		if (op === 'upsert') {
			const body = cleanBody(obj.body);
			if (!body) continue;
			// Always force critical=false — consolidation only touches non-critical.
			out.push({ op: 'upsert', heading, critical: false, body });
		} else if (op === 'delete') {
			out.push({ op: 'delete', heading });
		}
		// Unknown ops silently dropped.
	}
	return out;
}

function cleanBody(v: unknown): string {
	if (typeof v !== 'string') return '';
	const s = v.replace(/\r/g, '').trim();
	if (!s) return '';
	if (s.length <= MAX_BODY_LEN) return s;
	return s.slice(0, MAX_BODY_LEN - 1).trimEnd() + '…';
}

// ─── Runtime state persistence (sessions/state.json) ───────────────────────

function statePath(plugin: NoteAssistantPlugin): string {
	return `${plugin.paths.sessions()}/${STATE_FILE}`;
}

/**
 * Try to load the last-consolidated timestamp from `sessions/state.json`.
 * Returns 0 (never run) when the file is missing, malformed, or I/O fails.
 */
async function loadLastConsolidatedTime(plugin: NoteAssistantPlugin): Promise<number> {
	try {
		const adapter = plugin.app.vault.adapter;
		const raw = await adapter.read(statePath(plugin));
		if (!raw) return 0;
		const parsed = JSON.parse(raw) as Partial<PluginRuntimeState>;
		return typeof parsed.memoryLastConsolidatedTime === 'number'
			? parsed.memoryLastConsolidatedTime
			: 0;
	} catch {
		return 0;
	}
}

/**
 * Persist the last-consolidated timestamp to `sessions/state.json`.
 * Merges with any existing fields so other consumers can share this file.
 * I/O errors are silently swallowed — this is a best-effort cache.
 */
async function persistLastConsolidatedTime(plugin: NoteAssistantPlugin, timestamp: number): Promise<void> {
	try {
		const adapter = plugin.app.vault.adapter;
		const path = statePath(plugin);

		// Load existing state to merge, so we don't clobber other fields.
		let existing: Record<string, unknown> = {};
		try {
			const raw = await adapter.read(path);
			if (raw) {
				const parsed: unknown = JSON.parse(raw);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					existing = parsed as Record<string, unknown>;
				}
			}
		} catch { /* file doesn't exist yet — start fresh */ }

		existing.memoryLastConsolidatedTime = timestamp;
		void adapter.write(path, JSON.stringify(existing))
			.catch(() => { /* non-critical, ignore */ });
	} catch { /* non-critical, ignore */ }
}
