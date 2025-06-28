import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        background: 'src/background.ts',
        popup: 'src/popup.ts',
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
        inlineDynamicImports: false,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
