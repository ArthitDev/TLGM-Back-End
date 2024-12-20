const { 
  startContinuousAutoForward, 
  beginForwarding,
  stopContinuousAutoForward,
  checkForwardingStatus,
  handleInitialize,
  getForwardingStatusFromDB
} = require("../controller/ForwardController");
const express = require('express');
const router = express.Router();

// Remove unused routes and add new beginForwarding route
router.post("/start-continuous-forward", startContinuousAutoForward);
router.post("/begin-forwarding", beginForwarding);
router.post("/stop-continuous-forward", stopContinuousAutoForward);
router.post("/initialize", handleInitialize);
router.post("/check-forwarding-status", checkForwardingStatus);
router.post("/get-forwarding-status", getForwardingStatusFromDB);

module.exports = router;
