const express = require('express');
const router = express.Router();
const requestController = require('../controllers/requestController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// Solicitudes de residentes ante la Administración y la Junta Directiva. Requiere sesión (JWT).
router.use(authenticateToken);

router.get('/catalogos', requestController.getCatalogs);
router.get('/informe', requestController.getTransparencyReport);
router.get('/mis-solicitudes', requestController.getMyRequests);
router.get('/seguimiento/:numero', requestController.getRequestByTracking);
router.post('/', requestController.createRequest);

module.exports = router;
