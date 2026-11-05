const { mysqlPool } = require('../config/db');
const moment = require('moment-timezone');
const { buildEncryptedQR, QR_TYPES } = require('../utils/qrCrypto');
const { TZ, getResidentInfo, getRequestUserId, isAdminRole, nowHN, nowHNString, cleanText } = require('../utils/resident');

const MAX_INVITADOS = 100;

const getEventWithGuests = async (connection, id) => {
  const [rows] = await connection.query(
    `SELECT e.*, c.DESCRIPCION AS CASA, u.NOMBRE_USUARIO AS RESIDENTE
       FROM TBL_EVENTOS_VISITA e
       JOIN TBL_MS_USUARIO u ON u.ID_USUARIO = e.ID_USUARIO
       LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = e.ID_CONDOMINIO
      WHERE e.ID_EVENTO_VISITA = ?`,
    [id]
  );
  if (rows.length === 0) return null;
  const [invitados] = await connection.query(
    `SELECT i.ID_EVENTO_INVITADO, i.NOMBRE_COMPLETO, i.DOCUMENTO, i.INGRESADO, i.FECHA_INGRESO,
            ug.NOMBRE_USUARIO AS NOMBRE_GUARDIA
       FROM TBL_EVENTO_INVITADOS i
       LEFT JOIN TBL_MS_USUARIO ug ON ug.ID_USUARIO = i.ID_USUARIO_GUARDIA
      WHERE i.ID_EVENTO_VISITA = ?
      ORDER BY i.ID_EVENTO_INVITADO ASC`,
    [id]
  );
  return { ...rows[0], invitados };
};

/** Fecha/hora (zona Honduras) en la que termina la validez del QR. */
const getEventEnd = (evento) =>
  moment.tz(`${moment(evento.FECHA_EVENTO).format('YYYY-MM-DD')} ${evento.HORA_FIN}`, 'YYYY-MM-DD HH:mm:ss', TZ);

const buildEventCard = (evento, qrCode) => ({
  ID_EVENTO_VISITA: evento.ID_EVENTO_VISITA,
  TITULO: evento.TITULO,
  Residente: evento.RESIDENTE,
  Condominio: evento.CASA || 'N/A',
  FECHA_EVENTO: moment(evento.FECHA_EVENTO).format('YYYY-MM-DD'),
  HORA_INICIO: String(evento.HORA_INICIO).slice(0, 5),
  HORA_FIN: String(evento.HORA_FIN).slice(0, 5),
  TOTAL_INVITADOS: evento.invitados.length,
  OBSERVACIONES_RESIDENTE: evento.OBSERVACIONES_RESIDENTE,
  qrCode
});

const normalizeTime = (value) => {
  const m = moment(String(value || ''), ['HH:mm', 'HH:mm:ss'], true);
  return m.isValid() ? m.format('HH:mm:ss') : null;
};

const validateEventInput = (body) => {
  const titulo = cleanText(body.TITULO, 100);
  const fecha = body.FECHA_EVENTO;
  const horaInicio = normalizeTime(body.HORA_INICIO);
  const horaFin = normalizeTime(body.HORA_FIN);
  const invitadosRaw = Array.isArray(body.invitados) ? body.invitados : [];

  if (!titulo) return { error: 'Indique el motivo de la reunión (ej. Reunión de cumpleaños).' };
  if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) return { error: 'La fecha de la reunión es inválida.' };
  if (!horaInicio || !horaFin) return { error: 'Indique la hora de inicio y fin de la reunión.' };
  if (horaFin <= horaInicio) return { error: 'La hora de fin debe ser posterior a la hora de inicio.' };

  const fin = moment.tz(`${fecha} ${horaFin}`, 'YYYY-MM-DD HH:mm:ss', TZ);
  if (fin.isBefore(nowHN())) return { error: 'La fecha y hora de la reunión ya pasaron.' };

  const invitados = invitadosRaw
    .map(i => ({
      ID_EVENTO_INVITADO: i.ID_EVENTO_INVITADO ? Number(i.ID_EVENTO_INVITADO) : null,
      NOMBRE_COMPLETO: (cleanText(i.NOMBRE_COMPLETO, 100) || '').toUpperCase(),
      DOCUMENTO: cleanText(i.DOCUMENTO, 50)
    }))
    .filter(i => i.NOMBRE_COMPLETO);

  if (invitados.length === 0) return { error: 'Agregue al menos un visitante autorizado.' };
  if (invitados.length > MAX_INVITADOS) return { error: `Máximo ${MAX_INVITADOS} visitantes por QR.` };

  return {
    data: {
      TITULO: titulo.toUpperCase(),
      FECHA_EVENTO: fecha,
      HORA_INICIO: horaInicio,
      HORA_FIN: horaFin,
      OBSERVACIONES_RESIDENTE: cleanText(body.OBSERVACIONES_RESIDENTE, 500),
      invitados
    }
  };
};

// POST /api/eventos
const createEvent = async (req, res) => {
  const usuarioId = getRequestUserId(req);
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const residente = await getResidentInfo(connection, usuarioId);
    if (!residente || !residente.ID_PERSONA) return res.status(404).json({ message: 'Datos del residente no encontrados' });

    const { error, data } = validateEventInput(req.body);
    if (error) return res.status(400).json({ message: error });

    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO TBL_EVENTOS_VISITA
        (ID_USUARIO, ID_PERSONA, ID_CONDOMINIO, TITULO, FECHA_EVENTO, HORA_INICIO, HORA_FIN, OBSERVACIONES_RESIDENTE, ESTADO_QR, FECHA_HORA)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [usuarioId, residente.ID_PERSONA, residente.ID_CONDOMINIO, data.TITULO, data.FECHA_EVENTO,
        data.HORA_INICIO, data.HORA_FIN, data.OBSERVACIONES_RESIDENTE, nowHNString()]
    );
    const idEvento = result.insertId;
    const values = data.invitados.map(i => [idEvento, i.NOMBRE_COMPLETO, i.DOCUMENTO]);
    await connection.query('INSERT INTO TBL_EVENTO_INVITADOS (ID_EVENTO_VISITA, NOMBRE_COMPLETO, DOCUMENTO) VALUES ?', [values]);
    await connection.commit();

    const evento = await getEventWithGuests(connection, idEvento);
    const { qrCode } = await buildEncryptedQR(QR_TYPES.EVENTO, idEvento, { d: data.FECHA_EVENTO });
    res.status(201).json({ success: true, message: 'QR múltiple generado', qrCode, qrData: buildEventCard(evento, qrCode), evento });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error createEvent:', error);
    res.status(500).json({ message: 'Error al registrar la reunión' });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/eventos/usuario/:usuarioId
const getUserEvents = async (req, res) => {
  const usuarioId = isAdminRole(req) && req.params.usuarioId ? req.params.usuarioId : getRequestUserId(req);
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [eventos] = await connection.query(
      `SELECT e.ID_EVENTO_VISITA FROM TBL_EVENTOS_VISITA e
        WHERE e.ID_USUARIO = ? AND e.FECHA_EVENTO >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
        ORDER BY e.FECHA_EVENTO DESC, e.HORA_INICIO DESC`,
      [usuarioId]
    );
    const result = [];
    for (const e of eventos) {
      const ev = await getEventWithGuests(connection, e.ID_EVENTO_VISITA);
      if (ev) result.push({ ...ev, VENCIDO: getEventEnd(ev).isBefore(nowHN()) });
    }
    res.json(result);
  } catch (error) {
    console.error('Error getUserEvents:', error);
    res.status(500).json({ message: 'Error al obtener reuniones' });
  } finally {
    if (connection) connection.release();
  }
};

const loadOwnedEvent = async (connection, req, res) => {
  const evento = await getEventWithGuests(connection, req.params.id);
  if (!evento) {
    res.status(404).json({ message: 'Reunión no encontrada' });
    return null;
  }
  if (!isAdminRole(req) && Number(evento.ID_USUARIO) !== Number(getRequestUserId(req))) {
    res.status(403).json({ message: 'No tiene permisos sobre esta reunión' });
    return null;
  }
  return evento;
};

// PUT /api/eventos/:id  → agregar/quitar personas y cambiar datos antes de la reunión
const updateEvent = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const actual = await loadOwnedEvent(connection, req, res);
    if (!actual) return;
    if (getEventEnd(actual).isBefore(nowHN())) {
      return res.status(400).json({ message: 'La reunión ya finalizó; el QR no puede reutilizarse ni modificarse.' });
    }

    const { error, data } = validateEventInput(req.body);
    if (error) return res.status(400).json({ message: error });

    const yaIngresaron = actual.invitados.filter(i => Number(i.INGRESADO) === 1);
    if (yaIngresaron.length > 0 && data.FECHA_EVENTO !== moment(actual.FECHA_EVENTO).format('YYYY-MM-DD')) {
      return res.status(400).json({ message: 'Ya hay visitantes ingresados; no se puede cambiar la fecha de la reunión.' });
    }

    await connection.beginTransaction();
    await connection.query(
      `UPDATE TBL_EVENTOS_VISITA
          SET TITULO = ?, FECHA_EVENTO = ?, HORA_INICIO = ?, HORA_FIN = ?, OBSERVACIONES_RESIDENTE = ?, FECHA_MODIFICACION = ?
        WHERE ID_EVENTO_VISITA = ?`,
      [data.TITULO, data.FECHA_EVENTO, data.HORA_INICIO, data.HORA_FIN, data.OBSERVACIONES_RESIDENTE, nowHNString(), actual.ID_EVENTO_VISITA]
    );

    const existentes = new Map(actual.invitados.map(i => [Number(i.ID_EVENTO_INVITADO), i]));
    const conservar = new Set();
    for (const inv of data.invitados) {
      if (inv.ID_EVENTO_INVITADO && existentes.has(inv.ID_EVENTO_INVITADO)) {
        conservar.add(inv.ID_EVENTO_INVITADO);
        const previo = existentes.get(inv.ID_EVENTO_INVITADO);
        if (Number(previo.INGRESADO) !== 1) {
          await connection.query(
            'UPDATE TBL_EVENTO_INVITADOS SET NOMBRE_COMPLETO = ?, DOCUMENTO = ? WHERE ID_EVENTO_INVITADO = ?',
            [inv.NOMBRE_COMPLETO, inv.DOCUMENTO, inv.ID_EVENTO_INVITADO]
          );
        }
      } else {
        await connection.query(
          'INSERT INTO TBL_EVENTO_INVITADOS (ID_EVENTO_VISITA, NOMBRE_COMPLETO, DOCUMENTO) VALUES (?, ?, ?)',
          [actual.ID_EVENTO_VISITA, inv.NOMBRE_COMPLETO, inv.DOCUMENTO]
        );
      }
    }
    // Quitar personas (solo las que aún no han ingresado)
    for (const [idInv, inv] of existentes) {
      if (!conservar.has(idInv) && Number(inv.INGRESADO) !== 1) {
        await connection.query('DELETE FROM TBL_EVENTO_INVITADOS WHERE ID_EVENTO_INVITADO = ?', [idInv]);
      }
    }
    await connection.commit();

    const evento = await getEventWithGuests(connection, actual.ID_EVENTO_VISITA);
    const { qrCode } = await buildEncryptedQR(QR_TYPES.EVENTO, evento.ID_EVENTO_VISITA, { d: data.FECHA_EVENTO });
    res.json({ success: true, message: 'QR múltiple actualizado', qrCode, qrData: buildEventCard(evento, qrCode), evento });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error updateEvent:', error);
    res.status(500).json({ message: 'Error al actualizar la reunión' });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/eventos/:id/qr
const getEventQR = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const evento = await loadOwnedEvent(connection, req, res);
    if (!evento) return;
    if (getEventEnd(evento).isBefore(nowHN())) return res.status(400).json({ message: 'La reunión ya finalizó; el QR venció.' });
    const { qrCode } = await buildEncryptedQR(QR_TYPES.EVENTO, evento.ID_EVENTO_VISITA, { d: moment(evento.FECHA_EVENTO).format('YYYY-MM-DD') });
    res.json({ success: true, qrCode, qrData: buildEventCard(evento, qrCode) });
  } catch (error) {
    console.error('Error getEventQR:', error);
    res.status(500).json({ message: 'Error al generar el QR' });
  } finally {
    if (connection) connection.release();
  }
};

// DELETE /api/eventos/:id
const deleteEvent = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const evento = await loadOwnedEvent(connection, req, res);
    if (!evento) return;
    if (evento.invitados.some(i => Number(i.INGRESADO) === 1)) {
      return res.status(400).json({ message: 'La reunión ya tiene ingresos registrados y forma parte del reporte; no se puede eliminar.' });
    }
    await connection.query('DELETE FROM TBL_EVENTOS_VISITA WHERE ID_EVENTO_VISITA = ?', [evento.ID_EVENTO_VISITA]);
    res.json({ success: true, message: 'Reunión eliminada' });
  } catch (error) {
    console.error('Error deleteEvent:', error);
    res.status(500).json({ message: 'Error al eliminar la reunión' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  createEvent,
  getUserEvents,
  updateEvent,
  getEventQR,
  deleteEvent,
  getEventWithGuests,
  getEventEnd
};
