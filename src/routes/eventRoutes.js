const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// QR múltiple para visitas (reuniones, celebraciones, juntas). Requiere sesión (JWT).
router.use(authenticateToken);

router.post('/', eventController.createEvent);
router.get('/usuario/:usuarioId', eventController.getUserEvents);
router.get('/:id/qr', eventController.getEventQR);
router.put('/:id', eventController.updateEvent);
router.delete('/:id', eventController.deleteEvent);

module.exports = router;
