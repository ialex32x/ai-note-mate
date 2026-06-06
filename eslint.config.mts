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
		// JSON files are not source code. The typescript-eslint parser cannot
		// parse JSON syntax and would produce spurious "Unexpected token :"
		// parse errors when linting the whole repo (npm run lint = `eslint .`).
		"**/*.json",
		// stylelint config is not part of the plugin bundle
		".stylelintrc.js",
	]),
);
