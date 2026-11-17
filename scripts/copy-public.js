import { cpSync } from 'node:fs';

cpSync(
  new URL('../src/web/public/', import.meta.url),
  new URL('../dist/web/public/', import.meta.url),
  { recursive: true },
);
