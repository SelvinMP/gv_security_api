const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

/**
 * Tokens de un solo propósito: el paso intermedio del 2FA ('pre2fa'), el restablecimiento de
 * contraseña ('pwdReset') y el paso de datos personales del registro ('register'). Se firman con
 * una clave derivada distinta de la de sesión, así que authenticateToken (y cualquier jwt.verify
 * con SECRET_KEY) los rechaza: no sirven como sesión.
 */
const PURPOSES = ['pre2fa', 'pwdReset', 'register'];

const keyFor = (purpose) => {
  if (!PURPOSES.includes(purpose)) throw new Error(`Propósito de token desconocido: ${purpose}`);
  return crypto.createHmac('sha256', SECRET_KEY).update(`gv-security:${purpose}`).digest();
};

const signPurposeToken = (purpose, payload, expiresIn) =>
  jwt.sign({ ...payload, purpose }, keyFor(purpose), { expiresIn });

/** Payload del token, o null si falta, venció, fue alterado o es de otro propósito. */
const verifyPurposeToken = (purpose, token) => {
  if (!token || typeof token !== 'string') return null;
  try {
    const decoded = jwt.verify(token, keyFor(purpose));
    return decoded.purpose === purpose ? decoded : null;
  } catch {
    return null;
  }
};

/** Token del encabezado "Authorization: Bearer <token>". */
const bearerToken = (req) => {
  const header = req.headers?.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7) : null;
};

/**
 * Huella del hash de la contraseña actual. Va dentro del token de restablecimiento: al cambiar
 * la contraseña la huella cambia y el token deja de servir, así que se puede usar una sola vez.
 */
const passwordFingerprint = (passwordHash) =>
  crypto.createHmac('sha256', SECRET_KEY).update(String(passwordHash || '')).digest('base64url').slice(0, 22);

module.exports = { signPurposeToken, verifyPurposeToken, bearerToken, passwordFingerprint };
