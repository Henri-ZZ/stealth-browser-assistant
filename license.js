// License activation & verification for Stealth Browser Assistant.
//
// Talks to the Licentra backend and verifies its ECDSA P-256 signed response
// locally with the embedded public key (assets/public_key). Interface per the
// Licentra docs — see licentra/src/app/api/EXTERNAL.md:
//
//   POST /api/license/activate   { key, fingerprint, label }   -> { valid, payload, signature }
//   POST /api/license/check-in   { key, fingerprint }          -> { valid, payload, signature }
//
// Signature = ECDSA P-256 over JSON.stringify(payload), SHA-256, DER-encoded,
// base64. Payload key order is frozen server-side (product → plan → license_id →
// license_expires_at → valid_until); we re-stringify the exact parsed object so
// the bytes match. WebCrypto only accepts raw r‖s (P1363) signatures, so the DER
// blob is converted first.

import { STORAGE_KEYS, getState, setState } from './shared.js';

export const LICENTRA_BASE_URL = 'https://licentra.henri.ren';
export const PRODUCT_SLUG = 'stealth-browser-assistant';

// ───────────────────────── offline grace window ─────────────────────────
//
// When check-in fails because Licentra is unreachable (network error, 5xx,
// rate-limited, non-JSON body), the client may keep premium active for a
// limited offline window instead of locking the user out mid-failure.
// Rules (user-confirmed):
//   - each failed check-in extends validUntil by GRACE_STEP_MS (30 min);
//   - the extension may never push validUntil past graceUntil;
//   - graceUntil = last successful verify + GRACE_WINDOW_MS (48 h);
//   - once now >= graceUntil the license is treated as offline-expired and
//     the UI shows an explicit error (reason `grace_exhausted`).
// Server-side denials (revoked / refunded / …) NEVER get grace.
const GRACE_STEP_MS = 30 * 60 * 1000; // 30 minutes per failed check-in
const GRACE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h total from last success

// ECDSA P-256 public key (SPKI PEM) for PRODUCT_SLUG. From assets/public_key.
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQsObNhyvBIqD/EmGsElYA0NsM0BV
p6GbWoIHsl0wV2wIq0bCjLdSGQb7A7ZCZsd05sG3doFkBxaKXfjsA8kQuQ==
-----END PUBLIC KEY-----`;

// License-key format: ABCD-2345-EFGH-6789 (16 chars, 32-symbol alphabet).
const KEY_REGEX = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/**
 * Normalize a pasted key: uppercase, then if it has exactly 16 alphanumeric
 * chars re-group them 4-4-4-4 (forgiving of missing/extra dashes).
 */
export function normalizeLicenseKey(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === 16) {
    return [0, 4, 8, 12].map((i) => cleaned.slice(i, i + 4)).join('-');
  }
  return String(raw || '').trim().toUpperCase();
}

// ───────────────────────── encoding helpers ─────────────────────────

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pemToBytes(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  return base64ToBytes(b64);
}

/**
 * Convert a DER-encoded ECDSA signature to the raw r‖s form WebCrypto expects
 * (fixed 64 bytes for P-256). Returns null if the DER is malformed.
 */
export function derToRaw(der) {
  if (!der || der.length < 8 || der[0] !== 0x30) return null;
  let pos = 2;
  const seqLen = der[1];
  if (seqLen & 0x80) pos += seqLen & 0x7f; // long-form length (unlikely for P-256)
  if (der[pos] !== 0x02) return null; // r INTEGER
  const rLen = der[pos + 1];
  let r = der.subarray(pos + 2, pos + 2 + rLen);
  pos += 2 + rLen;
  if (der[pos] !== 0x02) return null; // s INTEGER
  const sLen = der[pos + 1];
  let s = der.subarray(pos + 2, pos + 2 + sLen);

  while (r.length > 1 && r[0] === 0) r = r.subarray(1);
  while (s.length > 1 && s[0] === 0) s = s.subarray(1);
  if (r.length > 32 || s.length > 32) return null;

  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

/**
 * Verify an ECDSA P-256 signature over JSON.stringify(payload). The payload
 * object must be the exact object parsed from the server response (insertion
 * order determines the signed bytes).
 */
export async function verifySignature(payload, signatureB64, publicKeyPem = PUBLIC_KEY_PEM) {
  try {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      pemToBytes(publicKeyPem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const rawSig = derToRaw(base64ToBytes(signatureB64));
    if (!rawSig) return false;
    const data = new TextEncoder().encode(JSON.stringify(payload));
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      rawSig,
      data,
    );
  } catch {
    return false;
  }
}

// ───────────────────────── license state ─────────────────────────

/**
 * Stable device fingerprint derived from hardware/OS signals — deliberately
 * NOT a persisted random value, so it survives storage clears on the same
 * machine. Computed fresh on each activation (deterministic), never stored.
 *
 * Signals: platform os/arch, logical CPU cores, device memory (GB, Chrome),
 * and screen size/color depth. Browser updates or display changes can alter
 * it; different profiles on the same machine share one fingerprint (treats
 * "one computer = one device", matching how the server counts activations).
 */
export async function getDeviceFingerprint() {
  let os = '';
  let arch = '';
  try {
    const info = await chrome.runtime.getPlatformInfo();
    os = info.os || '';
    arch = info.arch || '';
  } catch {
    // Non-fatal — fall through with empty platform fields.
  }

  const screenInfo = typeof screen !== 'undefined'
    ? `${screen.width}x${screen.height}x${screen.colorDepth}`
    : '';
  const cores = navigator.hardwareConcurrency || '';
  const mem = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : '';

  const raw = JSON.stringify({ os, arch, cores, mem, screen: screenInfo });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate + verify a signed response. Returns { ok, payload } on success or
 * { ok:false, reason } where reason is one of:
 *   invalid / stale / expired / bad_signature / license_not_found /
 *   license_revoked / license_refunded / activation_evicted
 *
 * Order mirrors EXTERNAL.md's client checklist: product → valid_until →
 * license_expires_at → signature (cheap checks fail fast before crypto).
 */
async function verifyResponse(resp) {
  if (!resp || resp.valid !== true) {
    return { ok: false, reason: resp?.reason || 'invalid' };
  }
  const { payload, signature } = resp;
  if (!payload || !signature) return { ok: false, reason: 'invalid' };
  if (payload.product !== PRODUCT_SLUG) return { ok: false, reason: 'invalid' };
  const validUntil = Date.parse(payload.valid_until);
  if (!Number.isFinite(validUntil) || validUntil <= Date.now()) {
    return { ok: false, reason: 'stale' };
  }
  // Business-level expiry (null = lifetime). The server signs this into the
  // payload, so enforce it client-side too — a fresh signature for a lapsed
  // subscription must not keep premium features unlocked.
  if (payload.license_expires_at != null) {
    const expiresAt = Date.parse(payload.license_expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }
  }
  const ok = await verifySignature(payload, signature);
  return ok ? { ok: true, payload } : { ok: false, reason: 'bad_signature' };
}

async function post(endpoint, body) {
  const res = await fetch(`${LICENTRA_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Don't let a hung server hold the service worker open indefinitely.
    signal: AbortSignal.timeout(10_000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body (proxy error page, empty reply) — callers treat as a
    // server-side failure.
  }
  // Keep the HTTP status so callers can distinguish "server answered with an
  // error" (500/400/429…) from a network-level failure (fetch threw).
  return { status: res.status, body: json };
}

function persistLicense(key, fingerprint, payload, certificate) {
  return setState(STORAGE_KEYS.LICENSE, {
    key,
    fingerprint,
    product: payload.product,
    plan: payload.plan,
    licenseId: payload.license_id,
    licenseExpiresAt: payload.license_expires_at,
    validUntil: Date.parse(payload.valid_until),
    // Offline grace: reset on every successful verify — the 48h window is
    // measured from the last time the server actually confirmed the license.
    graceUntil: Date.now() + GRACE_WINDOW_MS,
    // Clear any recorded server error (500/400/…) from a previous outage —
    // verification just succeeded, so there is nothing to surface anymore.
    lastServerError: null,
    // Signed License Certificate (EXTERNAL.md §"Signed License Certificate"):
    // every successful activate/check-in returns a fresh one and the client
    // overwrites its stored copy, for potential offline migration later.
    certificate: certificate ?? null,
  });
}

/**
 * Activate a license key on this device. Verifies the signed response before
 * persisting anything. Returns { ok, payload } or { ok:false, reason }.
 */
export async function activateLicense(rawKey, label) {
  const key = normalizeLicenseKey(rawKey);
  if (!KEY_REGEX.test(key)) return { ok: false, reason: 'invalid_format' };

  const fingerprint = await getDeviceFingerprint();
  let resp;
  try {
    resp = (await post('/api/license/activate', { key, fingerprint, label })).body;
  } catch {
    return { ok: false, reason: 'network' };
  }

  const result = await verifyResponse(resp);
  if (result.ok) {
    await persistLicense(key, fingerprint, result.payload, resp.certificate);
  }
  return result;
}

/**
 * Re-validate an existing license (detects revoke / refund / eviction). Used as
 * the periodic heartbeat once the signature's valid_until window has passed.
 *
 * Failure handling:
 *  - server explicitly denied (revoked / refunded / not_found / evicted /
 *    license_expired) → terminal, clears local state (TERMINAL_REASONS);
 *  - server unreachable / 5xx / rate-limited / non-JSON → offline grace
 *    window: extend validUntil by 30 min up to the 48h graceUntil, unless the
 *    grace window is already exhausted (→ `grace_exhausted`, keeps state so
 *    the next successful check-in can recover).
 */
export async function checkInLicense() {
  const license = await getState(STORAGE_KEYS.LICENSE);
  if (!license || !license.key || !license.fingerprint) {
    return { ok: false, reason: 'no_license' };
  }

  let http;
  try {
    http = await post('/api/license/check-in', {
      key: license.key,
      fingerprint: license.fingerprint,
    });
  } catch {
    // Network failure — the server never answered. Fall back to the grace
    // window instead of bricking premium on a transient outage.
    return grantGrace(license, null);
  }

  const resp = http.body;
  // Server answered with an HTTP error (5xx / 400 / 429 / …) — keep the
  // status + body error so the UI can surface the actual server error after
  // the grace window expires. body may be null (non-JSON reply).
  const serverError = http.status >= 400
    ? { status: http.status, error: resp?.error ?? `HTTP ${http.status}` }
    : null;

  // Server answered but not with a license verdict (5xx, rate limit, or a
  // body we couldn't parse into `valid`). Same treatment: server-side
  // problem, not a license problem — use the grace window.
  if (!resp || typeof resp.valid !== 'boolean') {
    return grantGrace(license, serverError);
  }

  const result = await verifyResponse(resp);
  if (result.ok) {
    await persistLicense(license.key, license.fingerprint, result.payload, resp.certificate);
  } else if (TERMINAL_REASONS.has(result.reason)) {
    // License is gone for good — clear local state so isPremium() turns off.
    await clearLicense();
  }
  return result;
}

/**
 * Offline grace: keep premium usable while the server is unreachable.
 * Extends validUntil by GRACE_STEP_MS, capped at graceUntil (last successful
 * verify + 48h). When the 48h window is exhausted, returns `grace_exhausted`
 * — the caller keeps local state (a future successful check-in recovers) but
 * isPremium() turns off because both deadlines are in the past.
 *
 * `serverError` ({ status, error } | null) records the server's last actual
 * response (e.g. 500 / 400) so the UI can surface the REAL error after the
 * window expires, instead of a generic message. It is persisted with the
 * license and cleared on the next successful verify.
 */
async function grantGrace(license, serverError = null) {
  const now = Date.now();
  // Old stored licenses (before grace existed) have no graceUntil — fall back
  // to a full window so existing users aren't locked out on first failure.
  const graceUntil = typeof license.graceUntil === 'number'
    ? license.graceUntil
    : now + GRACE_WINDOW_MS;

  if (now >= graceUntil) {
    // Also persist the latest server error on exhaustion, so the UI (which
    // reads storage, not this return value) can surface it.
    if (serverError) {
      await setState(STORAGE_KEYS.LICENSE, { ...license, lastServerError: serverError });
    }
    return { ok: false, reason: 'grace_exhausted', serverError };
  }

  const nextValidUntil = Math.min(now + GRACE_STEP_MS, graceUntil);
  await setState(STORAGE_KEYS.LICENSE, {
    ...license,
    validUntil: nextValidUntil,
    ...(serverError ? { lastServerError: serverError } : {}),
  });
  return { ok: true, grace: true };
}

// Reasons that mean the license is permanently invalid (clear local state).
// Transient failures (network / stale / expired / bad_signature / invalid)
// leave it alone — `expired` may resolve after the customer renews, and the
// next successful check-in will refresh the persisted state.
const TERMINAL_REASONS = new Set([
  'license_not_found',
  'license_revoked',
  'license_refunded',
  'license_expired',
  'activation_evicted',
]);

/**
 * Heartbeat wrapper: only re-check when the signature is stale (or near-stale).
 */
export async function maybeCheckIn() {
  const license = await getState(STORAGE_KEYS.LICENSE);
  if (!license || !license.key) return { ok: false, reason: 'no_license' };
  const HALF_TTL_MS = 12 * 60 * 60 * 1000; // refresh during the last half of the window
  if (typeof license.validUntil === 'number' && license.validUntil - Date.now() > HALF_TTL_MS) {
    return { ok: true, fresh: true };
  }
  return checkInLicense();
}

export async function clearLicense() {
  await setState(STORAGE_KEYS.LICENSE, null);
}
