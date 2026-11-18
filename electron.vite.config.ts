import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

// The production CSP lives in index.html. The dev server needs inline scripts
// (React refresh preamble), injected <style> tags and a websocket for HMR, so
// the policy is relaxed for `npm run dev` only (spec section 5).
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; " +
  "object-src 'none'; base-uri 'none'; frame-src 'none'";

function devCsp(): Plugin {
  return {
    name: 'relay-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/, `$1${DEV_CSP}$2`);
    },
  };
}

// Records which npm packages were compiled into the renderer, for the licence notices.
function recordBundledPackages(): Plugin {
  return {
    name: 'relay-bundled-packages',
    apply: 'build',
    generateBundle() {
      const found = new Set<string>();
      for (const id of this.getModuleIds()) {
        const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id.replace(/^\0+/, '').split('?')[0]);
        if (m) found.add(relative(__dirname, m[1]).replace(/\\/g, '/'));
      }
      mkdirSync(resolve(__dirname, 'out'), { recursive: true });
      writeFileSync(resolve(__dirname, 'out/.bundled-packages.json'), JSON.stringify([...found].sort(), null, 1));
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    resolve: { alias },
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss(), devCsp(), recordBundledPackages()],
    // No inlined data: assets, so the production CSP can stay strict (font-src 'self').
    build: { assetsInlineLimit: 0, rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
