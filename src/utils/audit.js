/**
 * Auditoría del sistema (Logs de Auditoría del panel Super Admin).
 *
 * Cada función guarda una "fotografía" del registro afectado en su tabla TBL_LOG_*
 * junto con la ACCIÓN realizada, un DETALLE legible, el usuario responsable
 * (tomado del JWT), la IP de origen y el navegador.
 *
 * Nota: por compatibilidad con el esquema existente, la columna FECHA_ELIMINACION
 * guarda la fecha del evento y USUARIO_ELIMINACION el responsable, sea cual sea la acción.
 *
 * La auditoría NUNCA debe romper la operación principal: todos los errores se
 * registran en consola y se ignoran.
 */
const jwt = require('jsonwebtoken');
const { mysqlPool } = require('../config/db');

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

/** ID del usuario en sesión: req.user (middleware) o el JWT del encabezado si la ruta no usa middleware. */
const sessionUserId = (req) => {
  if (req?.user?.id) return req.user.id;
  const h = req?.headers?.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(h.split(' ')[1], SECRET_KEY)?.id || null;
  } catch {
    return null;
  }
};

const ACCION = {
  CREACION: 'CREACIÓN',
  REGISTRO: 'REGISTRO',
  MODIFICACION: 'MODIFICACIÓN',
  CAMBIO_ESTADO: 'CAMBIO DE ESTADO',
  APROBACION: 'APROBACIÓN',
  RECHAZO: 'RECHAZO',
  BLOQUEO: 'BLOQUEO',
  DESACTIVACION: 'DESACTIVACIÓN',
  ELIMINACION: 'ELIMINACIÓN',
  CAMBIO_CONTRASENA: 'CAMBIO DE CONTRASEÑA',
  RESTABLECIMIENTO: 'RESTABLECIMIENTO',
  DEPURACION: 'DEPURACIÓN',
};

const cut = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

/** IP y navegador de la petición (respeta proxies como Render). */
const clientInfo = (req) => {
  const fwd = req?.headers?.['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0].trim() : null) || req?.socket?.remoteAddress || 'Desconocida';
  return { ip: cut(ip, 45), navegador: cut(req?.headers?.['user-agent'] || 'Desconocido', 255) };
};

/** Nombre del usuario que ejecuta la acción (JWT); "Sistema" si no hay sesión. */
const responsableOf = async (db, req, override) => {
  if (override) return cut(override, 60);
  const id = sessionUserId(req);
  if (!id) return 'Sistema';
  try {
    const [[u]] = await db.query('SELECT NOMBRE_USUARIO, EMAIL FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [id]);
    return cut(u ? (u.NOMBRE_USUARIO || u.EMAIL) : `Usuario #${id}`, 60);
  } catch {
    return cut(`Usuario #${id}`, 60);
  }
};

const safe = (name, fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.warn(`[auditoría] No se pudo registrar ${name}:`, err.message);
  }
};

/**
 * Evento sobre un usuario (TBL_LOG_USUARIO).
 * Llamar ANTES de un DELETE para conservar la fotografía del registro.
 * No guarda contraseña, secretos 2FA ni códigos de verificación.
 */
const logUsuario = safe('evento de usuario', async (db, req, { idUsuario, accion, detalle, responsable }) => {
  db = db || mysqlPool;
  const [[u]] = await db.query(
    `SELECT ID_USUARIO, ID_ROL, NOMBRE_USUARIO, ID_ESTADO_USUARIO, EMAIL, PRIMER_INGRESO, FECHA_ULTIMA_CONEXION,
            FECHA_VENCIMIENTO, CODIGO_2FA, INTENTOS_FALLIDOS, PRIMER_INGRESO_COMPLETADO
       FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?`,
    [idUsuario]
  );
  const { ip, navegador } = clientInfo(req);
  const quien = await responsableOf(db, req, responsable);
  await db.query(
    `INSERT INTO TBL_LOG_USUARIO
      (ID_USUARIO, ID_ROL, NOMBRE_USUARIO, ID_ESTADO_USUARIO, EMAIL, PRIMER_INGRESO, FECHA_ULTIMA_CONEXION,
       FECHA_VENCIMIENTO, CODIGO_2FA, INTENTOS_FALLIDOS, PRIMER_INGRESO_COMPLETADO,
       FECHA_ELIMINACION, USUARIO_ELIMINACION, ORIGEN_IP, NAVEGADOR, ACCION, DETALLE)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
    [
      idUsuario, u?.ID_ROL ?? null, cut(u?.NOMBRE_USUARIO, 70), u?.ID_ESTADO_USUARIO ?? null, cut(u?.EMAIL, 70),
      u?.PRIMER_INGRESO ?? null, u?.FECHA_ULTIMA_CONEXION ?? null, u?.FECHA_VENCIMIENTO ?? null,
      u?.CODIGO_2FA ?? null, u?.INTENTOS_FALLIDOS ?? null, u?.PRIMER_INGRESO_COMPLETADO ?? null,
      quien, ip, navegador, accion, cut(detalle, 500),
    ]
  );
});

/**
 * Evento sobre los datos de residente / persona (TBL_LOG_PERSONA).
 * Identifica la persona por idPersona o por idUsuario.
 */
const logPersona = safe('evento de persona', async (db, req, { idPersona, idUsuario, accion, detalle, responsable }) => {
  db = db || mysqlPool;
  const [[p]] = await db.query(
    `SELECT p.ID_PERSONA, p.DNI_PERSONA, p.NUM_CARNET_EXTRANJERO, p.ID_CONTACTO, p.ID_TIPO_PERSONA, p.ID_ESTADO_PERSONA,
            p.ID_PARENTESCO, p.ID_CONDOMINIO, p.ID_PADRE, u.NOMBRE_USUARIO
       FROM TBL_PERSONAS p
       LEFT JOIN TBL_MS_USUARIO u ON u.ID_USUARIO = p.ID_USUARIO
      WHERE ${idPersona ? 'p.ID_PERSONA = ?' : 'p.ID_USUARIO = ?'}
      LIMIT 1`,
    [idPersona || idUsuario]
  );
  if (!p) return;
  const { ip, navegador } = clientInfo(req);
  const quien = await responsableOf(db, req, responsable);
  await db.query(
    `INSERT INTO TBL_LOG_PERSONA
      (ID_PERSONA, NOMBRE_PERSONA, DNI_PERSONA, ID_CONTACTO, ID_TIPO_PERSONA, ID_ESTADO_PERSONA, ID_PARENTESCO,
       ID_CONDOMINIO, ID_PADRE, FECHA_ELIMINACION, USUARIO_ELIMINACION, ORIGEN_IP, NAVEGADOR, ACCION, DETALLE)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
    [
      p.ID_PERSONA, cut(p.NOMBRE_USUARIO, 60), cut(p.DNI_PERSONA || p.NUM_CARNET_EXTRANJERO, 60), p.ID_CONTACTO,
      p.ID_TIPO_PERSONA, p.ID_ESTADO_PERSONA, p.ID_PARENTESCO, p.ID_CONDOMINIO, p.ID_PADRE,
      quien, ip, navegador, accion, cut(detalle, 500),
    ]
  );
});

/**
 * Evento sobre un parámetro global (TBL_LOG_PARAMETROS).
 * `antes` (opcional) es la fila previa, para dejar constancia del valor anterior.
 */
const logParametro = safe('evento de parámetro', async (db, req, { idParametro, parametro, accion, detalle, antes, responsable }) => {
  db = db || mysqlPool;
  const [[row]] = await db.query(
    `SELECT ID_PARAMETRO, ID_USUARIO, PARAMETRO, VALOR, FECHA_CREACION, FECHA_MODIFICACION
       FROM TBL_MS_PARAMETROS WHERE ${idParametro ? 'ID_PARAMETRO = ?' : 'PARAMETRO = ?'} LIMIT 1`,
    [idParametro || parametro]
  );
  const r = row || antes;
  if (!r) return;
  const { ip, navegador } = clientInfo(req);
  const quien = await responsableOf(db, req, responsable);
  let texto = detalle;
  if (!texto && antes && row && String(antes.VALOR) !== String(row.VALOR)) {
    texto = `Valor anterior: ${antes.VALOR} → nuevo: ${row.VALOR}`;
  }
  await db.query(
    `INSERT INTO TBL_LOG_PARAMETROS
      (ID_PARAMETRO, ID_USUARIO, PARAMETRO, VALOR, FECHA_CREACION, FECHA_MODIFICACION,
       FECHA_ELIMINACION, USUARIO_ELIMINACION, ORIGEN_IP, NAVEGADOR, ACCION, DETALLE)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
    [
      r.ID_PARAMETRO, sessionUserId(req) ?? r.ID_USUARIO ?? null, cut(r.PARAMETRO, 50), cut(r.VALOR, 255),
      r.FECHA_CREACION ?? null, r.FECHA_MODIFICACION ?? null,
      quien || 'Sistema', ip, navegador, accion, cut(texto, 500),
    ]
  );
});

/**
 * Evento de contraseña (TBL_LOG_HISTORIAL_CONTRASEÑA): cambio, restablecimiento
 * o depuración del historial. Nunca guarda la contraseña en texto plano; en los
 * eventos de cambio/restablecimiento tampoco se guarda el hash.
 */
const logContrasena = safe('evento de contraseña', async (db, req, { idUsuario, accion, detalle, idHist = 0, hash = '', responsable }) => {
  db = db || mysqlPool;
  const { ip, navegador } = clientInfo(req);
  const quien = await responsableOf(db, req, responsable);
  await db.query(
    `INSERT INTO \`TBL_LOG_HISTORIAL_CONTRASEÑA\`
      (ID_HIST, ID_USUARIO, \`CONTRASEÑA\`, FECHA_ELIMINACION, USUARIO_ELIMINACION, ORIGEN_IP, NAVEGADOR, ACCION, DETALLE)
     VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
    [idHist, idUsuario, hash, cut(quien, 50), ip, navegador, accion, cut(detalle, 500)]
  );
});

module.exports = { ACCION, clientInfo, logUsuario, logPersona, logParametro, logContrasena };
