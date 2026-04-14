const nodemailer = require('nodemailer');
require('dotenv').config();

const emailPort = parseInt(process.env.EMAIL_PORT) || 587;

// Puerto 465 requiere SSL (secure: true). 587 usa STARTTLS (secure: false).
// Si EMAIL_SECURE está definido explícitamente, se respeta; de lo contrario se infiere del puerto.
const isSecure = process.env.EMAIL_SECURE !== undefined
  ? process.env.EMAIL_SECURE === 'true'
  : emailPort === 465;

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: emailPort,
  secure: isSecure,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false // Ayuda a evitar problemas en entornos con TLS estricto
  }
});

// Verificar conexión al arrancar (solo loguea, no detiene el servidor)
transporter.verify((error) => {
  if (error) {
    console.error('❌ Error al conectar con el servidor de correo:', error.message);
  } else {
    console.log('✅ Servidor de correo listo para enviar emails');
  }
});

module.exports = transporter;
