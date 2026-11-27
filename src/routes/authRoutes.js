const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const profilePhoto = require('../controllers/profilePhotoController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.post('/register', authController.register);
router.post('/login', authController.login);
// Sesión única por usuario: cerrar la sesión y comprobar si sigue vigente
router.post('/logout', authenticateToken, authController.logout);
router.get('/session', authenticateToken, authController.sessionStatus);
router.post('/verify-2fa', authController.verify2FA);
router.post('/verify-registration', authController.verifyRegistration);
router.post('/resend-verification', authController.resendVerificationCode);
router.post('/resend-2fa', authController.resendVerificationCode);
router.post('/reenviar_codigo', authController.resendVerificationCode);
router.post('/save-personal-data', authController.savePersonalData);
// Requieren sesión: el controlador valida además que el usuario consulte o gestione solo lo que le corresponde
router.get('/get2FAStatus', authenticateToken, authController.get2FAStatus);
router.get('/2fa-status', authenticateToken, authController.get2FAStatus);
router.get('/2fa-status/:usuarioId', authenticateToken, authController.get2FAStatus);
router.post('/set2FAStatus', authenticateToken, authController.set2FAStatus);
router.get('/profile/:usuarioId', authenticateToken, authController.getUserProfile);
// Foto de perfil: archivo en el servidor (carpeta privada), en la base solo su ruta
router.post('/profile-photo', authenticateToken, profilePhoto.receivePhoto, profilePhoto.uploadProfilePhoto);
router.get('/profile-photo/:usuarioId', authenticateToken, profilePhoto.getProfilePhoto);
router.delete('/profile-photo', authenticateToken, profilePhoto.deleteProfilePhoto);
router.get('/family/:usuarioId', authenticateToken, authController.getFamilyMembers);
router.get('/condo-details/:usuarioId', authenticateToken, authController.getCondominiumDetails);
router.get('/pending-users/:usuarioId', authenticateToken, authController.getPendingUsers);
router.put('/approve-user/:targetUsuarioId', authenticateToken, authController.approveUser);
router.delete('/reject-user/:targetUsuarioId', authenticateToken, authController.rejectUser);
router.get('/nationalities', authController.getNationalities);
router.get('/contact-types', authController.getContactTypes);
router.get('/relationships', authController.getRelationships);
router.get('/condos', authController.getCondos);

// Aliases para compatibilidad con aplicación móvil (Flutter)
router.post('/nueva_persona', authController.savePersonalData);
router.get('/condominio', authController.getCondos);
router.get('/parentesco', authController.getRelationships);
router.get('/nacionalidad', authController.getNationalities);
router.get('/contacto', authController.getContactTypes);
router.get('/personas', authController.getCondos);
// Notificaciones push: solo con sesión, y siempre sobre la cuenta de la sesión
router.post('/save-fcm-token', authenticateToken, authController.saveFCMToken);
router.get('/push-status/:usuarioId', authenticateToken, authController.getPushStatus);
router.post('/set-push-status', authenticateToken, authController.setPushStatus);
router.post('/push-test', authenticateToken, authController.sendTestPush);
router.post('/change-password', authenticateToken, authController.changePassword);
router.post('/forgot-password', authController.enviarCodigoRecuperacion);
router.post('/verify-reset-code', authController.verificarCodigoRecuperacion);
router.post('/reset-password', authController.actualizarContrasena);

module.exports = router;
