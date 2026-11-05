const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateToken, requireRole, requireSuperAdmin } = require('../middlewares/authMiddleware');

// Todas las rutas requieren token y rol de Super Admin (1) o Admin (4)
router.use(authenticateToken);
router.use(requireRole(1, 4));

// 1. Estadísticas y métricas generales del Dashboard (con áreas comunes reales)
router.get('/stats', adminController.getDashboardStats);

// 2. Configuración y lectura de Geocerca (Lectura para 1 y 4)
router.get('/geocerca', adminController.getGeocercaConfig);

// 3. Geocercas / Portones de entrada (¡SOLO SUPER ADMINISTRADOR = 1!)
router.put('/geocerca/parametros', requireSuperAdmin, adminController.updateGeocercaParams); // Parámetros globales
router.put('/geocerca', requireSuperAdmin, adminController.updateGeocercaConfig);              // Crear (sin id) o actualizar (con id) una entrada
router.post('/geocerca', requireSuperAdmin, adminController.updateGeocercaConfig);             // Crear nueva entrada
router.delete('/geocerca/:id', requireSuperAdmin, adminController.deleteGeocerca);             // Eliminar entrada

// 4. Opciones de listas maestras para formularios de modales CRUD (roles, estados, condominios, instalaciones)
router.get('/form-options', adminController.getFormOptions);

// 5. Tablas de mantenimiento (Lectura)
router.get('/maintenance/:table', adminController.getMaintenanceTable);

// 6. Tablas de mantenimiento (Creación - INSERT)
router.post('/maintenance/:table', adminController.createMaintenanceRecord);

// 7. Tablas de mantenimiento (Actualización - UPDATE)
router.put('/maintenance/:table/:id', adminController.updateMaintenanceRecord);

// 8. Tablas de mantenimiento (Eliminación - DELETE)
router.delete('/maintenance/:table/:id', adminController.deleteMaintenanceRecord);

const { uploadAnuncio } = require('../config/upload');

// 9. Respaldo integral de la base de datos (¡SOLO SUPER ADMINISTRADOR = 1!)
router.get('/backup/summary', requireSuperAdmin, adminController.getDatabaseBackupSummary);
router.get('/backup', requireSuperAdmin, adminController.downloadDatabaseBackup);

// 10. Gestión de Notificaciones Push y Anuncios
router.post('/anuncios/upload', uploadAnuncio.single('imagen'), adminController.uploadAnnouncementImage);
router.post('/notificaciones/enviar', adminController.sendPushNotificationAndAnnouncement);
router.get('/anuncios', adminController.getAnnouncementsList);
router.delete('/anuncios/:id', adminController.deleteAnnouncement);

// 11. Reportes por número de casa (paquetes y QR múltiples)
const reportController = require('../controllers/reportController');
router.get('/reportes/paquetes', reportController.getPackagesReport);
router.get('/reportes/eventos', reportController.getEventsReport);

// 12. Solicitudes de residentes (Administración / Junta Directiva)
const requestController = require('../controllers/requestController');
router.get('/solicitudes', requestController.adminListRequests);
router.post('/solicitudes', requestController.createRequest);
router.get('/solicitudes/:id', requestController.adminGetRequest);
router.put('/solicitudes/:id', requestController.adminUpdateRequest);

module.exports = router;


