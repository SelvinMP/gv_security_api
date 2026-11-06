const express = require('express');
const router = express.Router();
const politicas = require('../controllers/politicasController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');
const { uploadPolitica } = require('../config/upload');

// Políticas / reglamento de la residencial. Todas las rutas requieren sesión (JWT).
router.use(authenticateToken);

// Administración (Super Admin = 1, Administrador = 4). Van antes de "/:id".
const admin = requireRole(1, 4);
router.get('/admin/lista', admin, politicas.adminListPoliticas);
router.post('/admin/archivo', admin, (req, res, next) => {
  uploadPolitica.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'El PDF supera el máximo de 10 MB.' : err.message });
    next();
  });
}, politicas.uploadPoliticaPdf);
router.post('/admin', admin, politicas.createPolitica);
router.put('/admin/:id/estado', admin, politicas.setEstadoPolitica);
router.put('/admin/:id', admin, politicas.updatePolitica);
router.delete('/admin/:id', admin, politicas.deletePolitica);

// Lectura: cada rol recibe solo lo dirigido a él (admins ven todo; ?verComo=2|3 para previsualizar)
router.get('/categorias', politicas.getCategorias);
router.get('/', politicas.getPoliticas);
router.get('/:id/pdf', politicas.getPoliticaPdf);
router.get('/:id', politicas.getPolitica);

module.exports = router;
