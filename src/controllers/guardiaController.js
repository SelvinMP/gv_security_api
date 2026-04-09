const { mysqlPool } = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone');
const admin = require('firebase-admin');

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

const loginGuardia = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: "Usuario y contraseña son requeridos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?", [username]);
    if (rows.length === 0) return res.status(401).json({ message: "Usuario no encontrado" });

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
      return res.status(401).json({ message: "Contraseña incorrecta" });
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

const getVisitDetails = async (req, res) => {
  const { id } = req.params;
  const { isRecurrent } = req.query;

  if (!id) return res.status(400).json({ message: "ID no proporcionado" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    
    if (isRecurrent === 'true') {
      const [rows] = await connection.query(`
        SELECT 
          v.ID_VISITANTES_RECURRENTES as id,
          v.NOMBRE_VISITANTE,
          v.DNI_VISITANTE,
          v.NUM_CARNET_EXTRANJERO,
          v.NUM_PERSONAS,
          v.NUM_PLACA,
          v.FECHA_HORA,
          v.FECHA_VENCIMIENTO,
          v.ESTADO_QR,
          v.ID_USUARIO,
          u.NOMBRE_USUARIO as RESIDENTE
        FROM TBL_VISITANTES_RECURRENTES v
        JOIN TBL_MS_USUARIO u ON v.ID_USUARIO = u.ID_USUARIO
        WHERE v.ID_VISITANTES_RECURRENTES = ?
      `, [id]);

      if (rows.length === 0) return res.status(404).json({ message: "Visita no encontrada" });
      
      const vencimiento = moment(rows[0].FECHA_VENCIMIENTO);
      if (moment().isAfter(vencimiento)) return res.status(400).json({ message: "Código QR vencido" });
      
      return res.status(200).json({ data: rows[0], isRecurrent: true });
    } else {
      const [rows] = await connection.query(`
        SELECT 
          v.ID_VISITANTE as id,
          v.NOMBRE_VISITANTE,
          v.DNI_VISITANTE,
          v.NUM_CARNET_EXTRANJERO,
          v.NUM_PERSONAS,
          v.NUM_PLACA,
          v.FECHA_HORA,
          v.ESTADO_QR,
          v.ID_USUARIO,
          u.NOMBRE_USUARIO as RESIDENTE
        FROM TBL_REGVISITAS v
        JOIN TBL_MS_USUARIO u ON v.ID_USUARIO = u.ID_USUARIO
        WHERE v.ID_VISITANTE = ?
      `, [id]);

      if (rows.length === 0) return res.status(404).json({ message: "Visita no encontrada" });
      if (rows[0].ESTADO_QR === 1) return res.status(400).json({ message: "Código QR ya utilizado" });
      
      return res.status(200).json({ data: rows[0], isRecurrent: false });
    }
  } catch (error) {
    console.error("Error al obtener visita:", error);
    res.status(500).json({ message: "Error al obtener visita" });
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
    documento 
  } = req.body;

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
        SET FECHA_ACCESO = ?, NUM_PERSONAS = ?, NUM_PLACA = ?, ID_NACIONALIDAD = ?, DNI_VISITANTE = ?, NUM_CARNET_EXTRANJERO = ?, CANTIDAD_ESCANEANA = CANTIDAD_ESCANEANA + 1
        WHERE ID_VISITANTES_RECURRENTES = ?
      `, [now, numPersonas, numPlaca, nacionalidadId, dni, carnet, id]);

      // Insert Bitácora
      const [personaRows] = await connection.query("SELECT ID_PERSONA FROM TBL_PERSONAS WHERE ID_USUARIO = ?", [userId]);
      const idPersona = personaRows[0]?.ID_PERSONA || null;
      await connection.query(`
        INSERT INTO TBL_BITACORA_VISITA (ID_PERSONA, ID_VISITANTES_RECURRENTES, NUM_PERSONA, NUM_PLACA, NOTA, FECHA_HORA, FECHA_ACCESO, FECHA_VENCIMIENTO)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [idPersona, id, numPersonas, numPlaca, "Ingreso registrado por guardia", visitorData.FECHA_HORA, now, visitorData.FECHA_VENCIMIENTO]);

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

      // Update Bitácora (It usually gets created on visit creation, we could either update it or add a new record. The plan said 'Logs the entry in TBL_BITACORA_VISITA' but bitacora is usually created at qr gen. Let's update FECHA_ACCESO in bitacora)
      await connection.query(`
        UPDATE TBL_BITACORA_VISITA
        SET FECHA_ACCESO = ?, NUM_PERSONA = ?, NUM_PLACA = ?
        WHERE ID_VISITANTE = ?
      `, [now, numPersonas, numPlaca, id]);
    }

    await connection.commit();

    // Notify Resident
    try {
      const [userRows] = await connection.query("SELECT EMAIL, FCM_TOKEN FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [userId]);
      if (userRows.length > 0) {
        const title = "Su visita ha ingresado";
        const bodyMsg = `${visitorData.NOMBRE_VISITANTE} ha registrado su ingreso (${numPersonas} persona/s).`;
        
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

module.exports = {
  loginGuardia,
  getVisitDetails,
  confirmEntry
};
