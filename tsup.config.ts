import { defineConfig } from 'tsup';

export default defineConfig({
  // run_jobs is the Railway cron service's entry; see scripts/run_jobs.ts.
  entry: { index: 'src/index.ts', run_jobs: 'scripts/run_jobs.ts' },
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
