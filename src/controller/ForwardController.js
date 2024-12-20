const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const db = require('../../db');

const clientsMap = new Map();
const intervalsMap = new Map();
const messagesMap = new Map();

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
    const chat = await client.getEntity(destChatId);
    if (chat.slowmode_enabled) {
      console.log(`กลุ่ม ${destChatId} มี cooldown ${chat.slowmode_seconds} วินาที`);
      await new Promise(resolve => setTimeout(resolve, chat.slowmode_seconds * 1000));
    }

    await client.forwardMessages(destChatId, {
      messages: [msg.id],
      fromPeer: sourceChatId,
    });
    console.log(`Successfully forwarded message ID: ${msg.id} to ${destChatId}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(`Failed to forward message ${msg.id} to ${destChatId}:`, error.message);
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
    // ใช้ข้อความชุดเดิมที่เก็บไว้ตั้งแต่ต้น forward ซ้ำๆ
    const messagesToForward = messagesMap.get(userId);
    
    console.log(`Starting to forward ${messagesToForward?.length || 0} stored messages`);

    if (messagesToForward?.length) {
      for (const msg of messagesToForward) {
        for (const destChatId of destinationChatIds) {
          await forwardMessage(client, msg, sourceChatId, destChatId);
        }
      }
      console.log('Completed forwarding cycle');
    }

    return messagesToForward?.length || 0;
  } catch (error) {
    console.error('Error in auto forwarding:', error);
    throw error;
  }
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
