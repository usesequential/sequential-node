// @usesequential/node: batching, caps, retries, drops and the error helpers.
import { SequentialServer, SequentialError, SERVER_MAX_EVENTS } from '../src';

const KEY = 'sqs_' + 'a1B2'.repeat(10);

interface Call { url: string; headers: Record<string, string>; body: { events: Array<Record<string, any>> } }

function fakeFetch(responses: Array<number | { status: number; headers?: Record<string, string>; body?: unknown } | 'network'> = []) {
    const calls: Call[] = [];
    let i = 0;
    const f = jest.fn(async (url: any, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url: String(url), headers: init.headers, body });
        const r = responses[Math.min(i++, responses.length - 1)] ?? 200;
        if (r === 'network') throw new TypeError('fetch failed');
        const spec = typeof r === 'number' ? { status: r } : r;
        const ok = spec.status >= 200 && spec.status < 300;
        const payload = spec.body ?? (ok ? { events_ingested: body.events.length, context_dropped: 0, context_unverified: 0, dropped_no_identity: 0 } : { error: 'x' });
        return new Response(JSON.stringify(payload), { status: spec.status, headers: spec.headers });
    });
    return { f: f as unknown as typeof fetch, calls };
}

const client = (o: Partial<ConstructorParameters<typeof SequentialServer>[0]> = {}, f = fakeFetch().f) =>
    new SequentialServer({ secretKey: KEY, host: 'https://api.example.test/', fetch: f, flushIntervalMs: 60_000, ...o });

describe('SequentialServer: the key', () => {
    it('refuses anything but a server secret key, and never repeats the value', () => {
        for (const bad of ['', 'sq_live_abc', 'sqs_short', 'sqs_' + 'a'.repeat(41), 'SQS_' + 'a'.repeat(40)]) {
            let msg = '';
            try { new SequentialServer({ secretKey: bad, fetch: fakeFetch().f }); } catch (e) { msg = (e as Error).message; }
            expect(msg).toMatch(/server secret key/);
            if (bad) expect(msg).not.toContain(bad);
        }
        expect(() => client()).not.toThrow();
    });

    it('sends the key only in the Authorization header, to /i/v1/server on the host, with its own user agent', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        sq.track({ event: 'order charged', userId: 'u-1' });
        await sq.flush();
        expect(calls[0].url).toBe('https://api.example.test/i/v1/server');
        expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
        expect(calls[0].headers['user-agent']).toMatch(/^sequential-node\/\d+\.\d+\.\d+$/);
        expect(JSON.stringify(calls[0].body)).not.toContain(KEY);
    });

    it('defaults to the production API host', async () => {
        const { f, calls } = fakeFetch();
        const sq = new SequentialServer({ secretKey: KEY, fetch: f });
        sq.track({ event: 'e', userId: 'u' });
        await sq.flush();
        expect(calls[0].url).toBe('https://api.usesequential.com/i/v1/server');
    });
});

describe('SequentialServer: track', () => {
    it('sends the wire shape the server reads: event, uuid, ts, user_id, context, account_id, props', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        expect(sq.track({ event: 'order charged', userId: 'u-42', context: { distinct_id: 'a-1', session_id: 's-1' }, accountId: 'acct-7', props: { amount_eur: 49, skip: undefined }, ts: 1_760_000_000_000, uuid: 'evt-1' })).toBe(true);
        await sq.flush();
        expect(calls[0].body.events[0]).toEqual({
            event: 'order charged', uuid: 'evt-1', ts: new Date(1_760_000_000_000).toISOString(),
            user_id: 'u-42', context: { distinct_id: 'a-1', session_id: 's-1' }, account_id: 'acct-7', props: { amount_eur: 49 },
        });
    });

    it('gives every event its own uuid, and a retry resends the same uuids', async () => {
        const { f, calls } = fakeFetch([503, 200]);
        const sq = client({}, f);
        sq.track({ event: 'a', userId: 'u' });
        sq.track({ event: 'b', userId: 'u' });
        await sq.flush();
        const first = calls[0].body.events.map((e) => e.uuid);
        expect(new Set(first).size).toBe(2);
        expect(calls[1].body.events.map((e) => e.uuid)).toEqual(first);
    });

    it.each([
        ['an empty name', { event: '' }],
        ['a name over 200 characters', { event: 'x'.repeat(201) }],
        ["a name that starts with '$'", { event: '$pageview' }],
        ['no name', {}],
    ])('drops %s and counts it as invalid', async (_label, input) => {
        const { f, calls } = fakeFetch();
        const errors: SequentialError[] = [];
        const sq = client({ onError: (e) => errors.push(e) }, f);
        expect(sq.track({ userId: 'u', ...(input as any) })).toBe(false);
        await sq.flush();
        expect(calls).toHaveLength(0);
        expect(sq.stats.dropped_invalid).toBe(1);
        expect(errors.map((e) => e.reason)).toEqual(['invalid_event']);
    });

    it('drops an event with neither a userId nor a whole context; a half context is no context', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        expect(sq.track({ event: 'x' })).toBe(false);
        expect(sq.track({ event: 'y', context: { distinct_id: 'a-1', session_id: '' } })).toBe(false);
        expect(sq.track({ event: 'z', userId: '   ' })).toBe(false);
        await sq.flush();
        expect(calls).toHaveLength(0);
        expect(sq.stats.dropped_no_identity).toBe(3);
    });

    it('a context alone is a key (the server counts it as unverified)', async () => {
        const { f, calls } = fakeFetch([{ status: 200, body: { events_ingested: 1, context_dropped: 0, context_unverified: 1, dropped_no_identity: 0 } }]);
        const sq = client({}, f);
        expect(sq.track({ event: 'cart priced', context: { distinct_id: 'a-1', session_id: 's-1' } })).toBe(true);
        await sq.flush();
        expect(calls[0].body.events[0]).not.toHaveProperty('user_id');
        expect(sq.stats).toMatchObject({ sent: 1, batches: 1, context_unverified: 1 });
    });

    it('drops an event whose props JSON cannot hold, at track time; the queue keeps working and nothing rejects', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        process.on('unhandledRejection', onUnhandled);
        try {
            const { f, calls } = fakeFetch();
            const errors: string[] = [];
            const sq = client({ flushAt: 1, onError: (e) => errors.push(e.reason) }, f);
            const circular: Record<string, unknown> = {};
            circular.self = circular;
            expect(sq.track({ event: 'big', userId: 'u', props: { amount: BigInt(10) } })).toBe(false);
            expect(sq.track({ event: 'loop', userId: 'u', props: { circular } })).toBe(false);
            expect(sq.track({ event: 'ok', userId: 'u' })).toBe(true);
            await sq.flush();
            await new Promise((r) => setImmediate(r));
            expect(calls.flatMap((c) => c.body.events.map((e) => e.event))).toEqual(['ok']);
            expect(sq.stats).toMatchObject({ dropped_invalid: 2, queued: 1, sent: 1 });
            expect(errors).toEqual(['invalid_event', 'invalid_event']);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('sends the event as it was at track time', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        const cart = { step: 1 };
        sq.track({ event: 'e', userId: 'u', props: { cart } });
        cart.step = 2;
        await sq.flush();
        expect(calls[0].body.events[0].props).toEqual({ cart: { step: 1 } });
    });

    it('never throws into the caller, even from a throwing onError', () => {
        const sq = client({ onError: () => { throw new Error('boom'); } });
        expect(() => sq.track({ event: '' })).not.toThrow();
        expect(() => sq.track(undefined as any)).not.toThrow();
    });
});

describe('SequentialServer: batching and caps', () => {
    it('sends at flushAt events, and never more than 500 per request', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({ flushAt: 10_000, maxQueue: 2_000 }, f);
        for (let i = 0; i < 1_200; i++) sq.track({ event: 'e', userId: 'u' });
        await sq.flush();
        expect(calls.map((c) => c.body.events.length)).toEqual([SERVER_MAX_EVENTS, SERVER_MAX_EVENTS, 200]);
        expect(sq.stats).toMatchObject({ queued: 1_200, sent: 1_200, batches: 3 });
    });

    it('starts a flush by itself when flushAt events are queued', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({ flushAt: 3 }, f);
        sq.track({ event: 'a', userId: 'u' });
        sq.track({ event: 'b', userId: 'u' });
        expect(calls).toHaveLength(0);
        sq.track({ event: 'c', userId: 'u' });
        await sq.flush();
        expect(calls[0].body.events.map((e) => e.event)).toEqual(['a', 'b', 'c']);
    });

    it('sends what is queued after flushIntervalMs', async () => {
        jest.useFakeTimers();
        try {
            const { f, calls } = fakeFetch();
            const sq = client({ flushIntervalMs: 1_000 }, f);
            sq.track({ event: 'a', userId: 'u' });
            await jest.advanceTimersByTimeAsync(999);
            expect(calls).toHaveLength(0);
            await jest.advanceTimersByTimeAsync(1);
            await sq.flush();
            expect(calls).toHaveLength(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('keeps each request under maxBatchBytes, and drops (and counts) one event that is over it alone', async () => {
        const { f, calls } = fakeFetch();
        const errors: string[] = [];
        const sq = client({ maxBatchBytes: 4_096, onError: (e) => errors.push(e.reason) }, f);
        for (let i = 0; i < 20; i++) sq.track({ event: 'e', userId: 'u', props: { pad: 'x'.repeat(500) } });
        sq.track({ event: 'huge', userId: 'u', props: { pad: 'x'.repeat(5_000) } });
        await sq.flush();
        for (const c of calls) expect(Buffer.byteLength(JSON.stringify(c.body))).toBeLessThanOrEqual(4_096);
        expect(calls.flatMap((c) => c.body.events).length).toBe(20);
        expect(sq.stats.dropped_too_large).toBe(1);
        expect(errors).toEqual(['event_too_large']);
    });

    it('caps maxBatchBytes at the server body cap (1 MB)', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({ maxBatchBytes: 5_000_000, flushAt: 500 }, f);
        for (let i = 0; i < 300; i++) sq.track({ event: 'e', userId: 'u', props: { pad: 'x'.repeat(5_000) } });
        await sq.flush();
        expect(calls.length).toBeGreaterThan(1);
        for (const c of calls) expect(Buffer.byteLength(JSON.stringify(c.body))).toBeLessThanOrEqual(1_000_000);
        expect(calls.flatMap((c) => c.body.events).length).toBe(300);
    });

    it('a number option that is not a finite number takes its default (flushAt NaN never hangs the flush)', async () => {
        const { f, calls } = fakeFetch();
        const unset = Number(undefined);
        const sq = client({ flushAt: unset, maxQueue: unset, maxBatchBytes: unset, flushIntervalMs: unset }, f);
        for (let i = 0; i < 250; i++) sq.track({ event: 'e', userId: 'u' });
        await sq.flush();
        expect(calls.map((c) => c.body.events.length)).toEqual([100, 100, 50]);
    });

    it('sends events tracked while a flush ends, before an awaited flush() resolves', async () => {
        // A flush that is ending can miss an event queued in the last microtasks before it settles. Try each depth.
        for (let depth = 0; depth < 40; depth++) {
            const sent: string[] = [];
            let release: () => void = () => undefined;
            const f = (async (_url: any, init: any) => {
                const events = JSON.parse(init.body).events as Array<{ event: string }>;
                sent.push(...events.map((e) => e.event));
                if (events[0].event === 'a') await new Promise<void>((r) => { release = r; });
                return new Response(JSON.stringify({ events_ingested: events.length }), { status: 200 });
            }) as unknown as typeof fetch;
            const sq = client({ flushAt: 1 }, f);
            sq.track({ event: 'a', userId: 'u' });
            await new Promise((r) => setImmediate(r));
            let flushed: Promise<void> = Promise.resolve();
            let p = Promise.resolve();
            for (let i = 0; i < depth; i++) p = p.then(() => undefined);
            void p.then(() => {
                sq.track({ event: 'b', userId: 'u' });
                flushed = sq.flush();
            });
            release();
            await new Promise((r) => setImmediate(r));
            await flushed;
            expect({ depth, sent }).toEqual({ depth, sent: ['a', 'b'] });
        }
    });

    it('drops new events once maxQueue events wait, and counts them', () => {
        const sq = client({ maxQueue: 3, flushAt: 500 });
        const accepted = [1, 2, 3, 4, 5].map(() => sq.track({ event: 'e', userId: 'u' }));
        expect(accepted).toEqual([true, true, true, false, false]);
        expect(sq.stats).toMatchObject({ queued: 3, dropped_queue_full: 2 });
    });

    it('disabled: validates and counts, sends nothing', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({ disabled: true }, f);
        sq.track({ event: 'e', userId: 'u' });
        await sq.shutdown();
        expect(calls).toHaveLength(0);
        expect(sq.stats.queued).toBe(1);
    });
});

describe('SequentialServer: retries', () => {
    beforeEach(() => jest.spyOn(global, 'setTimeout'));
    afterEach(() => jest.restoreAllMocks());

    it('waits for Retry-After on a 429, then sends the same batch', async () => {
        jest.useFakeTimers();
        try {
            const { f, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, 200]);
            const sq = client({}, f);
            sq.track({ event: 'e', userId: 'u' });
            const done = sq.flush();
            await jest.advanceTimersByTimeAsync(1_999);
            expect(calls).toHaveLength(1);
            await jest.advanceTimersByTimeAsync(1);
            await done;
            expect(calls).toHaveLength(2);
            expect(sq.stats).toMatchObject({ http429: 1, retries: 1, sent: 1 });
        } finally {
            jest.useRealTimers();
        }
    });

    it('retries a 5xx and a network error with backoff, at most maxRetries times, then drops and counts', async () => {
        const { f, calls } = fakeFetch([500, 'network', 502, 503]);
        const errors: SequentialError[] = [];
        const sq = client({ maxRetries: 3, onError: (e) => errors.push(e) }, f);
        sq.track({ event: 'a', userId: 'u' });
        sq.track({ event: 'b', userId: 'u' });
        await sq.flush();
        expect(calls).toHaveLength(4);
        expect(sq.stats).toMatchObject({ retries: 3, dropped_after_retries: 2, sent: 0 });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ reason: 'retries_exhausted', events: 2, status: 503 });
    }, 15_000);

    it('caps the backoff between retries at 30 s, and a maxRetries that is not a number is 3', async () => {
        const delays: number[] = [];
        (global.setTimeout as unknown as jest.SpyInstance).mockImplementation(((fn: () => void, ms: number) => {
            delays.push(ms);
            fn();
            return { unref() {} };
        }) as any);
        const { f, calls } = fakeFetch([503]);
        const sq = client({ maxRetries: 30, flushAt: 1 }, f);
        sq.track({ event: 'e', userId: 'u' });
        await sq.flush();
        expect(calls).toHaveLength(31);
        expect(Math.max(...delays)).toBeLessThanOrEqual(30_100);
        const second = fakeFetch([503]);
        const sq2 = client({ maxRetries: Number.NaN, flushAt: 1 }, second.f);
        sq2.track({ event: 'e', userId: 'u' });
        await sq2.flush();
        expect(second.calls).toHaveLength(4);
        expect(sq2.stats.dropped_after_retries).toBe(1);
    });

    // 503 overloaded (the server answers it with Retry-After 30-60 s while its database is down, 3-8 s when shedding load): held like
    // a 429, up to maxRetryMs (5 min) from the first failure, without spending maxRetries (2026-10-22).
    const overloaded = (sec: number) => ({ status: 503, headers: { 'retry-after': String(sec) }, body: { error: 'overloaded', retry_after_sec: sec } });

    it('a 4-minute 503 overloaded outage: the batch waits each Retry-After and is sent once when the server is back (default maxRetries 3)', async () => {
        jest.useFakeTimers();
        try {
            const { f, calls } = fakeFetch([overloaded(33), overloaded(45), overloaded(53), overloaded(60), overloaded(60), 200]);
            const errors: SequentialError[] = [];
            const sq = client({ onError: (e) => errors.push(e) }, f);
            sq.track({ event: 'held', userId: 'u' });
            const done = sq.flush();
            for (const [wait, n] of [[33, 2], [45, 3], [53, 4], [60, 5], [60, 6]] as const) {
                await jest.advanceTimersByTimeAsync(wait * 1000 - 1);
                expect(calls).toHaveLength(n - 1); // not before Retry-After
                await jest.advanceTimersByTimeAsync(1);
                expect(calls).toHaveLength(n);
            }
            await done;
            expect(sq.stats).toMatchObject({ retries: 5, sent: 1, dropped_after_retries: 0 });
            expect(errors).toEqual([]);
            expect(new Set(calls.map((c) => c.body.events[0].uuid)).size).toBe(1); // the same event each time
        } finally {
            jest.useRealTimers();
        }
    });

    it('a 503 overloaded that outlasts maxRetryMs (5 min from the first failure) drops the batch, once, as retries_exhausted', async () => {
        jest.useFakeTimers();
        try {
            const { f, calls } = fakeFetch([overloaded(60)]);
            const errors: SequentialError[] = [];
            const sq = client({ onError: (e) => errors.push(e) }, f);
            sq.track({ event: 'held', userId: 'u' });
            const done = sq.flush();
            await jest.advanceTimersByTimeAsync(300_000);
            await done;
            expect(calls).toHaveLength(6); // at 0, 60, 120, 180, 240 and 300 s; the sixth refusal is 5 min after the first
            expect(sq.stats).toMatchObject({ dropped_after_retries: 1, sent: 0 });
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatchObject({ reason: 'retries_exhausted', events: 1, status: 503 });
            // maxRetryMs is an option: 1 min holds the batch through one wait only
            const short = fakeFetch([overloaded(60)]);
            const sq2 = client({ maxRetryMs: 60_000 }, short.f);
            sq2.track({ event: 'held', userId: 'u' });
            const done2 = sq2.flush();
            await jest.advanceTimersByTimeAsync(60_000);
            await done2;
            expect(short.calls).toHaveLength(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('a plain 500 (no Retry-After) still retries with backoff and gives up after maxRetries (3 by default); a 503 without Retry-After too', async () => {
        for (const status of [500, 503]) {
            const { f, calls } = fakeFetch([status]);
            const sq = client({}, f);
            sq.track({ event: 'e', userId: 'u' });
            await sq.flush();
            expect([status, calls.length, sq.stats.dropped_after_retries]).toEqual([status, 4, 1]);
        }
    }, 15_000);

    it('a 429 with Retry-After is unchanged (waits for it), and its waits do not spend maxRetries either', async () => {
        jest.useFakeTimers();
        try {
            const limited = { status: 429, headers: { 'retry-after': '1' } };
            const { f, calls } = fakeFetch([limited, limited, limited, limited, 200]);
            const sq = client({ maxRetries: 0 }, f); // no backoff retries at all: the 429 waits still go on
            sq.track({ event: 'e', userId: 'u' });
            const done = sq.flush();
            await jest.advanceTimersByTimeAsync(4_000);
            await done;
            expect(calls).toHaveLength(5);
            expect(sq.stats).toMatchObject({ http429: 4, retries: 4, sent: 1 });
        } finally {
            jest.useRealTimers();
        }
    });

    it('the queue cap holds while a batch is held: new events above maxQueue are dropped and counted, not buffered', async () => {
        jest.useFakeTimers();
        try {
            const { f } = fakeFetch([overloaded(30), 200]);
            const sq = client({ maxQueue: 3, flushAt: 500 }, f);
            sq.track({ event: 'held', userId: 'u' });
            const done = sq.flush(); // the batch leaves the queue and waits 30 s
            await jest.advanceTimersByTimeAsync(1);
            const accepted = [1, 2, 3, 4].map(() => sq.track({ event: 'later', userId: 'u' }));
            expect(accepted).toEqual([true, true, true, false]);
            expect(sq.stats.dropped_queue_full).toBe(1);
            await jest.advanceTimersByTimeAsync(30_000);
            await done;
        } finally {
            jest.useRealTimers();
        }
    });

    it('drops a batch the server refuses with another 4xx, without retrying', async () => {
        for (const status of [400, 401, 403, 413]) {
            const { f, calls } = fakeFetch([status]);
            const errors: SequentialError[] = [];
            const sq = client({ onError: (e) => errors.push(e) }, f);
            sq.track({ event: 'e', userId: 'u' });
            await sq.flush();
            expect(calls).toHaveLength(1);
            expect(sq.stats.dropped_client_error).toBe(1);
            expect(errors[0]).toMatchObject({ reason: 'client_error', status });
            expect(errors[0].message).not.toContain(KEY);
        }
    });

    it('adds up the counts the server returns', async () => {
        const { f } = fakeFetch([{ status: 200, body: { events_ingested: 2, context_dropped: 1, context_unverified: 0, dropped_no_identity: 1 } }]);
        const sq = client({}, f);
        for (const e of ['a', 'b', 'c']) sq.track({ event: e, userId: 'u' });
        await sq.flush();
        expect(sq.stats).toMatchObject({ sent: 2, context_dropped: 1, dropped_no_identity: 1 });
    });
});

describe('SequentialServer: errors', () => {
    it('captureError sends $exception with the type, the message and the first 20 stack lines', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        const err = new RangeError('amount out of range');
        err.stack = ['RangeError: amount out of range', ...Array.from({ length: 30 }, (_, i) => `    at fn${i} (file.js:${i}:1)`)].join('\n');
        expect(sq.captureError(err, { userId: 'u-42', props: { job: 'invoice' } })).toBe(true);
        await sq.flush();
        const e = calls[0].body.events[0];
        expect(e.event).toBe('$exception');
        expect(e.props).toMatchObject({ job: 'invoice', $exception_type: 'RangeError', $exception_message: 'amount out of range' });
        expect(e.props.$exception_stack.split('\n')).toHaveLength(20);
    });

    it('captureError accepts a thrown non-Error', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        sq.captureError('plain string', { userId: 'u' });
        sq.captureError({ weird: true }, { userId: 'u' });
        await sq.flush();
        expect(calls[0].body.events.map((e) => [e.props.$exception_type, e.props.$exception_message])).toEqual([
            ['Error', 'plain string'],
            ['Error', 'Non-Error value thrown'],
        ]);
    });

    it('captureError cannot be overridden by a customer prop', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        sq.captureError(new TypeError('real'), { userId: 'u', props: { $exception_type: 'Fake', $exception_message: 'fake' } });
        await sq.flush();
        expect(calls[0].body.events[0].props).toMatchObject({ $exception_type: 'TypeError', $exception_message: 'real' });
    });

    it('captureHttpError sends a 5xx as HTTP <status> and METHOD <route template>; any other status is ignored', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        expect(sq.captureHttpError({ status: 503, method: 'post', route: '/orders/:id', userId: 'u', context: { distinct_id: 'u', session_id: 's' } })).toBe(true);
        for (const status of [200, 404, 499, 600, 503.5]) expect(sq.captureHttpError({ status, method: 'GET', route: '/x', userId: 'u' })).toBe(false);
        await sq.flush();
        expect(calls[0].body.events).toHaveLength(1);
        expect(calls[0].body.events[0]).toMatchObject({ event: '$exception', context: { distinct_id: 'u', session_id: 's' }, props: { $exception_type: 'HTTP 503', $exception_message: 'POST /orders/:id' } });
    });

    it('error helpers need an identity like track does', () => {
        const sq = client();
        expect(sq.captureError(new Error('x'))).toBe(false);
        expect(sq.stats.dropped_no_identity).toBe(1);
    });
});

describe('SequentialServer: release', () => {
    const releasesOf = (calls: Call[]) => calls.flatMap((c) => c.body.events.map((e) => e.props.$release));

    it('sends the release option as $release on every event, errors included', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({ release: 'backend@1a2b3c4d5e6f' }, f);
        sq.track({ event: 'order charged', userId: 'u', props: { plan: 'pro' } });
        sq.captureError(new Error('x'), { userId: 'u' });
        sq.captureHttpError({ status: 500, method: 'GET', route: '/x', userId: 'u' });
        await sq.flush();
        expect(releasesOf(calls)).toEqual(['backend@1a2b3c4d5e6f', 'backend@1a2b3c4d5e6f', 'backend@1a2b3c4d5e6f']);
        expect(calls[0].body.events[0].props.plan).toBe('pro');
    });

    it('sends no $release without the option', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        sq.track({ event: 'order charged', userId: 'u' });
        await sq.flush();
        expect('$release' in calls[0].body.events[0].props).toBe(false);
    });

    it("an event's own $release prop wins over the option; an undefined one does not", async () => {
        const { f, calls } = fakeFetch();
        const sq = client({ release: 'backend@1' }, f);
        sq.track({ event: 'a', userId: 'u', props: { $release: 'worker@2' } });
        sq.track({ event: 'b', userId: 'u', props: { $release: undefined } });
        await sq.flush();
        expect(releasesOf(calls)).toEqual(['worker@2', 'backend@1']);
    });

    it('trims the option, and sends none for a value ingest would store as none', async () => {
        const { f, calls } = fakeFetch();
        const ok = client({ release: '  1.4.0 ' }, f);
        ok.track({ event: 'a', userId: 'u' });
        await ok.flush();
        expect(releasesOf(calls)).toEqual(['1.4.0']);
        for (const bad of ['', '   ', 'x'.repeat(65), 'caf\u00e9', 'a\nb', 'undefined', 'NULL', ' None ', '(null)', 42, null]) {
            const c = fakeFetch();
            const sq = client({ release: bad as unknown as string }, c.f);
            sq.track({ event: 'a', userId: 'u' });
            await sq.flush();
            expect([bad, '$release' in c.calls[0].body.events[0].props]).toEqual([bad, false]);
        }
        const c = fakeFetch();
        const max = client({ release: 'x'.repeat(64) }, c.f);
        max.track({ event: 'a', userId: 'u' });
        await max.flush();
        expect(releasesOf(c.calls)).toEqual(['x'.repeat(64)]);
    });
});

describe('SequentialServer: shutdown', () => {
    it('flushes what is queued, and concurrent flushes share one send', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        sq.track({ event: 'a', userId: 'u' });
        await Promise.all([sq.flush(), sq.flush(), sq.shutdown()]);
        expect(calls).toHaveLength(1);
    });

    it('the interval timer never keeps the process alive', () => {
        const unref = jest.fn();
        const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => ({ unref, fn })) as any);
        try {
            const sq = client({ flushIntervalMs: 1_000 });
            sq.track({ event: 'a', userId: 'u' });
            expect(unref).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('SequentialServer: ids and time', () => {
    it('refuses an event whose id is over 200 characters, rather than dropping the id', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        const ctx = { distinct_id: 'a-1', session_id: 's-1' };
        expect(sq.track({ event: 'e', userId: 'u'.repeat(201), context: ctx })).toBe(false);
        expect(sq.track({ event: 'e', userId: 'u', accountId: 'a'.repeat(201) })).toBe(false);
        expect(sq.track({ event: 'e', context: { distinct_id: 'd'.repeat(201), session_id: 's' } })).toBe(false);
        expect(sq.track({ event: 'e', userId: 'u'.repeat(200), context: ctx })).toBe(true);
        await sq.flush();
        expect(calls[0].body.events).toHaveLength(1);
        expect(sq.stats.dropped_invalid).toBe(3);
    });

    it('a null ts (plain JavaScript callers) means now, not 1970', async () => {
        const { f, calls } = fakeFetch();
        const sq = client({}, f);
        sq.track({ event: 'e', userId: 'u', ts: null as any });
        await sq.flush();
        expect(new Date(calls[0].body.events[0].ts).getFullYear()).toBeGreaterThan(2000);
    });
});
