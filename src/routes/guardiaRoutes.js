const express = require('express');
const router = express.Router();
const guardiaController = require('../controllers/guardiaController');
const { login } = require('../controllers/authController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');

// Escaneo de QR cifrado y operaciones de caseta (Guardia 3, Super Admin 1, Admin 4)
const guardOnly = [authenticateToken, requireRole(1, 3, 4)];

// Mismo inicio de sesión que la app (2FA, sesión única y dispositivo de confianza). El login propio de
// guardias entregaba tokens de 8 horas sin esas protecciones, que además ya no pasarían authenticateToken.
router.post('/login', login);
router.get('/motivos', guardiaController.getMotivos);
// Datos de visitas y residentes: solo personal de caseta con sesión vigente
router.get('/geocerca-check', guardOnly, guardiaController.checkGuardiaLocation);
router.get('/visit/:id', guardOnly, guardiaController.getVisitDetails);
router.get('/resident/:id', guardOnly, guardiaController.getResidentDetails);
router.post('/confirm-access', guardOnly, guardiaController.confirmEntry);

router.post('/scan', guardOnly, guardiaController.scanQR);
router.post('/paquetes/:id/recibir', guardOnly, guardiaController.receivePackage);
router.post('/eventos/:id/ingreso', guardOnly, guardiaController.checkInEventGuests);

module.exports = router;
