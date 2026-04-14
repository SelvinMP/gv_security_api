const { mysqlPool } = require('../config/db');
const { transporter, sendMailWithTimeout } = require('../config/transporter');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

try {
  if (!admin.apps.length) {
    const serviceAccount = require('../config/firebaseServiceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin inicializado correctamente");
  }
} catch (error) {
  console.warn("⚠️ Firebase Admin NO inicializado. Faltan credenciales (src/config/firebaseServiceAccountKey.json).");
}
const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '00'.repeat(32);

// Helper para cifrar (usado en registro y 2FA)
const encrypt = (text) => {
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.alloc(16, 0));
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
};

const register = async (req, res) => {
  const { NOMBRE_USUARIO, EMAIL, CONTRASEÑA } = req.body;

  if (!NOMBRE_USUARIO || !EMAIL || !CONTRASEÑA) {
    return res.status(400).json({ message: "Todos los campos son requeridos" });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    const hashedPassword = await bcrypt.hash(CONTRASEÑA, 8);
    const verificationCode = crypto.randomBytes(3).toString("hex").toUpperCase();
    const encryptedCode = encrypt(verificationCode);

    const [existingUsers] = await connection.query(
      "SELECT ID_USUARIO, PRIMER_INGRESO_COMPLETADO, ID_ESTADO_USUARIO FROM TBL_MS_USUARIO WHERE EMAIL = ?",
      [EMAIL]
    );

    let userId;
    let isUpdate = false;

    if (existingUsers.length > 0) {
      const user = existingUsers[0];
      
      // Si ya completó el primer ingreso o está activo/etc., no permitir re-registro
      if (user.PRIMER_INGRESO_COMPLETADO === 1 || user.ID_ESTADO_USUARIO === 1) {
        await connection.rollback();
        return res.status(400).json({ message: "Este correo ya está registrado y activo." });
      }

      // Si el usuario existe pero está pendiente de verificación (Estado 5) o es nuevo incompleto
      userId = user.ID_USUARIO;
      isUpdate = true;
      const updateQuery = `UPDATE TBL_MS_USUARIO SET NOMBRE_USUARIO = ?, CONTRASEÑA = ?, CODIGO_VERIFICACION = ?, ID_ESTADO_USUARIO = 5 WHERE ID_USUARIO = ?`;
      await connection.query(updateQuery, [NOMBRE_USUARIO, hashedPassword, encryptedCode, userId]);
      
      // Upsert en personas temporal (solo ID_USUARIO)
      const [pRows] = await connection.query("SELECT ID_PERSONA FROM TBL_PERSONAS WHERE ID_USUARIO = ?", [userId]);
      if (pRows.length === 0) {
        await connection.query("INSERT INTO TBL_PERSONAS (ID_USUARIO) VALUES (?)", [userId]);
      }
    } else {
      const insertUserQuery = `INSERT INTO TBL_MS_USUARIO (NOMBRE_USUARIO, EMAIL, CONTRASEÑA, CODIGO_VERIFICACION, ID_ROL, ID_ESTADO_USUARIO, PRIMER_INGRESO_COMPLETADO) VALUES (?, ?, ?, ?, 2, 5, 0)`;
      const [insertResult] = await connection.query(insertUserQuery, [NOMBRE_USUARIO, EMAIL, hashedPassword, encryptedCode]);
      userId = insertResult.insertId;
      await connection.query("INSERT INTO TBL_PERSONAS (ID_USUARIO) VALUES (?)", [userId]);
    }

    const mailOptions = {
      from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
      to: EMAIL,
      subject: "Código de Verificación - Registro",
      html: `<div style="font-family: sans-serif; border: 1px solid #ddd; padding: 20px;">
          <h2>Verifica tu cuenta</h2>
          <p>Hola <strong>${NOMBRE_USUARIO}</strong>,</p>
          <p>Usa el siguiente código para completar tu registro en GV-Security:</p>
          <p style="font-size: 32px; font-weight: bold; color: #d4af37; letter-spacing: 5px;">${verificationCode}</p>
          <p>Si no solicitaste esto, ignora este correo.</p>
        </div>`
    };

    await sendMailWithTimeout(mailOptions);
    await connection.commit();

    const token = jwt.sign({ id: userId }, SECRET_KEY, { expiresIn: 1800 });
    res.status(201).json({ success: true, token, id_usuario: userId, message: isUpdate ? "Datos actualizados. Verifica tu correo." : "Usuario creado. Verifica tu correo." });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error en Registro:", err);
    res.status(500).json({ message: "Error al procesar el registro" });
  } finally {
    if (connection) connection.release();
  }
};

const login = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: "Usuario y contraseña son requeridos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?", [username]);
    if (rows.length === 0) return res.status(401).json({ message: "Usuario no encontrado" });

    const user = rows[0];
    
    if (user.ID_ROL === 3) {
      return res.status(403).json({ message: "Acceso denegado: Esta aplicación es exclusiva para residentes" });
    }

    switch (user.ID_ESTADO_USUARIO) {
      case 2: return res.status(403).json({ message: "Usuario inactivo" });
      case 3: return res.status(403).json({ message: "Usuario bloqueado" });
      case 4: return res.status(403).json({ message: "Usuario Nuevo (Pendiente de activación)" });
      case 5: return res.status(403).json({ message: "Usuario pendiente de verificación" });
    }

    const passwordIsValid = await bcrypt.compare(password, user.CONTRASEÑA);
    if (!passwordIsValid) {
      await connection.query("UPDATE TBL_MS_USUARIO SET INTENTOS_FALLIDOS = INTENTOS_FALLIDOS + 1 WHERE EMAIL = ?", [username]);
      const [paramRows] = await connection.query("SELECT VALOR FROM TBL_MS_PARAMETROS WHERE PARAMETRO = ?", ["INTENTOS_FALLIDOS"]);
      const maxLoginAttempts = paramRows.length > 0 ? parseInt(paramRows[0].VALOR, 10) : 3;
      if (user.INTENTOS_FALLIDOS + 1 >= maxLoginAttempts) {
        await connection.query("UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 3 WHERE EMAIL = ?", [username]);
        return res.status(403).json({ message: "Usuario bloqueado por múltiples intentos fallidos" });
      } else {
        return res.status(401).json({ message: "Contraseña incorrecta" });
      }
    }

    await connection.query(`UPDATE TBL_MS_USUARIO SET INTENTOS_FALLIDOS = 0, PRIMER_INGRESO = IF(PRIMER_INGRESO IS NULL, NOW(), PRIMER_INGRESO) WHERE EMAIL = ?`, [username]);
    const token = jwt.sign({ id: user.ID_USUARIO }, SECRET_KEY, { expiresIn: '2h' });

    if (Number(user.CODIGO_2FA) === 1) {
      const verificationCode = crypto.randomBytes(3).toString("hex").toUpperCase();
      const encryptedCode = encrypt(verificationCode);

      await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = ? WHERE EMAIL = ?", [encryptedCode, username]);

      const mailOptions = {
        from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
        to: username,
        subject: "Código de Verificación 2FA",
        html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd;">
            <h2>Autenticación de Dos Pasos</h2>
            <p>Hola,</p>
            <p>Tu código de verificación de seguridad es:</p>
            <p style="font-size: 32px; font-weight: bold; color: #d4af37; letter-spacing: 5px;">${verificationCode}</p>
            <p>Si no solicitaste este código, te recomendamos cambiar tu contraseña inmediatamente.</p>
          </div>`
      };

      try {
        await sendMailWithTimeout(mailOptions);
        return res.status(200).json({ token, id_usuario: user.ID_USUARIO, require2FA: true, message: "Código 2FA enviado" });
      } catch (mailError) {
        console.error("Error al enviar email 2FA:", mailError.message);
        // No bloqueamos el login: devolvemos el token y avisamos al cliente
        return res.status(200).json({
          token,
          id_usuario: user.ID_USUARIO,
          require2FA: true,
          emailError: true,
          message: "Código generado pero no se pudo enviar el correo. Contacte al administrador."
        });
      }
    } else {
      return res.status(200).json({ token, id_usuario: user.ID_USUARIO, require2FA: false, message: "Login exitoso" });
    }
  } catch (err) {
    console.error("Error en login:", err);
    res.status(500).json({ message: "Error interno del servidor" });
  } finally {
    if (connection) connection.release();
  }
};

const verify2FA = async (req, res) => {
  const { id_usuario, codigo } = req.body;
  if (!id_usuario || !codigo) return res.status(400).json({ message: "Datos incompletos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT CODIGO_VERIFICACION, ID_ESTADO_USUARIO, INTENTOS_FALLIDOS, EMAIL FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [id_usuario]);
    if (rows.length === 0) return res.status(401).json({ message: "Usuario no encontrado" });

    const user = rows[0];
    if (user.ID_ESTADO_USUARIO === 3) return res.status(403).json({ message: "Cuenta bloqueada" });

    const encryptedInput = encrypt(codigo.toUpperCase());
    if (user.CODIGO_VERIFICACION !== encryptedInput) {
      // Incrementar intentos fallidos
      await connection.query("UPDATE TBL_MS_USUARIO SET INTENTOS_FALLIDOS = INTENTOS_FALLIDOS + 1 WHERE ID_USUARIO = ?", [id_usuario]);
      
      const [paramRows] = await connection.query("SELECT VALOR FROM TBL_MS_PARAMETROS WHERE PARAMETRO = ?", ["INTENTOS_FALLIDOS"]);
      const maxLoginAttempts = paramRows.length > 0 ? parseInt(paramRows[0].VALOR, 10) : 3;

      if (user.INTENTOS_FALLIDOS + 1 >= maxLoginAttempts) {
        await connection.query("UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 3 WHERE ID_USUARIO = ?", [id_usuario]);
        return res.status(403).json({ message: "Usuario bloqueado por múltiples intentos fallidos" });
      }

      return res.status(401).json({ 
        message: "Código incorrecto",
        attemptsLeft: maxLoginAttempts - (user.INTENTOS_FALLIDOS + 1)
      });
    }

    // Éxito: Resetear intentos y limpiar código
    await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = NULL, INTENTOS_FALLIDOS = 0, PRIMER_INGRESO_COMPLETADO = 1 WHERE ID_USUARIO = ?", [id_usuario]);
    
    const token = jwt.sign({ id: id_usuario }, SECRET_KEY, { expiresIn: 5400 }); 
    
    res.status(200).json({ 
      success: true, 
      token, 
      id_usuario: id_usuario,
      redirect: "/dashboard",
      message: "Acceso concedido" 
    });

  } catch (err) {
    console.error("Error in verify2FA:", err);
    res.status(500).json({ message: "Error de servidor" });
  } finally {
    if (connection) connection.release();
  }
};

const verifyRegistration = async (req, res) => {
  const { id_usuario, codigo } = req.body;
  if (!id_usuario || !codigo) return res.status(400).json({ message: "Datos incompletos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT CODIGO_VERIFICACION FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [id_usuario]);
    if (rows.length === 0) return res.status(401).json({ message: "Usuario no encontrado" });

    const user = rows[0];
    const encryptedInput = encrypt(codigo.toUpperCase());

    if (user.CODIGO_VERIFICACION !== encryptedInput) {
      return res.status(401).json({ message: "Código de verificación incorrecto" });
    }

    // No cambiamos el estado aquí todavía, ya que falta el paso de datos personales.
    // Simplemente validamos el código.
    await connection.query(
      "UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = NULL WHERE ID_USUARIO = ?", 
      [id_usuario]
    );

    res.status(200).json({ success: true, message: "Código verificado. Proceda a ingresar sus datos personales." });
  } catch (err) {
    res.status(500).json({ message: "Error de servidor" });
  } finally {
    if (connection) connection.release();
  }
};

const getNationalities = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query("SELECT ID_NACIONALIDAD, NOMBRE_NACIONALIDAD FROM TBL_NACIONALIDADES");
    res.json(results);
  } catch (err) {
    console.error("Error en getNationalities:", err);
    res.status(500).json({ error: "Error al obtener nacionalidades" });
  } finally {
    if (connection) connection.release();
  }
};

const getContactTypes = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query("SELECT ID_TIPO_CONTACTO, DESCRIPCION FROM TBL_TIPO_CONTACTO");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener tipos de contacto" });
  } finally {
    if (connection) connection.release();
  }
};

const getRelationships = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query("SELECT ID_PARENTESCO, DESCRIPCION FROM TBL_PARENTESCOS");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener parentescos" });
  } finally {
    if (connection) connection.release();
  }
};

const getCondos = async (req, res) => {
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query("SELECT ID_CONDOMINIO, DESCRIPCION FROM TBL_CONDOMINIOS");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener condominios" });
  } finally {
    if (connection) connection.release();
  }
};

const savePersonalData = async (req, res) => {
  const { 
    id_usuario, 
    dni, 
    carnet, 
    nationality, 
    contactType, 
    contact, 
    relationship, 
    condo 
  } = req.body;

  if (!id_usuario || !nationality || !contactType || !contact || !relationship || !condo) {
    return res.status(400).json({ message: "Datos incompletos" });
  }

  const esHondurena = nationality.toLowerCase().includes("hondureña");
  if (esHondurena && !dni) return res.status(400).json({ message: "El DNI es requerido para nacionalidad hondureña" });
  if (!esHondurena && !carnet) return res.status(400).json({ message: "El Carnet es requerido para extranjeros" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    // 1. Validar DNI si es hondureño
    if (esHondurena && dni) {
      if (dni.length < 4) return res.status(400).json({ message: "El DNI debe tener al menos 4 dígitos" });
      const codigoDNI = dni.substring(0, 4);
      const [codigoResults] = await connection.query("SELECT COUNT(*) as count FROM TBL_CODIGO_DNI WHERE CODIGO = ?", [codigoDNI]);
      if (codigoResults[0].count === 0) return res.status(400).json({ message: "Código de DNI inválido" });
    }

    // 2. Obtener IDs y validar capacidad del condominio
    const [condoResults] = await connection.query("SELECT ID_CONDOMINIO, USUARIOS_POR_CASA FROM TBL_CONDOMINIOS WHERE DESCRIPCION = ?", [condo]);
    if (condoResults.length === 0) throw new Error("Condominio no encontrado");
    const { ID_CONDOMINIO, USUARIOS_POR_CASA } = condoResults[0];

    const [regCount] = await connection.query("SELECT COUNT(*) AS total FROM TBL_PERSONAS WHERE ID_CONDOMINIO = ?", [ID_CONDOMINIO]);
    if (regCount[0].total >= USUARIOS_POR_CASA) return res.status(400).json({ message: "Capacidad máxima del condominio alcanzada" });

    // 3. Obtener Usuario y Persona
    const [userRows] = await connection.query("SELECT NOMBRE_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [id_usuario]);
    if (userRows.length === 0) throw new Error("Usuario no encontrado");

    const [personaRows] = await connection.query("SELECT ID_PERSONA FROM TBL_PERSONAS WHERE ID_USUARIO = ?", [id_usuario]);
    if (personaRows.length === 0) throw new Error("Registro de persona no encontrado");
    const ID_PERSONA = personaRows[0].ID_PERSONA;

    // 4. Obtener otros IDs
    const [nacionalidadRows] = await connection.query("SELECT ID_NACIONALIDAD FROM TBL_NACIONALIDADES WHERE NOMBRE_NACIONALIDAD = ?", [nationality]);
    const ID_NACIONALIDAD = nacionalidadRows.length > 0 ? nacionalidadRows[0].ID_NACIONALIDAD : null;

    const [tipoContRows] = await connection.query("SELECT ID_TIPO_CONTACTO FROM TBL_TIPO_CONTACTO WHERE DESCRIPCION = ?", [contactType]);
    const ID_TIPO_CONTACTO = tipoContRows.length > 0 ? tipoContRows[0].ID_TIPO_CONTACTO : null;

    const [parentescoRows] = await connection.query("SELECT ID_PARENTESCO FROM TBL_PARENTESCOS WHERE DESCRIPCION = ?", [relationship]);
    const ID_PARENTESCO = parentescoRows.length > 0 ? parentescoRows[0].ID_PARENTESCO : null;

    // 5. Insertar Contacto
    const [contResult] = await connection.query("INSERT INTO TBL_CONTACTOS (ID_TIPO_CONTACTO, DESCRIPCION) VALUES (?, ?)", [ID_TIPO_CONTACTO, contact]);
    const ID_CONTACTO = contResult.insertId;

    // 6. Verificar si es necesario administrador de la vivienda
    const [adminCheck] = await connection.query("SELECT COUNT(*) AS count FROM TBL_PERSONAS WHERE ID_CONDOMINIO = ? AND ID_PADRE = 1", [ID_CONDOMINIO]);
    const isAdminRequired = adminCheck[0].count === 0;

    // 7. Actualizar Persona
    const updateQuery = `
      UPDATE TBL_PERSONAS 
      SET DNI_PERSONA = ?, NUM_CARNET_EXTRANJERO = ?, ID_NACIONALIDAD = ?, ID_CONTACTO = ?, ID_ESTADO_PERSONA = 1, ID_PARENTESCO = ?, ID_CONDOMINIO = ?, ID_PADRE = ?
      WHERE ID_PERSONA = ?`;
    await connection.query(updateQuery, [dni || null, carnet || null, ID_NACIONALIDAD, ID_CONTACTO, ID_PARENTESCO, ID_CONDOMINIO, isAdminRequired ? 1 : null, ID_PERSONA]);

    // 8. Actualizar Usuario
    await connection.query("UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 4, PRIMER_INGRESO_COMPLETADO = 1 WHERE ID_USUARIO = ?", [id_usuario]);

    await connection.commit();

    // 9. Notificar Administradores (Async)
    notifyAdmins(userRows[0].NOMBRE_USUARIO, contact, condo, isAdminRequired, ID_CONDOMINIO, esHondurena, dni, carnet);

    res.status(200).json({ success: true, message: "Datos guardados correctamente" });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error en savePersonalData:", err);
    res.status(500).json({ message: "Error interno" });
  } finally {
    if (connection) connection.release();
  }
};

// Función auxiliar para notificaciones (sin bloquear respuesta)
const notifyAdmins = async (nombre, contacto, condo, isNewAdmin, condoId, esHondurena, dni, carnet) => {
  try {
    // 1. Notificar a SuperAdmins si es nuevo admin de casa
    if (isNewAdmin) {
      const [superAdmins] = await mysqlPool.query("SELECT EMAIL FROM TBL_MS_USUARIO WHERE ID_ROL IN (1, 4)");
      if (superAdmins.length > 0) {
        const emailList = superAdmins.map(r => r.EMAIL);
        await sendMailWithTimeout({
          from: `"GV-Security" <${process.env.EMAIL_USER}>`,
          to: emailList,
          subject: "Nuevo Administrador de Vivienda Registrado",
          html: `<p>Se ha registrado un nuevo administrador global para la vivienda: <strong>${condo}</strong>.</p><p>Nombre: ${nombre}</p><p>Contacto: ${contacto}</p>`
        });
      }
    }

    // 2. Notificar a Admins de la misma vivienda
    const [condoAdmins] = await mysqlPool.query(
      `SELECT u.ID_USUARIO, u.EMAIL, u.FCM_TOKEN FROM TBL_MS_USUARIO u 
       JOIN TBL_PERSONAS p ON u.ID_USUARIO = p.ID_USUARIO 
       WHERE p.ID_CONDOMINIO = ? AND p.ID_PADRE = 1`, [condoId]
    );

    if (condoAdmins.length > 0) {
      // 2.a Notificación por Correo
      const destinatarios = condoAdmins.map(c => c.EMAIL);
      const docInfo = esHondurena ? `<p>DNI: ${dni}</p>` : `<p>Carnet: ${carnet}</p>`;
      const asunt = "Nuevo integrante registrado en su vivienda";
      const menj = `Hola, un nuevo integrante se ha registrado en su vivienda: ${condo}. Nombre: ${nombre}, Contacto: ${contacto}`;
      
      await sendMailWithTimeout({
        from: `"GV-Security" <${process.env.EMAIL_USER}>`,
        to: destinatarios,
        subject: asunt,
        html: `<p>${menj}</p>${docInfo}`
      });

      // 2.b Guardar en Base de Datos e Intentar Notification Push (Firebase)
      const TokensFCM = [];
      for (const destinatario of condoAdmins) {
        // Insertar registro para que se vea dentro de la App ("Alertas")
        await mysqlPool.query(
          "INSERT INTO TBL_NOTIFICACIONES_APP (ID_USUARIO, TITULO, MENSAJE, FECHA_HORA, LEIDA) VALUES (?, ?, ?, NOW(), 0)",
          [destinatario.ID_USUARIO, asunt, menj]
        );

        // Agrupar los tokens para mandar Push Multi-Cast (celulares)
        if (destinatario.FCM_TOKEN) {
          TokensFCM.push(destinatario.FCM_TOKEN);
        }
      }

      // 2.c Enviar Push vía Firebase Cloud Messaging
      if (TokensFCM.length > 0 && admin.apps.length > 0) {
        const message = {
          notification: {
            title: asunt,
            body: menj,
          },
          tokens: TokensFCM // Arreglo de tokens celulares validos
        };
        admin.messaging().sendEachForMulticast(message)
          .then((response) => console.log(response.successCount + ' mensajes FCM enviados correctamente.'))
          .catch((error) => console.error('Error enviando push FCM:', error));
      }
    }
  } catch (err) {
    console.error("Error enviando notificaciones:", err);
  }
};

const get2FAStatus = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "Token no proporcionado" });

  const token = authHeader.split(" ")[1];
  let connection;
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    connection = await mysqlPool.getConnection();
    const [results] = await connection.query("SELECT CODIGO_2FA FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [userId]);

    if (results.length > 0) {
      res.json({ enabled: results[0].CODIGO_2FA });
    } else {
      res.status(404).json({ message: "Usuario no encontrado" });
    }
  } catch (error) {
    res.status(500).json({ message: "Error al verificar el token o consultar estado" });
  } finally {
    if (connection) connection.release();
  }
};

const set2FAStatus = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "Token no proporcionado" });

  const token = authHeader.split(" ")[1];
  let connection;
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const userId = decoded.id;

    const { enabled } = req.body; // 0 o 1
    if (typeof enabled !== "number" || (enabled !== 0 && enabled !== 1)) {
      return res.status(400).json({ message: "Valor inválido para 2FA" });
    }

    connection = await mysqlPool.getConnection();
    await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_2FA = ? WHERE ID_USUARIO = ?", [enabled, userId]);

    res.json({ success: true, message: "Estado de 2FA actualizado correctamente" });
  } catch (error) {
    res.status(500).json({ message: "Error al actualizar estado de 2FA" });
  } finally {
    if (connection) connection.release();
  }
};

const getUserProfile = async (req, res) => {
  const { usuarioId } = req.params;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const query = `
      SELECT 
          u.ID_USUARIO,
          u.NOMBRE_USUARIO,
          u.EMAIL,
          u.PRIMER_INGRESO,
          CASE 
              WHEN p.ID_NACIONALIDAD = 1 THEN p.DNI_PERSONA
              WHEN p.ID_NACIONALIDAD = 2 THEN p.NUM_CARNET_EXTRANJERO
          END AS DOCUMENTO,
          d.DESCRIPCION AS CONDOMINIO,
          c.DESCRIPCION AS CONTACTO,
          p.ID_PERSONA,
          p.ID_PADRE,
          r.ROL AS ROL
      FROM TBL_MS_USUARIO u
      LEFT JOIN TBL_PERSONAS p 
          ON u.ID_USUARIO = p.ID_USUARIO
      LEFT JOIN TBL_CONDOMINIOS d 
          ON p.ID_CONDOMINIO = d.ID_CONDOMINIO
      LEFT JOIN TBL_CONTACTOS c 
          ON p.ID_CONTACTO = c.ID_CONTACTO
      LEFT JOIN TBL_MS_ROLES r 
          ON u.ID_ROL = r.ID_ROL
      WHERE u.ID_USUARIO = ?`;

    const [results] = await connection.query(query, [usuarioId]);

    if (results.length > 0) {
      res.json(results[0]);
    } else {
      res.status(404).json({ message: "Perfil no encontrado" });
    }
  } catch (error) {
    console.error("Error al obtener perfil:", error);
    res.status(500).json({ message: "Error al obtener perfil" });
  } finally {
    if (connection) connection.release();
  }
};

const getFamilyMembers = async (req, res) => {
  const { usuarioId } = req.params;
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const query = `
      SELECT 
          u.NOMBRE_USUARIO AS USUARIO_REGISTRADO,
          d.DESCRIPCION AS NOMBRE_CONDOMINIO,
          par.DESCRIPCION AS PARENTESCO,
          COUNT(p.ID_PERSONA) OVER (PARTITION BY p.ID_CONDOMINIO) AS TOTAL_RESIDENTES
      FROM TBL_MS_USUARIO u
      INNER JOIN TBL_PERSONAS p 
          ON u.ID_USUARIO = p.ID_USUARIO
      INNER JOIN TBL_CONDOMINIOS d 
          ON p.ID_CONDOMINIO = d.ID_CONDOMINIO
      LEFT JOIN TBL_PARENTESCOS par
          ON p.ID_PARENTESCO = par.ID_PARENTESCO
      WHERE p.ID_CONDOMINIO = (
          SELECT p2.ID_CONDOMINIO 
          FROM TBL_PERSONAS p2 
          WHERE p2.ID_USUARIO = ?
      )`;

    const [results] = await connection.query(query, [usuarioId]);
    res.json(results);
  } catch (error) {
    console.error("Error al obtener miembros de la familia:", error);
    res.status(500).json({ message: "Error al obtener miembros de la familia" });
  } finally {
    if (connection) connection.release();
  }
};

// Get detailed info about user's condominium
const getCondominiumDetails = async (req, res) => {
  const { usuarioId } = req.params;
  try {
    const connection = await mysqlPool.getConnection();
    const query = `
      SELECT 
          c.DESCRIPCION AS NOMBRE_CONDOMINIO,
          tc.DESCRIPCION AS TIPO_CONDOMINIO,
          c.USUARIOS_POR_CASA
      FROM TBL_PERSONAS p
      INNER JOIN TBL_CONDOMINIOS c ON p.ID_CONDOMINIO = c.ID_CONDOMINIO
      INNER JOIN TBL_TIPO_CONDOMINIO tc ON c.ID_TIPO_CONDOMINIO = tc.ID_TIPO_CONDOMINIO
      WHERE p.ID_USUARIO = ?
    `;
    const [results] = await connection.query(query, [usuarioId]);
    connection.release();
    if (results.length > 0) {
      res.json(results[0]);
    } else {
      res.status(404).json({ message: 'Condominio no encontrado' });
    }
  } catch (error) {
    console.error('Error in getCondominiumDetails:', error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// Get pending or new users in the same condominium
const getPendingUsers = async (req, res) => {
  const { usuarioId } = req.params;
  try {
    const connection = await mysqlPool.getConnection();
    const query = `
      SELECT 
          u.ID_USUARIO,
          u.NOMBRE_USUARIO,
          u.EMAIL,
          eu.DESCRIPCION AS ESTADO,
          p.ID_PERSONA
      FROM TBL_MS_USUARIO u
      INNER JOIN TBL_PERSONAS p ON u.ID_USUARIO = p.ID_USUARIO
      INNER JOIN TBL_ESTADO_USUARIO eu ON u.ID_ESTADO_USUARIO = eu.ID_ESTADO_USUARIO
      WHERE p.ID_CONDOMINIO = (
          SELECT p2.ID_CONDOMINIO FROM TBL_PERSONAS p2 WHERE p2.ID_USUARIO = ?
      )
      AND u.ID_ESTADO_USUARIO IN (4, 5)
      AND u.ID_USUARIO <> ?
    `;
    const [results] = await connection.query(query, [usuarioId, usuarioId]);
    connection.release();
    res.json(results);
  } catch (error) {
    console.error('Error in getPendingUsers:', error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// Approve user access
const approveUser = async (req, res) => {
  const { targetUsuarioId } = req.params;
  try {
    const connection = await mysqlPool.getConnection();
    await connection.query(
      'UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 1 WHERE ID_USUARIO = ?',
      [targetUsuarioId]
    );
    connection.release();
    res.json({ message: 'Usuario aprobado con éxito' });
  } catch (error) {
    console.error('Error in approveUser:', error);
    res.status(500).json({ message: 'Error al aprobar usuario' });
  }
};

// Reject and delete user request
const rejectUser = async (req, res) => {
  const { targetUsuarioId } = req.params;
  try {
    const connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    // Delete from TBL_PERSONAS first due to FK
    await connection.query('DELETE FROM TBL_PERSONAS WHERE ID_USUARIO = ?', [targetUsuarioId]);
    // Delete from TBL_MS_USUARIO
    await connection.query('DELETE FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [targetUsuarioId]);

    await connection.commit();
    connection.release();
    res.json({ message: 'Solicitud rechazada y eliminada' });
  } catch (error) {
    console.error('Error in rejectUser:', error);
    res.status(500).json({ message: 'Error al rechazar solicitud' });
  }
};

// Password Recovery Functions
const enviarCodigoRecuperacion = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "El correo es requerido" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT ID_USUARIO FROM TBL_MS_USUARIO WHERE EMAIL = ?", [email]);
    if (rows.length === 0) return res.status(404).json({ message: "Usuario no encontrado" });

    const verificationCode = crypto.randomBytes(3).toString("hex").toUpperCase();
    const encryptedCode = encrypt(verificationCode);

    await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = ? WHERE EMAIL = ?", [encryptedCode, email]);

    const mailOptions = {
      from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Recuperación de Contraseña",
      html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd;">
          <h2>Recuperación de Contraseña</h2>
          <p>Has solicitado restablecer tu contraseña. Tu código de verificación es:</p>
          <p style="font-size: 32px; font-weight: bold; color: #d4af37; letter-spacing: 5px;">${verificationCode}</p>
          <p>Si no solicitaste este cambio, puedes ignorar este correo.</p>
        </div>`
    };

    await sendMailWithTimeout(mailOptions);
    res.json({ success: true, message: "Código enviado a su correo", id_usuario: rows[0].ID_USUARIO });
  } catch (error) {
    console.error("Error in enviarCodigoRecuperacion:", error);
    res.status(500).json({ message: "Error al enviar el código" });
  } finally {
    if (connection) connection.release();
  }
};

const verificarCodigoRecuperacion = async (req, res) => {
  const { id_usuario, codigo } = req.body;
  if (!id_usuario || !codigo) return res.status(400).json({ message: "Datos incompletos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT CODIGO_VERIFICACION FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [id_usuario]);
    if (rows.length === 0) return res.status(404).json({ message: "Usuario no encontrado" });

    const encryptedInput = encrypt(codigo.toUpperCase());
    if (rows[0].CODIGO_VERIFICACION !== encryptedInput) {
      return res.status(401).json({ message: "Código incorrecto" });
    }

    res.json({ success: true, message: "Código verificado correctamente" });
  } catch (error) {
    console.error("Error in verificarCodigoRecuperacion:", error);
    res.status(500).json({ message: "Error al verificar el código" });
  } finally {
    if (connection) connection.release();
  }
};

const actualizarContrasena = async (req, res) => {
  const { id_usuario, nuevaContrasena } = req.body;
  if (!id_usuario || !nuevaContrasena) return res.status(400).json({ message: "Datos incompletos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const hashedPassword = await bcrypt.hash(nuevaContrasena, 8);
    
    await connection.query(
      "UPDATE TBL_MS_USUARIO SET CONTRASEÑA = ?, CODIGO_VERIFICACION = NULL, INTENTOS_FALLIDOS = 0 WHERE ID_USUARIO = ?", 
      [hashedPassword, id_usuario]
    );

    res.json({ success: true, message: "Contraseña actualizada exitosamente" });
  } catch (error) {
    console.error("Error in actualizarContrasena:", error);
    res.status(500).json({ message: "Error al actualizar la contraseña" });
  } finally {
    if (connection) connection.release();
  }
};

const changePassword = async (req, res) => {
  const { id_usuario, currentPassword, newPassword } = req.body;
  if (!id_usuario || !currentPassword || !newPassword) {
    return res.status(400).json({ message: "Todos los campos son requeridos" });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT CONTRASEÑA FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [id_usuario]);
    if (rows.length === 0) return res.status(404).json({ message: "Usuario no encontrado" });

    const user = rows[0];
    const passwordIsValid = await bcrypt.compare(currentPassword, user.CONTRASEÑA);
    if (!passwordIsValid) {
      return res.status(401).json({ message: "La contraseña actual es incorrecta" });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 8);
    await connection.query("UPDATE TBL_MS_USUARIO SET CONTRASEÑA = ? WHERE ID_USUARIO = ?", [hashedNewPassword, id_usuario]);

    res.json({ success: true, message: "Contraseña cambiada correctamente" });
  } catch (error) {
    console.error("Error in changePassword:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  register, 
  login,
  verify2FA,
  verifyRegistration,
  enviarCodigoRecuperacion,
  verificarCodigoRecuperacion,
  actualizarContrasena,
  getNationalities,
  getContactTypes,
  getRelationships, // Assuming getParentesco is getRelationships
  getCondos, // Assuming getCondominios is getCondos
  savePersonalData,
  get2FAStatus,
  set2FAStatus,
  getUserProfile,
  getFamilyMembers,
  getCondominiumDetails,
  getPendingUsers,
  approveUser,
  rejectUser,
  changePassword
};
