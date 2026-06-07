/**
 * Minimal DOM query helper — drop-in replacement for the cheerio APIs
 * used across the search module. Powered by the browser's built-in
 * {@link DOMParser}, no dependencies.
 */

/** Mirrors the subset of CheerioAPI that the search module relies on. */
export interface QueryHandle {
    find(selector: string): QueryHandle;
    first(): QueryHandle;
    each(fn: (i: number, el: Element) => void | false): QueryHandle;
    text(): string;
    attr(name: string): string | undefined;
    prop(name: string): string | undefined;
    get(index: number): Element | undefined;
    remove(): QueryHandle;
    not(selector: string): QueryHandle;
    contents(): QueryHandle;
    readonly length: number;
}

/** A callable query function: `$(selector)` or `$(element)`. */
export interface QueryFn {
    (selector: string | Element): QueryHandle;
}

/** Error marker element that DOMParser returns for malformed XML. */
const PARSER_ERROR_TAG = 'parsererror';

class Handle implements QueryHandle {
    private readonly _els: readonly Element[];
    private readonly _doc: Document;

    constructor(els: Iterable<Element>, doc: Document) {
        this._els = [...els];
        this._doc = doc;
    }

    get length(): number {
        return this._els.length;
    }

    find(selector: string): QueryHandle {
        const found: Element[] = [];
        for (const el of this._els) {
            found.push(...Array.from(el.querySelectorAll(selector)));
        }
        return new Handle(found, this._doc);
    }

    first(): QueryHandle {
        return new Handle(this._els.slice(0, 1), this._doc);
    }

    each(fn: (i: number, el: Element) => void | false): QueryHandle {
        for (let i = 0; i < this._els.length; i++) {
            if (fn(i, this._els[i]!) === false) break;
        }
        return this;
    }

    text(): string {
        return this._els.map((el) => el.textContent ?? '').join('');
    }

    attr(name: string): string | undefined {
        return this._els[0]?.getAttribute(name) ?? undefined;
    }

    prop(name: string): string | undefined {
        if (name === 'tagName') {
            return this._els[0]?.tagName.toLowerCase();
        }
        return undefined;
    }

    get(index: number): Element | undefined {
        return this._els[index];
    }

    remove(): QueryHandle {
        for (const el of this._els) {
            el.remove();
        }
        return this;
    }

    not(selector: string): QueryHandle {
        const kept: Element[] = [];
        for (const el of this._els) {
            if (!el.matches(selector)) {
                kept.push(el);
            }
        }
        return new Handle(kept, this._doc);
    }

    contents(): QueryHandle {
        const children: Element[] = [];
        for (const el of this._els) {
            for (let ci = 0; ci < el.childNodes.length; ci++) {
                const child: Node = el.childNodes[ci]!;
                if (child.nodeType === 1 /* Element */ || child.nodeType === 3 /* Text */) {
                    children.push(child as unknown as Element);
                }
            }
        }
        return new Handle(children, this._doc);
    }
}

function createQueryFromDoc(doc: Document): QueryFn {
    return (selector: string | Element): QueryHandle => {
        if (typeof selector === 'string') {
            return new Handle(Array.from(doc.querySelectorAll(selector)), doc);
        }
        return new Handle([selector], doc);
    };
}

/**
 * Parse HTML/XML into a query function.
 *
 * For XML content (RSS/Atom), tries `text/xml` first, falling back to
 * `text/html` if the document contains a parser error — so malformed
 * feeds still parse.
 */
export function parseDocument(
    source: string,
    opts?: { xmlMode?: boolean },
): QueryFn {
    if (opts?.xmlMode) {
        const xmlDoc = new DOMParser().parseFromString(source, 'text/xml');
        if (
            !xmlDoc.documentElement ||
            xmlDoc.documentElement.tagName?.toLowerCase() !== PARSER_ERROR_TAG
        ) {
            return createQueryFromDoc(xmlDoc);
        }
    }
    const doc = new DOMParser().parseFromString(source, 'text/html');
    return createQueryFromDoc(doc);
}

/** Convenience: parse HTML and extract the title. */
export function extractTitle($: QueryFn): string {
    return (
        $('title').text().trim() ||
        $('h1').first().text().trim() ||
        'No Title'
    );
}

/** Convenience: remove noisy elements (scripts, styles, noscript). */
export function stripNoise($: QueryFn): void {
    $('script, style, noscript').remove();
}
