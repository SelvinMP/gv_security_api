const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// Ruta para obtener todos los anuncios (eventos): solo para usuarios con sesión vigente
router.get('/anuncios_eventos', authenticateToken, notificationsController.getAnnouncements);

// Ruta para ocultar un anuncio (para el usuario de la sesión)
router.post('/ocultar_anuncio', authenticateToken, notificationsController.hideAnnouncement);

// Ruta para obtener notificaciones personales (solo las propias)
router.get('/personal/:usuarioId', authenticateToken, notificationsController.getPersonalNotifications);

module.exports = router;
