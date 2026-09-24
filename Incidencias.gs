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
