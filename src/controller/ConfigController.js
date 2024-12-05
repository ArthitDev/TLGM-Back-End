const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const clients = {}; // เก็บ Clients ตาม apiId
const sessions = {}; // เก็บ session string ตาม apiId

// สร้าง Telegram Client พร้อมรองรับ session string
const createClient = async (apiId, apiHash, sessionString = "") => {
    const session = new StringSession(sessionString); // ใช้ session string (hash)
    const client = new TelegramClient(session, parseInt(apiId), apiHash, {
        connectionRetries: 5,
    });
    await client.connect();
    return { client, session };
};

// เริ่มต้น Client พร้อมส่งคืน session hash
const startClient = async (req, res) => {
    const { apiId, apiHash } = req.body;

    if (!apiId || !apiHash) {
        return res.status(400).json({ error: "API_ID และ API_HASH เป็นสิ่งจำเป็น" });
    }

    try {
        const sessionString = sessions[apiId] || ""; // ใช้ session string ที่บันทึกไว��� หากมี
        const { client, session } = await createClient(apiId, apiHash, sessionString);
        clients[apiId] = { client, apiHash }; // เก็บ client และ apiHash
        sessions[apiId] = session.save(); // บันทึก session string
        res.json({ message: "Client เริ่มทำงานแล้ว", apiId, sessionHash: sessions[apiId] });
    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการเริ่มต้น Client", details: error.message });
    }
};


// ใช้งาน Client
const getChannels = async (req, res) => {
    const { apiId } = req.params;
    const clientData = clients[apiId];

    if (!clientData) {
        return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
    }

    try {
        const dialogs = [];
        for await (const dialog of clientData.client.iterDialogs()) {
            if (dialog.isChannel || dialog.isGroup) {
                dialogs.push({ 
                    id: dialog.id, 
                    title: dialog.title,
                    type: dialog.isChannel ? 'channel' : 'group'
                });
            }
        }
        res.json({ message: "ดึงข้อมูล Channels และ Groups สำเร็จ", channels: dialogs });
    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล Channels และ Groups", details: error.message });
    }
};

// หยุด Client และลบ session
const stopClient = async (req, res) => {
    const { apiId } = req.params;
    const clientData = clients[apiId];

    if (!clientData) {
        return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
    }

    try {
        await clientData.client.disconnect();
        delete clients[apiId];
        delete sessions[apiId];
        res.json({ message: "Client หยุดทำงานแล้ว", apiId });
    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการหยุด Client", details: error.message });
    }
};

const sendPhoneNumber = async (req, res) => {
    const { apiId, phoneNumber } = req.body; // รับเฉพาะ apiId และ phoneNumber
    const clientData = clients[apiId]; // ดึงข้อมูล client และ apiHash

    if (!clientData) {
        return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
    }

    const { client, apiHash } = clientData; // แยก apiHash จาก clientData

    if (!apiHash) {
        return res.status(500).json({ error: "ไม่สามารถดึง API_HASH สำหรับ API_ID นี้ได้" });
    }

    try {
        const result = await client.invoke(new Api.auth.SendCode({
            phoneNumber: phoneNumber,
            apiId: parseInt(apiId),
            apiHash: apiHash, // ใช้ apiHash ที่ดึงมา
            settings: new Api.CodeSettings({
                allowFlashcall: false,
                currentNumber: true,
                allowAppHash: false
            })
        }));

        res.json({ message: "ส่งรหัส OTP แล้ว", apiId, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการส่งรหัส OTP", details: error.message });
    }
};





// เพิ่มฟังก์ชันใหม่สำหรับยืนยัน OTP
const verifyCode = async (req, res) => {
    const { apiId, phoneNumber, code, phoneCodeHash } = req.body;
    
    if (!apiId || !phoneNumber || !code || !phoneCodeHash) {
        return res.status(400).json({ 
            error: "ข้อมูลไม่ครบถ้วน",
            details: "กรุณาระบุ apiId, phoneNumber, code และ phoneCodeHash"
        });
    }

    const clientData = clients[apiId];

    if (!clientData) {
        return res.status(404).json({ error: "ไม่พบ Client สำหรับ API_ID นี้" });
    }

    try {
        const { client } = clientData;
        await client.invoke(new Api.auth.SignIn({
            phoneNumber: phoneNumber,
            phoneCode: code,
            phoneCodeHash: phoneCodeHash,
        }));
        
        // เก็บ session string และสร้าง client ใหม่
        sessions[apiId] = client.session.save();
        const { client: newClient } = await createClient(apiId, clientData.apiHash, sessions[apiId]);
        clients[apiId] = { client: newClient, apiHash: clientData.apiHash };

        res.json({ message: "ยืนยันรหัส OTP สำเร็จ", apiId, sessionHash: sessions[apiId] });
    } catch (error) {
        res.status(500).json({ error: "เกิดข้อผิดพลาดในการยืนยันรหัส OTP", details: error.message });
    }
};

module.exports = {
    startClient,
    sendPhoneNumber, 
    verifyCode, 
    getChannels,
    stopClient,
};

