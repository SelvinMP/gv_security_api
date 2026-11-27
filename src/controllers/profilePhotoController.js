const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mysqlPool } = require('../config/db');
const { avatarDir, uploadAvatar } = require('../config/upload');
const { canAccessUser, denyAccess } = require('../utils/access');
const { consumeRateLimit, tooManyRequests } = require('../utils/rateLimit');

/*
 * Foto de perfil. La imagen se guarda como archivo en el servidor (storage/avatars, carpeta privada) y
 * en la base solo su ruta relativa (TBL_MS_USUARIO.FOTO_PERFIL = 'avatars/<archivo>').
 * Privacidad: no está en /uploads (público); solo la ve su dueño o la administración, con sesión.
 */

const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Tipo real de la imagen por sus primeros bytes (no se confía en el nombre ni en lo que dice el navegador). */
const detectImage = (buf) => {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
};

/** Ruta absoluta a partir de lo guardado en la base: solo el nombre del archivo, siempre dentro de avatars. */
const fileFromDb = (stored) => (stored ? path.join(avatarDir, path.basename(String(stored))) : null);
const removeStoredFile = (stored) => {
  const file = fileFromDb(stored);
  if (file) fs.unlink(file, () => {});
};

/** Recibe el archivo (campo "foto") y convierte los errores de multer en un 400 legible. */
const receivePhoto = (req, res, next) =>
  uploadAvatar.single('foto')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'La foto pesa más de 2 MB.' : 'No se pudo recibir la foto.';
    res.status(400).json({ success: false, message });
  });

/** POST /auth/profile-photo — sube o reemplaza la foto del usuario de la sesión. */
const uploadProfilePhoto = async (req, res) => {
  const userId = req.user.id;
  const wait = consumeRateLimit([{ key: `profile-photo:user:${userId}`, max: 10, windowMs: 15 * 60 * 1000 }]);
  if (wait) return tooManyRequests(res, wait);

  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ success: false, message: 'Selecciona una foto.' });
  }
  const ext = detectImage(req.file.buffer);
  if (!ext) return res.status(400).json({ success: false, message: 'La foto debe ser JPG, PNG o WEBP.' });

  // Nombre aleatorio: no se puede adivinar ni pisar el de otro usuario
  const fileName = `u${userId}_${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const filePath = path.join(avatarDir, fileName);

  let connection;
  try {
    await fs.promises.writeFile(filePath, req.file.buffer, { flag: 'wx' });
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query('SELECT FOTO_PERFIL FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [userId]);
    await connection.query('UPDATE TBL_MS_USUARIO SET FOTO_PERFIL = ? WHERE ID_USUARIO = ?', [`avatars/${fileName}`, userId]);
    removeStoredFile(rows[0]?.FOTO_PERFIL); // la anterior ya no se usa
    res.json({ success: true, message: 'Foto de perfil actualizada.' });
  } catch (error) {
    fs.unlink(filePath, () => {});
    console.error('Error al guardar la foto de perfil:', error.message);
    res.status(500).json({ success: false, message: 'No se pudo guardar la foto.' });
  } finally {
    if (connection) connection.release();
  }
};

/** GET /auth/profile-photo/:usuarioId — la foto propia (o cualquiera, para la administración). */
const getProfilePhoto = async (req, res) => {
  const { usuarioId } = req.params;
  if (!canAccessUser(req, usuarioId)) return denyAccess(res);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query('SELECT FOTO_PERFIL FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [usuarioId]);
    const file = fileFromDb(rows[0]?.FOTO_PERFIL);
    const mime = file && MIME_BY_EXT[path.extname(file).slice(1)];
    // Sin foto, o el archivo ya no está (por ejemplo, el disco del servidor se reinició)
    if (!file || !mime || !fs.existsSync(file)) return res.status(404).json({ message: 'Sin foto de perfil' });

    res.set({
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    res.sendFile(file);
  } catch (error) {
    console.error('Error al leer la foto de perfil:', error.message);
    if (!res.headersSent) res.status(500).json({ message: 'No se pudo cargar la foto.' });
  } finally {
    if (connection) connection.release();
  }
};

/** DELETE /auth/profile-photo — quita la foto del usuario de la sesión (y borra el archivo). */
const deleteProfilePhoto = async (req, res) => {
  const userId = req.user.id;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query('SELECT FOTO_PERFIL FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [userId]);
    await connection.query('UPDATE TBL_MS_USUARIO SET FOTO_PERFIL = NULL WHERE ID_USUARIO = ?', [userId]);
    removeStoredFile(rows[0]?.FOTO_PERFIL);
    res.json({ success: true, message: 'Foto de perfil eliminada.' });
  } catch (error) {
    console.error('Error al quitar la foto de perfil:', error.message);
    res.status(500).json({ success: false, message: 'No se pudo quitar la foto.' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { receivePhoto, uploadProfilePhoto, getProfilePhoto, deleteProfilePhoto, detectImage };
