const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const db = require('../../db');

const clientsMap = new Map();
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
    clientsMap.set(userId, client);
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
    
    if (!userId || !sourceChatId || !Array.isArray(destinationChatIds)) {
      return res.status(400).json({
        error: 'Invalid parameters'
      });
    }

    const client = clientsMap.get(userId);
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

const autoForwardMessages = async (userId, sourceChatId, destinationChatIds) => {
  const client = clientsMap.get(userId);
  if (!client) throw new Error('Client not found');
  
  try {
    console.log(`Starting forward process to ${destinationChatIds.length} groups`);

    const chunkSize = 20;
    const chunks = [];
    const cooldownGroups = new Set();

    for (let i = 0; i < destinationChatIds.length; i += chunkSize) {
      chunks.push(destinationChatIds.slice(i, i + chunkSize));
    }

    let currentBatchSize = Math.min(userBatchSizesMap.get(userId) || 3, 3);
    console.log(`แบ่งการส่งเป็น ${chunks.length} chunks, batch size: ${currentBatchSize}`);

    // ส่งข้อความไปยังกลุ่มที่ไม่ติด cooldown
    for (let i = 0; i < chunks.length; i += currentBatchSize) {
      // ดึงข้อความล่าสุดก่อนส่งในแต่ละรอบ
      const latestMessages = await checkNewMessages(client, sourceChatId);
      if (!latestMessages || latestMessages.length === 0) {
        console.log('ไม่พบข้อความใหม่สำหรับการส่งในรอบนี้');
        continue;
      }
      const msg = latestMessages[0]; // ใช้ข้อความล่าสุด

      console.log(`Processing chunk ${i + 1}/${chunks.length} with message ID: ${msg.id}`);
      const currentBatch = chunks.slice(i, i + currentBatchSize);
      
      const results = await Promise.all(
        currentBatch.flatMap(chunk =>
          chunk.map(async destChatId => {
            const result = await forwardMessage(client, msg, sourceChatId, destChatId);
            if (!result) {
              const cooldownUntil = groupCooldowns.get(destChatId);
              if (cooldownUntil) {
                cooldownGroups.add(destChatId);
              }
            }
            return result;
          })
        )
      );

      const failedCount = results.filter(r => !r).length;
      if (failedCount > 0) {
        console.log(`${failedCount} groups failed in this batch`);
      }

      // พักระหว่าง batch
      if (i + currentBatchSize < chunks.length) {
        const delayTime = 5000;
        console.log(`Waiting ${delayTime/1000} seconds before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delayTime));
      }
    }

    // จัดการกลุ่มที่ติด cooldown แยก
    if (cooldownGroups.size > 0) {
      console.log(`มี ${cooldownGroups.size} กลุ่มที่ติด cooldown, เริ่มการส่งแยก`);
      
      const processCooldownGroups = async (client, msg, sourceChatId, cooldownGroups) => {
        try {
          const now = Date.now();
          const readyGroups = [];

          // ตรวจสอบและแสดงสถานะของทุกกลุ่ม
          for (const destChatId of cooldownGroups) {
            const cooldownUntil = groupCooldowns.get(destChatId);
            const timeLeft = cooldownUntil ? Math.ceil((cooldownUntil - now) / 1000) : 0;
            
            if (!cooldownUntil || now >= cooldownUntil + 2000) {
              console.log(`กลุ่ม ${destChatId} พร้อมส่ง (cooldown หมดแล้ว + 2 วินาที)`);
              readyGroups.push(destChatId);
            } else {
              console.log(`กลุ่ม ${destChatId} ยังไม่พร้อมส่ง: เหลือเวลา ${timeLeft} วินาที + 2 วินาที`);
            }
          }

          // ถ้ามีกลุ่มที่พร้อมส่ง
          if (readyGroups.length > 0) {
            console.log(`เริ่มส่งข้อความไปยัง ${readyGroups.length} กลุ่มที่พร้อมส่ง`);
            
            for (const destChatId of readyGroups) {
              console.log(`กำลังส่งข้อความไปยังกลุ่ม ${destChatId}`);
              const result = await forwardMessage(client, msg, sourceChatId, destChatId);
              
              if (result) {
                console.log(`✓ ส่งสำเร็จไปยังกลุ่ม ${destChatId}`);
                cooldownGroups.delete(destChatId);
              } else {
                console.log(`✗ ส่งไม่สำเร็จไปยังกลุ่ม ${destChatId}`);
                // ถ้าส่งไม่สำเร็จ ตรวจสอบ cooldown ใหม่
                const newCooldown = groupCooldowns.get(destChatId);
                if (newCooldown) {
                  console.log(`  → กลุ่ม ${destChatId} ได้รับ cooldown ใหม่: ${Math.ceil((newCooldown - now) / 1000)} วินาที`);
                }
              }
              
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }

          // ถ้ายังมีกลุ่มที่ติด cooldown
          if (cooldownGroups.size > 0) {
            const cooldownTimes = Array.from(cooldownGroups).map(id => {
              const cooldown = groupCooldowns.get(id) || 0;
              return { id, time: cooldown };
            });

            // เรียงลำดับตามเวลา cooldown
            cooldownTimes.sort((a, b) => a.time - b.time);
            
            const nextCooldown = cooldownTimes[0].time;
            const nextCheck = nextCooldown - now + 2000;
            
            console.log('\nสรุปสถานะ cooldown ที่เหลือ:');
            cooldownTimes.forEach(({ id, time }) => {
              const timeLeft = Math.ceil((time - now) / 1000);
              console.log(`- กลุ่ม ${id}: เหลือ ${timeLeft} วินาที`);
            });
            console.log(`\nจะตรวจสอบอีกครั้งใน ${Math.ceil(nextCheck/1000)} วินาที`);

            await new Promise(resolve => setTimeout(resolve, nextCheck));
            return processCooldownGroups(client, msg, sourceChatId, cooldownGroups);
          }
        } catch (error) {
          console.error('Error processing cooldown groups:', error);
          console.error('Error details:', error.message);
        }
      };

      await processCooldownGroups(client, msg, sourceChatId, cooldownGroups);
    }

    return true;
  } catch (error) {
    console.error('Error in auto forwarding:', error);
    throw error;
  }
};

const resetUserBatchSize = (userId) => {
  userBatchSizesMap.set(userId, 4);
};

const beginForwarding = async (req, res) => {
  try {
    const { userId, sourceChatId, destinationChatIds, interval = 5 } = req.body;
    
    const client = clientsMap.get(userId);
    if (!client) {
      return res.status(400).json({ error: 'Client not initialized' });
    }

    // Add database update before starting forward process
    try {
      await db.execute(
        'INSERT INTO forward (userid, status) VALUES (?, 1) ON DUPLICATE KEY UPDATE status = 1',
        [userId]
      );
      console.log(`Updated forwarding status for user ${userId} to active`);
    } catch (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({ error: 'Failed to update forwarding status' });
    }

    const groupCooldowns = await getGroupCooldowns(client, destinationChatIds);

    if (interval < 1 || interval > 60) {
      return res.status(400).json({
        error: 'Invalid interval (1-60 minutes)'
      });
    }

    // เก็บเพียงข้อความล่าสุด 1 ข้อความ
    const initialMessages = await checkNewMessages(client, sourceChatId);
    console.log(`Found ${initialMessages.length} message to forward repeatedly`);
    
    if (initialMessages.length > 0) {
      // เก็บเพียงข้อความเดียว
      messagesMap.set(userId, [initialMessages[0]]);
      console.log('Stored single message for repeated forwarding');
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
    const intervalMs = interval * 60 * 1000;
    const newInterval = setInterval(
      () => autoForwardMessages(userId, sourceChatId, destinationChatIds),
      intervalMs
    );

    intervalsMap.set(userId, newInterval);
    console.log(`Set new interval to forward every ${interval} minutes`);

    res.json({
      success: true,
      message: 'Forwarding started - will repeatedly forward initial messages',
      settings: { 
        intervalMinutes: interval,
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
    
    // Update database status to inactive
    try {
      await db.execute(
        'UPDATE forward SET status = 0 WHERE userid = ?',
        [userId]
      );
      console.log(`Updated forwarding status for user ${userId} to inactive`);
    } catch (dbError) {
      console.error('Database error:', dbError);
      // Continue with stopping even if DB update fails
    }

    if (intervalsMap.has(userId)) {
      clearInterval(intervalsMap.get(userId));
      intervalsMap.delete(userId);
      clientsMap.delete(userId);
      messagesMap.delete(userId);
      userBatchSizesMap.delete(userId);
      console.log(`Auto-forward stopped for user ${userId}`);
      res.json({ 
        success: true, 
        message: 'Auto-forward stopped successfully' 
      });
    } else {
      console.log(`No auto-forward was running for user ${userId}`);
      res.json({ 
        success: true, 
        message: 'No auto-forward was running' 
      });
    }
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

    const isForwarding = intervalsMap.has(userId);
    const storedMessages = messagesMap.get(userId) || [];
    const client = clientsMap.get(userId);

    res.json({
      success: true,
      isActive: isForwarding,
      messageCount: storedMessages.length,
      isClientConnected: !!client,
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

    const [rows] = await db.execute(
      'SELECT status FROM forward WHERE userid = ?',
      [userId]
    );

    const status = rows.length > 0 ? rows[0].status : 0;

    res.json({
      status: status,
      userId
    });

  } catch (error) {
    console.error('Error fetching forwarding status:', error);
    res.status(500).json({ 
      error: 'Failed to fetch forwarding status',
      details: error.message 
    });
  }
};

module.exports = {
  handleInitialize,
  startContinuousAutoForward,
  beginForwarding,
  stopContinuousAutoForward,
  checkForwardingStatus,
  getForwardingStatusFromDB
};
