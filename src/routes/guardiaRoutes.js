const express = require('express');
const router = express.Router();
const guardiaController = require('../controllers/guardiaController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');

router.post('/login', guardiaController.loginGuardia);
router.get('/motivos', guardiaController.getMotivos);
router.get('/geocerca-check', guardiaController.checkGuardiaLocation);
router.get('/visit/:id', guardiaController.getVisitDetails);
router.get('/resident/:id', guardiaController.getResidentDetails);
router.post('/confirm-access', guardiaController.confirmEntry);

// Escaneo de QR cifrado y nuevas operaciones de caseta (Guardia 3, Super Admin 1, Admin 4)
const guardOnly = [authenticateToken, requireRole(1, 3, 4)];
router.post('/scan', guardOnly, guardiaController.scanQR);
router.post('/paquetes/:id/recibir', guardOnly, guardiaController.receivePackage);
router.post('/eventos/:id/ingreso', guardOnly, guardiaController.checkInEventGuests);

module.exports = router;
