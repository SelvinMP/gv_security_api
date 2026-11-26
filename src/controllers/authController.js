const { mysqlPool } = require('../config/db');
const { transporter, sendMailWithTimeout } = require('../config/transporter');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
// Firebase Admin se inicializa una sola vez en config/firebase.js
const { sendPush, isPushReady, getPushInitError } = require('../config/firebase');
const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';
const { ACCION, clientInfo, logUsuario, logPersona, logContrasena } = require('../utils/audit');
const { signPurposeToken, verifyPurposeToken, bearerToken, passwordFingerprint } = require('../utils/authTokens');
const { consumeRateLimit, tooManyRequests } = require('../utils/rateLimit');
const { isPasswordBreached } = require('../utils/breachedPasswords');
const { isAdminRequest, canAccessUser, denyAccess } = require('../utils/access');
const { hashDeviceId, describeDevice, startSession, endSession, forgetSession } = require('../utils/sessions');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '00'.repeat(32);

// Vigencias de los pasos intermedios de autenticación
const PRE2FA_TOKEN_TTL = '30m';        // tiempo para escribir el código 2FA (alcanza para reenviarlo)
const RESET_TOKEN_TTL = '15m';         // tiempo para escribir la nueva contraseña tras validar el código
const RECOVERY_CODE_MINUTES = 15;      // vigencia del código de recuperación enviado al correo
const MAX_CODE_ATTEMPTS = 5;           // intentos por código de recuperación antes de anularlo

// Recuperación de contraseña
const MINUTE_MS = 60 * 1000;
const RECOVERY_ALLOWED_STATES = [1, 3]; // activo, o bloqueado (cambiar la contraseña no lo desbloquea)
const RECOVERY_SENT_MESSAGE = "Si el correo está registrado, te enviamos un código. Revisa también la carpeta de spam.";
const RECOVERY_INVALID_CODE_MESSAGE = "El código no es correcto o ya venció. Revísalo o solicita uno nuevo.";

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
/** Un solo correo, sin comas, espacios ni corchetes (nodemailer aceptaría una lista de destinatarios). */
const isSingleEmail = (value) =>
  typeof value === 'string' && value.length <= 254 && /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/.test(value);
/** Clave corta y de largo fijo para los límites de solicitudes (no guarda el correo tal cual). */
const limitKey = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url').slice(0, 22);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Helper para cifrar (usado en registro y 2FA)
const encrypt = (text) => {
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.alloc(16, 0));
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
};

// Helper para descifrar
const decrypt = (encryptedHex) => {
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.alloc(16, 0));
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    return null;
  }
};

/**
 * Bloque HTML del código de verificación, pensado para copiar y pegar:
 * - sin espacios entre caracteres (letter-spacing es solo visual, al copiar sale "A1B2C3");
 * - "user-select: all": un toque / doble clic selecciona el código completo;
 * - el código también va en el asunto, para copiarlo desde la notificación del teléfono.
 */
const codeBlockHtml = (code) => `
  <div style="background-color: #0E2041; border-radius: 8px; padding: 18px; text-align: center; margin: 25px 0;">
    <span style="font-size: 34px; font-weight: bold; color: #d4af37; letter-spacing: 8px; font-family: monospace; user-select: all; -webkit-user-select: all;">${code}</span>
  </div>
  <p style="color: #888888; font-size: 12px; text-align: center; margin: -12px 0 20px;">Mantén presionado (o haz doble clic) sobre el código para copiarlo y pégalo en la app.</p>`;

// Genera un código OTP de 6 caracteres con fecha de expiración (por defecto 10 minutos)
const generateVerificationPayload = (codeLength = 6, expirationMinutes = 10) => {
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const expiresAt = Date.now() + (expirationMinutes * 60 * 1000);
  const rawPayload = `${code}:${expiresAt}`;
  const encrypted = encrypt(rawPayload);
  return { code, expiresAt, encrypted };
};

// Valida si el código introducido coincide y si no ha expirado
const validateVerificationCode = (inputCode, storedEncrypted) => {
  if (!storedEncrypted || !inputCode) {
    return { valid: false, expired: false, reason: "Código no encontrado" };
  }

  const cleanInput = inputCode.trim().toUpperCase();

  // 1. Probar formato con expiración (CODE:TIMESTAMP)
  const decrypted = decrypt(storedEncrypted);
  if (decrypted && decrypted.includes(":")) {
    const [storedCode, expiresAtStr] = decrypted.split(":");
    const expiresAt = parseInt(expiresAtStr, 10);

    if (Date.now() > expiresAt) {
      return { valid: false, expired: true, reason: "El código de verificación ha expirado. Por favor solicita uno nuevo." };
    }

    if (storedCode.toUpperCase() === cleanInput) {
      return { valid: true, expired: false };
    } else {
      return { valid: false, expired: false, reason: "Código de verificación incorrecto" };
    }
  }

  // 2. Compatibilidad con formato anterior cifrado directo (sin vencimiento)
  const legacyEncrypted = encrypt(cleanInput);
  if (storedEncrypted === legacyEncrypted) {
    return { valid: true, expired: false, legacy: true };
  }

  return { valid: false, expired: false, reason: "Código de verificación incorrecto" };
};

/**
 * Cuenta un intento fallido dentro del propio código (CODIGO:VENCE:FALLOS). Al llegar al máximo
 * el código se anula y hay que pedir otro: no se puede adivinar por fuerza bruta y tampoco se
 * bloquea la cuenta del dueño por intentos ajenos. Devuelve cuántos intentos quedan.
 */
const registerFailedCodeAttempt = async (connection, userId, storedEncrypted) => {
  const [code, expiresAt, failsStr] = (decrypt(storedEncrypted) || '').split(':');
  const fails = (parseInt(failsStr, 10) || 0) + 1;
  const next = code && expiresAt && fails < MAX_CODE_ATTEMPTS ? encrypt(`${code}:${expiresAt}:${fails}`) : null;
  // Solo si el código no cambió mientras tanto (por ejemplo, porque se pidió uno nuevo)
  await connection.query(
    "UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = ? WHERE ID_USUARIO = ? AND CODIGO_VERIFICACION = ?",
    [next, userId, storedEncrypted]
  );
  return next ? MAX_CODE_ATTEMPTS - fails : 0;
};

/**
 * Aprobar o rechazar una solicitud de acceso: solo si sigue pendiente (estados 4 y 5) y quien la
 * gestiona es administrador o un residente activo de la misma casa. Nadie gestiona la suya.
 * Devuelve null si está permitido, o { status, message } con el motivo del rechazo.
 */
const checkRequestPermission = async (connection, req, targetUsuarioId) => {
  if (String(req.user?.id) === String(targetUsuarioId)) {
    return { status: 403, message: "No puedes aprobar ni rechazar tu propia solicitud." };
  }

  const userStateQuery = `
    SELECT u.ID_ESTADO_USUARIO, p.ID_CONDOMINIO
    FROM TBL_MS_USUARIO u
    LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = u.ID_USUARIO
    WHERE u.ID_USUARIO = ?`;

  const [targetRows] = await connection.query(userStateQuery, [targetUsuarioId]);
  if (targetRows.length === 0) return { status: 404, message: "Solicitud no encontrada." };
  if (![4, 5].includes(Number(targetRows[0].ID_ESTADO_USUARIO))) {
    return { status: 409, message: "Esta solicitud ya no está pendiente." };
  }

  if (isAdminRequest(req)) return null;

  const [requesterRows] = await connection.query(userStateQuery, [req.user.id]);
  const requester = requesterRows[0];
  const targetCondo = targetRows[0].ID_CONDOMINIO;
  if (!requester || Number(requester.ID_ESTADO_USUARIO) !== 1 || !targetCondo || String(requester.ID_CONDOMINIO) !== String(targetCondo)) {
    return { status: 403, message: "Solo puedes gestionar solicitudes de tu propia casa." };
  }
  return null;
};

const register = async (req, res) => {
  const { NOMBRE_USUARIO, EMAIL, CONTRASEÑA } = req.body;

  if (!NOMBRE_USUARIO || !EMAIL || !CONTRASEÑA) {
    return res.status(400).json({ message: "Todos los campos son requeridos" });
  }
  if (!isSingleEmail(EMAIL)) {
    return res.status(400).json({ message: "Correo electrónico inválido" });
  }

  const wait = consumeRateLimit([{ key: `register:ip:${clientInfo(req).ip}`, max: 20, windowMs: 60 * MINUTE_MS }]);
  if (wait) return tooManyRequests(res, wait);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    const hashedPassword = await bcrypt.hash(CONTRASEÑA, 8);
    const { code: verificationCode, encrypted: encryptedCode } = generateVerificationPayload(6, 10);

    const [existingUsers] = await connection.query(
      "SELECT ID_USUARIO, PRIMER_INGRESO_COMPLETADO, ID_ESTADO_USUARIO FROM TBL_MS_USUARIO WHERE EMAIL = ?",
      [EMAIL]
    );

    let userId;
    let isUpdate = false;

    if (existingUsers.length > 0) {
      const user = existingUsers[0];
      
      // Solo se puede repetir un registro que sigue esperando la verificación del correo (estado 5 y sin
      // completar). Antes también se aceptaba con cuentas bloqueadas o inactivas, y eso reemplazaba su
      // contraseña por la de quien "se registraba" con ese correo.
      if (Number(user.ID_ESTADO_USUARIO) !== 5 || Number(user.PRIMER_INGRESO_COMPLETADO) === 1) {
        await connection.rollback();
        return res.status(400).json({ message: "Este correo ya está registrado." });
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
      subject: `${verificationCode} es tu código de verificación - GV-Security`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 30px;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-top: 5px solid #0E2041;">
            <h2 style="color: #0E2041; margin-top: 0; font-size: 24px; text-align: center; font-weight: 800;">GV-Security</h2>
            <h3 style="color: #333333; font-size: 18px; margin-bottom: 10px;">Verifica tu correo electrónico</h3>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">Hola <strong>${escapeHtml(NOMBRE_USUARIO)}</strong>,</p>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">Gracias por registrarte en <strong>GV-Security</strong>. Usa el siguiente código para completar la verificación de tu cuenta:</p>
            ${codeBlockHtml(verificationCode)}
            <p style="color: #888888; font-size: 13px; text-align: center;">⏱️ Este código es válido durante <strong>10 minutos</strong> y es de un solo uso.</p>
            <hr style="border: none; border-top: 1px solid #eeeeee; margin: 25px 0;" />
            <p style="color: #999999; font-size: 12px; text-align: center; margin-bottom: 0;">Si no solicitaste este registro, puedes ignorar este mensaje de forma segura.</p>
          </div>
        </div>
      `
    };

    try {
      await sendMailWithTimeout(mailOptions);
    } catch (mailErr) {
      // Nunca se escribe el código ni el correo en los registros
      console.warn(`⚠️ Error enviando correo de verificación al usuario ${userId} (SMTP):`, mailErr.message);
    }
    await logUsuario(connection, req, {
      idUsuario: userId,
      accion: ACCION.REGISTRO,
      detalle: isUpdate ? 'Registro repetido: se actualizaron nombre y contraseña pendientes de verificación' : 'Auto-registro desde la app (pendiente de verificar correo)',
      responsable: NOMBRE_USUARIO,
    });
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

// Estados que no pueden iniciar sesión: 2 inactivo, 3 bloqueado, 4 pendiente de activación, 5 sin verificar
const DISABLED_STATES = [2, 3, 4, 5];

/** Lee el estado actual de la cuenta (no el que se leyó al principio de la petición). */
const isAccountDisabled = async (connection, userId) => {
  const [rows] = await connection.query("SELECT ID_ESTADO_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [userId]);
  return rows.length === 0 || DISABLED_STATES.includes(Number(rows[0].ID_ESTADO_USUARIO));
};

/**
 * Suma un intento fallido (contraseña o código del login) y bloquea la cuenta al llegar al máximo,
 * en una sola sentencia. Con muchas peticiones a la vez cada una parte del conteo ya actualizado
 * (InnoDB bloquea la fila), así que el límite no se puede saltar mandando intentos en paralelo.
 * Aplica a todos los roles, guardias incluidos. Devuelve { blocked, attemptsLeft }.
 */
const registerFailedLogin = async (connection, req, user, detalle) => {
  const [paramRows] = await connection.query("SELECT VALOR FROM TBL_MS_PARAMETROS WHERE PARAMETRO = ?", ["INTENTOS_FALLIDOS"]);
  const maxAttempts = parseInt(paramRows[0]?.VALOR, 10) || 3;

  // El estado se calcula antes del incremento y con el valor anterior + 1: el resultado es el mismo
  // tanto si MySQL evalúa las asignaciones en orden como si usa los valores originales.
  await connection.query(
    `UPDATE TBL_MS_USUARIO
        SET ID_ESTADO_USUARIO = IF(INTENTOS_FALLIDOS + 1 >= ?, 3, ID_ESTADO_USUARIO),
            INTENTOS_FALLIDOS = INTENTOS_FALLIDOS + 1
      WHERE ID_USUARIO = ?`,
    [maxAttempts, user.ID_USUARIO]
  );
  const [rows] = await connection.query("SELECT INTENTOS_FALLIDOS, ID_ESTADO_USUARIO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [user.ID_USUARIO]);
  const fails = Number(rows[0]?.INTENTOS_FALLIDOS) || 0;
  const blocked = Number(rows[0]?.ID_ESTADO_USUARIO) === 3;

  if (blocked && Number(user.ID_ESTADO_USUARIO) !== 3) {
    await logUsuario(connection, req, {
      idUsuario: user.ID_USUARIO,
      accion: ACCION.BLOQUEO,
      detalle: `Bloqueo automático: ${maxAttempts} ${detalle}`,
      responsable: 'Sistema (seguridad)',
    });
  }
  return { blocked, attemptsLeft: Math.max(0, maxAttempts - fails) };
};

/**
 * Correo con el código del segundo paso del login: el 2FA de siempre, o la confirmación de un
 * dispositivo nuevo (al confirmarlo se cierra la sesión del dispositivo anterior).
 */
const loginCodeMail = (to, code, reason, device) => {
  const newDevice = reason === 'new_device';
  return {
    from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
    to,
    subject: newDevice
      ? `${code} es tu código para confirmar un dispositivo nuevo - GV-Security`
      : `${code} es tu código 2FA - GV-Security`,
    html: `
      <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 30px;">
        <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-top: 5px solid #0E2041;">
          <h2 style="color: #0E2041; margin-top: 0; font-size: 24px; text-align: center; font-weight: 800;">GV-Security</h2>
          <h3 style="color: #333333; font-size: 18px; margin-bottom: 10px;">${newDevice ? 'Inicio de sesión en un dispositivo nuevo' : 'Autenticación en Dos Pasos (2FA)'}</h3>
          <p style="color: #555555; font-size: 14px; line-height: 1.6;">Hola,</p>
          <p style="color: #555555; font-size: 14px; line-height: 1.6;">${newDevice
            ? `Alguien está iniciando sesión en tu cuenta desde un dispositivo que no reconocemos (<strong>${escapeHtml(device)}</strong>). Si eres tú, usa este código. Al confirmarlo se cerrará la sesión en tu dispositivo anterior.`
            : 'Se ha detectado un intento de inicio de sesión en tu cuenta. Usa el siguiente código de seguridad para confirmar tu acceso:'}</p>
          ${codeBlockHtml(code)}
          <p style="color: #888888; font-size: 13px; text-align: center;">⏱️ Este código es válido durante <strong>10 minutos</strong> y es de un solo uso.</p>
          <hr style="border: none; border-top: 1px solid #eeeeee; margin: 25px 0;" />
          ${newDevice ? '<p style="color: #555555; font-size: 12px; line-height: 1.6;">Tu cuenta es personal: quien la use puede generar códigos QR de ingreso a tu nombre.</p>' : ''}
          <p style="color: #e53e3e; font-size: 12px; text-align: center; margin-bottom: 0;">${newDevice
            ? 'Si no eres tú, no compartas este código con nadie y cambia tu contraseña de inmediato.'
            : 'Si tú no intentaste iniciar sesión, te recomendamos cambiar tu contraseña de inmediato.'}</p>
        </div>
      </div>`
  };
};

/**
 * Aviso al dueño de la cuenta cuando se confirma un dispositivo nuevo: correo y push. El push sale
 * al token guardado, que todavía es el del dispositivo anterior. Sin IP ni ubicación: solo el tipo
 * de dispositivo y la hora. No retrasa la respuesta; los fallos solo se registran.
 */
const notifyNewDeviceLogin = (user, req) => {
  try {
    const device = describeDevice(req.headers['user-agent']);
    const when = new Date().toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'long', timeStyle: 'short' });
    sendMailWithTimeout({
      from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
      to: user.EMAIL,
      subject: 'Nuevo inicio de sesión en tu cuenta de GV-Security',
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 30px;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-top: 5px solid #0E2041;">
            <h2 style="color: #0E2041; margin-top: 0; font-size: 24px; text-align: center; font-weight: 800;">GV-Security</h2>
            <h3 style="color: #333333; font-size: 18px; margin-bottom: 10px;">Nuevo inicio de sesión</h3>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">Hola ${escapeHtml(user.NOMBRE_USUARIO)},</p>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">Se inició sesión en tu cuenta desde un dispositivo nuevo: <strong>${escapeHtml(device)}</strong>, el ${escapeHtml(when)}. Para proteger tu cuenta, cerramos la sesión en el dispositivo anterior.</p>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">Si fuiste tú, no tienes que hacer nada.</p>
            <p style="color: #e53e3e; font-size: 13px; font-weight: bold; line-height: 1.6; margin-bottom: 0;">Si no fuiste tú, cambia tu contraseña de inmediato y avisa a la administración del residencial.</p>
          </div>
        </div>`
    }).catch((mailError) => console.error("Error al enviar el aviso de nuevo inicio de sesión:", mailError.message));

    if (user.FCM_TOKEN) {
      sendPush(user.FCM_TOKEN, {
        title: 'Nuevo inicio de sesión',
        body: `Se inició sesión con tu cuenta en ${device} y se cerró en este dispositivo. Si no fuiste tú, cambia tu contraseña.`,
        link: '/login',
      }).catch((pushError) => console.error("Error al enviar el push de nuevo inicio de sesión:", pushError.message));
    }
  } catch (err) {
    console.error("Error al preparar el aviso de nuevo inicio de sesión:", err.message);
  }
};

const login = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: "Usuario y contraseña son requeridos" });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT * FROM TBL_MS_USUARIO WHERE EMAIL = ?", [username]);
    if (rows.length === 0) return res.status(401).json({ message: "Usuario o contraseña incorrecta" });

    const user = rows[0];

    switch (user.ID_ESTADO_USUARIO) {
      case 2: return res.status(403).json({ message: "Usuario inactivo" });
      case 3: return res.status(403).json({ message: "Usuario bloqueado" });
      case 4: return res.status(403).json({ message: "Usuario Nuevo (Pendiente de activación)" });
      case 5: return res.status(403).json({ message: "Usuario pendiente de verificación" });
    }

    const passwordIsValid = await bcrypt.compare(password, user.CONTRASEÑA);
    if (!passwordIsValid) {
      // Límite de intentos para todos los roles (antes los guardias no tenían ninguno)
      const { blocked } = await registerFailedLogin(connection, req, user, 'intentos fallidos de contraseña al iniciar sesión');
      if (blocked) return res.status(403).json({ message: "Usuario bloqueado por múltiples intentos fallidos" });
      return res.status(401).json({ message: "Usuario o contraseña incorrecta" });
    }

    await connection.query(`UPDATE TBL_MS_USUARIO SET INTENTOS_FALLIDOS = 0, PRIMER_INGRESO = IF(PRIMER_INGRESO IS NULL, NOW(), PRIMER_INGRESO) WHERE EMAIL = ?`, [username]);
    // Si otros intentos simultáneos bloquearon la cuenta mientras se comprobaba esta contraseña, gana el bloqueo
    if (await isAccountDisabled(connection, user.ID_USUARIO)) {
      return res.status(403).json({ message: "Usuario bloqueado" });
    }

    // Sesión única con dispositivo de confianza: el primer dispositivo queda registrado; uno distinto
    // necesita el código del correo (además del 2FA, si está activo). Entrar cierra la sesión anterior.
    const deviceHash = hashDeviceId(req.body.deviceId);
    const isNewDevice = !!user.DISPOSITIVO_ID && deviceHash !== user.DISPOSITIVO_ID;

    if (Number(user.CODIGO_2FA) === 1 || isNewDevice) {
      // Límite de códigos por cuenta: frena la avalancha de correos al dueño si alguien tiene la contraseña
      const codeWait = consumeRateLimit([{ key: `login-code:user:${user.ID_USUARIO}`, max: 5, windowMs: 15 * MINUTE_MS }]);
      if (codeWait) return tooManyRequests(res, codeWait);

      // Todavía NO se entrega la sesión: solo un token de paso que únicamente sirve en /verify-2fa
      // (authenticateToken lo rechaza). La sesión llega al validar el código. `ph` (huella de la
      // contraseña) hace que el token deje de servir si la contraseña cambia mientras tanto.
      const verifyReason = isNewDevice ? 'new_device' : '2fa';
      const token = signPurposeToken('pre2fa', {
        id: user.ID_USUARIO, dev: deviceHash, reason: verifyReason, ph: passwordFingerprint(user.CONTRASEÑA),
      }, PRE2FA_TOKEN_TTL);
      const { code: verificationCode, encrypted: encryptedCode } = generateVerificationPayload(6, 10);

      await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = ? WHERE ID_USUARIO = ?", [encryptedCode, user.ID_USUARIO]);

      const pending = { token, id_usuario: user.ID_USUARIO, role: user.ID_ROL, require2FA: true, verifyReason };
      try {
        await sendMailWithTimeout(loginCodeMail(user.EMAIL, verificationCode, verifyReason, describeDevice(req.headers['user-agent'])));
        return res.status(200).json({
          ...pending,
          message: isNewDevice ? "Confirma este dispositivo con el código enviado a tu correo" : "Código 2FA enviado",
        });
      } catch (mailError) {
        console.error("Error al enviar el código de inicio de sesión:", mailError.message);
        // No bloqueamos el login: devolvemos el token de paso y avisamos al cliente
        return res.status(200).json({
          ...pending,
          emailError: true,
          message: "Código generado pero no se pudo enviar el correo. Contacte al administrador."
        });
      }
    }

    // Dispositivo de confianza (o el primero que se registra): la sesión empieza aquí y cierra cualquier otra.
    // Solo si la contraseña sigue siendo la que se acaba de comprobar (un restablecimiento simultáneo gana).
    const token = await startSession(connection, user, deviceHash, user.CONTRASEÑA);
    if (!token) return res.status(401).json({ message: "Tu contraseña cambió hace un momento. Inicia sesión de nuevo." });
    return res.status(200).json({ token, id_usuario: user.ID_USUARIO, role: user.ID_ROL, require2FA: false, message: "Login exitoso" });
  } catch (err) {
    console.error("Error en login:", err);
    res.status(500).json({ message: "Error interno del servidor" });
  } finally {
    if (connection) connection.release();
  }
};

const verify2FA = async (req, res) => {
  const { codigo } = req.body;
  if (!codigo) return res.status(400).json({ message: "Datos incompletos" });

  // El código solo vale junto con el token de paso que entregó /login al validar la contraseña;
  // el usuario sale de ese token, no del body (así nadie prueba códigos ni bloquea cuentas ajenas).
  const preAuth = verifyPurposeToken('pre2fa', bearerToken(req) || req.body.token);
  if (!preAuth || (req.body.id_usuario && String(req.body.id_usuario) !== String(preAuth.id))) {
    return res.status(401).json({ restartLogin: true, message: "Tu verificación expiró. Inicia sesión de nuevo." });
  }
  const id_usuario = preAuth.id;

  // Límite propio de intentos de código (en memoria, no lo reinicia un login correcto): con la contraseña
  // en la mano no se puede probar códigos sin fin entrando una y otra vez, ni en ráfagas paralelas.
  const wait = consumeRateLimit([{ key: `verify-2fa:user:${id_usuario}`, max: 5, windowMs: 15 * MINUTE_MS }]);
  if (wait) return tooManyRequests(res, wait);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT CODIGO_VERIFICACION, ID_ESTADO_USUARIO, INTENTOS_FALLIDOS, EMAIL, ID_ROL, NOMBRE_USUARIO, FCM_TOKEN, CONTRASEÑA FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [id_usuario]);
    if (rows.length === 0) return res.status(401).json({ message: "Usuario no encontrado" });

    const user = rows[0];
    if (user.ID_ESTADO_USUARIO === 3) return res.status(403).json({ message: "Cuenta bloqueada" });

    // Si la contraseña cambió desde el login (por ejemplo, la restablecieron), el token de paso ya no vale
    if (preAuth.ph !== passwordFingerprint(user.CONTRASEÑA)) {
      return res.status(401).json({ restartLogin: true, message: "Tu verificación expiró. Inicia sesión de nuevo." });
    }

    const validation = validateVerificationCode(String(codigo), user.CODIGO_VERIFICACION);

    if (validation.expired) {
      return res.status(400).json({
        success: false,
        expired: true,
        message: "El código 2FA ha expirado. Por favor solicita uno nuevo con el botón Reenviar."
      });
    }

    if (!validation.valid) {
      const { blocked, attemptsLeft } = await registerFailedLogin(connection, req, { ...user, ID_USUARIO: id_usuario }, 'intentos fallidos del código de verificación');
      if (blocked) return res.status(403).json({ message: "Usuario bloqueado por múltiples intentos fallidos" });

      return res.status(401).json({
        message: "Código incorrecto",
        attemptsLeft
      });
    }

    // Éxito: Resetear intentos y limpiar código para que no pueda ser reutilizado
    await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = NULL, INTENTOS_FALLIDOS = 0, PRIMER_INGRESO_COMPLETADO = 1 WHERE ID_USUARIO = ?", [id_usuario]);
    // Si intentos simultáneos bloquearon la cuenta mientras se validaba este código, gana el bloqueo
    if (await isAccountDisabled(connection, id_usuario)) {
      return res.status(403).json({ message: "Cuenta bloqueada" });
    }

    // Sesión única: la sesión nueva cierra la anterior y este dispositivo queda como el de confianza
    const token = await startSession(connection, { ID_USUARIO: id_usuario, ID_ROL: user.ID_ROL }, preAuth.dev, user.CONTRASEÑA);
    if (!token) return res.status(401).json({ restartLogin: true, message: "Tu verificación expiró. Inicia sesión de nuevo." });
    if (preAuth.reason === 'new_device') notifyNewDeviceLogin(user, req);
    
    res.status(200).json({ 
      success: true, 
      token, 
      id_usuario: id_usuario,
      role: user.ID_ROL,
      require2FA: false,
      redirect: (user.ID_ROL === 1 || user.ID_ROL === 4) ? "/admin" : (user.ID_ROL === 3 ? "/scanner" : "/dashboard"),
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

  const wait = consumeRateLimit([{ key: `verify-register:user:${limitKey(id_usuario)}`, max: 10, windowMs: 15 * MINUTE_MS }]);
  if (wait) return tooManyRequests(res, wait);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(
      "SELECT CODIGO_VERIFICACION, ID_ESTADO_USUARIO, PRIMER_INGRESO_COMPLETADO FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?",
      [id_usuario]
    );
    const user = rows[0];

    // Solo cuentas que esperan verificar su correo: este paso no debe tocar el código de cuentas activas
    if (!user || Number(user.ID_ESTADO_USUARIO) !== 5 || Number(user.PRIMER_INGRESO_COMPLETADO) === 1) {
      return res.status(400).json({ success: false, expired: true, message: "El código no es válido o ya venció. Solicita uno nuevo." });
    }

    const validation = validateVerificationCode(String(codigo), user.CODIGO_VERIFICACION);

    if (validation.expired) {
      return res.status(400).json({
        success: false,
        expired: true,
        message: "El código de verificación ha expirado. Por favor solicita uno nuevo con el botón Reenviar."
      });
    }

    if (!validation.valid) {
      // Cinco intentos por código; después hay que pedir otro
      if (user.CODIGO_VERIFICACION) await registerFailedCodeAttempt(connection, id_usuario, user.CODIGO_VERIFICACION);
      return res.status(401).json({ success: false, message: "Código de verificación incorrecto" });
    }

    // No cambiamos el estado aquí todavía, ya que falta el paso de datos personales.
    // Simplemente validamos el código y lo limpiamos para evitar que sea reutilizado.
    await connection.query(
      "UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = NULL WHERE ID_USUARIO = ?",
      [id_usuario]
    );

    // Permiso para el paso de datos personales: lo usa la app al guardar esos datos
    const registerToken = signPurposeToken('register', { id: Number(id_usuario) }, '60m');
    res.status(200).json({ success: true, registerToken, message: "Código verificado. Proceda a ingresar sus datos personales." });
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
    const [results] = await connection.query(`
      SELECT 
        c.ID_CONDOMINIO, 
        c.DESCRIPCION,
        COALESCE(c.USUARIOS_POR_CASA, 4) AS USUARIOS_POR_CASA,
        (SELECT COUNT(*) 
         FROM TBL_PERSONAS p
         LEFT JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO
         WHERE p.ID_CONDOMINIO = c.ID_CONDOMINIO
           AND (u.ID_ESTADO_USUARIO IS NULL OR u.ID_ESTADO_USUARIO != 2)
           AND (p.ID_ESTADO_PERSONA IS NULL OR p.ID_ESTADO_PERSONA != 2)
        ) AS RESIDENTES_ACTUALES
      FROM TBL_CONDOMINIOS c
      ORDER BY CAST(c.DESCRIPCION AS UNSIGNED) ASC, c.ID_CONDOMINIO ASC
    `);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener condominios" });
  } finally {
    if (connection) connection.release();
  }
};

const savePersonalData = async (req, res) => {
  const id_usuario = req.body.id_usuario || req.body.usuarioId || req.body.ID_USUARIO;
  const dni = req.body.dni || req.body.P_DNI || req.body.DNI_PERSONA;
  const carnet = req.body.carnet || req.body.P_NUM_CARNET_EXTRANJERO || req.body.NUM_CARNET_EXTRANJERO;
  const nationality = req.body.nationality || req.body.P_ID_NACIONALIDAD || req.body.ID_NACIONALIDAD;
  const contactType = req.body.contactType || req.body.P_TIPO_CONTACTO || req.body.ID_TIPO_CONTACTO;
  const contact = req.body.contact || req.body.P_CONTACTO || req.body.CONTACTO;
  const relationship = req.body.relationship || req.body.P_PARENTESCO || req.body.ID_PARENTESCO;
  const condo = req.body.condo || req.body.P_CONDOMINIO || req.body.ID_CONDOMINIO || req.body.id_condominio;

  if (!id_usuario || !nationality || !contactType || !contact || !relationship || !condo) {
    return res.status(400).json({ success: false, error: "Datos incompletos", message: "Todos los campos de datos personales son requeridos" });
  }

  const esHondurena = String(nationality).toLowerCase().includes("hondureña") || String(nationality) === "1";
  if (esHondurena && !dni) return res.status(400).json({ success: false, error: "El DNI es requerido para nacionalidad hondureña", message: "El DNI es requerido para nacionalidad hondureña" });
  if (!esHondurena && !carnet) return res.status(400).json({ success: false, error: "El Carnet es requerido para extranjeros", message: "El Carnet es requerido para extranjeros" });

  // Si la app envía el permiso de verify-registration, debe ser de esta misma cuenta
  const registerPermit = verifyPurposeToken('register', bearerToken(req));
  if (bearerToken(req) && (!registerPermit || String(registerPermit.id) !== String(id_usuario))) {
    return res.status(401).json({ success: false, error: "Verificación vencida", message: "Tu verificación de correo venció. Vuelve a verificar tu correo para continuar." });
  }

  const wait = consumeRateLimit([{ key: `personal-data:ip:${clientInfo(req).ip}`, max: 30, windowMs: 60 * MINUTE_MS }]);
  if (wait) return tooManyRequests(res, wait);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.beginTransaction();

    // 0. Solo la cuenta que está en este paso del registro: estado 5, registro sin completar y correo ya
    //    verificado (sin código pendiente). Antes se aceptaba cualquier id_usuario: cualquiera podía
    //    reescribir los datos de cualquier cuenta y dejarla "pendiente", bloqueando admins y guardias.
    const [userRows] = await connection.query(
      "SELECT NOMBRE_USUARIO, ID_ESTADO_USUARIO, PRIMER_INGRESO_COMPLETADO, CODIGO_VERIFICACION FROM TBL_MS_USUARIO WHERE ID_USUARIO = ? FOR UPDATE",
      [id_usuario]
    );
    const target = userRows[0];
    if (!target || Number(target.ID_ESTADO_USUARIO) !== 5 || Number(target.PRIMER_INGRESO_COMPLETADO) === 1 || target.CODIGO_VERIFICACION) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: "Registro no disponible",
        message: "No se pudieron guardar los datos. Si aún no verificas tu correo, hazlo primero; si ya completaste tu registro, inicia sesión."
      });
    }

    // 1. Validar DNI si es hondureño
    if (esHondurena && dni) {
      const cleanDni = String(dni).replace(/\D/g, '');
      if (cleanDni.length < 4) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: "El DNI debe tener al menos 4 dígitos", message: "El DNI debe tener al menos 4 dígitos" });
      }
      const codigoDNI = cleanDni.substring(0, 4);
      const [codigoResults] = await connection.query("SELECT COUNT(*) as count FROM TBL_CODIGO_DNI WHERE CODIGO = ?", [codigoDNI]);
      if (codigoResults[0].count === 0) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: "Código de DNI inválido", message: "Código de DNI inválido" });
      }
    }

    // 2. Obtener IDs y validar capacidad del condominio
    const [condoResults] = await connection.query(
      "SELECT ID_CONDOMINIO, DESCRIPCION, USUARIOS_POR_CASA FROM TBL_CONDOMINIOS WHERE ID_CONDOMINIO = ? OR DESCRIPCION = ? LIMIT 1",
      [condo, String(condo)]
    );
    if (condoResults.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: "Condominio no encontrado", message: "Condominio no encontrado" });
    }
    const { ID_CONDOMINIO, DESCRIPCION: nombreCondo, USUARIOS_POR_CASA } = condoResults[0];
    const maxPermitidos = Number(USUARIOS_POR_CASA) || 4;

    const [regCount] = await connection.query(
      `SELECT COUNT(*) AS total 
       FROM TBL_PERSONAS p
       LEFT JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO
       WHERE p.ID_CONDOMINIO = ? 
         AND (p.ID_USUARIO IS NULL OR p.ID_USUARIO != ?)
         AND (u.ID_ESTADO_USUARIO IS NULL OR u.ID_ESTADO_USUARIO != 2)
         AND (p.ID_ESTADO_PERSONA IS NULL OR p.ID_ESTADO_PERSONA != 2)`,
      [ID_CONDOMINIO, id_usuario]
    );

    if (regCount[0].total >= maxPermitidos) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: `El condominio ${nombreCondo} ha alcanzado su capacidad máxima permitida (${maxPermitidos} usuarios/residentes). No es posible asignar más usuarios a esta vivienda.`,
        message: `El condominio ${nombreCondo} ha alcanzado su capacidad máxima permitida (${maxPermitidos} usuarios/residentes). No es posible asignar más usuarios a esta vivienda.`
      });
    }

    // 3. Obtener Persona (el usuario ya se validó en el paso 0)
    const [personaRows] = await connection.query("SELECT ID_PERSONA FROM TBL_PERSONAS WHERE ID_USUARIO = ?", [id_usuario]);
    let ID_PERSONA;
    if (personaRows.length === 0) {
      const [insertP] = await connection.query("INSERT INTO TBL_PERSONAS (ID_USUARIO) VALUES (?)", [id_usuario]);
      ID_PERSONA = insertP.insertId;
    } else {
      ID_PERSONA = personaRows[0].ID_PERSONA;
    }

    // 4. Obtener otros IDs (soportando nombres o IDs numéricos)
    let ID_NACIONALIDAD = Number(nationality) || null;
    if (!ID_NACIONALIDAD) {
      const [nacionalidadRows] = await connection.query("SELECT ID_NACIONALIDAD FROM TBL_NACIONALIDADES WHERE NOMBRE_NACIONALIDAD = ?", [nationality]);
      ID_NACIONALIDAD = nacionalidadRows.length > 0 ? nacionalidadRows[0].ID_NACIONALIDAD : 1;
    }

    let ID_TIPO_CONTACTO = Number(contactType) || null;
    if (!ID_TIPO_CONTACTO) {
      const [tipoContRows] = await connection.query("SELECT ID_TIPO_CONTACTO FROM TBL_TIPO_CONTACTO WHERE DESCRIPCION = ?", [contactType]);
      ID_TIPO_CONTACTO = tipoContRows.length > 0 ? tipoContRows[0].ID_TIPO_CONTACTO : 1;
    }

    let ID_PARENTESCO = Number(relationship) || null;
    if (!ID_PARENTESCO) {
      const [parentescoRows] = await connection.query("SELECT ID_PARENTESCO FROM TBL_PARENTESCOS WHERE DESCRIPCION = ?", [relationship]);
      ID_PARENTESCO = parentescoRows.length > 0 ? parentescoRows[0].ID_PARENTESCO : 9;
    }

    // 5. Insertar Contacto
    const [contResult] = await connection.query(
      "INSERT INTO TBL_CONTACTOS (ID_TIPO_CONTACTO, DESCRIPCION) VALUES (?, ?)", 
      [ID_TIPO_CONTACTO, String(contact).trim().toUpperCase()]
    );
    const ID_CONTACTO = contResult.insertId;

    // 6. Verificar si es necesario administrador de la vivienda
    const [adminCheck] = await connection.query("SELECT COUNT(*) AS count FROM TBL_PERSONAS WHERE ID_CONDOMINIO = ? AND ID_PADRE = 1 AND ID_USUARIO != ?", [ID_CONDOMINIO, id_usuario]);
    const isAdminRequired = adminCheck[0].count === 0;

    // 7. Actualizar Persona (Estado 4: Nuevo / Pendiente de aceptación)
    const updateQuery = `
      UPDATE TBL_PERSONAS 
      SET DNI_PERSONA = ?, NUM_CARNET_EXTRANJERO = ?, ID_NACIONALIDAD = ?, ID_CONTACTO = ?, ID_ESTADO_PERSONA = 4, ID_PARENTESCO = ?, ID_CONDOMINIO = ?, ID_PADRE = ?
      WHERE ID_PERSONA = ?`;
    await connection.query(updateQuery, [
      dni ? String(dni).trim().toUpperCase() : null, 
      carnet ? String(carnet).trim().toUpperCase() : null, 
      ID_NACIONALIDAD, 
      ID_CONTACTO, 
      ID_PARENTESCO, 
      ID_CONDOMINIO, 
      isAdminRequired ? 1 : null, 
      ID_PERSONA
    ]);

    // 8. Actualizar Usuario
    await connection.query("UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 4, PRIMER_INGRESO_COMPLETADO = 1 WHERE ID_USUARIO = ?", [id_usuario]);

    await logPersona(connection, req, {
      idPersona: ID_PERSONA,
      accion: ACCION.REGISTRO,
      detalle: `Datos personales registrados en el primer ingreso · Casa ${nombreCondo}${isAdminRequired ? ' · titular de la vivienda' : ''} (pendiente de aprobación)`,
      responsable: userRows[0].NOMBRE_USUARIO,
    });

    await connection.commit();

    // 9. Notificar Administradores (sin bloquear)
    notifyAdmins(userRows[0].NOMBRE_USUARIO, contact, nombreCondo, isAdminRequired, ID_CONDOMINIO, esHondurena, dni, carnet).catch(e => console.error("Error notifyAdmins:", e));

    res.status(200).json({ success: true, message: "Datos guardados correctamente" });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Error en savePersonalData:", err);
    res.status(500).json({ success: false, error: "Error interno", message: "Error interno" });
  } finally {
    if (connection) connection.release();
  }
};

// Función auxiliar para notificaciones (sin bloquear respuesta)
const notifyAdmins = async (nombre, contacto, condo, isNewAdmin, condoId, esHondurena, dni, carnet) => {
  try {
    // 1. Definir los destinatarios
    // Queremos notificar a:
    // a) Admins de la misma vivienda (ID_PADRE = 1)
    // b) Administradores de la residencial (ROL 1 y ROL 4)
    
    const [allAdmins] = await mysqlPool.query(
      `SELECT DISTINCT u.ID_USUARIO, u.EMAIL, u.FCM_TOKEN, u.ID_ROL 
       FROM TBL_MS_USUARIO u 
       LEFT JOIN TBL_PERSONAS p ON u.ID_USUARIO = p.ID_USUARIO 
       WHERE (p.ID_CONDOMINIO = ? AND p.ID_PADRE = 1) 
       OR u.ID_ROL IN (1, 4)`, [condoId]
    );

    if (allAdmins.length === 0) return;

    const asunt = "Nuevo integrante registrado";
    const menj = `Un nuevo integrante se ha registrado en la vivienda: ${condo}. Nombre: ${nombre}, Contacto: ${contacto}`;
    const docInfo = esHondurena ? `DNI: ${dni}` : `Carnet: ${carnet}`;
    // Los datos vienen del formulario de registro: se escapan para que nadie inyecte HTML en el correo oficial
    const fullHtml = `<p>${escapeHtml(menj)}</p><p>${escapeHtml(docInfo)}</p>`;

    // 2. Notificación por Correo (a todos los administradores encontrados). En copia oculta: cada
    //    destinatario no ve los correos de los demás (antes residentes veían los de los administradores).
    const emailList = allAdmins.map(r => r.EMAIL).filter(Boolean);
    if (emailList.length > 0) {
      const senderAddress = process.env.MAIL_FROM_EMAIL || process.env.EMAIL_USER;
      await sendMailWithTimeout({
        from: `"GV-Security" <${process.env.EMAIL_USER}>`,
        ...(senderAddress ? { to: senderAddress, bcc: emailList } : { to: emailList }),
        subject: asunt,
        html: fullHtml
      });
    }

    // 3. Notificación en la App (Sección Alertas) y Push FCM
    const TokensFCM = [];
    
    for (const adminUser of allAdmins) {
      // Insertar registro para que se vea dentro de la App ("Alertas")
      await mysqlPool.query(
        "INSERT INTO TBL_NOTIFICACIONES_APP (ID_USUARIO, TITULO, MENSAJE, FECHA_HORA, LEIDA) VALUES (?, ?, ?, NOW(), 0)",
        [adminUser.ID_USUARIO, `ALERTA: ${asunt}`, menj]
      );

      // Agrupar tokens para mandar Push
      if (adminUser.FCM_TOKEN) {
        TokensFCM.push(adminUser.FCM_TOKEN);
      }
    }

    // 4. Enviar Push vía Firebase Cloud Messaging
    if (TokensFCM.length > 0) {
      sendPush(TokensFCM, { title: `ALERTA: ${asunt}`, body: menj, link: '/notifications' });
    }

  } catch (err) {
    console.error("Error en notifyAdmins:", err);
  }
};

// Respuesta única del reenvío del registro: no revela si la cuenta existe ni a qué correo se envió
const REGISTER_RESEND_MESSAGE = "Si la cuenta está pendiente de verificación, enviamos un código nuevo a su correo.";

const resendVerificationCode = async (req, res) => {
  const { id_usuario, email, type } = req.body;
  if (!id_usuario && !email) {
    return res.status(400).json({ message: "Se requiere ID de usuario o correo electrónico" });
  }

  const is2FA = type === '2fa' || (req.path && req.path.includes('2fa'));

  // El reenvío del segundo paso del login solo vale con el token de paso que entregó /login
  const preAuth = is2FA ? verifyPurposeToken('pre2fa', bearerToken(req)) : null;
  if (is2FA && (!preAuth || (id_usuario && String(id_usuario) !== String(preAuth.id)))) {
    return res.status(401).json({ restartLogin: true, message: "Tu verificación expiró. Inicia sesión de nuevo." });
  }

  // Límite por cuenta pedida, antes de buscarla: así un 429 tampoco revela si la cuenta existe
  const wait = consumeRateLimit([{
    key: is2FA ? `resend-code:2fa:user:${preAuth.id}` : `resend-code:register:${limitKey(id_usuario || normalizeEmail(email))}`,
    max: 5,
    windowMs: 15 * MINUTE_MS,
  }]);
  if (wait) return tooManyRequests(res, wait);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const columns = "ID_USUARIO, NOMBRE_USUARIO, EMAIL, ID_ESTADO_USUARIO, CODIGO_2FA, PRIMER_INGRESO_COMPLETADO";
    const [rows] = is2FA
      ? await connection.query(`SELECT ${columns} FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?`, [preAuth.id])
      : id_usuario
        ? await connection.query(`SELECT ${columns} FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?`, [id_usuario])
        : await connection.query(`SELECT ${columns} FROM TBL_MS_USUARIO WHERE EMAIL = ?`, [email]);
    const user = rows[0];

    if (is2FA) {
      if (!user) return res.status(401).json({ restartLogin: true, message: "Tu verificación expiró. Inicia sesión de nuevo." });
      if (DISABLED_STATES.includes(Number(user.ID_ESTADO_USUARIO))) {
        return res.status(403).json({ message: "Usuario bloqueado. Contacte al administrador." });
      }
    } else {
      // Reenvío del registro: solo cuentas que esperan verificar su correo (estado 5, sin completar); si
      // llegan id y correo, deben coincidir. Antes servía con cualquier cuenta, respondía con su correo y
      // reemplazaba el código de inicio de sesión de cuentas activas.
      const pending = user
        && Number(user.ID_ESTADO_USUARIO) === 5
        && Number(user.PRIMER_INGRESO_COMPLETADO) !== 1
        && (!email || normalizeEmail(email) === normalizeEmail(user.EMAIL));
      if (!pending) return res.status(200).json({ success: true, message: REGISTER_RESEND_MESSAGE, expiresInMinutes: 10 });
    }

    const { code: newCode, encrypted: encryptedCode } = generateVerificationPayload(6, 10);

    await connection.query(
      "UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = ? WHERE ID_USUARIO = ?",
      [encryptedCode, user.ID_USUARIO]
    );

    const newDevice = preAuth?.reason === 'new_device';
    const subject = newDevice
      ? `${newCode} es tu nuevo código para confirmar un dispositivo nuevo - GV-Security`
      : is2FA ? `${newCode} es tu nuevo código 2FA - GV-Security` : `${newCode} es tu nuevo código de verificación - GV-Security`;
    const title = newDevice ? "Inicio de sesión en un dispositivo nuevo" : is2FA ? "Autenticación en Dos Pasos (2FA)" : "Verifica tu correo electrónico";
    const desc = newDevice
      ? "Tu nuevo código para confirmar el inicio de sesión en un dispositivo nuevo es (al confirmarlo se cerrará la sesión en tu dispositivo anterior):"
      : is2FA
        ? "Tu nuevo código de seguridad para acceder a tu cuenta es:"
        : `Hola <strong>${escapeHtml(user.NOMBRE_USUARIO || 'Usuario')}</strong>,<br/>Usa el siguiente nuevo código para completar la verificación de tu cuenta:`;

    const mailOptions = {
      from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
      to: user.EMAIL,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 30px;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-top: 5px solid #0E2041;">
            <h2 style="color: #0E2041; margin-top: 0; font-size: 24px; text-align: center; font-weight: 800;">GV-Security</h2>
            <h3 style="color: #333333; font-size: 18px; margin-bottom: 10px;">${title}</h3>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">${desc}</p>
            ${codeBlockHtml(newCode)}
            <p style="color: #888888; font-size: 13px; text-align: center;">⏱️ Este código es válido durante <strong>10 minutos</strong> y es de un solo uso.</p>
            <hr style="border: none; border-top: 1px solid #eeeeee; margin: 25px 0;" />
            <p style="color: #999999; font-size: 12px; text-align: center; margin-bottom: 0;">Si no solicitaste este código, puedes ignorar este mensaje de forma segura.</p>
          </div>
        </div>
      `
    };

    try {
      await sendMailWithTimeout(mailOptions);
    } catch (mailErr) {
      // Nunca se escribe el código en los registros: quien los lea podría usarlo para entrar
      console.warn("⚠️ Error reenviando correo (SMTP):", mailErr.message);
    }

    return res.status(200).json({
      success: true,
      message: is2FA ? "Te enviamos un código nuevo a tu correo." : REGISTER_RESEND_MESSAGE,
      expiresInMinutes: 10
    });
  } catch (err) {
    console.error("Error en resendVerificationCode:", err);
    res.status(500).json({ message: "Error interno al reenviar el código" });
  } finally {
    if (connection) connection.release();
  }
};

// La ruta exige sesión (authenticateToken): el usuario sale del token, nunca de la URL ni del body.
const get2FAStatus = async (req, res) => {
  const userId = req.user.id;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [results] = await connection.query("SELECT CODIGO_2FA FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [userId]);

    if (results.length > 0) {
      res.json({ enabled: results[0].CODIGO_2FA === 1 ? 1 : 0 });
    } else {
      res.status(404).json({ message: "Usuario no encontrado" });
    }
  } catch (error) {
    res.status(500).json({ message: "Error al consultar estado de 2FA" });
  } finally {
    if (connection) connection.release();
  }
};

// Igual que get2FAStatus: solo el dueño de la sesión cambia su propio 2FA.
const set2FAStatus = async (req, res) => {
  const userId = req.user.id;

  const { enabled } = req.body;
  const enabledNum = (enabled === 1 || enabled === true || enabled === '1') ? 1 : 0;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_2FA = ? WHERE ID_USUARIO = ?", [enabledNum, userId]);
    await logUsuario(connection, req, {
      idUsuario: userId,
      accion: ACCION.MODIFICACION,
      detalle: enabledNum ? 'Activó la verificación en dos pasos (2FA)' : 'Desactivó la verificación en dos pasos (2FA)',
    });

    res.json({ success: true, enabled: enabledNum, message: "Estado de 2FA actualizado correctamente" });
  } catch (error) {
    res.status(500).json({ message: "Error al actualizar estado de 2FA" });
  } finally {
    if (connection) connection.release();
  }
};

const getUserProfile = async (req, res) => {
  const { usuarioId } = req.params;
  if (!canAccessUser(req, usuarioId)) return denyAccess(res);
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
  if (!canAccessUser(req, usuarioId)) return denyAccess(res);
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
  if (!canAccessUser(req, usuarioId)) return denyAccess(res);
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
  if (!canAccessUser(req, usuarioId)) return denyAccess(res);
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
  let connection;
  try {
    connection = await mysqlPool.getConnection();

    const denied = await checkRequestPermission(connection, req, targetUsuarioId);
    if (denied) return res.status(denied.status).json({ success: false, error: denied.message, message: denied.message });

    await connection.beginTransaction();

    // Obtener condominio del usuario a aprobar
    const [userCondo] = await connection.query(`
      SELECT p.ID_CONDOMINIO, c.DESCRIPCION, c.USUARIOS_POR_CASA
      FROM TBL_PERSONAS p
      JOIN TBL_CONDOMINIOS c ON p.ID_CONDOMINIO = c.ID_CONDOMINIO
      WHERE p.ID_USUARIO = ?
    `, [targetUsuarioId]);

    if (userCondo.length > 0 && userCondo[0].ID_CONDOMINIO) {
      const { ID_CONDOMINIO, DESCRIPCION: nombreCondo, USUARIOS_POR_CASA } = userCondo[0];
      const maxCapacidad = Number(USUARIOS_POR_CASA) || 4;

      // Contar usuarios ya activos en ese condominio excluyendo al que se va a aprobar
      const [activeCount] = await connection.query(`
        SELECT COUNT(*) AS total
        FROM TBL_PERSONAS p
        JOIN TBL_MS_USUARIO u ON p.ID_USUARIO = u.ID_USUARIO
        WHERE p.ID_CONDOMINIO = ? 
          AND (u.ID_ESTADO_USUARIO IS NULL OR u.ID_ESTADO_USUARIO != 2)
          AND (p.ID_ESTADO_PERSONA IS NULL OR p.ID_ESTADO_PERSONA != 2)
          AND p.ID_USUARIO != ?
      `, [ID_CONDOMINIO, targetUsuarioId]);

      if (activeCount[0].total >= maxCapacidad) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: `El condominio ${nombreCondo} ya cuenta con el número máximo permitido de usuarios registrados (${maxCapacidad}). No se puede aprobar otro usuario.`,
          message: `El condominio ${nombreCondo} ya cuenta con el número máximo permitido de usuarios registrados (${maxCapacidad}). No se puede aprobar otro usuario.`
        });
      }
    }

    await connection.query(
      'UPDATE TBL_MS_USUARIO SET ID_ESTADO_USUARIO = 1 WHERE ID_USUARIO = ?',
      [targetUsuarioId]
    );
    await connection.query(
      'UPDATE TBL_PERSONAS SET ID_ESTADO_PERSONA = 1 WHERE ID_USUARIO = ?',
      [targetUsuarioId]
    );

    const casaTxt = userCondo.length > 0 && userCondo[0].DESCRIPCION ? ` · Casa ${userCondo[0].DESCRIPCION}` : '';
    await logUsuario(connection, req, { idUsuario: targetUsuarioId, accion: ACCION.APROBACION, detalle: `Solicitud de acceso aprobada; usuario activado${casaTxt}` });
    await logPersona(connection, req, { idUsuario: targetUsuarioId, accion: ACCION.APROBACION, detalle: `Residente aprobado${casaTxt}` });

    await connection.commit();
    res.json({ success: true, message: 'Usuario aprobado con éxito' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error in approveUser:', error);
    res.status(500).json({ success: false, error: 'Error al aprobar usuario', message: 'Error al aprobar usuario' });
  } finally {
    if (connection) connection.release();
  }
};

// Reject and delete user request
const rejectUser = async (req, res) => {
  const { targetUsuarioId } = req.params;
  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // Rechazar BORRA al usuario: solo solicitudes pendientes y solo quien tiene permiso
    const denied = await checkRequestPermission(connection, req, targetUsuarioId);
    if (denied) return res.status(denied.status).json({ message: denied.message });

    await connection.beginTransaction();

    // Fotografía antes de borrar (los logs no tienen FK, sobreviven al DELETE)
    await logPersona(connection, req, { idUsuario: targetUsuarioId, accion: ACCION.RECHAZO, detalle: 'Solicitud de residente rechazada; registro eliminado' });
    await logUsuario(connection, req, { idUsuario: targetUsuarioId, accion: ACCION.RECHAZO, detalle: 'Solicitud de acceso rechazada; usuario eliminado' });

    // Delete from TBL_PERSONAS first due to FK
    await connection.query('DELETE FROM TBL_PERSONAS WHERE ID_USUARIO = ?', [targetUsuarioId]);
    // Delete from TBL_MS_USUARIO
    await connection.query('DELETE FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [targetUsuarioId]);

    await connection.commit();
    res.json({ message: 'Solicitud rechazada y eliminada' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error in rejectUser:', error);
    res.status(500).json({ message: 'Error al rechazar solicitud' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── Recuperación de contraseña ───
// Flujo: forgot-password (código al correo) → verify-reset-code (devuelve resetToken) → reset-password.

const enviarCodigoRecuperacion = async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ message: "El correo es requerido" });
  if (!isSingleEmail(email)) return res.status(400).json({ message: "Correo electrónico inválido" });

  // Los límites se aplican antes de buscar la cuenta, así un 429 no revela si el correo existe
  const wait = consumeRateLimit([
    { key: `reset-request:ip:${clientInfo(req).ip}`, max: 10, windowMs: 15 * MINUTE_MS },
    { key: `reset-request:mail-1m:${limitKey(email)}`, max: 1, windowMs: MINUTE_MS },   // un código por minuto
    { key: `reset-request:mail-1h:${limitKey(email)}`, max: 5, windowMs: 60 * MINUTE_MS }, // y cinco por hora
  ]);
  if (wait) return tooManyRequests(res, wait);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(
      "SELECT ID_USUARIO, NOMBRE_USUARIO, EMAIL, ID_ESTADO_USUARIO FROM TBL_MS_USUARIO WHERE EMAIL = ?",
      [email]
    );
    const user = rows[0];

    // Misma respuesta exista o no la cuenta: no se puede averiguar qué correos están registrados
    if (!user || !RECOVERY_ALLOWED_STATES.includes(Number(user.ID_ESTADO_USUARIO))) {
      return res.json({ success: true, message: RECOVERY_SENT_MESSAGE });
    }

    // Se responde antes de guardar el código y enviar el correo: el tiempo de respuesta tampoco delata
    // si la cuenta existe
    res.json({ success: true, message: RECOVERY_SENT_MESSAGE });

    // Código con vencimiento y de un solo uso; reemplaza a cualquier código anterior
    const { code: verificationCode, encrypted: encryptedCode } = generateVerificationPayload(6, RECOVERY_CODE_MINUTES);
    await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = ? WHERE ID_USUARIO = ?", [encryptedCode, user.ID_USUARIO]);

    sendMailWithTimeout({
      from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
      to: user.EMAIL,
      subject: `${verificationCode} es tu código de recuperación - GV-Security`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 30px;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-top: 5px solid #0E2041;">
            <h2 style="color: #0E2041; margin-top: 0; font-size: 24px; text-align: center; font-weight: 800;">GV-Security</h2>
            <h3 style="color: #333333; font-size: 18px; margin-bottom: 10px;">Restablecer contraseña</h3>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">Hola ${escapeHtml(user.NOMBRE_USUARIO)},</p>
            <p style="color: #555555; font-size: 14px; line-height: 1.6;">Recibimos una solicitud para restablecer la contraseña de tu cuenta. Usa este código para continuar:</p>
            ${codeBlockHtml(verificationCode)}
            <p style="color: #888888; font-size: 13px; text-align: center;">⏱️ Vence en <strong>${RECOVERY_CODE_MINUTES} minutos</strong> y solo se puede usar una vez.</p>
            <hr style="border: none; border-top: 1px solid #eeeeee; margin: 25px 0;" />
            <p style="color: #555555; font-size: 12px; line-height: 1.6;">Nunca compartas este código: el personal de GV-Security no te lo pedirá por teléfono ni por mensaje.</p>
            <p style="color: #e53e3e; font-size: 12px; margin-bottom: 0;">Si no lo solicitaste, ignora este correo: tu contraseña no cambiará.</p>
          </div>
        </div>`
    }).catch((mailError) => console.error("Error al enviar el código de recuperación:", mailError.message));
  } catch (error) {
    console.error("Error in enviarCodigoRecuperacion:", error);
    if (!res.headersSent) res.status(500).json({ message: "No se pudo procesar la solicitud. Intenta de nuevo." });
  } finally {
    if (connection) connection.release();
  }
};

const verificarCodigoRecuperacion = async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { codigo } = req.body;
  if (!email || !codigo) return res.status(400).json({ message: "Datos incompletos" });
  if (!isSingleEmail(email)) return res.status(400).json({ expired: true, message: RECOVERY_INVALID_CODE_MESSAGE });

  // Por IP y por cuenta pedida (exista o no). El límite por cuenta es síncrono, así que tampoco se
  // puede exceder con intentos en paralelo (el contador dentro del código no es atómico).
  const wait = consumeRateLimit([
    { key: `reset-verify:ip:${clientInfo(req).ip}`, max: 20, windowMs: 15 * MINUTE_MS },
    { key: `reset-verify:mail:${limitKey(email)}`, max: 5, windowMs: 15 * MINUTE_MS },
  ]);
  if (wait) return tooManyRequests(res, wait);

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query(
      "SELECT ID_USUARIO, ID_ESTADO_USUARIO, CODIGO_VERIFICACION, CONTRASEÑA FROM TBL_MS_USUARIO WHERE EMAIL = ?",
      [email]
    );
    const user = rows[0];
    const stored = user && RECOVERY_ALLOWED_STATES.includes(Number(user.ID_ESTADO_USUARIO)) ? user.CODIGO_VERIFICACION : null;

    // Sin cuenta, sin código activo, vencido, del formato viejo (que no vencía) o incorrecto: la misma
    // respuesta en todos los casos, para que tampoco aquí se pueda saber si un correo está registrado
    const validation = stored ? validateVerificationCode(String(codigo), stored) : null;
    if (!validation || validation.expired || validation.legacy || !validation.valid) {
      // Un código incorrecto igual suma su intento: a los cinco se anula
      if (validation && !validation.expired && !validation.legacy) {
        await registerFailedCodeAttempt(connection, user.ID_USUARIO, stored);
      }
      return res.status(400).json({ expired: true, message: RECOVERY_INVALID_CODE_MESSAGE });
    }

    // El código se consume aquí; para cambiar la contraseña se usa el token de restablecimiento
    // (vence pronto y deja de servir en cuanto la contraseña cambia).
    await connection.query("UPDATE TBL_MS_USUARIO SET CODIGO_VERIFICACION = NULL WHERE ID_USUARIO = ?", [user.ID_USUARIO]);
    const resetToken = signPurposeToken('pwdReset', { id: user.ID_USUARIO, ph: passwordFingerprint(user.CONTRASEÑA) }, RESET_TOKEN_TTL);

    res.json({ success: true, message: "Código verificado correctamente", resetToken });
  } catch (error) {
    console.error("Error in verificarCodigoRecuperacion:", error);
    res.status(500).json({ message: "Error al verificar el código" });
  } finally {
    if (connection) connection.release();
  }
};

// Helper de validación de seguridad para contraseñas
const validatePasswordSecurity = (password, userDetails = {}) => {
  if (!password || typeof password !== 'string') {
    return 'La contraseña es obligatoria.';
  }
  if (password.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres.';
  }
  if (password.length > 30) {
    return 'La contraseña no puede exceder los 30 caracteres.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'La contraseña debe incluir al menos una letra mayúscula (A-Z).';
  }
  if (!/[a-z]/.test(password)) {
    return 'La contraseña debe incluir al menos una letra minúscula (a-z).';
  }
  if (!/[0-9]/.test(password)) {
    return 'La contraseña debe incluir al menos un número (0-9).';
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return 'La contraseña debe incluir al menos un carácter especial (ej. !@#$%^&*).';
  }
  if (/\s/.test(password)) {
    return 'La contraseña no debe contener espacios en blanco.';
  }

  if (userDetails.NOMBRE_USUARIO) {
    const parts = userDetails.NOMBRE_USUARIO.toLowerCase().split(/\s+/).filter(p => p.length >= 4);
    for (const part of parts) {
      if (password.toLowerCase().includes(part)) {
        return 'Por seguridad, la contraseña no debe contener tu nombre de usuario.';
      }
    }
  }

  if (userDetails.EMAIL) {
    const emailPrefix = userDetails.EMAIL.split('@')[0].toLowerCase();
    if (emailPrefix.length >= 4 && password.toLowerCase().includes(emailPrefix)) {
      return 'Por seguridad, la contraseña no debe contener partes de tu correo electrónico.';
    }
  }

  return null;
};

/**
 * Aviso de seguridad tras restablecer ('reset') o cambiar ('change') la contraseña: correo con fecha,
 * IP y navegador, y push al teléfono si tiene notificaciones. No retrasa la respuesta; los fallos solo se registran.
 */
const notifyPasswordChanged = (user, req, reason = 'reset') => {
  // Se llama después de responder: nada de aquí puede terminar en un segundo res.json
  try {
  const how = reason === 'change'
    ? 'La contraseña de tu cuenta se cambió desde la app, con tu sesión iniciada.'
    : 'La contraseña de tu cuenta se restableció con un código enviado a este correo.';
  const risk = reason === 'change' ? 'alguien podría haber entrado a tu cuenta' : 'alguien podría tener acceso a tu correo';
  const { ip, navegador } = clientInfo(req);
  const when = new Date().toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'long', timeStyle: 'short' });
  const row = (label, value) => `
    <tr>
      <td style="padding: 6px 10px; color: #888888; white-space: nowrap; vertical-align: top;">${label}</td>
      <td style="padding: 6px 10px; color: #333333;">${escapeHtml(value)}</td>
    </tr>`;

  sendMailWithTimeout({
    from: `"GV-Security Support" <${process.env.EMAIL_USER}>`,
    to: user.EMAIL,
    subject: 'Tu contraseña de GV-Security fue cambiada',
    html: `
      <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 30px;">
        <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-top: 5px solid #0E2041;">
          <h2 style="color: #0E2041; margin-top: 0; font-size: 24px; text-align: center; font-weight: 800;">GV-Security</h2>
          <h3 style="color: #333333; font-size: 18px; margin-bottom: 10px;">Tu contraseña fue cambiada</h3>
          <p style="color: #555555; font-size: 14px; line-height: 1.6;">Hola ${escapeHtml(user.NOMBRE_USUARIO)},</p>
          <p style="color: #555555; font-size: 14px; line-height: 1.6;">${how}</p>
          <table style="width: 100%; font-size: 13px; background-color: #f8f9fb; border-radius: 8px; margin: 20px 0; border-collapse: collapse;">
            ${row('Fecha', when)}
            ${row('Dirección IP', ip)}
            ${row('Navegador', String(navegador).slice(0, 150))}
          </table>
          <p style="color: #e53e3e; font-size: 13px; font-weight: bold; line-height: 1.6; margin-bottom: 0;">Si no fuiste tú, contacta de inmediato a la administración del residencial: ${risk}.</p>
        </div>
      </div>`
  }).catch((mailError) => console.error("Error al enviar el aviso de cambio de contraseña:", mailError.message));

  if (user.FCM_TOKEN) {
    sendPush(user.FCM_TOKEN, {
      title: 'Contraseña actualizada',
      body: 'Se cambió la contraseña de tu cuenta. Si no fuiste tú, contacta a la administración de inmediato.',
      link: '/login',
    }).catch((pushError) => console.error("Error al enviar el push de cambio de contraseña:", pushError.message));
  }
  } catch (err) {
    console.error("Error al preparar el aviso de cambio de contraseña:", err.message);
  }
};

const actualizarContrasena = async (req, res) => {
  const { nuevaContrasena } = req.body;

  const wait = consumeRateLimit([{ key: `reset-save:ip:${clientInfo(req).ip}`, max: 15, windowMs: 15 * MINUTE_MS }]);
  if (wait) return tooManyRequests(res, wait);

  // Solo con el token que entrega verify-reset-code tras validar el código del correo;
  // el usuario sale de ese token (antes bastaba con enviar cualquier id_usuario).
  const reset = verifyPurposeToken('pwdReset', req.body.resetToken || bearerToken(req));
  if (!reset || (req.body.id_usuario && String(req.body.id_usuario) !== String(reset.id))) {
    return res.status(401).json({ success: false, message: "Tu verificación expiró o no es válida. Solicita un nuevo código." });
  }
  if (!nuevaContrasena) return res.status(400).json({ success: false, message: "Datos incompletos" });
  const id_usuario = reset.id;

  let connection;
  try {
    connection = await mysqlPool.getConnection();

    const [rows] = await connection.query(
      "SELECT ID_USUARIO, NOMBRE_USUARIO, EMAIL, CONTRASEÑA, ID_ESTADO_USUARIO, FCM_TOKEN FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?",
      [id_usuario]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Usuario no encontrado" });

    const user = rows[0];

    // Un solo uso: si la contraseña ya cambió desde que se validó el código, el token no sirve
    if (reset.ph !== passwordFingerprint(user.CONTRASEÑA)) {
      return res.status(401).json({ success: false, message: "Esta verificación ya se usó. Solicita un nuevo código." });
    }
    // La cuenta pudo darse de baja mientras tanto
    if (!RECOVERY_ALLOWED_STATES.includes(Number(user.ID_ESTADO_USUARIO))) {
      return res.status(403).json({ success: false, message: "Tu cuenta no está activa. Contacta a la administración." });
    }

    const securityError = validatePasswordSecurity(nuevaContrasena, {
      NOMBRE_USUARIO: user.NOMBRE_USUARIO,
      EMAIL: user.EMAIL
    });
    if (securityError) {
      return res.status(400).json({ success: false, message: securityError });
    }

    if (user.CONTRASEÑA) {
      const isSameAsCurrent = await bcrypt.compare(nuevaContrasena, user.CONTRASEÑA);
      if (isSameAsCurrent) {
        return res.status(400).json({ success: false, message: "No puedes reutilizar tu contraseña anterior." });
      }
    }

    const [historyRows] = await connection.query(
      "SELECT ID_HIST, CONTRASEÑA FROM TBL_MS_HIST_CONTRASEÑA WHERE ID_USUARIO = ? ORDER BY ID_HIST DESC",
      [id_usuario]
    );

    for (const hist of historyRows) {
      const isReused = await bcrypt.compare(nuevaContrasena, hist.CONTRASEÑA);
      if (isReused) {
        return res.status(400).json({
          success: false,
          message: "No puedes reutilizar una contraseña usada anteriormente."
        });
      }
    }

    // Contraseñas expuestas en filtraciones públicas (si el servicio no responde, no se bloquea)
    if (await isPasswordBreached(nuevaContrasena)) {
      return res.status(400).json({
        success: false,
        message: "Esta contraseña aparece en filtraciones de datos públicas y es fácil de adivinar. Elige otra."
      });
    }

    await connection.beginTransaction();

    if (user.CONTRASEÑA) {
      await connection.query(
        "INSERT INTO TBL_MS_HIST_CONTRASEÑA (ID_USUARIO, CONTRASEÑA) VALUES (?, ?)",
        [id_usuario, user.CONTRASEÑA]
      );
    }

    const hashedPassword = await bcrypt.hash(nuevaContrasena, 10);
    
    // SESION_ID = NULL: la sesión abierta en cualquier dispositivo se cierra con el cambio. FCM_TOKEN = NULL:
    // ese dispositivo tampoco sigue recibiendo notificaciones (el aviso del cambio usa el token leído antes)
    await connection.query(
      "UPDATE TBL_MS_USUARIO SET CONTRASEÑA = ?, CODIGO_VERIFICACION = NULL, INTENTOS_FALLIDOS = 0, SESION_ID = NULL, FCM_TOKEN = NULL WHERE ID_USUARIO = ?",
      [hashedPassword, id_usuario]
    );

    await logContrasena(connection, req, {
      idUsuario: id_usuario,
      accion: ACCION.RESTABLECIMIENTO,
      detalle: 'Contraseña restablecida con código de recuperación enviado al correo',
      responsable: user.NOMBRE_USUARIO,
    });

    await connection.commit();
    forgetSession(id_usuario);
    res.json({
      success: true,
      message: "Contraseña actualizada exitosamente",
      // Un bloqueo de la cuenta se mantiene: lo levanta la administración
      accountBlocked: Number(user.ID_ESTADO_USUARIO) === 3,
      sessionsClosed: true,
    });
    notifyPasswordChanged(user, req);
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in actualizarContrasena:", error);
    res.status(500).json({ success: false, message: "Error al actualizar la contraseña" });
  } finally {
    if (connection) connection.release();
  }
};

// La ruta exige sesión: el usuario sale del token. Antes bastaba un id_usuario en el body y se
// podían probar contraseñas sin límite, saltándose el bloqueo del login.
const changePassword = async (req, res) => {
  const id_usuario = req.user.id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: "Todos los campos son requeridos." });
  }

  const wait = consumeRateLimit([{ key: `change-pwd:user:${id_usuario}`, max: 10, windowMs: 15 * MINUTE_MS }]);
  if (wait) return tooManyRequests(res, wait);

  if (currentPassword === newPassword) {
    return res.status(400).json({ 
      success: false, 
      message: "La nueva contraseña no puede ser igual a la contraseña actual." 
    });
  }

  let connection;
  try {
    connection = await mysqlPool.getConnection();

    // 1. Obtener datos del usuario
    const [rows] = await connection.query(
      "SELECT ID_USUARIO, NOMBRE_USUARIO, EMAIL, CONTRASEÑA, ID_ESTADO_USUARIO, FCM_TOKEN FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?",
      [id_usuario]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }

    const user = rows[0];

    if (user.ID_ESTADO_USUARIO === 3) {
      return res.status(403).json({ success: false, message: "Tu usuario se encuentra bloqueado. Contacta al administrador." });
    }

    // 2. Validar contraseña actual con bcrypt
    const passwordIsValid = await bcrypt.compare(currentPassword, user.CONTRASEÑA);
    if (!passwordIsValid) {
      return res.status(401).json({ success: false, message: "La contraseña actual es incorrecta." });
    }

    // 3. Validaciones de seguridad y complejidad
    const securityError = validatePasswordSecurity(newPassword, {
      NOMBRE_USUARIO: user.NOMBRE_USUARIO,
      EMAIL: user.EMAIL
    });
    if (securityError) {
      return res.status(400).json({ success: false, message: securityError });
    }

    // 4. Validar que la nueva contraseña no coincida con el hash de la contraseña actual
    const isSameAsCurrent = await bcrypt.compare(newPassword, user.CONTRASEÑA);
    if (isSameAsCurrent) {
      return res.status(400).json({ 
        success: false, 
        message: "No puedes reutilizar tu contraseña actual. Por favor ingresa una diferente." 
      });
    }

    // 5. Validar que no se haya usado en el historial (TBL_MS_HIST_CONTRASEÑA)
    const [historyRows] = await connection.query(
      "SELECT ID_HIST, CONTRASEÑA FROM TBL_MS_HIST_CONTRASEÑA WHERE ID_USUARIO = ? ORDER BY ID_HIST DESC",
      [id_usuario]
    );

    for (const hist of historyRows) {
      const isReused = await bcrypt.compare(newPassword, hist.CONTRASEÑA);
      if (isReused) {
        return res.status(400).json({ 
          success: false, 
          message: "No puedes reutilizar una contraseña usada anteriormente. Por motivos de seguridad, elige una contraseña diferente."
        });
      }
    }

    // Contraseñas expuestas en filtraciones públicas (si el servicio no responde, no se bloquea)
    if (await isPasswordBreached(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "Esta contraseña aparece en filtraciones de datos públicas y es fácil de adivinar. Elige otra."
      });
    }

    // 6. Iniciar transacción para actualizar y registrar historial
    await connection.beginTransaction();

    // Guardar la contraseña anterior en el historial
    await connection.query(
      "INSERT INTO TBL_MS_HIST_CONTRASEÑA (ID_USUARIO, CONTRASEÑA) VALUES (?, ?)",
      [id_usuario, user.CONTRASEÑA]
    );

    // Mantener un historial máximo de 5 contraseñas anteriores
    const [allHistory] = await connection.query(
      "SELECT ID_HIST, CONTRASEÑA FROM TBL_MS_HIST_CONTRASEÑA WHERE ID_USUARIO = ? ORDER BY ID_HIST DESC",
      [id_usuario]
    );

    const MAX_HISTORIAL = 5;
    if (allHistory.length > MAX_HISTORIAL) {
      const toRemove = allHistory.slice(MAX_HISTORIAL);

      for (const oldItem of toRemove) {
        await logContrasena(connection, req, {
          idUsuario: id_usuario,
          idHist: oldItem.ID_HIST,
          hash: oldItem.CONTRASEÑA,
          accion: ACCION.DEPURACION,
          detalle: `Se depuró una contraseña antigua del historial (se conservan las últimas ${MAX_HISTORIAL})`,
          responsable: user.NOMBRE_USUARIO || 'Sistema',
        });

        await connection.query("DELETE FROM TBL_MS_HIST_CONTRASEÑA WHERE ID_HIST = ?", [oldItem.ID_HIST]);
      }
    }

    // Obtener días de vencimiento de los parámetros del sistema
    const [paramRows] = await connection.query(
      "SELECT VALOR FROM TBL_MS_PARAMETROS WHERE PARAMETRO = 'FECHA_VENCIMIENTO'"
    );
    const diasVencimiento = (paramRows.length > 0 && !isNaN(parseInt(paramRows[0].VALOR, 10))) 
      ? parseInt(paramRows[0].VALOR, 10) 
      : 90;

    // Hashear la nueva contraseña
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Actualizar usuario
    await connection.query(
      `UPDATE TBL_MS_USUARIO 
       SET CONTRASEÑA = ?, 
           FECHA_VENCIMIENTO = DATE_ADD(NOW(), INTERVAL ? DAY), 
           INTENTOS_FALLIDOS = 0 
       WHERE ID_USUARIO = ?`,
      [hashedNewPassword, diasVencimiento, id_usuario]
    );

    await logContrasena(connection, req, {
      idUsuario: id_usuario,
      accion: ACCION.CAMBIO_CONTRASENA,
      detalle: `El usuario cambió su contraseña; nueva vigencia de ${diasVencimiento} días`,
      responsable: user.NOMBRE_USUARIO,
    });

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "¡Contraseña actualizada exitosamente!"
    });
    notifyPasswordChanged(user, req, 'change');
    return;

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in changePassword:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor al actualizar la contraseña." });
  } finally {
    if (connection) connection.release();
  }
};

// Notificaciones push: las rutas exigen sesión y el usuario sale de ella (antes se confiaba en el
// id_usuario enviado, y cualquiera podía desviar a su teléfono las notificaciones de otra persona).
const saveFCMToken = async (req, res) => {
  const id_usuario = req.user.id;
  const { fcm_token } = req.body;

  const tokenVal = (!fcm_token || fcm_token === 'DISABLED') ? null : String(fcm_token).trim();

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [result] = await connection.query("UPDATE TBL_MS_USUARIO SET FCM_TOKEN = ? WHERE ID_USUARIO = ?", [tokenVal, id_usuario]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }

    res.json({ success: true, enabled: !!tokenVal, message: tokenVal ? "Token FCM guardado correctamente" : "Token FCM eliminado" });
  } catch (error) {
    console.error("[FCM] Error al actualizar token:", error);
    res.status(500).json({ message: "Error al guardar el token" });
  } finally {
    if (connection) connection.release();
  }
};

const getPushStatus = async (req, res) => {
  // El :usuarioId de la URL se conserva por compatibilidad, pero solo se consulta el de la sesión
  const usuarioId = req.user.id;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const [rows] = await connection.query("SELECT FCM_TOKEN FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?", [usuarioId]);
    if (rows.length === 0) return res.status(404).json({ message: "Usuario no encontrado" });
    
    const token = rows[0].FCM_TOKEN;
    const isEnabled = !!token && token !== 'DISABLED' && token.trim().length > 10;
    res.json({ success: true, enabled: isEnabled, serverReady: isPushReady() });
  } catch (error) {
    console.error("Error al obtener estado push:", error);
    res.status(500).json({ message: "Error al consultar estado push" });
  } finally {
    if (connection) connection.release();
  }
};

const setPushStatus = async (req, res) => {
  const id_usuario = req.user.id;
  const { enabled, fcm_token } = req.body;

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const tokenVal = (enabled && fcm_token && fcm_token !== 'DISABLED') ? String(fcm_token).trim() : null;
    await connection.query("UPDATE TBL_MS_USUARIO SET FCM_TOKEN = ? WHERE ID_USUARIO = ?", [tokenVal, id_usuario]);
    res.json({ success: true, enabled: !!tokenVal });
  } catch (error) {
    console.error("Error al actualizar estado push:", error);
    res.status(500).json({ message: "Error al actualizar estado de notificaciones push" });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Envía una notificación push de prueba al usuario autenticado (botón en Configuración).
 */
const sendTestPush = async (req, res) => {
  const userId = req.user && req.user.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Sesión no válida.' });
  if (!isPushReady()) {
    return res.status(503).json({ success: false, message: 'El servidor no tiene configurado Firebase: ' + (getPushInitError() || 'sin credenciales') });
  }
  try {
    const [rows] = await mysqlPool.query('SELECT FCM_TOKEN FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?', [userId]);
    const token = rows[0] && rows[0].FCM_TOKEN;
    if (!token) return res.status(400).json({ success: false, message: 'Este usuario no tiene notificaciones push activadas.' });

    const result = await sendPush(token, {
      title: 'GV-Security: prueba de notificación',
      body: 'Si ves este mensaje, las notificaciones push funcionan correctamente en este dispositivo.',
      link: '/settings'
    });
    if (result.successCount > 0) return res.json({ success: true, message: 'Notificación de prueba enviada.' });
    const code = result.errors[0] || 'desconocido';
    const expired = /not-registered|invalid-registration|invalid-argument/.test(code);
    return res.status(expired ? 410 : 502).json({
      success: false,
      expired,
      message: expired
        ? 'El registro de este dispositivo venció. Vuelva a activar las notificaciones.'
        : 'Firebase no pudo entregar la notificación (' + code + ').'
    });
  } catch (error) {
    console.error('Error en notificación de prueba:', error);
    res.status(500).json({ success: false, message: 'Error al enviar la notificación de prueba.' });
  }
};

/** Cierra la sesión actual en el servidor: el token deja de servir aunque alguien lo haya copiado. */
const logout = async (req, res) => {
  try {
    await endSession(req.user.id, req.user.sid);
    res.json({ success: true, message: "Sesión cerrada" });
  } catch (error) {
    console.error("Error al cerrar sesión:", error);
    res.status(500).json({ success: false, message: "No se pudo cerrar la sesión" });
  }
};

/** Confirma que la sesión sigue vigente (authenticateToken ya lo validó); la app lo consulta al volver a primer plano. */
const sessionStatus = (req, res) => res.json({ success: true });

module.exports = {
  register,
  login,
  logout,
  sessionStatus,
  verify2FA,
  verifyRegistration,
  resendVerificationCode,
  enviarCodigoRecuperacion,
  verificarCodigoRecuperacion,
  actualizarContrasena,
  getNationalities,
  getContactTypes,
  getRelationships,
  getCondos,
  savePersonalData,
  get2FAStatus,
  set2FAStatus,
  getUserProfile,
  getFamilyMembers,
  getCondominiumDetails,
  getPendingUsers,
  approveUser,
  rejectUser,
  changePassword,
  saveFCMToken,
  getPushStatus,
  setPushStatus,
  sendTestPush
};
