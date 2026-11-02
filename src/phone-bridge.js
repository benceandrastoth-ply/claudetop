// Shares what Claude Code is doing with the claudetop Android app over the local network.
//
// - The phone finds this PC with a UDP broadcast ("claudetop?" on DISCOVERY_PORT) and pairs
//   with a 6-digit code shown on the PC: POST /pair { code, name } -> { token }.
// - It then follows GET /events (server-sent events, "Authorization: Bearer <token>").
// - Only hashes of the tokens are kept, in the app's config. Nothing runs unless a phone is
//   paired or the pairing dialog is open.

const crypto = require('crypto');
const dgram = require('dgram');
const http = require('http');
const os = require('os');

const HTTP_PORT = 47047;
const DISCOVERY_PORT = 47048;
const PAIR_TRIES = 5; // wrong codes before the pairing code stops working
const PING_MS = 20 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// This PC's LAN addresses, for the pairing dialog (and for typing in by hand).
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

// phones(): [{ id, name, tokenHash, added }]; setPhones(list) saves them.
// snapshot(): the JSON the phone gets ({ sessions, focus }).
function createBridge({ pcId, phones, setPhones, snapshot, onPaired, log = () => {} }) {
  let server = null;
  let udp = null;
  let pairing = null; // { code, tries }
  const clients = new Set(); // open /events responses
  let lastSent = '';

  const wanted = () => phones().length > 0 || !!pairing;

  function phoneFor(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const hash = Buffer.from(sha256(m[1]), 'hex');
    return phones().find((p) => {
      const known = Buffer.from(p.tokenHash, 'hex');
      return known.length === hash.length && crypto.timingSafeEqual(known, hash);
    }) || null;
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        data += c;
        if (data.length > 4096) req.destroy();
      });
      req.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/hello') {
      return send(res, 200, { app: 'claudetop', id: pcId, name: os.hostname(), pairing: !!pairing });
    }
    if (req.method === 'POST' && url.pathname === '/pair') {
      const body = await readBody(req);
      if (!pairing) return send(res, 403, { error: 'not-pairing' });
      if (String(body.code || '').replace(/\D/g, '') !== pairing.code) {
        pairing.tries++;
        if (pairing.tries >= PAIR_TRIES) pairing.code = null; // burnt: open the dialog again
        return send(res, 403, { error: pairing.code ? 'wrong-code' : 'too-many-tries' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const phone = {
        id: crypto.randomBytes(6).toString('hex'),
        name: String(body.name || 'Phone').slice(0, 60),
        tokenHash: sha256(token),
        added: Date.now(),
      };
      setPhones([...phones(), phone]);
      pairing = null;
      send(res, 200, { token, id: pcId, name: os.hostname() });
      onPaired(phone);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const phone = phoneFor(req);
      if (!phone) return send(res, 401, { error: 'unknown-phone' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${lastSent || JSON.stringify(snapshot())}\n\n`);
      const client = { res, phoneId: phone.id };
      clients.add(client);
      req.on('close', () => clients.delete(client));
      return;
    }
    send(res, 404, { error: 'not-found' });
  }

  function startServer() {
    if (server) return;
    server = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        try { send(res, 500, { error: 'oops' }); } catch {}
      });
    });
    server.keepAliveTimeout = 0;
    server.on('error', (e) => {
      log(`phone bridge: ${e.message}`);
      server = null;
    });
    server.listen(HTTP_PORT, '0.0.0.0');

    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      if (msg.toString('utf8').trim() !== 'claudetop?') return;
      const reply = JSON.stringify({ app: 'claudetop', id: pcId, name: os.hostname(), port: HTTP_PORT, pairing: !!pairing });
      udp.send(reply, rinfo.port, rinfo.address);
    });
    udp.on('error', (e) => {
      log(`phone discovery: ${e.message}`);
      try { udp.close(); } catch {}
      udp = null;
    });
    udp.bind(DISCOVERY_PORT, '0.0.0.0');
  }

  function stopServer() {
    for (const c of clients) c.res.end();
    clients.clear();
    if (server) server.close();
    server = null;
    if (udp) try { udp.close(); } catch {}
    udp = null;
  }

  // Start or stop to match: running while there's a paired phone or pairing is open.
  function refresh() {
    if (wanted()) startServer();
    else stopServer();
    // A forgotten phone gets cut off straight away.
    const ids = new Set(phones().map((p) => p.id));
    for (const c of [...clients]) {
      if (!ids.has(c.phoneId)) {
        c.res.end();
        clients.delete(c);
      }
    }
  }

  function update() {
    if (!clients.size) {
      lastSent = '';
      return;
    }
    const json = JSON.stringify(snapshot());
    if (json === lastSent) return;
    lastSent = json;
    for (const c of clients) c.res.write(`event: state\ndata: ${json}\n\n`);
  }

  setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
  }, PING_MS).unref();

  return {
    refresh,
    update,
    startPairing() {
      pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), tries: 0 };
      refresh();
      return { code: pairing.code, addresses: lanAddresses(), port: HTTP_PORT, name: os.hostname() };
    },
    stopPairing() {
      pairing = null;
      refresh();
    },
    stop: stopServer,
  };
}

module.exports = { createBridge, HTTP_PORT, DISCOVERY_PORT };
