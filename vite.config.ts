// Bundles the CLI into dist/cli.js
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const ENTRY = "dist/cli.js";

/** A CLI has to be executable and has to say what runs it. */
function executableEntry(): Plugin {
  return {
    name: "seu:executable-entry",
    renderChunk(code, chunk) {
      return chunk.isEntry ? { code: `#!/usr/bin/env node\n${code}`, map: null } : null;
    },
    closeBundle() {
      // npm sets the bit itself on install; this is for `./dist/cli.js` in a
      // checkout.
      try {
        chmodSync(resolve(ENTRY), 0o755);
      } catch {
        /* the entry is not there when another build failed first */
      }
    },
  };
}

export default defineConfig({
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    ssr: "src/cli.ts",
    rollupOptions: {
      external: [/^node:/, "microsandbox"],
      output: {
        format: "esm",
        entryFileNames: "cli.js",
      },
    },
  },
  ssr: {
    noExternal: ["zod"],
  },
  plugins: [executableEntry()],
});
