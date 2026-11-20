const express = require('express');
const router = express.Router();
const reservationsController = require('../controllers/reservationsController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// GET /api/reservas/instalaciones (catálogo general)
router.get('/instalaciones', reservationsController.getInstallations);

// POST /api/reservas (a nombre del usuario de la sesión)
router.post('/', authenticateToken, reservationsController.createReservation);

// GET /api/reservas/usuario/:userId (solo las propias, o un administrador)
router.get('/usuario/:userId', authenticateToken, reservationsController.getUserReservations);

module.exports = router;
