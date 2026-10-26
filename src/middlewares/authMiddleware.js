const jwt = require('jsonwebtoken');
require('dotenv').config();

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

/**
 * Middleware para verificar JWT en solicitudes HTTP.
 * Extrae id y role del token y los asigna a req.user.
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') 
    ? authHeader.split(' ')[1] 
    : (req.query.token || null);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Acceso no autorizado. Token no proporcionado.' });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token inválido o expirado.' });
  }
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
