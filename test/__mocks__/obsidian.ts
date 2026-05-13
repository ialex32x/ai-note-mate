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
 * Provide a tolerant default export for any other Obsidian APIs the
 * codebase imports — vitest will fail on missing named exports if we
 * keep this file completely empty. Add stubs here as tests need them.
 */
