-- =============================================================================
--  GV-SECURITY · MIGRACIÓN 2026-11-06
--  Requerimiento: el residente puede CANCELAR una visita (única o recurrente)
--  desde su historial. Al escanear el QR en el portón, el guardia ve el aviso
--  "Acceso denegado: visita cancelada" con fecha, hora y motivo.
--
--  Idempotente: puede ejecutarse más de una vez.
--  Ejecutar ANTES de desplegar la API que incluye la cancelación de visitas.
--
--    mysql -h <HOST_DB> -P <PUERTO> -u <USUARIO> -p railway < 2026-11-06_cancelacion_visitas.sql
-- =============================================================================

SET NAMES utf8mb4;

DROP PROCEDURE IF EXISTS `GV_ADD_COLUMN_IF_MISSING`;
DELIMITER $$
CREATE PROCEDURE `GV_ADD_COLUMN_IF_MISSING`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- Visitas de ingreso único
CALL GV_ADD_COLUMN_IF_MISSING('TBL_REGVISITAS', 'FECHA_CANCELACION',
  'DATETIME NULL DEFAULT NULL COMMENT ''Fecha/hora (Honduras) en que el residente canceló la visita''');
CALL GV_ADD_COLUMN_IF_MISSING('TBL_REGVISITAS', 'MOTIVO_CANCELACION',
  'VARCHAR(255) NULL DEFAULT NULL COMMENT ''Motivo indicado por el residente''');

-- Visitas recurrentes (visitante frecuente)
CALL GV_ADD_COLUMN_IF_MISSING('TBL_VISITANTES_RECURRENTES', 'FECHA_CANCELACION',
  'DATETIME NULL DEFAULT NULL COMMENT ''Fecha/hora (Honduras) en que el residente canceló la visita''');
CALL GV_ADD_COLUMN_IF_MISSING('TBL_VISITANTES_RECURRENTES', 'MOTIVO_CANCELACION',
  'VARCHAR(255) NULL DEFAULT NULL COMMENT ''Motivo indicado por el residente''');

DROP PROCEDURE IF EXISTS `GV_ADD_COLUMN_IF_MISSING`;
