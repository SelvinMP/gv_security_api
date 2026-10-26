const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateToken, requireRole, requireSuperAdmin } = require('../middlewares/authMiddleware');

// Todas las rutas requieren token y rol de Super Admin (1) o Admin (4)
router.use(authenticateToken);
router.use(requireRole(1, 4));

// 1. Estadísticas y métricas generales del Dashboard
router.get('/stats', adminController.getDashboardStats);

// 2. Configuración y lectura de Geocerca (Lectura para 1 y 4)
router.get('/geocerca', adminController.getGeocercaConfig);

// 3. Modificación de Geocerca (¡SOLO SUPER ADMINISTRADOR = 1!)
router.put('/geocerca', requireSuperAdmin, adminController.updateGeocercaConfig);

// 4. Tablas de mantenimiento (Lectura)
router.get('/maintenance/:table', adminController.getMaintenanceTable);

// 5. Tablas de mantenimiento (Actualización de registros)
router.put('/maintenance/:table/:id', adminController.updateMaintenanceRecord);

module.exports = router;
