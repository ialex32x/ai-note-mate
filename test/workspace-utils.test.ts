import { describe, expect, it } from 'vitest';
import { App, TFile, TFolder } from 'obsidian';
import { resolveFileRef } from '../src/utils/workspace-utils';

function makeApp(files: Array<{ path: string; kind: 'file' | 'folder' }>): App {
    const byPath = new Map<string, TFile | TFolder>();
    const childrenByParent = new Map<string, Array<TFile | TFolder>>();

    for (const entry of files) {
        const node = entry.kind === 'folder'
            ? new TFolder(entry.path)
            : new TFile(entry.path);
        byPath.set(entry.path, node);

        const slash = entry.path.lastIndexOf('/');
        const parentPath = slash >= 0 ? entry.path.slice(0, slash) : '';
        const siblings = childrenByParent.get(parentPath) ?? [];
        siblings.push(node);
        childrenByParent.set(parentPath, siblings);
    }

    for (const folder of byPath.values()) {
        if (folder instanceof TFolder) {
            const slash = folder.path.lastIndexOf('/');
            const parentPath = slash >= 0 ? folder.path.slice(0, slash) : '';
            folder.children = childrenByParent.get(folder.path) ?? [];
            void parentPath;
        }
    }

    return {
        vault: {
            getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
            getAllLoadedFiles: () => [...byPath.values()],
        },
    } as unknown as App;
}

describe('resolveFileRef', () => {
    it('resolves extensionless folder paths to non-md files', () => {
        const app = makeApp([
            { path: 'Inbox', kind: 'folder' },
            { path: 'Inbox/Generic Base.base', kind: 'file' },
        ]);

        const resolved = resolveFileRef(app, 'Inbox/Generic Base');
        expect(resolved).toEqual({
            path: 'Inbox/Generic Base.base',
            isFolder: false,
            isShortLink: false,
        });
    });

    it('still resolves paths with omitted .md extension', () => {
        const app = makeApp([
            { path: 'Notes', kind: 'folder' },
            { path: 'Notes/My Note.md', kind: 'file' },
        ]);

        const resolved = resolveFileRef(app, 'Notes/My Note');
        expect(resolved?.path).toBe('Notes/My Note.md');
    });
});
