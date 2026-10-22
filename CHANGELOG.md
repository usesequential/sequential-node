# Changelog

## 1.0.3

- A 503 with `Retry-After` (`503 overloaded`: Sequential shedding load, or its database briefly unavailable) now waits
  for it, at most 60 s each time, like a 429. Before, it retried within about 1.5 s and dropped the batch.
- New option `maxRetryMs` (default 300,000): a batch is held while the server answers 429 or 503 with `Retry-After`, up
  to 5 minutes after its first failure. Those waits no longer use up `maxRetries`, which now counts only the retries of
  a 5xx or a network error without `Retry-After` (default 3, as before).
- README: a batch whose first attempt was stored is stored again on a retry (the server does not deduplicate retries
  today).

## 1.0.2

- README: for Hono, pass `c.req.raw` to `contextFromRequest`.
- README: in the first minute after a visitor signs in, a server event with their `userId` can stay out of the session.
- No change to the code's behaviour.

## 1.0.1

- package.json names the source repository (github.com/usesequential/sequential-node) and its issue tracker.
- No change to the code's behaviour.

## 1.0.0

- First release: `SequentialServer` (`track`, `captureError`, `captureHttpError`, `flush`, `shutdown`, `stats`),
  `contextFromRequest`, `parseContext`, `encodeContext`.
