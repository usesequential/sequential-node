// The built package loads both ways and exports what the README names. Runs before every publish.
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const names = ['SequentialServer', 'SequentialError', 'contextFromRequest', 'parseContext', 'encodeContext', 'CONTEXT_HEADER', 'CONTEXT_COOKIE', 'SDK_VERSION', 'DEFAULT_HOST'];
const pkg = path.resolve(__dirname, '..');
// the `sequential` command starts and prints its help (a broken bin is never published)
const { execFileSync } = require('node:child_process');
const help = execFileSync(process.execPath, [path.join(pkg, 'dist/cjs/bin.js'), '--help'], { encoding: 'utf8', env: {} });
assert.match(help, /^Usage: sequential changes record/);
const cjs = require(path.join(pkg, 'dist/cjs/index.js'));
for (const n of names) assert.ok(cjs[n] !== undefined, `require: ${n}`);
assert.strictEqual(cjs.SDK_VERSION, require(path.join(pkg, 'package.json')).version);
import(pathToFileURL(path.join(pkg, 'dist/esm/index.js')).href).then((esm) => {
    for (const n of names) assert.ok(esm[n] !== undefined, `import: ${n}`);
    assert.throws(() => new esm.SequentialServer({ secretKey: 'sq_write_key' }), /server secret key/);
    console.log('smoke ok: require + import,', names.length, 'exports, version', esm.SDK_VERSION);
});
