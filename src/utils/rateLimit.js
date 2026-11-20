/**
 * Límite de solicitudes en memoria (ventana deslizante), sin dependencias externas.
 * Alcanza para una sola instancia del servidor (Render); al reiniciarse, los contadores empiezan de cero.
 */
const buckets = new Map(); // clave → { windowMs, times: [marcas de tiempo] }

const recentHits = (key, windowMs, now) => {
  const bucket = buckets.get(key);
  const times = bucket ? bucket.times.filter((t) => now - t < windowMs) : [];
  buckets.set(key, { windowMs, times });
  return times;
};

/**
 * Revisa todas las reglas y, solo si todas lo permiten, registra el intento en cada una.
 * rules: [{ key, max, windowMs }]. Devuelve 0 si se permite, o los segundos que faltan para reintentar.
 */
const consumeRateLimit = (rules) => {
  const now = Date.now();
  let waitMs = 0;
  for (const { key, max, windowMs } of rules) {
    const times = recentHits(key, windowMs, now);
    if (times.length >= max) waitMs = Math.max(waitMs, windowMs - (now - times[0]));
  }
  if (waitMs > 0) return Math.max(1, Math.ceil(waitMs / 1000));
  for (const { key } of rules) buckets.get(key).times.push(now);
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

// Limpieza periódica para que el mapa no crezca sin control
setInterval(() => {
  const now = Date.now();
  for (const [key, { windowMs, times }] of buckets) {
    if (!times.some((t) => now - t < windowMs)) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = { consumeRateLimit, tooManyRequests };
