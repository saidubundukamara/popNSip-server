import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Bundling is what resolves the `@/*` alias; dependencies stay external.
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
});
