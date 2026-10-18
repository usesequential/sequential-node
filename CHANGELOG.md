# Changelog

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
