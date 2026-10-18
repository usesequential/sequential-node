// @usesequential/node: send your backend's events and errors to Sequential, on the same person and browser session
// as that person's browser events. README.md has the guide.
export { SequentialServer, SequentialError, DEFAULT_HOST, SERVER_MAX_EVENTS } from './client';
export type { SequentialServerOptions, TrackInput, ErrorInput, HttpErrorInput, DropReason, SdkStats } from './client';
export { contextFromRequest, parseContext, encodeContext, CONTEXT_HEADER, CONTEXT_COOKIE } from './context';
export type { SequentialContext, RequestLike } from './context';
export { SDK_VERSION } from './version';
