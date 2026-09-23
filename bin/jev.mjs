#!/usr/bin/env node
// Entry point: runs the TypeScript CLI through Node's native type stripping.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { main } = await import(pathToFileURL(join(root, 'src/cli/main.ts')).href);
await main(process.argv.slice(2));
