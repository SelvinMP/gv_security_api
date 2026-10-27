const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Asegurar que el directorio de subidas exista
const uploadDir = path.join(__dirname, '../../uploads/anuncios');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuración de almacenamiento en disco del servidor
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, `anuncio_${uniqueSuffix}${ext || '.jpg'}`);
  }
});

// Filtro para aceptar únicamente formatos de imagen válidos
const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExtensions.includes(ext) || (file.mimetype && file.mimetype.startsWith('image/'))) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten imágenes (JPG, PNG, WEBP, GIF).'), false);
  }
};

const uploadAnuncio = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 Megabytes máximo
  }
});

module.exports = { uploadAnuncio, uploadDir };
