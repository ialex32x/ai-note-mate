import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    test: {
        globals: true,
        include: ['test/**/*.test.ts'],
    },
    resolve: {
        alias: {
            // Mirror tsconfig baseUrl so bare imports resolve correctly
            'services': resolve(__dirname, 'src/services'),
            'utils': resolve(__dirname, 'src/utils'),
            'settings': resolve(__dirname, 'src/settings'),
            'main': resolve(__dirname, 'src/main'),
            'views': resolve(__dirname, 'src/views'),
            // Mock obsidian module (not available outside the app)
            'obsidian': resolve(__dirname, 'test/__mocks__/obsidian.ts'),
        },
    },
});
