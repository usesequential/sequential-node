# @usesequential/node

Send your backend's events and errors to [Sequential](https://www.usesequential.com). Each event lands on the same
person as that person's browser events. When a browser request caused it, it also lands in that browser session, next
to the replay.

- "order charged", "email sent", "invoice failed": the facts only your server knows.
- A 5xx your API answered, a job that failed: they become errors in Sequential and feed findings like browser errors,
  marked "From your server".
- No dependencies. Node 18 or later. CommonJS and ES modules. Types included.

## Install

```bash
npm install @usesequential/node
```

Create a **server key** in Sequential: in **Settings → Projects**, open your project's **Sources & keys** tab, then
**Server keys → Create a server key**. The key starts with `sqs_`. Sequential shows it once and stores only its hash. Keep it in your secret store,
for example as `SEQUENTIAL_SERVER_KEY`.

A server key is a secret. Never put it in a web page or a mobile app. The browser uses the project's **write key**, which
is a different key. Sequential refuses a server key in a request that comes from a browser.

## Send an event

```ts
import { SequentialServer, contextFromRequest } from '@usesequential/node';

const sequential = new SequentialServer({ secretKey: process.env.SEQUENTIAL_SERVER_KEY! });

app.post('/checkout', async (req, res) => {
    const order = await charge(req.body);
    sequential.track({
        event: 'order charged',
        userId: req.user?.id,              // the id your browser code sends with identify()
        context: contextFromRequest(req),  // the browser session of this request
        props: { plan: order.plan, amount_eur: order.amount },
    });
    res.json(order);
});

process.on('SIGTERM', async () => {
    await sequential.shutdown();           // sends what is still queued
    process.exit(0);
});
```

`track()` returns at once. Events leave in batches in the background.

### How Sequential finds the person and the session

| You send | The event lands on |
|---|---|
| `userId` and `context` | that user, in that browser session |
| `userId` only (a cron job, a queue worker) | that user, in no session. It shows in **Backend activity** on the user's page. |
| `context` only (the visitor did not sign in) | that visitor, in that session. Once the visitor signs in, the event is on the user. |
| neither | nothing: the SDK does not send it |

Use the same `userId` that your browser code sends with `sequential.identify()`.

When you send a `userId` and a `context`, Sequential keeps the session only when the context belongs to that user. A
visitor can edit their own cookie, so a context that belongs to another visitor is dropped. The event then stays on the
user with no session. `stats.context_dropped` counts it.

Sequential can prove that a context belongs to a user only after it has stored the browser's `identify()`. That can
take about a minute. In that first minute after a visitor signs in, an event with their `userId` stays on the user but
not in the session, and `stats.context_dropped` counts it.

### Where the context comes from

The browser SDK writes the first-party cookie `__sq_ctx` on your own domain while it records. The cookie reaches your
backend with each request from your pages, and `contextFromRequest(req)` reads it. It also reads the header
`x-sequential-context` first, for these cases:

- Your API is on another site than your pages (the cookie does not go cross-site). Send the header from your page.
- Your API is on another subdomain (pages on `www.shop.com`, API on `api.shop.com`). Either send the header, or set the
  attribute `data-context-cookie-domain="shop.com"` on the browser SDK's script tag.
- A native app calls your API. Send the header.

`contextFromRequest` accepts Node's request (Express, Koa's `ctx.req`, Fastify's `request.raw`, plain `http`) and a
Fetch API `Request` (Next.js route handlers, Hono's `c.req.raw`, workers). It returns `null` when the request has no context.

## Send an error

```ts
// An exception that your code caught (a failed job, a failed payment).
try {
    await sendInvoice(order);
} catch (err) {
    sequential.captureError(err, { userId: order.userId, props: { job: 'invoice' } });
    throw err;
}

// A 5xx that your API answered. Send the route TEMPLATE, never the raw path:
// ids in the path would split one problem into many findings.
app.use((req, res, next) => {
    res.on('finish', () => {
        sequential.captureHttpError({
            status: res.statusCode,          // only 500-599 is sent
            method: req.method,
            route: req.route?.path ?? 'unknown',
            userId: req.user?.id,
            context: contextFromRequest(req),
        });
    });
    next();
});
```

`captureError` sends the error's type, its message and the first 20 lines of its stack. Keep personal data out of your
error messages. Sequential screens names and emails in what agents read, but your messages are stored as you send them.

## Options

| Option | Default | What it does |
|---|---|---|
| `secretKey` | (required) | The server key, `sqs_…`. |
| `host` | `https://api.usesequential.com` | The Sequential API origin. |
| `flushAt` | 100 (at most 500) | Send a batch at this many queued events. |
| `flushIntervalMs` | 1000 | Send what is queued at least this often. |
| `maxBatchBytes` | 512 kB (at most 1 MB) | The largest request. One event over it is dropped. |
| `maxQueue` | 10,000 | The most events held in memory. New events above it are dropped. |
| `maxRetries` | 3 | Retries after a 5xx or a network error that came without `Retry-After`. |
| `maxRetryMs` | 300,000 | How long a batch is held while the server answers 429 or 503 with `Retry-After` (5 minutes, from the batch's first failure). |
| `release` | none | The build this server runs, for example `'backend@' + process.env.GIT_SHA`, sent as `$release` on every event so Sequential can compare before and after a release. 1-64 printable ASCII characters; any other value is not sent. An event's own `$release` prop wins. |
| `disabled` | `false` | Send nothing (tests, local development). |
| `onError` | none | Called with a `SequentialError` for each drop: `reason`, `events`, `status`. |
| `fetch` | global `fetch` | Your own fetch. |

A number option that is not a finite number (for example `Number(process.env.UNSET)`) takes its default.

## Serverless functions

A function can stop as soon as it answers. Call `await sequential.flush()` before you return, or the queued events can
be lost. The SDK's timer never keeps a process alive by itself.

## Delivery

- A 429, or a 503 with `Retry-After` (Sequential shedding load, or its database briefly unavailable: `503 overloaded`),
  waits for the server's `Retry-After` (at most 60 s each time), then sends the batch again. It keeps doing that for up
  to `maxRetryMs` (5 minutes) after the batch's first failure, then drops the batch. These waits do not use up
  `maxRetries`.
- Any other 5xx, or a network error, retries with backoff (at most 30 s between tries), `maxRetries` times.
- Any other 4xx (a revoked key, a refused body) drops the batch.
- Every event has a `uuid`. Sequential does not drop retried events as duplicates today, so a batch whose first attempt
  was stored (for example, the answer timed out) is stored again when the SDK sends it again.
- `track()` makes the event's JSON at once. A prop that JSON cannot hold (a `BigInt`, a circular object) drops the
  event: `track()` returns `false` and `stats.dropped_invalid` counts it. A later change to a prop object does not
  change the queued event.
- `sequential.stats` counts what was queued, sent, retried and dropped, with the reason.

## Limits

- 500 events per request and 1 MB per request. The SDK stays under both.
- 50 requests per second per key. Above it, the server answers 429 and the SDK waits.
- An event name is 1-200 characters and does not start with `$` (names with `$` are Sequential's own).
- Ids (`userId`, `accountId`, the context ids) are at most 200 characters. An event with a longer id is dropped (`invalid_event`).
- Your plan counts sessions. A server event never starts a session, so it does not add to your usage. When your
  project's plan stops ingest (HTTP 402), the SDK drops the batch (`client_error`).
- Server events are not page views, sessions or users: a person with only server events is not counted as a user.

## Privacy

- Server events store no browser, device, IP address, country or URL. Those would be your server's, shown as the
  user's.
- A server event never identifies a person. Only the browser's `identify()` links a visitor to a user.
- Send ids, enums and counts as properties. Do not send names, emails or free text.
- Some property names mean the text of a page element, in any case: for example `text`, `form`, `selector`,
  `element`, `element_text`, `aria_label`, and names that start with `$el_` or `$element`. In such a property,
  Sequential stores an email, a card number, a JWT or a Bearer or Basic credential as `[redacted]`. This is the same
  rule as for element text from the browser. Error messages are not in this rule.
- The cookie `__sq_ctx` is an analytics cookie. The browser SDK writes it only while it records: never while the
  visitor is opted out (`data-opt-out` or `optOut()`), and `optOut()` clears it. `reset()` replaces it with the new
  visitor and session. List it with your analytics cookies in your consent banner.
- The cookie holds the visitor id and the session id that the browser SDK already keeps. After `identify()`, the
  visitor id can be your user id. If your user ids are emails, the cookie holds an email.

## Command line

These commands moved to the Sequential CLI, `@usesequential/cli` (`npx @usesequential/cli`). They still work here and
print one line that says so. They leave this package in 2.0.

The package also installs a `sequential` command. It records a change on your project's Changes timeline, for
example from a deploy step:

```sh
npx -p @usesequential/node sequential changes record \
  --kind release --title "Checkout v2.14" --version web@2.14 \
  --pr https://github.com/acme/shop/pull/812
```

- The token is a project access token (`sq_pat_…`) with the `changes:write` scope, read from `SEQUENTIAL_TOKEN` only. It is never
  printed. A server key (`sqs_…`) sends events only and is refused.
- `--kind` is one of release, product, pricing, marketing, incident, company, external or tracking; `--title` is one
  line, at most 140 characters. `--external-id` makes a repeat find the same entry.
- A release recorded here is a Changes entry. To have Sequential verify fixes against it, also send the release
  marker (`POST /api/releases` with a `releases:write` token), for example with `sequential releases record`.
- `--dry-run` prints what would be sent and sends nothing. `sequential --help` lists every option.
- `sequential releases record --version web@2.14` posts that release marker: the version your app now runs, exactly
  as it sends it as its release, which fix verification measures against. It has its own token,
  `SEQUENTIAL_RELEASES_TOKEN`, a project access token (`sq_pat_…`) with the `releases:write` scope, so a deploy step needs no
  right to write the timeline. Options: `--environment`, `--commit-sha`, `--released-at`, `--finding F-12`
  (repeatable).
- The exit code is 0 when Sequential recorded it (or found it already recorded), 1 when it refused or could not be
  reached, and 2 for a mistake in the command.

In CI, record a run's changes in ONE request with `changes sync`, not `changes record` once per commit:

```sh
git log --format='%H%x09%s' "$BEFORE..$AFTER" | jq -Rn '[inputs | split("\t") | {kind: "product", title: .[1], external_id: .[0]}]' \
  | npx -p @usesequential/node sequential changes sync --items - --source git --covered-through "$(date -u +%FT%TZ)"
```

- `--items` is a file, or `-` for stdin, holding a JSON array of 1 to 100 changes, each with at least `kind` and
  `title` and any field of `changes record` in its JSON name (`external_id`, `links`, `start` …). More than 100 is
  refused: one run is one request, so split the range instead.
- `--source` names the source of every item that names none (default `ci`); `--covered-through` (with
  `--covered-from`) declares the range this run covers, so a stretch with no entries means nothing happened.
  `--atomic` writes nothing when any item is refused.
- It prints one line per item (its outcome, or why it was refused) and exits 0 when every item was written, 3 when
  some were refused, 1 when the run was refused or Sequential could not be reached, and 2 for a mistake in the
  command.

## License

MIT
