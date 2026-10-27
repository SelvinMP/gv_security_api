const { mysqlPool } = require('../config/db');
const bcrypt = require('bcrypt');

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

    const totalReservas = reservaCounts[0]?.total_reservas || 0;

    // Reservaciones agrupadas por instalación REAL de la Base de Datos
    const [reservasPorInstalacionRaw] = await connection.query(`
      SELECT 
        i.ID_INSTALACION,
        i.NOMBRE_INSTALACION,
        i.CAPACIDAD,
        i.PRECIO,
        COUNT(r.ID_RESERVA) AS total
      FROM TBL_INSTALACIONES i
      LEFT JOIN TBL_RESERVAS r ON i.ID_INSTALACION = r.ID_INSTALACION
      GROUP BY i.ID_INSTALACION, i.NOMBRE_INSTALACION, i.CAPACIDAD, i.PRECIO
      ORDER BY total DESC;
    `);

    const reservasPorInstalacion = reservasPorInstalacionRaw.map(item => ({
      ID_INSTALACION: item.ID_INSTALACION,
      NOMBRE_INSTALACION: item.NOMBRE_INSTALACION,
      CAPACIDAD: item.CAPACIDAD,
      PRECIO: item.PRECIO,
      total: Number(item.total),
      porcentaje: totalReservas > 0 ? Math.round((Number(item.total) / totalReservas) * 100) : 0
    }));

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

    // ── Detalle Dinámico de Estados de Usuario ──
    const [estadosDetalle] = await connection.query(`
      SELECT 
        eu.ID_ESTADO_USUARIO,
        eu.DESCRIPCION AS ESTADO,
        COUNT(u.ID_USUARIO) AS total,
        COALESCE(ROUND((COUNT(u.ID_USUARIO) / NULLIF((SELECT COUNT(*) FROM TBL_MS_USUARIO), 0)) * 100, 1), 0) AS porcentaje
      FROM TBL_ESTADO_USUARIO eu
      LEFT JOIN TBL_MS_USUARIO u ON eu.ID_ESTADO_USUARIO = u.ID_ESTADO_USUARIO
      GROUP BY eu.ID_ESTADO_USUARIO, eu.DESCRIPCION
      ORDER BY eu.ID_ESTADO_USUARIO ASC;
    `);

    // ── Detalle Dinámico de Roles de Usuario ──
    const [rolesDetalle] = await connection.query(`
      SELECT 
        r.ID_ROL,
        r.ROL,
        r.DESCRIPCION,
        COUNT(u.ID_USUARIO) AS total,
        COALESCE(ROUND((COUNT(u.ID_USUARIO) / NULLIF((SELECT COUNT(*) FROM TBL_MS_USUARIO), 0)) * 100, 1), 0) AS porcentaje
      FROM TBL_MS_ROLES r
      LEFT JOIN TBL_MS_USUARIO u ON r.ID_ROL = u.ID_ROL
      GROUP BY r.ID_ROL, r.ROL, r.DESCRIPCION
      ORDER BY r.ID_ROL ASC;
    `);

    // ── Estadísticas de Accesos / Visitas ──
    const [visitaCounts] = await connection.query(`
      SELECT 
        (SELECT COUNT(*) FROM TBL_BITACORA_VISITA) AS total_accesos_bitacora,
        (SELECT COUNT(*) FROM TBL_BITACORA_VISITA WHERE DATE(COALESCE(FECHA_ACCESO, FECHA_HORA)) = CURDATE()) AS accesos_hoy,
        (SELECT COUNT(*) FROM TBL_REGVISITAS) AS total_visitas_generadas,
        (SELECT COUNT(*) FROM TBL_VISITANTES_RECURRENTES) AS total_recurrentes_creados;
    `);

    // ── Tendencia Día (Últimas 24 horas por bloques de 2 horas) ──
    const [visitasDiaRaw] = await connection.query(`
      SELECT 
        HOUR(COALESCE(FECHA_ACCESO, FECHA_HORA)) AS hora,
        COUNT(*) AS total_accesos
      FROM TBL_BITACORA_VISITA
      WHERE DATE(COALESCE(FECHA_ACCESO, FECHA_HORA)) = CURDATE()
         OR DATE(COALESCE(FECHA_ACCESO, FECHA_HORA)) = (SELECT DATE(MAX(COALESCE(FECHA_ACCESO, FECHA_HORA))) FROM TBL_BITACORA_VISITA)
      GROUP BY HOUR(COALESCE(FECHA_ACCESO, FECHA_HORA))
      ORDER BY hora ASC;
    `);

    const horasMap = {};
    visitasDiaRaw.forEach(r => { horasMap[r.hora] = Number(r.total_accesos); });
    const tendenciaDia = [];
    for (let h = 0; h < 24; h += 2) {
      const sum = (horasMap[h] || 0) + (horasMap[h + 1] || 0);
      tendenciaDia.push({
        label: `${String(h).padStart(2, '0')}:00`,
        total_accesos: sum
      });
    }

    // ── Tendencia Semana (Últimos 7 días con nombres de días) ──
    const [tendenciaSemana] = await connection.query(`
      SELECT 
        DATE_FORMAT(d.dia, '%d/%m') AS fecha,
        CASE DAYOFWEEK(d.dia)
          WHEN 1 THEN 'Dom'
          WHEN 2 THEN 'Lun'
          WHEN 3 THEN 'Mar'
          WHEN 4 THEN 'Mié'
          WHEN 5 THEN 'Jue'
          WHEN 6 THEN 'Vie'
          WHEN 7 THEN 'Sáb'
        END AS dia_semana,
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
      LEFT JOIN TBL_BITACORA_VISITA bv ON DATE(COALESCE(bv.FECHA_ACCESO, bv.FECHA_HORA)) = d.dia
      GROUP BY d.dia
      ORDER BY d.dia ASC;
    `);

    // ── Tendencia Mes (Últimos 30 días día a día) ──
    const [visitasMesRaw] = await connection.query(`
      SELECT 
        DATE_FORMAT(COALESCE(FECHA_ACCESO, FECHA_HORA), '%d/%m') AS fecha,
        COUNT(*) AS total_accesos
      FROM TBL_BITACORA_VISITA
      WHERE COALESCE(FECHA_ACCESO, FECHA_HORA) >= CURDATE() - INTERVAL 30 DAY
      GROUP BY DATE_FORMAT(COALESCE(FECHA_ACCESO, FECHA_HORA), '%d/%m');
    `);

    const mesMap = {};
    visitasMesRaw.forEach(r => { mesMap[r.fecha] = Number(r.total_accesos); });

    const [dias30] = await connection.query(`
      SELECT DATE_FORMAT(CURDATE() - INTERVAL n DAY, '%d/%m') AS fecha
      FROM (
        SELECT 29 AS n UNION ALL SELECT 28 UNION ALL SELECT 27 UNION ALL SELECT 26 UNION ALL SELECT 25 UNION ALL
        SELECT 24 UNION ALL SELECT 23 UNION ALL SELECT 22 UNION ALL SELECT 21 UNION ALL SELECT 20 UNION ALL
        SELECT 19 UNION ALL SELECT 18 UNION ALL SELECT 17 UNION ALL SELECT 16 UNION ALL SELECT 15 UNION ALL
        SELECT 14 UNION ALL SELECT 13 UNION ALL SELECT 12 UNION ALL SELECT 11 UNION ALL SELECT 10 UNION ALL
        SELECT 9 UNION ALL SELECT 8 UNION ALL SELECT 7 UNION ALL SELECT 6 UNION ALL SELECT 5 UNION ALL
        SELECT 4 UNION ALL SELECT 3 UNION ALL SELECT 2 UNION ALL SELECT 1 UNION ALL SELECT 0
      ) seq
      ORDER BY n DESC;
    `);

    const tendenciaMes = dias30.map(d => ({
      fecha: d.fecha,
      label: d.fecha,
      total_accesos: mesMap[d.fecha] || 0
    }));

    // ── Tendencia Año (Últimos 12 meses) ──
    const [visitasAñoRaw] = await connection.query(`
      SELECT 
        DATE_FORMAT(COALESCE(FECHA_ACCESO, FECHA_HORA), '%Y-%m') AS mes_key,
        COUNT(*) AS total_accesos
      FROM TBL_BITACORA_VISITA
      WHERE COALESCE(FECHA_ACCESO, FECHA_HORA) >= CURDATE() - INTERVAL 12 MONTH
      GROUP BY mes_key;
    `);

    const anoMap = {};
    visitasAñoRaw.forEach(r => { anoMap[r.mes_key] = Number(r.total_accesos); });

    const [meses12] = await connection.query(`
      SELECT 
        DATE_FORMAT(CURDATE() - INTERVAL n MONTH, '%Y-%m') AS mes_key,
        CASE DATE_FORMAT(CURDATE() - INTERVAL n MONTH, '%m')
          WHEN '01' THEN 'Ene'
          WHEN '02' THEN 'Feb'
          WHEN '03' THEN 'Mar'
          WHEN '04' THEN 'Abr'
          WHEN '05' THEN 'May'
          WHEN '06' THEN 'Jun'
          WHEN '07' THEN 'Jul'
          WHEN '08' THEN 'Ago'
          WHEN '09' THEN 'Sep'
          WHEN '10' THEN 'Oct'
          WHEN '11' THEN 'Nov'
          WHEN '12' THEN 'Dic'
        END AS mes_nombre
      FROM (
        SELECT 11 AS n UNION ALL SELECT 10 UNION ALL SELECT 9 UNION ALL SELECT 8 UNION ALL
        SELECT 7 UNION ALL SELECT 6 UNION ALL SELECT 5 UNION ALL SELECT 4 UNION ALL
        SELECT 3 UNION ALL SELECT 2 UNION ALL SELECT 1 UNION ALL SELECT 0
      ) seq
      ORDER BY n DESC;
    `);

    const tendenciaAño = meses12.map(m => ({
      mes_key: m.mes_key,
      label: m.mes_nombre,
      total_accesos: anoMap[m.mes_key] || 0
    }));

    // ── Estadísticas de Condominios y Capacidad Total ──
    const [condoMetrics] = await connection.query(`
      SELECT 
        COUNT(*) AS total_condominios,
        COALESCE(SUM(USUARIOS_POR_CASA), 0) AS total_capacidad_usuarios,
        (SELECT COUNT(DISTINCT ID_CONDOMINIO) FROM TBL_PERSONAS WHERE ID_CONDOMINIO IS NOT NULL) AS condominios_ocupados,
        (SELECT COUNT(*) FROM TBL_PERSONAS WHERE ID_CONDOMINIO IS NOT NULL) AS residentes_asignados
      FROM TBL_CONDOMINIOS;
    `);

    const totalCondominios = Number(condoMetrics[0]?.total_condominios || 0);
    const condominiosOcupados = Number(condoMetrics[0]?.condominios_ocupados || 0);
    const totalCapacidadUsuarios = Number(condoMetrics[0]?.total_capacidad_usuarios || 0);
    const residentesAsignados = Number(condoMetrics[0]?.residentes_asignados || 0);
    const tasaOcupacion = totalCondominios > 0 ? Math.round((condominiosOcupados / totalCondominios) * 100) : 0;

    // ── Documentación / Identificación de Personas ──
    const [personasDocCounts] = await connection.query(`
      SELECT 
        COUNT(*) AS total_personas,
        SUM(CASE WHEN DNI_PERSONA IS NOT NULL AND DNI_PERSONA != '' THEN 1 ELSE 0 END) AS con_dni,
        SUM(CASE WHEN NUM_CARNET_EXTRANJERO IS NOT NULL AND NUM_CARNET_EXTRANJERO != '' THEN 1 ELSE 0 END) AS extranjeros,
        SUM(CASE WHEN ID_CONDOMINIO IS NOT NULL THEN 1 ELSE 0 END) AS con_condominio
      FROM TBL_PERSONAS;
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
        usuarios: {
          ...userCounts[0],
          estados: estadosDetalle,
          roles: rolesDetalle,
          documentos: {
            con_dni: Number(personasDocCounts[0]?.con_dni || 0),
            extranjeros: Number(personasDocCounts[0]?.extranjeros || 0),
            total_personas: Number(personasDocCounts[0]?.total_personas || 0)
          }
        },
        reservas: {
          ...reservaCounts[0],
          total_reservas: Number(reservaCounts[0]?.total_reservas || 0),
          reservas_confirmadas: Number(reservaCounts[0]?.reservas_confirmadas || 0),
          reservas_pendientes: Number(reservaCounts[0]?.reservas_pendientes || 0),
          reservas_canceladas: Number(reservaCounts[0]?.reservas_canceladas || 0),
          porInstalacion: reservasPorInstalacion,
          proximas: proximasReservas
        },
        visitas: {
          ...visitaCounts[0],
          tendenciaSemanal: tendenciaSemana,
          tendenciaDia,
          tendenciaSemana,
          tendenciaMes,
          tendenciaAño
        },
        condominios: {
          total_condominios: totalCondominios,
          total_capacidad_usuarios: totalCapacidadUsuarios,
          condominios_ocupados: condominiosOcupados,
          residentes_asignados: residentesAsignados,
          tasa_ocupacion: tasaOcupacion
        },
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

    const [params] = await connection.query(`
      SELECT PARAMETRO, VALOR 
      FROM TBL_MS_PARAMETROS 
      WHERE PARAMETRO IN ('GEOCERCA_ACTIVA', 'PRECISION_MAXIMA_GPS_METROS');
    `);

    const paramMap = {};
    params.forEach(p => {
      paramMap[p.PARAMETRO] = p.VALOR;
    });

    const [failedScans] = await connection.query(`
      SELECT 
        l.ID_LOG_ESCANEO,
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
 * 4. Obtiene opciones de formulario (Roles, Estados, Instalaciones, Condominios) para selects de los modales CRUD
 */
const getFormOptions = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // Excluir rol 1 (SUPER ADMINISTRADOR) para que no pueda ser asignado desde la app
    const [roles] = await connection.query('SELECT ID_ROL, ROL, DESCRIPCION FROM TBL_MS_ROLES WHERE ID_ROL != 1 AND UPPER(ROL) NOT LIKE "%SUPER%" ORDER BY ID_ROL ASC');
    const [estadosUsuario] = await connection.query('SELECT ID_ESTADO_USUARIO, DESCRIPCION FROM TBL_ESTADO_USUARIO ORDER BY ID_ESTADO_USUARIO ASC');
    const [estadosReserva] = await connection.query('SELECT ID_ESTADO_RESERVA, DESCRIPCION FROM TBL_ESTADO_RESERVA ORDER BY ID_ESTADO_RESERVA ASC');
    const [tiposCondominio] = await connection.query('SELECT ID_TIPO_CONDOMINIO, DESCRIPCION FROM TBL_TIPO_CONDOMINIO ORDER BY ID_TIPO_CONDOMINIO ASC');
    const [instalaciones] = await connection.query('SELECT ID_INSTALACION, NOMBRE_INSTALACION, CAPACIDAD, PRECIO FROM TBL_INSTALACIONES ORDER BY ID_INSTALACION ASC');
    const [condominios] = await connection.query('SELECT ID_CONDOMINIO, DESCRIPCION FROM TBL_CONDOMINIOS ORDER BY CAST(DESCRIPCION AS UNSIGNED) ASC, ID_CONDOMINIO ASC');
    const [usuarios] = await connection.query('SELECT ID_USUARIO, NOMBRE_USUARIO, EMAIL FROM TBL_MS_USUARIO WHERE ID_ESTADO_USUARIO = 1 ORDER BY NOMBRE_USUARIO ASC');

    res.status(200).json({
      success: true,
      data: {
        roles,
        estadosUsuario,
        estadosReserva,
        tiposCondominio,
        instalaciones,
        condominios,
        usuarios
      }
    });
  } catch (error) {
    console.error('Error al obtener opciones para formularios:', error);
    res.status(500).json({ success: false, message: 'Error al consultar listas maestras.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 5. Obtiene los registros de las Tablas de Mantenimiento con campos limpios y sin exponer ID al usuario
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
            p.DNI_PERSONA,
            p.ID_CONDOMINIO,
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
            c.ID_TIPO_CONDOMINIO,
            tc.DESCRIPCION AS TIPO_CONDOMINIO,
            c.USUARIOS_POR_CASA,
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

      case 'escaneos_fallidos': {
        const [rows] = await connection.query(`
          SELECT 
            l.ID_LOG_ESCANEO,
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

      case 'bitacoras':
      case 'bitacora_visitas': {
        const [rows] = await connection.query(`
          SELECT 
            bv.ID_BITACORA_VISITA,
            COALESCE(rv.NOMBRE_VISITANTE, vr.NOMBRE_VISITANTE, 'Visitante General') AS NOMBRE_VISITANTE,
            COALESCE(rv.DNI_VISITANTE, vr.DNI_VISITANTE, '-') AS DNI_VISITANTE,
            CASE 
              WHEN bv.ID_VISITANTES_RECURRENTES IS NOT NULL THEN 'Recurrente'
              ELSE 'Visita Única'
            END AS TIPO_VISITA,
            u_residente.NOMBRE_USUARIO AS NOMBRE_RESIDENTE,
            condo.DESCRIPCION AS NUM_CASA,
            COALESCE(u_guardia.NOMBRE_USUARIO, 'Guardia de Caseta') AS NOMBRE_GUARDIA,
            bv.NUM_PERSONA,
            COALESCE(NULLIF(bv.NUM_PLACA, ''), NULLIF(rv.NUM_PLACA, ''), NULLIF(vr.NUM_PLACA, ''), 'Peatonal') AS NUM_PLACA,
            bv.FECHA_ACCESO,
            bv.FECHA_HORA,
            bv.FECHA_VENCIMIENTO,
            bv.NOTA,
            geo.NOMBRE_ZONA AS GEOCERCA_ZONA,
            bv.LATITUD_ESCANEO,
            bv.LONGITUD_ESCANEO,
            bv.DISTANCIA_METROS,
            bv.PRECISION_GPS
          FROM TBL_BITACORA_VISITA bv
          LEFT JOIN TBL_PERSONAS p ON bv.ID_PERSONA = p.ID_PERSONA
          LEFT JOIN TBL_MS_USUARIO u_residente ON p.ID_USUARIO = u_residente.ID_USUARIO
          LEFT JOIN TBL_CONDOMINIOS condo ON p.ID_CONDOMINIO = condo.ID_CONDOMINIO
          LEFT JOIN TBL_REGVISITAS rv ON bv.ID_VISITANTE = rv.ID_VISITANTE
          LEFT JOIN TBL_VISITANTES_RECURRENTES vr ON bv.ID_VISITANTES_RECURRENTES = vr.ID_VISITANTES_RECURRENTES
          LEFT JOIN TBL_MS_USUARIO u_guardia ON bv.ID_USUARIO_GUARDIA = u_guardia.ID_USUARIO
          LEFT JOIN TBL_GEOCERCAS geo ON bv.ID_GEOCERCA = geo.ID_GEOCERCA
          ORDER BY COALESCE(bv.FECHA_ACCESO, bv.FECHA_HORA) DESC;
        `);
        return res.status(200).json({ success: true, table: 'bitacoras', data: rows });
      }

      case 'logs_usuarios': {
        const [rows] = await connection.query(`
          SELECT 
            lu.ID_LOG_USUARIO,
            lu.NOMBRE_USUARIO,
            lu.EMAIL,
            COALESCE(r.ROL, 'Usuario') AS ROL,
            lu.FECHA_ELIMINACION,
            COALESCE(lu.USUARIO_ELIMINACION, 'Sistema') AS USUARIO_ELIMINACION,
            COALESCE(lu.ORIGEN_IP, 'Desconocida') AS ORIGEN_IP,
            COALESCE(lu.NAVEGADOR, 'Navegador web') AS NAVEGADOR
          FROM TBL_LOG_USUARIO lu
          LEFT JOIN TBL_MS_ROLES r ON lu.ID_ROL = r.ID_ROL
          ORDER BY lu.FECHA_ELIMINACION DESC
          LIMIT 200;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'logs_personas': {
        const [rows] = await connection.query(`
          SELECT 
            lp.ID_LOG_PERSONA,
            lp.NOMBRE_PERSONA,
            COALESCE(lp.DNI_PERSONA, '-') AS DNI_PERSONA,
            COALESCE(condo.DESCRIPCION, 'No asignada') AS NUM_CASA,
            lp.FECHA_ELIMINACION,
            COALESCE(lp.USUARIO_ELIMINACION, 'Sistema') AS USUARIO_ELIMINACION,
            COALESCE(lp.ORIGEN_IP, 'Desconocida') AS ORIGEN_IP,
            COALESCE(lp.NAVEGADOR, 'Navegador web') AS NAVEGADOR
          FROM TBL_LOG_PERSONA lp
          LEFT JOIN TBL_CONDOMINIOS condo ON lp.ID_CONDOMINIO = condo.ID_CONDOMINIO
          ORDER BY lp.FECHA_ELIMINACION DESC
          LIMIT 200;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'logs_parametros': {
        const [rows] = await connection.query(`
          SELECT 
            lp.ID_LOG_PARAMETRO,
            lp.PARAMETRO,
            lp.VALOR,
            lp.FECHA_ELIMINACION,
            COALESCE(lp.USUARIO_ELIMINACION, 'Sistema') AS USUARIO_ELIMINACION,
            COALESCE(lp.ORIGEN_IP, 'Desconocida') AS ORIGEN_IP,
            COALESCE(lp.NAVEGADOR, 'Navegador web') AS NAVEGADOR
          FROM TBL_LOG_PARAMETROS lp
          ORDER BY lp.FECHA_ELIMINACION DESC
          LIMIT 200;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'logs_roles': {
        const [rows] = await connection.query(`
          SELECT 
            lr.ID_LOG_ROL,
            lr.ROL,
            COALESCE(lr.DESCRIPCION, '-') AS DESCRIPCION,
            lr.FECHA_ELIMINACION,
            COALESCE(lr.USUARIO_ELIMINACION, 'Sistema') AS USUARIO_ELIMINACION,
            COALESCE(lr.ORIGEN_IP, 'Desconocida') AS ORIGEN_IP,
            COALESCE(lr.NAVEGADOR, 'Navegador web') AS NAVEGADOR
          FROM TBL_LOG_ROLES lr
          ORDER BY lr.FECHA_ELIMINACION DESC
          LIMIT 200;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'logs_permisos': {
        const [rows] = await connection.query(`
          SELECT 
            lp.ID_LOG_PERMISO,
            COALESCE(r.ROL, 'Rol General') AS ROL,
            lp.FECHA_ELIMINACION,
            COALESCE(lp.USUARIO_ELIMINACION, 'Sistema') AS USUARIO_ELIMINACION,
            COALESCE(lp.ORIGEN_IP, 'Desconocida') AS ORIGEN_IP,
            COALESCE(lp.NAVEGADOR, 'Navegador web') AS NAVEGADOR
          FROM TBL_LOG_PERMISOS lp
          LEFT JOIN TBL_MS_ROLES r ON lp.ID_ROL = r.ID_ROL
          ORDER BY lp.FECHA_ELIMINACION DESC
          LIMIT 200;
        `);
        return res.status(200).json({ success: true, table, data: rows });
      }

      case 'logs_contrasenas': {
        const [rows] = await connection.query(`
          SELECT 
            lh.ID_LOG_HIST,
            COALESCE(u.NOMBRE_USUARIO, 'Usuario') AS NOMBRE_USUARIO,
            lh.FECHA_ELIMINACION,
            COALESCE(lh.USUARIO_ELIMINACION, 'Sistema') AS USUARIO_ELIMINACION,
            COALESCE(lh.ORIGEN_IP, 'Desconocida') AS ORIGEN_IP,
            COALESCE(lh.NAVEGADOR, 'Navegador web') AS NAVEGADOR
          FROM \`TBL_LOG_HISTORIAL_CONTRASEÑA\` lh
          LEFT JOIN TBL_MS_USUARIO u ON lh.ID_USUARIO = u.ID_USUARIO
          ORDER BY lh.FECHA_ELIMINACION DESC
          LIMIT 200;
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
 * 6. CREAR (INSERT) registro nuevo en tabla de mantenimiento
 */
const createMaintenanceRecord = async (req, res) => {
  const { table } = req.params;
  const data = req.body;

  if (table === 'bitacoras' || table === 'bitacora_visitas' || table === 'escaneos_fallidos' || table.startsWith('log')) {
    return res.status(403).json({
      success: false,
      message: 'Las bitácoras y registros de auditoría son de solo lectura y no pueden crearse manualmente.'
    });
  }

  let connection;

  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    switch (table) {
      case 'usuarios': {
        const { NOMBRE_USUARIO, EMAIL, CONTRASEÑA, ID_ROL, ID_ESTADO_USUARIO, DNI_PERSONA, ID_CONDOMINIO } = data;
        if (!NOMBRE_USUARIO || !EMAIL || !CONTRASEÑA) {
          return res.status(400).json({ success: false, message: 'Nombre, email y contraseña son obligatorios.' });
        }

        // Proteger el rol de Super Administrador
        if (Number(ID_ROL) === 1) {
          await connection.rollback();
          return res.status(403).json({ success: false, message: 'El rol de Super Administrador solo puede ser asignado a nivel de base de datos.' });
        }

        const [exists] = await connection.query('SELECT ID_USUARIO FROM TBL_MS_USUARIO WHERE EMAIL = ?', [EMAIL]);
        if (exists.length > 0) {
          return res.status(400).json({ success: false, message: 'El correo electrónico ya está registrado.' });
        }

        const hashedPassword = await bcrypt.hash(CONTRASEÑA, 8);
        const [userResult] = await connection.query(`
          INSERT INTO TBL_MS_USUARIO (NOMBRE_USUARIO, EMAIL, CONTRASEÑA, ID_ROL, ID_ESTADO_USUARIO, PRIMER_INGRESO_COMPLETADO, PRIMER_INGRESO)
          VALUES (?, ?, ?, ?, ?, 1, NOW());
        `, [NOMBRE_USUARIO, EMAIL, hashedPassword, ID_ROL || 2, ID_ESTADO_USUARIO || 1]);

        const newUserId = userResult.insertId;

        // Crear registro en TBL_PERSONAS
        await connection.query(`
          INSERT INTO TBL_PERSONAS (ID_USUARIO, DNI_PERSONA, ID_CONDOMINIO, ID_ESTADO_PERSONA)
          VALUES (?, ?, ?, ?);
        `, [newUserId, DNI_PERSONA || null, ID_CONDOMINIO || null, ID_ESTADO_USUARIO || 1]);

        break;
      }

      case 'instalaciones': {
        const { NOMBRE_INSTALACION, CAPACIDAD, PRECIO, DESCRIPCION } = data;
        if (!NOMBRE_INSTALACION) {
          return res.status(400).json({ success: false, message: 'El nombre de la instalación es obligatorio.' });
        }
        await connection.query(`
          INSERT INTO TBL_INSTALACIONES (NOMBRE_INSTALACION, CAPACIDAD, PRECIO, DESCRIPCION)
          VALUES (?, ?, ?, ?);
        `, [
          NOMBRE_INSTALACION.toUpperCase().trim(),
          Number(CAPACIDAD) || 30,
          parseFloat(PRECIO) || 0,
          DESCRIPCION || 'EN BASE A LA ADMINISTRACION'
        ]);
        break;
      }

      case 'condominios': {
        const { NUM_CASA, ID_TIPO_CONDOMINIO, USUARIOS_POR_CASA } = data;
        if (!NUM_CASA) {
          return res.status(400).json({ success: false, message: 'El número o identificador de casa es obligatorio.' });
        }
        await connection.query(`
          INSERT INTO TBL_CONDOMINIOS (DESCRIPCION, ID_TIPO_CONDOMINIO, USUARIOS_POR_CASA)
          VALUES (?, ?, ?);
        `, [
          String(NUM_CASA).trim(),
          Number(ID_TIPO_CONDOMINIO) || 1,
          Number(USUARIOS_POR_CASA) || 4
        ]);
        break;
      }

      case 'reservaciones': {
        const { ID_USUARIO, ID_INSTALACION, FECHA_RESERVA, HORA_INICIO, HORA_FINAL, TIPO_EVENTO, NUM_INVITADO, NOTAS, ID_ESTADO_RESERVA } = data;
        if (!ID_USUARIO || !ID_INSTALACION || !FECHA_RESERVA || !HORA_INICIO || !HORA_FINAL) {
          return res.status(400).json({ success: false, message: 'Usuario, instalación, fecha y horarios son requeridos.' });
        }
        await connection.query(`
          INSERT INTO TBL_RESERVAS (ID_USUARIO, ID_INSTALACION, ID_ESTADO_RESERVA, TIPO_EVENTO, NUM_INVITADO, NOTAS, FECHA_RESERVA, HORA_INICIO, HORA_FINAL)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `, [
          ID_USUARIO,
          ID_INSTALACION,
          ID_ESTADO_RESERVA || 1,
          TIPO_EVENTO || 'EVENTO SOCIAL',
          Number(NUM_INVITADO) || 10,
          NOTAS || '',
          FECHA_RESERVA,
          HORA_INICIO,
          HORA_FINAL
        ]);
        break;
      }

      case 'parametros': {
        const { PARAMETRO, VALOR } = data;
        if (!PARAMETRO || VALOR === undefined) {
          return res.status(400).json({ success: false, message: 'Nombre del parámetro y valor son obligatorios.' });
        }
        await connection.query(`
          INSERT INTO TBL_MS_PARAMETROS (ID_USUARIO, PARAMETRO, VALOR, FECHA_CREACION)
          VALUES (?, ?, ?, NOW());
        `, [req.user.id, PARAMETRO.toUpperCase().trim(), String(VALOR)]);
        break;
      }

      default:
        await connection.rollback();
        return res.status(400).json({ success: false, message: `Creación no soportada para tabla ${table}.` });
    }

    await connection.commit();
    res.status(201).json({ success: true, message: `Nuevo registro creado con éxito en ${table}.` });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`Error al crear en ${table}:`, error);
    res.status(500).json({ success: false, message: error.message || 'Error interno al crear registro.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 7. MODIFICAR (UPDATE) registro existente en tabla de mantenimiento
 */
const updateMaintenanceRecord = async (req, res) => {
  const { table, id } = req.params;
  const updates = req.body;

  if (table === 'bitacoras' || table === 'bitacora_visitas' || table === 'escaneos_fallidos' || table.startsWith('log')) {
    return res.status(403).json({
      success: false,
      message: 'Las bitácoras y registros de auditoría son inmutables y no pueden modificarse.'
    });
  }

  let connection;

  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    switch (table) {
      case 'usuarios': {
        const { NOMBRE_USUARIO, EMAIL, CONTRASEÑA, ID_ROL, ID_ESTADO_USUARIO, DNI_PERSONA, ID_CONDOMINIO } = updates;

        // Proteger el rol de Super Administrador
        if (ID_ROL !== undefined && Number(ID_ROL) === 1) {
          await connection.rollback();
          return res.status(403).json({ success: false, message: 'El rol de Super Administrador solo puede ser asignado a nivel de base de datos.' });
        }

        let passwordQuery = '';
        const params = [NOMBRE_USUARIO, EMAIL, ID_ROL, ID_ESTADO_USUARIO];

        if (CONTRASEÑA && CONTRASEÑA.trim() !== '') {
          const hashedPassword = await bcrypt.hash(CONTRASEÑA, 8);
          passwordQuery = ', CONTRASEÑA = ?';
          params.push(hashedPassword);
        }

        params.push(id);

        await connection.query(`
          UPDATE TBL_MS_USUARIO SET
            NOMBRE_USUARIO = COALESCE(?, NOMBRE_USUARIO),
            EMAIL = COALESCE(?, EMAIL),
            ID_ROL = COALESCE(?, ID_ROL),
            ID_ESTADO_USUARIO = COALESCE(?, ID_ESTADO_USUARIO)
            ${passwordQuery}
          WHERE ID_USUARIO = ?;
        `, params);

        // Actualizar datos de persona
        if (DNI_PERSONA !== undefined || ID_CONDOMINIO !== undefined) {
          const [persona] = await connection.query('SELECT ID_PERSONA FROM TBL_PERSONAS WHERE ID_USUARIO = ?', [id]);
          if (persona.length > 0) {
            await connection.query(`
              UPDATE TBL_PERSONAS SET
                DNI_PERSONA = COALESCE(?, DNI_PERSONA),
                ID_CONDOMINIO = COALESCE(?, ID_CONDOMINIO),
                ID_ESTADO_PERSONA = COALESCE(?, ID_ESTADO_PERSONA)
              WHERE ID_USUARIO = ?;
            `, [DNI_PERSONA, ID_CONDOMINIO, ID_ESTADO_USUARIO, id]);
          } else {
            await connection.query(`
              INSERT INTO TBL_PERSONAS (ID_USUARIO, DNI_PERSONA, ID_CONDOMINIO, ID_ESTADO_PERSONA)
              VALUES (?, ?, ?, ?);
            `, [id, DNI_PERSONA || null, ID_CONDOMINIO || null, ID_ESTADO_USUARIO || 1]);
          }
        }
        break;
      }

      case 'reservaciones': {
        const { ID_ESTADO_RESERVA, ID_INSTALACION, FECHA_RESERVA, HORA_INICIO, HORA_FINAL, TIPO_EVENTO, NUM_INVITADO, NOTAS } = updates;
        await connection.query(`
          UPDATE TBL_RESERVAS SET
            ID_ESTADO_RESERVA = COALESCE(?, ID_ESTADO_RESERVA),
            ID_INSTALACION = COALESCE(?, ID_INSTALACION),
            FECHA_RESERVA = COALESCE(?, FECHA_RESERVA),
            HORA_INICIO = COALESCE(?, HORA_INICIO),
            HORA_FINAL = COALESCE(?, HORA_FINAL),
            TIPO_EVENTO = COALESCE(?, TIPO_EVENTO),
            NUM_INVITADO = COALESCE(?, NUM_INVITADO),
            NOTAS = COALESCE(?, NOTAS)
          WHERE ID_RESERVA = ?;
        `, [ID_ESTADO_RESERVA, ID_INSTALACION, FECHA_RESERVA, HORA_INICIO, HORA_FINAL, TIPO_EVENTO, NUM_INVITADO, NOTAS, id]);
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

      case 'condominios': {
        const { NUM_CASA, ID_TIPO_CONDOMINIO, USUARIOS_POR_CASA } = updates;
        await connection.query(`
          UPDATE TBL_CONDOMINIOS SET
            DESCRIPCION = COALESCE(?, DESCRIPCION),
            ID_TIPO_CONDOMINIO = COALESCE(?, ID_TIPO_CONDOMINIO),
            USUARIOS_POR_CASA = COALESCE(?, USUARIOS_POR_CASA)
          WHERE ID_CONDOMINIO = ?;
        `, [NUM_CASA, ID_TIPO_CONDOMINIO, USUARIOS_POR_CASA, id]);
        break;
      }

      case 'parametros': {
        const { PARAMETRO, VALOR } = updates;
        await connection.query(`
          UPDATE TBL_MS_PARAMETROS SET
            PARAMETRO = COALESCE(?, PARAMETRO),
            VALOR = COALESCE(?, VALOR),
            FECHA_MODIFICACION = NOW()
          WHERE ID_PARAMETRO = ?;
        `, [PARAMETRO, VALOR, id]);
        break;
      }

      default:
        await connection.rollback();
        return res.status(400).json({ success: false, message: `Modificación no soportada para ${table}.` });
    }

    await connection.commit();
    res.status(200).json({ success: true, message: `Registro actualizado correctamente en ${table}.` });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`Error al actualizar tabla ${table}:`, error);
    res.status(500).json({ success: false, message: 'Error interno al actualizar registro.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 8. ELIMINAR (DELETE) registro en tabla de mantenimiento
 */
const deleteMaintenanceRecord = async (req, res) => {
  const { table, id } = req.params;

  if (table === 'bitacoras' || table === 'bitacora_visitas' || table === 'escaneos_fallidos' || table.startsWith('log')) {
    return res.status(403).json({
      success: false,
      message: 'Las bitácoras y registros de auditoría son inmutables y no pueden eliminarse.'
    });
  }

  let connection;

  try {
    connection = await mysqlPool.getConnection();

    switch (table) {
      case 'usuarios': {
        // En usuarios hacemos desactivación de estado para no romper integridad de bitácora
        await connection.query('UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 2 WHERE ID_USUARIO = ?', [id]);
        break;
      }

      case 'instalaciones': {
        await connection.query('DELETE FROM TBL_INSTALACIONES WHERE ID_INSTALACION = ?', [id]);
        break;
      }

      case 'condominios': {
        await connection.query('DELETE FROM TBL_CONDOMINIOS WHERE ID_CONDOMINIO = ?', [id]);
        break;
      }

      case 'reservaciones': {
        // Cambiar estado a Cancelada (2)
        await connection.query('UPDATE TBL_RESERVAS SET ID_ESTADO_RESERVA = 2 WHERE ID_RESERVA = ?', [id]);
        break;
      }

      case 'parametros': {
        await connection.query('DELETE FROM TBL_MS_PARAMETROS WHERE ID_PARAMETRO = ?', [id]);
        break;
      }

      default:
        return res.status(400).json({ success: false, message: `Eliminación no permitida para ${table}.` });
    }

    res.status(200).json({ success: true, message: `Registro eliminado/desactivado con éxito en ${table}.` });

  } catch (error) {
    console.error(`Error al eliminar en ${table}:`, error);
    res.status(500).json({ success: false, message: error.message || 'Error interno al procesar eliminación.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 9. Resumen de la Base de Datos para pantalla de Respaldo (Solo Super Admin)
 */
const getDatabaseBackupSummary = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [tablesRaw] = await connection.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');

    const tables = [];
    let totalRows = 0;

    for (const t of tablesRaw) {
      const tableName = Object.values(t)[0];
      try {
        const [[{ count }]] = await connection.query(`SELECT COUNT(*) as count FROM \`${tableName}\``);
        totalRows += count;
        tables.push({ name: tableName, rows: count });
      } catch {
        tables.push({ name: tableName, rows: 0 });
      }
    }

    res.status(200).json({
      success: true,
      data: {
        databaseName: process.env.DB_NAME || 'railway',
        host: process.env.DB_HOST || 'MySQL Cloud Host',
        port: process.env.DB_PORT || 3306,
        dialect: 'MySQL',
        totalTables: tables.length,
        totalRows,
        tables,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error al obtener resumen de base de datos:', error);
    res.status(500).json({ success: false, message: 'Error al consultar resumen de base de datos.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 10. Generación y descarga del Respaldo SQL Completo (.sql) (Solo Super Admin)
 */
const downloadDatabaseBackup = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [tablesRaw] = await connection.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');

    const dbName = process.env.DB_NAME || 'railway';
    const now = new Date();
    const dateFormatted = now.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
    const filename = `gv_security_backup_${dbName}_${dateFormatted}.sql`;

    let sqlDump = `-- ========================================================\n`;
    sqlDump += `-- GV-SECURITY APP - RESPALDO INTEGRAL DE BASE DE DATOS\n`;
    sqlDump += `-- Base de Datos: ${dbName}\n`;
    sqlDump += `-- Servidor Host: ${process.env.DB_HOST || 'MySQL'}\n`;
    sqlDump += `-- Fecha y Hora: ${now.toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa' })} (UTC: ${now.toISOString()})\n`;
    sqlDump += `-- Solicitado por Super Administrador: ${req.user?.nombre_usuario || req.user?.id || 'Super Usuario'}\n`;
    sqlDump += `-- Total de Tablas: ${tablesRaw.length}\n`;
    sqlDump += `-- ========================================================\n\n`;
    sqlDump += `SET NAMES utf8mb4;\n`;
    sqlDump += `SET FOREIGN_KEY_CHECKS = 0;\n`;
    sqlDump += `SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";\n`;
    sqlDump += `SET AUTOCOMMIT = 0;\n`;
    sqlDump += `START TRANSACTION;\n`;
    sqlDump += `SET time_zone = "+00:00";\n\n`;

    for (const tableObj of tablesRaw) {
      const tableName = Object.values(tableObj)[0];

      sqlDump += `-- --------------------------------------------------------\n`;
      sqlDump += `-- Estructura de tabla para \`${tableName}\`\n`;
      sqlDump += `-- --------------------------------------------------------\n`;
      sqlDump += `DROP TABLE IF EXISTS \`${tableName}\`;\n`;

      const [createTableResult] = await connection.query(`SHOW CREATE TABLE \`${tableName}\``);
      if (createTableResult.length > 0) {
        const createSql = createTableResult[0]['Create Table'] || Object.values(createTableResult[0])[1];
        sqlDump += `${createSql};\n\n`;
      }

      // Volcado de datos
      const [rows] = await connection.query(`SELECT * FROM \`${tableName}\``);
      if (rows.length > 0) {
        sqlDump += `-- Volcado de datos para la tabla \`${tableName}\` (${rows.length} registros)\n`;
        sqlDump += `LOCK TABLES \`${tableName}\` WRITE;\n`;

        const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');

        const chunkSize = 100;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const valuesStr = chunk.map(row => {
            const rowVals = Object.values(row).map(val => connection.escape(val)).join(', ');
            return `  (${rowVals})`;
          }).join(',\n');

          sqlDump += `INSERT INTO \`${tableName}\` (${cols}) VALUES\n${valuesStr};\n`;
        }

        sqlDump += `UNLOCK TABLES;\n\n`;
      } else {
        sqlDump += `-- (Tabla \`${tableName}\` sin registros)\n\n`;
      }
    }

    sqlDump += `COMMIT;\n`;
    sqlDump += `SET FOREIGN_KEY_CHECKS = 1;\n`;
    sqlDump += `-- ========================================================\n`;
    sqlDump += `-- Fin del Respaldo de Base de Datos GV-SECURITY\n`;
    sqlDump += `-- ========================================================\n`;

    console.log(`[BACKUP] Respaldo generado con éxito (${filename}) - Tamaño: ${(Buffer.byteLength(sqlDump, 'utf8') / 1024).toFixed(2)} KB`);

    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(sqlDump);

  } catch (error) {
    console.error('Error al generar respaldo de BD:', error);
    res.status(500).json({ success: false, message: 'Error interno al generar el respaldo de la base de datos.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 11. Subida de imagen para anuncios y notificaciones push
 */
const uploadAnnouncementImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se ha proporcionado ningún archivo de imagen.' });
    }

    const relativePath = `uploads/anuncios/${req.file.filename}`;
    const host = req.get('host');
    const protocol = req.protocol;
    const fullUrl = `${protocol}://${host}/${relativePath}`;

    res.status(200).json({
      success: true,
      message: 'Imagen subida exitosamente al servidor.',
      data: {
        filename: req.file.filename,
        path: relativePath,
        fullUrl: fullUrl,
        size: req.file.size,
        mimetype: req.file.mimetype
      }
    });
  } catch (error) {
    console.error('Error al subir imagen de anuncio:', error);
    res.status(500).json({ success: false, message: 'Error interno al procesar la imagen.' });
  }
};

/**
 * 12. Envío de Notificaciones Push y publicación en muro de Anuncios/Eventos
 */
const sendPushNotificationAndAnnouncement = async (req, res) => {
  const {
    titulo,
    mensaje,
    imagen,
    destinatarios,
    publicarMuro,
    notificarApp,
    enviarPushFCM
  } = req.body;

  if (!titulo || !mensaje) {
    return res.status(400).json({ success: false, message: 'El título y el mensaje son obligatorios.' });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    let anuncioId = null;

    // 1. Guardar en TBL_ANUNCIOS_EVENTOS si publicarMuro es true
    if (publicarMuro !== false) {
      const [insertAnuncio] = await connection.query(`
        INSERT INTO TBL_ANUNCIOS_EVENTOS (ID_ESTADO_ANUNCIO_EVENTO, TITULO, DESCRIPCION, IMAGEN, FECHA_HORA)
        VALUES (1, ?, ?, ?, NOW());
      `, [
        titulo.slice(0, 100).trim(),
        mensaje.slice(0, 800).trim(),
        imagen ? String(imagen).trim() : null
      ]);
      anuncioId = insertAnuncio.insertId;
    }

    // 2. Determinar usuarios destinatarios
    let userFilter = 'ID_ESTADO_USUARIO = 1';
    if (destinatarios === 'residentes') {
      userFilter += ' AND ID_ROL = 2';
    } else if (destinatarios === 'guardias') {
      userFilter += ' AND ID_ROL = 3';
    } else if (destinatarios === 'admins') {
      userFilter += ' AND ID_ROL IN (1, 4)';
    }

    const [targetUsers] = await connection.query(`
      SELECT ID_USUARIO, NOMBRE_USUARIO, EMAIL, FCM_TOKEN, ID_ROL 
      FROM TBL_MS_USUARIO 
      WHERE ${userFilter};
    `);

    // 3. Insertar en TBL_NOTIFICACIONES_APP para cada usuario si notificarApp es true
    if (notificarApp !== false && targetUsers.length > 0) {
      for (const u of targetUsers) {
        await connection.query(`
          INSERT INTO TBL_NOTIFICACIONES_APP (ID_USUARIO, TITULO, MENSAJE, FECHA_HORA, LEIDA)
          VALUES (?, ?, ?, NOW(), 0);
        `, [u.ID_USUARIO, titulo.slice(0, 150).trim(), mensaje.trim()]);
      }
    }

    await connection.commit();

    // 4. Si enviarPushFCM es true, enviar a través de Firebase Cloud Messaging
    const fcmTokens = targetUsers
      .map(u => u.FCM_TOKEN)
      .filter(token => token && typeof token === 'string' && token.trim().length > 10);

    let pushSuccessCount = 0;
    let pushFailureCount = 0;

    let firebaseAdmin = null;
    try {
      const admin = require('firebase-admin');
      if (admin.apps.length > 0) {
        firebaseAdmin = admin;
      }
    } catch {
      // Firebase opcional si falta configuración
    }

    if (enviarPushFCM !== false && fcmTokens.length > 0 && firebaseAdmin) {
      try {
        const payload = {
          notification: {
            title: titulo,
            body: mensaje
          },
          data: {
            tipo: 'anuncio',
            anuncioId: String(anuncioId || ''),
            fecha: new Date().toISOString()
          },
          tokens: fcmTokens
        };

        if (imagen) {
          const host = req.get('host');
          const protocol = req.protocol;
          const fullImgUrl = imagen.startsWith('http') 
            ? imagen 
            : `${protocol}://${host}/${imagen.replace(/^\//, '')}`;
          payload.notification.imageUrl = fullImgUrl;
        }

        const response = await firebaseAdmin.messaging().sendEachForMulticast(payload);
        pushSuccessCount = response.successCount;
        pushFailureCount = response.failureCount;
        console.log(`[FCM PUSH] Notificaciones enviadas: ${pushSuccessCount} exitosas, ${pushFailureCount} fallidas.`);
      } catch (fcmError) {
        console.warn('[FCM PUSH] Advertencia al enviar multicast FCM:', fcmError.message);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Notificación procesada y difundida exitosamente.',
      data: {
        anuncioId,
        totalDestinatarios: targetUsers.length,
        tokensFCMEncontrados: fcmTokens.length,
        pushExitosos: pushSuccessCount,
        pushFallidos: pushFailureCount,
        imagenRuta: imagen || null
      }
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error al enviar notificación push:', error);
    res.status(500).json({ success: false, message: 'Error interno al procesar el envío de la notificación.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 13. Obtiene la lista de todos los anuncios con estado y conteo de vistas
 */
const getAnnouncementsList = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(`
      SELECT 
        a.ID_ANUNCIOS_EVENTOS,
        a.ID_ESTADO_ANUNCIO_EVENTO,
        a.TITULO,
        a.DESCRIPCION,
        a.IMAGEN,
        a.FECHA_HORA,
        COUNT(DISTINCT o.ID_USUARIO) AS TOTAL_OCULTADOS
      FROM TBL_ANUNCIOS_EVENTOS a
      LEFT JOIN TBL_ANUNCIOS_OCULTOS o ON a.ID_ANUNCIOS_EVENTOS = o.ID_ANUNCIOS_EVENTOS
      GROUP BY a.ID_ANUNCIOS_EVENTOS
      ORDER BY a.FECHA_HORA DESC
      LIMIT 100;
    `);

    res.status(200).json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error('Error al obtener lista de anuncios:', error);
    res.status(500).json({ success: false, message: 'Error al consultar anuncios.' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * 14. Da de baja o elimina un anuncio
 */
const deleteAnnouncement = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.query('UPDATE TBL_ANUNCIOS_EVENTOS SET ID_ESTADO_ANUNCIO_EVENTO = 2 WHERE ID_ANUNCIOS_EVENTOS = ?', [id]);
    res.status(200).json({ success: true, message: 'Anuncio desactivado exitosamente.' });
  } catch (error) {
    console.error('Error al desactivar anuncio:', error);
    res.status(500).json({ success: false, message: 'Error al desactivar anuncio.' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getDashboardStats,
  getGeocercaConfig,
  updateGeocercaConfig,
  getFormOptions,
  getMaintenanceTable,
  createMaintenanceRecord,
  updateMaintenanceRecord,
  deleteMaintenanceRecord,
  getDatabaseBackupSummary,
  downloadDatabaseBackup,
  uploadAnnouncementImage,
  sendPushNotificationAndAnnouncement,
  getAnnouncementsList,
  deleteAnnouncement
};

