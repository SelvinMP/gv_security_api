const { mysqlPool } = require('../config/db');

/**
 * Obtiene todas las instalaciones disponibles.
 */
const getInstallations = async (req, res) => {
  console.log('Petición recibida en GET /api/reservas/instalaciones');
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query(
      "SELECT ID_INSTALACION, NOMBRE_INSTALACION FROM TBL_INSTALACIONES"
    );
    console.log('Instalaciones encontradas:', results.length);
    res.json(results);
  } catch (error) {
    console.error("Error al obtener instalaciones:", error);
    res.status(500).json({ error: "Error al obtener instalaciones" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

/**
 * Crea una nueva reservación validando disponibilidad.
 */
const createReservation = async (req, res) => {
  const { idUsuario, idInstalacion, tipoEvento, numInvitado, notas, fechaReserva, horaInicio, horaFinal } = req.body;

  if (!idUsuario || !idInstalacion || !fechaReserva || !horaInicio || !horaFinal) {
    return res.status(400).json({ message: "Datos obligatorios incompletos" });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // Validar traslapes
    const checkQuery = `
      SELECT * FROM TBL_RESERVAS 
      WHERE ID_INSTALACION = ? 
      AND FECHA_RESERVA = ?
      AND HORA_INICIO < ? 
      AND HORA_FINAL > ?
      AND ID_ESTADO_RESERVA != 4 -- Omitir canceladas
    `;

    const [overlaps] = await connection.query(checkQuery, [idInstalacion, fechaReserva, horaFinal, horaInicio]);

    if (overlaps.length > 0) {
      return res.status(409).json({ message: "La instalación ya está reservada en ese horario." });
    }

    // Insertar reservación (Estado 3 = Pendiente)
    const insertQuery = `
      INSERT INTO TBL_RESERVAS (
        ID_USUARIO, ID_INSTALACION, ID_ESTADO_RESERVA, TIPO_EVENTO, 
        NUM_INVITADO, NOTAS, FECHA_RESERVA, HORA_INICIO, HORA_FINAL
      ) VALUES (?, ?, 3, ?, ?, ?, ?, ?, ?)
    `;

    await connection.query(insertQuery, [
      idUsuario, idInstalacion, tipoEvento, 
      numInvitado, notas, fechaReserva, horaInicio, horaFinal
    ]);

    res.status(201).json({ message: "Reservación creada exitosamente" });
  } catch (error) {
    console.error("Error al crear reservación:", error);
    res.status(500).json({ message: "Error interno al crear reservación" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

/**
 * Obtiene las reservaciones de un usuario.
 */
const getUserReservations = async (req, res) => {
  const { userId } = req.params;

  const query = `
    SELECT r.*, i.NOMBRE_INSTALACION, e.DESCRIPCION
    FROM TBL_RESERVAS r
    JOIN TBL_INSTALACIONES i ON r.ID_INSTALACION = i.ID_INSTALACION
    JOIN TBL_ESTADO_RESERVA e ON r.ID_ESTADO_RESERVA = e.ID_ESTADO_RESERVA
    WHERE r.ID_USUARIO = ?
    ORDER BY r.FECHA_RESERVA DESC, r.HORA_INICIO DESC
  `;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query(query, [userId]);
    res.json(results);
  } catch (error) {
    console.error("Error al obtener reservaciones del usuario:", error);
    res.status(500).json({ message: "Error al obtener reservaciones" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};


module.exports = {
  getInstallations,
  createReservation,
  getUserReservations
};
