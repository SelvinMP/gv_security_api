-- =============================================================================
--  GV-SECURITY · MIGRACIÓN 2026-11-10
--  Requerimiento: funciones opcionales de Inteligencia Artificial (preguntas
--  sobre el reglamento, asistente del residente y lectura de identidad/placa
--  por foto). La administración las enciende o apaga desde el panel.
--
--  Crea la tabla de consumo, usada para el tope mensual de la residencial, el
--  tope diario por usuario y el reporte de consumo del panel.
--
--  La configuración se guarda en TBL_MS_PARAMETROS (se crea sola al guardar
--  desde el panel): IA_HABILITADA, IA_REGLAMENTO, IA_ASISTENTE, IA_FOTOS,
--  IA_ANALITICA, IA_SOLICITUDES, IA_LIMITE_MENSUAL, IA_LIMITE_DIARIO_USUARIO.
--  Sin esos parámetros la IA queda apagada. Solo el Super Administrador
--  (ID_ROL = 1) puede cambiarlos desde el panel.
--
--  Idempotente: puede ejecutarse más de una vez. La API también crea esta
--  tabla al arrancar (src/config/ensureSchema.js).
--
--    mysql -h <HOST_DB> -P <PUERTO> -u <USUARIO> -p railway < 2026-11-10_inteligencia_artificial.sql
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS TBL_IA_USO (
  ID_USO INT NOT NULL AUTO_INCREMENT,
  ID_USUARIO INT NULL,
  FUNCION VARCHAR(30) NOT NULL COMMENT 'reglamento, asistente, fotos',
  MODELO VARCHAR(60) NOT NULL,
  TOKENS_ENTRADA INT NOT NULL DEFAULT 0,
  TOKENS_SALIDA INT NOT NULL DEFAULT 0,
  FECHA DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ID_USO),
  KEY IDX_IA_USO_FECHA (FECHA),
  KEY IDX_IA_USO_USUARIO_FECHA (ID_USUARIO, FECHA)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
