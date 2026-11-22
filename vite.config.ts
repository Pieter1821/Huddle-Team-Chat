import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// One project, one deploy: the Cloudflare plugin runs the Worker (API, Durable Objects, D1, R2,
// queues) inside Vite's dev server, and builds the React app into the Worker's static assets.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // Port 8787 matches APP_URL in .dev.vars, so session cookies and the Origin check work locally.
  server: { port: 8787, strictPort: true },
  build: { sourcemap: true },
});
