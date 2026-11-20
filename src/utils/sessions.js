const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { mysqlPool } = require('../config/db');
require('dotenv').config();

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';
const SESSION_TTL = '2h';

/*
 * Una sola sesión abierta por usuario, ligada a un dispositivo de confianza.
 *
 * Privacidad:
 *  - del dispositivo solo se recibe un identificador aleatorio que genera la app (no es un dato
 *    del teléfono ni una huella del navegador) y se guarda su HMAC, nunca el valor;
 *  - de la sesión se guarda el hash de su id;
 *  - no se guardan IP, ubicación ni historial de accesos.
 */

const hashSessionId = (sid) => crypto.createHash('sha256').update(`sid:${sid}`).digest('hex');

/** HMAC del identificador del dispositivo, o null si la app no envió uno válido. */
const hashDeviceId = (deviceId) => {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(deviceId)) return null;
  return crypto.createHmac('sha256', SECRET_KEY).update(`device:${deviceId}`).digest('hex');
};

/** Nombre genérico del dispositivo para los avisos ("Chrome en Android"); no se guarda. */
const describeDevice = (userAgent = '') => {
  const ua = String(userAgent);
  const browser =
    /Edg(e|iOS|A)?\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
          : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
            : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
              : /Safari\//.test(ua) ? 'Safari'
                : 'un navegador';
  const os =
    /Android/.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X/.test(ua) ? 'Mac'
            : /Linux/.test(ua) ? 'Linux'
              : 'otro sistema';
  return `${browser} en ${os}`;
};

// ─── Sesión vigente por usuario, con caché corta para no consultar la base en cada petición ───
const CACHE_MS = 20 * 1000;
const cache = new Map(); // idUsuario → { sidHash, at }

const rememberSession = (userId, sidHash) => cache.set(String(userId), { sidHash, at: Date.now() });

const currentSessionHash = async (userId) => {
  const hit = cache.get(String(userId));
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.sidHash;
  const [rows] = await mysqlPool.query('SELECT SESION_ID FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [userId]);
  const sidHash = rows[0]?.SESION_ID ?? null;
  rememberSession(userId, sidHash);
  return sidHash;
};

const SESSION_ERRORS = {
  SESSION_EXPIRED: 'Tu sesión expiró. Inicia sesión de nuevo.',
  SESSION_REPLACED: 'Se inició sesión con tu cuenta en otro dispositivo, por eso se cerró esta sesión.',
  SESSION_ENDED: 'Tu sesión terminó. Inicia sesión de nuevo.',
};

/** null si el token es el de la sesión vigente del usuario; si no, el código del motivo. */
const sessionProblem = async (decoded) => {
  if (!decoded?.sid) return 'SESSION_EXPIRED'; // token emitido antes de la sesión única
  const current = await currentSessionHash(decoded.id);
  if (current && current === hashSessionId(decoded.sid)) return null;
  return current ? 'SESSION_REPLACED' : 'SESSION_ENDED';
};

/**
 * Abre la sesión del usuario con un id nuevo: la sesión anterior, en cualquier dispositivo, deja
 * de valer. Si viene el dispositivo, queda como el de confianza de la cuenta.
 */
const startSession = async (connection, user, deviceHash) => {
  const sid = crypto.randomBytes(18).toString('base64url');
  const sidHash = hashSessionId(sid);
  await connection.query(
    'UPDATE TBL_MS_USUARIO SET SESION_ID = ?, DISPOSITIVO_ID = COALESCE(?, DISPOSITIVO_ID) WHERE ID_USUARIO = ?',
    [sidHash, deviceHash || null, user.ID_USUARIO]
  );
  rememberSession(user.ID_USUARIO, sidHash);
  return jwt.sign({ id: user.ID_USUARIO, role: user.ID_ROL, sid }, SECRET_KEY, { expiresIn: SESSION_TTL });
};

/** Cierra la sesión solo si sigue siendo la vigente (no cierra una más nueva de otro dispositivo). */
const endSession = async (userId, sid) => {
  const sidHash = hashSessionId(sid);
  await mysqlPool.query('UPDATE TBL_MS_USUARIO SET SESION_ID = NULL WHERE ID_USUARIO = ? AND SESION_ID = ?', [userId, sidHash]);
  const hit = cache.get(String(userId));
  if (hit && hit.sidHash === sidHash) rememberSession(userId, null);
};

/** Olvida en la caché la sesión de un usuario cuya SESION_ID se anuló en la base (p. ej., al restablecer la contraseña). */
const forgetSession = (userId) => rememberSession(userId, null);

module.exports = {
  SESSION_ERRORS,
  hashDeviceId,
  describeDevice,
  sessionProblem,
  startSession,
  endSession,
  forgetSession,
};
