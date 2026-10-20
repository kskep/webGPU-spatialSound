import { mkdir, readdir, copyFile } from 'node:fs/promises';
const source = new URL('../src/audio/dsp/', import.meta.url),
  destination = new URL('../public/audio-worklets/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of await readdir(source))
  if (name.endsWith('.mjs')) await copyFile(new URL(name, source), new URL(name, destination));
