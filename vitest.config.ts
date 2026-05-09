import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    test: {
        globals: true,
        include: ['test/**/*.test.ts'],
    },
    resolve: {
        alias: {
            // Mirror tsconfig baseUrl so bare imports from "services/..." resolve correctly
            'services': resolve(__dirname, 'src/services'),
            'utils': resolve(__dirname, 'src/utils'),
            // Mock obsidian module (not available outside the app)
            'obsidian': resolve(__dirname, 'test/__mocks__/obsidian.ts'),
        },
    },
});
