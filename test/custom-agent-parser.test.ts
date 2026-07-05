import { describe, it, expect } from 'vitest';
import {
    normalizeAgentTools,
    matchesWildcard,
    buildMcpToolNames,
    buildMcpToolInfos,
} from '../src/services/custom-agents/custom-agent-parser';
import type { MCPServerConfig } from '../src/services/mcp/mcp-types';

describe('normalizeAgentTools', () => {
    it('should normalize a string array', () => {
        expect(normalizeAgentTools(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('should trim whitespace from each entry', () => {
        expect(normalizeAgentTools([' a ', 'b', '  c  '])).toEqual(['a', 'b', 'c']);
    });

    it('should split a comma-separated string', () => {
        expect(normalizeAgentTools('a, b, c')).toEqual(['a', 'b', 'c']);
    });

    it('should split a newline-separated string', () => {
        expect(normalizeAgentTools('a\nb\nc')).toEqual(['a', 'b', 'c']);
    });

    it('should deduplicate while preserving first-seen order', () => {
        expect(normalizeAgentTools(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });

    it('should drop blank entries', () => {
        expect(normalizeAgentTools(['a', '', 'b', '  ', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('should coerce non-string array members', () => {
        expect(normalizeAgentTools(['a', 42, true, null])).toEqual(['a', '42', 'true', 'null']);
    });

    it('should return empty array for non-array, non-string input', () => {
        expect(normalizeAgentTools(42)).toEqual([]);
        expect(normalizeAgentTools(null)).toEqual([]);
        expect(normalizeAgentTools(undefined)).toEqual([]);
        expect(normalizeAgentTools({})).toEqual([]);
    });

    it('should return empty array for a blank string', () => {
        expect(normalizeAgentTools('')).toEqual([]);
        expect(normalizeAgentTools('  ')).toEqual([]);
    });
});

describe('matchesWildcard', () => {
    it('should match exact strings', () => {
        expect(matchesWildcard('hello', 'hello')).toBe(true);
    });

    it('should not match different strings', () => {
        expect(matchesWildcard('hello', 'world')).toBe(false);
    });

    it('should match with * wildcard prefix', () => {
        expect(matchesWildcard('*search', 'web_search')).toBe(true);
    });

    it('should match with * wildcard suffix', () => {
        expect(matchesWildcard('mcp_*', 'mcp_web_fetch')).toBe(true);
    });

    it('should match with * wildcard in middle', () => {
        expect(matchesWildcard('mcp_*_fetch', 'mcp_web_fetch')).toBe(true);
    });

    it('should match * alone (everything)', () => {
        expect(matchesWildcard('*', 'anything')).toBe(true);
    });

    it('should be case-insensitive', () => {
        expect(matchesWildcard('HELLO', 'hello')).toBe(true);
        expect(matchesWildcard('hello', 'HELLO')).toBe(true);
        expect(matchesWildcard('MCP_*', 'mcp_Web_Fetch')).toBe(true);
    });

    it('should treat regex-special characters as literals (only * is special)', () => {
        // [ch] is treated as literal "[ch]", not as a character class
        expect(matchesWildcard('file.[ch]', 'file.[ch]')).toBe(true);
        expect(matchesWildcard('file.[ch]', 'file.c')).toBe(false);
        expect(matchesWildcard('file.[ch]', 'file.x')).toBe(false);
    });

    it('should return false for malformed pattern (invalid regex)', () => {
        // This shouldn't throw, should return false
        expect(matchesWildcard('[unclosed', 'test')).toBe(false);
    });
});

describe('buildMcpToolNames', () => {
    it('should build prefixed tool names from server configs', () => {
        const servers: MCPServerConfig[] = [
            { slug: 'web', tools: [{ name: 'fetch', description: '' }, { name: 'search', description: '' }] },
            { slug: 'fs', tools: [{ name: 'read', description: '' }, { name: 'write', description: '' }] },
        ] as MCPServerConfig[];
        expect(buildMcpToolNames(servers)).toEqual([
            'mcp_web_fetch',
            'mcp_web_search',
            'mcp_fs_read',
            'mcp_fs_write',
        ]);
    });

    it('should skip servers without slug', () => {
        const servers: MCPServerConfig[] = [
            { slug: '', tools: [{ name: 'fetch', description: '' }] },
            { slug: 'valid', tools: [{ name: 'read', description: '' }] },
        ] as MCPServerConfig[];
        expect(buildMcpToolNames(servers)).toEqual(['mcp_valid_read']);
    });

    it('should skip servers without tools', () => {
        const servers: MCPServerConfig[] = [
            { slug: 'web', tools: [] },
            { slug: 'fs', tools: [{ name: 'read', description: '' }] },
        ] as MCPServerConfig[];
        expect(buildMcpToolNames(servers)).toEqual(['mcp_fs_read']);
    });

    it('should return empty array for empty input', () => {
        expect(buildMcpToolNames([])).toEqual([]);
    });
});

describe('buildMcpToolInfos', () => {
    const servers: MCPServerConfig[] = [
        {
            slug: 'web',
            tools: [
                { name: 'fetch', description: 'Fetch a URL' },
                { name: 'search', description: 'Search the web' },
            ],
        },
        {
            slug: 'fs',
            tools: [
                { name: 'read', description: 'Read a file' },
                { name: 'write', description: 'Write to a file' },
            ],
        },
    ] as MCPServerConfig[];

    it('should filter by wildcard patterns', () => {
        const result = buildMcpToolInfos(servers, ['mcp_web_*']);
        expect(result).toHaveLength(2);
        expect(result[0]!.name).toBe('mcp_web_fetch');
        expect(result[0]!.description).toBe('Fetch a URL');
        expect(result[1]!.name).toBe('mcp_web_search');
        expect(result[1]!.description).toBe('Search the web');
    });

    it('should return info for all matched tools', () => {
        const result = buildMcpToolInfos(servers, ['mcp_*_read']);
        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe('mcp_fs_read');
    });

    it('should return empty array when no patterns match', () => {
        const result = buildMcpToolInfos(servers, ['mcp_xyz_*']);
        expect(result).toEqual([]);
    });

    it('should return empty array for empty servers', () => {
        const result = buildMcpToolInfos([], ['*']);
        expect(result).toEqual([]);
    });
});
