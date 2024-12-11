const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const db = require('../../db');
const clients = {}; // เก็บ Clients ตาม apiId
const sessions = {}; // เก็บ session string ตาม apiId


const getChannels = async (req, res) => {
    const { apiId } = req.params;
    const clientData = clients[apiId]; // ตรวจสอบว่า Client ถูกสร้างขึ้นแล้ว

    if (!clientData) {
        return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
    }

    try {
        const dialogs = [];
        for await (const dialog of clientData.client.iterDialogs()) {
            if (dialog.isChannel || dialog.isGroup) {
                dialogs.push({
                    id: dialog.id,          // ID ของ Channel หรือ Group
                    title: dialog.title,    // ชื่อ Channel หรือ Group
                    type: dialog.isChannel ? 'channel' : 'group' // ประเภท
                });
            }
        }

        res.json({
            message: "ดึงข้อมูล Channels และ Groups สำเร็จ",
            channels: dialogs, // ส่งกลับรายการ Channels
        });
    } catch (error) {
        console.error("Error in getChannels:", error);
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล Channels", details: error.message });
    }
};

const formatPhoneNumber = (phoneNumber) => {
    // ตรวจสอบว่าหมายเลขขึ้นต้นด้วย '0'
    if (phoneNumber.startsWith('0')) {
      return '+66' + phoneNumber.slice(1); // แปลง '0' เป็น '+66'
    }
    return phoneNumber; // หากไม่มี '0' คงหมายเลขเดิม
};

  
// สร้าง Telegram Client พร้อมรองรับ session string
const createClient = async (apiId, apiHash, sessionString = "") => {
    const session = new StringSession(sessionString); // ใช้ session string (hash)
    const client = new TelegramClient(session, parseInt(apiId), apiHash, {
        connectionRetries: 5,
    });
    await client.connect(); // เชื่อมต่อกับ Telegram API
    return { client, session };
};

const startClient = async (req, res) => {
    const { apiId, apiHash } = req.body;

    if (!apiId || !apiHash) {
        return res.status(400).json({ error: "API_ID และ API_HASH เป็นสิ่งจำเป็น" });
    }

    try {
        const sessionString = sessions[apiId] || ""; // ใช้ session string ที่บันทึกไว้ หากมี
        const { client, session } = await createClient(apiId, apiHash, sessionString); // สร้าง Client
        clients[apiId] = { client, apiHash }; // เก็บ client และ apiHash
        sessions[apiId] = session.save(); // บันทึก session string
        res.json({ message: "Client เริ่มทำงานแล้ว", apiId, sessionHash: sessions[apiId] });
    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการเริ่มต้น Client", details: error.message });
    }
};


// หยุด Client และลบ session
const stopClient = async (req, res) => {
    const { apiId } = req.params;
    const { userid } = req.body;

    // Log the userid received from the front-end
    console.log('Received userid from front-end:', userid);

    const clientData = clients[apiId];

    if (!clientData) {
        return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
    }

    try {
        // Update both telegram_auth and session_hash in database
        const [result] = await db.execute(
            'UPDATE users SET telegram_auth = 0, session_hash = NULL WHERE userid = ?',
            [userid]
        );

        if (result.affectedRows === 0) {
            console.error('Database Update Failed: No rows affected.');
            return res.status(404).json({ error: 'User not found or update failed.' });
        }

        await clientData.client.disconnect();
        delete clients[apiId];
        delete sessions[apiId];

        res.json({ message: "Client หยุดทำงานแล้ว", apiId });
    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการหยุด Client", details: error.message });
    }
};

const sendPhoneNumber = async (req, res) => {
    const { apiId, phoneNumber } = req.body;
    const clientData = clients[apiId];
  
    if (!clientData) {
      return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
    }
  
    try {
      const formattedPhoneNumber = formatPhoneNumber(phoneNumber); // แปลงหมายเลขโทรศัพท์
      const result = await clientData.client.invoke(new Api.auth.SendCode({
        phoneNumber: formattedPhoneNumber,
        apiId: parseInt(apiId),
        apiHash: clientData.apiHash,
        settings: new Api.CodeSettings({
          allowFlashcall: false,
          currentNumber: true,
          allowAppHash: false,
        }),
      }));
  
      res.json({ message: "ส่งรหัส OTP แล้ว", phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
      res.status(500).json({ error: "เกิดข้อผิดพลาดในการส่งรหัส OTP", details: error.message });
    }
  };
  


// เพิ่มฟังก์ชันใหม่สำหรับยืนยัน OTP
const verifyCode = async (req, res) => {
  const { apiId, phoneNumber, code, phoneCodeHash, userid } = req.body;

  if (!apiId || !phoneNumber || !code || !phoneCodeHash || !userid) {
      return res.status(400).json({
          error: "ข้อมูลไม่ครบถ้วน",
          details: "กรุณาระบุ apiId, phoneNumber, code, phoneCodeHash และ userid",
      });
  }

  const clientData = clients[apiId];

  if (!clientData) {
      return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
  }

  try {
      const formattedPhoneNumber = formatPhoneNumber(phoneNumber);
      console.log('Sending to Telegram API:', {
          phoneNumber: formattedPhoneNumber,
          phoneCode: code,
          phoneCodeHash: phoneCodeHash,
      });

      const { client } = clientData;
      await client.invoke(new Api.auth.SignIn({
          phoneNumber: formattedPhoneNumber,
          phoneCode: code,
          phoneCodeHash: phoneCodeHash,
      }));

      sessions[apiId] = client.session.save();
      const sessionHash = sessions[apiId];

      console.log('Updating Database...');
      const [result] = await db.execute(
          'UPDATE users SET session_hash = ?, telegram_auth = 1 WHERE userid = ?',
          [sessionHash, userid]
      );

      console.log('Database Update Result:', result);

      if (result.affectedRows === 0) {
          console.error('Database Update Failed: No rows affected.');
          return res.status(404).json({ error: 'User not found or update failed.' });
      }

      res.json({ message: "ยืนยันรหัส OTP สำเร็จ", apiId, sessionHash });
  } catch (error) {
      console.error("Error in verifyCode:", error);
      res.status(500).json({ error: "Telegram API failed", details: error.message });
  }
};


module.exports = {
    startClient,
    sendPhoneNumber, 
    verifyCode, 
    stopClient,
    getChannels
};