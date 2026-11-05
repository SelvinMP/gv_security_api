/**
 * ============================================================================
 *  CIFRADO DE CÓDIGOS QR - GV-SECURITY
 * ============================================================================
 *  Todo QR emitido por la API contiene un token cifrado con AES-256-GCM:
 *
 *      GVS1.<base64url( IV[12] | TAG[16] | CIPHERTEXT )>
 *
 *  - Un lector de QR genérico solo ve texto ilegible (sin nombres, DNI, casa…).
 *  - GCM autentica el contenido: un QR alterado o falsificado no se descifra.
 *  - Solo la API (que conoce QR_SECRET_KEY) puede descifrarlo; el escáner del
 *    guardia envía el token a /api/guardia/scan y recibe los datos validados.
 *
 *  La llave se toma de la variable de entorno QR_SECRET_KEY (recomendado: 32+
 *  caracteres aleatorios). Si no existe, se deriva de SECRET_KEY para no
 *  romper el despliegue, pero se muestra una advertencia.
 * ============================================================================
 */
const crypto = require('crypto');
const QRCode = require('qrcode');
require('dotenv').config();

const QR_PREFIX = 'GVS1.';

// Tipos de QR soportados
const QR_TYPES = {
  VISITA: 'V',        // Visita de ingreso único (TBL_REGVISITAS)
  RECURRENTE: 'R',    // Visita recurrente (TBL_VISITANTES_RECURRENTES)
  PAQUETE: 'P',       // Paquete (TBL_PAQUETES)
  EVENTO: 'E',        // QR múltiple de visitas (TBL_EVENTOS_VISITA)
  RESIDENTE: 'H'      // Carnet de residente (TBL_PERSONAS / TBL_MS_USUARIO)
};

const rawSecret = (process.env.QR_SECRET_KEY || '').trim();
if (!rawSecret) {
  console.warn('⚠️  QR_SECRET_KEY no está configurada. Se deriva una llave a partir de SECRET_KEY. Configure QR_SECRET_KEY en el entorno.');
}
const KEY = crypto
  .createHash('sha256')
  .update(rawSecret || `gv-qr::${process.env.SECRET_KEY || 'your_secret_key'}`)
  .digest(); // 32 bytes → AES-256

const toBase64Url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (str) => {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64');
};

/**
 * Cifra un payload { t, id, ... } y devuelve el token GVS1.
 */
const encryptQRPayload = (payload) => {
  const body = JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return QR_PREFIX + toBase64Url(Buffer.concat([iv, tag, ciphertext]));
};

/**
 * Descifra un token GVS1. Devuelve el payload o null si es inválido/alterado.
 */
const decryptQRPayload = (token) => {
  try {
    if (typeof token !== 'string') return null;
    const clean = token.trim();
    if (!clean.startsWith(QR_PREFIX)) return null;
    const raw = fromBase64Url(clean.slice(QR_PREFIX.length));
    if (raw.length < 12 + 16 + 2) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plain);
    if (!payload || !payload.t || payload.id === undefined || payload.id === null) return null;
    return payload;
  } catch (e) {
    return null;
  }
};

/**
 * Genera la imagen (Data URL PNG) de un QR cifrado.
 * Mantiene los colores institucionales (navy sobre blanco).
 */
const buildEncryptedQR = async (type, id, extra = {}) => {
  const token = encryptQRPayload({ t: type, id: Number(id), ...extra });
  const qrCode = await QRCode.toDataURL(token, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#0E2041', light: '#FFFFFF' }
  });
  return { token, qrCode };
};

module.exports = {
  QR_PREFIX,
  QR_TYPES,
  encryptQRPayload,
  decryptQRPayload,
  buildEncryptedQR
};
