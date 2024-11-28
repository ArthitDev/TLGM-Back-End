const express = require("express");
const {
    startClient,
    sendPhoneNumber,
    verifyCode,
    getChannels,
    stopClient,
} = require("../controller/ConfigController");

const router = express.Router();

router.post("/start", startClient);
router.get("/channels/:apiId", getChannels);
router.post("/stop/:apiId", stopClient);
router.post("/send-phone", sendPhoneNumber);
router.post("/verify-code", verifyCode);

module.exports = router;
