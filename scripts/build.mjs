// Minimal, dependency-free "build": copies public/ (the actual source of
// truth for the web app) into dist/, which Capacitor packages into the
// native shells. No bundler — the app has no build-time dependencies today
// (Firebase is loaded straight from CDN URLs), so a real bundler would just
// be an elaborate copy step. Firebase Hosting keeps deploying from public/
// directly and is untouched by this.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src  = `${root}public`;
const dest = `${root}dist`;

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

console.log(`Built dist/ from public/ (${src} -> ${dest})`);
