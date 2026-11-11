import crypto from 'node:crypto';

const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';

function md5(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

function doubleByte(v: number): number {
  return ((v << 1) ^ (v & 128 ? 27 : 0)) & 255;
}
function threeByte(v: number): number {
  return doubleByte(v) ^ v;
}
function nineByte(v: number): number {
  return threeByte(doubleByte(v));
}
function elevenByte(v: number): number {
  return nineByte(threeByte(doubleByte(v)));
}
function thirteenByte(v: number): number {
  return elevenByte(v) ^ nineByte(v) ^ threeByte(v);
}

/**
 * Computes the XiaoHeiHe API path signature (hkey).
 */
export function signPath(rawPath: string, timestamp: number, nonce: string): string {
  const cleanPath = '/' + rawPath.split('/').filter(Boolean).join('/') + '/';
  const mapChars = (value: string, alphabet: string): string => {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      out += alphabet[value.charCodeAt(i) % alphabet.length];
    }
    return out;
  };

  const p1 = mapChars(String(timestamp + 1), ALPHABET.slice(0, -2));
  const p2 = mapChars(cleanPath, ALPHABET);
  const p3 = mapChars(nonce, ALPHABET);

  const maxLen = Math.max(p1.length, p2.length, p3.length);
  let seed = '';
  for (let i = 0; i < maxLen; i++) {
    if (i < p1.length) seed += p1[i];
    if (i < p2.length) seed += p2[i];
    if (i < p3.length) seed += p3[i];
  }
  seed = seed.slice(0, 20);

  const digest = md5(seed);
  const tail = digest.slice(-6);
  const a = tail.charCodeAt(0);
  const b = tail.charCodeAt(1);
  const c = tail.charCodeAt(2);
  const d = tail.charCodeAt(3);

  const mixed = [
    thirteenByte(a) ^ elevenByte(b) ^ nineByte(c) ^ threeByte(d),
    threeByte(a) ^ thirteenByte(b) ^ elevenByte(c) ^ nineByte(d),
    nineByte(a) ^ threeByte(b) ^ thirteenByte(c) ^ elevenByte(d),
    elevenByte(a) ^ nineByte(b) ^ threeByte(c) ^ thirteenByte(d),
  ];

  const sumMixed = mixed.reduce((acc, v) => acc + v, 0);
  const last2 = digest.slice(-2);
  const checksum = (sumMixed + last2.charCodeAt(0) + last2.charCodeAt(1)) % 100;

  return mapChars(digest.slice(0, 5), ALPHABET.slice(0, -4)) + String(checksum).padStart(2, '0');
}

/**
 * Generates signed query parameters for XiaoHeiHe API endpoints.
 */
export function getSignedParams(
  reqPath: string,
  options: { timestamp?: number; nonce?: string } = {}
): { hkey: string; _time: number; nonce: string } {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce =
    options.nonce ??
    md5(String(timestamp) + crypto.randomBytes(16).toString('hex')).toUpperCase();
  const hkey = signPath(reqPath, timestamp, nonce);
  return { hkey, _time: timestamp, nonce };
}

/**
 * Generates workshop signature (_rnd) for XiaoHeiHe web write endpoints.
 */
export function getWorkshopParams(params: { _time: number; nonce: string }): { _rnd: string } {
  const salt = 'Z7mFG4tQp9Ws2LxB8H';
  const nonce = String(params.nonce);
  const stamp = String(params._time);
  const message = `${salt}${nonce}${stamp}:${nonce}`;
  const digest = crypto.createHmac('sha256', salt).update(message).digest('hex');
  return { _rnd: `15:${digest}` };
}

/**
 * Computes Tencent Cloud COS HMAC-SHA1 authorization header for direct file uploads.
 */
export function getCosAuthorization(
  credentials: { tmpSecretId: string; tmpSecretKey: string },
  method: string,
  path: string,
  headers: Record<string, string>,
  start: number,
  end: number
): string {
  const keyTime = `${start};${end}`;
  const canonical: Record<string, string> = {};
  for (const k of Object.keys(headers)) {
    canonical[k.toLowerCase()] = String(headers[k]);
  }
  const names = Object.keys(canonical).sort();
  const headerText = names
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(canonical[k]))
    .join('&');
  const httpString = `${method.toLowerCase()}\n${path}\n\n${headerText}\n`;
  const signKey = crypto.createHmac('sha1', credentials.tmpSecretKey).update(keyTime).digest('hex');
  const toSign = `sha1\n${keyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = crypto.createHmac('sha1', signKey).update(toSign).digest('hex');

  return (
    `q-sign-algorithm=sha1&q-ak=${credentials.tmpSecretId}&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}&q-header-list=${names.join(';')}&q-url-param-list=&q-signature=${signature}`
  );
}
