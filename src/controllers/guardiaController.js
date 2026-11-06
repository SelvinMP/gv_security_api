const { mysqlPool } = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone');
const { sendPush } = require('../config/firebase');
const { isCancelled, buildCancelledResult } = require('../utils/visitCancel');
const { sendMailWithTimeout } = require('../config/transporter');

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

const loginGuardia = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: "Usuario y contraseña son requeridos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?", [username]);
    if (rows.length === 0) return res.status(401).json({ message: "Usuario o contraseña incorrecta" });

    const user = rows[0];

    // Verificar que sea Guardia (Rol 3)
    if (user.ID_ROL !== 3) {
      return res.status(403).json({ message: "Acceso denegado. Solo para Guardias de Seguridad." });
    }

    switch (user.ID_ESTADO_USUARIO) {
      case 2: return res.status(403).json({ message: "Usuario inactivo" });
      case 3: return res.status(403).json({ message: "Usuario bloqueado" });
    }

    const passwordIsValid = await bcrypt.compare(password, user.CONTRASEÑA);
    if (!passwordIsValid) {
      return res.status(401).json({ message: "Usuario o contraseña incorrecta" });
    }

    const token = jwt.sign({ id: user.ID_USUARIO, role: user.ID_ROL }, SECRET_KEY, { expiresIn: '8h' });

    return res.status(200).json({ token, id_usuario: user.ID_USUARIO, role: user.ID_ROL, message: "Login exitoso" });
  } catch (err) {
    console.error("Error en loginGuardia:", err);
    res.status(500).json({ message: "Error interno del servidor" });
  } finally {
    if (connection) connection.release();
  }
};

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
          v.FECHA_CANCELACION,
          v.MOTIVO_CANCELACION,
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
      
      if (isCancelled(rows[0])) {
        const { status, ...body } = buildCancelledResult(rows[0]);
        return res.status(status).json(body);
      }
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
          v.FECHA_CANCELACION,
          v.MOTIVO_CANCELACION,
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
      if (isCancelled(rows[0])) {
        const { status, ...body } = buildCancelledResult(rows[0]);
        return res.status(status).json(body);
      }
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
      if (isCancelled(visitorData)) {
        await connection.rollback();
        const { status, ...body } = buildCancelledResult(visitorData);
        return res.status(status).json(body);
      }

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
      if (isCancelled(visitorRes[0])) {
        await connection.rollback();
        const { status, ...body } = buildCancelledResult(visitorRes[0]);
        return res.status(status).json(body);
      }
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

        if (userRows[0].FCM_TOKEN) {
          sendPush(userRows[0].FCM_TOKEN, { title, body: bodyMsg, link: '/notifications' });
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
          sendMailWithTimeout(mailOptions).catch(err => console.log('Error enviando correo de motivo:', err));
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

// ============================================================================
//  ESCANEO DE QR CIFRADO (GVS1.*) - Visitas, recurrentes, paquetes, QR múltiple
//  y carnet de residente. El QR solo contiene un token AES-256-GCM; los datos
//  se obtienen de la base de datos después de descifrarlo aquí en el servidor.
// ============================================================================
const { decryptQRPayload, QR_TYPES } = require('../utils/qrCrypto');
const { notifyUser, buildEmailHtml } = require('../utils/notify');
const { getPackageWithDetails } = require('./packageController');
const { getEventWithGuests, getEventEnd } = require('./eventController');

const TZ_HN = 'America/Tegucigalpa';

const queryVisit = async (connection, id, isRecurrent) => {
  if (isRecurrent) {
    const [rows] = await connection.query(`
      SELECT v.ID_VISITANTES_RECURRENTES as id, v.NOMBRE_VISITANTE, v.DNI_VISITANTE, v.NUM_CARNET_EXTRANJERO,
             v.ID_NACIONALIDAD, v.NUM_PERSONAS, v.NUM_PLACA, v.FECHA_HORA, v.FECHA_VENCIMIENTO, v.ESTADO_QR,
             v.FECHA_CANCELACION, v.MOTIVO_CANCELACION, v.NOTA, v.ID_USUARIO, u.NOMBRE_USUARIO as RESIDENTE, c.DESCRIPCION as CASA_DESTINO
        FROM TBL_VISITANTES_RECURRENTES v
        JOIN TBL_MS_USUARIO u ON v.ID_USUARIO = u.ID_USUARIO
        LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = v.ID_USUARIO
        LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = p.ID_CONDOMINIO
       WHERE v.ID_VISITANTES_RECURRENTES = ?`, [id]);
    if (rows.length === 0) return { status: 404, message: 'No se encontró información para este código QR.' };
    if (isCancelled(rows[0])) return buildCancelledResult(rows[0]);
    if (moment().isAfter(moment(rows[0].FECHA_VENCIMIENTO))) {
      return { status: 400, message: 'La fecha de validez de este código QR de visita recurrente ya venció o caducó.' };
    }
    return { data: rows[0] };
  }
  const [rows] = await connection.query(`
    SELECT v.ID_VISITANTE as id, v.NOMBRE_VISITANTE, v.DNI_VISITANTE, v.NUM_CARNET_EXTRANJERO, v.ID_NACIONALIDAD,
           v.NUM_PERSONAS, v.NUM_PLACA, v.FECHA_HORA, v.ESTADO_QR, v.FECHA_CANCELACION, v.MOTIVO_CANCELACION, v.NOTA, v.ID_USUARIO,
           u.NOMBRE_USUARIO as RESIDENTE, c.DESCRIPCION as CASA_DESTINO
      FROM TBL_REGVISITAS v
      JOIN TBL_MS_USUARIO u ON v.ID_USUARIO = u.ID_USUARIO
      LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = v.ID_USUARIO
      LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = p.ID_CONDOMINIO
     WHERE v.ID_VISITANTE = ?`, [id]);
  if (rows.length === 0) return { status: 404, message: 'No se encontró información para este código QR.' };
  if (isCancelled(rows[0])) return buildCancelledResult(rows[0]);
  if (rows[0].ESTADO_QR === 1) return { status: 400, message: 'Este código QR de ingreso único ya fue utilizado o escaneado anteriormente.' };
  return { data: rows[0] };
};

const queryResident = async (connection, usuarioId) => {
  const [rows] = await connection.query(`
    SELECT u.NOMBRE_USUARIO, p.DNI_PERSONA, p.NUM_CARNET_EXTRANJERO, c.DESCRIPCION as CONDOMINIO,
           ep.DESCRIPCION as ESTADO_RESIDENTE, p.ID_ESTADO_PERSONA
      FROM TBL_MS_USUARIO u
      LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = u.ID_USUARIO
      LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = p.ID_CONDOMINIO
      LEFT JOIN TBL_ESTADO_PERSONA ep ON ep.ID_ESTADO_PERSONA = p.ID_ESTADO_PERSONA
     WHERE u.ID_USUARIO = ?`, [usuarioId]);
  if (rows.length === 0) return { status: 404, message: 'No se encontró información para este usuario residente.' };
  const resident = rows[0];
  if (resident.ID_ESTADO_PERSONA !== 1) {
    return { data: { ID_ESTADO_PERSONA: resident.ID_ESTADO_PERSONA, ESTADO_RESIDENTE: resident.ESTADO_RESIDENTE || 'DESCONOCIDO' } };
  }
  return { data: resident };
};

const queryPackage = async (connection, id) => {
  const paquete = await getPackageWithDetails(connection, id);
  if (!paquete) return { status: 404, message: 'No se encontró información para este código QR de paquete.' };
  if (Number(paquete.ESTADO_QR) === 1) {
    return { status: 400, message: `Este paquete ya fue recibido en caseta el ${moment(paquete.FECHA_RECEPCION).format('DD/MM/YYYY hh:mm a')}.` };
  }
  const [res] = await connection.query('SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [paquete.ID_USUARIO]);
  return {
    data: {
      id: paquete.ID_PAQUETE,
      RESIDENTE: res[0]?.NOMBRE_USUARIO,
      CASA_DESTINO: paquete.CASA,
      REMITENTE: paquete.REMITENTE,
      TIPO_REMITENTE: paquete.TIPO_REMITENTE,
      TAMANO: paquete.TAMANO,
      DIMENSIONES_MAXIMAS: paquete.DIMENSIONES_MAXIMAS,
      PERMITIDO: paquete.PERMITIDO,
      FECHA_ESTIMADA_ENTREGA: paquete.FECHA_ESTIMADA_ENTREGA,
      DESCRIPCION: paquete.DESCRIPCION
    }
  };
};

/** Valida que el QR múltiple se use solo el día de la reunión y antes de que termine. */
const validateEventWindow = (evento, payloadDate) => {
  const hoy = moment().tz(TZ_HN).format('YYYY-MM-DD');
  const fechaEvento = moment(evento.FECHA_EVENTO).format('YYYY-MM-DD');
  if (payloadDate && payloadDate !== fechaEvento) {
    return 'Este QR corresponde a una versión anterior de la reunión. Solicite al residente el QR actualizado.';
  }
  if (fechaEvento !== hoy) {
    return `Este QR múltiple solo es válido el día de la reunión (${moment(fechaEvento).format('DD/MM/YYYY')}). No puede reutilizarse en otra fecha.`;
  }
  if (getEventEnd(evento).isBefore(moment().tz(TZ_HN))) {
    return 'La reunión ya finalizó; el QR múltiple venció.';
  }
  return null;
};

const queryEvent = async (connection, id, payloadDate) => {
  const evento = await getEventWithGuests(connection, id);
  if (!evento) return { status: 404, message: 'No se encontró información para este QR múltiple.' };
  const invalid = validateEventWindow(evento, payloadDate);
  if (invalid) return { status: 400, message: invalid };
  return {
    data: {
      id: evento.ID_EVENTO_VISITA,
      TITULO: evento.TITULO,
      RESIDENTE: evento.RESIDENTE,
      CASA_DESTINO: evento.CASA,
      FECHA_EVENTO: moment(evento.FECHA_EVENTO).format('YYYY-MM-DD'),
      HORA_INICIO: String(evento.HORA_INICIO).slice(0, 5),
      HORA_FIN: String(evento.HORA_FIN).slice(0, 5),
      OBSERVACIONES_RESIDENTE: evento.OBSERVACIONES_RESIDENTE,
      OBSERVACIONES_GUARDIA: evento.OBSERVACIONES_GUARDIA,
      invitados: evento.invitados
    }
  };
};

/**
 * POST /api/guardia/scan
 * body: { qr, latitud, longitud, precision }
 * Respuesta: { kind: 'visit'|'recurrent'|'package'|'event'|'resident', data, geocerca }
 */
const scanQR = async (req, res) => {
  const { qr, latitud, longitud, precision } = req.body || {};
  const guardiaId = getGuardiaIdFromReq(req);
  const payload = decryptQRPayload(qr);

  if (!payload) {
    return res.status(400).json({
      message: 'Código QR no válido, alterado o de una versión anterior. Solicite al residente que genere o actualice el QR desde la app.'
    });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();

    const geoValidation = await checkGeocerca(connection, {
      latitud, longitud, precision, guardiaId,
      idVisitante: payload.t === QR_TYPES.VISITA ? payload.id : null,
      idVisitanteRecurrente: payload.t === QR_TYPES.RECURRENTE ? payload.id : null,
      req
    });
    if (!geoValidation.allowed) {
      return res.status(403).json({
        message: geoValidation.message, geocercaError: true,
        distancia: geoValidation.distancia, radio: geoValidation.radio, zona: geoValidation.zona
      });
    }

    let result;
    let kind;
    switch (payload.t) {
      case QR_TYPES.VISITA: kind = 'visit'; result = await queryVisit(connection, payload.id, false); break;
      case QR_TYPES.RECURRENTE: kind = 'recurrent'; result = await queryVisit(connection, payload.id, true); break;
      case QR_TYPES.PAQUETE: kind = 'package'; result = await queryPackage(connection, payload.id); break;
      case QR_TYPES.EVENTO: kind = 'event'; result = await queryEvent(connection, payload.id, payload.d); break;
      case QR_TYPES.RESIDENTE: kind = 'resident'; result = await queryResident(connection, payload.id); break;
      default: return res.status(400).json({ message: 'Tipo de código QR no reconocido.' });
    }

    if (result.status) {
      const { status, ...body } = result;
      return res.status(status).json(body);
    }
    return res.status(200).json({ kind, isRecurrent: kind === 'recurrent', data: result.data, geocerca: geoValidation });
  } catch (error) {
    console.error('Error en scanQR:', error);
    res.status(500).json({ message: 'Error al validar el código QR' });
  } finally {
    if (connection) connection.release();
  }
};

const ESTADOS_PAQUETE = ['INTACTO', 'ROTO', 'APLASTADO', 'MOJADO', 'ABIERTO', 'OTRO'];

/**
 * POST /api/guardia/paquetes/:id/recibir
 * body: { estadoPaquete, observaciones, cumpleDimensiones, idGeocerca, latitud, longitud }
 */
const receivePackage = async (req, res) => {
  const { id } = req.params;
  const { estadoPaquete, observaciones, cumpleDimensiones, idGeocerca, latitud, longitud } = req.body || {};
  const guardiaId = getGuardiaIdFromReq(req);
  const estado = String(estadoPaquete || '').toUpperCase();

  if (!ESTADOS_PAQUETE.includes(estado)) return res.status(400).json({ message: 'Seleccione el estado en que se recibe el paquete.' });
  if (cumpleDimensiones !== true) return res.status(400).json({ message: 'Solo se reciben paquetes que cumplan las dimensiones permitidas (pequeño o mediano).' });
  if (estado === 'OTRO' && !String(observaciones || '').trim()) return res.status(400).json({ message: 'Describa el estado del paquete en observaciones.' });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const paquete = await getPackageWithDetails(connection, id);
    if (!paquete) return res.status(404).json({ message: 'Paquete no encontrado' });
    if (Number(paquete.ESTADO_QR) === 1) return res.status(400).json({ message: 'Este paquete ya fue recibido.' });
    if (Number(paquete.PERMITIDO) !== 1) return res.status(400).json({ message: 'El tamaño de este paquete no está permitido en caseta.' });

    const now = moment().tz(TZ_HN).format('YYYY-MM-DD HH:mm:ss');
    const obs = String(observaciones || '').trim().slice(0, 2000) || null;
    const [upd] = await connection.query(
      `UPDATE TBL_PAQUETES
          SET ESTADO_QR = 1, FECHA_RECEPCION = ?, ID_USUARIO_GUARDIA = ?, ID_GEOCERCA = ?,
              ESTADO_PAQUETE = ?, OBSERVACIONES_GUARDIA = ?, LATITUD_ESCANEO = ?, LONGITUD_ESCANEO = ?
        WHERE ID_PAQUETE = ? AND ESTADO_QR = 0`,
      [now, guardiaId || null, idGeocerca || null, estado, obs, latitud || null, longitud || null, id]
    );
    if (upd.affectedRows === 0) return res.status(400).json({ message: 'Este paquete ya fue recibido.' });

    const fechaTxt = moment(now).format('DD/MM/YYYY hh:mm a');
    await notifyUser(connection, paquete.ID_USUARIO, {
      title: 'Paquete recibido en caseta',
      message: `Su paquete de ${paquete.REMITENTE} fue recibido el ${fechaTxt}. Estado: ${estado}${obs ? ` (${obs})` : ''}.`,
      emailSubject: `Paquete recibido: ${paquete.REMITENTE}`,
      emailHtml: buildEmailHtml(
        'Paquete recibido en caseta',
        'Le informamos que la caseta de seguridad recibió el siguiente paquete autorizado por usted:',
        [
          { label: 'Remitente', value: paquete.REMITENTE },
          { label: 'Casa', value: paquete.CASA },
          { label: 'Tamaño', value: paquete.TAMANO },
          { label: 'Fecha y hora', value: fechaTxt },
          { label: 'Estado', value: estado },
          { label: 'Observaciones', value: obs }
        ],
        'Puede pasar a retirarlo en la caseta de seguridad.'
      )
    });

    res.json({ success: true, message: 'Paquete recibido y residente notificado' });
  } catch (error) {
    console.error('Error receivePackage:', error);
    res.status(500).json({ message: 'Error al registrar la recepción del paquete' });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * POST /api/guardia/eventos/:id/ingreso
 * body: { invitados: [ID_EVENTO_INVITADO...], observaciones, todosCoinciden, idGeocerca }
 * Marca cada visitante como "ingresado" y envía correo al residente.
 */
const checkInEventGuests = async (req, res) => {
  const { id } = req.params;
  const { invitados, observaciones, todosCoinciden, idGeocerca } = req.body || {};
  const guardiaId = getGuardiaIdFromReq(req);
  const ids = Array.isArray(invitados) ? invitados.map(Number).filter(Boolean) : [];

  if (ids.length === 0) return res.status(400).json({ message: 'Seleccione al menos un visitante que está ingresando.' });
  if (todosCoinciden !== true) return res.status(400).json({ message: 'Debe confirmar que los visitantes coinciden con la lista autorizada.' });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const evento = await getEventWithGuests(connection, id);
    if (!evento) return res.status(404).json({ message: 'Reunión no encontrada' });
    const invalid = validateEventWindow(evento, null);
    if (invalid) return res.status(400).json({ message: invalid });

    const pendientes = evento.invitados.filter(i => ids.includes(Number(i.ID_EVENTO_INVITADO)) && Number(i.INGRESADO) !== 1);
    if (pendientes.length === 0) return res.status(400).json({ message: 'Los visitantes seleccionados ya fueron registrados o no pertenecen a esta lista.' });

    const now = moment().tz(TZ_HN).format('YYYY-MM-DD HH:mm:ss');
    const obs = String(observaciones || '').trim().slice(0, 1000);

    await connection.beginTransaction();
    await connection.query(
      `UPDATE TBL_EVENTO_INVITADOS SET INGRESADO = 1, FECHA_INGRESO = ?, ID_USUARIO_GUARDIA = ?
        WHERE ID_EVENTO_VISITA = ? AND INGRESADO = 0 AND ID_EVENTO_INVITADO IN (?)`,
      [now, guardiaId || null, id, pendientes.map(p => p.ID_EVENTO_INVITADO)]
    );
    const totalIngresados = evento.invitados.filter(i => Number(i.INGRESADO) === 1).length + pendientes.length;
    const nuevoEstado = totalIngresados >= evento.invitados.length ? 2 : 1;
    const notaGuardia = obs ? `[${moment(now).format('DD/MM/YYYY hh:mm a')}] ${obs}` : null;
    await connection.query(
      `UPDATE TBL_EVENTOS_VISITA
          SET ESTADO_QR = ?, ID_USUARIO_GUARDIA = ?, ID_GEOCERCA = COALESCE(?, ID_GEOCERCA),
              OBSERVACIONES_GUARDIA = CASE WHEN ? IS NULL THEN OBSERVACIONES_GUARDIA
                                           ELSE CONCAT_WS('\n', OBSERVACIONES_GUARDIA, ?) END
        WHERE ID_EVENTO_VISITA = ?`,
      [nuevoEstado, guardiaId || null, idGeocerca || null, notaGuardia, notaGuardia, id]
    );
    await connection.commit();

    const nombres = pendientes.map(p => p.NOMBRE_COMPLETO);
    const horaTxt = moment(now).format('hh:mm a');
    await notifyUser(connection, evento.ID_USUARIO, {
      title: 'Su visita llegó',
      message: `${nombres.join(', ')} ingresaron a las ${horaTxt} (${evento.TITULO}). ${totalIngresados}/${evento.invitados.length} visitantes han llegado.${obs ? ` Observación del guardia: ${obs}` : ''}`,
      emailSubject: `Su visita llegó - ${evento.TITULO}`,
      emailHtml: buildEmailHtml(
        'Su visita llegó',
        `La caseta de seguridad registró el ingreso de visitantes de su reunión "${evento.TITULO}".`,
        [
          { label: 'Ingresaron', value: nombres.join(', ') },
          { label: 'Hora de ingreso', value: horaTxt },
          { label: 'Casa', value: evento.CASA },
          { label: 'Llegadas', value: `${totalIngresados} de ${evento.invitados.length} autorizados` },
          { label: 'Observación del guardia', value: obs }
        ]
      )
    });

    const actualizado = await getEventWithGuests(connection, id);
    res.json({ success: true, message: `${pendientes.length} visitante(s) registrados`, data: actualizado.invitados });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error checkInEventGuests:', error);
    res.status(500).json({ message: 'Error al registrar el ingreso' });
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
  checkGuardiaLocation,
  scanQR,
  receivePackage,
  checkInEventGuests
};
