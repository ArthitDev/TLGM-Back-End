const express = require('express');
const router = express.Router();
const loginController = require('../controller/LoginController');
const authenticateToken = require('../middleware/authMiddleware');

// เส้นทางสำหรับการ login
router.post('/login', loginController.login);

// เพิ่มเส้นทางสำหรับ logout
router.post('/logout', loginController.logout);

module.exports = router;
