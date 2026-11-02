// @usesequential/node: the `sequential changes record` command (src/cli.ts). Imports only the package's own
// source, so it runs in the public repository too. The token never shows in anything the command prints.
import { FINDINGS_MAX, HELP, LINKS_MAX, TITLE_MAX, TIMEOUT_MS, apiHost, changeBody, main, parseArgs, releaseBody, tokenFrom } from '../src/cli';
import { DEFAULT_HOST } from '../src/client';
import { SDK_VERSION } from '../src/version';

const TOKEN = 'sq_pat_' + 'Zx9'.repeat(12);
const ENV = { SEQUENTIAL_TOKEN: TOKEN };

function run(argv: string[], env: Record<string, string | undefined> = ENV, answer: { status: number; body?: unknown } | 'network' | 'not-json' = { status: 201, body: { change_id: '2f1c9a7e-0b1d-4c7a-9e55-0d4c1f6b8a01', outcome: 'create' } }) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        if (answer === 'network') throw new TypeError('fetch failed');
        if (answer === 'not-json') return new Response('<html>bad gateway</html>', { status: 502 });
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    }) as unknown as typeof globalThis.fetch;
    return main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l), fetch }).then((code) => ({ code, out, err, calls, printed: [...out, ...err].join('\n') }));
}
const sent = (r: { calls: { init: RequestInit }[] }) => JSON.parse(String(r.calls[0].init.body));
const REC = ['changes', 'record', '--kind', 'release', '--title', 'v2.14'];

describe('sequential changes record: what is sent', () => {
    it('POSTs record_change to the default host with the token as a bearer, its own user agent and a timeout', async () => {
        const r = await run(REC);
        expect(r.code).toBe(0);
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0].url).toBe(`${DEFAULT_HOST}/api/agent/record_change`);
        expect(r.calls[0].init.method).toBe('POST');
        expect(r.calls[0].init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': `sequential-cli/${SDK_VERSION}` });
        expect(r.calls[0].init.signal).toBeInstanceOf(AbortSignal);
        expect(TIMEOUT_MS).toBe(15_000);
        expect(sent(r)).toEqual({ kind: 'release', title: 'v2.14', source: 'ci' });
    });

    it('every option lands in the body; links keep their order and labels', async () => {
        const r = await run([
            'changes', 'record', '--kind=release', '--title', '  v2.14  ', '--summary', ' New checkout ', '--importance', 'major', '--occurrence', 'happened',
            '--start', '2026-10-27T10:00:00Z', '--end', '2026-10-27T11:00:00Z', '--version', 'web@2.14', '--environment', 'staging', '--external-id', 'gh-123',
            '--link', 'https://example.test/notes', '--pr', 'https://github.com/o/r/pull/1', '--commit', 'https://github.com/o/r/commit/abc', '--pr', 'https://github.com/o/r/pull/2',
        ]);
        expect(r.code).toBe(0);
        expect(sent(r)).toEqual({
            kind: 'release', title: 'v2.14', source: 'ci', summary: 'New checkout', importance: 'major', occurrence: 'happened',
            start: '2026-10-27T10:00:00Z', end: '2026-10-27T11:00:00Z', release: { environment: 'staging', version: 'web@2.14' }, external_id: 'gh-123',
            links: [
                { url: 'https://github.com/o/r/pull/1', label: 'pr' }, { url: 'https://github.com/o/r/pull/2', label: 'pr' },
                { url: 'https://github.com/o/r/commit/abc', label: 'commit' }, { url: 'https://example.test/notes', label: 'other' },
            ],
        });
    });

    it('a release version defaults to the production environment; a blank summary is left out', async () => {
        expect(changeBody(parseArgs([...REC, '--version', 'web@1', '--summary', '  ']))).toEqual({ kind: 'release', title: 'v2.14', source: 'ci', release: { environment: 'production', version: 'web@1' } });
    });

    it('--host sends there (an origin, trailing slashes dropped)', async () => {
        const r = await run([...REC, '--host', 'https://api.example.test//']);
        expect(r.calls[0].url).toBe('https://api.example.test/api/agent/record_change');
    });

    it('prints the outcome and the change id', async () => {
        expect((await run(REC)).out).toEqual(['create 2f1c9a7e-0b1d-4c7a-9e55-0d4c1f6b8a01']);
        expect((await run(REC, ENV, { status: 200, body: { change_id: null, outcome: 'exists' } })).out).toEqual(['exists']);
        // an answer it cannot vouch for is not repeated
        expect((await run(REC, ENV, { status: 200, body: { change_id: 'a b<script>', outcome: 'Created!' } })).out).toEqual(['recorded']);
        expect((await run(REC, ENV, { status: 200, body: { change_id: 'x'.repeat(65), outcome: 'x'.repeat(41) } })).out).toEqual(['recorded']);
    });
});

describe('the dry run', () => {
    it('prints where and what it would send, sends nothing, and needs no token', async () => {
        const r = await run([...REC, '--dry-run'], {});
        expect(r.code).toBe(0);
        expect(r.calls).toHaveLength(0);
        expect(r.out).toEqual([`Would send to ${DEFAULT_HOST}/api/agent/record_change:`, JSON.stringify({ kind: 'release', title: 'v2.14', source: 'ci' }, null, 2)]);
    });
    it('never prints the token, even when one is set', async () => {
        const r = await run([...REC, '--dry-run']);
        expect(r.printed).not.toContain(TOKEN);
        expect(r.printed).not.toContain('Zx9');
    });
    it('a usage mistake still fails a dry run', async () => {
        expect((await run(['changes', 'record', '--kind', 'release', '--dry-run'], {})).code).toBe(2);
    });
});

describe('the token', () => {
    const SERVER_KEY = 'sqs_' + 'Qw7'.repeat(12);
    it('comes from SEQUENTIAL_TOKEN only, trimmed', () => {
        expect(tokenFrom({ SEQUENTIAL_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN);
    });
    it.each([
        [{}, 'SEQUENTIAL_TOKEN is not set'],
        [{ SEQUENTIAL_TOKEN: '  ' }, 'SEQUENTIAL_TOKEN is not set'],
        [{ SEQUENTIAL_TOKEN: SERVER_KEY }, 'holds a server key'],
        [{ SEQUENTIAL_TOKEN: 'sq_write_' + 'Qw7'.repeat(12) }, 'is not a personal access token'],
    ])('refuses %#, says why, sends nothing, and never repeats the value', async (env, says) => {
        const r = await run(REC, env as Record<string, string>);
        expect(r.code).toBe(2);
        expect(r.calls).toHaveLength(0);
        expect(r.err.join('\n')).toContain(says);
        expect(r.printed).not.toContain('Qw7');
    });
    it('is never printed on any failure', async () => {
        for (const answer of [{ status: 401, body: { error: 'invalid_token', message: `bad ${TOKEN}` } }, { status: 500 }, 'network', 'not-json'] as const) {
            const r = await run(REC, ENV, answer);
            expect(r.code).toBe(1);
            expect(r.printed).not.toContain(TOKEN);
        }
    });
});

describe('a refusal or no answer', () => {
    // the server's refusal shape: { error, message, errors: [{ field, message }] } (a field is a pointer or a bare name)
    const refusal = (field: unknown, error: unknown = 'bad_request') => ({ error, message: 'The request is not valid.', errors: [{ field, message: 'echo: <the title>' }] });
    it('says the status and Sequential\'s error code (with the first field), never the message or body', async () => {
        const r = await run(REC, ENV, { status: 400, body: refusal('/title') });
        expect(r.code).toBe(1);
        expect(r.err).toEqual(['sequential: Sequential answered 400 bad_request (/title)']);
        expect(r.printed).not.toContain('echo');
    });
    it('a code or field it cannot vouch for is left out', async () => {
        expect((await run(REC, ENV, { status: 400, body: refusal('id') })).err).toEqual(['sequential: Sequential answered 400 bad_request (id)']);
        expect((await run(REC, ENV, { status: 400, body: { ...refusal('/start'), errors: [{ field: '/start' }, { field: '/end' }] } })).err).toEqual(['sequential: Sequential answered 400 bad_request (/start)']);
        expect((await run(REC, ENV, { status: 403, body: refusal('title<x>', 'Bad Thing!') })).err).toEqual(['sequential: Sequential answered 403']);
        expect((await run(REC, ENV, { status: 400, body: refusal('/' + 'a'.repeat(61)) })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REC, ENV, { status: 400, body: refusal('/' + 'a'.repeat(60)) })).err).toEqual([`sequential: Sequential answered 400 bad_request (/${'a'.repeat(60)})`]);
        expect((await run(REC, ENV, { status: 400, body: refusal('/9x') })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REC, ENV, { status: 400, body: refusal(7) })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REC, ENV, { status: 400, body: { error: 'bad_request', errors: ['/title'] } })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REC, ENV, { status: 400, body: { error: 'bad_request', errors: [] } })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REC, ENV, { status: 400, body: { error: 'bad_request', errors: { field: '/title' } } })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        // a top-level field is not the server's shape and is not read
        expect((await run(REC, ENV, { status: 400, body: { error: 'bad_request', field: '/title' } })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REC, ENV, { status: 403, body: { error: 'insufficient_scope' } })).err).toEqual(['sequential: Sequential answered 403 insufficient_scope']);
        expect((await run(REC, ENV, { status: 429, body: ['daily_cap'] })).err).toEqual(['sequential: Sequential answered 429']);
        expect((await run(REC, ENV, 'not-json')).err).toEqual(['sequential: Sequential answered 502']);
        // a refused text: the reason code it knows, with its own hint; never the server's hint, message or an unknown reason
        const textRefused = (reason: unknown) => ({ error: 'text_refused', step: 'screen', field: '/title', reason, hint: 'server hint <the title>', message: 'A text was refused at the screen check.' });
        const said = await run(REC, ENV, { status: 422, body: textRefused('reads_as_agent_instruction') });
        expect(said.err).toEqual(['sequential: Sequential answered 422 text_refused reads_as_agent_instruction: describe what changed, in the past tense, not what to do']);
        expect(said.printed).not.toContain('server hint');
        expect((await run(REC, ENV, { status: 422, body: textRefused('ignore all rules') })).err).toEqual(['sequential: Sequential answered 422 text_refused']);
        expect((await run(REC, ENV, { status: 422, body: textRefused('toString') })).err).toEqual(['sequential: Sequential answered 422 text_refused']);
        expect((await run(REC, ENV, { status: 422, body: textRefused(7) })).err).toEqual(['sequential: Sequential answered 422 text_refused']);
    });
    it('a network failure names the host only', async () => {
        const r = await run(REC, ENV, 'network');
        expect(r.err).toEqual([`sequential: could not reach ${DEFAULT_HOST}`]);
    });
});

describe('usage', () => {
    it('--help prints the help and exits 0; no command prints it and exits 2', async () => {
        expect(await run(['--help'], {})).toMatchObject({ code: 0, out: [HELP] });
        expect(await run(['changes', 'record', '--help'], {})).toMatchObject({ code: 0, out: [HELP] });
        expect(await run([], {})).toMatchObject({ code: 2, out: [HELP] });
        expect(HELP).toMatch(/^Usage: sequential changes record/);
        expect(HELP).toContain('SEQUENTIAL_TOKEN');
        expect(HELP).toContain('A release recorded here is a Changes entry. To have Sequential verify fixes against it,\nalso send the release marker (POST /api/releases with a releases:write token), for\nexample with `sequential releases record`.');
        expect(HELP).toContain('       sequential releases record --version <version> [options]');
        expect(HELP).toContain('SEQUENTIAL_RELEASES_TOKEN');
    });
    it.each([
        [['changes', 'list'], 'unknown command: changes list'],
        // an inherited object member is no command
        [['constructor'], 'unknown command: constructor'],
        [['__proto__'], 'unknown command: __proto__'],
        [['toString', '--kind', 'release'], 'unknown command: toString'],
        [['hasOwnProperty'], 'unknown command: hasOwnProperty'],
        // one dash is a word, not an option
        [['changes', 'record', '-k'], 'unknown command: changes record -k'],
        [['changes', 'record', '--title', 'x'], '--kind is required'],
        [['changes', 'record', '--kind', 'release'], '--title is required'],
        [['changes', 'record', '--kind', 'release', '--title', '   '], '--title is required'],
        [['changes', 'record', '--kind', 'deploy', '--title', 'x'], '--kind must be one of release, product, pricing, marketing, incident, company, external, tracking'],
        [[...REC, '--importance', 'huge'], '--importance must be one of major, minor, note'],
        [[...REC, '--occurrence', 'maybe'], '--occurrence must be one of planned, happened, did_not_happen'],
        [['changes', 'record', '--kind', 'product', '--title', 'x', '--version', '1'], '--version goes with --kind release'],
        [[...REC, '--environment', 'staging'], '--environment goes with --version'],
        [[...REC, '--external-id', ''], '--external-id is 1 to 128 characters'],
        [[...REC, '--external-id', 'x'.repeat(129)], '--external-id is 1 to 128 characters'],
        [[...REC, '--pr', 'not a url'], '--pr must be a URL'],
        [[...REC, '--link', 'javascript:alert(1)'], '--link must be an http or https URL'],
        [[...REC, '--colour', 'red'], 'unknown option --colour'],
        [[...REC, '--dry-run=yes'], '--dry-run takes no value'],
        [[...REC, '--summary'], '--summary needs a value'],
        [[...REC, '--summary', '--dry-run'], '--summary needs a value'],
        [[...REC, '--title', 'again'], '--title is given twice'],
        [[...REC, '--host', 'http://api.example.test'], '--host must be https (http only for localhost)'],
        [[...REC, '--host', 'not a url'], '--host must be a URL'],
        [[...REC, '--host', 'https://api.example.test/v1'], '--host must be an origin'],
    ])('%j: %s, exit 2, nothing sent', async (argv, says) => {
        const r = await run(argv as string[]);
        expect(r.code).toBe(2);
        expect(r.calls).toHaveLength(0);
        expect(r.err).toHaveLength(1);
        expect(r.err[0]).toContain(`sequential: ${says}`);
    });
    it('the title limit and the link limit', async () => {
        expect(TITLE_MAX).toBe(140);
        expect(LINKS_MAX).toBe(10);
        expect((await run(['changes', 'record', '--kind', 'release', '--title', 'x'.repeat(140)])).code).toBe(0);
        expect((await run(['changes', 'record', '--kind', 'release', '--title', 'x'.repeat(141)])).err).toEqual(['sequential: --title is at most 140 characters']);
        const links = (n: number) => Array.from({ length: n }, (_, i) => ['--link', `https://e.test/${i}`]).flat();
        expect((await run([...REC, ...links(10)])).code).toBe(0);
        expect((await run([...REC, ...links(11)])).err).toEqual(['sequential: at most 10 links']);
    });
    it('a value may itself start with a dash when given with =', () => {
        expect(changeBody(parseArgs(['changes', 'record', '--kind', 'product', '--title=--weird'])).title).toBe('--weird');
    });
});

describe('the host', () => {
    it('https anywhere, http only to this machine', () => {
        expect(apiHost(undefined)).toBe(DEFAULT_HOST);
        expect(apiHost('https://api.example.test/')).toBe('https://api.example.test');
        expect(apiHost('http://localhost:3000')).toBe('http://localhost:3000');
        expect(apiHost('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
        expect(apiHost('http://[::1]:3000')).toBe('http://[::1]:3000');
        expect(() => apiHost('http://localhost.example.test')).toThrow('https');
        expect(() => apiHost('ftp://api.example.test')).toThrow('https');
        expect(() => apiHost('ftp://localhost')).toThrow('https');
    });
    it('only an origin: no path, query, fragment or credentials', () => {
        for (const h of ['https://a.test/x', 'https://a.test?x=1', 'https://a.test#x', 'https://u:p@a.test']) expect(() => apiHost(h)).toThrow('origin');
    });
});

describe('sequential releases record', () => {
    const RTOKEN = 'sq_pat_' + 'Rl5'.repeat(12);
    const RENV = { SEQUENTIAL_RELEASES_TOKEN: RTOKEN };
    const REL = ['releases', 'record', '--version', 'web@2.14'];
    const created = { status: 201, body: { release: { version: 'web@2.14' } } } as const;

    it('POSTs the marker to /api/releases with its own token, and says what it recorded', async () => {
        const r = await run([...REL, '--environment', 'staging', '--commit-sha', 'ABCDEF1', '--released-at', '2026-10-27T10:00:00+02:00', '--finding', 'F-12', '--finding', 'F-3'], RENV, created);
        expect(r.code).toBe(0);
        expect(r.calls[0].url).toBe(`${DEFAULT_HOST}/api/releases`);
        expect(r.calls[0].init.headers).toEqual({ authorization: `Bearer ${RTOKEN}`, 'content-type': 'application/json', 'user-agent': `sequential-cli/${SDK_VERSION}` });
        expect(sent(r)).toEqual({ version: 'web@2.14', environment: 'staging', commit_sha: 'abcdef1', released_at: '2026-10-27T10:00:00+02:00', finding_ids: ['F-12', 'F-3'] });
        expect(r.out).toEqual(['recorded release web@2.14']);
        expect(r.printed).not.toContain(RTOKEN);
    });

    it('sends only the version when nothing else is given (the project picks its environment)', async () => {
        const r = await run(REL, RENV, created);
        expect(sent(r)).toEqual({ version: 'web@2.14' });
    });

    it('reads SEQUENTIAL_RELEASES_TOKEN only: the changes token is not used for it, nor the other way round', async () => {
        const r = await run(REL, ENV, created);
        expect(r.code).toBe(2);
        expect(r.calls).toHaveLength(0);
        expect(r.err).toEqual(['sequential: SEQUENTIAL_RELEASES_TOKEN is not set: create a personal access token with the releases:write scope']);
        expect((await run(REC, RENV)).err).toEqual(['sequential: SEQUENTIAL_TOKEN is not set: create a personal access token with the changes:write scope']);
        const key = await run(REL, { SEQUENTIAL_RELEASES_TOKEN: 'sqs_' + 'Qw7'.repeat(12) });
        expect(key.err[0]).toContain('SEQUENTIAL_RELEASES_TOKEN holds a server key');
        expect(key.err[0]).toContain('releases:write');
        expect(key.printed).not.toContain('Qw7');
        expect((await run(REL, { SEQUENTIAL_RELEASES_TOKEN: 'sq_x_' + 'Qw7'.repeat(12) })).err).toEqual(['sequential: SEQUENTIAL_RELEASES_TOKEN is not a personal access token (sq_pat_…)']);
    });

    it('a dry run prints the marker and sends nothing', async () => {
        const r = await run([...REL, '--dry-run'], {});
        expect(r.code).toBe(0);
        expect(r.calls).toHaveLength(0);
        expect(r.out).toEqual([`Would send to ${DEFAULT_HOST}/api/releases:`, JSON.stringify({ version: 'web@2.14' }, null, 2)]);
    });

    it('a refusal names the field from the start of its message, never the rest', async () => {
        const r = await run(REL, RENV, { status: 400, body: { error: 'bad_request', message: 'version: 1–64 printable ASCII characters, not a placeholder such as "null"' } });
        expect(r.err).toEqual(['sequential: Sequential answered 400 bad_request (version)']);
        expect((await run(REL, RENV, { status: 400, body: { error: 'bad_request', message: 'Version is wrong' } })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REL, RENV, { status: 400, body: { error: 'bad_request', message: 'x'.repeat(31) + ': y' } })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REL, RENV, { status: 403, body: { error: 'insufficient_scope', message: 'scope: releases:write' } })).err).toEqual(['sequential: Sequential answered 403 insufficient_scope (scope)']);
        // the errors list wins over the message, even one whose first item cannot be read
        expect((await run(REC, ENV, { status: 400, body: { error: 'bad_request', message: 'start: x', errors: ['/title'] } })).err).toEqual(['sequential: Sequential answered 400 bad_request']);
        expect((await run(REC, ENV, { status: 400, body: { error: 'bad_request', message: 'start: x', errors: [{ field: '/title' }] } })).err).toEqual(['sequential: Sequential answered 400 bad_request (/title)']);
    });

    it.each([
        [['releases', 'record'], '--version is required'],
        [['releases', 'record', '--version', ' web@1'], '--version is 1-64 printable characters'],
        [['releases', 'record', '--version', 'x'.repeat(65)], '--version is 1-64 printable characters'],
        [['releases', 'record', '--version', 'NULL'], '--version is 1-64 printable characters'],
        [['releases', 'record', '--version', 'café'], '--version is 1-64 printable characters'],
        [[...REL, '--environment', 'Prod'], '--environment is lowercase letters, digits, . _ - (at most 32)'],
        [[...REL, '--environment', 'p'.repeat(33)], '--environment is lowercase letters'],
        [[...REL, '--environment', '-prod'], '--environment is lowercase letters'],
        [[...REL, '--commit-sha', 'abc12'], '--commit-sha is 7 to 40 hex characters'],
        [[...REL, '--commit-sha', 'abcdef'], '--commit-sha is 7 to 40 hex characters'],
        [[...REL, '--commit-sha', 'g'.repeat(7)], '--commit-sha is 7 to 40 hex characters'],
        [[...REL, '--commit-sha', 'a'.repeat(41)], '--commit-sha is 7 to 40 hex characters'],
        [[...REL, '--released-at', '2026-10-27T10:00:00'], '--released-at is a date-time with Z or an offset'],
        [[...REL, '--released-at', '2026-10-27'], '--released-at is a date-time with Z or an offset'],
        [[...REL, '--finding', 'F-0'], '--finding is a finding number such as F-12'],
        [[...REL, '--finding', 'F-012'], '--finding is a finding number such as F-12'],
        [[...REL, '--finding', 'f-12'], '--finding is a finding number such as F-12'],
        [[...REL, '--title', 'x'], 'releases record takes no --title'],
        [[...REL, '--pr', 'https://e.test/1'], 'releases record takes no --pr'],
        [[...REC, '--commit-sha', 'abcdef1'], 'changes record takes no --commit-sha'],
        [[...REC, '--finding', 'F-1'], 'changes record takes no --finding'],
    ])('%j: %s, exit 2, nothing sent', async (argv, says) => {
        const r = await run(argv as string[], { ...ENV, SEQUENTIAL_RELEASES_TOKEN: 'sq_pat_' + 'Rl5'.repeat(12) });
        expect(r.code).toBe(2);
        expect(r.calls).toHaveLength(0);
        expect(r.err[0]).toContain(`sequential: ${says}`);
    });

    it('the edges that pass: 64 characters, 32-character environment, 7 and 40 hex, Z, a fraction, F-999999999, 50 findings', () => {
        const p = (xs: string[]) => releaseBody(parseArgs(['releases', 'record', ...xs]));
        expect(p(['--version', 'x'.repeat(64)]).version).toBe('x'.repeat(64));
        expect(p(['--version', 'v', '--environment', 'p'.repeat(32)]).environment).toBe('p'.repeat(32));
        expect(p(['--version', 'v', '--environment', '0a._-']).environment).toBe('0a._-');
        expect(p(['--version', 'v', '--commit-sha', 'a'.repeat(7)]).commit_sha).toBe('a'.repeat(7));
        expect(p(['--version', 'v', '--commit-sha', 'F'.repeat(40)]).commit_sha).toBe('f'.repeat(40));
        expect(p(['--version', 'v', '--released-at', '2026-10-27T10:00Z']).released_at).toBe('2026-10-27T10:00Z');
        expect(p(['--version', 'v', '--released-at', '2026-10-27T10:00:00.123-05:00']).released_at).toBe('2026-10-27T10:00:00.123-05:00');
        expect(p(['--version', 'v', '--finding', 'F-999999999']).finding_ids).toEqual(['F-999999999']);
        expect(FINDINGS_MAX).toBe(50);
        const many = (n: number) => Array.from({ length: n }, (_, i) => ['--finding', `F-${i + 1}`]).flat();
        expect((p(['--version', 'v', ...many(50)]).finding_ids as string[]).length).toBe(50);
        expect(() => p(['--version', 'v', ...many(51)])).toThrow('at most 50 findings');
    });
});

