const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const db = require('../../db');

const CLIENT_TIMEOUT = 1000 * 60 * 60; // 1 hour in milliseconds
const CLEANUP_INTERVAL = 1000 * 60 * 15; // run cleanup every 15 minutes

const clientsMap = new Map(); // Map<userId, { client, createdAt, lastUsed }>
const intervalsMap = new Map();
const messagesMap = new Map();
const userBatchSizesMap = new Map();
const groupCooldowns = new Map();

const initializeClient = async (userId) => {
  try {
    const userData = await getUserFromDatabase(userId);
    if (!userData) {
      throw new Error('User not found');
    }

    const client = new TelegramClient(
      new StringSession(userData.sessionString), 
      userData.apiId, 
      userData.apiHash, 
      {
        connectionRetries: 5,
      }
    );
    
    await client.connect();
    
    // เก็บข้อมูล timestamp
    clientsMap.set(userId, {
      client,
      createdAt: Date.now(),
      lastUsed: Date.now()
    });
    
    return client;
  } catch (error) {
    console.error('Error initializing client:', error);
    throw error;
  }
};

const getUserFromDatabase = async (userId) => {
  try {
    const [rows] = await db.execute(
      'SELECT userid, api_id, api_hash, session_hash FROM users WHERE userid = ?',
      [userId]
    );

    if (rows.length === 0) {
      return null;
    }

    return {
      userId: rows[0].userid,
      apiId: rows[0].api_id,
      apiHash: rows[0].api_hash,
      sessionString: rows[0].session_hash
    };
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
};

const checkNewMessages = async (client, sourceChatId) => {
  const messages = await client.getMessages(sourceChatId, { limit: 1 });
  return messages.filter(msg => 
    !msg.forwards && msg.date > (Date.now() / 1000 - 3600)
  );
};

const forwardMessage = async (client, msg, sourceChatId, destChatId) => {
  try {
    const chat = await client.getEntity(destChatId).catch(e => null);
    if (!chat) {
      console.log(`ไม่สามารถเข้าถึงกลุ่ม ${destChatId}: กลุ่มอาจไม่มีอยู่หรือไม่ได้เป็นสมาชิก`);
      return false;
    }

    const cooldownUntil = groupCooldowns.get(destChatId);
    const now = Date.now();
    if (cooldownUntil && now < cooldownUntil) {
      console.log(`กลุ่ม ${destChatId} ยังอยู่ในช่วง cooldown อีก ${Math.ceil((cooldownUntil - now)/1000)} วินาที`);
      return false;
    }

    await client.forwardMessages(destChatId, {
      messages: [msg.id],
      fromPeer: sourceChatId,
    });
    
    if (chat.slowmode_enabled) {
      groupCooldowns.set(destChatId, now + (chat.slowmode_seconds * 1000));
      console.log(`ตั้ง cooldown ${chat.slowmode_seconds} วินาที สำหรับกลุ่ม ${destChatId}`);
    }

    console.log(`Successfully forwarded message ID: ${msg.id} to ${destChatId}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return true;
  } catch (error) {
    if (error.message.includes('PEER_ID_INVALID')) {
      console.log(`ไม่สามารถส่งข้อความไปยังกลุ่ม ${destChatId}: กลุ่มไม่ถูกต้องหรือไม่มีสิทธิ์`);
    } else {
      console.error(`Failed to forward message ${msg.id} to ${destChatId}:`, error.message);
    }
    return false;
  }
};

const getGroupCooldowns = async (client, chatIds) => {
  const cooldowns = {};
  for (const chatId of chatIds) {
    try {
      const chat = await client.getEntity(chatId);
      if (chat.slowmode_enabled) {
        cooldowns[chatId] = chat.slowmode_seconds;
      }
    } catch (error) {
      console.error(`ไม่สามารถดึงข้อมูล cooldown ของกลุ่ม ${chatId}:`, error.message);
    }
  }
  return cooldowns;
};

const startContinuousAutoForward = async (req, res) => {
  try {
    const { userId, sourceChatId, destinationChatIds } = req.body;
    const clientData = clientsMap.get(userId);
    
    if (!clientData) {
      return res.status(400).json({ error: 'Client not initialized' });
    }

    // อัพเดท lastUsed timestamp
    clientData.lastUsed = Date.now();
    
    if (!userId || !sourceChatId || !Array.isArray(destinationChatIds)) {
      return res.status(400).json({
        error: 'Invalid parameters'
      });
    }

    const client = clientData.client;
    if (!client) {
      return res.status(400).json({ error: 'Client not initialized' });
    }

    // ต่งข้อความ hello world ไปยังทุกกลุ่มปลายทางก่อน
    for (const destChatId of destinationChatIds) {
      try {
        await client.sendMessage(destChatId, { message: 'hello world' });
        console.log(`Sent initial hello world message to ${destChatId}`);
        // รอ 1 วินาทีระหว่างการส่งแต่ละกลุ่ม
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Failed to send hello world to ${destChatId}:`, error.message);
        return res.status(400).json({ 
          error: `Unable to send messages to group ${destChatId}. Please check permissions.` 
        });
      }
    }

    // ตั้งค่า timeout สำหรับการรอ (เช่น 30 วินาที)
    const TIMEOUT = 30000;
    const startTime = Date.now();

    // วนลูปตรวจสอบข้อความใหม่
    while (Date.now() - startTime < TIMEOUT) {
      const unforwardedMessages = await checkNewMessages(client, sourceChatId);
      
      if (unforwardedMessages.length > 0) {
        // พบข้อความใหม่
        return res.json({
          success: true,
          status: 'FOUND',
          message: 'New messages found',
          data: unforwardedMessages.map(msg => ({
            messageId: msg.id,
            text: msg.message,
            date: new Date(msg.date * 1000)
          }))
        });
      }

      // รอ 1 วินาทีก่อนตรวจสอบอีกครั้ง
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // หมดเวลารอแล้วยังไม่พบข้อความใหม่
    return res.json({
      success: true,
      status: 'TIMEOUT',
      message: 'No new messages found within timeout period',
      data: []
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
};

const processCooldownGroups = async (client, msg, sourceChatId, cooldownGroups) => {
  try {
    console.log('\n=== เริ่มตรวจสอบกลุ่มที่ติด Cooldown ===');
    
    // สร้างฟังก์ชันสำหรับตรวจสอบและส่งข้อความทันทีเมื่อครบ cooldown
    const checkAndSendMessage = async (destChatId) => {
      while (cooldownGroups.has(destChatId)) {
        const now = Date.now();
        const cooldownUntil = groupCooldowns.get(destChatId);
        const timeLeft = cooldownUntil ? Math.ceil((cooldownUntil - now) / 1000) : 0;

        // ถ้าครบ cooldown + 2 วินาที
        if (!cooldownUntil || now >= cooldownUntil + 2000) {
          console.log(`\n🕒 กลุ่ม ${destChatId} ครบเวลา cooldown แล้ว`);
          console.log(`📤 กำลังส่งข้อความไปยังกลุ่ม ${destChatId}...`);
          
          const result = await forwardMessage(client, msg, sourceChatId, destChatId);
          
          if (result) {
            console.log(`✅ ส่งสำเร็จไปยังกลุ่ม ${destChatId}`);
            cooldownGroups.delete(destChatId);
            return;
          } else {
            console.log(`❌ ส่งไม่สำเร็จไปยังกลุ่ม ${destChatId}`);
            const newCooldown = groupCooldowns.get(destChatId);
            if (newCooldown) {
              console.log(`⏳ กลุ่ม ${destChatId} ได้รับ cooldown ใหม่: ${Math.ceil((newCooldown - now) / 1000)} วินาที`);
              // รอจนครบ cooldown ใหม่แล้วลองอีกครั้ง
              await new Promise(resolve => setTimeout(resolve, newCooldown - now + 2000));
            }
          }
        } else {
          // ถ้ายังไม่ครบ cooldown ให้รอจนครบแล้วลองใหม่
          console.log(`⏳ กลุ่ม ${destChatId} เหลือเวลา cooldown: ${timeLeft} วินาที`);
          await new Promise(resolve => setTimeout(resolve, cooldownUntil - now + 2000));
        }
      }
    };

    // เริ่มการตรวจสอบและส่งข้อความสำหรับทุกกลุ่มพร้อมกัน
    console.log(`\n🔄 เริ่มตรวจสอบ ${cooldownGroups.size} กลุ่มที่ติด cooldown`);
    const checkPromises = Array.from(cooldownGroups).map(destChatId => 
      checkAndSendMessage(destChatId)
    );

    // รอให้ทุกกลุ่มทำงานเสร็จ
    await Promise.all(checkPromises);
    
    console.log('\n✨ จบการตรวจสอบกลุ่มที่ติด Cooldown');
    
    // ถ้ายังมีกลุ่มที่ไม่สำเร็จ แสดงสถานะ
    if (cooldownGroups.size > 0) {
      console.log('\n📊 สรุปกลุ่มที่ยังติด cooldown:');
      for (const destChatId of cooldownGroups) {
        const cooldownUntil = groupCooldowns.get(destChatId);
        const timeLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);
        console.log(`- กลุ่ม ${destChatId}: เหลือเวลา ${timeLeft} วินาที`);
      }
    }

  } catch (error) {
    console.error('❌ Error processing cooldown groups:', error);
    console.error('Error details:', error.message);
  }
};

const autoForwardMessages = async (userId, sourceChatId, destinationChatIds) => {
  const clientData = clientsMap.get(userId);
  if (!clientData) throw new Error('Client not found');
  
  try {
    // อัพเดท lastUsed timestamp
    clientData.lastUsed = Date.now();
    
    console.log('\n=== เริ่มกระบวนการ Forward ===');
    console.log(`จำนวนกลุ่มทั้งหมด: ${destinationChatIds.length} กลุ่ม`);

    const chunkSize = 20;
    const chunks = [];
    const cooldownGroups = new Set();
    
    // ดึงข้อความที่เก็บไว้จาก messagesMap
    const storedMessages = messagesMap.get(userId);
    if (!storedMessages || storedMessages.length === 0) {
      console.log('❌ ไม่พบข้อความที่เก็บไว้ใน messagesMap');
      return false;
    }
    let lastMessage = storedMessages[0];
    console.log(`📝 ข้อความที่เก็บไว้: ID ${lastMessage.id}`);
    console.log(`📄 เนื้อหา: ${lastMessage.message?.substring(0, 50)}...`);

    for (let i = 0; i < destinationChatIds.length; i += chunkSize) {
      chunks.push(destinationChatIds.slice(i, i + chunkSize));
    }

    let currentBatchSize = Math.min(userBatchSizesMap.get(userId) || 3, 3);
    console.log(`\n🔄 แบ่งการส่งเป็น ${chunks.length} chunks (${chunkSize} กลุ่ม/chunk)`);
    console.log(`📦 Batch size: ${currentBatchSize} chunks/รอบ`);

    // ส่งข้อความไปยังกลุ่มที่ไม่ติด cooldown
    for (let i = 0; i < chunks.length; i += currentBatchSize) {
      console.log(`\n=== รอบที่ ${Math.floor(i/currentBatchSize) + 1} ===`);
      
      // ดึงข้อความล่าสุดก่อนส่งในแต่ละรอบ
      console.log('🔍 ตรวจสอบข้อความใหม่...');
      const latestMessages = await checkNewMessages(clientData.client, sourceChatId);
      
      // อัพเดท lastMessage ถ้าพบข้อความใหม่
      if (latestMessages?.length > 0) {
        lastMessage = latestMessages[0];
        messagesMap.set(userId, [lastMessage]);
        console.log(`✨ พบข้อความใหม่ ID: ${lastMessage.id}`);
        console.log(`📄 เนื้อหา: ${lastMessage.message?.substring(0, 50)}...`);
      } else {
        console.log(`♻️ ใช้ข้อความเดิม ID: ${lastMessage.id}`);
      }

      const currentBatch = chunks.slice(i, i + currentBatchSize);
      const totalGroupsInBatch = currentBatch.reduce((sum, chunk) => sum + chunk.length, 0);
      
      console.log(`\n📤 กำลังส่งไปยัง ${totalGroupsInBatch} กลุ่ม...`);
      
      const results = await Promise.all(
        currentBatch.flatMap(chunk =>
          chunk.map(async destChatId => {
            const result = await forwardMessage(clientData.client, lastMessage, sourceChatId, destChatId);
            if (!result) {
              const cooldownUntil = groupCooldowns.get(destChatId);
              if (cooldownUntil) {
                cooldownGroups.add(destChatId);
                const timeLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);
                console.log(`⏳ กลุ่ม ${destChatId} ติด cooldown อีก ${timeLeft} วินาที`);
              }
            } else {
              console.log(`✅ ส่งสำเร็จไปยังกลุ่ม ${destChatId}`);
            }
            return result;
          })
        )
      );

      const successCount = results.filter(r => r).length;
      const failedCount = results.filter(r => !r).length;
      
      console.log(`\n📊 สรุปผลการส่งรอบนี้:`);
      console.log(`✅ สำเร็จ: ${successCount} กลุ่ม`);
      console.log(`❌ ไม่สำเร็จ: ${failedCount} กลุ่ม`);

      if (i + currentBatchSize < chunks.length) {
        const delayTime = 5000;
        console.log(`\n⏱️ รอ ${delayTime/1000} วินาที ก่อนส่งรอบถัดไป...`);
        await new Promise(resolve => setTimeout(resolve, delayTime));
      }
    }

    // จัดการกลุ่มที่ติด cooldown
    if (cooldownGroups.size > 0) {
      console.log(`\n⏳ มี ${cooldownGroups.size} กลุ่มที่ติด cooldown, เริ่มการส่งแยก`);
      await processCooldownGroups(clientData.client, lastMessage, sourceChatId, cooldownGroups);
    }

    console.log('\n=== จบกระบวนการ Forward ===\n');
    return true;
  } catch (error) {
    console.error('❌ Error in auto forwarding:', error);
    throw error;
  }
};

const resetUserBatchSize = (userId) => {
  userBatchSizesMap.set(userId, 4);
};

const beginForwarding = async (req, res) => {
  try {
    const { userId, sourceChatId, destinationChatIds, forward_interval = 5 } = req.body;
    
    const clientData = clientsMap.get(userId);
    if (!clientData) {
      return res.status(400).json({ error: 'Client not initialized' });
    }

    // อัพเดท lastUsed timestamp
    clientData.lastUsed = Date.now();

    if (forward_interval < 1 || forward_interval > 60) {
      return res.status(400).json({
        error: 'Invalid forward_interval (1-60 minutes)'
      });
    }

    // Check if record exists and update with new forward_interval
    try {
      const [rows] = await db.execute(
        'SELECT userid FROM forward WHERE userid = ?',
        [userId]
      );

      if (rows.length === 0) {
        await db.execute(
          'INSERT INTO forward (userid, status, forward_interval) VALUES (?, 1, ?)',
          [userId, forward_interval]
        );
        console.log(`Created new forwarding record for user ${userId} with forward_interval ${forward_interval}`);
      } else {
        await db.execute(
          'UPDATE forward SET status = 1, forward_interval = ? WHERE userid = ?',
          [forward_interval, userId]
        );
        console.log(`Updated forwarding status and forward_interval for user ${userId}`);
      }
    } catch (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({ error: 'Failed to update forwarding status' });
    }

    // เก็บข้อความเริ่มต้น
    const initialMessages = await clientData.client.getMessages(sourceChatId, { limit: 1 });
    console.log(`Found ${initialMessages.length} message to forward repeatedly`);
    
    if (initialMessages.length > 0) {
      messagesMap.set(userId, [initialMessages[0]]);
      console.log('Stored initial message for repeated forwarding:', initialMessages[0].id);
    } else {
      console.log('No message found to forward');
      return res.status(400).json({
        error: 'No message found to forward'
      });
    }

    // ถ้ามี interval เดิมอยู่ให้ยกเลิกก่อน
    if (intervalsMap.has(userId)) {
      clearInterval(intervalsMap.get(userId));
      console.log('Cleared existing interval');
    }

    // ตั้ง interval ใหม่สำหรับ forward ซ้ำๆ
    const intervalMs = forward_interval * 60 * 1000;
    const newInterval = setInterval(
      () => autoForwardMessages(userId, sourceChatId, destinationChatIds),
      intervalMs
    );

    intervalsMap.set(userId, newInterval);
    console.log(`Set new interval to forward every ${forward_interval} minutes`);

    // เริ่มส่งข้อความครั้งแรกทันที
    autoForwardMessages(userId, sourceChatId, destinationChatIds);

    res.json({
      success: true,
      message: 'Forwarding started - will repeatedly forward initial messages',
      settings: { 
        forward_interval: forward_interval,
        initialMessageCount: initialMessages.length,
        groupCooldowns
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const stopContinuousAutoForward = async (req, res) => {
  try {
    const { userId } = req.body;
    
    const clientData = clientsMap.get(userId);
    if (clientData) {
      // อัพเดท lastUsed timestamp ก่อนที่จะหยุด
      clientData.lastUsed = Date.now();
      
      try {
        await clientData.client.disconnect();
      } catch (disconnectError) {
        console.error('Error disconnecting client:', disconnectError);
      }
    }

    // Update database status to inactive and reset forward_interval
    try {
      await db.execute(
        'UPDATE forward SET status = 0, forward_interval = 0 WHERE userid = ?',
        [userId]
      );
      console.log(`Updated forwarding status and reset interval for user ${userId}`);
    } catch (dbError) {
      console.error('Database error:', dbError);
    }

    // Cleanup all maps
    if (intervalsMap.has(userId)) {
      clearInterval(intervalsMap.get(userId));
      intervalsMap.delete(userId);
    }
    clientsMap.delete(userId);
    messagesMap.delete(userId);
    userBatchSizesMap.delete(userId);

    console.log(`Auto-forward stopped for user ${userId}`);
    res.json({ 
      success: true, 
      message: 'Auto-forward stopped successfully' 
    });
  } catch (error) {
    console.error('Error stopping auto-forward:', error);
    res.status(500).json({
      error: 'Failed to stop auto-forward',
      details: error.message
    });
  }
};

const handleInitialize = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        error: 'userId is required' 
      });
    }

    const client = await initializeClient(userId);
    
    res.json({
      success: true,
      message: 'Client initialized successfully'
    });
  } catch (error) {
    console.error('Error in initialization:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
};

const checkForwardingStatus = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const clientData = clientsMap.get(userId);
    if (clientData) {
      // อัพเดท lastUsed timestamp
      clientData.lastUsed = Date.now();
    }

    const isForwarding = intervalsMap.has(userId);
    const storedMessages = messagesMap.get(userId) || [];

    res.json({
      success: true,
      isActive: isForwarding,
      messageCount: storedMessages.length,
      isClientConnected: !!clientData?.client,
      clientInfo: clientData ? {
        createdAt: new Date(clientData.createdAt).toISOString(),
        lastUsed: new Date(clientData.lastUsed).toISOString(),
        uptime: Date.now() - clientData.createdAt
      } : null,
      lastMessage: storedMessages[0] ? {
        messageId: storedMessages[0].id,
        text: storedMessages[0].message,
        date: new Date(storedMessages[0].date * 1000)
      } : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getForwardingStatusFromDB = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const clientData = clientsMap.get(userId);
    if (clientData) {
      clientData.lastUsed = Date.now();
    }

    const [rows] = await db.execute(
      'SELECT status, forward_interval FROM forward WHERE userid = ?',
      [userId]
    );

    const status = rows.length > 0 ? rows[0].status : 0;
    const forward_interval = rows.length > 0 ? rows[0].forward_interval : null;

    res.json({
      status: status,
      forward_interval: forward_interval,
      userId,
      clientInfo: clientData ? {
        createdAt: new Date(clientData.createdAt).toISOString(),
        lastUsed: new Date(clientData.lastUsed).toISOString(),
        uptime: Date.now() - clientData.createdAt
      } : null
    });

  } catch (error) {
    console.error('Error fetching forwarding status:', error);
    res.status(500).json({ 
      error: 'Failed to fetch forwarding status',
      details: error.message 
    });
  }
};

// เพิ่ม cleanup routine
const cleanupInactiveClients = async () => {
    const now = Date.now();
    for (const [userId, clientData] of clientsMap.entries()) {
        if (now - clientData.lastUsed > CLIENT_TIMEOUT) {
            console.log(`Cleaning up inactive client for user: ${userId}`);
            try {
                await clientData.client.disconnect();
                clientsMap.delete(userId);
                intervalsMap.delete(userId);
                messagesMap.delete(userId);
                userBatchSizesMap.delete(userId);
            } catch (error) {
                console.error(`Error cleaning up client for user ${userId}:`, error);
            }
        }
    }
};

// เริ่ม cleanup routine
setInterval(cleanupInactiveClients, CLEANUP_INTERVAL);

module.exports = {
  handleInitialize,
  startContinuousAutoForward,
  beginForwarding,
  stopContinuousAutoForward,
  checkForwardingStatus,
  getForwardingStatusFromDB
};
