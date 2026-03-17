const express = require('express');
const router = express.Router();
const reservationsController = require('../controllers/reservationsController');

// GET /api/reservas/instalaciones
router.get('/instalaciones', reservationsController.getInstallations);

// POST /api/reservas
router.post('/', reservationsController.createReservation);

// GET /api/reservas/usuario/:userId
router.get('/usuario/:userId', reservationsController.getUserReservations);

module.exports = router;
