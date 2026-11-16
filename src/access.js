// Who is asking. Cloudflare Access sits in front of littlefield.jay.systems and adds the
// signed-in user's email and a signed token to every request it lets through.
//
// When ACCESS_TEAM_DOMAIN (e.g. "yourteam.cloudflareaccess.com") and ACCESS_AUD (the
// application's Audience tag) are set, the token is verified, so a request that somehow
// skipped Access cannot spend the API budget. Without them, the email header is trusted:
// acceptable only because Access covers every address of this Worker.

const certCache = { url: null, keys: null, at: 0 };

export async function identify(request, env) {
  const email = request.headers.get('cf-access-authenticated-user-email');
  const token = request.headers.get('cf-access-jwt-assertion');
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    if (!token) return { ok: false, reason: 'No Cloudflare Access token.' };
    const claims = await verifyAccessJwt(token, env).catch(() => null);
    if (!claims) return { ok: false, reason: 'Cloudflare Access token did not verify.' };
    return { ok: true, email: claims.email || email || 'unknown', verified: true };
  }
  if (email) return { ok: true, email, verified: false };
  if (env.DEV_ALLOW_ANON === '1') return { ok: true, email: 'local-dev', verified: false };
  return { ok: false, reason: 'Not signed in through Cloudflare Access.' };
}

function b64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export async function verifyAccessJwt(token, env, now = Date.now() / 1000) {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new Error('malformed');
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (header.alg !== 'RS256') throw new Error('alg');
  const issuer = 'https://' + env.ACCESS_TEAM_DOMAIN.replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (claims.iss !== issuer) throw new Error('iss');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('aud');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('exp');
  const keys = await accessKeys(issuer + '/cdn-cgi/access/certs', env);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(h + '.' + p));
  if (!ok) throw new Error('sig');
  return claims;
}

async function accessKeys(url, env) {
  if (certCache.url === url && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await (env.ACCESS_FETCH || fetch)(url);
  if (!res.ok) throw new Error('certs ' + res.status);
  const { keys } = await res.json();
  Object.assign(certCache, { url, keys, at: Date.now() });
  return keys;
}
