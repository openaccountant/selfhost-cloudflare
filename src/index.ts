/**
 * Open Accountant (wilson) on your own Cloudflare account.
 *
 * ONE persistent sandbox for ONE owner. Your data dir (~/.openaccountant) is snapshotted
 * to YOUR R2 bucket (every SNAPSHOT_EVERY_MIN while running, and before the container
 * sleeps) and restored when the container boots.
 *
 * Fail-closed auth: every request must carry a valid Cloudflare Access JWT
 * (Cf-Access-Jwt-Assertion) for ACCESS_TEAM_DOMAIN + ACCESS_AUD. If either is unset, or the
 * token is missing/invalid, the Worker refuses to serve anything but a setup page.
 *
 * Routes:
 *   /_oa/            terminal page (xterm.js)
 *   /_oa/api/*       status, manual snapshot, terminal WebSocket
 *   everything else  the real wilson dashboard, proxied into the sandbox
 */

import { getSandbox, proxyToSandbox, Sandbox as BaseSandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<OwnerSandbox>;
  DATA: R2Bucket;
  ASSETS: Fetcher;
  /** e.g. "yourteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's Audience (AUD) tag. */
  ACCESS_AUD?: string;
  SNAPSHOT_EVERY_MIN?: string;
  IDLE_SLEEP?: string;
  KEEP_SNAPSHOTS?: string;
  /** Optional: passed into the sandbox so wilson can use a cloud model. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

const SANDBOX_ID = "owner";
const DASHBOARD_PORT = 8123;
const FORWARD_PORT = 8124;
const RESTORED = "/tmp/.oa-restored"; // data dir restored from R2 (or confirmed fresh) in this container
const READY = "/tmp/.oa-ready"; // dashboard + forwarder running
const SNAP_TMP = "/tmp/oa-snapshot.tgz";
const LATEST = "snapshots/latest.tgz";

// ── The owner's sandbox ───────────────────────────────────────────────────────

export class OwnerSandbox extends BaseSandbox<Env> {
  /** In-memory fast path so dashboard requests don't pay an exec round trip. */
  private ready = false;

  override async onStart(): Promise<void> {
    this.ready = false;
    await super.onStart();
    await this.schedule(this.everySec(), "periodicSnapshot");
  }

  private everySec(): number {
    return Math.max(2, Number(this.env.SNAPSHOT_EVERY_MIN ?? 10)) * 60;
  }

  async periodicSnapshot(): Promise<void> {
    try { await this.snapshot("interval"); } catch (e) { console.error(JSON.stringify({ msg: "snapshot_failed", err: String(e) })); }
    await this.schedule(this.everySec(), "periodicSnapshot");
  }

  /** Snapshot right before the idle sleep stops the container (its disk is ephemeral). */
  override async onActivityExpired(): Promise<void> {
    try { await this.snapshot("idle"); } catch (e) { console.error(JSON.stringify({ msg: "snapshot_failed", err: String(e) })); }
    await super.onActivityExpired();
  }

  /** Tar the data dir inside the container and store it in R2. Returns the object key. */
  async snapshot(reason: string): Promise<string | null> {
    const restored = await this.exec(`test -f ${RESTORED}`);
    if (restored.exitCode !== 0) return null; // never overwrite R2 with an un-restored, empty dir
    const r = await this.exec(`bash /opt/oa/snapshot.sh ${SNAP_TMP}`, { timeout: 120_000 });
    if (r.exitCode === 3) return null;
    if (!r.success) throw new Error(`snapshot.sh failed: ${r.stderr.slice(-300)}`);
    const file = await this.readFile(SNAP_TMP, { encoding: "base64" });
    const bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
    const key = `snapshots/${new Date().toISOString().replace(/[:.]/g, "-")}.tgz`;
    const meta = { customMetadata: { reason, bytes: String(bytes.length) } };
    await this.env.DATA.put(key, bytes, meta);
    await this.env.DATA.put(LATEST, bytes, meta);
    await this.exec(`rm -f ${SNAP_TMP}`);
    await this.prune();
    console.log(JSON.stringify({ msg: "snapshot", key, bytes: bytes.length, reason }));
    return key;
  }

  private async prune(): Promise<void> {
    const keep = Math.max(1, Number(this.env.KEEP_SNAPSHOTS ?? 48));
    const listed = await this.env.DATA.list({ prefix: "snapshots/2" });
    const keys = listed.objects.map((o) => o.key).sort();
    const drop = keys.slice(0, Math.max(0, keys.length - keep));
    if (drop.length) await this.env.DATA.delete(drop);
  }

  /** Restore the latest snapshot (if any), then start the dashboard. Idempotent per container. */
  async boot(): Promise<{ restored: boolean }> {
    if (this.ready) return { restored: false };
    const state = await this.exec(`test -f ${READY} && echo ready || (test -f ${RESTORED} && echo restored || echo empty)`);
    const st = state.stdout.trim();
    if (st === "ready") { this.ready = true; return { restored: false }; }

    let restored = false;
    const obj = st === "empty" ? await this.env.DATA.get(LATEST) : null;
    if (obj) {
      const buf = new Uint8Array(await obj.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await this.writeFile(SNAP_TMP, btoa(bin), { encoding: "base64" });
      const x = await this.exec(`mkdir -p /root && tar xzf ${SNAP_TMP} -C /root && rm -f ${SNAP_TMP}`);
      if (!x.success) throw new Error(`restore failed: ${x.stderr.slice(-300)}`);
      restored = true;
    }
    await this.exec(`touch ${RESTORED}`);

    const env: Record<string, string> = {};
    if (this.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
    if (this.env.OPENAI_API_KEY) env.OPENAI_API_KEY = this.env.OPENAI_API_KEY;
    const host = await this.ctx.storage.get<string>("host");
    if (host) {
      env.WILSON_DASHBOARD_ALLOWED_HOSTS = host;
      env.WILSON_DASHBOARD_ALLOWED_ORIGINS = `https://${host}`;
    }
    const dash = await this.startProcess(`wilson --dashboard --port ${DASHBOARD_PORT}`, { env });
    const fwd = await this.startProcess("node /opt/oa/dash-forward.mjs", {
      env: { FORWARD_PORT: String(FORWARD_PORT), DASHBOARD_PORT: String(DASHBOARD_PORT) },
    });
    await dash.waitForPort(DASHBOARD_PORT, { mode: "tcp", timeout: 90_000 });
    await fwd.waitForPort(FORWARD_PORT, { mode: "tcp", timeout: 15_000 });
    await this.exec(`touch ${READY}`);
    this.ready = true;
    console.log(JSON.stringify({ msg: "booted", restored }));
    return { restored };
  }

  /**
   * wilson only answers Host headers it was told about. If the Worker is reached on a new
   * hostname (workers.dev first, a custom domain later), restart just the dashboard with it.
   * Data is untouched: the restore marker stays, so nothing is re-restored over live data.
   */
  async rememberHost(host: string): Promise<void> {
    if ((await this.ctx.storage.get("host")) === host) return;
    await this.ctx.storage.put("host", host);
    if (this.ready) {
      // rm first; the [x] pattern keeps pkill from matching the shell running this line.
      await this.exec(`rm -f ${READY}; pkill -f -- '[-]-dashboard --port ${DASHBOARD_PORT}'; pkill -f '[d]ash-forward.mjs'; sleep 1`);
      this.ready = false;
    }
  }
}

const owner = (env: Env) => getSandbox(env.Sandbox, SANDBOX_ID, { sleepAfter: env.IDLE_SLEEP ?? "30m" });

// ── Cloudflare Access verification (fail closed) ─────────────────────────────

type Jwk = JsonWebKey & { kid: string };
let jwksCache: { at: number; team: string; keys: Jwk[] } | null = null;

async function accessKeys(team: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.team === team && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), team, keys };
  return keys;
}

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

export async function verifyAccess(request: Request, env: Env): Promise<{ ok: true; email?: string } | { ok: false; why: string }> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) return { ok: false, why: "not_configured" };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, why: "no_token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, why: "malformed" };
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { kid?: string; alg?: string };
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
    if (header.alg !== "RS256") return { ok: false, why: "alg" };
    const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, why: "kid" };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return { ok: false, why: "signature" };
    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return { ok: false, why: "aud" };
    if (payload.iss !== `https://${team}`) return { ok: false, why: "iss" };
    if (!payload.exp || payload.exp < now - 30) return { ok: false, why: "expired" };
    if (payload.nbf && payload.nbf > now + 30) return { ok: false, why: "nbf" };
    return { ok: true, email: payload.email };
  } catch {
    return { ok: false, why: "invalid" };
  }
}

function refuse(why: string): Response {
  const setup = why === "not_configured";
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Locked</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<body style="margin:0;background:#f8f9ed;color:#20251f;font:16px/1.6 'DM Sans',system-ui,sans-serif"><div style="max-width:36rem;margin:10vh auto;padding:0 16px">
<h1 style="font:400 44px/1.05 'Instrument Serif',Georgia,serif;letter-spacing:-.025em;margin:0 0 16px">Open Accountant is <em>locked.</em></h1>
${setup
  ? `<p>This Worker refuses to serve until it is protected by <strong>Cloudflare Access</strong>. Your financial data would otherwise be on the open internet.</p>
<ol style="color:#5b6057"><li>Zero Trust → Access → Applications → add a <em>self-hosted</em> app for this Worker's hostname.</li>
<li>Add a policy that allows only your email.</li>
<li>Copy the app's <strong>Audience (AUD) tag</strong> and your team domain (<code>yourteam.cloudflareaccess.com</code>).</li>
<li>Set them as Worker variables <code>ACCESS_AUD</code> and <code>ACCESS_TEAM_DOMAIN</code>, then reload.</li></ol>`
  : `<p style="color:#5b6057">Sign in through Cloudflare Access to continue. (Reason: <code>${why}</code>.)</p>`}
<p><a style="color:#176b36" href="https://docs.openaccountant.ai/getting-started/self-host-cloudflare/">Setup guide</a></p></div>`;
  return new Response(body, { status: setup ? 503 : 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// ── Worker ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = await verifyAccess(request, env);
    if (!auth.ok) return refuse(auth.why);

    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);
    const sb = owner(env);
    await sb.rememberHost(url.host);

    if (url.pathname === "/_oa") return Response.redirect(new URL("/_oa/", url).toString(), 302);

    if (url.pathname === "/_oa/api/status") {
      const latest = await env.DATA.head(LATEST);
      return json({ user: auth.email ?? null, latestSnapshot: latest ? { uploaded: latest.uploaded, bytes: latest.size } : null });
    }

    if (url.pathname === "/_oa/api/snapshot" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
      await sb.boot();
      return json({ key: await sb.snapshot("manual") });
    }

    if (url.pathname === "/_oa/api/terminal") {
      if (request.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
      await sb.boot();
      let session;
      try { session = await sb.getSession("term"); } catch { session = await sb.createSession({ id: "term", cwd: "/root", env: { HOME: "/root", TERM: "xterm-256color" } }); }
      return session.terminal(request, { cols: 100, rows: 30, shell: "/bin/bash" });
    }

    if (url.pathname.startsWith("/_oa/")) return env.ASSETS.fetch(request);

    // The real wilson dashboard.
    await sb.boot();
    const res = await sb.containerFetch(request, FORWARD_PORT);
    if (res.status === 101) return res;
    const out = new Response(res.body, res);
    if (url.pathname.startsWith("/api/") && !out.headers.has("cache-control")) out.headers.set("cache-control", "no-store");
    return out;
  },
} satisfies ExportedHandler<Env>;
