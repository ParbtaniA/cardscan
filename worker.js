// CardScan auth + API proxy
// Holds all secrets server-side. Employees never see an API key.
//
// Required bindings:
//   KV namespace:  KV
//   Secrets:       AIRTABLE_TOKEN, ANTHROPIC_KEY, JWT_SECRET, BOOTSTRAP_SECRET
//   Vars:          APP_URL   (e.g. https://contacts.venzaura.com)

const BASE_ID  = 'appNWqtWKEQaVa97F';
const TABLE_ID = 'tbl20LKbf0JODZE9h';
const AT = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;  // invite links die after 48h
const DAILY_SCAN_CAP = 100;                  // per user, per day

// ─────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────
const enc = new TextEncoder();

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, unb64url(sig), enc.encode(body));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(unb64url(body)));
  } catch { return null; }
}

function randomId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return prefix + b64url(b).slice(0, 22);
}

// ─────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const fail = (msg, status = 400) => json({ error: msg }, status);

// ─────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────
async function currentUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const claims = await verifyToken(token, env.JWT_SECRET);
  if (!claims?.uid) return null;

  // Live KV lookup means revocation is instant
  const raw = await env.KV.get(`user:${claims.uid}`);
  if (!raw) return null;
  const user = JSON.parse(raw);
  if (!user.active) return null;
  return user;
}

async function saveUser(env, user) {
  await env.KV.put(`user:${user.uid}`, JSON.stringify(user));
}

// ─────────────────────────────────────────────
// Airtable
// ─────────────────────────────────────────────
async function airtable(env, path, init = {}) {
  const res = await fetch(AT + path, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // ── Bootstrap: create the root admin. Run once, then rotate BOOTSTRAP_SECRET.
      if (path === '/auth/bootstrap' && request.method === 'POST') {
        const { secret, name } = await request.json();
        if (secret !== env.BOOTSTRAP_SECRET) return fail('Bad secret', 403);
        if (await env.KV.get('root_created')) return fail('Already bootstrapped', 409);

        // Mint a single-use, admin-granting invite. Same claim flow as everyone else,
        // so the session is created on the owner's own device and the link burns on use.
        const inviteTok = randomId('inv_');
        await env.KV.put(`invite:${inviteTok}`, JSON.stringify({
          createdBy: null,
          createdByName: null,
          grantsAdmin: true,
          createdAt: new Date().toISOString(),
        }), { expirationTtl: INVITE_TTL_MS / 1000 });

        return json({ url: `${env.APP_URL}?invite=${inviteTok}` });
      }

      // ── Claim an invite: burns the token, creates the user, returns a session
      if (path === '/auth/claim' && request.method === 'POST') {
        const { invite, name } = await request.json();
        if (!name || !name.trim()) return fail('Name required');

        const raw = await env.KV.get(`invite:${invite}`);
        if (!raw) return fail('This invite link is invalid or has already been used', 403);

        const inv = JSON.parse(raw);
        if (Date.now() - new Date(inv.createdAt).getTime() > INVITE_TTL_MS) {
          await env.KV.delete(`invite:${invite}`);
          return fail('This invite link has expired', 403);
        }

        // Burn it — single use
        await env.KV.delete(`invite:${invite}`);

        let user;
        if (inv.restoreUid) {
          // Re-issued link: step back into the existing identity so past contacts still belong to them
          const existing = await env.KV.get(`user:${inv.restoreUid}`);
          if (!existing) return fail('That account no longer exists', 404);
          user = JSON.parse(existing);
          user.active = true;
          if (name.trim()) user.name = name.trim();
          user.restoredAt = new Date().toISOString();
        } else {
          user = {
            uid: randomId('usr_'),
            name: name.trim(),
            admin: !!inv.grantsAdmin,
            active: true,
            invitedBy: inv.createdBy,
            invitedByName: inv.createdByName,
            createdAt: new Date().toISOString(),
          };
          if (inv.grantsAdmin) await env.KV.put('root_created', user.uid);
          if (inv.createdBy) await env.KV.put(`child:${inv.createdBy}:${user.uid}`, '1');
        }
        await saveUser(env, user);

        const token = await signToken({ uid: user.uid }, env.JWT_SECRET);
        return json({ token, user });
      }

      // ── Everything below needs a session
      const me = await currentUser(request, env);

      if (path === '/auth/me' && request.method === 'GET') {
        if (!me) return fail('Not signed in', 401);
        return json({ user: me });
      }

      // ── Generate an invite link
      if (path === '/auth/invite' && request.method === 'POST') {
        if (!me) return fail('Not signed in', 401);
        const token = randomId('inv_');
        await env.KV.put(`invite:${token}`, JSON.stringify({
          createdBy: me.uid,
          createdByName: me.name,
          createdAt: new Date().toISOString(),
        }), { expirationTtl: INVITE_TTL_MS / 1000 });

        return json({
          url: `${env.APP_URL}?invite=${token}`,
          expiresInHours: INVITE_TTL_MS / 3600000,
        });
      }

      // ── Card scan proxy (Anthropic key never leaves the Worker)
      if (path === '/api/scan' && request.method === 'POST') {
        if (!me) return fail('Not signed in', 401);

        // Daily cap
        const today = new Date().toISOString().slice(0, 10);
        const capKey = `scans:${me.uid}:${today}`;
        const used = parseInt(await env.KV.get(capKey) || '0', 10);
        if (used >= DAILY_SCAN_CAP) return fail('Daily scan limit reached', 429);
        await env.KV.put(capKey, String(used + 1), { expirationTtl: 172800 });

        const { image } = await request.json();
        if (!image) return fail('No image');

        const prompt = `Extract structured contact data from this business card image. Return ONLY valid JSON, nothing else:
{"name":"full name or null","title":"job title or null","company":"company name or null","email":["email1"] or [],"email2":"second email or null","phone":"digits and dashes only no country code or null","phone2":"second phone or null","website":"url or null","linkedin":"linkedin url or null","address":"address or null","other":"any extra info or null"}`;

        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
                { type: 'text', text: prompt },
              ],
            }],
          }),
        });
        const data = await aiRes.json();
        if (!aiRes.ok) return fail('Scan failed', 502);

        const text = (data.content || []).map(b => b.text || '').join('');
        try {
          return json({ parsed: JSON.parse(text.replace(/```json|```/g, '').trim()) });
        } catch {
          return fail('Could not read that card — try a clearer photo', 422);
        }
      }

      // ── List contacts: yours only, unless you're the admin
      if (path === '/api/contacts' && request.method === 'GET') {
        if (!me) return fail('Not signed in', 401);

        let q = '?sort%5B0%5D%5Bfield%5D=Date%20Scanned&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=200';
        if (!me.admin) {
          q += `&filterByFormula=${encodeURIComponent(`{Collector ID} = '${me.uid}'`)}`;
        }
        const data = await airtable(env, q);
        return json({
          records: (data.records || []).map(r => ({ _id: r.id, ...r.fields })),
          admin: !!me.admin,
        });
      }

      // ── Create a contact: collector is stamped server-side, never trusted from the client
      if (path === '/api/contacts' && request.method === 'POST') {
        if (!me) return fail('Not signed in', 401);
        const { fields } = await request.json();

        const clean = { ...(fields || {}) };
        delete clean['Collector ID'];
        delete clean['Collected By'];
        delete clean['Invited By'];

        clean['Collector ID'] = me.uid;
        clean['Collected By'] = me.name;
        clean['Invited By']   = me.invitedByName || '';
        clean['Date Scanned'] = new Date().toISOString();

        const created = await airtable(env, '', {
          method: 'POST',
          body: JSON.stringify({ fields: clean }),
        });
        return json({ id: created.id, fields: created.fields });
      }

      // ── Delete a contact: only your own, unless admin
      if (path.startsWith('/api/contacts/') && request.method === 'DELETE') {
        if (!me) return fail('Not signed in', 401);
        const id = path.split('/').pop();

        const rec = await airtable(env, `/${id}`);
        if (!me.admin && rec.fields['Collector ID'] !== me.uid) {
          return fail('Not your contact', 403);
        }
        await airtable(env, `/${id}`, { method: 'DELETE' });
        return json({ deleted: true });
      }

      // ── Admin: list everyone
      if (path === '/admin/users' && request.method === 'GET') {
        if (!me?.admin) return fail('Admin only', 403);
        const list = await env.KV.list({ prefix: 'user:' });
        const users = [];
        for (const k of list.keys) {
          const u = JSON.parse(await env.KV.get(k.name));
          users.push({ uid: u.uid, name: u.name, active: u.active, admin: u.admin, invitedByName: u.invitedByName, createdAt: u.createdAt });
        }
        return json({ users });
      }

      // ── Admin: re-issue access to someone who lost their session
      if (path === '/admin/reinvite' && request.method === 'POST') {
        if (!me?.admin) return fail('Admin only', 403);
        const { uid } = await request.json();
        const raw = await env.KV.get(`user:${uid}`);
        if (!raw) return fail('No such user', 404);
        const target = JSON.parse(raw);

        const tok = randomId('inv_');
        await env.KV.put(`invite:${tok}`, JSON.stringify({
          restoreUid: uid,
          createdBy: me.uid,
          createdByName: me.name,
          createdAt: new Date().toISOString(),
        }), { expirationTtl: INVITE_TTL_MS / 1000 });

        return json({ url: `${env.APP_URL}?invite=${tok}`, name: target.name, restore: true });
      }

      // ── Admin: kill switch
      if (path === '/admin/revoke' && request.method === 'POST') {
        if (!me?.admin) return fail('Admin only', 403);
        const { uid, active } = await request.json();
        const raw = await env.KV.get(`user:${uid}`);
        if (!raw) return fail('No such user', 404);
        const u = JSON.parse(raw);
        if (u.admin) return fail('Cannot revoke an admin', 400);
        u.active = active !== false ? true : false;
        await saveUser(env, u);
        return json({ user: u });
      }

      return fail('Not found', 404);

    } catch (err) {
      return fail('Server error: ' + err.message, 500);
    }
  },
};
