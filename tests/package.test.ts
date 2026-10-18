// @usesequential/node: the package manifest stays publishable and in step with the source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SDK_VERSION } from '../src';

const dir = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

describe('@usesequential/node package', () => {
    it('SDK_VERSION (the user agent) equals package.json version', () => {
        expect(SDK_VERSION).toBe(pkg.version);
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('is public, scoped, with no runtime dependencies, for Node 18+', () => {
        expect(pkg.name).toBe('@usesequential/node');
        expect(pkg.private).toBeUndefined();
        expect(pkg.dependencies ?? {}).toEqual({});
        expect(pkg.engines.node).toBe('>=18');
        expect(pkg.license).toBe('MIT');
    });

    it('names its public source repository and issue tracker', () => {
        expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/usesequential/sequential-node.git' });
        expect(pkg.bugs).toEqual({ url: 'https://github.com/usesequential/sequential-node/issues' });
    });

    it('exports both module formats, each with its own types, and publishes only dist + docs', () => {
        expect(pkg.exports['.']).toEqual({
            import: { types: './dist/esm/index.d.ts', default: './dist/esm/index.js' },
            require: { types: './dist/cjs/index.d.ts', default: './dist/cjs/index.js' },
        });
        expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    });

    it('the source imports only node: builtins and its own files', () => {
        for (const f of ['index.ts', 'client.ts', 'context.ts', 'version.ts']) {
            const src = readFileSync(join(dir, 'src', f), 'utf8');
            for (const m of src.matchAll(/from '([^']+)'/g)) expect(m[1]).toMatch(/^(node:|\.\/)/);
        }
    });

    // The comments ship in dist and in the public repository: they name no file of the private monorepo.
    it('the source comments name no private path', () => {
        for (const f of ['index.ts', 'client.ts', 'context.ts', 'version.ts']) {
            const src = readFileSync(join(dir, 'src', f), 'utf8');
            expect(src).not.toMatch(/docs\/superpowers|src\/(adapters|handlers|lists|routes|auth|ingest)\//);
        }
    });

    it('the README names the real path to a server key: Settings → Projects → Sources & keys → Server keys', () => {
        const readme = readFileSync(join(dir, 'README.md'), 'utf8').replace(/\s+/g, ' ');
        expect(readme.replace(/\s+/g, ' ')).toContain("open your project's **Sources & keys** tab, then **Server keys → Create a server key**");
        expect(readme).not.toContain('Settings → Server keys');
    });
});
