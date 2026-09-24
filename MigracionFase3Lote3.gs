/**
 * ============================================================
 * MigracionFase3Lote3.gs · Wrappers Apps Script → RPC (Lote 3), solo staging
 * ============================================================
 * Fase 3 "Pieza 2" de la migración a Supabase, acotada al Lote 3 (ciclo de
 * vida de pedidos: borrar/cambiar flujo/reabrir + altas masivas/manual +
 * importación y resincronización) y SOLO contra el esquema `staging`.
 *
 * Reutiliza _rpcStaging_ / _restStaging_ / _dispararEnParalelo_ ya definidos
 * en MigracionFase3Lote1.gs (mismo proyecto, mismo scope global de Apps
 * Script -- NO se duplican aquí). Mismo motivo que Lotes 1 y 2: el esquema
 * va fijo en las cabeceras Accept-Profile/Content-Profile: 'staging' de esos
 * helpers, a propósito, para que sea físicamente imposible llamar a
 * `public` (producción real) desde aquí. Backend.gs NO se toca en este
 * bloque.
 */

// ============================================================
// Grupo A · Gestión simple de pedidos
// ============================================================

// Backend.gs real: borrarPedidoNoSacado(numPed) -- MISMA firma.
function borrarPedidoNoSacadoViaSupabase(numPed) {
  return _rpcStaging_('borrar_pedido_no_sacado', { p_num_ped: String(numPed) });
}

// Backend.gs real: cambiarFlujoPedido(numPed, nuevoFlujo) -- MISMA firma.
function cambiarFlujoPedidoViaSupabase(numPed, nuevoFlujo) {
  return _rpcStaging_('cambiar_flujo_pedido', { p_num_ped: String(numPed), p_nuevo_flujo: nuevoFlujo });
}

// Backend.gs real: cambiarFlujoPedidosMasivo(numeros, nuevoFlujo) -- MISMA firma.
function cambiarFlujoPedidosMasivoViaSupabase(numeros, nuevoFlujo) {
  return _rpcStaging_('cambiar_flujo_pedidos_masivo', { p_numeros: numeros, p_nuevo_flujo: nuevoFlujo });
}

// Backend.gs real: reabrirPedido(numPed, tienda) -- MISMA firma, tienda opcional.
function reabrirPedidoViaSupabase(numPed, tienda) {
  return _rpcStaging_('reabrir_pedido', { p_num_ped: String(numPed), p_tienda: tienda || null });
}

// ============================================================
// Grupo B · Altas de pedidos (masivas y manual)
// ============================================================

// Backend.gs real: registrarYaCargadosMasivo(numeros, tienda) -- MISMA firma.
function registrarYaCargadosMasivoViaSupabase(numeros, tienda) {
  return _rpcStaging_('registrar_ya_cargados_masivo', { p_numeros_pedido: numeros, p_tienda: tienda || null });
}

// Backend.gs real: registrarRecogidasMasivo(numeros, tienda) -- MISMA firma.
function registrarRecogidasMasivoViaSupabase(numeros, tienda) {
  return _rpcStaging_('registrar_recogidas_masivo', { p_numeros_pedido: numeros, p_tienda: tienda || null });
}

// Backend.gs real: registrarPedidoManual(datos) donde datos = {num, tienda,
// flujo, silueta, posIni, soportes, comentario}. EXCEPCIÓN DE FIRMA
// documentada (mismo criterio que moverPedidoDeSiluetaViaSupabase del Lote
// 1): la RPC necesita dos valores que el original calcula ANTES de escribir
// y que Postgres no puede derivar por sí solo --
//   p_posiciones: calcularPosiciones(soportes) (función pura, ya vive en
//     Backend.gs) si soportes trae algo; si soportes está vacío, el mismo
//     default que usa el original: [{back:true,front:'reservado'}] (UNA
//     posición reservada, NO []) -- por eso p_pos_ini nunca acaba siendo 0
//     a través de este wrapper (0 solo sale de la RPC si p_posiciones
//     llegara vacío de verdad, que el original nunca envía).
//   p_tiendas_pyxis: en el flujo real es Object.keys(entry.porTienda) del
//     inventario de Pyxis (cargarInventario) -- Postgres no puede leer
//     Drive. Para que el arnés de pruebas sea determinista (sin depender de
//     datos reales de Pyxis), este wrapper acepta datos.tiendasPyxis como
//     override EXPLÍCITO opcional en vez de leerlo de cargarInventario() --
//     si se omite, se manda null (mismo comportamiento que "el pedido no
//     está en NINGÚN inventario", que el original deja pasar sin más).
function registrarPedidoManualViaSupabase(datos) {
  var soportes = datos.soportes || [];
  var posiciones = soportes.length > 0 ? calcularPosiciones(soportes) : [{ back: true, front: 'reservado' }];
  return _rpcStaging_('registrar_pedido_manual', {
    p_num: String(datos.num || '').trim(), p_tienda: datos.tienda || '', p_flujo: datos.flujo || '',
    p_silueta: datos.silueta || '', p_pos_ini: (datos.posIni === undefined ? null : Number(datos.posIni)),
    p_soportes: soportes, p_comentario: datos.comentario || '', p_posiciones: posiciones,
    p_tiendas_pyxis: datos.tiendasPyxis || null
  });
}

// ============================================================
// Grupo C · Importación y resincronización
// ============================================================

// Backend.gs real: importarClasificacion(numerosPorTransporte, opciones) --
// FIRMA MUY DISTINTA (numerosPorTransporte agrupado por zona + opciones con
// tiendaColisiones/parciales/comentarios). Resuelve colisiones de tienda
// leyendo el índice de Pyxis (resolverOcurrencia/cargarInventario) -- eso
// vive fuera de este esquema. EXCEPCIÓN DE FIRMA grande y deliberada: este
// wrapper acepta `entradas` YA RESUELTAS, con la forma exacta que espera la
// RPC: [{ped, tienda, transporte, lineas:[{ref,dir,ean,des,ctd}], esParcial,
// comentario}]. 'transporte' es la ZONA del clasificador ('Transporte'|
// 'Instalaciones'|'PRO'|'Remansur'), no el nombre final del transportista.
// 'colisiones' en la respuesta SIEMPRE vuelve [] (no hay colisiones posibles
// a este nivel, ya llegan resueltas) -- no es un bug, es consecuencia
// directa de este recorte de alcance.
function importarClasificacionViaSupabase(entradas) {
  return _rpcStaging_('importar_clasificacion', { p_entradas: entradas });
}

// Backend.gs real: resincronizarPedidosActivos() -- SIN parámetros, lee
// cargarInventario() y las hojas PEDIDOS/LINEAS ella misma. EXCEPCIÓN DE
// FIRMA: este wrapper recibe `inventario` ya armado, forma [{ped, tienda,
// lineas:[...]}] -- para el arnés de pruebas, construir un array mínimo a
// mano en vez de depender del inventario real de Drive.
function resincronizarPedidosActivosViaSupabase(inventario) {
  return _rpcStaging_('resincronizar_pedidos_activos', { p_inventario: inventario });
}
