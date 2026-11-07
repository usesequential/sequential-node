// The `sequential` command, from a shell or a CI step:
//   sequential changes record   a change on your project's Changes timeline (changes:write, SEQUENTIAL_TOKEN)
//   sequential changes sync     a batch of changes in ONE request (record_changes): what a CI run sends, once per run
//   sequential releases record  a release marker, which fix verification measures against (releases:write,
//                               SEQUENTIAL_RELEASES_TOKEN)
// bin.ts runs it; this file only parses and sends, so a test can run it with a fake fetch.
//
// Each token comes from its environment variable only (never an argument, which shells and CI logs keep), must be a
// project access token, and is never printed. One scope per token: a deploy step that posts markers needs no right to
// write the timeline. Errors name the HTTP status and Sequential's error code, never a response body or header.
import { DEFAULT_HOST, RELEASE_PATTERN, RELEASE_PLACEHOLDERS } from './client';
import { SDK_VERSION } from './version';

export const KINDS = ['release', 'product', 'pricing', 'marketing', 'incident', 'company', 'external', 'tracking'] as const;
export const IMPORTANCES = ['major', 'minor', 'note'] as const;
export const OCCURRENCES = ['planned', 'happened', 'did_not_happen'] as const;
/** Sequential's own limits on a change, so a mistake is said before anything is sent. */
export const TITLE_MAX = 140;
export const LINKS_MAX = 10;
export const EXTERNAL_ID_MAX = 128;
export const TIMEOUT_MS = 15_000;
export const FINDINGS_MAX = 50;
/** The most items one `changes sync` run sends: record_changes' own limit. More is refused, never split into several
 *  requests: one run is one request (owner item 12b). */
export const ITEMS_MAX = 100;
const PAT_PREFIX = 'sq_pat_';
const SERVER_KEY_PREFIX = 'sqs_';

export const HELP = `Usage: sequential changes record --kind <kind> --title <text> [options]
       sequential changes sync --items <file|-> [options]
       sequential releases record --version <version> [options]

changes record: records one change on your project's Changes timeline. The token is
read from SEQUENTIAL_TOKEN: a project access token (sq_pat_…) with the changes:write
scope. It is never printed.

Options:
  --kind <kind>          ${KINDS.join(', ')}
  --title <text>         one line, at most ${TITLE_MAX} characters
  --summary <text>       one line
  --importance <level>   ${IMPORTANCES.join(', ')}
  --occurrence <value>   ${OCCURRENCES.join(', ')}
  --start <time>         a date-time with Z or an offset, a day, an ISO week or a month (default: now)
  --end <time>           as --start
  --version <version>    the release version (with --kind release), for example web@2.14
  --environment <name>   the release environment (default: production)
  --external-id <id>     your own id for this change: recording it again finds the same entry
  --pr <url>             a pull request link (repeatable)
  --commit <url>         a commit link (repeatable)
  --link <url>           any other link (repeatable)
  --host <url>           the Sequential API (default: ${DEFAULT_HOST})
  --dry-run              print what would be sent, and send nothing
  --help                 this text

changes sync: records a batch of changes in ONE request, the way a CI run should (one run,
one request: not \`changes record\` once per commit). --items is a file, or - for stdin,
holding a JSON array of 1 to ${ITEMS_MAX} changes, each with at least "kind" and "title" and
the fields of \`changes record\` in their JSON names (external_id, links, start …).
Same token as changes record.

Options:
  --items <file|->         the JSON array (required)
  --source <name>          the source of every item that names none (default: ci)
  --source-detail <text>   which repository or feed, as the source names it
  --covered-from <time>    with --covered-through: the range this run declares covered
  --covered-through <time> a date-time with Z or an offset; a stretch with no entries in it
                           then means nothing happened, according to this source
  --atomic                 write nothing when any item is refused
  --host, --dry-run, --help   as above

Exit codes: 0 every item written, 3 some items refused (each is printed with why), 1 the
run was refused or Sequential was not reached, 2 a usage mistake.

A release recorded here is a Changes entry. To have Sequential verify fixes against it,
also send the release marker (POST /api/releases with a releases:write token), for
example with \`sequential releases record\`.

releases record: posts a release marker, the version your app now runs, which Sequential
measures fixes against. The token is read from SEQUENTIAL_RELEASES_TOKEN: a personal access
token (sq_pat_…) with the releases:write scope. It is never printed.

Options:
  --version <version>    the release, exactly as your app sends it as its release (1-64 characters)
  --environment <name>   lowercase letters, digits, . _ - (default: the project's environment)
  --commit-sha <sha>     the commit, 7 to 40 hex characters
  --released-at <time>   a date-time with Z or an offset (default: now)
  --finding <F-n>        a finding this release fixes (repeatable, at most ${FINDINGS_MAX})
  --host, --dry-run, --help   as above
`;

export interface Io {
    out: (line: string) => void;
    err: (line: string) => void;
    fetch: typeof fetch;
    /** The text of a file, or of stdin for '-' (changes sync --items). */
    readText?: (path: string) => Promise<string>;
}

type Parsed = { flags: Map<string, string[]>; positional: string[] };
const VALUED = new Set(['kind', 'title', 'summary', 'importance', 'occurrence', 'start', 'end', 'version', 'environment', 'external-id', 'pr', 'commit', 'link', 'host', 'commit-sha', 'released-at', 'finding', 'items', 'source', 'source-detail', 'covered-from', 'covered-through']);
const SWITCHES = new Set(['dry-run', 'help', 'atomic']);
const REPEATABLE = new Set(['pr', 'commit', 'link', 'finding']);
/** The options each command takes (with --host, --dry-run and --help). */
const TAKES = new Map<string, ReadonlySet<string>>([
    ['changes record', new Set(['kind', 'title', 'summary', 'importance', 'occurrence', 'start', 'end', 'version', 'environment', 'external-id', 'pr', 'commit', 'link'])],
    ['releases record', new Set(['version', 'environment', 'commit-sha', 'released-at', 'finding'])],
    ['changes sync', new Set(['items', 'source', 'source-detail', 'covered-from', 'covered-through', 'atomic'])],
]);
const COMMON = new Set(['host', 'dry-run', 'help']);

class UsageError extends Error {}

/** `--name value`, `--name=value` and switches; anything else is a positional word. Hand-written: util.parseArgs is
 *  experimental on some Node 18 releases, and this package supports Node 18. */
export function parseArgs(argv: readonly string[]): Parsed {
    const flags = new Map<string, string[]>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            positional.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        if (SWITCHES.has(name)) {
            if (eq >= 0) throw new UsageError(`--${name} takes no value`);
            flags.set(name, ['true']);
            continue;
        }
        if (!VALUED.has(name)) throw new UsageError(`unknown option --${name}`);
        let value: string;
        if (eq >= 0) value = a.slice(eq + 1);
        else {
            if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`--${name} needs a value`);
            value = argv[++i];
        }
        const had = flags.get(name);
        if (had && !REPEATABLE.has(name)) throw new UsageError(`--${name} is given twice`);
        flags.set(name, [...(had ?? []), value]);
    }
    return { flags, positional };
}

const one = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.[0];

function oneOf<T extends string>(p: Parsed, name: string, list: readonly T[]): T | undefined {
    const v = one(p, name);
    if (v === undefined) return undefined;
    if (!(list as readonly string[]).includes(v)) throw new UsageError(`--${name} must be one of ${list.join(', ')}`);
    return v as T;
}

/** An http(s) URL, for a link. */
function linkUrl(name: string, v: string): string {
    let u: URL;
    try {
        u = new URL(v);
    } catch {
        throw new UsageError(`--${name} must be a URL`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UsageError(`--${name} must be an http or https URL`);
    return v;
}

/** The API origin: https, or http only to this machine (a token never crosses a network in clear text). */
export function apiHost(v: string | undefined): string {
    const raw = (v ?? DEFAULT_HOST).replace(/\/+$/, '');
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new UsageError('--host must be a URL');
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UsageError('--host must be https (http only for localhost)');
    if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new UsageError('--host must be an origin, for example https://api.usesequential.com');
    return u.origin;
}

/** The record_change arguments the flags describe. */
export function changeBody(p: Parsed): Record<string, unknown> {
    const kind = oneOf(p, 'kind', KINDS);
    if (!kind) throw new UsageError('--kind is required');
    const title = one(p, 'title')?.trim();
    if (!title) throw new UsageError('--title is required');
    if (title.length > TITLE_MAX) throw new UsageError(`--title is at most ${TITLE_MAX} characters`);
    const body: Record<string, unknown> = { kind, title, source: 'ci' };
    const summary = one(p, 'summary')?.trim();
    if (summary) body.summary = summary;
    const importance = oneOf(p, 'importance', IMPORTANCES);
    if (importance) body.importance = importance;
    const occurrence = oneOf(p, 'occurrence', OCCURRENCES);
    if (occurrence) body.occurrence = occurrence;
    for (const k of ['start', 'end'] as const) {
        const v = one(p, k);
        if (v !== undefined) body[k] = v;
    }
    const version = one(p, 'version');
    const environment = one(p, 'environment');
    if (version !== undefined) {
        if (kind !== 'release') throw new UsageError('--version goes with --kind release');
        body.release = { environment: environment ?? 'production', version };
    } else if (environment !== undefined) throw new UsageError('--environment goes with --version');
    const externalId = one(p, 'external-id');
    if (externalId !== undefined) {
        if (!externalId || externalId.length > EXTERNAL_ID_MAX) throw new UsageError(`--external-id is 1 to ${EXTERNAL_ID_MAX} characters`);
        body.external_id = externalId;
    }
    const links: { url: string; label: string }[] = [];
    for (const [name, label] of [['pr', 'pr'], ['commit', 'commit'], ['link', 'other']] as const)
        for (const v of p.flags.get(name) ?? []) links.push({ url: linkUrl(name, v), label });
    if (links.length > LINKS_MAX) throw new UsageError(`at most ${LINKS_MAX} links`);
    if (links.length) body.links = links;
    return body;
}

/** A release marker's body (POST /api/releases), checked as Sequential checks it so a mistake is said before sending. */
export function releaseBody(p: Parsed): Record<string, unknown> {
    const version = one(p, 'version');
    if (version === undefined) throw new UsageError('--version is required');
    if (version !== version.trim() || !RELEASE_PATTERN.test(version) || RELEASE_PLACEHOLDERS.includes(version.toLowerCase()))
        throw new UsageError('--version is 1-64 printable characters, without spaces at either end, and not a placeholder such as "null"');
    const body: Record<string, unknown> = { version };
    const environment = one(p, 'environment');
    if (environment !== undefined) {
        if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(environment)) throw new UsageError('--environment is lowercase letters, digits, . _ - (at most 32)');
        body.environment = environment;
    }
    const sha = one(p, 'commit-sha');
    if (sha !== undefined) {
        if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new UsageError('--commit-sha is 7 to 40 hex characters');
        body.commit_sha = sha.toLowerCase();
    }
    const at = one(p, 'released-at');
    if (at !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(at)) throw new UsageError('--released-at is a date-time with Z or an offset');
        body.released_at = at;
    }
    const findings = p.flags.get('finding') ?? [];
    if (findings.length > FINDINGS_MAX) throw new UsageError(`at most ${FINDINGS_MAX} findings`);
    for (const f of findings) if (!/^F-[1-9]\d{0,8}$/.test(f)) throw new UsageError('--finding is a finding number such as F-12');
    if (findings.length) body.finding_ids = findings;
    return body;
}

/** The token from `name` in the environment, or why it cannot be used. Never returns or prints any part of a wrong one. */
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** The record_changes arguments: the items from --items (checked enough that a mistake is said before anything is sent;
 *  the server checks every field), each without a source given --source (default ci), and the sync block with
 *  --covered-through. */
export function syncBody(p: Parsed, text: string): Record<string, unknown> {
    let items: unknown;
    try {
        items = JSON.parse(text);
    } catch {
        throw new UsageError('--items is not JSON: it must hold a JSON array of changes');
    }
    if (!Array.isArray(items)) throw new UsageError('--items must hold a JSON array of changes');
    if (items.length === 0) throw new UsageError('--items holds no changes');
    if (items.length > ITEMS_MAX)
        throw new UsageError(`--items holds ${items.length} changes; at most ${ITEMS_MAX} per run (one run is one request): split the range`);
    const source = one(p, 'source') ?? 'ci';
    if (!NAME.test(source)) throw new UsageError('--source is a source name such as ci or github');
    const out = items.map((it, i) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) throw new UsageError(`item ${i} is not an object`);
        const item = it as Record<string, unknown>;
        if (typeof item.kind !== 'string' || !(KINDS as readonly string[]).includes(item.kind)) throw new UsageError(`item ${i}: kind is one of ${KINDS.join(', ')}`);
        if (typeof item.title !== 'string' || !item.title.trim() || /[\r\n]/.test(item.title) || Array.from(item.title).length > TITLE_MAX)
            throw new UsageError(`item ${i}: title is one line of 1 to ${TITLE_MAX} characters`);
        if (item.external_id !== undefined && (typeof item.external_id !== 'string' || item.external_id.length > EXTERNAL_ID_MAX))
            throw new UsageError(`item ${i}: external_id is at most ${EXTERNAL_ID_MAX} characters`);
        return item.source === undefined ? { ...item, source } : item;
    });
    const through = one(p, 'covered-through');
    const from = one(p, 'covered-from');
    if (from !== undefined && through === undefined) throw new UsageError('--covered-from needs --covered-through');
    const detail = one(p, 'source-detail');
    // Sequential refuses a sync whose items do not carry the sync's source_detail (sync_mismatch), so --source-detail goes
    // into every item that names none, as --source does (1.2.0; before, every run with it was refused).
    const items2 = detail === undefined ? out : out.map((it) => (it.source_detail === undefined ? { ...it, source_detail: detail } : it));
    const body: Record<string, unknown> = { items: items2 };
    if (p.flags.has('atomic')) body.atomic = true;
    if (through !== undefined) {
        body.sync = { source, ...(detail !== undefined ? { source_detail: detail } : {}), ...(from !== undefined ? { covered_from: from } : {}), covered_through: through };
    }
    return body;
}

export function tokenFrom(env: Record<string, string | undefined>, name = 'SEQUENTIAL_TOKEN', scope = 'changes:write'): string {
    const t = env[name]?.trim();
    if (!t) throw new UsageError(`${name} is not set: create a project access token (sq_pat_…) with the ${scope} scope`);
    if (t.startsWith(SERVER_KEY_PREFIX))
        throw new UsageError(`${name} holds a server key, which sends events only: use a project access token (sq_pat_…) with the ${scope} scope`);
    if (!t.startsWith(PAT_PREFIX)) throw new UsageError(`${name} is not a project access token (sq_pat_…)`);
    return t;
}

type Command = { body: (p: Parsed, io: Io) => Record<string, unknown> | Promise<Record<string, unknown>>; path: string; token: string; scope: string };
/** Each command: its body, where it goes, and its token. A Map, so a word such as "constructor" is no command. */
const COMMANDS = new Map<string, Command>([
    ['changes record', { body: changeBody, path: '/api/agent/record_change', token: 'SEQUENTIAL_TOKEN', scope: 'changes:write' }],
    ['releases record', { body: releaseBody, path: '/api/releases', token: 'SEQUENTIAL_RELEASES_TOKEN', scope: 'releases:write' }],
    ['changes sync', { body: readSyncBody, path: '/api/agent/record_changes', token: 'SEQUENTIAL_TOKEN', scope: 'changes:write' }],
]);

async function readSyncBody(p: Parsed, io: Io): Promise<Record<string, unknown>> {
    const path = one(p, 'items');
    if (path === undefined) throw new UsageError('changes sync needs --items <file|->');
    if (!io.readText) throw new UsageError('--items cannot be read here');
    let text: string;
    try {
        text = await io.readText(path);
    } catch {
        throw new UsageError(path === '-' ? 'could not read the items from stdin' : `could not read ${path}`);
    }
    return syncBody(p, text);
}

/** A refused text's reason (the server's text_refused `reason`, BE src/changes/service.ts TEXT_REFUSALS) and the CLI's own
 *  hint for it. Only a reason listed here is printed, and never the server's hint or message. */
export const REASON_HINTS: Readonly<Record<string, string>> = {
    reads_as_agent_instruction: 'describe what changed, in the past tense, not what to do',
    text_has_link: 'leave web addresses, email addresses and @handles out of the text',
    text_has_secret: 'leave tokens, keys and card numbers out of the text',
    text_shape: 'one line, within the length limit',
    not_checked: 'try again later',
};

/** A short, safe word from an error answer, `{ error, message, errors?: [{ field, message }] }`: Sequential's error code
 *  and the first field it names (a pointer such as /title, or a bare name such as id), else nothing. A release refusal
 *  names its field only at the start of its message ("version: …"): that name is taken, never the rest. A text_refused
 *  answer's `reason` is added with the CLI's own hint when it is one REASON_HINTS knows. */
function errorCode(body: unknown): string {
    if (!body || typeof body !== 'object') return '';
    const b = body as { error?: unknown; errors?: unknown; message?: unknown; reason?: unknown };
    const code = typeof b.error === 'string' && /^[a-z_]{1,40}$/.test(b.error) ? b.error : '';
    const first = Array.isArray(b.errors) ? (b.errors[0] as { field?: unknown } | undefined) : undefined;
    const lead = !first && typeof b.message === 'string' ? /^([a-z_]{1,30}):/.exec(b.message)?.[1] : undefined;
    const f = first && typeof first === 'object' ? first.field : lead;
    const field = typeof f === 'string' && /^\/?[a-z_][a-z_/0-9]{0,59}$/.test(f) ? f : '';
    const reason = typeof b.reason === 'string' && Object.hasOwn(REASON_HINTS, b.reason) ? b.reason : '';
    return [code, field && `(${field})`, reason && `${reason}: ${REASON_HINTS[reason]}`].filter(Boolean).join(' ');
}

/** One stderr line on every run (1.2.0, owner 2026-11-06 ruling 2): the commands live on in the Sequential CLI. */
export const MOVED = 'sequential: these commands moved to the Sequential CLI (npx @usesequential/cli); they leave @usesequential/node in 2.0.';

/** Runs the command; the exit code: 0 recorded (or a dry run), 1 refused or not reached, 2 a usage mistake, 3 (changes sync)
 *  some items refused. */
export async function main(argv: readonly string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
    let p: Parsed;
    let body: Record<string, unknown>;
    let host: string;
    let name: string;
    let cmd: Command;
    try {
        p = parseArgs(argv);
        if (p.flags.has('help') || p.positional.length === 0) {
            io.out(HELP);
            return p.flags.has('help') ? 0 : 2;
        }
        name = p.positional.join(' ');
        io.err(MOVED);
        const found = COMMANDS.get(name);
        const takes = TAKES.get(name);
        if (!found || !takes) throw new UsageError(`unknown command: ${name}`);
        cmd = found;
        for (const f of p.flags.keys()) if (!COMMON.has(f) && !takes.has(f)) throw new UsageError(`${name} takes no --${f}`);
        body = await cmd.body(p, io);
        host = apiHost(one(p, 'host'));
        if (p.flags.has('dry-run')) {
            io.out(`Would send to ${host}${cmd.path}:`);
            io.out(JSON.stringify(body, null, 2));
            return 0;
        }
    } catch (e) {
        if (e instanceof UsageError) {
            io.err(`sequential: ${e.message}`);
            return 2;
        }
        throw e;
    }
    let token: string;
    try {
        token = tokenFrom(env, cmd.token, cmd.scope);
    } catch (e) {
        io.err(`sequential: ${(e as Error).message}`);
        return 2;
    }
    let res: Response;
    try {
        res = await io.fetch(`${host}${cmd.path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': `sequential-cli/${SDK_VERSION}` },
            body: JSON.stringify(body),
            // A redirect never carries the token to another host.
            redirect: 'error',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        io.err(`sequential: could not reach ${host}`);
        return 1;
    }
    let answer: unknown = null;
    try {
        answer = await res.json();
    } catch {
        // no JSON: the status says enough
    }
    if (!res.ok) {
        const code = errorCode(answer);
        io.err(`sequential: Sequential answered ${res.status}${code ? ` ${code}` : ''}`);
        return 1;
    }
    if (name === 'releases record') {
        io.out(`recorded release ${String(body.version)}`);
        return 0;
    }
    if (name === 'changes sync') return syncResult(answer, io);
    const a = (answer ?? {}) as { outcome?: unknown; change_id?: unknown };
    const outcome = typeof a.outcome === 'string' && /^[a-z_]{1,40}$/.test(a.outcome) ? a.outcome : 'recorded';
    const id = typeof a.change_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(a.change_id) ? ` ${a.change_id}` : '';
    io.out(`${outcome}${id}`);
    return 0;
}

const WORD = /^[a-z_]{1,40}$/;
/** One line per item: its index and outcome, the change id, and for a refused item the step, the field and the reason with
 *  the CLI's own hint (never the server's text). Exit 0 when every item was written, 3 when any was refused. */
function syncResult(answer: unknown, io: Io): number {
    const items = (answer && typeof answer === 'object' && Array.isArray((answer as { items?: unknown }).items) ? (answer as { items: unknown[] }).items : []) as Array<Record<string, unknown>>;
    let refused = 0;
    for (const it of items) {
        const index = typeof it.index === 'number' && Number.isInteger(it.index) ? it.index : '?';
        const outcome = typeof it.outcome === 'string' && WORD.test(it.outcome) ? it.outcome : 'unknown';
        const id = typeof it.change_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(it.change_id) ? ` ${it.change_id}` : '';
        if (outcome === 'refused' || outcome === 'not_checked') {
            refused++;
            const step = typeof it.step === 'string' && WORD.test(it.step) ? ` ${it.step}` : '';
            const field = typeof it.field === 'string' && /^\/?[a-z_][a-z_/0-9]{0,59}$/.test(it.field) ? ` (${it.field})` : '';
            const reason = typeof it.reason === 'string' && Object.hasOwn(REASON_HINTS, it.reason) ? ` ${it.reason}: ${REASON_HINTS[it.reason]}` : '';
            io.out(`#${index} ${outcome}${step}${field}${reason}`);
        } else {
            io.out(`#${index} ${outcome}${id}`);
        }
    }
    io.out(`${items.length - refused} written, ${refused} refused`);
    return refused > 0 ? 3 : 0;
}

