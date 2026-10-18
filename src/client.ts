// SequentialServer: events from the customer's backend onto the same person and browser session as that person's
// browser events.
//
// The join key, in the order the server applies it: userId (the id the browser's identify() sends) wins; the browser
// context adds the session when it belongs to that user; with no userId the context alone is the key (counted as
// unverified). An event with neither is not sent.
//
// Volume: events queue in memory and leave in batches (flushAt events or flushIntervalMs, whichever comes first), each
// under maxBatchBytes and the server's 500-event cap. A 429 waits for Retry-After; a 5xx or a network error retries
// with backoff; any other 4xx drops the batch. A full queue drops new events rather than growing. Every drop is
// counted in `stats`. Every event carries a uuid, so a retried batch is stored once.
import { randomUUID } from 'node:crypto';
import type { SequentialContext } from './context';
import { SDK_VERSION } from './version';

export const DEFAULT_HOST = 'https://api.usesequential.com';
export const SERVER_KEY_RE = /^sqs_[A-Za-z0-9]{40}$/;
/** The server's cap per request (POST /i/v1/server answers 413 above it). */
export const SERVER_MAX_EVENTS = 500;
/** The server's body cap is 1 MB. maxBatchBytes never goes over it. */
export const SERVER_MAX_BODY_BYTES = 1_000_000;
/** The longest wait between two retries of a 5xx or a network error. */
const MAX_BACKOFF_MS = 30_000;
/** The longest delay setTimeout keeps. Node runs a longer delay after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const MAX_NAME = 200;
const MAX_ID = 200;
const STACK_LINES = 20;
const MAX_ERROR_TEXT = 2000;

export interface SequentialServerOptions {
    /** The server secret key (sqs_…) from Settings → Server keys. Never the browser write key. */
    secretKey: string;
    /** The Sequential API origin. Default https://api.usesequential.com. */
    host?: string;
    /** Send a batch at this many queued events. Default 100, at most 500. */
    flushAt?: number;
    /** Send what is queued at least this often. Default 1000 ms. */
    flushIntervalMs?: number;
    /** The largest request body. Default 512 kB, at most 1 MB. An event alone over it is dropped. */
    maxBatchBytes?: number;
    /** The most events held in memory. Default 10,000; new events above it are dropped. */
    maxQueue?: number;
    /** Retries of a batch after a 429, a 5xx or a network error. Default 3. */
    maxRetries?: number;
    /** Send nothing (tests, local development). track() still validates and counts. */
    disabled?: boolean;
    /** Called for each dropped event or batch, with the reason. Never throws into your code. */
    onError?: (error: SequentialError) => void;
    /** The fetch to use. Default the global fetch (Node 18+). */
    fetch?: typeof fetch;
}

export interface TrackInput {
    /** The event name, for example 'order charged'. At most 200 characters; never starts with '$'. */
    event: string;
    /** The id your browser code sends with identify(). Send it whenever your server knows the user. */
    userId?: string | null;
    /** The browser context of the request that caused this event: contextFromRequest(req). */
    context?: SequentialContext | null;
    /** The account (organisation) id your browser code sends with account(). */
    accountId?: string | null;
    /** Flat properties: ids, enums, counts. Objects and arrays are stored as JSON text. */
    props?: Record<string, unknown>;
    /** When it happened. Default now. */
    ts?: Date | string | number;
    /** A unique id for this event, so a retry is stored once. Default a random UUID. */
    uuid?: string;
}

export interface ErrorInput {
    userId?: string | null;
    context?: SequentialContext | null;
    accountId?: string | null;
    props?: Record<string, unknown>;
    ts?: Date | string | number;
}

export interface HttpErrorInput extends ErrorInput {
    /** The status your API answered. Only 5xx is sent. */
    status: number;
    /** The HTTP method, for example 'POST'. */
    method: string;
    /** The route TEMPLATE, for example '/orders/:id', never the raw path: ids would split one problem into many. */
    route: string;
}

export type DropReason =
    | 'invalid_event'
    | 'no_identity'
    | 'queue_full'
    | 'event_too_large'
    | 'client_error'
    | 'retries_exhausted';

export class SequentialError extends Error {
    constructor(
        readonly reason: DropReason,
        message: string,
        readonly events: number,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'SequentialError';
    }
}

export interface SdkStats {
    /** Events accepted into the queue. */
    queued: number;
    /** Events the server stored. */
    sent: number;
    /** Requests the server accepted. */
    batches: number;
    retries: number;
    http429: number;
    dropped_invalid: number;
    dropped_no_identity: number;
    dropped_queue_full: number;
    dropped_too_large: number;
    dropped_client_error: number;
    dropped_after_retries: number;
    /** Server counts: a userId whose context was another visitor's (the session was dropped, the event kept). */
    context_dropped: number;
    /** Server counts: a context with no userId (accepted, not checkable). */
    context_unverified: number;
}

interface WireEvent {
    event: string;
    uuid: string;
    ts: string;
    user_id?: string;
    context?: SequentialContext;
    account_id?: string;
    props: Record<string, unknown>;
}

/** A queued event: its JSON, made once in track(), and the bytes of that JSON. */
interface QueuedEvent {
    json: string;
    bytes: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

function idOrUndefined(v: string | null | undefined): string | undefined {
    return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_ID ? v : undefined;
}

function contextOrUndefined(c: SequentialContext | null | undefined): SequentialContext | undefined {
    if (!c) return undefined;
    const d = idOrUndefined(c.distinct_id);
    const s = idOrUndefined(c.session_id);
    return d && s ? { distinct_id: d, session_id: s } : undefined;
}

/** A number option: the default when it is not a finite number, then held between min and max. */
function numberOption(v: number | undefined, def: number, min: number, max: number): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
    return Math.min(max, Math.max(min, n));
}

function isoTime(ts: Date | string | number | null | undefined): string {
    if (ts === undefined || ts === null) return new Date().toISOString();
    const d = ts instanceof Date ? ts : new Date(ts);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export class SequentialServer {
    private queue: QueuedEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private flushing: Promise<void> | null = null;
    private readonly secretKey: string;
    private readonly endpoint: string;
    private readonly flushAt: number;
    private readonly flushIntervalMs: number;
    private readonly maxBatchBytes: number;
    private readonly maxQueue: number;
    private readonly maxRetries: number;
    private readonly disabled: boolean;
    private readonly onError?: (e: SequentialError) => void;
    private readonly fetchImpl: typeof fetch;
    readonly stats: SdkStats = {
        queued: 0, sent: 0, batches: 0, retries: 0, http429: 0,
        dropped_invalid: 0, dropped_no_identity: 0, dropped_queue_full: 0, dropped_too_large: 0,
        dropped_client_error: 0, dropped_after_retries: 0, context_dropped: 0, context_unverified: 0,
    };

    constructor(opts: SequentialServerOptions) {
        if (!opts || typeof opts.secretKey !== 'string' || !SERVER_KEY_RE.test(opts.secretKey)) {
            // The message never repeats the value: a wrong value may still be a secret.
            throw new Error('SequentialServer: secretKey must be a server secret key (sqs_ and 40 letters or digits), never the browser write key');
        }
        const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
        if (typeof f !== 'function') throw new Error('SequentialServer: no fetch: use Node 18 or later, or pass options.fetch');
        this.secretKey = opts.secretKey;
        this.endpoint = `${(opts.host ?? DEFAULT_HOST).replace(/\/+$/, '')}/i/v1/server`;
        // A value that is not a finite number (for example Number(process.env.UNSET)) takes the default. NaN in
        // flushAt made takeBatch return no events, so the flush loop never ended and blocked the event loop.
        this.flushAt = Math.floor(numberOption(opts.flushAt, 100, 1, SERVER_MAX_EVENTS));
        this.flushIntervalMs = numberOption(opts.flushIntervalMs, 1000, 0, MAX_TIMER_MS);
        this.maxBatchBytes = numberOption(opts.maxBatchBytes, 512 * 1024, 1024, SERVER_MAX_BODY_BYTES);
        this.maxQueue = Math.floor(numberOption(opts.maxQueue, 10_000, 1, Number.MAX_SAFE_INTEGER));
        this.maxRetries = Math.floor(numberOption(opts.maxRetries, 3, 0, Number.MAX_SAFE_INTEGER));
        this.disabled = opts.disabled === true;
        this.onError = opts.onError;
        this.fetchImpl = f;
    }

    /** Queues one event. Returns false when the event was dropped (the reason is counted in `stats`). Never throws. */
    track(input: TrackInput): boolean {
        const name = input?.event;
        if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME || name.startsWith('$')) {
            this.stats.dropped_invalid++;
            this.report('invalid_event', "the event name must be 1-200 characters and must not start with '$'", 1);
            return false;
        }
        return this.enqueue(name, input, input.props ?? {});
    }

    /**
     * Sends an error from your server: a failed job, an exception your code caught. It becomes an error in Sequential
     * and feeds findings like a browser error, shown as coming from your server.
     */
    captureError(error: unknown, input: ErrorInput = {}): boolean {
        const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-Error value thrown');
        const stack = typeof e.stack === 'string' ? e.stack.split('\n').slice(0, STACK_LINES).join('\n') : '';
        return this.enqueue('$exception', input, {
            ...(input.props ?? {}),
            $exception_type: clip(e.name || 'Error', MAX_NAME),
            $exception_message: clip(e.message ?? '', MAX_ERROR_TEXT),
            ...(stack ? { $exception_stack: clip(stack, MAX_ERROR_TEXT * 4) } : {}),
        });
    }

    /** Sends a 5xx that your API answered, as an error. Any other status is ignored (returns false, counts nothing). */
    captureHttpError(input: HttpErrorInput): boolean {
        if (!input || !Number.isInteger(input.status) || input.status < 500 || input.status > 599) return false;
        const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
        const route = typeof input.route === 'string' && input.route !== '' ? input.route : '(unknown route)';
        return this.enqueue('$exception', input, {
            ...(input.props ?? {}),
            $exception_type: `HTTP ${input.status}`,
            $exception_message: clip(`${method} ${route}`, MAX_ERROR_TEXT),
        });
    }

    /** Sends everything queued. Resolves when each batch was stored or dropped. */
    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.flushing) {
            // A running flush can end without the events queued after its last check. Send those too.
            await this.flushing;
            if (this.queue.length) await this.flush();
            return;
        }
        this.flushing = (async () => {
            while (this.queue.length) await this.sendBatch(this.takeBatch());
        })().finally(() => {
            this.flushing = null;
        });
        return this.flushing;
    }

    /** A flush that nobody awaits. It must never become an unhandled rejection in the caller's process. */
    private flushInBackground(): void {
        this.flush().catch(() => undefined);
    }

    /** Flushes before your process exits. Call it on SIGTERM and at the end of a serverless handler. */
    async shutdown(): Promise<void> {
        await this.flush();
    }

    private enqueue(name: string, input: ErrorInput & { uuid?: string }, props: Record<string, unknown>): boolean {
        // An id over 200 characters is refused, never ignored: ignoring a userId would put the event on the
        // anonymous visitor of the context instead of the user.
        const tooLong = [input.userId, input.accountId, input.context?.distinct_id, input.context?.session_id]
            .some((v) => typeof v === 'string' && v.length > MAX_ID);
        if (tooLong) {
            this.stats.dropped_invalid++;
            this.report('invalid_event', 'an id (userId, accountId or a context id) is over 200 characters', 1);
            return false;
        }
        const user_id = idOrUndefined(input.userId);
        const context = contextOrUndefined(input.context);
        if (!user_id && !context) {
            this.stats.dropped_no_identity++;
            this.report('no_identity', 'an event needs a userId or a browser context', 1);
            return false;
        }
        if (this.queue.length >= this.maxQueue) {
            this.stats.dropped_queue_full++;
            this.report('queue_full', `the queue holds ${this.maxQueue} events`, 1);
            return false;
        }
        const account_id = idOrUndefined(input.accountId);
        const flat: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) if (v !== undefined && typeof v !== 'function') flat[k] = v;
        const wire: WireEvent = {
            event: name,
            uuid: idOrUndefined(input.uuid) ?? randomUUID(),
            ts: isoTime(input.ts),
            ...(user_id ? { user_id } : {}),
            ...(context ? { context } : {}),
            ...(account_id ? { account_id } : {}),
            props: flat,
        };
        // The JSON is made here, not at send time. A prop that JSON cannot hold (a BigInt, a circular object) drops
        // this event now. At send time it threw in the background: an unhandled rejection, and the event stayed
        // first in the queue, so no later event was sent.
        let json: string;
        try {
            json = JSON.stringify(wire);
        } catch {
            this.stats.dropped_invalid++;
            this.report('invalid_event', 'a prop cannot be sent as JSON (for example a BigInt or a circular object)', 1);
            return false;
        }
        this.queue.push({ json, bytes: byteLength(json) });
        this.stats.queued++;
        if (this.queue.length >= this.flushAt) this.flushInBackground();
        else if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.flushInBackground();
            }, this.flushIntervalMs);
            // A queued event never keeps the process alive; call shutdown() before exit to send it.
            (this.timer as { unref?: () => void }).unref?.();
        }
        return true;
    }

    /** Up to flushAt events and never over maxBatchBytes of JSON. An event alone over the cap is dropped. */
    private takeBatch(): QueuedEvent[] {
        const batch: QueuedEvent[] = [];
        const envelope = byteLength('{"events":[]}');
        let bytes = envelope;
        while (this.queue.length && batch.length < this.flushAt) {
            const size = this.queue[0].bytes + 1;
            if (size + envelope > this.maxBatchBytes) {
                this.queue.shift();
                this.stats.dropped_too_large++;
                this.report('event_too_large', `one event is over maxBatchBytes (${this.maxBatchBytes})`, 1);
                continue;
            }
            if (bytes + size > this.maxBatchBytes) break;
            batch.push(this.queue.shift()!);
            bytes += size;
        }
        return batch;
    }

    private async sendBatch(events: QueuedEvent[]): Promise<void> {
        if (!events.length) return;
        if (this.disabled) return;
        for (let attempt = 0; ; attempt++) {
            let status: number;
            let retryAfterSec = 0;
            try {
                const res = await this.fetchImpl(this.endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${this.secretKey}`,
                        'user-agent': `sequential-node/${SDK_VERSION}`,
                    },
                    body: `{"events":[${events.map((e) => e.json).join(',')}]}`,
                });
                status = res.status;
                retryAfterSec = Number(res.headers.get('retry-after') ?? 0) || 0;
                if (res.ok) {
                    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                    const n = (k: string) => (typeof b[k] === 'number' ? (b[k] as number) : 0);
                    this.stats.sent += n('events_ingested');
                    this.stats.context_dropped += n('context_dropped');
                    this.stats.context_unverified += n('context_unverified');
                    this.stats.dropped_no_identity += n('dropped_no_identity');
                    this.stats.batches++;
                    return;
                }
                await res.body?.cancel().catch(() => undefined);
            } catch {
                status = 0;
            }
            if (status === 429) this.stats.http429++;
            const retryable = status === 0 || status === 429 || status >= 500;
            if (!retryable) {
                this.stats.dropped_client_error += events.length;
                this.report('client_error', `Sequential refused the batch (HTTP ${status})`, events.length, status);
                return;
            }
            if (attempt >= this.maxRetries) {
                this.stats.dropped_after_retries += events.length;
                this.report('retries_exhausted', `the batch failed ${attempt + 1} times (last: ${status ? `HTTP ${status}` : 'network error'})`, events.length, status || undefined);
                return;
            }
            this.stats.retries++;
            // Capped: 200 * 2 ** attempt grows past the longest setTimeout delay at attempt 24, and Node then waits 1 ms.
            const backoff = Math.min(200 * 2 ** attempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 100);
            await sleep(status === 429 && retryAfterSec > 0 ? Math.min(retryAfterSec, 60) * 1000 : backoff);
        }
    }

    private report(reason: DropReason, message: string, events: number, status?: number): void {
        if (!this.onError) return;
        try {
            this.onError(new SequentialError(reason, message, events, status));
        } catch {
            // The caller's handler must never break their request.
        }
    }
}
