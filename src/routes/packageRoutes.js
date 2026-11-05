const express = require('express');
const router = express.Router();
const packageController = require('../controllers/packageController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// QR de Paquetes (residentes). Todas las rutas requieren sesión (JWT).
router.use(authenticateToken);

router.get('/tamanos', packageController.getPackageSizes);
router.post('/', packageController.createPackage);
router.get('/usuario/:usuarioId', packageController.getUserPackages);
router.get('/:id/qr', packageController.getPackageQR);
router.put('/:id', packageController.updatePackage);
router.delete('/:id', packageController.deletePackage);

module.exports = router;
