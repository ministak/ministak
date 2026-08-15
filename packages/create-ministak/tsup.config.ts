import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'node22',
  clean: true,
  splitting: false,
  minify: false,
  sourcemap: false,
})
