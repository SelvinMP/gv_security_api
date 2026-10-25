const { mysqlPool } = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone');
const admin = require('firebase-admin');
const transporter = require('../config/transporter');

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

// Helper: Extraer ID del guardia desde el token JWT o los parámetros de la petición
const getGuardiaIdFromReq = (req) => {
  try {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, SECRET_KEY);
      if (decoded && decoded.id) return decoded.id;
    }
  } catch (e) {
    // Si no es token válido, continuar con query / body
  }

  return req.body?.guardiaId || req.body?.idGuardia || req.body?.id_usuario ||
         req.query?.guardiaId || req.query?.idGuardia || req.query?.id_usuario || null;
};

// Helper: Registrar intento fallido de escaneo en TBL_LOG_ESCANEO_FALLIDO
const registrarLogFallido = async (connection, {
  guardiaId,
  idVisitante = null,
  idVisitanteRecurrente = null,
  latitud = null,
  longitud = null,
  distancia = null,
  precision = null,
  motivo,
  req
}) => {
  try {
    if (!guardiaId) {
      console.warn("Log fallido omitido: No se pudo identificar el guardia.");
      return;
    }

    const clientIp = (req ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || '') : '').slice(0, 45);
    const userAgent = (req ? (req.headers['user-agent'] || '') : '').slice(0, 255);
    const motivoTruncado = (motivo || 'Rechazado por política de geocerca').slice(0, 150);

    await connection.query(`
      INSERT INTO TBL_LOG_ESCANEO_FALLIDO 
      (ID_USUARIO_GUARDIA, ID_VISITANTE, ID_VISITANTES_RECURRENTES, LATITUD_INTENTO, LONGITUD_INTENTO, DISTANCIA_METROS, PRECISION_GPS, MOTIVO_RECHAZO, ORIGEN_IP, DISPOSITIVO)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      guardiaId,
      idVisitante || null,
      idVisitanteRecurrente || null,
      latitud || null,
      longitud || null,
      distancia || null,
      precision || null,
      motivoTruncado,
      clientIp || null,
      userAgent || null
    ]);
  } catch (err) {
    console.error("Error al registrar en TBL_LOG_ESCANEO_FALLIDO:", err.message);
  }
};

// Helper: Comprobar si el guardia se encuentra dentro de una geocerca activa
const checkGeocerca = async (connection, {
  latitud,
  longitud,
  precision,
  guardiaId,
  idVisitante = null,
  idVisitanteRecurrente = null,
  req
}) => {
  // 1. Obtener parámetros globales de geocerca
  const [paramRows] = await connection.query(
    "SELECT PARAMETRO, VALOR FROM TBL_MS_PARAMETROS WHERE PARAMETRO IN ('GEOCERCA_ACTIVA', 'PRECISION_MAXIMA_GPS_METROS')"
  );

  const params = {};
  paramRows.forEach(p => { params[p.PARAMETRO] = p.VALOR; });

  const geocercaActiva = params['GEOCERCA_ACTIVA'] === '1';
  const precisionMaxima = parseFloat(params['PRECISION_MAXIMA_GPS_METROS']) || 40.0;

  if (!geocercaActiva) {
    return { allowed: true, geocercaActiva: false };
  }

  // 2. Validar que vengan coordenadas GPS
  if (latitud === undefined || latitud === null || longitud === undefined || longitud === null ||
      latitud === '' || longitud === '' || isNaN(parseFloat(latitud)) || isNaN(parseFloat(longitud))) {
    await registrarLogFallido(connection, {
      guardiaId,
      idVisitante,
      idVisitanteRecurrente,
      motivo: 'GPS no proporcionado o desactivado',
      req
    });
    return {
      allowed: false,
      message: 'Ubicación GPS requerida. Debe activar la ubicación GPS en su dispositivo para escanear en caseta.'
    };
  }

  const latNum = parseFloat(latitud);
  const lngNum = parseFloat(longitud);
  const precNum = (precision !== undefined && precision !== null && precision !== '' && !isNaN(parseFloat(precision)))
    ? parseFloat(precision)
    : null;

  // 3. Validar precisión de la señal GPS
  if (precNum !== null && precNum > precisionMaxima) {
    await registrarLogFallido(connection, {
      guardiaId,
      idVisitante,
      idVisitanteRecurrente,
      latitud: latNum,
      longitud: lngNum,
      precision: precNum,
      motivo: `Baja precisión GPS (${Math.round(precNum)}m > máx ${precisionMaxima}m)`,
      req
    });
    return {
      allowed: false,
      message: `Precisión de GPS insuficiente (${Math.round(precNum)} metros). Debe ser menor a ${precisionMaxima}m. Espere una mejor señal de satélite o acérquese a la caseta.`
    };
  }

  // 4. Consultar geocerca activa más cercana mediante ST_Distance_Sphere
  const [geoRows] = await connection.query(`
    SELECT 
        ID_GEOCERCA,
        NOMBRE_ZONA,
        RADIO_METROS,
        ROUND(
            ST_Distance_Sphere(
                POINT(LONGITUD_CENTRO, LATITUD_CENTRO),
                POINT(?, ?)
            ), 2
        ) AS DISTANCIA_ACTUAL_METROS,
        CASE 
            WHEN ST_Distance_Sphere(
                POINT(LONGITUD_CENTRO, LATITUD_CENTRO),
                POINT(?, ?)
            ) <= RADIO_METROS THEN 1 
            ELSE 0 
        END AS DENTRO_DE_AREA
    FROM TBL_GEOCERCAS
    WHERE ACTIVO = 1
    ORDER BY DISTANCIA_ACTUAL_METROS ASC
    LIMIT 1;
  `, [lngNum, latNum, lngNum, latNum]);

  if (geoRows.length === 0) {
    return { allowed: true, geocercaActiva: true, noActiveGeocercas: true };
  }

  const geocerca = geoRows[0];

  if (geocerca.DENTRO_DE_AREA !== 1) {
    await registrarLogFallido(connection, {
      guardiaId,
      idVisitante,
      idVisitanteRecurrente,
      latitud: latNum,
      longitud: lngNum,
      distancia: geocerca.DISTANCIA_ACTUAL_METROS,
      precision: precNum,
      motivo: `Fuera de geocerca (${geocerca.NOMBRE_ZONA}). Distancia: ${geocerca.DISTANCIA_ACTUAL_METROS}m (Máx: ${geocerca.RADIO_METROS}m)`,
      req
    });
    return {
      allowed: false,
      message: `Acceso restringido: Se encuentra fuera del área permitida (${geocerca.NOMBRE_ZONA}). Distancia actual: ${Math.round(geocerca.DISTANCIA_ACTUAL_METROS)}m (Máximo permitido: ${Math.round(geocerca.RADIO_METROS)}m).`,
      distancia: geocerca.DISTANCIA_ACTUAL_METROS,
      radio: geocerca.RADIO_METROS,
      zona: geocerca.NOMBRE_ZONA
    };
  }

  return {
    allowed: true,
    geocercaActiva: true,
    idGeocerca: geocerca.ID_GEOCERCA,
    nombreZona: geocerca.NOMBRE_ZONA,
    distancia: geocerca.DISTANCIA_ACTUAL_METROS,
    radio: geocerca.RADIO_METROS,
    latitud: latNum,
    longitud: lngNum,
    precision: precNum
  };
};

const checkGuardiaLocation = async (req, res) => {
  const { latitud, longitud, precision } = req.query;
  const guardiaId = getGuardiaIdFromReq(req);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const result = await checkGeocerca(connection, {
      latitud,
      longitud,
      precision,
      guardiaId,
      req
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error en checkGuardiaLocation:", error);
    return res.status(500).json({ message: "Error al verificar geocerca" });
  } finally {
    if (connection) connection.release();
  }
};

const getVisitDetails = async (req, res) => {
  const { id } = req.params;
  const { isRecurrent, latitud, longitud, precision } = req.query;
  const guardiaId = getGuardiaIdFromReq(req);

  if (!id) return res.status(400).json({ message: "ID no proporcionado" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // Validar Geocerca
    const geoValidation = await checkGeocerca(connection, {
      latitud,
      longitud,
      precision,
      guardiaId,
      idVisitante: isRecurrent === 'true' ? null : id,
      idVisitanteRecurrente: isRecurrent === 'true' ? id : null,
      req
    });

    if (!geoValidation.allowed) {
      return res.status(403).json({
        message: geoValidation.message,
        geocercaError: true,
        distancia: geoValidation.distancia,
        radio: geoValidation.radio,
        zona: geoValidation.zona
      });
    }
    
    if (isRecurrent === 'true') {
      const [rows] = await connection.query(`
        SELECT 
          v.ID_VISITANTES_RECURRENTES as id,
          v.NOMBRE_VISITANTE,
          v.DNI_VISITANTE,
          v.NUM_CARNET_EXTRANJERO,
          v.ID_NACIONALIDAD,
          v.NUM_PERSONAS,
          v.NUM_PLACA,
          v.FECHA_HORA,
          v.FECHA_VENCIMIENTO,
          v.ESTADO_QR,
          v.NOTA,
          v.ID_USUARIO,
          u.NOMBRE_USUARIO as RESIDENTE,
          c.DESCRIPCION as CASA_DESTINO
        FROM TBL_VISITANTES_RECURRENTES v
        JOIN TBL_MS_USUARIO u ON v.ID_USUARIO = u.ID_USUARIO
        LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = v.ID_USUARIO
        LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = p.ID_CONDOMINIO
        WHERE v.ID_VISITANTES_RECURRENTES = ?
      `, [id]);

      if (rows.length === 0) return res.status(404).json({ message: "No se encontró información para este código QR." });
      
      const vencimiento = moment(rows[0].FECHA_VENCIMIENTO);
      if (moment().isAfter(vencimiento)) return res.status(400).json({ message: "La fecha de validez de este código QR de visita recurrente ya venció o caducó." });
      
      return res.status(200).json({ data: rows[0], isRecurrent: true, geocerca: geoValidation });
    } else {
      const [rows] = await connection.query(`
        SELECT 
          v.ID_VISITANTE as id,
          v.NOMBRE_VISITANTE,
          v.DNI_VISITANTE,
          v.NUM_CARNET_EXTRANJERO,
          v.ID_NACIONALIDAD,
          v.NUM_PERSONAS,
          v.NUM_PLACA,
          v.FECHA_HORA,
          v.ESTADO_QR,
          v.NOTA,
          v.ID_USUARIO,
          u.NOMBRE_USUARIO as RESIDENTE,
          c.DESCRIPCION as CASA_DESTINO
        FROM TBL_REGVISITAS v
        JOIN TBL_MS_USUARIO u ON v.ID_USUARIO = u.ID_USUARIO
        LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = v.ID_USUARIO
        LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = p.ID_CONDOMINIO
        WHERE v.ID_VISITANTE = ?
      `, [id]);

      if (rows.length === 0) return res.status(404).json({ message: "No se encontró información para este código QR." });
      if (rows[0].ESTADO_QR === 1) return res.status(400).json({ message: "Este código QR de ingreso único ya fue utilizado o escaneado anteriormente." });
      
      return res.status(200).json({ data: rows[0], isRecurrent: false, geocerca: geoValidation });
    }
  } catch (error) {
    console.error("Error al obtener visita:", error);
    res.status(500).json({ message: "Error al obtener visita" });
  } finally {
    if (connection) connection.release();
  }
};

const getMotivos = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT ID_MOTIVO, MOTIVO FROM TBL_MOTIVOS");
    res.json(rows);
  } catch (err) {
    console.error("Error getMotivos:", err);
    res.status(500).json({ message: "Error al obtener motivos" });
  } finally {
    if (connection) connection.release();
  }
};

const confirmEntry = async (req, res) => {
  const { 
    id, 
    isRecurrent, 
    numPersonas, 
    numPlaca, 
    nacionalidadId, 
    documento,
    motivoId,
    idGeocerca,
    latitud,
    longitud,
    distanciaMetros,
    precision
  } = req.body;
  const guardiaId = getGuardiaIdFromReq(req);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    // Validar DNI si es nacionalidad hondureña
    const [nacRows] = await connection.query("SELECT NOMBRE_NACIONALIDAD FROM TBL_NACIONALIDADES WHERE ID_NACIONALIDAD = ?", [nacionalidadId]);
    if (nacRows.length === 0) return res.status(400).json({ message: "Nacionalidad inválida" });

    const esHondurena = nacRows[0].NOMBRE_NACIONALIDAD.toLowerCase().includes("hondureña");

    if (esHondurena && documento) {
      if (documento.length < 4) return res.status(400).json({ message: "El DNI debe tener al menos 4 dígitos" });
      const codigoDNI = documento.substring(0, 4);
      const [codigoResults] = await connection.query("SELECT COUNT(*) as count FROM TBL_CODIGO_DNI WHERE CODIGO = ?", [codigoDNI]);
      if (codigoResults[0].count === 0) {
        return res.status(400).json({ message: "Código de departamento/municipio de DNI inválido" });
      }
    }

    const dni = esHondurena ? documento : null;
    const carnet = !esHondurena ? documento : null;
    const now = moment().tz("America/Tegucigalpa").format("YYYY-MM-DD HH:mm:ss");
    
    let visitorData;
    let userId;

    if (isRecurrent) {
      const [visitorRes] = await connection.query("SELECT * FROM TBL_VISITANTES_RECURRENTES WHERE ID_VISITANTES_RECURRENTES = ?", [id]);
      if (visitorRes.length === 0) throw new Error("Visita no encontrada");
      visitorData = visitorRes[0];
      userId = visitorData.ID_USUARIO;

      // Update TBL_VISITANTES_RECURRENTES
      await connection.query(`
        UPDATE TBL_VISITANTES_RECURRENTES 
        SET FECHA_ACCESO = ?, NUM_PERSONAS = ?, NUM_PLACA = ?, ID_NACIONALIDAD = ?, DNI_VISITANTE = ?, NUM_CARNET_EXTRANJERO = ?, CANTIDAD_ESCANEANA = CANTIDAD_ESCANEANA + 1, ESTADO_QR = 1
        WHERE ID_VISITANTES_RECURRENTES = ?
      `, [now, numPersonas, numPlaca, nacionalidadId, dni, carnet, id]);

      // Insert Bitácora con datos de auditoría de guardia y geocerca
      const [personaRows] = await connection.query("SELECT ID_PERSONA FROM TBL_PERSONAS WHERE ID_USUARIO = ?", [userId]);
      const idPersona = personaRows[0]?.ID_PERSONA || null;
      await connection.query(`
        INSERT INTO TBL_BITACORA_VISITA (
          ID_PERSONA, ID_VISITANTES_RECURRENTES, ID_USUARIO_GUARDIA, ID_GEOCERCA,
          NUM_PERSONA, NUM_PLACA, NOTA, FECHA_HORA, FECHA_ACCESO, FECHA_VENCIMIENTO,
          LATITUD_ESCANEO, LONGITUD_ESCANEO, DISTANCIA_METROS, PRECISION_GPS
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        idPersona, 
        id, 
        guardiaId || null, 
        idGeocerca || null, 
        numPersonas, 
        numPlaca, 
        visitorData.NOTA || null, 
        visitorData.FECHA_HORA, 
        now, 
        visitorData.FECHA_VENCIMIENTO,
        latitud || null,
        longitud || null,
        distanciaMetros || null,
        precision || null
      ]);

    } else {
      const [visitorRes] = await connection.query("SELECT * FROM TBL_REGVISITAS WHERE ID_VISITANTE = ?", [id]);
      if (visitorRes.length === 0) throw new Error("Visita no encontrada");
      visitorData = visitorRes[0];
      userId = visitorData.ID_USUARIO;

      // Update TBL_REGVISITAS
      await connection.query(`
        UPDATE TBL_REGVISITAS 
        SET FECHA_ACCESO = ?, NUM_PERSONAS = ?, NUM_PLACA = ?, ID_NACIONALIDAD = ?, DNI_VISITANTE = ?, NUM_CARNET_EXTRANJERO = ?, ESTADO_QR = 1
        WHERE ID_VISITANTE = ?
      `, [now, numPersonas, numPlaca, nacionalidadId, dni, carnet, id]);

      // Update Bitácora con datos de auditoría de guardia y geocerca
      await connection.query(`
        UPDATE TBL_BITACORA_VISITA
        SET FECHA_ACCESO = ?, NUM_PERSONA = ?, NUM_PLACA = ?,
            ID_USUARIO_GUARDIA = ?, ID_GEOCERCA = ?,
            LATITUD_ESCANEO = ?, LONGITUD_ESCANEO = ?,
            DISTANCIA_METROS = ?, PRECISION_GPS = ?
        WHERE ID_VISITANTE = ?
      `, [
        now, 
        numPersonas, 
        numPlaca, 
        guardiaId || null, 
        idGeocerca || null, 
        latitud || null, 
        longitud || null, 
        distanciaMetros || null, 
        precision || null, 
        id
      ]);
    }

    await connection.commit();

    // Fetch Motivo Text if provided
    let motivoTexto = null;
    if (motivoId) {
      const [motivoRows] = await connection.query("SELECT MOTIVO FROM TBL_MOTIVOS WHERE ID_MOTIVO = ?", [motivoId]);
      if (motivoRows.length > 0) {
        motivoTexto = motivoRows[0].MOTIVO;
      }
    }

    // Notify Resident
    try {
      const [userRows] = await connection.query("SELECT EMAIL, FCM_TOKEN FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [userId]);
      if (userRows.length > 0) {
        const title = "Su visita ha ingresado";
        let bodyMsg = `${visitorData.NOMBRE_VISITANTE} ha registrado su ingreso (${numPersonas} persona/s).`;
        
        if (motivoTexto) {
          bodyMsg += ` Observación de Guardia: ${motivoTexto}`;
        }
        
        // Save to TBL_NOTIFICACIONES_APP
        await connection.query(
          "INSERT INTO TBL_NOTIFICACIONES_APP (ID_USUARIO, TITULO, MENSAJE, FECHA_HORA, LEIDA) VALUES (?, ?, ?, NOW(), 0)",
          [userId, title, bodyMsg]
        );

        if (userRows[0].FCM_TOKEN && admin.apps.length > 0) {
          const message = {
            notification: {
              title: title,
              body: bodyMsg,
            },
            token: userRows[0].FCM_TOKEN
          };
          admin.messaging().send(message)
            .then(() => console.log('FCM Guardia a Residente enviado'))
            .catch((err) => console.log('Error FCM Guardia:', err));
        }

        // Send Email if there is a behavior motive
        if (motivoTexto && userRows[0].EMAIL) {
          const mailOptions = {
            from: `"GV-Security Guardia" <${process.env.EMAIL_USER}>`,
            to: userRows[0].EMAIL,
            subject: `Observación de Comportamiento: ${visitorData.NOMBRE_VISITANTE}`,
            html: `<div style="font-family: sans-serif; border: 1px solid #ddd; padding: 20px;">
                <h2 style="color: #0E2041;">Alerta de Guardia de Seguridad</h2>
                <p>Estimado Residente,</p>
                <p>El guardia de seguridad ha reportado la siguiente observación durante el ingreso de su visitante (<b>${visitorData.NOMBRE_VISITANTE}</b>):</p>
                <p style="font-size: 18px; font-weight: bold; color: #d93025; background: #fce8e6; padding: 10px; border-radius: 5px;">${motivoTexto}</p>
                <p>Por favor tome sus precauciones. Si necesita más información consulte con seguridad al llamar a caseta.</p>
              </div>`
          };
          transporter.sendMail(mailOptions).catch(err => console.log('Error enviando correo de motivo:', err));
        }
      }
    } catch (notifErr) {
      console.error("Error al notificar al residente:", notifErr);
    }

    res.status(200).json({ success: true, message: "Ingreso confirmado y registrado" });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error confirmEntry:", error);
    res.status(500).json({ message: error.message || "Error al confirmar ingreso" });
  } finally {
    if (connection) connection.release();
  }
};

const getResidentDetails = async (req, res) => {
  const { id } = req.params;
  const { latitud, longitud, precision } = req.query;
  const guardiaId = getGuardiaIdFromReq(req);

  if (!id) return res.status(400).json({ message: "ID no proporcionado" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // Validar Geocerca
    const geoValidation = await checkGeocerca(connection, {
      latitud,
      longitud,
      precision,
      guardiaId,
      req
    });

    if (!geoValidation.allowed) {
      return res.status(403).json({
        message: geoValidation.message,
        geocercaError: true,
        distancia: geoValidation.distancia,
        radio: geoValidation.radio,
        zona: geoValidation.zona
      });
    }
    
    // Check if the user is a resident (padre/hijo)
    const [rows] = await connection.query(`
      SELECT 
        u.NOMBRE_USUARIO,
        p.DNI_PERSONA,
        p.NUM_CARNET_EXTRANJERO,
        c.DESCRIPCION as CONDOMINIO,
        ep.DESCRIPCION as ESTADO_RESIDENTE,
        p.ID_ESTADO_PERSONA
      FROM TBL_MS_USUARIO u
      LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = u.ID_USUARIO
      LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = p.ID_CONDOMINIO
      LEFT JOIN TBL_ESTADO_PERSONA ep ON ep.ID_ESTADO_PERSONA = p.ID_ESTADO_PERSONA
      WHERE u.ID_USUARIO = ? OR p.ID_PERSONA = ?
    `, [id, id]);

    if (rows.length === 0) return res.status(404).json({ message: "No se encontró información para este usuario residente." });
    
    const resident = rows[0];

    // Validación de privacidad: si el estado no es activo (1), no enviamos la información personal
    if (resident.ID_ESTADO_PERSONA !== 1) {
      return res.status(200).json({ 
        data: {
          ID_ESTADO_PERSONA: resident.ID_ESTADO_PERSONA,
          ESTADO_RESIDENTE: resident.ESTADO_RESIDENTE || 'DESCONOCIDO'
        },
        geocerca: geoValidation
      });
    }

    return res.status(200).json({ data: resident, geocerca: geoValidation });
  } catch (error) {
    console.error("Error al obtener detalles del residente:", error);
    res.status(500).json({ message: "Error al obtener detalles del residente" });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  loginGuardia,
  getVisitDetails,
  getMotivos,
  confirmEntry,
  getResidentDetails,
  checkGuardiaLocation
};
