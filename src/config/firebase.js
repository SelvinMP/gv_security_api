/**
 * Firebase Admin (notificaciones push FCM) — inicialización única y envío centralizado.
 *
 * Credenciales (en este orden):
 *  1. Variable de entorno FIREBASE_SERVICE_ACCOUNT con el JSON de la cuenta de servicio
 *     (puede ir tal cual o codificado en base64). Recomendado para Render.
 *  2. Archivo src/config/firebaseServiceAccountKey.json (desarrollo local; está en .gitignore).
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { mysqlPool } = require('./db');

const APP_URL = (process.env.APP_URL || 'https://gv-security.web.app').replace(/\/$/, '');
const ICON_URL = `${APP_URL}/android-chrome-192x192.png`;
const BADGE_URL = `${APP_URL}/favicon-32x32.png`;

let initError = null;

const loadServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const json = JSON.parse(text);
    if (json.private_key) json.private_key = json.private_key.replace(/\\n/g, '\n');
    return { json, source: 'variable FIREBASE_SERVICE_ACCOUNT' };
  }
  const file = path.join(__dirname, 'firebaseServiceAccountKey.json');
  if (fs.existsSync(file)) return { json: require(file), source: 'archivo firebaseServiceAccountKey.json' };
  return null;
};

try {
  if (!admin.apps.length) {
    const sa = loadServiceAccount();
    if (!sa) {
      initError = 'No hay credenciales de Firebase (FIREBASE_SERVICE_ACCOUNT o src/config/firebaseServiceAccountKey.json).';
      console.warn(`⚠️ Firebase Admin NO inicializado: ${initError}`);
    } else {
      admin.initializeApp({ credential: admin.credential.cert(sa.json) });
      console.log(`🔥 Firebase Admin inicializado (${sa.source}).`);
    }
  }
} catch (error) {
  initError = error.message;
  console.error('❌ Error al inicializar Firebase Admin:', error.message);
}

const isPushReady = () => admin.apps.length > 0;
const getPushInitError = () => initError;

// Errores que indican que el token ya no sirve (app desinstalada, permiso revocado, token viejo)
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

/** Construye el mensaje FCM para la web (PWA): título, cuerpo, ícono y enlace al abrir. */
const buildMessage = ({ title, body, link = '/notifications', imageUrl, data = {} }) => {
  const absLink = /^https?:\/\//.test(link) ? link : `${APP_URL}${link.startsWith('/') ? '' : '/'}${link}`;
  const notification = { title: String(title || 'GV-Security').slice(0, 150), body: String(body || '').slice(0, 1000) };
  if (imageUrl) notification.imageUrl = imageUrl;

  const stringData = {};
  Object.entries({ ...data, link: absLink }).forEach(([k, v]) => {
    if (v !== undefined && v !== null) stringData[k] = String(v);
  });

  return {
    notification,
    data: stringData,
    webpush: {
      headers: { Urgency: 'high', TTL: '86400' },
      notification: {
        icon: ICON_URL,
        badge: BADGE_URL,
        ...(imageUrl ? { image: imageUrl } : {}),
        requireInteraction: false
      },
      fcmOptions: { link: absLink }
    },
    android: { priority: 'high', notification: { sound: 'default' } },
    apns: { payload: { aps: { sound: 'default' } } }
  };
};

/** Limpia de la BD los tokens que FCM reporta como inválidos. */
const cleanupTokens = async (tokens) => {
  if (tokens.length === 0) return;
  try {
    await mysqlPool.query('UPDATE TBL_MS_USUARIO SET FCM_TOKEN = NULL WHERE FCM_TOKEN IN (?)', [tokens]);
    console.log(`[FCM] ${tokens.length} token(s) inválido(s) eliminado(s).`);
  } catch (err) {
    console.error('[FCM] No se pudieron limpiar tokens inválidos:', err.message);
  }
};

/**
 * Envía una notificación push a uno o varios tokens.
 * Nunca lanza errores. Devuelve { successCount, failureCount, errors[] }.
 * Borra automáticamente de la BD los tokens que FCM reporta como inválidos.
 */
const sendPush = async (tokens, payload) => {
  const list = [...new Set((Array.isArray(tokens) ? tokens : [tokens])
    .filter(t => typeof t === 'string' && t.trim().length > 10 && t !== 'DISABLED')
    .map(t => t.trim()))];

  const result = { successCount: 0, failureCount: 0, errors: [] };
  if (list.length === 0) return result;
  if (!isPushReady()) {
    result.failureCount = list.length;
    result.errors.push(initError || 'Firebase Admin no inicializado.');
    console.warn('[FCM] Push no enviado: Firebase Admin no inicializado.');
    return result;
  }

  try {
    const base = buildMessage(payload);
    const invalid = [];
    // sendEachForMulticast admite máximo 500 tokens por llamada
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const response = await admin.messaging().sendEachForMulticast({ ...base, tokens: chunk });
      result.successCount += response.successCount;
      result.failureCount += response.failureCount;
      response.responses.forEach((r, idx) => {
        if (!r.success && r.error) {
          result.errors.push(r.error.code || r.error.message);
          if (INVALID_TOKEN_CODES.has(r.error.code)) invalid.push(chunk[idx]);
        }
      });
    }
    await cleanupTokens(invalid);
    console.log(`[FCM] Push enviado: ${result.successCount} ok, ${result.failureCount} fallidos.`);
  } catch (err) {
    result.failureCount = list.length;
    result.errors.push(err.message);
    console.error('[FCM] Error enviando push:', err.message);
  }
  return result;
};

module.exports = { admin, sendPush, isPushReady, getPushInitError, APP_URL };
