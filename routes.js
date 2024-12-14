const getMainInfo = (req, res) => {
  res.json({
    message: "SWC API Gateway!",
    note: "โปรดดูเอกสารประกอบเกี่ยวกับวิธีการใช้ API เหล่านี้.",
    main_endpoints: {
      "/api/v1/register": "ลงทะเบียนผู้ดูแลระบบใหม่",
      "/api/v1/login": "เข้าสู่ระบบสำหรับผู้ดูแลระบบที่มีอยู่แล้ว",
    },
    config_endpoints: {
      "/api/v1/config/start": "เริ่มต้น Client",
      "/api/v1/config/channels/:apiId": "ดึงข้อมูล Channels",
      "/api/v1/config/stop/:apiId": "หยุด Client",
    },
  });
};

module.exports = { getMainInfo };
