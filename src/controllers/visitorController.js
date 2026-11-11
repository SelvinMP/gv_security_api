const { mysqlPool } = require('../config/db');
const moment = require('moment-timezone');
const { buildEncryptedQR, QR_TYPES } = require('../utils/qrCrypto');

// Cantidad de personas: respeta el valor enviado (incluido el cambio de acompañantes)
const parsePersonas = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : (Number(fallback) > 0 ? Number(fallback) : 1);
};

/**
 * Registra una visita (normal o recurrente) y devuelve su QR cifrado.
 * Lo usan el formulario de la app (registerVisit) y el asistente de IA.
 * Devuelve null si no existen los datos del residente.
 */
const createVisit = async (connection, {
  usuarioId,
  NOMBRE_VISITANTE,
  NUM_PERSONAS,
  NOTA,
  isRecurrentVisitor,
  FECHA_VENCIMIENTO,
}) => {
    // Obtener info del residente/usuario
    const [personaResults] = await connection.query(
      `SELECT p.ID_PERSONA, u.NOMBRE_USUARIO AS NOMBRE_PERSONA, p.DNI_PERSONA, p.NUM_CARNET_EXTRANJERO, c.DESCRIPCION AS CONTACTO, d.DESCRIPCION AS ID_CONDOMINIO 
       FROM TBL_PERSONAS p
       INNER JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO
       LEFT JOIN TBL_CONTACTOS c ON p.ID_CONTACTO = c.ID_CONTACTO
       LEFT JOIN TBL_CONDOMINIOS d ON p.ID_CONDOMINIO = d.ID_CONDOMINIO
       WHERE p.ID_USUARIO = ?`,
      [usuarioId]
    );


    if (personaResults.length === 0) return null;

    const personaInfo = personaResults[0];
    const ID_PERSONA = personaInfo.ID_PERSONA;

    const fechaActual = moment().tz("America/Tegucigalpa");
    const fechaHoraStr = fechaActual.format("YYYY-MM-DD HH:mm:ss");
    
    let insertQuery, insertParams, FECHA_VENCIMIENTO_FINAL;

    if (isRecurrentVisitor) {
       // Convertir FECHA_VENCIMIENTO al formato 'YYYY-MM-DD HH:mm:ss'
       // FECHA_VENCIMIENTO viene como string 'YYYY-MM-DD HH:mm'
       FECHA_VENCIMIENTO_FINAL = moment(FECHA_VENCIMIENTO).format("YYYY-MM-DD HH:mm:ss");
       
       insertQuery = `INSERT INTO TBL_VISITANTES_RECURRENTES 
         (ID_USUARIO, NOMBRE_VISITANTE, ID_NACIONALIDAD, DNI_VISITANTE, NUM_CARNET_EXTRANJERO, NUM_PERSONAS, NUM_PLACA, NOTA, FECHA_HORA, FECHA_VENCIMIENTO) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
       insertParams = [usuarioId, NOMBRE_VISITANTE, null, null, null, NUM_PERSONAS, null, NOTA, fechaHoraStr, FECHA_VENCIMIENTO_FINAL];
    } else {
       insertQuery = `INSERT INTO TBL_REGVISITAS (ID_USUARIO, NOMBRE_VISITANTE, ID_NACIONALIDAD, DNI_VISITANTE, NUM_CARNET_EXTRANJERO, NUM_PERSONAS, NUM_PLACA, NOTA, FECHA_HORA) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
       insertParams = [usuarioId, NOMBRE_VISITANTE, null, null, null, NUM_PERSONAS, null, NOTA, fechaHoraStr];
    }

    const [result] = await connection.query(insertQuery, insertParams);
    const ID_VISITANTE = result.insertId;

    // Bitácora
    let insertBitacoraQuery, insertBitacoraParams;
    if (isRecurrentVisitor) {
      insertBitacoraQuery = "INSERT INTO TBL_BITACORA_VISITA (ID_PERSONA, ID_VISITANTES_RECURRENTES, NUM_PERSONA, NUM_PLACA, NOTA, FECHA_HORA, FECHA_VENCIMIENTO) VALUES (?, ?, ?, ?, ?, ?, ?)";
      insertBitacoraParams = [ID_PERSONA, ID_VISITANTE, NUM_PERSONAS, null, NOTA, fechaHoraStr, FECHA_VENCIMIENTO_FINAL];
    } else {
      insertBitacoraQuery = "INSERT INTO TBL_BITACORA_VISITA (ID_PERSONA, ID_VISITANTE, NUM_PERSONA, NUM_PLACA, NOTA, FECHA_HORA) VALUES (?, ?, ?, ?, ?, ?)";
      insertBitacoraParams = [ID_PERSONA, ID_VISITANTE, NUM_PERSONAS, null, NOTA, fechaHoraStr];
    }
    await connection.query(insertBitacoraQuery, insertBitacoraParams);

    const qrData = {
      Residente: personaInfo.NOMBRE_PERSONA,
      DNI_Residente: personaInfo.DNI_PERSONA || personaInfo.NUM_CARNET_EXTRANJERO,
      Contacto: personaInfo.CONTACTO,
      ID_VISITANTE,
      Condominio: personaInfo.ID_CONDOMINIO,
      NOMBRE_VISITANTE,
      NACIONALIDAD: 'N/A', // Omitido
      DNI_VISITANTE: null,
      NUM_PERSONAS,
      NUM_PLACA: null,
      FECHA_VENCIMIENTO: isRecurrentVisitor ? FECHA_VENCIMIENTO_FINAL : null,
      isRecurrent: isRecurrentVisitor
    };

    const { qrCode: qrUrl } = await buildEncryptedQR(isRecurrentVisitor ? QR_TYPES.RECURRENTE : QR_TYPES.VISITA, ID_VISITANTE);

    return {
      success: true,
      message: isRecurrentVisitor ? "Visitante recurrente registrado" : "Visita registrada",
      qrCode: qrUrl,
      qrData: qrData,
    };
};

const registerVisit = async (req, res) => {
  let connection;

  try {
    connection = await mysqlPool.getConnection();
    const result = await createVisit(connection, req.body);
    if (!result) {
      return res.status(404).json({ error: "Datos del residente no encontrados" });
    }
    res.status(201).json(result);
  } catch (error) {
    console.error("Error en registro:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  } finally {
    if (connection) connection.release();
  }
};

const validateQR = async (req, res) => {
  const { ID_VISITANTE, isRecurrent } = req.body;
  if (!ID_VISITANTE) return res.status(400).json({ message: "ID no proporcionado" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    
    if (isRecurrent) {
      const [rows] = await connection.query("SELECT FECHA_VENCIMIENTO FROM TBL_VISITANTES_RECURRENTES WHERE ID_VISITANTES_RECURRENTES = ?", [ID_VISITANTE]);
      if (rows.length === 0) return res.status(404).json({ message: "Visita no encontrada" });
      
      const vencimiento = moment(rows[0].FECHA_VENCIMIENTO);
      if (moment().isAfter(vencimiento)) return res.status(400).json({ message: "Código QR vencido" });
      
      return res.status(200).json({ message: "QR Válido (Recurrente)" });
    } else {
      const [rows] = await connection.query("SELECT ESTADO_QR FROM TBL_REGVISITAS WHERE ID_VISITANTE = ?", [ID_VISITANTE]);
      if (rows.length === 0) return res.status(404).json({ message: "Visita no encontrada" });
      
      if (rows[0].ESTADO_QR === 1) return res.status(400).json({ message: "Código QR ya utilizado" });
      
      return res.status(200).json({ message: "QR Válido (Uso único)" });
    }
  } catch (error) {
    res.status(500).json({ message: "Error al validar QR" });
  } finally {
    if (connection) connection.release();
  }
};

const getVisitorHistory = async (req, res) => {
  const { usuarioId } = req.params;
  const { search } = req.query; // New search parameter
  let connection;

  try {
    connection = await mysqlPool.getConnection();
    
    let searchFilter = "";
    let searchParams = [usuarioId];
    
    if (search && search.trim() !== "") {
      const term = `%${search.trim()}%`;
      searchFilter = " AND (NOMBRE_VISITANTE LIKE ? OR DNI_VISITANTE LIKE ? OR NUM_CARNET_EXTRANJERO LIKE ?)";
      searchParams = [usuarioId, term, term, term];
    }

    // Normal visits: if searching, no time limit. Otherwise last month.
    const historyInterval = (search && search.trim() !== "") ? "" : " AND FECHA_HORA >= DATE_SUB(NOW(), INTERVAL 3 MONTH)";

    const [regVisitas] = await connection.query(
      `SELECT 
        ID_VISITANTE as id,
        NOMBRE_VISITANTE,
        DNI_VISITANTE,
        NUM_CARNET_EXTRANJERO,
        NUM_PERSONAS,
        NUM_PLACA,
        FECHA_HORA,
        FECHA_ACCESO,
        ESTADO_QR,
        NOTA,
        FECHA_CANCELACION,
        MOTIVO_CANCELACION,
        'normal' as type
      FROM TBL_REGVISITAS 
      WHERE ID_USUARIO = ? ${searchFilter} ${historyInterval}
      ORDER BY FECHA_HORA DESC`,
      searchParams
    );

    // Recurrent visits: if searching, no time limit. Otherwise not expired (or last year).
    const recurrentInterval = (search && search.trim() !== "") ? "" : " AND (FECHA_VENCIMIENTO IS NULL OR FECHA_VENCIMIENTO >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH))";

    const [recurrentVisitas] = await connection.query(
      `SELECT 
        ID_VISITANTES_RECURRENTES as id,
        NOMBRE_VISITANTE,
        DNI_VISITANTE,
        NUM_CARNET_EXTRANJERO,
        NUM_PERSONAS,
        NUM_PLACA,
        FECHA_HORA,
        FECHA_ACCESO,
        FECHA_VENCIMIENTO,
        ESTADO_QR,
        CANTIDAD_ESCANEANA,
        NOTA,
        FECHA_CANCELACION,
        MOTIVO_CANCELACION,
        'recurrent' as type
      FROM TBL_VISITANTES_RECURRENTES
      WHERE ID_USUARIO = ? ${searchFilter} ${recurrentInterval}
      ORDER BY FECHA_HORA DESC`,
      searchParams
    );

    const history = [...regVisitas, ...recurrentVisitas].sort((a, b) => 
      new Date(b.FECHA_HORA) - new Date(a.FECHA_HORA)
    );

    res.status(200).json(history);
  } catch (error) {
    console.error("Error fetching history:", error);
    res.status(500).json({ message: "Error al obtener el historial" });
  } finally {
    if (connection) connection.release();
  }
};

const regenerateVisit = async (req, res) => {
  const { id, type } = req.params;
  const { newExpiry, numPersonas, numPlaca, nota } = req.body;
  let connection;

  try {
    connection = await mysqlPool.getConnection();
    
    if (type === 'recurrent') {
      const [original] = await connection.query("SELECT * FROM TBL_VISITANTES_RECURRENTES WHERE ID_VISITANTES_RECURRENTES = ?", [id]);
      if (original.length === 0) return res.status(404).json({ message: "Visita no encontrada" });
      const originalVisit = original[0];

      const formattedExpiry = moment(newExpiry).format("YYYY-MM-DD HH:mm:ss");
      await connection.query(
        "UPDATE TBL_VISITANTES_RECURRENTES SET FECHA_VENCIMIENTO = ?, NUM_PERSONAS = ?, NUM_PLACA = ?, ESTADO_QR = 0, NOTA = ?, FECHA_CANCELACION = NULL, MOTIVO_CANCELACION = NULL WHERE ID_VISITANTES_RECURRENTES = ?",
        [formattedExpiry, parsePersonas(numPersonas, originalVisit.NUM_PERSONAS), numPlaca || originalVisit.NUM_PLACA, nota !== undefined && nota !== '' ? nota : originalVisit.NOTA, id]
      );
      
      const [visitor] = await connection.query("SELECT * FROM TBL_VISITANTES_RECURRENTES WHERE ID_VISITANTES_RECURRENTES = ?", [id]);
      const v = visitor[0];

      // Get Resident Info for QR
      const [residente] = await connection.query(
        "SELECT u.NOMBRE_USUARIO, p.DNI_PERSONA, p.NUM_CARNET_EXTRANJERO, c.DESCRIPCION AS CONTACTO, d.DESCRIPCION AS ID_CONDOMINIO FROM TBL_PERSONAS p INNER JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO LEFT JOIN TBL_CONTACTOS c ON p.ID_CONTACTO = c.ID_CONTACTO LEFT JOIN TBL_CONDOMINIOS d ON p.ID_CONDOMINIO = d.ID_CONDOMINIO WHERE p.ID_USUARIO = ?", 
        [v.ID_USUARIO]
      );
      const resInfo = residente[0];

      const qrData = {
        Residente: resInfo.NOMBRE_USUARIO,
        DNI_Residente: resInfo.DNI_PERSONA || resInfo.NUM_CARNET_EXTRANJERO,
        Contacto: resInfo.CONTACTO,
        ID_VISITANTE: id,
        Condominio: resInfo.ID_CONDOMINIO,
        NOMBRE_VISITANTE: v.NOMBRE_VISITANTE,
        DNI_VISITANTE: v.DNI_VISITANTE || v.NUM_CARNET_EXTRANJERO,
        NUM_PERSONAS: v.NUM_PERSONAS,
        NUM_PLACA: numPlaca || (v.NUM_PLACA || ''),
        NOTA: v.NOTA,
        FECHA_VENCIMIENTO: formattedExpiry,
        isRecurrent: true
      };
      const { qrCode: qrUrl } = await buildEncryptedQR(QR_TYPES.RECURRENTE, id);

      res.json({ success: true, message: "QR Recurrente renovado", qrCode: qrUrl, qrData });
    } else {
      // For normal: CLONE into new entry
      const [original] = await connection.query("SELECT * FROM TBL_REGVISITAS WHERE ID_VISITANTE = ?", [id]);
      if (original.length === 0) return res.status(404).json({ message: "Visita no encontrada" });
      
      const v = original[0];
      const now = moment().tz("America/Tegucigalpa").format("YYYY-MM-DD HH:mm:ss");
      
      const [result] = await connection.query(
        "INSERT INTO TBL_REGVISITAS (ID_USUARIO, NOMBRE_VISITANTE, ID_NACIONALIDAD, DNI_VISITANTE, NUM_CARNET_EXTRANJERO, NUM_PERSONAS, NUM_PLACA, NOTA, FECHA_HORA, ESTADO_QR) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        [v.ID_USUARIO, v.NOMBRE_VISITANTE, v.ID_NACIONALIDAD, v.DNI_VISITANTE, v.NUM_CARNET_EXTRANJERO, parsePersonas(numPersonas, v.NUM_PERSONAS), numPlaca || (v.NUM_PLACA || ''), nota !== undefined && nota !== '' ? nota : v.NOTA, now]
      );
      const nuevasPersonas = parsePersonas(numPersonas, v.NUM_PERSONAS);
      const nuevaNota = nota !== undefined && nota !== '' ? nota : v.NOTA;

      // La nueva visita también debe existir en la bitácora para que el guardia registre el acceso
      const [personaRows] = await connection.query("SELECT ID_PERSONA FROM TBL_PERSONAS WHERE ID_USUARIO = ?", [v.ID_USUARIO]);
      if (personaRows.length > 0) {
        await connection.query(
          "INSERT INTO TBL_BITACORA_VISITA (ID_PERSONA, ID_VISITANTE, NUM_PERSONA, NUM_PLACA, NOTA, FECHA_HORA) VALUES (?, ?, ?, ?, ?, ?)",
          [personaRows[0].ID_PERSONA, result.insertId, nuevasPersonas, numPlaca || (v.NUM_PLACA || null), nuevaNota, now]
        );
      }
      
      // Get Resident Info for QR
      const [residente] = await connection.query(
        "SELECT u.NOMBRE_USUARIO, p.DNI_PERSONA, p.NUM_CARNET_EXTRANJERO, c.DESCRIPCION AS CONTACTO, d.DESCRIPCION AS ID_CONDOMINIO FROM TBL_PERSONAS p INNER JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO LEFT JOIN TBL_CONTACTOS c ON p.ID_CONTACTO = c.ID_CONTACTO LEFT JOIN TBL_CONDOMINIOS d ON p.ID_CONDOMINIO = d.ID_CONDOMINIO WHERE p.ID_USUARIO = ?", 
        [v.ID_USUARIO]
      );
      const resInfo = residente[0];

      const qrData = {
        Residente: resInfo.NOMBRE_USUARIO,
        DNI_Residente: resInfo.DNI_PERSONA || resInfo.NUM_CARNET_EXTRANJERO,
        Contacto: resInfo.CONTACTO,
        ID_VISITANTE: result.insertId,
        Condominio: resInfo.ID_CONDOMINIO,
        NOMBRE_VISITANTE: v.NOMBRE_VISITANTE,
        DNI_VISITANTE: v.DNI_VISITANTE || v.NUM_CARNET_EXTRANJERO,
        NUM_PERSONAS: nuevasPersonas,
        NUM_PLACA: numPlaca || (v.NUM_PLACA || ''),
        NOTA: nuevaNota,
        FECHA_VENCIMIENTO: null,
        isRecurrent: false
      };
      const { qrCode: qrUrl } = await buildEncryptedQR(QR_TYPES.VISITA, result.insertId);

      res.json({ success: true, message: "Nueva visita generada", qrCode: qrUrl, qrData });
    }
  } catch (error) {
    console.error("Error in regenerateVisit:", error);
    res.status(500).json({ message: "Error al regenerar visita" });
  } finally {
    if (connection) connection.release();
  }
};

const convertToRecurrent = async (req, res) => {
  const { id } = req.params;
  const { newExpiry, nota, numPersonas } = req.body;
  let connection;

  try {
    connection = await mysqlPool.getConnection();
    
    // Get original visit data
    const [original] = await connection.query("SELECT * FROM TBL_REGVISITAS WHERE ID_VISITANTE = ?", [id]);
    if (original.length === 0) return res.status(404).json({ message: "Visita original no encontrada" });
    
    const v = original[0];
    const formattedExpiry = moment(newExpiry).format("YYYY-MM-DD HH:mm:ss");
    const fechaHoraStr = moment().tz("America/Tegucigalpa").format("YYYY-MM-DD HH:mm:ss");

    // Insert into TBL_VISITANTES_RECURRENTES
    const insertQuery = `INSERT INTO TBL_VISITANTES_RECURRENTES 
      (ID_USUARIO, NOMBRE_VISITANTE, ID_NACIONALIDAD, DNI_VISITANTE, NUM_CARNET_EXTRANJERO, NUM_PERSONAS, NUM_PLACA, NOTA, FECHA_HORA, FECHA_VENCIMIENTO) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    const [result] = await connection.query(insertQuery, [
      v.ID_USUARIO, v.NOMBRE_VISITANTE, v.ID_NACIONALIDAD, v.DNI_VISITANTE, 
      v.NUM_CARNET_EXTRANJERO, parsePersonas(numPersonas, v.NUM_PERSONAS), v.NUM_PLACA, nota !== undefined && nota !== '' ? nota : v.NOTA, fechaHoraStr, formattedExpiry
    ]);

    const newRecurrentId = result.insertId;

    // Optional: Delete original visit or mark it? 
    // User said "una opción... de hacerla vista recurrente", usually implies moving/promoting it.
    // We'll keep the original for history but the new one is the recurrent one.
    
    // Get Resident Info for QR
    const [residente] = await connection.query(
      `SELECT u.NOMBRE_USUARIO, p.DNI_PERSONA, p.NUM_CARNET_EXTRANJERO, c.DESCRIPCION AS CONTACTO, d.DESCRIPCION AS ID_CONDOMINIO 
       FROM TBL_PERSONAS p 
       INNER JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO 
       LEFT JOIN TBL_CONTACTOS c ON p.ID_CONTACTO = c.ID_CONTACTO 
       LEFT JOIN TBL_CONDOMINIOS d ON p.ID_CONDOMINIO = d.ID_CONDOMINIO 
       WHERE p.ID_USUARIO = ?`, 
      [v.ID_USUARIO]
    );
    const resInfo = residente[0];

    const qrData = {
      Residente: resInfo.NOMBRE_USUARIO,
      DNI_Residente: resInfo.DNI_PERSONA || resInfo.NUM_CARNET_EXTRANJERO,
      Contacto: resInfo.CONTACTO,
      ID_VISITANTE: newRecurrentId,
      Condominio: resInfo.ID_CONDOMINIO,
      NOMBRE_VISITANTE: v.NOMBRE_VISITANTE,
      DNI_VISITANTE: v.DNI_VISITANTE || v.NUM_CARNET_EXTRANJERO,
      NUM_PERSONAS: parsePersonas(numPersonas, v.NUM_PERSONAS),
      NUM_PLACA: v.NUM_PLACA,
      NOTA: nota !== undefined && nota !== '' ? nota : v.NOTA,
      FECHA_VENCIMIENTO: formattedExpiry,
      isRecurrent: true
    };

    const { qrCode: qrUrl } = await buildEncryptedQR(QR_TYPES.RECURRENTE, newRecurrentId);

    res.json({ 
      success: true, 
      message: "Visita convertida a recurrente con éxito", 
      qrCode: qrUrl, 
      qrData 
    });

  } catch (error) {
    console.error("Error converting to recurrent:", error);
    res.status(500).json({ message: "Error al convertir visita" });
  } finally {
    if (connection) connection.release();
  }
};

const deleteVisitor = async (req, res) => {
  const { type, id } = req.params;
  let connection;

  try {
    connection = await mysqlPool.getConnection();
    let query;
    if (type === 'recurrent') {
      query = "DELETE FROM TBL_VISITANTES_RECURRENTES WHERE ID_VISITANTES_RECURRENTES = ?";
    } else {
      query = "DELETE FROM TBL_REGVISITAS WHERE ID_VISITANTE = ?";
    }

    await connection.query(query, [id]);
    res.status(200).json({ success: true, message: "Visita eliminada correctamente" });
  } catch (error) {
    console.error("Error deleting visitor:", error);
    res.status(500).json({ message: "Error al eliminar la visita" });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Cancela una visita (única o recurrente). El QR deja de ser válido y en el portón
 * se muestra "Acceso denegado: visita cancelada". Solo el residente dueño puede cancelarla.
 */
const cancelVisit = async (req, res) => {
  const { type, id } = req.params;
  const userId = req.user && req.user.id;
  const motivo = String((req.body && req.body.motivo) || '').trim().slice(0, 255) || null;
  const isRecurrent = type === 'recurrent';
  const table = isRecurrent ? 'TBL_VISITANTES_RECURRENTES' : 'TBL_REGVISITAS';
  const pk = isRecurrent ? 'ID_VISITANTES_RECURRENTES' : 'ID_VISITANTE';

  if (!['recurrent', 'normal'].includes(type)) return res.status(400).json({ message: 'Tipo de visita inválido.' });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(
      `SELECT ${pk} AS id, ID_USUARIO, NOMBRE_VISITANTE, ESTADO_QR, FECHA_VENCIMIENTO_COL, FECHA_CANCELACION FROM ${table} WHERE ${pk} = ?`
        .replace('FECHA_VENCIMIENTO_COL', isRecurrent ? 'FECHA_VENCIMIENTO' : 'NULL AS FECHA_VENCIMIENTO'),
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Visita no encontrada.' });
    const visit = rows[0];

    if (Number(visit.ID_USUARIO) !== Number(userId)) {
      return res.status(403).json({ message: 'Solo el residente que registró la visita puede cancelarla.' });
    }
    if (visit.FECHA_CANCELACION) return res.status(409).json({ message: 'Esta visita ya fue cancelada.' });
    if (!isRecurrent && Number(visit.ESTADO_QR) === 1) {
      return res.status(409).json({ message: 'No se puede cancelar: el visitante ya ingresó al residencial.' });
    }

    const ahora = moment().tz('America/Tegucigalpa').format('YYYY-MM-DD HH:mm:ss');
    await connection.query(
      `UPDATE ${table} SET FECHA_CANCELACION = ?, MOTIVO_CANCELACION = ? WHERE ${pk} = ?`,
      [ahora, motivo, id]
    );

    res.status(200).json({
      success: true,
      message: `La visita de ${visit.NOMBRE_VISITANTE} fue cancelada. Su código QR ya no permite el ingreso.`,
      FECHA_CANCELACION: ahora,
      MOTIVO_CANCELACION: motivo
    });
  } catch (error) {
    console.error('Error al cancelar visita:', error);
    res.status(500).json({ message: 'Error al cancelar la visita.' });
  } finally {
    if (connection) connection.release();
  }
};

const getRecurrentVisitSummary = async (req, res) => {
  const { usuarioId } = req.params;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const query = `
      SELECT COUNT(*) as TOTAL
      FROM TBL_VISITANTES_RECURRENTES
      WHERE ID_USUARIO = ?
      AND FECHA_HORA >= DATE_SUB(NOW(), INTERVAL 1 YEAR)`;
    const [results] = await connection.query(query, [usuarioId]);
    res.json(results[0]);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener resumen de visitas recurrentes" });
  } finally {
    if (connection) connection.release();
  }
};

const getRecurrentVisitDetails = async (req, res) => {
  const { usuarioId } = req.params;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const query = `
      SELECT 
        ID_VISITANTES_RECURRENTES as id,
        NOMBRE_VISITANTE,
        FECHA_HORA,
        FECHA_VENCIMIENTO,
        ESTADO_QR,
        CANTIDAD_ESCANEANA
      FROM TBL_VISITANTES_RECURRENTES
      WHERE ID_USUARIO = ?
      AND FECHA_HORA >= DATE_SUB(NOW(), INTERVAL 1 YEAR)
      ORDER BY FECHA_HORA ASC`;
    const [results] = await connection.query(query, [usuarioId]);
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener detalles de visitas" });
  } finally {
    if (connection) connection.release();
  }
};

const updateRecurrentVisitExpiry = async (req, res) => {
  const { id } = req.params;
  const { FECHA_VENCIMIENTO } = req.body;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.query(
      "UPDATE TBL_VISITANTES_RECURRENTES SET FECHA_VENCIMIENTO = ? WHERE ID_VISITANTES_RECURRENTES = ?",
      [FECHA_VENCIMIENTO, id]
    );
    res.json({ success: true, message: "Fecha de vencimiento actualizada" });
  } catch (error) {
    res.status(500).json({ message: "Error al actualizar fecha" });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Carnet QR del residente (cifrado). Reemplaza el QR en texto plano que antes
 * se generaba en el navegador mediante un servicio externo.
 * GET /api/visitantes/resident-qr
 */
const getResidentQR = async (req, res) => {
  const usuarioId = req.user?.id;
  if (!usuarioId) return res.status(401).json({ message: 'Sesión no válida' });
  try {
    const { qrCode } = await buildEncryptedQR(QR_TYPES.RESIDENTE, usuarioId);
    res.json({ success: true, qrCode });
  } catch (error) {
    console.error("Error generating resident QR:", error);
    res.status(500).json({ message: "Error al generar el QR de residente" });
  }
};

module.exports = { 
  getResidentQR,
  createVisit,
  registerVisit,
  validateQR, 
  getVisitorHistory, 
  deleteVisitor, 
  getRecurrentVisitSummary, 
  getRecurrentVisitDetails, 
  updateRecurrentVisitExpiry,
  regenerateVisit,
  convertToRecurrent,
  cancelVisit
};
