// TCP forwarder: 0.0.0.0:FORWARD_PORT -> 127.0.0.1:DASHBOARD_PORT (run with node).
//
// The Worker reaches the container over its network interface, but the wilson
// dashboard refuses to bind a non-loopback address without dashboard auth (its
// LAN-mode guard). Keeping wilson on 127.0.0.1 and forwarding raw bytes means the
// dashboard runs exactly as on a laptop. The Host header passes through, so
// WILSON_DASHBOARD_ALLOWED_HOSTS must list the public dashboard hostname.
// stream.pipe() handles backpressure (the dashboard page is a ~3 MB single file).
import net from 'node:net';

const listenPort = Number(process.env.FORWARD_PORT ?? 8124);
const targetPort = Number(process.env.DASHBOARD_PORT ?? 8123);

net.createServer((client) => {
  const upstream = net.connect(targetPort, '127.0.0.1');
  client.pipe(upstream);
  upstream.pipe(client);
  const kill = () => { client.destroy(); upstream.destroy(); };
  client.on('error', kill);
  upstream.on('error', kill);
}).listen(listenPort, '0.0.0.0', () => console.log(`[forward] 0.0.0.0:${listenPort} -> 127.0.0.1:${targetPort}`));
