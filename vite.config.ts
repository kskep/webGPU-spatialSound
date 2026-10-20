/**
 * Vite configuration. The only thing here is a development-only route for the validation listening
 * page (Task P): `/external-bras/...` serves files from the git-ignored folder `external/bras/`
 * (the measured BRAS impulse responses). `apply: 'serve'` keeps the plugin out of `vite build`, and
 * the page itself (`validation.html`) is not an entry of the build, so nothing from `external/`
 * reaches `dist/`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** URL prefix of the route and the folder it serves. */
const ROUTE = '/external-bras/';
const FOLDER = resolve('external/bras');

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/** Serves `external/bras` under `/external-bras/` in the dev server only; refuses paths outside the folder. */
function serveExternalBras(): Plugin {
  return {
    name: 'serve-external-bras',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? '';
        if (!url.startsWith(ROUTE)) return next();
        const relative = normalize(decodeURIComponent(url.slice(ROUTE.length).split('?')[0]));
        const file = join(FOLDER, relative);
        if (!file.startsWith(FOLDER + sep) || !existsSync(file) || !statSync(file).isFile()) {
          response.statusCode = 404;
          response.end('Not found. The BRAS data is only served by the dev server from external/bras.');
          return;
        }
        response.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
        createReadStream(file).pipe(response);
      });
    },
  };
}

export default defineConfig({ plugins: [serveExternalBras()] });
