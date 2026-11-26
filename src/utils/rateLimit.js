/**
 * Límite de solicitudes en memoria (ventana deslizante), sin dependencias externas.
 * Alcanza para una sola instancia del servidor (Render); al reiniciarse, los contadores empiezan de cero.
 *
 * Protección de memoria: solo se guarda un registro por clave cuando la solicitud se permite (las
 * rechazadas no crean nada), las claves largas se acortan, hay un máximo de claves y una limpieza
 * frecuente. Así nadie puede agotar la memoria mandando miles de correos o claves distintas.
 */
const crypto = require('crypto');

const MAX_BUCKETS = 50000;
const MAX_KEY_LENGTH = 120;
const buckets = new Map(); // clave → { windowMs, times: [marcas de tiempo] }

const normalizeKey = (key) => {
  const value = String(key);
  return value.length <= MAX_KEY_LENGTH
    ? value
    : `${value.slice(0, 40)}#${crypto.createHash('sha256').update(value).digest('base64url').slice(0, 22)}`;
};

/** Marcas de tiempo vigentes de una clave, sin crear nada si la clave no existe. */
const recentHits = (key, windowMs, now) => {
  const bucket = buckets.get(key);
  if (!bucket) return [];
  bucket.times = bucket.times.filter((t) => now - t < windowMs);
  return bucket.times;
};

const prune = (now) => {
  for (const [key, { windowMs, times }] of buckets) {
    if (!times.some((t) => now - t < windowMs)) buckets.delete(key);
  }
};

/** Hace espacio para una clave nueva: primero quita las vencidas; si no alcanza, las más antiguas. */
const makeRoom = (now) => {
  if (buckets.size < MAX_BUCKETS) return;
  prune(now);
  for (const key of buckets.keys()) {
    if (buckets.size < MAX_BUCKETS) break;
    buckets.delete(key); // Map conserva el orden de inserción: se van primero las más viejas
  }
};

/**
 * Revisa todas las reglas y, solo si todas lo permiten, registra el intento en cada una.
 * rules: [{ key, max, windowMs }]. Devuelve 0 si se permite, o los segundos que faltan para reintentar.
 */
const consumeRateLimit = (rules) => {
  const now = Date.now();
  const normalized = rules.map((rule) => ({ ...rule, key: normalizeKey(rule.key) }));
  let waitMs = 0;
  for (const { key, max, windowMs } of normalized) {
    const times = recentHits(key, windowMs, now);
    if (times.length >= max) waitMs = Math.max(waitMs, windowMs - (now - times[0]));
  }
  if (waitMs > 0) return Math.max(1, Math.ceil(waitMs / 1000));

  for (const { key, windowMs } of normalized) {
    let bucket = buckets.get(key);
    if (!bucket) {
      makeRoom(now);
      bucket = { windowMs, times: [] };
      buckets.set(key, bucket);
    }
    bucket.windowMs = Math.max(bucket.windowMs, windowMs);
    bucket.times.push(now);
  }
  return 0;
};

const describeWait = (seconds) => {
  if (seconds < 60) return `${seconds} segundo${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
};

/** Respuesta 429 estándar, con el tiempo de espera en el encabezado Retry-After y en el cuerpo. */
const tooManyRequests = (res, seconds) =>
  res
    .status(429)
    .set('Retry-After', String(seconds))
    .json({ message: `Demasiados intentos. Espera ${describeWait(seconds)} e inténtalo de nuevo.`, retryAfter: seconds });

// Limpieza periódica de claves vencidas
setInterval(() => prune(Date.now()), 2 * 60 * 1000).unref();

module.exports = { consumeRateLimit, tooManyRequests };
