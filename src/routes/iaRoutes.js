const express = require('express');
const multer = require('multer');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { requireIA } = require('../utils/ai');
const aiAdminController = require('../controllers/aiAdminController');
const { authenticateToken, requireRole, requireSuperAdmin } = require('../middlewares/authMiddleware');

// Inteligencia Artificial (opcional por residencial). Todas las rutas requieren sesión (JWT).
router.use(authenticateToken);

// La foto se procesa en memoria y no se guarda en el servidor.
const foto = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const subirFoto = (req, res, next) => {
  foto.single('foto')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'La foto supera el máximo de 5 MB.' : 'No se pudo recibir la foto.' });
    next();
  });
};

// Qué funciones están encendidas (la app oculta las apagadas)
router.get('/estado', aiController.getEstado);

// Administración (Super Admin = 1, Administrador = 4) puede ver el estado y el consumo;
// SOLO el Super Administrador puede encender/apagar funciones y cambiar los topes.
const admin = requireRole(1, 4);
router.get('/admin/config', admin, aiController.adminGetConfig);
router.put('/admin/config', requireSuperAdmin, aiController.adminSaveConfig);

// Funciones para la administración
router.post('/admin/consulta', admin, requireIA('analitica'), aiAdminController.consultarDatos);
router.post('/admin/resumen', admin, requireIA('analitica'), aiAdminController.generarResumen);
router.post('/admin/solicitudes/:id/analizar', admin, requireIA('solicitudes'), aiAdminController.analizarSolicitud);

// Funciones (cada una exige que la administración la haya activado)
router.post('/reglamento', requireIA('reglamento'), aiController.preguntarReglamento);
router.post('/asistente', requireRole(1, 2, 4), requireIA('asistente'), aiController.conversarAsistente);
router.post('/leer-foto', requireIA('fotos'), subirFoto, aiController.leerFoto);

module.exports = router;
