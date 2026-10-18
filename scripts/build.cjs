// Builds dist/cjs (require) and dist/esm (import), each with its own .d.ts, with the repo's TypeScript.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = path.resolve(__dirname, '..');
const tsc = require.resolve('typescript/bin/tsc', { paths: [pkg, path.resolve(pkg, '../..')] });
const run = (args) => execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', ...args], { cwd: pkg, stdio: 'inherit' });

fs.rmSync(path.join(pkg, 'dist'), { recursive: true, force: true });
run(['--declaration', '--outDir', 'dist/cjs']);
run(['--declaration', '--module', 'es2020', '--outDir', 'dist/esm']);
// dist/esm is ES modules inside a CommonJS package: its own package.json says so.
fs.writeFileSync(path.join(pkg, 'dist/esm/package.json'), '{\n    "type": "module"\n}\n');
// ES module imports need the file extension.
for (const f of fs.readdirSync(path.join(pkg, 'dist/esm'))) {
    if (!f.endsWith('.js') && !f.endsWith('.d.ts')) continue;
    const p = path.join(pkg, 'dist/esm', f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '(\.\/[a-z-]+)'/g, "from '$1.js'"));
}
