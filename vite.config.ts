import { readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** The artifact host serves a fixed list of web file types, so binary data ships as .wasm in dist/. */
function binToWasm(): Plugin {
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.bin')) renameSync(p, p.slice(0, -4) + '.wasm');
    }
  };
  return { name: 'bin-to-wasm', apply: 'build', closeBundle: () => walk('dist') };
}

export default defineConfig({
  plugins: [viteSingleFile(), binToWasm()],
  build: { target: 'es2022', assetsInlineLimit: 100000000, chunkSizeWarningLimit: 4000 },
});
