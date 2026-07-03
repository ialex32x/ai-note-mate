import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: ['test/_smoke.test.ts'],
        pool: 'vmThreads',
    },
    resolve: {
        alias: {
            'services': resolve(__dirname, 'src/services'),
            'utils': resolve(__dirname, 'src/utils'),
            'settings': resolve(__dirname, 'src/settings'),
            'main': resolve(__dirname, 'src/main'),
            'views': resolve(__dirname, 'src/views'),
            'obsidian': resolve(__dirname, 'test/__mocks__/obsidian.ts'),
        },
    },
});
