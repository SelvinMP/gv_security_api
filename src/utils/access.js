// ─── Permisos sobre datos de usuarios (compartido por los controladores) ───
const ADMIN_ROLES = [1, 4]; // 1: Super Admin, 4: Administrador

const isAdminRequest = (req) => ADMIN_ROLES.includes(Number(req.user?.role));

/** Cada usuario consulta solo sus propios datos; los administradores, los de cualquiera. */
const canAccessUser = (req, usuarioId) => isAdminRequest(req) || String(req.user?.id) === String(usuarioId);

const denyAccess = (res) => res.status(403).json({ message: "No tienes permiso para consultar estos datos." });

module.exports = { ADMIN_ROLES, isAdminRequest, canAccessUser, denyAccess };
