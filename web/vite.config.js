import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        drafting: fileURLToPath(new URL('./drafting.html', import.meta.url)),
        plate: fileURLToPath(new URL('./plate.html', import.meta.url)),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three') || id.includes('node_modules\\three')) {
            return 'three';
          }
          return undefined;
        },
      },
    },
  },
});
