const express = require('express');
const router = express.Router();
const visitorController = require('../controllers/visitorController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');

// Todas las rutas de visitas exigen la sesión vigente: una sesión cerrada (por ejemplo, porque se
// entró con la cuenta en otro dispositivo) ya no puede generar, reactivar ni consultar códigos QR.
// El controlador valida además que cada visita sea del usuario de la sesión.
router.use(authenticateToken);

// Carnet QR cifrado del residente (debe ir antes de '/:type/:id')
router.get('/resident-qr', visitorController.getResidentQR);
router.post('/registrar_visitas', visitorController.registerVisit);
router.post('/validateQR', requireRole(1, 3, 4), visitorController.validateQR);
router.get('/history/:usuarioId', visitorController.getVisitorHistory);
// Cancelar visita (debe ir antes de '/:type/:id')
router.post('/cancel/:type/:id', visitorController.cancelVisit);
router.delete('/:type/:id', visitorController.deleteVisitor);
router.get('/recurrent-summary/:usuarioId', visitorController.getRecurrentVisitSummary);
router.get('/recurrent-details/:usuarioId', visitorController.getRecurrentVisitDetails);
router.put('/recurrent-expiry/:id', visitorController.updateRecurrentVisitExpiry);
router.post('/regenerate-visit/:type/:id', visitorController.regenerateVisit);
router.post('/convert-to-recurrent/:id', visitorController.convertToRecurrent);

module.exports = router;
