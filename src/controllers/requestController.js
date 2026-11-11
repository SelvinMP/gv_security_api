const { mysqlPool } = require('../config/db');
const moment = require('moment-timezone');
const { sendMailWithTimeout } = require('../config/transporter');
const { notifyUser, buildEmailHtml } = require('../utils/notify');
const {
  getResidentInfo, getRequestUserId, isAdminRole, nowHN, nowHNString,
  addBusinessDays, getParametro, cleanText
} = require('../utils/resident');

const CANALES = ['PLATAFORMA', 'CORREO', 'FISICO'];
const ESTADO_RECIBIDA = 1;

const BASE_SELECT = `
  SELECT s.ID_SOLICITUD, s.NUM_SEGUIMIENTO, s.ID_USUARIO, s.NOMBRE_RESIDENTE, s.CANAL, s.ASUNTO,
         s.DESCRIPCION, s.JUSTIFICACION, s.FECHA_PRESENTACION, s.FECHA_LIMITE_RESPUESTA,
         s.RESPUESTA, s.FECHA_RESPUESTA, s.FECHA_MODIFICACION,
         s.ID_TIPO_SOLICITUD, ts.DESCRIPCION AS TIPO_SOLICITUD,
         s.ID_ESTADO_SOLICITUD, es.DESCRIPCION AS ESTADO_SOLICITUD,
         s.ID_CONDOMINIO, c.DESCRIPCION AS NUM_CASA,
         ur.NOMBRE_USUARIO AS RESPONDIDO_POR
    FROM TBL_SOLICITUDES s
    JOIN TBL_TIPO_SOLICITUD ts ON ts.ID_TIPO_SOLICITUD = s.ID_TIPO_SOLICITUD
    JOIN TBL_ESTADO_SOLICITUD es ON es.ID_ESTADO_SOLICITUD = s.ID_ESTADO_SOLICITUD
    LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = s.ID_CONDOMINIO
    LEFT JOIN TBL_MS_USUARIO ur ON ur.ID_USUARIO = s.ID_USUARIO_RESPONDE`;

const getRequestDetail = async (connection, where, params) => {
  const [rows] = await connection.query(`${BASE_SELECT} WHERE ${where} LIMIT 1`, params);
  if (rows.length === 0) return null;
  const [seguimiento] = await connection.query(
    `SELECT sg.ID_SOLICITUD_SEGUIMIENTO, sg.OBSERVACION, sg.FECHA_HORA, es.DESCRIPCION AS ESTADO_SOLICITUD,
            u.NOMBRE_USUARIO AS REGISTRADO_POR
       FROM TBL_SOLICITUD_SEGUIMIENTO sg
       JOIN TBL_ESTADO_SOLICITUD es ON es.ID_ESTADO_SOLICITUD = sg.ID_ESTADO_SOLICITUD
       LEFT JOIN TBL_MS_USUARIO u ON u.ID_USUARIO = sg.ID_USUARIO
      WHERE sg.ID_SOLICITUD = ?
      ORDER BY sg.FECHA_HORA ASC, sg.ID_SOLICITUD_SEGUIMIENTO ASC`,
    [rows[0].ID_SOLICITUD]
  );
  return { ...rows[0], seguimiento };
};

// GET /api/solicitudes/catalogos
const getCatalogs = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [tipos] = await connection.query('SELECT * FROM TBL_TIPO_SOLICITUD ORDER BY ID_TIPO_SOLICITUD ASC');
    const [estados] = await connection.query('SELECT * FROM TBL_ESTADO_SOLICITUD ORDER BY ID_ESTADO_SOLICITUD ASC');
    const plazo = Number(await getParametro(connection, 'PLAZO_RESPUESTA_SOLICITUD_DIAS', 15)) || 15;
    res.json({ tipos, estados, canales: CANALES, plazoDiasHabiles: plazo });
  } catch (error) {
    console.error('Error getCatalogs:', error);
    res.status(500).json({ message: 'Error al obtener catálogos de solicitudes' });
  } finally {
    if (connection) connection.release();
  }
};

// POST /api/solicitudes
const createRequest = async (req, res) => {
  const usuarioId = getRequestUserId(req);
  const asunto = cleanText(req.body.ASUNTO, 150);
  const descripcion = cleanText(req.body.DESCRIPCION, 3000);
  const justificacion = cleanText(req.body.JUSTIFICACION, 3000);
  const idTipo = Number(req.body.ID_TIPO_SOLICITUD);
  // Un residente siempre presenta por la plataforma; la administración puede
  // registrar solicitudes recibidas por correo o en físico.
  const canal = isAdminRole(req) && CANALES.includes(String(req.body.CANAL).toUpperCase())
    ? String(req.body.CANAL).toUpperCase() : 'PLATAFORMA';
  const solicitanteId = isAdminRole(req) && req.body.ID_USUARIO_SOLICITANTE ? req.body.ID_USUARIO_SOLICITANTE : usuarioId;

  if (!asunto || !descripcion || !justificacion || !idTipo) {
    return res.status(400).json({ message: 'Complete el tipo, asunto, descripción y justificación de la solicitud.' });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const residente = await getResidentInfo(connection, solicitanteId);
    if (!residente) return res.status(404).json({ message: 'Datos del residente no encontrados' });

    const [tipo] = await connection.query('SELECT DESCRIPCION FROM TBL_TIPO_SOLICITUD WHERE ID_TIPO_SOLICITUD = ?', [idTipo]);
    if (tipo.length === 0) return res.status(400).json({ message: 'Tipo de solicitud inválido.' });

    const plazo = Number(await getParametro(connection, 'PLAZO_RESPUESTA_SOLICITUD_DIAS', 15)) || 15;
    const ahora = nowHN();
    const fechaLimite = addBusinessDays(ahora, plazo).format('YYYY-MM-DD');

    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO TBL_SOLICITUDES
        (ID_USUARIO, ID_PERSONA, ID_CONDOMINIO, NOMBRE_RESIDENTE, ID_TIPO_SOLICITUD, ID_ESTADO_SOLICITUD, CANAL,
         ASUNTO, DESCRIPCION, JUSTIFICACION, FECHA_PRESENTACION, FECHA_LIMITE_RESPUESTA)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [solicitanteId, residente.ID_PERSONA, residente.ID_CONDOMINIO, residente.NOMBRE_USUARIO, idTipo, ESTADO_RECIBIDA,
        canal, asunto.toUpperCase(), descripcion, justificacion, ahora.format('YYYY-MM-DD HH:mm:ss'), fechaLimite]
    );
    const numSeguimiento = `SOL-${ahora.format('YYYY')}-${String(result.insertId).padStart(6, '0')}`;
    await connection.query('UPDATE TBL_SOLICITUDES SET NUM_SEGUIMIENTO = ? WHERE ID_SOLICITUD = ?', [numSeguimiento, result.insertId]);
    await connection.query(
      'INSERT INTO TBL_SOLICITUD_SEGUIMIENTO (ID_SOLICITUD, ID_ESTADO_SOLICITUD, OBSERVACION, ID_USUARIO, FECHA_HORA) VALUES (?, ?, ?, ?, ?)',
      [result.insertId, ESTADO_RECIBIDA, `Solicitud registrada por ${canal.toLowerCase()}. Número de seguimiento asignado.`, usuarioId, ahora.format('YYYY-MM-DD HH:mm:ss')]
    );
    await connection.commit();

    const detalle = await getRequestDetail(connection, 's.ID_SOLICITUD = ?', [result.insertId]);
    const rows = [
      { label: 'No. Seguimiento', value: numSeguimiento },
      { label: 'Casa', value: residente.CASA },
      { label: 'Tipo', value: tipo[0].DESCRIPCION },
      { label: 'Asunto', value: asunto.toUpperCase() },
      { label: 'Respuesta a más tardar', value: moment(fechaLimite).format('DD/MM/YYYY') }
    ];

    await notifyUser(connection, solicitanteId, {
      title: 'Solicitud recibida',
      message: `Su solicitud ${numSeguimiento} fue registrada. La Junta Directiva responderá a más tardar el ${moment(fechaLimite).format('DD/MM/YYYY')}.`,
      emailSubject: `Solicitud recibida - ${numSeguimiento}`,
      emailHtml: buildEmailHtml('Solicitud recibida', `Estimado(a) ${residente.NOMBRE_USUARIO}, su solicitud fue registrada en el sistema de la Administración.`, rows,
        `Puede dar seguimiento desde la app con el número ${numSeguimiento}. Plazo máximo de respuesta: ${plazo} días hábiles.`)
    });

    // Copia a la Administración (si está configurado el correo institucional)
    const correoAdmin = await getParametro(connection, 'CORREO_ADMINISTRACION', process.env.ADMIN_EMAIL || null);
    if (correoAdmin) {
      sendMailWithTimeout({
        from: `"GV-Security Solicitudes" <${process.env.EMAIL_USER}>`,
        to: correoAdmin,
        subject: `Nueva solicitud ${numSeguimiento} - Casa ${residente.CASA || 'N/A'}`,
        html: buildEmailHtml('Nueva solicitud de residente', `${residente.NOMBRE_USUARIO} presentó una nueva solicitud.`,
          [...rows, { label: 'Descripción', value: descripcion }, { label: 'Justificación', value: justificacion }])
      }).catch(err => console.log('Error correo administración:', err.message));
    }

    res.status(201).json({ success: true, message: 'Solicitud registrada', solicitud: detalle });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error createRequest:', error);
    res.status(500).json({ message: 'Error al registrar la solicitud' });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/solicitudes/mis-solicitudes
const getMyRequests = async (req, res) => {
  const usuarioId = getRequestUserId(req);
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(`${BASE_SELECT} WHERE s.ID_USUARIO = ? ORDER BY s.FECHA_PRESENTACION DESC`, [usuarioId]);
    res.json(rows);
  } catch (error) {
    console.error('Error getMyRequests:', error);
    res.status(500).json({ message: 'Error al obtener solicitudes' });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/solicitudes/seguimiento/:numero
const getRequestByTracking = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const detalle = await getRequestDetail(connection, 's.NUM_SEGUIMIENTO = ?', [String(req.params.numero || '').toUpperCase()]);
    if (!detalle) return res.status(404).json({ message: 'No se encontró una solicitud con ese número de seguimiento.' });
    if (!isAdminRole(req) && Number(detalle.ID_USUARIO) !== Number(getRequestUserId(req))) {
      return res.status(403).json({ message: 'Esta solicitud pertenece a otro residente.' });
    }
    res.json(detalle);
  } catch (error) {
    console.error('Error getRequestByTracking:', error);
    res.status(500).json({ message: 'Error al consultar la solicitud' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Informe periódico de transparencia (sin datos personales):
 * totales por tipo y por estado en el periodo.
 * GET /api/solicitudes/informe?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 */
const getTransparencyReport = async (req, res) => {
  const desde = moment(req.query.desde, 'YYYY-MM-DD', true).isValid() ? req.query.desde : nowHN().startOf('month').format('YYYY-MM-DD');
  const hasta = moment(req.query.hasta, 'YYYY-MM-DD', true).isValid() ? req.query.hasta : nowHN().format('YYYY-MM-DD');
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const range = [`${desde} 00:00:00`, `${hasta} 23:59:59`];
    const [porTipo] = await connection.query(
      `SELECT ts.DESCRIPCION AS TIPO, COUNT(s.ID_SOLICITUD) AS TOTAL
         FROM TBL_TIPO_SOLICITUD ts
         LEFT JOIN TBL_SOLICITUDES s ON s.ID_TIPO_SOLICITUD = ts.ID_TIPO_SOLICITUD AND s.FECHA_PRESENTACION BETWEEN ? AND ?
        GROUP BY ts.ID_TIPO_SOLICITUD, ts.DESCRIPCION ORDER BY ts.ID_TIPO_SOLICITUD`, range);
    const [porEstado] = await connection.query(
      `SELECT es.DESCRIPCION AS ESTADO, COUNT(s.ID_SOLICITUD) AS TOTAL
         FROM TBL_ESTADO_SOLICITUD es
         LEFT JOIN TBL_SOLICITUDES s ON s.ID_ESTADO_SOLICITUD = es.ID_ESTADO_SOLICITUD AND s.FECHA_PRESENTACION BETWEEN ? AND ?
        GROUP BY es.ID_ESTADO_SOLICITUD, es.DESCRIPCION ORDER BY es.ID_ESTADO_SOLICITUD`, range);
    const [[totales]] = await connection.query(
      `SELECT COUNT(*) AS TOTAL,
              SUM(CASE WHEN FECHA_RESPUESTA IS NOT NULL THEN 1 ELSE 0 END) AS RESPONDIDAS,
              SUM(CASE WHEN FECHA_RESPUESTA IS NOT NULL AND DATE(FECHA_RESPUESTA) <= FECHA_LIMITE_RESPUESTA THEN 1 ELSE 0 END) AS EN_PLAZO,
              SUM(CASE WHEN FECHA_RESPUESTA IS NULL AND FECHA_LIMITE_RESPUESTA < CURDATE() THEN 1 ELSE 0 END) AS VENCIDAS
         FROM TBL_SOLICITUDES WHERE FECHA_PRESENTACION BETWEEN ? AND ?`, range);
    // Listado público: número, tipo, asunto y estado (sin nombre ni casa del residente)
    const [listado] = await connection.query(
      `SELECT s.NUM_SEGUIMIENTO, ts.DESCRIPCION AS TIPO_SOLICITUD, s.ASUNTO, es.DESCRIPCION AS ESTADO_SOLICITUD,
              s.FECHA_PRESENTACION, s.FECHA_RESPUESTA
         FROM TBL_SOLICITUDES s
         JOIN TBL_TIPO_SOLICITUD ts ON ts.ID_TIPO_SOLICITUD = s.ID_TIPO_SOLICITUD
         JOIN TBL_ESTADO_SOLICITUD es ON es.ID_ESTADO_SOLICITUD = s.ID_ESTADO_SOLICITUD
        WHERE s.FECHA_PRESENTACION BETWEEN ? AND ?
        ORDER BY s.FECHA_PRESENTACION DESC`, range);

    res.json({
      desde, hasta,
      totales: {
        TOTAL: Number(totales.TOTAL) || 0,
        RESPONDIDAS: Number(totales.RESPONDIDAS) || 0,
        EN_PLAZO: Number(totales.EN_PLAZO) || 0,
        VENCIDAS: Number(totales.VENCIDAS) || 0
      },
      porTipo, porEstado, listado
    });
  } catch (error) {
    console.error('Error getTransparencyReport:', error);
    res.status(500).json({ message: 'Error al generar el informe' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── ADMINISTRACIÓN / JUNTA DIRECTIVA ───────────────────────────────────────

// GET /api/admin/solicitudes?estado=&tipo=&casa=
const adminListRequests = async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.estado) { filters.push('s.ID_ESTADO_SOLICITUD = ?'); params.push(Number(req.query.estado)); }
  if (req.query.tipo) { filters.push('s.ID_TIPO_SOLICITUD = ?'); params.push(Number(req.query.tipo)); }
  if (req.query.casa) { filters.push('c.DESCRIPCION = ?'); params.push(String(req.query.casa)); }
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(
      `${BASE_SELECT} ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY CAST(c.DESCRIPCION AS UNSIGNED) ASC, c.DESCRIPCION ASC, s.FECHA_PRESENTACION DESC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error adminListRequests:', error);
    res.status(500).json({ success: false, message: 'Error al obtener solicitudes' });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/admin/solicitudes/:id
const adminGetRequest = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const detalle = await getRequestDetail(connection, 's.ID_SOLICITUD = ?', [req.params.id]);
    if (!detalle) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    res.json({ success: true, data: detalle });
  } catch (error) {
    console.error('Error adminGetRequest:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la solicitud' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * PUT /api/admin/solicitudes/:id
 * body: { ID_ESTADO_SOLICITUD, OBSERVACION, RESPUESTA, notificar }
 * Registra el movimiento en el expediente y comunica al residente por correo.
 */
const adminUpdateRequest = async (req, res) => {
  const idEstado = Number(req.body.ID_ESTADO_SOLICITUD);
  const observacion = cleanText(req.body.OBSERVACION, 3000);
  const respuesta = cleanText(req.body.RESPUESTA, 5000);
  const adminId = req.user?.id || null;

  if (!idEstado) return res.status(400).json({ success: false, message: 'Seleccione el estado de la solicitud.' });
  if (!observacion && !respuesta) return res.status(400).json({ success: false, message: 'Agregue una observación o la respuesta oficial.' });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const actual = await getRequestDetail(connection, 's.ID_SOLICITUD = ?', [req.params.id]);
    if (!actual) return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });

    const [estado] = await connection.query('SELECT DESCRIPCION FROM TBL_ESTADO_SOLICITUD WHERE ID_ESTADO_SOLICITUD = ?', [idEstado]);
    if (estado.length === 0) return res.status(400).json({ success: false, message: 'Estado inválido.' });

    const ahora = nowHNString();
    await connection.beginTransaction();
    await connection.query(
      `UPDATE TBL_SOLICITUDES
          SET ID_ESTADO_SOLICITUD = ?, FECHA_MODIFICACION = ?,
              RESPUESTA = COALESCE(?, RESPUESTA),
              FECHA_RESPUESTA = CASE WHEN ? IS NOT NULL THEN ? ELSE FECHA_RESPUESTA END,
              ID_USUARIO_RESPONDE = CASE WHEN ? IS NOT NULL THEN ? ELSE ID_USUARIO_RESPONDE END
        WHERE ID_SOLICITUD = ?`,
      [idEstado, ahora, respuesta, respuesta, ahora, respuesta, adminId, actual.ID_SOLICITUD]
    );
    await connection.query(
      'INSERT INTO TBL_SOLICITUD_SEGUIMIENTO (ID_SOLICITUD, ID_ESTADO_SOLICITUD, OBSERVACION, ID_USUARIO, FECHA_HORA) VALUES (?, ?, ?, ?, ?)',
      [actual.ID_SOLICITUD, idEstado, [observacion, respuesta ? `RESPUESTA OFICIAL: ${respuesta}` : null].filter(Boolean).join('\n'), adminId, ahora]
    );
    await connection.commit();

    if (req.body.notificar !== false) {
      await notifyUser(connection, actual.ID_USUARIO, {
        title: `Solicitud ${actual.NUM_SEGUIMIENTO}: ${estado[0].DESCRIPCION}`,
        message: respuesta || observacion,
        emailSubject: `Actualización de su solicitud ${actual.NUM_SEGUIMIENTO}`,
        emailHtml: buildEmailHtml(
          'Actualización de su solicitud',
          `Estimado(a) ${actual.NOMBRE_RESIDENTE}, la Administración / Junta Directiva actualizó su solicitud.`,
          [
            { label: 'No. Seguimiento', value: actual.NUM_SEGUIMIENTO },
            { label: 'Asunto', value: actual.ASUNTO },
            { label: 'Estado', value: estado[0].DESCRIPCION },
            { label: 'Observaciones', value: observacion },
            { label: 'Respuesta oficial', value: respuesta }
          ],
          'Esta comunicación queda archivada en su expediente de residente.'
        )
      });
    }

    const detalle = await getRequestDetail(connection, 's.ID_SOLICITUD = ?', [actual.ID_SOLICITUD]);
    res.json({ success: true, message: 'Solicitud actualizada y comunicada al residente', data: detalle });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error adminUpdateRequest:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la solicitud' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getRequestDetail,
  getCatalogs,
  createRequest,
  getMyRequests,
  getRequestByTracking,
  getTransparencyReport,
  adminListRequests,
  adminGetRequest,
  adminUpdateRequest
};
