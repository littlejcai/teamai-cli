import { defineConfig } from 'tsup';

// [teamai-desktop] Two bundles:
//  1. src/index.ts       -> dist/index.js        (CLI, shebang kept)
//  2. src/desktop-api.ts -> dist/desktop-api.js  (library entry for GUI clients,
//     no shebang, ships .d.ts; importing it must never execute the CLI)
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    outDir: 'dist',
    clean: true,
    splitting: false,
    sourcemap: true,
    dts: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: ['src/desktop-api.ts'],
    format: ['esm'],
    target: 'node20',
    outDir: 'dist',
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: true,
  },
]);
