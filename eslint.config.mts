import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// Obsidian-injected DOM helpers (augmented on HTMLElement/Document/global)
				createEl: "readonly",
				createDiv: "readonly",
				createSpan: "readonly",
				createFragment: "readonly",
				// TS lib built-ins not in older "browser" globals set
				AsyncIterable: "readonly",
				AsyncIterableIterator: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Node-side build/dev scripts are not part of the plugin bundle and
		// run under Node, not the browser sandbox. Give them Node globals so
		// `process`, `__dirname` etc. are recognised.
		files: ["scripts/**/*.{js,mjs,cjs,ts,mts,cts}"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		// Tests and vitest config aren't part of the plugin bundle and aren't
		// included in tsconfig.json; skip them so typed linting rules don't
		// fail with "file was not found by the project service".
		"test",
		"vitest.config.ts",
	]),
);
