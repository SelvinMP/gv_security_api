const jwt = require('jsonwebtoken');
require('dotenv').config();
const { sessionProblem, SESSION_ERRORS } = require('../utils/sessions');

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

/**
 * Middleware para verificar JWT en solicitudes HTTP.
 * Extrae id y role del token y los asigna a req.user.
 * Además exige que el token sea el de la sesión vigente del usuario (una sola sesión por cuenta):
 * si se inició sesión en otro dispositivo o se cerró, responde 401 con un `code` que la app reconoce.
 */
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : (req.query.token || null);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Acceso no autorizado. Token no proporcionado.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SECRET_KEY);
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token inválido o expirado.' });
  }

  try {
    const problem = await sessionProblem(decoded);
    if (problem) {
      return res.status(401).json({ success: false, code: problem, message: SESSION_ERRORS[problem] });
    }
  } catch (err) {
    console.error('[sesión] No se pudo validar la sesión:', err.message);
    return res.status(503).json({ success: false, message: 'No se pudo validar la sesión. Intenta de nuevo.' });
  }

  req.user = decoded;
  next();
};

/**
 * Middleware para verificar que el usuario tenga uno de los roles permitidos.
 * 1: SUPER ADMINISTRADOR
 * 2: RESIDENTE / USUARIO
 * 3: GUARDIA
 * 4: ADMINISTRADOR
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, message: 'Rol de usuario no identificado.' });
    }

    if (!allowedRoles.includes(Number(req.user.role))) {
      return res.status(403).json({ 
        success: false, 
        message: 'No tienes permisos suficientes para realizar esta acción.' 
      });
    }

    next();
  };
};

/**
 * Solo para Super Administrador (ID_ROL = 1)
 */
const requireSuperAdmin = (req, res, next) => {
  if (!req.user || Number(req.user.role) !== 1) {
    return res.status(403).json({ 
      success: false, 
      message: 'Acceso denegado: Esta función está reservada exclusivamente para el Super Administrador.' 
    });
  }
  next();
};

module.exports = {
  authenticateToken,
  requireRole,
  requireSuperAdmin
};
