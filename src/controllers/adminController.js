const { mysqlPool } = require('../config/db');

/**
 * 1. Obtiene métricas y estadísticas consolidadas para el Dashboard Administrativo
 */
const getDashboardStats = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // ── Estadísticas de Usuarios ──
    const [userCounts] = await connection.query(`
      SELECT 
        COUNT(*) AS total_usuarios,
        SUM(CASE WHEN ID_ROL = 1 THEN 1 ELSE 0 END) AS super_admins,
        SUM(CASE WHEN ID_ROL = 4 THEN 1 ELSE 0 END) AS admins,
        SUM(CASE WHEN ID_ROL = 2 THEN 1 ELSE 0 END) AS residentes,
        SUM(CASE WHEN ID_ROL = 3 THEN 1 ELSE 0 END) AS guardias,
        SUM(CASE WHEN ID_ESTADO_USUARIO = 1 THEN 1 ELSE 0 END) AS usuarios_activos,
        SUM(CASE WHEN ID_ESTADO_USUARIO = 2 THEN 1 ELSE 0 END) AS usuarios_inactivos,
        SUM(CASE WHEN ID_ESTADO_USUARIO = 3 THEN 1 ELSE 0 END) AS usuarios_bloqueados,
        SUM(CASE WHEN ID_ESTADO_USUARIO IN (4, 5) THEN 1 ELSE 0 END) AS usuarios_pendientes
      FROM TBL_MS_USUARIO;
    `);

    // ── Estadísticas de Reservaciones ──
    const [reservaCounts] = await connection.query(`
      SELECT 
        COUNT(*) AS total_reservas,
        SUM(CASE WHEN ID_ESTADO_RESERVA = 1 THEN 1 ELSE 0 END) AS reservas_confirmadas,
        SUM(CASE WHEN ID_ESTADO_RESERVA = 3 THEN 1 ELSE 0 END) AS reservas_pendientes,
        SUM(CASE WHEN ID_ESTADO_RESERVA = 2 THEN 1 ELSE 0 END) AS reservas_canceladas
      FROM TBL_RESERVAS;
    `);

    // Reservaciones agrupadas por instalación
    const [reservasPorInstalacion] = await connection.query(`
      SELECT 
        i.NOMBRE_INSTALACION,
        COUNT(r.ID_RESERVA) AS total
      FROM TBL_INSTALACIONES i
      LEFT JOIN TBL_RESERVAS r ON i.ID_INSTALACION = r.ID_INSTALACION
      GROUP BY i.ID_INSTALACION, i.NOMBRE_INSTALACION;
    `);

    // Próximas 5 reservaciones
    const [proximasReservas] = await connection.query(`
      SELECT 
        r.ID_RESERVA,
        r.FECHA_RESERVA,
        r.HORA_INICIO,
        r.HORA_FINAL,
        r.TIPO_EVENTO,
        r.NUM_INVITADO,
        i.NOMBRE_INSTALACION,
        u.NOMBRE_USUARIO,
        er.DESCRIPCION AS ESTADO
      FROM TBL_RESERVAS r
      JOIN TBL_INSTALACIONES i ON r.ID_INSTALACION = i.ID_INSTALACION
      JOIN TBL_MS_USUARIO u ON r.ID_USUARIO = u.ID_USUARIO
      JOIN TBL_ESTADO_RESERVA er ON r.ID_ESTADO_RESERVA = er.ID_ESTADO_RESERVA
      ORDER BY r.FECHA_RESERVA DESC, r.HORA_INICIO ASC
      LIMIT 5;
    `);

    // ── Estadísticas de Accesos / Visitas ──
    const [visitaCounts] = await connection.query(`
      SELECT 
        (SELECT COUNT(*) FROM TBL_BITACORA_VISITA) AS total_accesos_bitacora,
        (SELECT COUNT(*) FROM TBL_BITACORA_VISITA WHERE DATE(FECHA_ACCESO) = CURDATE()) AS accesos_hoy,
        (SELECT COUNT(*) FROM TBL_REGVISITAS) AS total_visitas_generadas,
        (SELECT COUNT(*) FROM TBL_VISITANTES_RECURRENTES) AS total_recurrentes_creados;
    `);

    // Visitas de los últimos 7 días (para el gráfico de tendencias)
    const [tendenciaVisitas] = await connection.query(`
      SELECT 
        DATE_FORMAT(d.dia, '%d/%m') AS fecha,
        COALESCE(COUNT(bv.ID_BITACORA_VISITA), 0) AS total_accesos
      FROM (
        SELECT CURDATE() - INTERVAL 6 DAY AS dia UNION ALL
        SELECT CURDATE() - INTERVAL 5 DAY UNION ALL
        SELECT CURDATE() - INTERVAL 4 DAY UNION ALL
        SELECT CURDATE() - INTERVAL 3 DAY UNION ALL
        SELECT CURDATE() - INTERVAL 2 DAY UNION ALL
        SELECT CURDATE() - INTERVAL 1 DAY UNION ALL
        SELECT CURDATE()
      ) d
      LEFT JOIN TBL_BITACORA_VISITA bv ON DATE(bv.FECHA_ACCESO) = d.dia
      GROUP BY d.dia
      ORDER BY d.dia ASC;
    `);

    // ── Estadísticas de Condominios ──
    const [condoCounts] = await connection.query(`
      SELECT COUNT(*) AS total_condominios FROM TBL_CONDOMINIOS;
    `);

    // ── Estadísticas de Geocerca y Auditoría ──
    const [geocercaStats] = await connection.query(`
      SELECT 
        (SELECT COUNT(*) FROM TBL_GEOCERCAS WHERE ACTIVO = 1) AS geocercas_activas,
        (SELECT COUNT(*) FROM TBL_LOG_ESCANEO_FALLIDO) AS total_escaneos_fallidos,
        (SELECT COUNT(*) FROM TBL_LOG_ESCANEO_FALLIDO WHERE DATE(FECHA_HORA) = CURDATE()) AS fallidos_hoy;
    `);

    res.status(200).json({
      success: true,
      data: {
        usuarios: userCounts[0],
        reservas: {
          ...reservaCounts[0],
          porInstalacion: reservasPorInstalacion,
          proximas: proximasReservas
        },
        visitas: {
          ...visitaCounts[0],
          tendenciaSemanal: tendenciaVisitas
        },
        condominios: condoCounts[0],
        geocerca: geocercaStats[0]
      }
    });

  } catch (error) {
    console.error('Error al obtener estadísticas del dashboard:', error);
    res.status(500).json({ success: false, message: 'Error interno al consultar métricas.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 2. Obtiene la configuración actual de la Geocerca y los últimos logs de escaneo
 */
const getGeocercaConfig = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // Geocerca activa o principal
    const [geocercas] = await connection.query(`
      SELECT 
        g.ID_GEOCERCA,
        g.NOMBRE_ZONA,
        g.DESCRIPCION,
        g.LATITUD_CENTRO,
        g.LONGITUD_CENTRO,
        g.RADIO_METROS,
        g.ACTIVO,
        g.FECHA_CREACION,
        u.NOMBRE_USUARIO AS CREADO_POR_NOMBRE
      FROM TBL_GEOCERCAS g
      LEFT JOIN TBL_MS_USUARIO u ON g.CREADO_POR = u.ID_USUARIO
      ORDER BY g.ID_GEOCERCA ASC
      LIMIT 1;
    `);

    // Parámetros de geocerca en TBL_MS_PARAMETROS
    const [params] = await connection.query(`
      SELECT PARAMETRO, VALOR 
      FROM TBL_MS_PARAMETROS 
      WHERE PARAMETRO IN ('GEOCERCA_ACTIVA', 'PRECISION_MAXIMA_GPS_METROS');
    `);

    const paramMap = {};
    params.forEach(p => {
      paramMap[p.PARAMETRO] = p.VALOR;
    });

    // Últimos 10 escaneos fallidos para auditoría
    const [failedScans] = await connection.query(`
      SELECT 
        l.ID_LOG_ESCANEO,
        l.ID_USUARIO_GUARDIA,
        u.NOMBRE_USUARIO AS NOMBRE_GUARDIA,
        l.LATITUD_INTENTO,
        l.LONGITUD_INTENTO,
        l.DISTANCIA_METROS,
        l.PRECISION_GPS,
        l.MOTIVO_RECHAZO,
        l.DISPOSITIVO,
        l.FECHA_HORA
      FROM TBL_LOG_ESCANEO_FALLIDO l
      LEFT JOIN TBL_MS_USUARIO u ON l.ID_USUARIO_GUARDIA = u.ID_USUARIO
      ORDER BY l.FECHA_HORA DESC
      LIMIT 10;
    `);

    res.status(200).json({
      success: true,
      data: {
        geocerca: geocercas.length > 0 ? geocercas[0] : null,
        parametros: {
          geocerca_activa: paramMap['GEOCERCA_ACTIVA'] === '1',
          precision_maxima: paramMap['PRECISION_MAXIMA_GPS_METROS'] ? Number(paramMap['PRECISION_MAXIMA_GPS_METROS']) : 40
        },
        escaneos_fallidos: failedScans
      }
    });

  } catch (error) {
    console.error('Error al obtener configuración de geocerca:', error);
    res.status(500).json({ success: false, message: 'Error al consultar geocerca.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 3. Actualiza las coordenadas y parámetros de la Geocerca
 * ¡REGLA ESTRICTA!: Solo Super Administrador (ID_ROL = 1)
 */
const updateGeocercaConfig = async (req, res) => {
  // Validación estricta de rol
  if (!req.user || Number(req.user.role) !== 1) {
    return res.status(403).json({
      success: false,
      message: 'Acceso denegado: Solo el SUPER ADMINISTRADOR puede modificar las coordenadas y parámetros de la geocerca.'
    });
  }

  const {
    id_geocerca,
    nombre_zona,
    descripcion,
    latitud_centro,
    longitud_centro,
    radio_metros,
    activo,
    precision_maxima
  } = req.body;

  if (latitud_centro === undefined || longitud_centro === undefined || radio_metros === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Latitud, longitud y radio en metros son campos obligatorios.'
    });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    const latNum = parseFloat(latitud_centro);
    const lngNum = parseFloat(longitud_centro);
    const radioNum = parseFloat(radio_metros);
    const activoVal = activo !== undefined ? (activo ? 1 : 0) : 1;
    const precisionVal = precision_maxima ? parseInt(precision_maxima, 10) : 40;

    // Actualizar o insertar geocerca en TBL_GEOCERCAS
    if (id_geocerca) {
      await connection.query(`
        UPDATE TBL_GEOCERCAS SET
          NOMBRE_ZONA = COALESCE(?, NOMBRE_ZONA),
          DESCRIPCION = COALESCE(?, DESCRIPCION),
          LATITUD_CENTRO = ?,
          LONGITUD_CENTRO = ?,
          RADIO_METROS = ?,
          ACTIVO = ?
        WHERE ID_GEOCERCA = ?;
      `, [nombre_zona || null, descripcion || null, latNum, lngNum, radioNum, activoVal, id_geocerca]);
    } else {
      // Si no existe, verificar si hay alguna o insertar
      const [existing] = await connection.query('SELECT ID_GEOCERCA FROM TBL_GEOCERCAS LIMIT 1');
      if (existing.length > 0) {
        await connection.query(`
          UPDATE TBL_GEOCERCAS SET
            NOMBRE_ZONA = COALESCE(?, NOMBRE_ZONA),
            DESCRIPCION = COALESCE(?, DESCRIPCION),
            LATITUD_CENTRO = ?,
            LONGITUD_CENTRO = ?,
            RADIO_METROS = ?,
            ACTIVO = ?
          WHERE ID_GEOCERCA = ?;
        `, [nombre_zona || null, descripcion || null, latNum, lngNum, radioNum, activoVal, existing[0].ID_GEOCERCA]);
      } else {
        await connection.query(`
          INSERT INTO TBL_GEOCERCAS (NOMBRE_ZONA, DESCRIPCION, LATITUD_CENTRO, LONGITUD_CENTRO, RADIO_METROS, ACTIVO, CREADO_POR)
          VALUES (?, ?, ?, ?, ?, ?, ?);
        `, [
          nombre_zona || 'CASETA PRINCIPAL',
          descripcion || 'Perímetro autorizado para escaneo de QR',
          latNum,
          lngNum,
          radioNum,
          activoVal,
          req.user.id
        ]);
      }
    }

    // Actualizar parámetros globales en TBL_MS_PARAMETROS
    // GEOCERCA_ACTIVA
    const [pActiva] = await connection.query("SELECT ID_PARAMETRO FROM TBL_MS_PARAMETROS WHERE PARAMETRO = 'GEOCERCA_ACTIVA'");
    if (pActiva.length > 0) {
      await connection.query("UPDATE TBL_MS_PARAMETROS SET VALOR = ?, FECHA_MODIFICACION = NOW() WHERE PARAMETRO = 'GEOCERCA_ACTIVA'", [String(activoVal)]);
    } else {
      await connection.query("INSERT INTO TBL_MS_PARAMETROS (ID_USUARIO, PARAMETRO, VALOR, FECHA_CREACION) VALUES (?, 'GEOCERCA_ACTIVA', ?, NOW())", [req.user.id, String(activoVal)]);
    }

    // PRECISION_MAXIMA_GPS_METROS
    const [pPrec] = await connection.query("SELECT ID_PARAMETRO FROM TBL_MS_PARAMETROS WHERE PARAMETRO = 'PRECISION_MAXIMA_GPS_METROS'");
    if (pPrec.length > 0) {
      await connection.query("UPDATE TBL_MS_PARAMETROS SET VALOR = ?, FECHA_MODIFICACION = NOW() WHERE PARAMETRO = 'PRECISION_MAXIMA_GPS_METROS'", [String(precisionVal)]);
    } else {
      await connection.query("INSERT INTO TBL_MS_PARAMETROS (ID_USUARIO, PARAMETRO, VALOR, FECHA_CREACION) VALUES (?, 'PRECISION_MAXIMA_GPS_METROS', ?, NOW())", [req.user.id, String(precisionVal)]);
    }

    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Coordenadas y parámetros de Geocerca actualizados exitosamente por el Super Administrador.'
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error al actualizar geocerca:', error);
    res.status(500).json({ success: false, message: 'Error interno al guardar cambios de geocerca.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 4. Obtiene los registros de las Tablas de Mantenimiento del Sistema
 */
const getMaintenanceTable = async (req, res) => {
  const { table } = req.params;
  let connection;

  try {
    connection = await mysqlPool.getConnection();

    switch (table) {
      case 'usuarios': {
        const [rows] = await connection.query(`
          SELECT 
            u.ID_USUARIO,
            u.NOMBRE_USUARIO,
            u.EMAIL,
            u.ID_ROL,
            r.ROL,
            u.ID_ESTADO_USUARIO,
            eu.DESCRIPCION AS ESTADO_USUARIO,
            u.PRIMER_INGRESO_COMPLETADO,
            p.DNI_PERSONA,
            c.DESCRIPCION AS NUM_CASA
          FROM TBL_MS_USUARIO u
          LEFT JOIN TBL_MS_ROLES r ON u.ID_ROL = r.ID_ROL
          LEFT JOIN TBL_ESTADO_USUARIO eu ON u.ID_ESTADO_USUARIO = eu.ID_ESTADO_USUARIO
          LEFT JOIN TBL_PERSONAS p ON u.ID_USUARIO = p.ID_USUARIO
          LEFT JOIN TBL_CONDOMINIOS c ON p.ID_CONDOMINIO = c.ID_CONDOMINIO
          ORDER BY u.ID_USUARIO DESC;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'reservaciones': {
        const [rows] = await connection.query(`
          SELECT 
            r.ID_RESERVA,
            r.ID_USUARIO,
            u.NOMBRE_USUARIO,
            r.ID_INSTALACION,
            i.NOMBRE_INSTALACION,
            r.ID_ESTADO_RESERVA,
            er.DESCRIPCION AS ESTADO_RESERVA,
            r.TIPO_EVENTO,
            r.NUM_INVITADO,
            r.NOTAS,
            r.FECHA_RESERVA,
            r.HORA_INICIO,
            r.HORA_FINAL
          FROM TBL_RESERVAS r
          JOIN TBL_INSTALACIONES i ON r.ID_INSTALACION = i.ID_INSTALACION
          JOIN TBL_ESTADO_RESERVA er ON r.ID_ESTADO_RESERVA = er.ID_ESTADO_RESERVA
          JOIN TBL_MS_USUARIO u ON r.ID_USUARIO = u.ID_USUARIO
          ORDER BY r.FECHA_RESERVA DESC, r.HORA_INICIO DESC;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'condominios': {
        const [rows] = await connection.query(`
          SELECT 
            c.ID_CONDOMINIO,
            c.DESCRIPCION AS NUM_CASA,
            c.USUARIOS_POR_CASA,
            tc.DESCRIPCION AS TIPO_CONDOMINIO,
            (SELECT COUNT(*) FROM TBL_PERSONAS p WHERE p.ID_CONDOMINIO = c.ID_CONDOMINIO) AS RESIDENTES_ACTUALES
          FROM TBL_CONDOMINIOS c
          LEFT JOIN TBL_TIPO_CONDOMINIO tc ON c.ID_TIPO_CONDOMINIO = tc.ID_TIPO_CONDOMINIO
          ORDER BY CAST(c.DESCRIPCION AS UNSIGNED) ASC, c.ID_CONDOMINIO ASC;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'instalaciones': {
        const [rows] = await connection.query(`
          SELECT 
            ID_INSTALACION,
            NOMBRE_INSTALACION,
            CAPACIDAD,
            PRECIO,
            DESCRIPCION
          FROM TBL_INSTALACIONES
          ORDER BY ID_INSTALACION ASC;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'parametros': {
        const [rows] = await connection.query(`
          SELECT 
            p.ID_PARAMETRO,
            p.PARAMETRO,
            p.VALOR,
            p.FECHA_CREACION,
            p.FECHA_MODIFICACION,
            u.NOMBRE_USUARIO AS CREADO_POR
          FROM TBL_MS_PARAMETROS p
          LEFT JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO
          ORDER BY p.ID_PARAMETRO ASC;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'geocercas': {
        const [rows] = await connection.query(`
          SELECT 
            g.ID_GEOCERCA,
            g.NOMBRE_ZONA,
            g.DESCRIPCION,
            g.LATITUD_CENTRO,
            g.LONGITUD_CENTRO,
            g.RADIO_METROS,
            g.ACTIVO,
            g.FECHA_CREACION,
            u.NOMBRE_USUARIO AS CREADO_POR
          FROM TBL_GEOCERCAS g
          LEFT JOIN TBL_MS_USUARIO u ON g.CREADO_POR = u.ID_USUARIO
          ORDER BY g.ID_GEOCERCA ASC;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'escaneos_fallidos': {
        const [rows] = await connection.query(`
          SELECT 
            l.ID_LOG_ESCANEO,
            l.ID_USUARIO_GUARDIA,
            u.NOMBRE_USUARIO AS NOMBRE_GUARDIA,
            l.LATITUD_INTENTO,
            l.LONGITUD_INTENTO,
            l.DISTANCIA_METROS,
            l.PRECISION_GPS,
            l.MOTIVO_RECHAZO,
            l.DISPOSITIVO,
            l.ORIGEN_IP,
            l.FECHA_HORA
          FROM TBL_LOG_ESCANEO_FALLIDO l
          LEFT JOIN TBL_MS_USUARIO u ON l.ID_USUARIO_GUARDIA = u.ID_USUARIO
          ORDER BY l.FECHA_HORA DESC
          LIMIT 50;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      default:
        return res.status(400).json({ success: false, message: `Tabla '${table}' no reconocida.` });
    }

  } catch (error) {
    console.error(`Error al consultar tabla ${table}:`, error);
    res.status(500).json({ success: false, message: 'Error interno al consultar datos de mantenimiento.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 5. Actualiza un registro de una tabla de mantenimiento
 */
const updateMaintenanceRecord = async (req, res) => {
  const { table, id } = req.params;
  const updates = req.body;
  let connection;

  try {
    connection = await mysqlPool.getConnection();

    switch (table) {
      case 'usuarios': {
        const { ID_ESTADO_USUARIO, ID_ROL } = updates;
        if (ID_ESTADO_USUARIO === undefined && ID_ROL === undefined) {
          return res.status(400).json({ success: false, message: 'No hay campos para actualizar.' });
        }
        await connection.query(`
          UPDATE TBL_MS_USUARIO SET
            ID_ESTADO_USUARIO = COALESCE(?, ID_ESTADO_USUARIO),
            ID_ROL = COALESCE(?, ID_ROL)
          WHERE ID_USUARIO = ?;
        `, [ID_ESTADO_USUARIO, ID_ROL, id]);
        break;
      }

      case 'reservaciones': {
        const { ID_ESTADO_RESERVA, NOTAS } = updates;
        if (ID_ESTADO_RESERVA === undefined) {
          return res.status(400).json({ success: false, message: 'Estado de reserva requerido.' });
        }
        await connection.query(`
          UPDATE TBL_RESERVAS SET
            ID_ESTADO_RESERVA = ?,
            NOTAS = COALESCE(?, NOTAS)
          WHERE ID_RESERVA = ?;
        `, [ID_ESTADO_RESERVA, NOTAS, id]);
        break;
      }

      case 'instalaciones': {
        const { NOMBRE_INSTALACION, CAPACIDAD, PRECIO, DESCRIPCION } = updates;
        await connection.query(`
          UPDATE TBL_INSTALACIONES SET
            NOMBRE_INSTALACION = COALESCE(?, NOMBRE_INSTALACION),
            CAPACIDAD = COALESCE(?, CAPACIDAD),
            PRECIO = COALESCE(?, PRECIO),
            DESCRIPCION = COALESCE(?, DESCRIPCION)
          WHERE ID_INSTALACION = ?;
        `, [NOMBRE_INSTALACION, CAPACIDAD, PRECIO, DESCRIPCION, id]);
        break;
      }

      case 'parametros': {
        const { VALOR } = updates;
        if (VALOR === undefined) {
          return res.status(400).json({ success: false, message: 'Valor requerido.' });
        }
        await connection.query(`
          UPDATE TBL_MS_PARAMETROS SET
            VALOR = ?,
            FECHA_MODIFICACION = NOW()
          WHERE ID_PARAMETRO = ?;
        `, [VALOR, id]);
        break;
      }

      default:
        return res.status(400).json({ success: false, message: `Operación no soportada para ${table}.` });
    }

    res.status(200).json({ success: true, message: `Registro ${id} actualizado correctamente en ${table}.` });

  } catch (error) {
    console.error(`Error al actualizar tabla ${table}:`, error);
    res.status(500).json({ success: false, message: 'Error interno al actualizar registro.' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getDashboardStats,
  getGeocercaConfig,
  updateGeocercaConfig,
  getMaintenanceTable,
  updateMaintenanceRecord
};
