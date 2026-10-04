/** Test-only HTTP fixture for the isolated guest modules, not a production server. */
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createGuestMeetings} from '../server/guest-meetings.mjs';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.PORT || 4178), origin = `http://127.0.0.1:${port}`;
const broker = createGuestMeetings({origin, createLimit: 100});
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};
const server = http.createServer(async (req, res) => {
  if (await broker.handle(req, res)) return;
  try {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, origin).pathname));
    if (!file.startsWith(root) || !['GET', 'HEAD'].includes(req.method)) throw new Error();
    const data = await readFile(file); res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Referrer-Policy': 'no-referrer'}); res.end(req.method === 'HEAD' ? '' : data);
  } catch {res.writeHead(404); res.end('Not found');}
});
server.listen(port, '127.0.0.1', () => console.log(`Guest test fixture: ${origin}`));
function close() {broker.close(); server.closeAllConnections(); server.close(() => process.exit(0));}
process.on('SIGTERM', close); process.on('SIGINT', close);
