// Zona horaria oficial: Honduras (debe ir antes de cargar cualquier módulo)
process.env.TZ = 'America/Tegucigalpa';

const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

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
const guardiaRoutes = require('./routes/guardiaRoutes');
const adminRoutes = require('./routes/adminRoutes');
const packageRoutes = require('./routes/packageRoutes');
const eventRoutes = require('./routes/eventRoutes');
const requestRoutes = require('./routes/requestRoutes');

const app = express();

// 1. Middlewares de Seguridad y Control
app.use(morgan('dev')); 
app.use(express.json()); 

// CONFIGURACIÓN DE CORS (Permitir todo en desarrollo para que funcione desde el celular)
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));

const path = require('path');

// Servir archivos estáticos subidos en el servidor (imágenes de anuncios, avatares, fotos)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));



// 2. Conexión a la Base de Datos (GV-Security) y verificación de columnas requeridas
const { ensureSchema } = require('./config/ensureSchema');
connectDB().then(ensureSchema);

// 3. Rutas de la API
console.log('Iniciando registro de rutas...');
app.use('/api/auth', authRoutes);
app.use('/api/reservas', reservationRoutes);
app.use('/api/visitantes', visitorRoutes);
app.use('/api/guardia', guardiaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/paquetes', packageRoutes);
app.use('/api/eventos', eventRoutes);
app.use('/api/solicitudes', requestRoutes);
app.use('/api', notificationRoutes);
// Compatibilidad directa para llamadas móviles sin prefijo /api/auth
app.use('/', authRoutes);
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

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 4. Configuración del Puerto (Optimizado para Render)
// Render asigna dinámicamente process.env.PORT (usualmente 10000) y requiere enlazar a 0.0.0.0
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log('==============================================');
    console.log(`🚀 Servidor corriendo en http://${HOST}:${PORT}`);
    console.log('==============================================');
});