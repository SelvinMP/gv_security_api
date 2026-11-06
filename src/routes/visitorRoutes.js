const express = require('express');
const router = express.Router();
const visitorController = require('../controllers/visitorController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// Carnet QR cifrado del residente (debe ir antes de '/:type/:id')
router.get('/resident-qr', authenticateToken, visitorController.getResidentQR);
router.post('/registrar_visitas', visitorController.registerVisit);
router.post('/validateQR', visitorController.validateQR);
router.get('/history/:usuarioId', visitorController.getVisitorHistory);
// Cancelar visita (debe ir antes de '/:type/:id')
router.post('/cancel/:type/:id', authenticateToken, visitorController.cancelVisit);
router.delete('/:type/:id', visitorController.deleteVisitor);
router.get('/recurrent-summary/:usuarioId', visitorController.getRecurrentVisitSummary);
router.get('/recurrent-details/:usuarioId', visitorController.getRecurrentVisitDetails);
router.put('/recurrent-expiry/:id', visitorController.updateRecurrentVisitExpiry);
router.post('/regenerate-visit/:type/:id', visitorController.regenerateVisit);
router.post('/convert-to-recurrent/:id', visitorController.convertToRecurrent);

module.exports = router;
