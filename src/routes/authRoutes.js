const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/verify-2fa', authController.verify2FA);
router.post('/verify-registration', authController.verifyRegistration);
router.post('/save-personal-data', authController.savePersonalData);
router.get('/get2FAStatus', authController.get2FAStatus);
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
router.post('/change-password', authController.changePassword);

module.exports = router;
