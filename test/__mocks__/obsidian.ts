// Minimal obsidian mock for unit tests.
// Only stub what the tested modules actually import from 'obsidian'.

/**
 * Stand-in for `TFile`. Mocks are constructor-friendly so tests can
 * fabricate file references without needing the real Obsidian
 * runtime. Tests use `new TFile()` and set `.path` directly; the
 * `instanceof TFile` checks in production code resolve against this
 * class via vitest's module alias.
 */
export class TFile {
    path = "";
    name = "";
    constructor(path = "") {
        this.path = path;
        const idx = path.lastIndexOf("/");
        this.name = idx >= 0 ? path.slice(idx + 1) : path;
    }
}

/** Folder counterpart; same minimal shape, kept for symmetry. */
export class TFolder {
    path = "";
    children: unknown[] = [];
    constructor(path = "") {
        this.path = path;
    }
}

/** Common base; `instanceof TAbstractFile` is rarely checked in tests. */
export class TAbstractFile {
    path = "";
    constructor(path = "") {
        this.path = path;
    }
}

/** Generic Notice stub. Production code uses it for UI surfacing. */
export class Notice {
    constructor(_msg: string) { /* no-op */ }
}

/**
 * Stub for Obsidian's UI-language API (`getLanguage`, since 1.8.7).
 * Tests don't normally cross-test the i18n auto-detect path, but
 * `src/i18n.ts` imports the symbol at module load, so we need a
 * named export here even if no test actually invokes it. Returns
 * `'en'` so any accidental call falls through to the English bundle.
 */
export function getLanguage(): string {
    return 'en';
}

/**
 * Minimal `moment` stub: only `locale()` (no arg → getter) is touched
 * by `resolveLocale`. Returning `''` keeps the resolver in the
 * `navigator.language` / `'en'` branches without needing the real
 * moment.js library at test time.
 */
export const moment = {
    locale: (): string => '',
};

/**
 * Provide a tolerant default export for any other Obsidian APIs the
 * codebase imports — vitest will fail on missing named exports if we
 * keep this file completely empty. Add stubs here as tests need them.
 */
