const express = require('express');
const app = express();
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const port = process.env.PORT || 3123;

// กำหนดค่า CORS options
const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());

// นำเข้า routes
const routes = require('./routes');
const loginRoutes = require('./src/routers/LoginRoutes');
const registerRoutes = require('./src/routers/RegisterRoutes');
const userRoutes = require('./src/routers/UserRoutes');
const protectedRoutes = require('./src/routers/protectedRoutes');

// นำเข้า database connection
const db = require('./db');

app.get('/', (req, res) => {
  res.json(routes.endpoints);
});

// เพิ่ม middleware สำหรับ login routes
app.use('/api/v1', loginRoutes);

// เริ่ม middleware สำหรับ register routes
app.use('/api/v1', registerRoutes);

// เริ่ม middleware สำหรับ user routes
app.use('/api/v1', userRoutes);

// เริ่ม middleware สำหรับ protected routes
app.use('/api/v1', protectedRoutes);


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
