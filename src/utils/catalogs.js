/**
 * Catálogos de mantenimiento (tablas maestras simples).
 * CRUD genérico usado por /api/admin/maintenance/:table
 *
 * Cada campo:
 *  - name:      columna en la BD
 *  - required:  obligatorio al crear/editar
 *  - max:       longitud máxima (varchar)
 *  - upper:     se guarda en MAYÚSCULAS
 *  - type:      'text' (default) | 'bool'
 *  - unique:    no se permiten duplicados (comparación sin mayúsculas/minúsculas)
 *
 * usedBy: tablas que usan el registro. Si está en uso, no se permite eliminarlo
 * (varias de estas columnas no tienen llave foránea en la BD).
 */
const { mysqlPool } = require('../config/db');

const CATALOGS = {
  motivos: {
    table: 'TBL_MOTIVOS',
    pk: 'ID_MOTIVO',
    label: 'motivo de visita',
    fields: [
      { name: 'MOTIVO', required: true, max: 100, upper: true, unique: true },
      { name: 'DESCRIPCION', max: 255 }
    ]
  },
  parentescos: {
    table: 'TBL_PARENTESCOS',
    pk: 'ID_PARENTESCO',
    label: 'parentesco',
    usedBy: [{ table: 'TBL_PERSONAS', label: 'residente(s)' }],
    fields: [{ name: 'DESCRIPCION', required: true, max: 150, unique: true }]
  },
  tipos_contacto: {
    table: 'TBL_TIPO_CONTACTO',
    pk: 'ID_TIPO_CONTACTO',
    label: 'tipo de contacto',
    usedBy: [{ table: 'TBL_CONTACTOS', label: 'contacto(s)' }],
    fields: [{ name: 'DESCRIPCION', required: true, max: 100, unique: true }]
  },
  tipos_solicitud: {
    table: 'TBL_TIPO_SOLICITUD',
    pk: 'ID_TIPO_SOLICITUD',
    label: 'tipo de solicitud',
    usedBy: [{ table: 'TBL_SOLICITUDES', label: 'solicitud(es)' }],
    fields: [
      { name: 'DESCRIPCION', required: true, max: 50, upper: true, unique: true },
      { name: 'DETALLE', max: 255 }
    ]
  },
  tamanos_paquete: {
    table: 'TBL_TAMANO_PAQUETE',
    pk: 'ID_TAMANO_PAQUETE',
    label: 'tamaño de paquete',
    usedBy: [{ table: 'TBL_PAQUETES', label: 'paquete(s)' }],
    fields: [
      { name: 'DESCRIPCION', required: true, max: 50, upper: true, unique: true },
      { name: 'DIMENSIONES_MAXIMAS', max: 100 },
      { name: 'PERMITIDO', type: 'bool', required: true }
    ]
  },
  tipos_condominio: {
    table: 'TBL_TIPO_CONDOMINIO',
    pk: 'ID_TIPO_CONDOMINIO',
    label: 'tipo de condominio',
    usedBy: [{ table: 'TBL_CONDOMINIOS', label: 'condominio(s)' }],
    fields: [{ name: 'DESCRIPCION', required: true, max: 100, upper: true, unique: true }]
  },
  categorias_politica: {
    table: 'TBL_CATEGORIA_POLITICA',
    pk: 'ID_CATEGORIA',
    label: 'categoría de política',
    usedBy: [{ table: 'TBL_POLITICAS', label: 'política(s)' }],
    fields: [{ name: 'DESCRIPCION', required: true, max: 80, upper: true, unique: true }]
  },
  tipos_persona: {
    table: 'TBL_TIPO_PERSONAS',
    pk: 'ID_TIPO_PERSONA',
    label: 'tipo de persona',
    usedBy: [{ table: 'TBL_PERSONAS', label: 'persona(s)' }],
    fields: [{ name: 'DESCRIPCION', required: true, max: 100, upper: true, unique: true }]
  }
};

const isCatalog = (table) => Object.prototype.hasOwnProperty.call(CATALOGS, table);

/** Normaliza y valida los valores recibidos. Devuelve { values } o { error }. */
const buildValues = (cfg, body, isCreate) => {
  const values = {};
  for (const f of cfg.fields) {
    const raw = body[f.name];
    const provided = raw !== undefined;

    if (!provided && !isCreate) continue; // en edición solo se actualiza lo enviado

    if (f.type === 'bool') {
      const v = raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;
      values[f.name] = provided ? v : 1;
      continue;
    }

    let v = raw === null || raw === undefined ? '' : String(raw).trim();
    if (f.upper) v = v.toUpperCase();

    if (f.required && !v) {
      return { error: `El campo ${f.name.replace(/_/g, ' ').toLowerCase()} es obligatorio.` };
    }
    if (f.max && v.length > f.max) {
      return { error: `El campo ${f.name.replace(/_/g, ' ').toLowerCase()} admite máximo ${f.max} caracteres.` };
    }
    values[f.name] = v === '' ? null : v;
  }
  return { values };
};

/** Verifica duplicados en campos marcados como únicos. */
const findDuplicate = async (connection, cfg, values, excludeId = null) => {
  for (const f of cfg.fields.filter(x => x.unique)) {
    if (values[f.name] === undefined || values[f.name] === null) continue;
    const params = [values[f.name]];
    let sql = `SELECT ${cfg.pk} FROM ${cfg.table} WHERE UPPER(TRIM(${f.name})) = UPPER(?)`;
    if (excludeId !== null) {
      sql += ` AND ${cfg.pk} <> ?`;
      params.push(excludeId);
    }
    const [rows] = await connection.query(sql, params);
    if (rows.length > 0) return `Ya existe un ${cfg.label} con ese valor (${values[f.name]}).`;
  }
  return null;
};

const listCatalog = async (req, res) => {
  const { table } = req.params;
  const cfg = CATALOGS[table];
  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const cols = [cfg.pk, ...cfg.fields.map(f => f.name)].join(', ');
    const [rows] = await connection.query(`SELECT ${cols} FROM ${cfg.table} ORDER BY ${cfg.pk} ASC`);
    res.status(200).json({ success: true, table, data: rows });
  } catch (error) {
    console.error(`Error al consultar catálogo ${table}:`, error);
    res.status(500).json({ success: false, message: 'Error interno al consultar el catálogo.' });
  } finally {
    if (connection) connection.release();
  }
};

const createCatalog = async (req, res) => {
  const { table } = req.params;
  const cfg = CATALOGS[table];
  const { values, error } = buildValues(cfg, req.body || {}, true);
  if (error) return res.status(400).json({ success: false, message: error });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const dup = await findDuplicate(connection, cfg, values);
    if (dup) return res.status(409).json({ success: false, message: dup });

    const cols = Object.keys(values);
    await connection.query(
      `INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => values[c])
    );
    res.status(201).json({ success: true, message: `Registro de ${cfg.label} creado con éxito.` });
  } catch (error) {
    console.error(`Error al crear en catálogo ${table}:`, error);
    res.status(500).json({ success: false, message: 'Error interno al crear el registro.' });
  } finally {
    if (connection) connection.release();
  }
};

const updateCatalog = async (req, res) => {
  const { table, id } = req.params;
  const cfg = CATALOGS[table];
  const { values, error } = buildValues(cfg, req.body || {}, false);
  if (error) return res.status(400).json({ success: false, message: error });

  const cols = Object.keys(values);
  if (cols.length === 0) return res.status(400).json({ success: false, message: 'No se enviaron campos para actualizar.' });

  let connection;
  try {
    connection = await mysqlPool.getConnection();
    const dup = await findDuplicate(connection, cfg, values, id);
    if (dup) return res.status(409).json({ success: false, message: dup });

    const [result] = await connection.query(
      `UPDATE ${cfg.table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE ${cfg.pk} = ?`,
      [...cols.map(c => values[c]), id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Registro no encontrado.' });
    res.status(200).json({ success: true, message: `Registro de ${cfg.label} actualizado correctamente.` });
  } catch (error) {
    console.error(`Error al actualizar catálogo ${table}:`, error);
    res.status(500).json({ success: false, message: 'Error interno al actualizar el registro.' });
  } finally {
    if (connection) connection.release();
  }
};

const deleteCatalog = async (req, res) => {
  const { table, id } = req.params;
  const cfg = CATALOGS[table];
  let connection;
  try {
    connection = await mysqlPool.getConnection();

    for (const ref of cfg.usedBy || []) {
      const [[{ total }]] = await connection.query(
        `SELECT COUNT(*) AS total FROM ${ref.table} WHERE ${cfg.pk} = ?`, [id]
      );
      if (Number(total) > 0) {
        return res.status(409).json({
          success: false,
          message: `No se puede eliminar: este ${cfg.label} está asignado a ${total} ${ref.label}.`
        });
      }
    }

    const [result] = await connection.query(`DELETE FROM ${cfg.table} WHERE ${cfg.pk} = ?`, [id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Registro no encontrado.' });
    res.status(200).json({ success: true, message: `Registro de ${cfg.label} eliminado con éxito.` });
  } catch (error) {
    // 1451: registro referenciado por otra tabla (llave foránea)
    if (error && (error.errno === 1451 || error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED')) {
      return res.status(409).json({
        success: false,
        message: `No se puede eliminar: este ${cfg.label} está siendo utilizado por otros registros del sistema.`
      });
    }
    console.error(`Error al eliminar en catálogo ${table}:`, error);
    res.status(500).json({ success: false, message: 'Error interno al eliminar el registro.' });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { CATALOGS, isCatalog, listCatalog, createCatalog, updateCatalog, deleteCatalog };
