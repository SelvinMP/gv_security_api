/**
 * Políticas / reglamento de la residencial.
 *
 * - El administrador (roles 1 y 4) registra políticas y elige a qué roles van
 *   dirigidas (TBL_POLITICA_ROL). Flujo: BORRADOR → PUBLICADA → ARCHIVADA.
 * - Residentes (2) y guardias (3) solo leen las PUBLICADAS y vigentes dirigidas a su rol.
 * - Super Admin y Administrador leen todas las publicadas (y pueden "ver como" otro rol).
 *
 * El rol se toma SIEMPRE del JWT, nunca de lo que envíe el cliente.
 */
const fs = require('fs');
const path = require('path');
const { mysqlPool } = require('../config/db');
const { policyDir } = require('../config/upload');
const { sendPush } = require('../config/firebase');

const ADMIN_ROLES = [1, 4];
const ESTADOS = ['BORRADOR', 'PUBLICADA', 'ARCHIVADA'];
const isAdmin = (req) => ADMIN_ROLES.includes(Number(req.user?.role));

const VIGENTE_SQL = `p.ESTADO = 'PUBLICADA'
  AND (p.VIGENTE_DESDE IS NULL OR p.VIGENTE_DESDE <= CURDATE())
  AND (p.VIGENTE_HASTA IS NULL OR p.VIGENTE_HASTA >= CURDATE())`;

const BASE_SELECT = `
  SELECT p.ID_POLITICA, p.TITULO, p.RESUMEN, p.CONTENIDO, p.ID_CATEGORIA,
         COALESCE(c.DESCRIPCION, 'GENERAL') AS CATEGORIA, c.ORDEN AS ORDEN_CATEGORIA,
         (p.ARCHIVO_PDF IS NOT NULL) AS TIENE_PDF,
         p.ESTADO, p.VIGENTE_DESDE, p.VIGENTE_HASTA, p.FECHA_PUBLICACION,
         p.FECHA_CREACION, p.FECHA_MODIFICACION,
         uc.NOMBRE_USUARIO AS CREADO_POR, um.NOMBRE_USUARIO AS MODIFICADO_POR,
         GROUP_CONCAT(DISTINCT pr.ID_ROL ORDER BY pr.ID_ROL) AS ROLES_IDS,
         GROUP_CONCAT(DISTINCT r.ROL ORDER BY pr.ID_ROL SEPARATOR ', ') AS ROLES,
         (p.FECHA_PUBLICACION >= NOW() - INTERVAL 7 DAY) AS ES_NUEVA,
         (p.FECHA_MODIFICACION IS NOT NULL AND p.FECHA_PUBLICACION IS NOT NULL
           AND p.FECHA_MODIFICACION > p.FECHA_PUBLICACION + INTERVAL 1 HOUR
           AND p.FECHA_MODIFICACION >= NOW() - INTERVAL 7 DAY) AS ES_ACTUALIZADA
    FROM TBL_POLITICAS p
    LEFT JOIN TBL_CATEGORIA_POLITICA c ON c.ID_CATEGORIA = p.ID_CATEGORIA
    LEFT JOIN TBL_POLITICA_ROL pr ON pr.ID_POLITICA = p.ID_POLITICA
    LEFT JOIN TBL_MS_ROLES r ON r.ID_ROL = pr.ID_ROL
    LEFT JOIN TBL_MS_USUARIO uc ON uc.ID_USUARIO = p.CREADO_POR
    LEFT JOIN TBL_MS_USUARIO um ON um.ID_USUARIO = p.MODIFICADO_POR`;

const normalize = (row) => ({
  ...row,
  TIENE_PDF: Boolean(Number(row.TIENE_PDF)),
  ES_NUEVA: Boolean(Number(row.ES_NUEVA)),
  ES_ACTUALIZADA: Boolean(Number(row.ES_ACTUALIZADA)),
  ROLES_IDS: row.ROLES_IDS ? String(row.ROLES_IDS).split(',').map(Number) : [],
});

/** Condición de lectura según el rol del usuario (o el rol que el admin quiere previsualizar). */
const readerFilter = (req) => {
  const role = Number(req.user?.role);
  const verComo = Number(req.query.verComo);
  if (isAdmin(req) && !verComo) return { sql: VIGENTE_SQL, params: [] };
  const targetRole = isAdmin(req) && verComo ? verComo : role;
  return {
    sql: `${VIGENTE_SQL} AND EXISTS (SELECT 1 FROM TBL_POLITICA_ROL x WHERE x.ID_POLITICA = p.ID_POLITICA AND x.ID_ROL = ?)`,
    params: [targetRole],
  };
};

/**
 * Políticas publicadas y vigentes que puede leer un rol (los administradores leen todas).
 * Lo usa el módulo de IA para responder preguntas sobre el reglamento.
 */
const listPoliticasParaRol = async (role) => {
  const admin = ADMIN_ROLES.includes(Number(role));
  const sql = admin
    ? VIGENTE_SQL
    : `${VIGENTE_SQL} AND EXISTS (SELECT 1 FROM TBL_POLITICA_ROL x WHERE x.ID_POLITICA = p.ID_POLITICA AND x.ID_ROL = ?)`;
  const [rows] = await mysqlPool.query(
    `${BASE_SELECT} WHERE ${sql} GROUP BY p.ID_POLITICA ORDER BY ORDEN_CATEGORIA IS NULL, ORDEN_CATEGORIA, p.TITULO`,
    admin ? [] : [Number(role)]
  );
  return rows.map(normalize);
};

const fail = (res, err, msg) => {
  console.error(msg, err);
  res.status(500).json({ success: false, message: msg });
};

// ─────────────────────────── LECTURA (todos los roles) ───────────────────────────

const getCategorias = async (req, res) => {
  try {
    const [rows] = await mysqlPool.query('SELECT ID_CATEGORIA, DESCRIPCION FROM TBL_CATEGORIA_POLITICA ORDER BY ORDEN, DESCRIPCION');
    res.json({ success: true, data: rows });
  } catch (err) {
    fail(res, err, 'Error al consultar las categorías de políticas.');
  }
};

/** Políticas visibles para el usuario en sesión. */
const getPoliticas = async (req, res) => {
  try {
    const f = readerFilter(req);
    const [rows] = await mysqlPool.query(
      `${BASE_SELECT} WHERE ${f.sql} GROUP BY p.ID_POLITICA ORDER BY ORDEN_CATEGORIA IS NULL, ORDEN_CATEGORIA, p.TITULO`,
      f.params
    );
    res.json({ success: true, data: rows.map(normalize) });
  } catch (err) {
    fail(res, err, 'Error al consultar las políticas.');
  }
};

const findReadable = async (req, id) => {
  const f = readerFilter(req);
  const [rows] = await mysqlPool.query(
    `${BASE_SELECT} WHERE p.ID_POLITICA = ? AND ${f.sql} GROUP BY p.ID_POLITICA`,
    [id, ...f.params]
  );
  return rows[0] || null;
};

const getPolitica = async (req, res) => {
  try {
    const row = await findReadable(req, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Política no encontrada o no disponible para su rol.' });
    res.json({ success: true, data: normalize(row) });
  } catch (err) {
    fail(res, err, 'Error al consultar la política.');
  }
};

/** Descarga del PDF adjunto validando que el usuario pueda leer la política. */
const getPoliticaPdf = async (req, res) => {
  try {
    let allowed = await findReadable(req, req.params.id);
    if (!allowed && isAdmin(req)) {
      // Los administradores pueden ver el PDF de borradores y archivadas
      const [[r]] = await mysqlPool.query('SELECT ID_POLITICA FROM TBL_POLITICAS WHERE ID_POLITICA = ?', [req.params.id]);
      allowed = r;
    }
    if (!allowed) return res.status(404).json({ success: false, message: 'Documento no disponible.' });

    const [[p]] = await mysqlPool.query('SELECT TITULO, ARCHIVO_PDF FROM TBL_POLITICAS WHERE ID_POLITICA = ?', [req.params.id]);
    if (!p?.ARCHIVO_PDF) return res.status(404).json({ success: false, message: 'La política no tiene PDF adjunto.' });

    const file = path.join(policyDir, path.basename(p.ARCHIVO_PDF));
    if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: 'El archivo PDF ya no está disponible en el servidor.' });

    const safeName = String(p.TITULO).replace(/[^\w\s.-]/g, '').trim().slice(0, 80) || 'politica';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}.pdf"`);
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    fail(res, err, 'Error al descargar el PDF.');
  }
};

// ─────────────────────────── ADMINISTRACIÓN (roles 1 y 4) ───────────────────────────

const adminListPoliticas = async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(
      `${BASE_SELECT} GROUP BY p.ID_POLITICA
       ORDER BY FIELD(p.ESTADO, 'BORRADOR', 'PUBLICADA', 'ARCHIVADA'), COALESCE(p.FECHA_MODIFICACION, p.FECHA_CREACION) DESC`
    );
    res.json({ success: true, data: rows.map(normalize) });
  } catch (err) {
    fail(res, err, 'Error al consultar las políticas.');
  }
};

/** Valida y normaliza el cuerpo de creación / edición. */
const parseBody = async (body, connection) => {
  const titulo = String(body.TITULO ?? '').trim();
  const contenido = String(body.CONTENIDO ?? '').trim();
  if (!titulo) return { error: 'El título es obligatorio.' };
  if (titulo.length > 150) return { error: 'El título admite máximo 150 caracteres.' };
  if (!contenido) return { error: 'El contenido de la política es obligatorio.' };
  const resumen = String(body.RESUMEN ?? '').trim();
  if (resumen.length > 300) return { error: 'El resumen admite máximo 300 caracteres.' };

  const roles = [...new Set((Array.isArray(body.ROLES) ? body.ROLES : []).map(Number).filter(Boolean))];
  if (roles.length) {
    const [valid] = await connection.query('SELECT ID_ROL FROM TBL_MS_ROLES WHERE ID_ROL IN (?)', [roles]);
    if (valid.length !== roles.length) return { error: 'Uno de los roles seleccionados no existe.' };
  }

  const date = (v) => (v ? String(v).slice(0, 10) : null);
  const desde = date(body.VIGENTE_DESDE);
  const hasta = date(body.VIGENTE_HASTA);
  if (desde && hasta && hasta < desde) return { error: 'La fecha "vigente hasta" no puede ser anterior a "vigente desde".' };

  const pdf = body.ARCHIVO_PDF ? path.basename(String(body.ARCHIVO_PDF)) : null;
  if (pdf && !/^politica_[\w-]+\.pdf$/.test(pdf)) return { error: 'Archivo PDF no válido.' };

  return {
    values: {
      TITULO: titulo,
      RESUMEN: resumen || null,
      CONTENIDO: contenido,
      ID_CATEGORIA: body.ID_CATEGORIA ? Number(body.ID_CATEGORIA) : null,
      ARCHIVO_PDF: pdf,
      VIGENTE_DESDE: desde,
      VIGENTE_HASTA: hasta,
    },
    roles,
  };
};

const saveRoles = async (connection, id, roles) => {
  await connection.query('DELETE FROM TBL_POLITICA_ROL WHERE ID_POLITICA = ?', [id]);
  if (roles.length) {
    await connection.query('INSERT INTO TBL_POLITICA_ROL (ID_POLITICA, ID_ROL) VALUES ?', [roles.map(r => [id, r])]);
  }
};

/** Avisa (notificación en la app + push) a los usuarios activos de los roles destinatarios. */
const notifyAudience = async (connection, id, tipo) => {
  try {
    const [[p]] = await connection.query('SELECT TITULO, RESUMEN FROM TBL_POLITICAS WHERE ID_POLITICA = ?', [id]);
    const [users] = await connection.query(
      `SELECT DISTINCT u.ID_USUARIO, u.FCM_TOKEN
         FROM TBL_MS_USUARIO u
         JOIN TBL_POLITICA_ROL pr ON pr.ID_ROL = u.ID_ROL AND pr.ID_POLITICA = ?
        WHERE u.ID_ESTADO_USUARIO = 1`,
      [id]
    );
    if (!p || users.length === 0) return 0;
    const titulo = tipo === 'actualizada' ? `Reglamento actualizado: ${p.TITULO}` : `Nueva política: ${p.TITULO}`;
    const mensaje = p.RESUMEN || 'La administración publicó una política del reglamento. Revísala en la sección Reglamento.';
    await connection.query(
      `INSERT INTO TBL_NOTIFICACIONES_APP (ID_USUARIO, TITULO, MENSAJE, FECHA_HORA, LEIDA)
       SELECT ID_USUARIO, ?, ?, NOW(), 0 FROM TBL_MS_USUARIO WHERE ID_USUARIO IN (?)`,
      [titulo.slice(0, 150), mensaje, users.map(u => u.ID_USUARIO)]
    );
    sendPush(users.map(u => u.FCM_TOKEN), { title: titulo, body: mensaje, link: '/reglamento', data: { tipo: 'politica', politicaId: String(id) } })
      .catch(e => console.warn('[políticas] Push no enviado:', e.message));
    return users.length;
  } catch (err) {
    console.warn('[políticas] No se pudo notificar a los destinatarios:', err.message);
    return 0;
  }
};

const createPolitica = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const parsed = await parseBody(req.body, connection);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const publicar = String(req.body.ESTADO || '').toUpperCase() === 'PUBLICADA';
    if (publicar && parsed.roles.length === 0) {
      return res.status(400).json({ success: false, message: 'Seleccione al menos un rol destinatario para publicar.' });
    }

    await connection.beginTransaction();
    const v = parsed.values;
    const [ins] = await connection.query(
      `INSERT INTO TBL_POLITICAS (TITULO, RESUMEN, CONTENIDO, ID_CATEGORIA, ARCHIVO_PDF, ESTADO, VIGENTE_DESDE, VIGENTE_HASTA,
                                  FECHA_PUBLICACION, CREADO_POR, FECHA_CREACION)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${publicar ? 'NOW()' : 'NULL'}, ?, NOW())`,
      [v.TITULO, v.RESUMEN, v.CONTENIDO, v.ID_CATEGORIA, v.ARCHIVO_PDF, publicar ? 'PUBLICADA' : 'BORRADOR', v.VIGENTE_DESDE, v.VIGENTE_HASTA, req.user.id]
    );
    await saveRoles(connection, ins.insertId, parsed.roles);
    await connection.commit();

    let notificados = 0;
    if (publicar && req.body.notificar !== false) notificados = await notifyAudience(connection, ins.insertId, 'nueva');

    res.status(201).json({
      success: true,
      id: ins.insertId,
      message: publicar
        ? `Política publicada${notificados ? `; se notificó a ${notificados} usuario(s)` : ''}.`
        : 'Política guardada como borrador.',
    });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    fail(res, err, 'Error al registrar la política.');
  } finally {
    if (connection) connection.release();
  }
};

const updatePolitica = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [[actual]] = await connection.query('SELECT ESTADO, ARCHIVO_PDF FROM TBL_POLITICAS WHERE ID_POLITICA = ?', [id]);
    if (!actual) return res.status(404).json({ success: false, message: 'Política no encontrada.' });

    const parsed = await parseBody(req.body, connection);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    if (actual.ESTADO === 'PUBLICADA' && parsed.roles.length === 0) {
      return res.status(400).json({ success: false, message: 'Una política publicada debe tener al menos un rol destinatario.' });
    }

    await connection.beginTransaction();
    const v = parsed.values;
    // Sin ARCHIVO_PDF en el cuerpo = conservar el actual; null = quitarlo; nombre = reemplazarlo
    if (!Object.prototype.hasOwnProperty.call(req.body, 'ARCHIVO_PDF')) v.ARCHIVO_PDF = actual.ARCHIVO_PDF;
    await connection.query(
      `UPDATE TBL_POLITICAS SET TITULO = ?, RESUMEN = ?, CONTENIDO = ?, ID_CATEGORIA = ?, ARCHIVO_PDF = ?,
              VIGENTE_DESDE = ?, VIGENTE_HASTA = ?, MODIFICADO_POR = ?, FECHA_MODIFICACION = NOW()
        WHERE ID_POLITICA = ?`,
      [v.TITULO, v.RESUMEN, v.CONTENIDO, v.ID_CATEGORIA, v.ARCHIVO_PDF, v.VIGENTE_DESDE, v.VIGENTE_HASTA, req.user.id, id]
    );
    await saveRoles(connection, id, parsed.roles);
    await connection.commit();

    // Si se reemplazó o quitó el PDF, borrar el archivo anterior
    if (actual.ARCHIVO_PDF && actual.ARCHIVO_PDF !== v.ARCHIVO_PDF) removePdf(actual.ARCHIVO_PDF);

    let notificados = 0;
    if (actual.ESTADO === 'PUBLICADA' && req.body.notificar === true) notificados = await notifyAudience(connection, id, 'actualizada');

    res.json({ success: true, message: `Política actualizada${notificados ? `; se notificó a ${notificados} usuario(s)` : ''}.` });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    fail(res, err, 'Error al actualizar la política.');
  } finally {
    if (connection) connection.release();
  }
};

/** Publicar, archivar o regresar a borrador. */
const setEstadoPolitica = async (req, res) => {
  const { id } = req.params;
  const estado = String(req.body.ESTADO || '').toUpperCase();
  if (!ESTADOS.includes(estado)) return res.status(400).json({ success: false, message: 'Estado no válido.' });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [[p]] = await connection.query(
      `SELECT p.ESTADO, p.FECHA_PUBLICACION, COUNT(pr.ID_ROL) AS ROLES
         FROM TBL_POLITICAS p LEFT JOIN TBL_POLITICA_ROL pr ON pr.ID_POLITICA = p.ID_POLITICA
        WHERE p.ID_POLITICA = ? GROUP BY p.ID_POLITICA`,
      [id]
    );
    if (!p) return res.status(404).json({ success: false, message: 'Política no encontrada.' });
    if (estado === 'PUBLICADA' && Number(p.ROLES) === 0) {
      return res.status(400).json({ success: false, message: 'Seleccione al menos un rol destinatario antes de publicar.' });
    }

    const primeraPublicacion = estado === 'PUBLICADA' && !p.FECHA_PUBLICACION;
    await connection.query(
      `UPDATE TBL_POLITICAS SET ESTADO = ?, MODIFICADO_POR = ?, FECHA_MODIFICACION = NOW()
              ${estado === 'PUBLICADA' ? ', FECHA_PUBLICACION = COALESCE(FECHA_PUBLICACION, NOW())' : ''}
        WHERE ID_POLITICA = ?`,
      [estado, req.user.id, id]
    );

    let notificados = 0;
    if (estado === 'PUBLICADA' && p.ESTADO !== 'PUBLICADA' && req.body.notificar !== false) {
      notificados = await notifyAudience(connection, id, primeraPublicacion ? 'nueva' : 'actualizada');
    }

    const label = { BORRADOR: 'regresada a borrador', PUBLICADA: 'publicada', ARCHIVADA: 'archivada' }[estado];
    res.json({ success: true, message: `Política ${label}${notificados ? `; se notificó a ${notificados} usuario(s)` : ''}.` });
  } catch (err) {
    fail(res, err, 'Error al cambiar el estado de la política.');
  } finally {
    if (connection) connection.release();
  }
};

/** Solo se eliminan borradores; lo publicado se archiva para conservar el historial. */
const deletePolitica = async (req, res) => {
  try {
    const [[p]] = await mysqlPool.query('SELECT ESTADO, ARCHIVO_PDF FROM TBL_POLITICAS WHERE ID_POLITICA = ?', [req.params.id]);
    if (!p) return res.status(404).json({ success: false, message: 'Política no encontrada.' });
    if (p.ESTADO !== 'BORRADOR') {
      return res.status(400).json({ success: false, message: 'Solo se pueden eliminar borradores. Las políticas publicadas se archivan.' });
    }
    await mysqlPool.query('DELETE FROM TBL_POLITICAS WHERE ID_POLITICA = ?', [req.params.id]);
    if (p.ARCHIVO_PDF) removePdf(p.ARCHIVO_PDF);
    res.json({ success: true, message: 'Borrador eliminado.' });
  } catch (err) {
    fail(res, err, 'Error al eliminar la política.');
  }
};

/** Recibe el PDF (multer) y devuelve el nombre del archivo para guardarlo en la política. */
const uploadPoliticaPdf = (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No se recibió ningún PDF.' });
  res.json({ success: true, archivo: req.file.filename, nombreOriginal: req.file.originalname });
};

const removePdf = (name) => {
  fs.unlink(path.join(policyDir, path.basename(name)), () => {});
};

module.exports = {
  listPoliticasParaRol,
  getCategorias,
  getPoliticas,
  getPolitica,
  getPoliticaPdf,
  adminListPoliticas,
  createPolitica,
  updatePolitica,
  setEstadoPolitica,
  deletePolitica,
  uploadPoliticaPdf,
};
