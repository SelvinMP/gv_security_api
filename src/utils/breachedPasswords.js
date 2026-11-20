const crypto = require('crypto');

/**
 * ¿La contraseña aparece en filtraciones públicas? Usa el servicio de Have I Been Pwned con
 * k-anonimato: solo se envían los primeros 5 caracteres del hash SHA-1, nunca la contraseña.
 * Devuelve true o false, o null si el servicio no respondió a tiempo (en ese caso no se bloquea
 * el cambio: la política de contraseñas y el historial se siguen aplicando).
 */
const isPasswordBreached = async (password, timeoutMs = 3000) => {
  const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' }, // respuestas de tamaño uniforme
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0; // el relleno llega con conteo 0
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { isPasswordBreached };
