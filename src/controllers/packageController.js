const { mysqlPool } = require('../config/db');
const moment = require('moment-timezone');
const { buildEncryptedQR, QR_TYPES } = require('../utils/qrCrypto');
const { getResidentInfo, getRequestUserId, isAdminRole, nowHNString, cleanText } = require('../utils/resident');

const TIPOS_REMITENTE = ['EMPRESA', 'FAMILIAR', 'AMIGO'];

/**
 * Datos visibles en la tarjeta del QR (solo para la app, no van dentro del QR).
 */
const buildPackageCard = (paquete, residente, qrCode) => ({
  ID_PAQUETE: paquete.ID_PAQUETE,
  Residente: residente?.NOMBRE_USUARIO,
  Condominio: residente?.CASA || paquete.CASA || 'N/A',
  REMITENTE: paquete.REMITENTE,
  TIPO_REMITENTE: paquete.TIPO_REMITENTE,
  TAMANO: paquete.TAMANO,
  FECHA_ESTIMADA_ENTREGA: moment(paquete.FECHA_ESTIMADA_ENTREGA).format('YYYY-MM-DD'),
  DESCRIPCION: paquete.DESCRIPCION,
  qrCode
});

const getPackageWithDetails = async (connection, id) => {
  const [rows] = await connection.query(
    `SELECT pq.*, t.DESCRIPCION AS TAMANO, t.DIMENSIONES_MAXIMAS, t.PERMITIDO, c.DESCRIPCION AS CASA
       FROM TBL_PAQUETES pq
       JOIN TBL_TAMANO_PAQUETE t ON t.ID_TAMANO_PAQUETE = pq.ID_TAMANO_PAQUETE
       LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = pq.ID_CONDOMINIO
      WHERE pq.ID_PAQUETE = ?`,
    [id]
  );
  return rows[0] || null;
};

const validatePackageInput = async (connection, body) => {
  const remitente = cleanText(body.REMITENTE, 100);
  const tipo = String(body.TIPO_REMITENTE || 'EMPRESA').toUpperCase();
  const fecha = body.FECHA_ESTIMADA_ENTREGA;
  const idTamano = Number(body.ID_TAMANO_PAQUETE);

  if (!remitente) return { error: 'La empresa o remitente es requerido.' };
  if (!TIPOS_REMITENTE.includes(tipo)) return { error: 'Tipo de remitente inválido.' };
  if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) return { error: 'La fecha estimada de entrega es inválida.' };
  if (moment(fecha, 'YYYY-MM-DD').isBefore(moment().tz('America/Tegucigalpa').startOf('day'))) {
    return { error: 'La fecha estimada de entrega no puede ser anterior a hoy.' };
  }

  const [tamanos] = await connection.query('SELECT * FROM TBL_TAMANO_PAQUETE WHERE ID_TAMANO_PAQUETE = ?', [idTamano]);
  if (tamanos.length === 0) return { error: 'Seleccione un tamaño de paquete válido.' };
  if (Number(tamanos[0].PERMITIDO) !== 1) {
    return { error: `Los paquetes de tamaño ${tamanos[0].DESCRIPCION} no se reciben en caseta. Solo pequeños o medianos.` };
  }

  return {
    data: {
      REMITENTE: remitente.toUpperCase(),
      TIPO_REMITENTE: tipo,
      FECHA_ESTIMADA_ENTREGA: fecha,
      ID_TAMANO_PAQUETE: idTamano,
      DESCRIPCION: cleanText(body.DESCRIPCION, 255)
    }
  };
};

// GET /api/paquetes/tamanos
const getPackageSizes = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query('SELECT * FROM TBL_TAMANO_PAQUETE ORDER BY ID_TAMANO_PAQUETE ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error getPackageSizes:', error);
    res.status(500).json({ message: 'Error al obtener tamaños de paquete' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Valida y registra un paquete y genera su QR cifrado.
 * Lo usan el formulario de la app (createPackage) y el asistente de IA.
 * Devuelve { status, message } si no se pudo, o { qrCode, qrData } si se creó.
 */
const insertPackage = async (connection, usuarioId, body) => {
    const residente = await getResidentInfo(connection, usuarioId);
    if (!residente || !residente.ID_PERSONA) return { status: 404, message: 'Datos del residente no encontrados' };

    const { error, data } = await validatePackageInput(connection, body);
    if (error) return { status: 400, message: error };

    const [result] = await connection.query(
      `INSERT INTO TBL_PAQUETES
        (ID_USUARIO, ID_PERSONA, ID_CONDOMINIO, REMITENTE, TIPO_REMITENTE, ID_TAMANO_PAQUETE, FECHA_ESTIMADA_ENTREGA, DESCRIPCION, ESTADO_QR, FECHA_HORA)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [usuarioId, residente.ID_PERSONA, residente.ID_CONDOMINIO, data.REMITENTE, data.TIPO_REMITENTE,
        data.ID_TAMANO_PAQUETE, data.FECHA_ESTIMADA_ENTREGA, data.DESCRIPCION, nowHNString()]
    );

    const paquete = await getPackageWithDetails(connection, result.insertId);
    const { qrCode } = await buildEncryptedQR(QR_TYPES.PAQUETE, paquete.ID_PAQUETE);

    return { qrCode, qrData: buildPackageCard(paquete, residente, qrCode) };
};

// POST /api/paquetes
const createPackage = async (req, res) => {
  const usuarioId = getRequestUserId(req);
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const result = await insertPackage(connection, usuarioId, req.body);
    if (result.status) return res.status(result.status).json({ message: result.message });

    res.status(201).json({
      success: true,
      message: 'QR de paquete generado',
      qrCode: result.qrCode,
      qrData: result.qrData
    });
  } catch (error) {
    console.error('Error createPackage:', error);
    res.status(500).json({ message: 'Error al registrar el paquete' });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/paquetes/usuario/:usuarioId
const getUserPackages = async (req, res) => {
  const usuarioId = isAdminRole(req) && req.params.usuarioId ? req.params.usuarioId : getRequestUserId(req);
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(
      `SELECT pq.ID_PAQUETE, pq.REMITENTE, pq.TIPO_REMITENTE, pq.ID_TAMANO_PAQUETE, t.DESCRIPCION AS TAMANO,
              pq.FECHA_ESTIMADA_ENTREGA, pq.DESCRIPCION, pq.ESTADO_QR, pq.FECHA_HORA, pq.FECHA_RECEPCION,
              pq.ESTADO_PAQUETE, pq.OBSERVACIONES_GUARDIA, c.DESCRIPCION AS CASA,
              ug.NOMBRE_USUARIO AS NOMBRE_GUARDIA
         FROM TBL_PAQUETES pq
         JOIN TBL_TAMANO_PAQUETE t ON t.ID_TAMANO_PAQUETE = pq.ID_TAMANO_PAQUETE
         LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = pq.ID_CONDOMINIO
         LEFT JOIN TBL_MS_USUARIO ug ON ug.ID_USUARIO = pq.ID_USUARIO_GUARDIA
        WHERE pq.ID_USUARIO = ?
          AND pq.FECHA_HORA >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
        ORDER BY pq.FECHA_HORA DESC`,
      [usuarioId]
    );
    res.json(rows);
  } catch (error) {
    console.error('Error getUserPackages:', error);
    res.status(500).json({ message: 'Error al obtener paquetes' });
  } finally {
    if (connection) connection.release();
  }
};

const loadOwnedPackage = async (connection, req, res) => {
  const paquete = await getPackageWithDetails(connection, req.params.id);
  if (!paquete) {
    res.status(404).json({ message: 'Paquete no encontrado' });
    return null;
  }
  if (!isAdminRole(req) && Number(paquete.ID_USUARIO) !== Number(getRequestUserId(req))) {
    res.status(403).json({ message: 'No tiene permisos sobre este paquete' });
    return null;
  }
  return paquete;
};

// PUT /api/paquetes/:id  → actualiza datos y regenera el QR (para compartirlo de nuevo)
const updatePackage = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const actual = await loadOwnedPackage(connection, req, res);
    if (!actual) return;
    if (Number(actual.ESTADO_QR) === 1) return res.status(400).json({ message: 'El paquete ya fue recibido en caseta; no se puede modificar.' });

    const { error, data } = await validatePackageInput(connection, { ...actual, ...req.body,
      FECHA_ESTIMADA_ENTREGA: req.body.FECHA_ESTIMADA_ENTREGA || moment(actual.FECHA_ESTIMADA_ENTREGA).format('YYYY-MM-DD') });
    if (error) return res.status(400).json({ message: error });

    await connection.query(
      `UPDATE TBL_PAQUETES
          SET REMITENTE = ?, TIPO_REMITENTE = ?, ID_TAMANO_PAQUETE = ?, FECHA_ESTIMADA_ENTREGA = ?, DESCRIPCION = ?, FECHA_MODIFICACION = ?
        WHERE ID_PAQUETE = ?`,
      [data.REMITENTE, data.TIPO_REMITENTE, data.ID_TAMANO_PAQUETE, data.FECHA_ESTIMADA_ENTREGA, data.DESCRIPCION, nowHNString(), actual.ID_PAQUETE]
    );

    const paquete = await getPackageWithDetails(connection, actual.ID_PAQUETE);
    const residente = await getResidentInfo(connection, paquete.ID_USUARIO);
    const { qrCode } = await buildEncryptedQR(QR_TYPES.PAQUETE, paquete.ID_PAQUETE);

    res.json({ success: true, message: 'QR de paquete actualizado', qrCode, qrData: buildPackageCard(paquete, residente, qrCode) });
  } catch (error) {
    console.error('Error updatePackage:', error);
    res.status(500).json({ message: 'Error al actualizar el paquete' });
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/paquetes/:id/qr  → vuelve a obtener el QR para compartirlo
const getPackageQR = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const paquete = await loadOwnedPackage(connection, req, res);
    if (!paquete) return;
    const residente = await getResidentInfo(connection, paquete.ID_USUARIO);
    const { qrCode } = await buildEncryptedQR(QR_TYPES.PAQUETE, paquete.ID_PAQUETE);
    res.json({ success: true, qrCode, qrData: buildPackageCard(paquete, residente, qrCode) });
  } catch (error) {
    console.error('Error getPackageQR:', error);
    res.status(500).json({ message: 'Error al generar el QR' });
  } finally {
    if (connection) connection.release();
  }
};

// DELETE /api/paquetes/:id  (solo pendientes)
const deletePackage = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const paquete = await loadOwnedPackage(connection, req, res);
    if (!paquete) return;
    if (Number(paquete.ESTADO_QR) === 1) return res.status(400).json({ message: 'Un paquete recibido forma parte del reporte y no se puede eliminar.' });
    await connection.query('DELETE FROM TBL_PAQUETES WHERE ID_PAQUETE = ?', [paquete.ID_PAQUETE]);
    res.json({ success: true, message: 'Paquete eliminado' });
  } catch (error) {
    console.error('Error deletePackage:', error);
    res.status(500).json({ message: 'Error al eliminar el paquete' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  insertPackage,
  getPackageSizes,
  createPackage,
  getUserPackages,
  updatePackage,
  getPackageQR,
  deletePackage,
  getPackageWithDetails
};
