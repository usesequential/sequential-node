#!/usr/bin/env node
// The `sequential` executable (package.json "bin"): runs cli.ts with this process's arguments and environment.
import { readFile } from 'node:fs/promises';
import { main } from './cli';

/** A file's text, or all of stdin for '-' (changes sync --items -). */
async function readText(path: string): Promise<string> {
    if (path !== '-') return readFile(path, 'utf8');
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return Buffer.concat(chunks).toString('utf8');
}

main(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l), fetch: globalThis.fetch, readText }).then(
    (code) => {
        process.exitCode = code;
    },
    () => {
        console.error('sequential: an unexpected error');
        process.exitCode = 1;
    }
);
