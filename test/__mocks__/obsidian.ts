/**
 * Obsidian API mock for unit tests.
 *
 * This file provides stubs for ALL Obsidian symbols that `src/` code
 * imports as runtime (non-type) imports.  When vitest aliases `obsidian`
 * to this file, every module that references an Obsidian API receives
 * the stub defined here instead of the real Obsidian runtime.
 *
 * ── Add stubs as tests need them ──
 * If a test fails with "Cannot read properties of undefined (reading X)",
 * check the call stack for the missing symbol and add a minimal stub here.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopFn(..._args: unknown[]): any { /* no-op */ }

function createElStub(): HTMLElement {
    return document.createElement('div');
}

function createIconStub(): HTMLElement {
    const span = document.createElement('span');
    span.classList.add('mock-icon');
    return span;
}

// ---------------------------------------------------------------------------
// Core classes (constructor-compatible stubs)
// ---------------------------------------------------------------------------

export class App { vault = new Vault() }

// Vault is a stub — methods that tests rely on must be mocked per-test.
export class Vault {
    adapter = new DataAdapter();
    getAbstractFileByPath(_path: string): unknown { return null; }
    getMarkdownFiles(): unknown[] { return []; }
    read = noopFn;
    modify = noopFn;
    create = noopFn;
    delete = noopFn;
    getFiles = noopFn;
    getAllLoadedFiles = () => [] as unknown[];
}

export class DataAdapter {
    getBasePath = () => '';
    getName = () => 'mock';
}

export class Plugin {
    app = new App();
    manifest = {};
    loadData = async () => ({} as any);
    saveData = async (_data: any) => {};
    addCommand = noopFn;
    addSettingTab = noopFn;
    registerView = noopFn;
    registerExtensions = noopFn;
    registerEvent = noopFn;
    registerDomEvent = noopFn;
    registerInterval = noopFn;
    addRibbonIcon = () => createElStub();
}

export class Component {
    load() { return this; }
    onunload = noopFn;
    registerEvent = noopFn;
    registerDomEvent = noopFn;
    addChild = noopFn;
}

export class PluginSettingTab {
    app: App;
    plugin: Plugin;
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = createElStub();
    }
    display = noopFn;
    hide = noopFn;
}

export class MarkdownView {
    app = new App();
    editor = new Editor();
    file: TFile | null = null;
    contentEl = createElStub();
    constructor() {}
}

export class WorkspaceLeaf {
    view: any = null;
    constructor() {}
}

export class ItemView {
    app: App;
    leaf: WorkspaceLeaf;
    contentEl: HTMLElement;
    navigation = false;
    icon = 'document';
    constructor(leaf: WorkspaceLeaf) {
        this.leaf = leaf;
        this.app = new App();
        this.contentEl = createElStub();
    }
    onOpen = noopFn;
    onClose = noopFn;
    getViewType = () => '';
    getDisplayText = () => '';
    getState = () => ({} as any);
    setState = noopFn;
    getEphemeralState = () => ({} as any);
    setEphemeralState = noopFn;
}

export class Editor {
    getDoc = () => '';
    getValue = () => '';
    setValue = noopFn;
    getCursor = () => ({ line: 0, ch: 0 });
    getSelection = () => '';
    replaceSelection = noopFn;
    replaceRange = noopFn;
    getRange = () => '';
    getLine = () => '';
    lineCount = () => 0;
    lastLine = () => 0;
    setCursor = noopFn;
    setSelection = noopFn;
    scrollIntoView = noopFn;
    focus = noopFn;
    hasFocus = () => false;
    refresh = noopFn;
    wordAt = () => null;
    posToOffset = () => 0;
    offsetToPos = () => ({ line: 0, ch: 0 });
    isClean = () => true;
    markClean = noopFn;
    exec = noopFn;
    on = noopFn;
    off = noopFn;
}

export class MarkdownRenderer {
    static renderMarkdown = async (_markdown: string, _el: HTMLElement, _path: string, _component: Component) => {};
}

export class MarkdownFileInfo {
    app = new App();
}

export class FileView {
    app = new App();
    file: TFile | null = null;
}

export class Menu {
    dom: HTMLElement;
    constructor() { this.dom = createElStub(); }
    addItem = noopFn;
    addSeparator = noopFn;
    setNoIcon = noopFn;
    showAtPosition = noopFn;
    showAtMouseEvent = noopFn;
    hide = noopFn;
    close = noopFn;
}

export class Notice {
    el: HTMLElement;
    constructor(_msg: string | DocumentFragment, _duration?: number) {
        this.el = createElStub();
    }
    setMessage = noopFn;
    hide = noopFn;
    noticeEl = createElStub();
    static clear = noopFn;
}

export class Modal {
    app: App;
    containerEl: HTMLElement;
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;
    constructor(app: App) {
        this.app = app;
        this.containerEl = createElStub();
        this.contentEl = createElStub();
        this.titleEl = createElStub();
        this.modalEl = createElStub();
    }
    open = noopFn;
    close = noopFn;
    onOpen = noopFn;
    onClose = noopFn;
}

export class Setting {
    containerEl: HTMLElement;
    constructor(_containerEl: HTMLElement) {
        this.containerEl = createElStub();
    }
    setName = () => this;
    setDesc = () => this;
    setClass = () => this;
    setHeading = () => this;
    setTooltip = () => this;
    addText = () => new TextComponent(createElStub());
    addTextArea = () => new TextAreaComponent(createElStub());
    addDropdown = () => new DropdownComponent(createElStub());
    addToggle = () => new ToggleComponent(createElStub());
    addSlider = () => new SliderComponent(createElStub());
    addButton = () => new ButtonComponent(createElStub());
    addExtraButton = () => new ExtraButtonComponent(createElStub());
    addColorPicker = () => new ColorComponent(createElStub());
    addMomentFormat = () => new MomentFormatComponent(createElStub());
    then = noopFn;
    infoEl = createElStub();
    nameEl = createElStub();
    descEl = createElStub();
    controlEl = createElStub();
    settingEl = createElStub();
}

export class TextComponent {
    inputEl: HTMLInputElement;
    constructor(_containerEl: HTMLElement) {
        this.inputEl = document.createElement('input');
    }
    setValue = () => this;
    getValue = () => '';
    onChange = () => this;
    setPlaceholder = () => this;
    onChanged = noopFn;
    disabled = false;
}

export class TextAreaComponent {
    inputEl: HTMLTextAreaElement;
    constructor(_containerEl: HTMLElement) {
        this.inputEl = document.createElement('textarea');
    }
    setValue = () => this;
    getValue = () => '';
    onChange = () => this;
    setPlaceholder = () => this;
}

export class DropdownComponent {
    selectEl: HTMLSelectElement;
    constructor(_containerEl: HTMLElement) {
        this.selectEl = document.createElement('select');
    }
    addOption = () => this;
    setValue = () => this;
    getValue = () => '';
    onChange = () => this;
    addOptions = () => this;
}

export class ToggleComponent {
    toggleEl: HTMLInputElement;
    constructor(_containerEl: HTMLElement) {
        this.toggleEl = document.createElement('input');
        this.toggleEl.type = 'checkbox';
    }
    setValue = () => this;
    getValue = () => false;
    onChange = () => this;
}

export class ButtonComponent {
    buttonEl: HTMLButtonElement;
    constructor(_containerEl: HTMLElement) {
        this.buttonEl = document.createElement('button');
    }
    setButtonText = () => this;
    setCta = () => this;
    setIcon = () => this;
    setTooltip = () => this;
    onClick = () => this;
    setClass = () => this;
    setDisabled = () => this;
    then = noopFn;
    removeButton = () => this;
}

export class ExtraButtonComponent {
    extraSettingsEl: HTMLElement;
    constructor(_containerEl: HTMLElement) {
        this.extraSettingsEl = createElStub();
    }
    setIcon = () => this;
    setTooltip = () => this;
    onClick = () => this;
}

export class SliderComponent {
    sliderEl: HTMLInputElement;
    constructor(_containerEl: HTMLElement) {
        this.sliderEl = document.createElement('input');
        this.sliderEl.type = 'range';
    }
    setValue = () => this;
    getValue = () => '0';
    onChange = () => this;
    setLimits = () => this;
    setDynamicTooltip = () => this;
}

export class ColorComponent {
    colorPickerEl: HTMLInputElement;
    constructor(_containerEl: HTMLElement) {
        this.colorPickerEl = document.createElement('input');
        this.colorPickerEl.type = 'color';
    }
    setValue = () => this;
    getValue = () => '#000000';
    onChange = () => this;
}

export class MomentFormatComponent {
    sampleEl: HTMLElement;
    constructor(_containerEl: HTMLElement) {
        this.sampleEl = createElStub();
    }
    setValue = () => this;
    getValue = () => '';
    onChange = () => this;
    setPlaceholder = () => this;
    setDefaultFormat = () => this;
    updateSample = noopFn;
}

export class SecretComponent {
    inputEl: HTMLInputElement;
    visibleButtonEl: HTMLElement;
    maskButtonEl: HTMLElement;
    constructor(_containerEl: HTMLElement) {
        this.inputEl = document.createElement('input');
        this.inputEl.type = 'password';
        this.visibleButtonEl = createElStub();
        this.maskButtonEl = createElStub();
    }
    setValue = () => this;
    getValue = () => '';
    onChange = () => this;
}

// ---------------------------------------------------------------------------
// File / folder stubs
// ---------------------------------------------------------------------------

export class TFile {
    path = '';
    name = '';
    basename = '';
    extension = '';
    stat = { ctime: 0, mtime: 0, size: 0 };
    parent: TFolder | null = null;
    vault = new Vault();
    constructor(path = '') {
        this.path = path;
        const idx = path.lastIndexOf('/');
        this.name = idx >= 0 ? path.slice(idx + 1) : path;
        const dot = this.name.lastIndexOf('.');
        this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
        this.extension = dot >= 0 ? this.name.slice(dot + 1) : '';
    }
}

export class TFolder {
    path = '';
    name = '';
    isRoot = () => false;
    children: unknown[] = [];
    parent: TFolder | null = null;
    vault = new Vault();
    constructor(path = '') {
        this.path = path;
        const idx = path.lastIndexOf('/');
        this.name = idx >= 0 ? path.slice(idx + 1) : path;
    }
}

export class TAbstractFile {
    path = '';
    name = '';
    vault = new Vault();
    parent: TFolder | null = null;
    constructor(path = '') {
        this.path = path;
    }
}

// ---------------------------------------------------------------------------
// Environment / platform
// ---------------------------------------------------------------------------

export const Platform = {
    isDesktop: true,
    isMobile: false,
    isDesktopApp: true,
    isMobileApp: false,
    isMacOS: false,
    isWin: true,
    isLinux: false,
    isIosApp: false,
    isAndroidApp: false,
    isSafari: false,
    resourcePathPrefix: '',
};

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

export function getLanguage(): string {
    return 'en';
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/\/+/g, '/');
}

export function debounce<T extends (...args: any[]) => any>(
    fn: T,
    _delay?: number,
    _immediate?: boolean,
): T {
    return fn as T;
}

export function setIcon(iconEl: HTMLElement, _iconId: string): void {
    // no-op: tests don't need actual SVGs
}

export function setTooltip(el: HTMLElement, _tooltip: string, _options?: unknown): void {
    // no-op
}

export function requestUrl(_req: unknown): Promise<{ status: number; headers: Record<string, string>; json: any; text: string; arrayBuffer: ArrayBuffer }> {
    return Promise.resolve({
        status: 200,
        headers: {},
        json: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
    });
}

export function arrayBufferToBase64(buffer: ArrayBufferLike): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function getAllTags(_cache: unknown): string[] | null {
    return null;
}

export function getFrontMatterInfo(_editor: unknown): { from: number; to: number; exists: boolean; frontmatterPosition: unknown; contentStart: number } {
    return { from: 0, to: 0, exists: false, frontmatterPosition: null, contentStart: 0 };
}

export function parseYaml(_yaml: string): any {
    return {};
}

export function stringifyYaml(_obj: unknown): string {
    return '';
}

// ---------------------------------------------------------------------------
// moment.js stub (Obsidian re-exports a tailored version)
// ---------------------------------------------------------------------------

export const moment = {
    locale: (): string => '',
    utc: () => moment,
    format: () => '',
    fromNow: () => '',
    diff: () => 0,
    valueOf: () => 0,
    toDate: () => new Date(),
    add: () => moment,
    subtract: () => moment,
    startOf: () => moment,
    endOf: () => moment,
    isBefore: () => false,
    isAfter: () => false,
    isSame: () => false,
    isSameOrBefore: () => false,
    isSameOrAfter: () => false,
};

// ---------------------------------------------------------------------------
// Type re-exports (needed when imported as value imports)
// ---------------------------------------------------------------------------

/** Obsidian uses `string` as IconName; re-export as a named symbol for value imports. */
export type IconName = string;

/** RequestUrlParam is an interface in Obsidian. When imported as a value it
 *  resolves to `undefined` at runtime, but core code uses it for type
 *  annotations.  A typed export satisfies vitest's module resolver. */
export type RequestUrlParam = unknown;
