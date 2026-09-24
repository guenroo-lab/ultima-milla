/**
 * ============================================================
 * Incidencias.gs
 * Módulo de incidencias: administración da de alta, el equipo de
 * operarios las trabaja desde el móvil con un hilo de comentarios
 * (texto + fotos). Siempre ligadas a un pedido existente.
 * Ver docs/superpowers/specs/2026-09-24-incidencias-operario-admin-design.md
 * ============================================================
 */

// === FOTOS (Google Drive) ===

function _carpetaIncidenciasRaiz_() {
  var id = getIncidenciasFolderId();
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* ID inválido: se recrea abajo */ }
  }
  var carpeta = DriveApp.createFolder('Incidencias LM Málaga');
  setIncidenciasFolderId(carpeta.getId());
  return carpeta;
}

function _subcarpetaIncidencia_(idIncidencia, ped) {
  var raiz = _carpetaIncidenciasRaiz_();
  var nombre = 'INC-' + idIncidencia + '-' + ped;
  var it = raiz.getFoldersByName(nombre);
  if (it.hasNext()) return it.next();
  return raiz.createFolder(nombre);
}

/**
 * Guarda UNA foto (base64) en la subcarpeta de la incidencia, la comparte
 * por enlace de dominio (si no, el operario que no sea el dueño del
 * archivo ve un icono roto en vez de la foto) y devuelve su fileId.
 */
function _guardarFotoIncidencia(idIncidencia, ped, base64, mime) {
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mime || 'image/jpeg', idIncidencia + '_' + new Date().getTime() + '.jpg');
  var carpeta = _subcarpetaIncidencia_(idIncidencia, ped);
  var archivo = carpeta.createFile(blob);
  archivo.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  return archivo.getId();
}

/**
 * Guarda hasta 4 fotos (array de { base64, mime }), en orden, ignorando
 * silenciosamente cualquiera que falle (no debe bloquear el resto).
 * Devuelve el array de fileIds guardados.
 */
function _guardarFotosIncidencia(idIncidencia, ped, fotosBase64) {
  var ids = [];
  (fotosBase64 || []).slice(0, 4).forEach(function(f) {
    if (!f || !f.base64) return;
    try { ids.push(_guardarFotoIncidencia(idIncidencia, ped, f.base64, f.mime)); }
    catch (e) { console.error('Error guardando foto de incidencia:', e); }
  });
  return ids;
}

// === CREAR (solo administración) ===

/**
 * Crea una incidencia sobre un pedido YA existente (idPedido = PEDIDOS.id).
 * El texto de indicaciones se guarda como el PRIMER comentario del hilo
 * (rol='admin') — no hay un campo de "indicaciones" aparte.
 */
function crearIncidencia(idPedido, tipo, prioridad, asignado, texto, fotosBase64) {
  var pedido = buscarFilaPorCampo('PEDIDOS', 'id', idPedido);
  if (!pedido) return { ok: false, error: 'Pedido no encontrado' };
  var txt = String(texto || '').trim();
  if (!txt) return { ok: false, error: 'Escribe las indicaciones para el equipo' };

  var ahora = new Date().toISOString();
  var idIncidencia = 'INC_' + new Date().getTime();

  anadirFila('INCIDENCIAS', {
    id: idIncidencia,
    idPedido: pedido.id,
    ped: pedido.ped,
    tienda: pedido.tienda,
    tipo: tipo,
    prioridad: prioridad || 'NORMAL',
    estado: 'PENDIENTE',
    asignado: asignado || '',
    creadoPor: 'Administración',
    creadoTs: ahora,
    actualizado: ahora
  });

  var fotoIds = _guardarFotosIncidencia(idIncidencia, pedido.ped, fotosBase64 || []);
  anadirFila('INC_COMENTARIOS', {
    id: 'INCC_' + new Date().getTime(),
    idIncidencia: idIncidencia,
    autor: 'Administración',
    rol: 'admin',
    texto: txt,
    fotos: fotoIds,
    ts: ahora
  });

  logActividad('INCIDENCIA_CREADA', 'Incidencia ' + idIncidencia + ' · pedido ' + pedido.ped + ' (' + tipo + ')', 'admin');
  return { ok: true, id: idIncidencia };
}

// === LISTAR Y VER DETALLE ===

/**
 * filtros = { estado, tienda, tipo, asignado } — todos opcionales. Para
 * "asignado": pasar '' explícitamente filtra el pool (sin asignar); no
 * pasar la clave devuelve todos los asignados y sin asignar mezclados.
 */
function listarIncidencias(filtros) {
  filtros = filtros || {};
  var filas = leerHoja('INCIDENCIAS');
  var res = filas.filter(function(f) {
    if (filtros.estado && f.estado !== filtros.estado) return false;
    if (filtros.tienda && f.tienda !== filtros.tienda) return false;
    if (filtros.tipo && f.tipo !== filtros.tipo) return false;
    if (filtros.asignado !== undefined && filtros.asignado !== null && String(f.asignado || '') !== String(filtros.asignado)) return false;
    return true;
  });
  res.sort(function(a, b) { return String(b.actualizado || '').localeCompare(String(a.actualizado || '')); });
  return res.map(function(f) {
    return {
      id: f.id, ped: f.ped, tienda: f.tienda, tipo: f.tipo, prioridad: f.prioridad,
      estado: f.estado, asignado: f.asignado || '', creadoPor: f.creadoPor,
      creadoTs: f.creadoTs, actualizado: f.actualizado
    };
  });
}

function obtenerIncidenciaConComentarios(idIncidencia) {
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  var comentarios = buscarFilasPorCampo('INC_COMENTARIOS', 'idIncidencia', idIncidencia);
  comentarios.sort(function(a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  return {
    ok: true,
    incidencia: {
      id: inc.id, ped: inc.ped, tienda: inc.tienda, tipo: inc.tipo, prioridad: inc.prioridad,
      estado: inc.estado, asignado: inc.asignado || '', creadoPor: inc.creadoPor, creadoTs: inc.creadoTs
    },
    comentarios: comentarios.map(function(c) {
      return { id: c.id, autor: c.autor, rol: c.rol, texto: c.texto, fotos: parseJSON(c.fotos, []), ts: c.ts };
    })
  };
}

// === HILO DE COMENTARIOS (admin y operario) ===

/**
 * Añade un comentario (texto y/o fotos) al hilo. Si quien comenta es un
 * operario: si la incidencia estaba sin 'asignado' se autoasigna a
 * 'autor', y si estaba PENDIENTE pasa a EN_CURSO. Un comentario de admin
 * nunca cambia asignado ni estado — solo da indicaciones.
 */
function anadirComentarioIncidencia(idIncidencia, autor, rol, texto, fotosBase64) {
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  if (inc.estado === 'RESUELTA' || inc.estado === 'CANCELADA') return { ok: false, error: 'Esta incidencia ya está cerrada' };

  var txt = String(texto || '').trim();
  var fotos = fotosBase64 || [];
  if (!txt && !fotos.length) return { ok: false, error: 'Escribe un texto o adjunta una foto' };

  var ahora = new Date().toISOString();
  var fotoIds = _guardarFotosIncidencia(idIncidencia, inc.ped, fotos);

  anadirFila('INC_COMENTARIOS', {
    id: 'INCC_' + new Date().getTime(),
    idIncidencia: idIncidencia, autor: autor, rol: rol, texto: txt, fotos: fotoIds, ts: ahora
  });

  var cambios = { actualizado: ahora };
  if (rol === 'operario') {
    if (!inc.asignado) cambios.asignado = autor;
    if (inc.estado === 'PENDIENTE') cambios.estado = 'EN_CURSO';
  }
  actualizarFila('INCIDENCIAS', inc._fila, cambios);

  return { ok: true };
}

// === CERRAR (Resolver / Cancelar) Y REASIGNAR ===

/**
 * nuevoEstado: 'RESUELTA' (operario) o 'CANCELADA' (admin). Exige texto
 * (nota final) y solo es válido desde PENDIENTE/EN_CURSO — una incidencia
 * ya cerrada no se puede volver a cerrar.
 */
function cambiarEstadoIncidencia(idIncidencia, nuevoEstado, autor, rol, texto, fotosBase64) {
  if (nuevoEstado !== 'RESUELTA' && nuevoEstado !== 'CANCELADA') return { ok: false, error: 'Estado no válido' };
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  if (inc.estado !== 'PENDIENTE' && inc.estado !== 'EN_CURSO') return { ok: false, error: 'Esta incidencia ya está cerrada' };
  var txt = String(texto || '').trim();
  if (!txt) return { ok: false, error: 'Escribe una nota antes de cerrar la incidencia' };

  var ahora = new Date().toISOString();
  var fotoIds = _guardarFotosIncidencia(idIncidencia, inc.ped, fotosBase64 || []);

  anadirFila('INC_COMENTARIOS', {
    id: 'INCC_' + new Date().getTime(),
    idIncidencia: idIncidencia, autor: autor, rol: rol, texto: txt, fotos: fotoIds, ts: ahora
  });

  actualizarFila('INCIDENCIAS', inc._fila, { estado: nuevoEstado, actualizado: ahora });
  logActividad('INCIDENCIA_' + nuevoEstado, 'Incidencia ' + idIncidencia + ' · pedido ' + inc.ped, autor);
  return { ok: true };
}

// Solo la llama la UI de admin.
function reasignarIncidencia(idIncidencia, nuevoAsignado) {
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  actualizarFila('INCIDENCIAS', inc._fila, { asignado: nuevoAsignado || '', actualizado: new Date().toISOString() });
  return { ok: true };
}

/**
 * Prueba manual — ejecutar desde el editor de Apps Script (Ejecutar →
 * probarIncidencias). Crea una incidencia de prueba sobre el PRIMER
 * pedido que encuentre (no afecta a datos reales del pedido, solo añade
 * una fila en INCIDENCIAS/INCIDENCIAS_COMENTARIOS — se puede borrar a
 * mano después desde la hoja).
 */
function probarIncidencias() {
  var pedidos = leerHoja('PEDIDOS');
  if (!pedidos.length) { Logger.log('No hay pedidos para probar.'); return; }
  var pedido = pedidos[0];
  var r = crearIncidencia(pedido.id, 'OTRA', 'NORMAL', '', 'Prueba automática desde probarIncidencias()', []);
  Logger.log('crearIncidencia: ' + JSON.stringify(r));
  if (!r.ok) return;
  var detalle = obtenerIncidenciaConComentarios(r.id);
  Logger.log('obtenerIncidenciaConComentarios: ' + JSON.stringify(detalle));
  var com = anadirComentarioIncidencia(r.id, 'Operario de prueba', 'operario', 'Comentario de prueba', []);
  Logger.log('anadirComentarioIncidencia: ' + JSON.stringify(com));
  var cierre = cambiarEstadoIncidencia(r.id, 'RESUELTA', 'Operario de prueba', 'operario', 'Resuelta en la prueba', []);
  Logger.log('cambiarEstadoIncidencia: ' + JSON.stringify(cierre));
}
