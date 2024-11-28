const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();
const port = process.env.PORT || 3123;

// กำหนดค่า CORS options
const corsOptions = {
  origin: true, // อนุญาตทุก origin (แนะนำให้ใช้ true แทน '*')
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'], // เพิ่ม 'Accept' header
  exposedHeaders: ['Content-Range', 'X-Content-Range'], // เพิ่ม exposed headers ถ้าจำเป็น
  credentials: true,
};

app.use(cors(corsOptions));

app.use(express.json());

// นำเข้า routes
const { getMainInfo } = require('./routes');
const loginRoutes = require('./src/routers/LoginRoutes');
const registerRoutes = require('./src/routers/RegisterRoutes');
const configRoutes = require('./src/routers/ConfigRoutes');
// นำเข้า database connection
const db = require('./db');

app.get('/', getMainInfo);
app.use('/api/v1', loginRoutes);
app.use('/api/v1', registerRoutes);
app.use('/api/v1', configRoutes);

// เริ่ม server
const startServer = async () => {
  try {
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
      console.log(`🚀 Server ready at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
