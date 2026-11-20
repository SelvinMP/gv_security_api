-- Sesión única por usuario y dispositivo de confianza.
-- La API crea estas columnas sola al arrancar (src/config/ensureSchema.js); este script es la referencia manual.
-- Privacidad: solo se guardan hashes. No se guarda IP, ubicación ni historial de accesos.

ALTER TABLE TBL_MS_USUARIO
  ADD COLUMN SESION_ID CHAR(64) NULL DEFAULT NULL
    COMMENT 'SHA-256 del id de la única sesión abierta; NULL = sin sesión',
  ADD COLUMN DISPOSITIVO_ID CHAR(64) NULL DEFAULT NULL
    COMMENT 'HMAC del identificador aleatorio del dispositivo de confianza';
