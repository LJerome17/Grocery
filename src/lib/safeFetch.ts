// Server-only fetch of a link typed by a visitor: public http(s) addresses only (no localhost, private or cloud
// metadata ranges, checked again at every redirect), with a time limit and a size cap.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 4;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    // IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::) addresses can reach IPv4 hosts: refused outright.
    if (/^::\d+\.\d+\.\d+\.\d+$/.test(v) || v.startsWith("64:ff9b:")) return true;
    return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

async function assertPublic(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Lien invalide : seules les adresses web sont acceptées.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Lien invalide.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateAddress)) throw new Error("Lien invalide.");
}

/** fetch() for visitor links; the body is cut at `maxBytes` (an error is thrown past it). */
export async function safeFetch(input: string, init: RequestInit = {}, maxBytes = 5_000_000): Promise<Response> {
  let url = new URL(input);
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      if (hop >= MAX_REDIRECTS) throw new Error("Trop de redirections.");
      url = new URL(next, url);
      continue;
    }
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new Error("Fichier trop volumineux.");
    const body = await res.arrayBuffer();
    if (body.byteLength > maxBytes) throw new Error("Fichier trop volumineux.");
    return new Response(body, { status: res.status, headers: res.headers });
  }
}
