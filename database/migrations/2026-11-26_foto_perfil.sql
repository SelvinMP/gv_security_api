-- Foto de perfil de los usuarios.
-- La API crea esta columna sola al arrancar (src/config/ensureSchema.js); este script es la referencia manual.
-- Solo se guarda la ruta relativa del archivo (avatars/<archivo>); la imagen vive en storage/avatars
-- del servidor (o en STORAGE_ROOT/avatars si se configura un disco persistente).

ALTER TABLE TBL_MS_USUARIO
  ADD COLUMN FOTO_PERFIL VARCHAR(255) NULL DEFAULT NULL
    COMMENT 'Ruta relativa de la foto de perfil (avatars/<archivo>); la imagen vive en el servidor';
