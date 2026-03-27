const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

// Importamos la conexión a la base de datos
const { connectDB } = require('./config/db');
// Importamos las rutas
const authRoutes = require('./routes/authRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const reservationRoutes = require('./routes/reservationRoutes');
const visitorRoutes = require('./routes/visitorRoutes');

const app = express();

// 1. Middlewares de Seguridad y Control
app.use(helmet()); 
app.use(morgan('dev')); 
app.use(express.json()); 

// CONFIGURACIÓN DE CORS (Solo una vez y con tu URL)
app.use(cors({
  origin: 'https://gv-security.web.app', 
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// 2. Conexión a la Base de Datos (GV-Security)
connectDB();

// 3. Rutas de la API
console.log('Iniciando registro de rutas...');
app.use('/api/auth', authRoutes);
app.use('/api/reservas', reservationRoutes);
app.use('/api/visitantes', visitorRoutes);
app.use('/api', notificationRoutes);
console.log('Rutas registradas exitosamente');

app.get('/', (req, res) => {
    res.json({
        message: "Bienvenido a la API de GV-Security",
        status: "Online",
        timestamp: new Date()
    });
});

app.post('/api/check-connection', (req, res) => {
    console.log('Datos recibidos de React:', req.body);
    res.json({ success: true, message: "Conexión exitosa con el Backend" });
});

// 4. Configuración del Puerto (Optimizado para Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('==============================================');
    console.log(`🚀 Servidor corriendo en puerto: ${PORT}`);
    console.log('==============================================');
});