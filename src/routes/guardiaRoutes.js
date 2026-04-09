const express = require('express');
const router = express.Router();
const guardiaController = require('../controllers/guardiaController');

router.post('/login', guardiaController.loginGuardia);
router.get('/visit/:id', guardiaController.getVisitDetails);
router.post('/confirm-access', guardiaController.confirmEntry);

module.exports = router;
