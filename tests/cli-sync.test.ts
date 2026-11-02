// @usesequential/node: `sequential changes sync` (src/cli.ts): a CI run's changes in ONE
// record_changes request, at most ITEMS_MAX items (more is refused, never split), one line per item, exit 3 when some
// were refused. Imports only the package's own source, so it runs in the public repository too.
import { ITEMS_MAX, REASON_HINTS, TITLE_MAX, main, parseArgs, syncBody } from '../src/cli';
import { DEFAULT_HOST } from '../src/client';

const TOKEN = 'sq_pat_' + 'Zx9'.repeat(12);
const ENV = { SEQUENTIAL_TOKEN: TOKEN };
const item = (i: number, over: Record<string, unknown> = {}) => ({ kind: 'product', title: `Shipped part ${i}`, external_id: `sha${i}`, ...over });
const ITEMS = JSON.stringify([item(0), item(1)]);
const OK = { status: 200, body: { items: [{ index: 0, outcome: 'create', change_id: 'c-0', version: 1 }, { index: 1, outcome: 'update', change_id: 'c-1', version: 2 }], plan_hash: 'h', batch_id: 'b' } };

function run(argv: string[], files: Record<string, string> = { 'items.json': ITEMS, '-': ITEMS }, answer: { status: number; body?: unknown } | 'network' = OK) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    const reads: string[] = [];
    const fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        if (answer === 'network') throw new TypeError('fetch failed');
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    }) as unknown as typeof globalThis.fetch;
    const readText = async (path: string) => {
        reads.push(path);
        if (!(path in files)) throw new Error('ENOENT');
        return files[path];
    };
    return main(argv, ENV, { out: (l) => out.push(l), err: (l) => err.push(l), fetch, readText }).then((code) => ({ code, out, err, calls, reads, printed: [...out, ...err].join('\n') }));
}
const sent = (r: { calls: { init: RequestInit }[] }) => JSON.parse(String(r.calls[0].init.body));
const SYNC = ['changes', 'sync', '--items', 'items.json'];

describe('sequential changes sync: one request per run', () => {
    it('POSTs record_changes ONCE with the items, each given the default source ci', async () => {
        const r = await run(SYNC);
        expect(r.code).toBe(0);
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0].url).toBe(`${DEFAULT_HOST}/api/agent/record_changes`);
        expect(r.calls[0].init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
        expect(sent(r)).toEqual({ items: [{ ...item(0), source: 'ci' }, { ...item(1), source: 'ci' }] });
    });
    it('reads the items from stdin with -', async () => {
        const r = await run(['changes', 'sync', '--items', '-']);
        expect(r.reads).toEqual(['-']);
        expect(sent(r).items).toHaveLength(2);
    });
    it('--source fills the items that name none; an item\'s own source stays; --covered-* make the sync block; --atomic', async () => {
        const r = await run([...SYNC, '--source', 'git', '--source-detail', 'acme/shop', '--covered-from', '2026-10-27T00:00:00Z', '--covered-through', '2026-10-28T00:00:00Z', '--atomic'],
            { 'items.json': JSON.stringify([item(0), item(1, { source: 'github' })]) });
        expect(sent(r)).toEqual({
            items: [{ ...item(0), source: 'git' }, { ...item(1), source: 'github' }],
            atomic: true,
            sync: { source: 'git', source_detail: 'acme/shop', covered_from: '2026-10-27T00:00:00Z', covered_through: '2026-10-28T00:00:00Z' },
        });
    });
    it(`${ITEMS_MAX} items go in one request; ${ITEMS_MAX + 1} are refused before anything is sent (never split)`, async () => {
        const full = await run(SYNC, { 'items.json': JSON.stringify(Array.from({ length: ITEMS_MAX }, (_, i) => item(i))) },
            { status: 200, body: { items: Array.from({ length: ITEMS_MAX }, (_, i) => ({ index: i, outcome: 'create', change_id: `c-${i}` })) } });
        expect([full.code, full.calls.length, sent(full).items.length]).toEqual([0, 1, ITEMS_MAX]);
        const over = await run(SYNC, { 'items.json': JSON.stringify(Array.from({ length: ITEMS_MAX + 1 }, (_, i) => item(i))) });
        expect([over.code, over.calls.length]).toEqual([2, 0]);
        expect(over.err.join('\n')).toMatch(/at most 100 per run \(one run is one request\): split the range/);
        expect(ITEMS_MAX).toBe(100);
    });
});

describe('sequential changes sync: what it prints and its exit code', () => {
    it('one line per item and a summary; exit 0 when every item was written', async () => {
        const r = await run(SYNC);
        expect(r.out).toEqual(['#0 create c-0', '#1 update c-1', '2 written, 0 refused']);
        expect(r.code).toBe(0);
    });
    it('a refused item: its step, field and reason with the CLI\'s own hint, never the server\'s text; exit 3', async () => {
        const r = await run(SYNC, undefined, { status: 200, body: { items: [
            { index: 0, outcome: 'create', change_id: 'c-0' },
            { index: 1, outcome: 'refused', step: 'screen', field: '/items/1/title', reason: 'reads_as_agent_instruction', hint: 'SERVER HINT Shipped part 1', error: 'text_refused' },
            { index: 2, outcome: 'not_checked', step: 'not_checked', field: '/items/2' },
        ] } });
        expect(r.out).toEqual([
            '#0 create c-0',
            `#1 refused screen (/items/1/title) reads_as_agent_instruction: ${REASON_HINTS.reads_as_agent_instruction}`,
            '#2 not_checked not_checked (/items/2)',
            '1 written, 2 refused',
        ]);
        expect(r.printed).not.toContain('SERVER HINT');
        expect(r.printed).not.toContain('Shipped part');
        expect(r.code).toBe(3);
    });
    it('a refused run (write_blocked, too_many_items …) is exit 1 with its code; not reached is 1; the token never prints', async () => {
        const blocked = await run(SYNC, undefined, { status: 429, body: { error: 'write_blocked', message: 'x' } });
        expect([blocked.code, blocked.err.join('\n')]).toEqual([1, 'sequential: Sequential answered 429 write_blocked']);
        const down = await run(SYNC, undefined, 'network');
        expect(down.code).toBe(1);
        for (const r of [blocked, down]) expect(r.printed).not.toContain(TOKEN);
    });
    it('--dry-run prints the one request and sends nothing', async () => {
        const r = await run([...SYNC, '--dry-run']);
        expect([r.code, r.calls.length]).toEqual([0, 0]);
        expect(r.out[0]).toBe(`Would send to ${DEFAULT_HOST}/api/agent/record_changes:`);
    });
});

describe('sequential changes sync: usage mistakes are said before anything is sent', () => {
    it.each([
        ['no --items', ['changes', 'sync'], {}, /needs --items/],
        ['a file it cannot read', ['changes', 'sync', '--items', 'nope.json'], {}, /could not read nope\.json/],
        ['not JSON', SYNC, { 'items.json': '{' }, /not JSON/],
        ['not an array', SYNC, { 'items.json': '{"kind":"product"}' }, /JSON array/],
        ['an empty array', SYNC, { 'items.json': '[]' }, /no changes/],
        ['an item that is not an object', SYNC, { 'items.json': '[1]' }, /item 0 is not an object/],
        ['an unknown kind', SYNC, { 'items.json': JSON.stringify([item(0, { kind: 'commit' })]) }, /item 0: kind is one of/],
        ['no title', SYNC, { 'items.json': JSON.stringify([{ kind: 'product' }]) }, /item 0: title/],
        ['a two-line title', SYNC, { 'items.json': JSON.stringify([item(0, { title: 'a\nb' })]) }, /item 0: title is one line/],
        ['a title over the limit', SYNC, { 'items.json': JSON.stringify([item(0, { title: 'x'.repeat(TITLE_MAX + 1) })]) }, /item 0: title/],
        ['--covered-from alone', [...SYNC, '--covered-from', '2026-10-27T00:00:00Z'], { 'items.json': ITEMS }, /--covered-from needs --covered-through/],
        ['a bad --source', [...SYNC, '--source', 'Git Hub'], { 'items.json': ITEMS }, /--source is a source name/],
        ['an option of another command', [...SYNC, '--kind', 'product'], { 'items.json': ITEMS }, /changes sync takes no --kind/],
    ] as const)('%s → exit 2, no request', async (_n, argv, files, msg) => {
        const r = await run([...argv], files as Record<string, string>);
        expect(r.code).toBe(2);
        expect(r.calls).toHaveLength(0);
        expect(r.err.join('\n')).toMatch(msg);
    });
    it('syncBody is pure: the same items give the same body', () => {
        const p = parseArgs([...SYNC]);
        expect(syncBody(p, ITEMS)).toEqual(syncBody(p, ITEMS));
    });
});
