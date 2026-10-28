const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/verify-2fa', authController.verify2FA);
router.post('/verify-registration', authController.verifyRegistration);
router.post('/resend-verification', authController.resendVerificationCode);
router.post('/resend-2fa', authController.resendVerificationCode);
router.post('/reenviar_codigo', authController.resendVerificationCode);
router.post('/save-personal-data', authController.savePersonalData);
router.get('/get2FAStatus', authController.get2FAStatus);
router.get('/2fa-status', authController.get2FAStatus);
router.get('/2fa-status/:usuarioId', authController.get2FAStatus);
router.post('/set2FAStatus', authController.set2FAStatus);
router.get('/profile/:usuarioId', authController.getUserProfile);
router.get('/family/:usuarioId', authController.getFamilyMembers);
router.get('/condo-details/:usuarioId', authController.getCondominiumDetails);
router.get('/pending-users/:usuarioId', authController.getPendingUsers);
router.put('/approve-user/:targetUsuarioId', authController.approveUser);
router.delete('/reject-user/:targetUsuarioId', authController.rejectUser);
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
router.post('/save-fcm-token', authController.saveFCMToken);
router.get('/push-status/:usuarioId', authController.getPushStatus);
router.post('/set-push-status', authController.setPushStatus);
router.post('/change-password', authController.changePassword);
router.post('/forgot-password', authController.enviarCodigoRecuperacion);
router.post('/verify-reset-code', authController.verificarCodigoRecuperacion);
router.post('/reset-password', authController.actualizarContrasena);

module.exports = router;
