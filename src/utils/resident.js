const moment = require('moment-timezone');

const TZ = 'America/Tegucigalpa';
const nowHN = () => moment().tz(TZ);
const nowHNString = () => nowHN().format('YYYY-MM-DD HH:mm:ss');

/**
 * Datos del residente para QR, reportes y correos.
 */
const getResidentInfo = async (connection, usuarioId) => {
  const [rows] = await connection.query(
    `SELECT p.ID_PERSONA, p.ID_CONDOMINIO, u.ID_USUARIO, u.NOMBRE_USUARIO, u.EMAIL,
            p.DNI_PERSONA, p.NUM_CARNET_EXTRANJERO,
            c.DESCRIPCION AS CONTACTO, d.DESCRIPCION AS CASA
       FROM TBL_MS_USUARIO u
       LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = u.ID_USUARIO
       LEFT JOIN TBL_CONTACTOS c ON p.ID_CONTACTO = c.ID_CONTACTO
       LEFT JOIN TBL_CONDOMINIOS d ON p.ID_CONDOMINIO = d.ID_CONDOMINIO
      WHERE u.ID_USUARIO = ?`,
    [usuarioId]
  );
  return rows[0] || null;
};

/**
 * Usuario autenticado: se prioriza el id del JWT; si la ruta no usa JWT se
 * acepta el usuarioId enviado (mismo estándar que las rutas existentes).
 */
const getRequestUserId = (req) =>
  (req.user && req.user.id) ||
  req.body?.usuarioId || req.params?.usuarioId || req.query?.usuarioId || null;

const isAdminRole = (req) => req.user && [1, 4].includes(Number(req.user.role));

/**
 * Suma N días hábiles (lunes a viernes) a una fecha moment.
 */
const addBusinessDays = (start, days) => {
  const d = start.clone();
  let added = 0;
  while (added < days) {
    d.add(1, 'day');
    const dow = d.isoWeekday();
    if (dow <= 5) added++;
  }
  return d;
};

const getParametro = async (connection, nombre, defecto = null) => {
  const [rows] = await connection.query('SELECT VALOR FROM TBL_MS_PARAMETROS WHERE PARAMETRO = ? LIMIT 1', [nombre]);
  return rows.length > 0 && rows[0].VALOR !== null && rows[0].VALOR !== '' ? rows[0].VALOR : defecto;
};

const cleanText = (value, max = 255) =>
  value === undefined || value === null ? null : String(value).trim().slice(0, max) || null;

module.exports = {
  TZ,
  nowHN,
  nowHNString,
  getResidentInfo,
  getRequestUserId,
  isAdminRole,
  addBusinessDays,
  getParametro,
  cleanText
};
