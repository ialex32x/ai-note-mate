import { describe, it, expect } from 'vitest';
import { prettifyIfJson } from '../src/utils/json-format';

describe('prettifyIfJson', () => {
    it('should pretty-print a valid JSON object', () => {
        const input = '{"a":1,"b":"hello"}';
        const result = prettifyIfJson(input);
        expect(result).toBe('{\n  "a": 1,\n  "b": "hello"\n}');
    });

    it('should pretty-print a valid JSON array', () => {
        const input = '[1,2,3]';
        const result = prettifyIfJson(input);
        expect(result).toBe('[\n  1,\n  2,\n  3\n]');
    });

    it('should pretty-print a nested object', () => {
        const input = '{"outer":{"inner":42}}';
        const result = prettifyIfJson(input);
        expect(result).toBe('{\n  "outer": {\n    "inner": 42\n  }\n}');
    });

    it('should return the original text for non-JSON string', () => {
        const input = 'just a regular string';
        expect(prettifyIfJson(input)).toBe(input);
    });

    it('should return the original text for primitive JSON values', () => {
        // Primitives (strings, numbers, booleans, null) should be left as-is
        expect(prettifyIfJson('"hello"')).toBe('"hello"');
        expect(prettifyIfJson('42')).toBe('42');
        expect(prettifyIfJson('true')).toBe('true');
        expect(prettifyIfJson('null')).toBe('null');
    });

    it('should return the original text when JSON does not start with { or [', () => {
        const input = 'Error: {"code":1}';
        expect(prettifyIfJson(input)).toBe(input);
    });

    it('should return the original text for invalid JSON', () => {
        const input = '{invalid: true}';
        expect(prettifyIfJson(input)).toBe(input);
    });

    it('should handle empty string', () => {
        expect(prettifyIfJson('')).toBe('');
    });

    it('should handle whitespace-only string', () => {
        expect(prettifyIfJson('   ')).toBe('   ');
    });

    it('should handle JSON with leading whitespace', () => {
        const input = '  {"a":1}';
        const result = prettifyIfJson(input);
        expect(result).toBe('{\n  "a": 1\n}');
    });

    it('should handle single-line object', () => {
        const input = '{"name":"test","value":123}';
        const result = prettifyIfJson(input);
        expect(result).toBe('{\n  "name": "test",\n  "value": 123\n}');
    });

    it('should not modify already-pretty JSON', () => {
        const input = '{\n  "a": 1\n}';
        const result = prettifyIfJson(input);
        expect(result).toBe(input);
    });
});
