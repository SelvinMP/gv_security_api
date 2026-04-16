const { mysqlPool } = require('../config/db');

/**
 * Obtiene todos los anuncios y eventos que no han sido ocultados por el usuario.
 */
const getAnnouncements = async (req, res) => {
  const usuarioId = req.query.usuario_id;

  if (!usuarioId) {
    return res.status(400).json({ message: "El ID de usuario es requerido" });
  }

  const query = `
    SELECT ID_ANUNCIOS_EVENTOS, TITULO, DESCRIPCION, IMAGEN, FECHA_HORA 
    FROM TBL_ANUNCIOS_EVENTOS 
    WHERE ID_ESTADO_ANUNCIO_EVENTO = 1 
    AND ID_ANUNCIOS_EVENTOS NOT IN (
        SELECT ID_ANUNCIOS_EVENTOS FROM TBL_ANUNCIOS_OCULTOS WHERE ID_USUARIO = ?
    )
    ORDER BY FECHA_HORA DESC`;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query(query, [usuarioId]);
    res.status(200).json(results);
  } catch (error) {
    console.error("Error al obtener los anuncios:", error);
    res.status(500).json({ message: "Error al obtener los anuncios" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

/**
 * Inserta un registro para ocultar un anuncio para un usuario específico.
 */
const hideAnnouncement = async (req, res) => {
  const { usuarioId, anuncioId } = req.body;

  if (!usuarioId || !anuncioId) {
    return res.status(400).json({ message: "Datos incompletos (usuarioId, anuncioId)" });
  }

  const query = `
    INSERT INTO TBL_ANUNCIOS_OCULTOS (ID_USUARIO, ID_ANUNCIOS_EVENTOS) 
    VALUES (?, ?)`;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.query(query, [usuarioId, anuncioId]);
    res.status(200).json({ message: "Anuncio ocultado exitosamente" });
  } catch (error) {
    console.error("Error al ocultar el anuncio:", error);
    res.status(500).json({ message: "Error al ocultar el anuncio" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

/**
 * Obtiene las notificaciones personales de un usuario (de la tabla TBL_NOTIFICACIONES_APP).
 */
const getPersonalNotifications = async (req, res) => {
  const { usuarioId } = req.params;

  if (!usuarioId) {
    return res.status(400).json({ message: "El ID de usuario es requerido" });
  }

  const query = `
    SELECT ID_NOTIFICACION, TITULO, MENSAJE as DESCRIPCION, FECHA_HORA, LEIDA 
    FROM TBL_NOTIFICACIONES_APP 
    WHERE ID_USUARIO = ? 
    ORDER BY FECHA_HORA DESC`;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query(query, [usuarioId]);
    res.status(200).json(results);
  } catch (error) {
    console.error("Error al obtener notificaciones personales:", error);
    res.status(500).json({ message: "Error al obtener notificaciones" });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getAnnouncements,
  hideAnnouncement,
  getPersonalNotifications
};
