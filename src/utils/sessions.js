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
const cache = new Map(); // idUsuario → { sidHash, state, role, at }

/** Sesión vigente, estado y rol actuales de la cuenta (null si la cuenta ya no existe). */
const currentSession = async (userId) => {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const [rows] = await mysqlPool.query(
    'SELECT SESION_ID, ID_ESTADO_USUARIO, ID_ROL FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?',
    [userId]
  );
  const row = rows[0];
  const value = row ? { sidHash: row.SESION_ID ?? null, state: row.ID_ESTADO_USUARIO, role: row.ID_ROL } : null;
  cache.set(key, { value, at: Date.now() });
  return value;
};

/** Olvida lo que la caché sabe de la cuenta: la próxima petición lo lee de la base. */
const forgetSession = (userId) => cache.delete(String(userId));

const SESSION_ERRORS = {
  SESSION_EXPIRED: 'Tu sesión expiró. Inicia sesión de nuevo.',
  SESSION_REPLACED: 'Se inició sesión con tu cuenta en otro dispositivo, por eso se cerró esta sesión.',
  SESSION_ENDED: 'Tu sesión terminó. Inicia sesión de nuevo.',
};

// Estados con los que una sesión abierta deja de valer: 2 inactivo, 4 pendiente, 5 sin verificar.
// El 3 (bloqueado) no: si no, tres contraseñas equivocadas de otra persona sacarían al dueño. Cuando
// es la administración la que bloquea, el panel cierra la sesión (adminController).
const SESSION_ENDING_STATES = [2, 4, 5];

/** null si el token es el de la sesión vigente del usuario; si no, el código del motivo. */
const sessionProblem = async (decoded) => {
  if (!decoded?.sid) return 'SESSION_EXPIRED'; // token emitido antes de la sesión única
  const current = await currentSession(decoded.id);
  if (!current || !current.sidHash) return 'SESSION_ENDED';
  if (current.sidHash !== hashSessionId(decoded.sid)) return 'SESSION_REPLACED';
  // Cuenta dada de baja o con otro rol desde que se inició la sesión: hay que volver a entrar
  if (SESSION_ENDING_STATES.includes(Number(current.state))) return 'SESSION_ENDED';
  if (Number(current.role) !== Number(decoded.role)) return 'SESSION_ENDED';
  return null;
};

/**
 * Abre la sesión del usuario con un id nuevo: la sesión anterior, en cualquier dispositivo, deja de
 * valer. Si viene el dispositivo, queda como el de confianza de la cuenta; si es otro distinto al de
 * confianza, se olvida el token push del anterior (deja de recibir las notificaciones del dueño; el
 * dispositivo nuevo registra el suyo al entrar). Con `passwordHash`, solo abre la sesión si la
 * contraseña sigue siendo esa (un cambio simultáneo gana). Devuelve el token, o null si no se abrió.
 */
const startSession = async (connection, user, deviceHash, passwordHash) => {
  const sid = crypto.randomBytes(18).toString('base64url');
  const bindPassword = typeof passwordHash === 'string' && passwordHash.length > 0;
  // FCM_TOKEN va antes que DISPOSITIVO_ID: así compara con el dispositivo anterior, tanto si MySQL
  // evalúa las asignaciones en orden como si usa los valores originales.
  const [result] = await connection.query(
    `UPDATE TBL_MS_USUARIO
        SET SESION_ID = ?,
            FCM_TOKEN = IF(DISPOSITIVO_ID IS NULL OR DISPOSITIVO_ID = ?, FCM_TOKEN, NULL),
            DISPOSITIVO_ID = COALESCE(?, DISPOSITIVO_ID)
      WHERE ID_USUARIO = ?${bindPassword ? ' AND CONTRASEÑA = ?' : ''}`,
    [hashSessionId(sid), deviceHash || null, deviceHash || null, user.ID_USUARIO, ...(bindPassword ? [passwordHash] : [])]
  );
  forgetSession(user.ID_USUARIO);
  // SESION_ID siempre cambia (es aleatorio), así que affectedRows es 1 si y solo si la fila coincidió
  if (!result || !result.affectedRows) return null;
  return jwt.sign({ id: user.ID_USUARIO, role: user.ID_ROL, sid }, SECRET_KEY, { expiresIn: SESSION_TTL });
};

/**
 * Cierra la sesión solo si sigue siendo la vigente (no cierra una más nueva de otro dispositivo) y
 * olvida el token push: tras cerrar sesión, ese dispositivo ya no recibe las notificaciones.
 */
const endSession = async (userId, sid) => {
  await mysqlPool.query(
    'UPDATE TBL_MS_USUARIO SET SESION_ID = NULL, FCM_TOKEN = NULL WHERE ID_USUARIO = ? AND SESION_ID = ?',
    [userId, hashSessionId(sid)]
  );
  forgetSession(userId);
};

module.exports = {
  SESSION_ERRORS,
  hashDeviceId,
  describeDevice,
  sessionProblem,
  startSession,
  endSession,
  forgetSession,
};
