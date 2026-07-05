import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	{
		languageOptions: {
			globals: {
				...globals.browser,
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
		rules: {
			// SettingDefinition type only available in obsidian >= 1.13
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
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
		// JSON files are not source code. The typescript-eslint parser cannot
		// parse JSON syntax and would produce spurious "Unexpected token :"
		// parse errors when linting the whole repo (npm run lint = `eslint .`).
		"**/*.json",
		// stylelint config is not part of the plugin bundle
		".stylelintrc.js",
		// Utility scripts are plain Node.js, not part of the plugin bundle
		"scripts",
		// Ignore all dot-directories at root (e.g. .github, etc.)
		".*",
	]),
);
