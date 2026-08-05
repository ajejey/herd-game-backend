/**
 * Firebase Cloud Messaging sender, HTTP v1.
 *
 * Deliberately dependency-free. The legacy server-key API is retired, so v1
 * needs an OAuth2 access token from a service account — which is a signed JWT
 * exchanged for a bearer token. That is ~40 lines with node:crypto, and adding
 * firebase-admin (and its transitive tree) to a single-replica production
 * backend for one HTTP call is not a trade worth making.
 *
 * Config, from the service account JSON downloaded out of Firebase console
 * (Project settings -> Service accounts -> Generate new private key):
 *
 *   FCM_PROJECT_ID
 *   FCM_CLIENT_EMAIL
 *   FCM_PRIVATE_KEY     (paste whole key; literal \n sequences are handled)
 *
 * With none of these set, isConfigured() is false and every send is a no-op, so
 * the backend runs unchanged until you actually create the Firebase project.
 */
import crypto from 'crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function config() {
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  // Railway env vars keep newlines as the two characters \ and n.
  const privateKey = (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return { projectId, clientEmail, privateKey };
}

export function isConfigured() {
  const { projectId, clientEmail, privateKey } = config();
  return Boolean(projectId && clientEmail && privateKey);
}

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cachedToken = null; // { value, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const { clientEmail, privateKey } = config();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(privateKey).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM auth failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

/**
 * Send to one device token.
 * Returns { ok } or { ok: false, stale: true } when the token is dead, so the
 * caller can prune it — FCM tokens rotate and dead ones accumulate fast.
 */
export async function sendToToken(token, { title, body, route = '/daily', data = {} }) {
  if (!isConfigured()) return { ok: false, reason: 'not-configured' };

  const { projectId } = config();
  const auth = await accessToken();

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        // `data` is what the app reads on tap; keep the route here so the
        // client can deep link without parsing the notification text.
        data: { route, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
        android: {
          priority: 'HIGH',
          notification: { channel_id: 'herd_daily', icon: 'ic_stat_herd', color: '#3D8B5A' },
        },
      },
    }),
  });

  if (res.ok) return { ok: true };

  const text = await res.text();
  // UNREGISTERED / INVALID_ARGUMENT on the token means the install is gone.
  const stale = res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text);
  return { ok: false, stale, status: res.status, error: text.slice(0, 300) };
}
