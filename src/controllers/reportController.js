const { mysqlPool } = require('../config/db');
const moment = require('moment-timezone');

/**
 * Filtros comunes: ?casa=<DESCRIPCION condominio>&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 */
const buildFilters = (req, casaColumn, dateColumn) => {
  const filters = [];
  const params = [];
  if (req.query.casa) { filters.push(`${casaColumn} = ?`); params.push(String(req.query.casa)); }
  if (moment(req.query.desde, 'YYYY-MM-DD', true).isValid()) { filters.push(`${dateColumn} >= ?`); params.push(`${req.query.desde} 00:00:00`); }
  if (moment(req.query.hasta, 'YYYY-MM-DD', true).isValid()) { filters.push(`${dateColumn} <= ?`); params.push(`${req.query.hasta} 23:59:59`); }
  return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', params };
};

/**
 * Reporte de paquetes por número de casa.
 * GET /api/admin/reportes/paquetes
 */
const getPackagesReport = async (req, res) => {
  const { where, params } = buildFilters(req, 'c.DESCRIPCION', 'COALESCE(pq.FECHA_RECEPCION, pq.FECHA_HORA)');
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(
      `SELECT pq.ID_PAQUETE,
              c.DESCRIPCION AS NUM_CASA,
              u.NOMBRE_USUARIO AS NOMBRE_RESIDENTE,
              pq.REMITENTE, pq.TIPO_REMITENTE,
              t.DESCRIPCION AS TAMANO,
              pq.FECHA_ESTIMADA_ENTREGA,
              pq.FECHA_HORA AS FECHA_CREACION,
              pq.FECHA_RECEPCION,
              CASE WHEN pq.ESTADO_QR = 1 THEN 'RECIBIDO' ELSE 'PENDIENTE' END AS ESTADO,
              pq.ESTADO_PAQUETE,
              pq.OBSERVACIONES_GUARDIA,
              pq.DESCRIPCION AS NOTA_RESIDENTE,
              ug.NOMBRE_USUARIO AS NOMBRE_GUARDIA,
              geo.NOMBRE_ZONA AS GEOCERCA_ZONA
         FROM TBL_PAQUETES pq
         JOIN TBL_TAMANO_PAQUETE t ON t.ID_TAMANO_PAQUETE = pq.ID_TAMANO_PAQUETE
         JOIN TBL_MS_USUARIO u ON u.ID_USUARIO = pq.ID_USUARIO
         LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = pq.ID_CONDOMINIO
         LEFT JOIN TBL_MS_USUARIO ug ON ug.ID_USUARIO = pq.ID_USUARIO_GUARDIA
         LEFT JOIN TBL_GEOCERCAS geo ON geo.ID_GEOCERCA = pq.ID_GEOCERCA
         ${where}
        ORDER BY CAST(c.DESCRIPCION AS UNSIGNED) ASC, c.DESCRIPCION ASC, COALESCE(pq.FECHA_RECEPCION, pq.FECHA_HORA) DESC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getPackagesReport:', error);
    res.status(500).json({ success: false, message: 'Error al generar el reporte de paquetes' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Reporte de QR múltiples (reuniones) por número de casa: un registro por
 * visitante autorizado con su hora de ingreso y observaciones.
 * GET /api/admin/reportes/eventos
 */
const getEventsReport = async (req, res) => {
  const { where, params } = buildFilters(req, 'c.DESCRIPCION', 'e.FECHA_EVENTO');
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [eventos] = await connection.query(
      `SELECT e.ID_EVENTO_VISITA,
              c.DESCRIPCION AS NUM_CASA,
              u.NOMBRE_USUARIO AS NOMBRE_RESIDENTE,
              e.TITULO, e.FECHA_EVENTO, e.HORA_INICIO, e.HORA_FIN,
              e.OBSERVACIONES_RESIDENTE, e.OBSERVACIONES_GUARDIA,
              (SELECT COUNT(*) FROM TBL_EVENTO_INVITADOS i WHERE i.ID_EVENTO_VISITA = e.ID_EVENTO_VISITA) AS TOTAL_AUTORIZADOS,
              (SELECT COUNT(*) FROM TBL_EVENTO_INVITADOS i WHERE i.ID_EVENTO_VISITA = e.ID_EVENTO_VISITA AND i.INGRESADO = 1) AS TOTAL_INGRESADOS
         FROM TBL_EVENTOS_VISITA e
         JOIN TBL_MS_USUARIO u ON u.ID_USUARIO = e.ID_USUARIO
         LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = e.ID_CONDOMINIO
         ${where}
        ORDER BY CAST(c.DESCRIPCION AS UNSIGNED) ASC, c.DESCRIPCION ASC, e.FECHA_EVENTO DESC`,
      params
    );

    if (eventos.length > 0) {
      const ids = eventos.map(e => e.ID_EVENTO_VISITA);
      const [invitados] = await connection.query(
        `SELECT i.ID_EVENTO_VISITA, i.NOMBRE_COMPLETO, i.DOCUMENTO, i.INGRESADO, i.FECHA_INGRESO,
                ug.NOMBRE_USUARIO AS NOMBRE_GUARDIA
           FROM TBL_EVENTO_INVITADOS i
           LEFT JOIN TBL_MS_USUARIO ug ON ug.ID_USUARIO = i.ID_USUARIO_GUARDIA
          WHERE i.ID_EVENTO_VISITA IN (?)
          ORDER BY i.ID_EVENTO_INVITADO ASC`,
        [ids]
      );
      const byEvent = new Map();
      invitados.forEach(i => {
        if (!byEvent.has(i.ID_EVENTO_VISITA)) byEvent.set(i.ID_EVENTO_VISITA, []);
        byEvent.get(i.ID_EVENTO_VISITA).push(i);
      });
      eventos.forEach(e => { e.invitados = byEvent.get(e.ID_EVENTO_VISITA) || []; });
    }

    res.json({ success: true, data: eventos });
  } catch (error) {
    console.error('Error getEventsReport:', error);
    res.status(500).json({ success: false, message: 'Error al generar el reporte de reuniones' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { getPackagesReport, getEventsReport };
