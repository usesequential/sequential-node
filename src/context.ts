// The browser context: which visitor and which browser session caused a request to the customer's backend.
//
// The browser SDK (sequential.js) writes it into the first-party cookie `__sq_ctx` on the customer's own domain while
// it records (spec 2026-10-12 §4.4). A backend on another site, or a native app, sends the same value in the header
// `x-sequential-context`. The value: `v1;d=<distinct_id>;s=<session_id>`, each part URI-encoded; the cookie holds the
// whole value URI-encoded once more (a cookie value cannot hold `;`).

export const CONTEXT_HEADER = 'x-sequential-context';
export const CONTEXT_COOKIE = '__sq_ctx';
/** The longest value read, after encoding. The browser SDK never writes a longer one. */
export const CONTEXT_MAX_CHARS = 600;
const MAX_ID = 200;

export interface SequentialContext {
    distinct_id: string;
    session_id: string;
}

export function encodeContext(c: SequentialContext): string {
    return `v1;d=${encodeURIComponent(c.distinct_id)};s=${encodeURIComponent(c.session_id)}`;
}

/** The context in a header value, or null when the value is missing, too long, of another version or half a context. */
export function parseContext(value: string | null | undefined): SequentialContext | null {
    if (typeof value !== 'string' || value === '' || value.length > CONTEXT_MAX_CHARS) return null;
    const parts = value.split(';');
    if (parts[0] !== 'v1') return null;
    let d = '';
    let s = '';
    for (const p of parts.slice(1)) {
        const i = p.indexOf('=');
        if (i < 0) continue;
        let v: string;
        try {
            v = decodeURIComponent(p.slice(i + 1));
        } catch {
            return null;
        }
        const k = p.slice(0, i);
        if (k === 'd') d = v;
        else if (k === 's') s = v;
    }
    if (!d.trim() || !s.trim() || d.length > MAX_ID || s.length > MAX_ID) return null;
    return { distinct_id: d, session_id: s };
}

type HeaderBag = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

/** Any request object with headers: Node's IncomingMessage (Express, Fastify's raw, Koa's req) or a Fetch API Request. */
export interface RequestLike {
    headers: HeaderBag;
}

function header(headers: HeaderBag, name: string): string | undefined {
    if (typeof (headers as { get?: unknown }).get === 'function') {
        return (headers as { get(n: string): string | null }).get(name) ?? undefined;
    }
    const v = (headers as Record<string, string | string[] | undefined>)[name];
    return Array.isArray(v) ? v.join(name === 'cookie' ? '; ' : ',') : v;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(';')) {
        const c = part.trim();
        if (c.startsWith(`${name}=`)) return c.slice(name.length + 1);
    }
    return undefined;
}

/** The browser context of an incoming request: the header first, then the cookie. Null when neither holds one. */
export function contextFromRequest(req: RequestLike | null | undefined): SequentialContext | null {
    if (!req || !req.headers) return null;
    const fromHeader = parseContext(header(req.headers, CONTEXT_HEADER));
    if (fromHeader) return fromHeader;
    const raw = cookieValue(header(req.headers, 'cookie'), CONTEXT_COOKIE);
    if (!raw || raw.length > CONTEXT_MAX_CHARS) return null;
    try {
        return parseContext(decodeURIComponent(raw));
    } catch {
        return null;
    }
}
