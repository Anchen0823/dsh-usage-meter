import { defineConfig } from 'tsdown'

/**
 * Emit the plugin entry as a single ESM file. Host packages (`@deepseek-ai/*`)
 * and schemastery stay unbundled: at runtime the dsh installation that loads
 * this bundle provides them. The build deliberately skips type checking and
 * declaration emit so it can run standalone (devDependencies-free) as the
 * `prepare` hook for git-based installs.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  outDir: 'lib',
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'schemastery'],
  },
  dts: false,
  clean: true,
})
