/**
 * Scans src/ for code files containing `eslint-disable-next-line` and prints
 * the file path and line number for each occurrence.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, relative, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const srcDir = resolve(rootDir, 'src');

const CODE_EXTENSIONS = new Set(['.ts', '.less']);

/**
 * Recursively collect all code files in a directory.
 */
function collectFiles(dir, files = []) {
	const entries = readdirSync(dir);
	for (const entry of entries) {
		const fullPath = resolve(dir, entry);
		if (statSync(fullPath).isDirectory()) {
			collectFiles(fullPath, files);
		} else if (CODE_EXTENSIONS.has(extname(entry))) {
			files.push(fullPath);
		}
	}
	return files;
}

const files = collectFiles(srcDir);
let totalCount = 0;

for (const file of files) {
	const lines = readFileSync(file, 'utf8').split('\n');
	lines.forEach((line, index) => {
		if (line.includes('eslint-disable-next-line')) {
			totalCount++;
			const relPath = relative(rootDir, file).replace(/\\/g, '/');
			console.log(`${relPath}:${index + 1}`);
		}
	});
}

if (totalCount === 0) {
	console.log('✅ No eslint-disable-next-line usages found in src/');
} else {
	console.log(`\nTotal: ${totalCount} eslint-disable-next-line usage(s)`);
}
