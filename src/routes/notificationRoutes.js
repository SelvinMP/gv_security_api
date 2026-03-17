const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notificationsController');

// Ruta para obtener todos los anuncios (eventos)
router.get('/anuncios_eventos', notificationsController.getAnnouncements);

// Ruta para ocultar un anuncio
router.post('/ocultar_anuncio', notificationsController.hideAnnouncement);

module.exports = router;
