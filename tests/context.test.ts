// @usesequential/node: reading the browser context from a request.
import { contextFromRequest, parseContext, encodeContext, CONTEXT_COOKIE, CONTEXT_HEADER } from '../src';

// What the browser SDK writes into the cookie: the whole value URI-encoded once more.
const cookieValue = (d: string, s: string) => encodeURIComponent('v1;d=' + encodeURIComponent(d) + ';s=' + encodeURIComponent(s));

describe('parseContext', () => {
    it('round-trips encodeContext, including ids with ; = and spaces', () => {
        const c = { distinct_id: 'a;b=c d', session_id: '01a1-ü' };
        expect(parseContext(encodeContext(c))).toEqual(c);
    });

    it.each([
        ['missing', undefined],
        ['empty', ''],
        ['another version', 'v2;d=a;s=b'],
        ['half a context', 'v1;d=a'],
        ['blank ids', 'v1;d=%20;s=b'],
        ['bad escape', 'v1;d=%E0%A4%A;s=b'],
        ['over 600 characters', 'v1;d=' + 'a'.repeat(300) + ';s=' + 'b'.repeat(300)],
        ['an id over 200 characters', 'v1;d=' + 'a'.repeat(201) + ';s=b'],
    ])('ignores a value that is %s', (_label, v) => {
        expect(parseContext(v as any)).toBeNull();
    });
});

describe('contextFromRequest', () => {
    it('reads the cookie the browser SDK writes', () => {
        const req = { headers: { cookie: `other=1; ${CONTEXT_COOKIE}=${cookieValue('a-1', 's-1')}; x=y` } };
        expect(contextFromRequest(req)).toEqual({ distinct_id: 'a-1', session_id: 's-1' });
    });

    it('reads the header first, then the cookie', () => {
        const req = { headers: { [CONTEXT_HEADER]: encodeContext({ distinct_id: 'h', session_id: 'hs' }), cookie: `${CONTEXT_COOKIE}=${cookieValue('c', 'cs')}` } };
        expect(contextFromRequest(req)).toEqual({ distinct_id: 'h', session_id: 'hs' });
    });

    it('falls back to the cookie when the header is malformed', () => {
        const req = { headers: { [CONTEXT_HEADER]: 'garbage', cookie: `${CONTEXT_COOKIE}=${cookieValue('c', 'cs')}` } };
        expect(contextFromRequest(req)).toEqual({ distinct_id: 'c', session_id: 'cs' });
    });

    it('works with a Fetch API Request (Next.js route handlers, Hono, workers)', () => {
        const req = new Request('https://shop.example/api', { headers: { cookie: `${CONTEXT_COOKIE}=${cookieValue('a', 's')}` } });
        expect(contextFromRequest(req)).toEqual({ distinct_id: 'a', session_id: 's' });
    });

    it('ignores a header value over 600 characters, even when its ids are 200 characters or less', () => {
        const long = encodeContext({ distinct_id: 'ü'.repeat(100), session_id: 's' });
        expect(long.length).toBeGreaterThan(600);
        expect(parseContext(long)).toBeNull();
        expect(contextFromRequest({ headers: { [CONTEXT_HEADER]: long } })).toBeNull();
        const short = encodeContext({ distinct_id: 'ü'.repeat(90), session_id: 's' });
        expect(short.length).toBeLessThanOrEqual(600);
        expect(parseContext(short)).toEqual({ distinct_id: 'ü'.repeat(90), session_id: 's' });
    });

    it('reads the cookie for ids with ; = % and spaces', () => {
        const req = { headers: { cookie: `${CONTEXT_COOKIE}=${cookieValue('a;b=c d', '50%')}` } };
        expect(contextFromRequest(req)).toEqual({ distinct_id: 'a;b=c d', session_id: '50%' });
    });

    it('ignores a cookie over 600 characters and returns null with neither', () => {
        expect(contextFromRequest({ headers: { cookie: `${CONTEXT_COOKIE}=${cookieValue('ü'.repeat(60), 's')}` } })).toBeNull();
        expect(contextFromRequest({ headers: {} })).toBeNull();
        expect(contextFromRequest(null)).toBeNull();
        expect(contextFromRequest({ headers: { cookie: `${CONTEXT_COOKIE}=%E0%A4%A` } })).toBeNull();
    });

    it('does not take a cookie whose name only ends with __sq_ctx', () => {
        expect(contextFromRequest({ headers: { cookie: `x${CONTEXT_COOKIE}=${cookieValue('a', 's')}` } })).toBeNull();
    });
});
