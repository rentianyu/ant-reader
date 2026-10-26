/** 单用户口令认证：PBKDF2 口令哈希 + HMAC 签名会话 Cookie（无状态） */

const encoder = new TextEncoder();
const PBKDF2_ITER = 100000;
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 天

/* ------------------------------ 编码工具 ------------------------------ */

export function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function b64url(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return atob(s + pad);
}

export function randomHex(byteLen = 16) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function timingSafeEqual(a, b) {
  const A = String(a);
  const B = String(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------ 口令哈希 ------------------------------ */

export async function hashPassword(password, saltHex, iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function verifyPassword(password, stored) {
  // stored 格式： pbkdf2$<iterations>$<saltHex>$<hashHex>
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10) || PBKDF2_ITER;
  const saltHex = parts[2];
  const expected = parts[3];
  const got = await hashPassword(password, saltHex, iterations);
  return timingSafeEqual(got, expected);
}

export async function makePasswordRecord(password) {
  const saltHex = randomHex(16);
  const hash = await hashPassword(password, saltHex, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${saltHex}$${hash}`;
}

/* ------------------------------ 会话签名 ------------------------------ */

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(secret, ttl = SESSION_TTL) {
  const payload = JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl });
  const body = b64url(encoder.encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(secret, token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, Uint8Array.from(b64urlDecode(sig), (c) => c.charCodeAt(0)), encoder.encode(body));
    if (!ok) return false;
    const payload = JSON.parse(b64urlDecode(body));
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/* ------------------------------ Cookie ------------------------------ */

export const COOKIE_NAME = 'ant_session';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function buildSessionCookie(token, maxAge = SESSION_TTL, secure = true) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${maxAge}`;
}

export function clearSessionCookie(secure = true) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`;
}
