/**
 * ============================================================
 * PruebasLote3Staging.gs · Pruebas funcionales y de concurrencia del Lote 3
 * ============================================================
 * Todas las pruebas siembran sus propios pedidos/líneas/cargas sintéticos
 * (prefijo TEST_LOTE3_, silueta ficticia ZTEST) en `staging` y los limpian
 * en un `finally`, pase o falle la prueba. Ejecutar ejecutarTodoLote3Staging()
 * (primera función del archivo, autoseleccionada en el editor) para
 * correrlas todas en orden, o cualquier función ejecutar... individual para
 * depurar una sola.
 *
 * LECCIÓN del Lote 2 (hallazgo real de la verificación adversarial,
 * confirmado en ejecución): 3 funciones de este lote crean pedidos.id NUEVO
 * del lado del SERVIDOR con un formato que NO empieza por el prefijo
 * TEST_LOTE3_ (registrar_ya_cargados_masivo -> 'YAC_'+num+epoch_ms,
 * registrar_recogidas_masivo -> 'REC_'+num+epoch_ms, registrar_pedido_manual
 * / importar_clasificacion -> codigoTienda+'::'+num). En los tres casos el
 * id SÍ CONTIENE el número de pedido tal cual, así que el chequeo de
 * residuos y la limpieza defensiva de este archivo filtran SIEMPRE por la
 * columna 'ped', nunca por 'id' -- un filtro por 'id like TEST_LOTE3_*'
 * sería ciego a esas filas.
 */

var SILUETA_PRUEBA_LOTE3 = 'ZTEST';
var RESPONSABLE_PRUEBA_LOTE3 = 'TEST_LOTE3_MARCADOR';

/**
 * Runner maestro del Lote 3: limpia cualquier residuo de una ejecución
 * anterior interrumpida (por 'ped', ver cabecera), ejecuta las 10 pruebas
 * (9 funcionales + 1 de concurrencia) en orden, para en el primer fallo, y
 * verifica al final que no quedó ningún residuo. Colocada a propósito como
 * PRIMERA función del archivo, mismo motivo que en los Lotes 1 y 2.
 */
function ejecutarTodoLote3Staging() {
  _limpiarTodoResiduoLote3_();

  var pruebas = [
    ejecutarPruebaBorrarPedidoNoSacadoLote3,
    ejecutarPruebaCambiarFlujoPedidoLote3,
    ejecutarPruebaCambiarFlujoPedidosMasivoLote3,
    ejecutarPruebaReabrirPedidoLote3,
    ejecutarPruebaRegistrarYaCargadosMasivoLote3,
    ejecutarPruebaRegistrarRecogidasMasivoLote3,
    ejecutarPruebaRegistrarPedidoManualLote3,
    ejecutarPruebaImportarClasificacionLote3,
    ejecutarPruebaResincronizarPedidosActivosLote3,
    ejecutarConcurrenciaYaCargadosLote3
  ];
  for (var i = 0; i < pruebas.length; i++) {
    try {
      pruebas[i]();
    } catch (e) {
      Logger.log('*** PARADO en la prueba #' + (i + 1) + ' (' + pruebas[i].name + '): ' + e.message + ' ***');
      return;
    }
  }

  var pedidosResiduales = _restStaging_('get', 'pedidos?ped=like.TEST_LOTE3_*&select=id');
  var ocupacionResidual = _restStaging_('get', 'ocupacion_siluetas?pedido=like.TEST_LOTE3_*&select=silueta,pos');
  var cargasResiduales = _restStaging_('get',
    'cargas?or=(id.like.TEST_LOTE3_*,responsable.eq.' + encodeURIComponent(RESPONSABLE_PRUEBA_LOTE3) + ')&select=id');
  var totalResiduos = pedidosResiduales.length + ocupacionResidual.length + cargasResiduales.length;
  Logger.log(totalResiduos === 0
    ? '=== TODAS LAS PRUEBAS DEL LOTE 3 PASARON, sin residuos TEST_LOTE3_ ==='
    : '*** ADVERTENCIA: quedaron ' + pedidosResiduales.length + ' pedidos, ' + ocupacionResidual.length +
      ' ocupaciones y ' + cargasResiduales.length + ' cargas residuales -- revisar limpieza ***');
}

/**
 * Borra CUALQUIER rastro de pruebas del Lote 3 que pueda haber quedado de
 * una ejecución anterior (interrumpida o fallida) -- por 'ped' (pedidos,
 * ocupacion_siluetas) y por 'id'/marcador de responsable (cargas). Se llama
 * al INICIO del runner, antes de sembrar nada nuevo.
 */
function _limpiarTodoResiduoLote3_() {
  var peds = _restStaging_('get', 'pedidos?ped=like.TEST_LOTE3_*&select=ped').map(function(p) { return p.ped; });
  var cargas = _restStaging_('get',
    'cargas?or=(id.like.TEST_LOTE3_*,responsable.eq.' + encodeURIComponent(RESPONSABLE_PRUEBA_LOTE3) + ')&select=id');
  var cargaIds = cargas.map(function(c) { return c.id; });
  if (peds.length || cargaIds.length) {
    Logger.log('Limpieza defensiva previa: ' + peds.length + ' pedido(s) + ' + cargaIds.length + ' carga(s) de una ejecución anterior');
    _limpiarPruebaLote3_(peds, cargaIds);
  }
}

/**
 * Siembra un pedido sintético en staging.pedidos con valores por defecto
 * razonables (PENDIENTE, sin silueta, sin líneas). `opts` permite forzar
 * cualquier columna (estado, transportista, flujo, silueta, posIni, posFin,
 * numeroCarga, soportes, nLin, nUbic, parcial, comentario, operario, pct).
 */
function _sembrarPedidoLote3_(id, ped, tienda, opts) {
  opts = opts || {};
  var fila = {
    id: id, ped: ped, tienda: tienda,
    transportista: opts.hasOwnProperty('transportista') ? opts.transportista : 'Correcaminos',
    flujo: opts.flujo || 'transporte',
    estado: opts.estado || 'PENDIENTE',
    pct: opts.pct === undefined ? 0 : opts.pct,
    operario: opts.hasOwnProperty('operario') ? opts.operario : null,
    silueta: opts.hasOwnProperty('silueta') ? opts.silueta : null,
    pos_ini: opts.hasOwnProperty('posIni') ? opts.posIni : null,
    pos_fin: opts.hasOwnProperty('posFin') ? opts.posFin : null,
    numero_carga: opts.hasOwnProperty('numeroCarga') ? opts.numeroCarga : null,
    soportes: opts.soportes || [],
    n_lin: opts.nLin === undefined ? 0 : opts.nLin,
    n_ubic: opts.nUbic === undefined ? 0 : opts.nUbic,
    parcial: !!opts.parcial,
    comentario: opts.hasOwnProperty('comentario') ? opts.comentario : null,
    actualizado: new Date().toISOString()
  };
  _restStaging_('post', 'pedidos', [fila]);
  return fila;
}

/** Siembra una fila en staging.lineas_preparacion para un idPedido ya sembrado. */
function _sembrarLineaLote3_(idPedido, idx, opts) {
  opts = opts || {};
  var fila = {
    id: idPedido + '::L' + idx, id_pedido: idPedido, idx: idx,
    dir: opts.dir || 'PASILLO_TEST', ref: opts.ref || ('REF_TEST_' + idx), ean: opts.ean || null,
    des: opts.des || 'Artículo de prueba', ctd: opts.ctd === undefined ? 1 : opts.ctd,
    tipo_ubic: opts.tipoUbic || 'palet', es_picking: !!opts.esPicking,
    estado: opts.estado || 'PENDIENTE', motivo: null, operario: null, ts: null
  };
  _restStaging_('post', 'lineas_preparacion', [fila]);
  return fila;
}

/** Siembra una carga sintética en staging.cargas, marcada con el responsable de prueba. */
function _sembrarCargaLote3_(id, numCarga, estado) {
  var fila = {
    id: id, num_carga: String(numCarga), fecha: new Date().toISOString().slice(0, 10),
    estado: estado || 'GENERADA', responsable: RESPONSABLE_PRUEBA_LOTE3
  };
  _restStaging_('post', 'cargas', [fila]);
  return fila;
}

/** Vincula un pedido a una carga en cargas_pedidos, sin pasar por ninguna RPC. */
function _sembrarCargaPedidoLote3_(idCarga, idPedido, posicion) {
  _restStaging_('post', 'cargas_pedidos', [{ carga_id: idCarga, pedido_id: idPedido, posicion: posicion }]);
}

/**
 * Borra TODO rastro de una tanda de prueba del Lote 3: primero
 * lineas_preparacion y cargas_pedidos (por el id real de cada pedido -- hay
 * que resolverlo primero porque 3 funciones del lote generan un id nuevo
 * del lado del servidor, ver cabecera), luego ocupacion_siluetas (por
 * 'pedido', columna de texto = número de pedido) y pedidos (por 'ped'), y
 * por último las cargas sembradas a mano. Cada DELETE fallido se loguea con
 * detalle en vez de tragarse en silencio.
 */
function _limpiarPruebaLote3_(peds, cargaIds) {
  if (peds && peds.length) {
    var filtroPed = 'ped=in.(' + peds.map(encodeURIComponent).join(',') + ')';
    var filasPedidos = _restStaging_('get', 'pedidos?' + filtroPed + '&select=id');
    var ids = filasPedidos.map(function(r) { return r.id; });
    if (ids.length) {
      var filtroIdPedido = 'id_pedido=in.(' + ids.map(encodeURIComponent).join(',') + ')';
      try { _restStaging_('delete', 'lineas_preparacion?' + filtroIdPedido); }
      catch (e) { Logger.log('⚠ _limpiarPruebaLote3_ (lineas_preparacion, filtro=' + filtroIdPedido + '): ' + e.message); }
      var filtroPedidoId = 'pedido_id=in.(' + ids.map(encodeURIComponent).join(',') + ')';
      try { _restStaging_('delete', 'cargas_pedidos?' + filtroPedidoId); }
      catch (e) { Logger.log('⚠ _limpiarPruebaLote3_ (cargas_pedidos por pedido_id, filtro=' + filtroPedidoId + '): ' + e.message); }
    }
    var filtroOcupacion = 'pedido=in.(' + peds.map(encodeURIComponent).join(',') + ')';
    try { _restStaging_('delete', 'ocupacion_siluetas?' + filtroOcupacion); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote3_ (ocupacion_siluetas, filtro=' + filtroOcupacion + '): ' + e.message); }
    try { _restStaging_('delete', 'pedidos?' + filtroPed); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote3_ (pedidos, filtro=' + filtroPed + '): ' + e.message); }
  }
  if (cargaIds && cargaIds.length) {
    var filtroCargaId = 'carga_id=in.(' + cargaIds.map(encodeURIComponent).join(',') + ')';
    try { _restStaging_('delete', 'cargas_pedidos?' + filtroCargaId); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote3_ (cargas_pedidos por carga_id, filtro=' + filtroCargaId + '): ' + e.message); }
    var filtroCarga = 'id=in.(' + cargaIds.map(encodeURIComponent).join(',') + ')';
    try { _restStaging_('delete', 'cargas?' + filtroCarga); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote3_ (cargas, filtro=' + filtroCarga + '): ' + e.message); }
  }
}

/** Assert mínimo: compara y lanza con mensaje claro si no coincide. */
function _assertLote3_(cond, mensaje) {
  if (!cond) throw new Error('FAIL: ' + mensaje);
  Logger.log('PASS: ' + mensaje);
}

// ============================================================
// Grupo A · Gestión simple de pedidos
// ============================================================

/**
 * Prueba funcional de borrarPedidoNoSacadoViaSupabase -- 4 casos:
 * 1) sin silueta, línea PENDIENTE -> se borra entero (pedido + líneas).
 * 2) pedido no encontrado -> error específico.
 * 3) pedido con silueta asignada -> rechazado, cita la silueta.
 * 4) línea ya tocada (no PENDIENTE) -> rechazado, no borra nada.
 */
function ejecutarPruebaBorrarPedidoNoSacadoLote3() {
  var peds = [];
  try {
    _sembrarPedidoLote3_('TEST_LOTE3_BOR_1', 'TEST_LOTE3_BOR_1', 'Málaga', { nLin: 1 });
    _sembrarLineaLote3_('TEST_LOTE3_BOR_1', 0, {});
    peds.push('TEST_LOTE3_BOR_1');
    var r1 = borrarPedidoNoSacadoViaSupabase('TEST_LOTE3_BOR_1');
    _assertLote3_(r1.ok === true, 'Caso 1 (sin silueta, sin tocar): ok=true (' + JSON.stringify(r1) + ')');
    _assertLote3_(r1.lineasBorradas === 1, 'Caso 1: 1 línea borrada');
    _assertLote3_(_restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_BOR_1&select=id').length === 0, 'Caso 1: la fila de pedidos ya no existe');
    _assertLote3_(_restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE3_BOR_1&select=id').length === 0, 'Caso 1: la línea ya no existe');

    var r2 = borrarPedidoNoSacadoViaSupabase('TEST_LOTE3_BOR_NOEXISTE');
    _assertLote3_(r2.ok === false && r2.error === 'Pedido no encontrado', 'Caso 2: pedido inexistente');

    _sembrarPedidoLote3_('TEST_LOTE3_BOR_3', 'TEST_LOTE3_BOR_3', 'Málaga', { silueta: SILUETA_PRUEBA_LOTE3, posIni: '1', posFin: '1' });
    peds.push('TEST_LOTE3_BOR_3');
    var r3 = borrarPedidoNoSacadoViaSupabase('TEST_LOTE3_BOR_3');
    _assertLote3_(r3.ok === false && r3.error.indexOf('Este pedido ya está en la silueta ' + SILUETA_PRUEBA_LOTE3) === 0,
      'Caso 3 (con silueta): rechazado (' + JSON.stringify(r3) + ')');

    _sembrarPedidoLote3_('TEST_LOTE3_BOR_4', 'TEST_LOTE3_BOR_4', 'Málaga', { nLin: 1 });
    _sembrarLineaLote3_('TEST_LOTE3_BOR_4', 0, { estado: 'PREPARADO' });
    peds.push('TEST_LOTE3_BOR_4');
    var r4 = borrarPedidoNoSacadoViaSupabase('TEST_LOTE3_BOR_4');
    _assertLote3_(r4.ok === false && r4.error.indexOf('Un operario ya ha empezado') === 0,
      'Caso 4 (línea tocada): rechazado (' + JSON.stringify(r4) + ')');

    Logger.log('=== ejecutarPruebaBorrarPedidoNoSacadoLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

/**
 * Prueba funcional de cambiarFlujoPedidoViaSupabase -- 4 casos:
 * 1) cambio simple, sin silueta -> PEDIDOS actualizado.
 * 2) pedido con silueta -> también pinta OCUPACION (silueta+tienda+pedido).
 * 3) flujo inválido -> error genérico.
 * 4) pedido no encontrado -> error específico.
 */
function ejecutarPruebaCambiarFlujoPedidoLote3() {
  var peds = [];
  try {
    _sembrarPedidoLote3_('TEST_LOTE3_CFP_1', 'TEST_LOTE3_CFP_1', 'Málaga', { flujo: 'transporte', transportista: 'Correcaminos' });
    peds.push('TEST_LOTE3_CFP_1');
    var r1 = cambiarFlujoPedidoViaSupabase('TEST_LOTE3_CFP_1', 'remansur_transporte');
    _assertLote3_(r1.ok === true && r1.flujo === 'remansur_transporte' && r1.transportista === 'Remansur',
      'Caso 1 (cambio simple): ok=true, Remansur (' + JSON.stringify(r1) + ')');
    var p1 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_CFP_1&select=flujo,transportista')[0];
    _assertLote3_(p1.flujo === 'remansur_transporte' && p1.transportista === 'Remansur', 'Caso 1: PEDIDOS actualizado');

    _sembrarPedidoLote3_('TEST_LOTE3_CFP_2', 'TEST_LOTE3_CFP_2', 'Málaga', { flujo: 'transporte', silueta: SILUETA_PRUEBA_LOTE3, posIni: '1', posFin: '1' });
    peds.push('TEST_LOTE3_CFP_2');
    _restStaging_('post', 'ocupacion_siluetas', [
      { silueta: SILUETA_PRUEBA_LOTE3, pos: '1', layer: 'back', pedido: 'TEST_LOTE3_CFP_2', tienda: 'Málaga', flujo: 'transporte', reservado: false }
    ]);
    var r2 = cambiarFlujoPedidoViaSupabase('TEST_LOTE3_CFP_2', 'instalacion');
    _assertLote3_(r2.ok === true, 'Caso 2 (con silueta): ok=true (' + JSON.stringify(r2) + ')');
    var ocup2 = _restStaging_('get', 'ocupacion_siluetas?silueta=eq.' + SILUETA_PRUEBA_LOTE3 + '&pos=eq.1&layer=eq.back&pedido=eq.TEST_LOTE3_CFP_2&select=flujo')[0];
    _assertLote3_(ocup2.flujo === 'instalacion', 'Caso 2: OCUPACION también actualizada a instalacion');

    var r3 = cambiarFlujoPedidoViaSupabase('TEST_LOTE3_CFP_1', 'flujo_que_no_existe');
    _assertLote3_(r3.ok === false && r3.error === 'Tipo de transporte no válido', 'Caso 3: flujo inválido');

    var r4 = cambiarFlujoPedidoViaSupabase('TEST_LOTE3_CFP_NOEXISTE', 'transporte');
    _assertLote3_(r4.ok === false && r4.error === 'Pedido no encontrado', 'Caso 4: pedido inexistente');

    Logger.log('=== ejecutarPruebaCambiarFlujoPedidoLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

/**
 * Prueba funcional de cambiarFlujoPedidosMasivoViaSupabase -- 4 casos:
 * 1) 2 pedidos válidos + 1 repetido en la lista -> cambiados=2.
 * 2) número inexistente -> noEncontrados.
 * 3) número ambiguo (mismo ped, 2 tiendas) -> cae en ambiguos, no en noEncontrados.
 * 4) flujo inválido -> error genérico.
 */
function ejecutarPruebaCambiarFlujoPedidosMasivoLote3() {
  var peds = [];
  try {
    _sembrarPedidoLote3_('TEST_LOTE3_CFM_1', 'TEST_LOTE3_CFM_1', 'Málaga', {});
    _sembrarPedidoLote3_('TEST_LOTE3_CFM_2', 'TEST_LOTE3_CFM_2', 'Málaga', {});
    peds.push('TEST_LOTE3_CFM_1', 'TEST_LOTE3_CFM_2');
    var r1 = cambiarFlujoPedidosMasivoViaSupabase(['TEST_LOTE3_CFM_1', 'TEST_LOTE3_CFM_1', 'TEST_LOTE3_CFM_2'], 'pro');
    _assertLote3_(r1.ok === true && r1.cambiados === 2, 'Caso 1 (2 válidos, 1 repetido): cambiados=2 (' + JSON.stringify(r1) + ')');
    var p1 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_CFM_1&select=transportista')[0];
    _assertLote3_(p1.transportista === 'Correcaminos PRO', 'Caso 1: transportista actualizado a PRO');

    var r2 = cambiarFlujoPedidosMasivoViaSupabase(['TEST_LOTE3_CFM_NOEXISTE'], 'transporte');
    _assertLote3_(r2.ok === true && r2.cambiados === 0 && r2.noEncontrados.length === 1, 'Caso 2: noEncontrados (' + JSON.stringify(r2) + ')');

    _sembrarPedidoLote3_('TEST_LOTE3_CFM_DUP_A', 'TEST_LOTE3_CFM_DUP', 'Málaga', {});
    _sembrarPedidoLote3_('TEST_LOTE3_CFM_DUP_B', 'TEST_LOTE3_CFM_DUP', 'Marbella', {});
    peds.push('TEST_LOTE3_CFM_DUP');
    var r3 = cambiarFlujoPedidosMasivoViaSupabase(['TEST_LOTE3_CFM_DUP'], 'transporte');
    _assertLote3_(r3.ok === true && r3.cambiados === 0 && r3.ambiguos.length === 1 && r3.ambiguos[0] === 'TEST_LOTE3_CFM_DUP',
      'Caso 3 (ambiguo): cae en ambiguos, no en noEncontrados (' + JSON.stringify(r3) + ')');

    var r4 = cambiarFlujoPedidosMasivoViaSupabase(['TEST_LOTE3_CFM_1'], 'flujo_invalido');
    _assertLote3_(r4.ok === false && r4.error === 'Tipo de transporte no válido', 'Caso 4: flujo inválido');

    Logger.log('=== ejecutarPruebaCambiarFlujoPedidosMasivoLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

/**
 * Prueba funcional de reabrirPedidoViaSupabase -- 5 casos:
 * 1) terminal, sin tienda -> vuelve a PENDIENTE, líneas reseteadas.
 * 2) NO terminal -> rechazado.
 * 3) vinculado a carga GENERADA -> tras reabrir, vínculo eliminado.
 * 4) tienda ambigua (mismo ped, 2 tiendas, sin especificar) -> rechazado.
 * 5) misma pareja ambigua, CON tienda -> resuelve el correcto, el otro intacto.
 */
function ejecutarPruebaReabrirPedidoLote3() {
  var peds = []; var cargaIds = [];
  try {
    _sembrarPedidoLote3_('TEST_LOTE3_REAB_1', 'TEST_LOTE3_REAB_1', 'Málaga', {
      estado: 'ENTREGADO', silueta: SILUETA_PRUEBA_LOTE3, posIni: '1', posFin: '1', nLin: 1
    });
    _sembrarLineaLote3_('TEST_LOTE3_REAB_1', 0, { estado: 'PREPARADO' });
    peds.push('TEST_LOTE3_REAB_1');
    var r1 = reabrirPedidoViaSupabase('TEST_LOTE3_REAB_1');
    _assertLote3_(r1.ok === true && r1.nLineas === 1, 'Caso 1 (terminal, sin tienda): ok=true (' + JSON.stringify(r1) + ')');
    var p1 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_REAB_1&select=estado,silueta')[0];
    _assertLote3_(p1.estado === 'PENDIENTE' && p1.silueta === null, 'Caso 1: pedido vuelve a PENDIENTE sin silueta');
    var l1 = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE3_REAB_1&select=estado')[0];
    _assertLote3_(l1.estado === 'PENDIENTE', 'Caso 1: línea reseteada a PENDIENTE');

    _sembrarPedidoLote3_('TEST_LOTE3_REAB_2', 'TEST_LOTE3_REAB_2', 'Málaga', { estado: 'PENDIENTE' });
    peds.push('TEST_LOTE3_REAB_2');
    var r2 = reabrirPedidoViaSupabase('TEST_LOTE3_REAB_2');
    _assertLote3_(r2.ok === false && r2.error.indexOf('Este pedido no está en un estado que se pueda reabrir') === 0,
      'Caso 2 (no terminal): rechazado (' + JSON.stringify(r2) + ')');

    var carga = _sembrarCargaLote3_('TEST_LOTE3_REAB_CARGA', 950, 'GENERADA');
    cargaIds.push(carga.id);
    _sembrarPedidoLote3_('TEST_LOTE3_REAB_3', 'TEST_LOTE3_REAB_3', 'Málaga', { estado: 'ENTREGADO', numeroCarga: '950' });
    peds.push('TEST_LOTE3_REAB_3');
    _sembrarCargaPedidoLote3_(carga.id, 'TEST_LOTE3_REAB_3', 0);
    var r3 = reabrirPedidoViaSupabase('TEST_LOTE3_REAB_3');
    _assertLote3_(r3.ok === true, 'Caso 3 (vinculado a carga): ok=true (' + JSON.stringify(r3) + ')');
    var vinculo3 = _restStaging_('get', 'cargas_pedidos?carga_id=eq.' + carga.id + '&pedido_id=eq.TEST_LOTE3_REAB_3&select=carga_id');
    _assertLote3_(vinculo3.length === 0, 'Caso 3: el vínculo con la carga GENERADA desapareció');

    _sembrarPedidoLote3_('TEST_LOTE3_REAB_DUP_A', 'TEST_LOTE3_REAB_DUP', 'Málaga', { estado: 'ENTREGADO' });
    _sembrarPedidoLote3_('TEST_LOTE3_REAB_DUP_B', 'TEST_LOTE3_REAB_DUP', 'Marbella', { estado: 'ENTREGADO' });
    peds.push('TEST_LOTE3_REAB_DUP');
    var r4 = reabrirPedidoViaSupabase('TEST_LOTE3_REAB_DUP');
    _assertLote3_(r4.ok === false && r4.error.indexOf('Hay varios pedidos con este número') === 0,
      'Caso 4 (ambiguo, sin tienda): rechazado (' + JSON.stringify(r4) + ')');

    var r5 = reabrirPedidoViaSupabase('TEST_LOTE3_REAB_DUP', 'Marbella');
    _assertLote3_(r5.ok === true, 'Caso 5 (ambiguo, con tienda): resuelve el de Marbella (' + JSON.stringify(r5) + ')');
    var pDupA = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_REAB_DUP_A&select=estado')[0];
    _assertLote3_(pDupA.estado === 'ENTREGADO', 'Caso 5: el de Málaga NO se tocó (sigue ENTREGADO)');

    Logger.log('=== ejecutarPruebaReabrirPedidoLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, cargaIds);
  }
}

// ============================================================
// Grupo B · Altas de pedidos (masivas y manual)
// ============================================================

/**
 * Prueba funcional de registrarYaCargadosMasivoViaSupabase -- 5 casos:
 * 1) pedido inexistente -> alta nueva, id server-generado con prefijo YAC_.
 * 2) pedido existente en estado terminal -> reconvertido, comentario fijado.
 * 3) pedido existente NO terminal -> yaExistian, sin tocar.
 * 4) pedido ya en Ya Cargados -> yaExistian específico.
 * 5) número repetido en la lista pegada -> solo 1 alta.
 */
function ejecutarPruebaRegistrarYaCargadosMasivoLote3() {
  var peds = [];
  try {
    var r1 = registrarYaCargadosMasivoViaSupabase(['TEST_LOTE3_YAC_1'], 'Málaga');
    peds.push('TEST_LOTE3_YAC_1');
    _assertLote3_(r1.ok === true && r1.anadidos === 1 && r1.reconvertidos === 0, 'Caso 1 (nuevo): anadidos=1 (' + JSON.stringify(r1) + ')');
    var p1 = _restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_YAC_1&select=id,estado,silueta,operario')[0];
    _assertLote3_(p1.estado === 'COMPLETADO_LISTO' && p1.silueta === 'Ya Cargados' && p1.operario === 'Ya Cargado',
      'Caso 1: fila creada con silueta ficticia Ya Cargados');
    _assertLote3_(p1.id.indexOf('YAC_TEST_LOTE3_YAC_1_') === 0, 'Caso 1: id server-generado con prefijo YAC_ (' + p1.id + ')');

    _sembrarPedidoLote3_('TEST_LOTE3_YAC_2', 'TEST_LOTE3_YAC_2', 'Málaga', { estado: 'ENTREGADO', transportista: 'Remansur', flujo: 'remansur_transporte' });
    peds.push('TEST_LOTE3_YAC_2');
    var r2 = registrarYaCargadosMasivoViaSupabase(['TEST_LOTE3_YAC_2'], null);
    _assertLote3_(r2.ok === true && r2.reconvertidos === 1 && r2.anadidos === 0, 'Caso 2 (terminal): reconvertidos=1 (' + JSON.stringify(r2) + ')');
    var p2 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_YAC_2&select=silueta,transportista,comentario')[0];
    _assertLote3_(p2.silueta === 'Ya Cargados' && p2.transportista === 'Remansur', 'Caso 2: reconvertido sin tocar transportista');
    _assertLote3_(p2.comentario === 'Pedido ya cargado anteriormente', 'Caso 2: comentario fijado');

    _sembrarPedidoLote3_('TEST_LOTE3_YAC_3', 'TEST_LOTE3_YAC_3', 'Málaga', { estado: 'EN_PREPARACION' });
    peds.push('TEST_LOTE3_YAC_3');
    var r3 = registrarYaCargadosMasivoViaSupabase(['TEST_LOTE3_YAC_3'], null);
    _assertLote3_(r3.ok === true && r3.anadidos === 0 && r3.reconvertidos === 0 && r3.yaExistian.length === 1,
      'Caso 3 (no terminal): yaExistian (' + JSON.stringify(r3) + ')');
    var p3 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_YAC_3&select=estado')[0];
    _assertLote3_(p3.estado === 'EN_PREPARACION', 'Caso 3: no se tocó el pedido');

    var r4 = registrarYaCargadosMasivoViaSupabase(['TEST_LOTE3_YAC_1'], null);
    _assertLote3_(r4.ok === true && r4.yaExistian.length === 1 && r4.yaExistian[0].indexOf('ya está en Ya Cargados') !== -1,
      'Caso 4 (ya en Ya Cargados): yaExistian (' + JSON.stringify(r4) + ')');

    var r5 = registrarYaCargadosMasivoViaSupabase(['TEST_LOTE3_YAC_5', 'TEST_LOTE3_YAC_5'], 'Málaga');
    peds.push('TEST_LOTE3_YAC_5');
    _assertLote3_(r5.ok === true && r5.anadidos === 1 && r5.yaExistian.length === 1 && r5.yaExistian[0].indexOf('repetido') !== -1,
      'Caso 5 (repetido en la lista): solo 1 alta, el resto marcado repetido (' + JSON.stringify(r5) + ')');

    Logger.log('=== ejecutarPruebaRegistrarYaCargadosMasivoLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

/**
 * Prueba funcional de registrarRecogidasMasivoViaSupabase -- 2 casos
 * (comparte estructura con Ya Cargados, ya probada arriba; aquí solo se
 * cubren las DIFERENCIAS reales entre las dos RPC):
 * 1) pedido inexistente -> alta nueva, id server-generado con prefijo REC_.
 * 2) reconversión desde terminal FUERZA transportista=Correcaminos/flujo=
 *    transporte (a diferencia de Ya Cargados, que deja el que ya tenía) Y
 *    NO toca 'comentario' (a diferencia de Ya Cargados, que sí lo fija).
 */
function ejecutarPruebaRegistrarRecogidasMasivoLote3() {
  var peds = [];
  try {
    var r1 = registrarRecogidasMasivoViaSupabase(['TEST_LOTE3_REC_1'], 'Marbella');
    peds.push('TEST_LOTE3_REC_1');
    _assertLote3_(r1.ok === true && r1.anadidos === 1, 'Caso 1 (nuevo): anadidos=1 (' + JSON.stringify(r1) + ')');
    var p1 = _restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_REC_1&select=id,silueta,operario')[0];
    _assertLote3_(p1.id.indexOf('REC_TEST_LOTE3_REC_1_') === 0, 'Caso 1: id server-generado con prefijo REC_ (' + p1.id + ')');
    _assertLote3_(p1.silueta === 'Recogidas' && p1.operario === 'Recogidas', 'Caso 1: silueta ficticia Recogidas');

    _sembrarPedidoLote3_('TEST_LOTE3_REC_2', 'TEST_LOTE3_REC_2', 'Marbella', {
      estado: 'ENTREGADO', transportista: 'Remansur PRO', flujo: 'remansur_pro', comentario: 'nota previa'
    });
    peds.push('TEST_LOTE3_REC_2');
    var r2 = registrarRecogidasMasivoViaSupabase(['TEST_LOTE3_REC_2'], null);
    _assertLote3_(r2.ok === true && r2.reconvertidos === 1, 'Caso 2 (terminal): reconvertido (' + JSON.stringify(r2) + ')');
    var p2 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE3_REC_2&select=transportista,flujo,comentario')[0];
    _assertLote3_(p2.transportista === 'Correcaminos' && p2.flujo === 'transporte',
      'Caso 2: transportista FORZADO a Correcaminos/transporte (era Remansur PRO)');
    _assertLote3_(p2.comentario === 'nota previa', 'Caso 2: comentario NO se toca en Recogidas (a diferencia de Ya Cargados)');

    Logger.log('=== ejecutarPruebaRegistrarRecogidasMasivoLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

/**
 * Prueba funcional de registrarPedidoManualViaSupabase -- 6 casos:
 * 1) alta nueva con soportes -> 2 filas OCUPACION (back+front) en la posición.
 * 2) alta nueva SIN soportes -> 1 posición reservada por defecto (front reservado).
 * 3) posición ya ocupada -> rechazado.
 * 4) pedido existente se ACTUALIZA (no duplica fila), libera la posición vieja.
 * 5) tienda no coincide con tiendasPyxis -> rechazado.
 * 6) silueta desconocida -> rechazado.
 */
function ejecutarPruebaRegistrarPedidoManualLote3() {
  var peds = [];
  try {
    var soportes1 = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    var r1 = registrarPedidoManualViaSupabase({
      num: 'TEST_LOTE3_MAN_1', tienda: 'Málaga', flujo: 'transporte', silueta: SILUETA_PRUEBA_LOTE3,
      posIni: 1, soportes: soportes1, comentario: ''
    });
    peds.push('TEST_LOTE3_MAN_1');
    _assertLote3_(r1.ok === true && r1.posIni === 1 && r1.posFin === 1, 'Caso 1 (alta con soportes): ok=true (' + JSON.stringify(r1) + ')');
    var ocup1 = _restStaging_('get', 'ocupacion_siluetas?silueta=eq.' + SILUETA_PRUEBA_LOTE3 + '&pos=eq.1&pedido=eq.TEST_LOTE3_MAN_1&select=layer');
    _assertLote3_(ocup1.length === 2, 'Caso 1: 2 filas OCUPACION (back+front)');

    var r2 = registrarPedidoManualViaSupabase({
      num: 'TEST_LOTE3_MAN_2', tienda: 'Málaga', flujo: 'transporte', silueta: SILUETA_PRUEBA_LOTE3,
      posIni: 2, soportes: [], comentario: ''
    });
    peds.push('TEST_LOTE3_MAN_2');
    _assertLote3_(r2.ok === true && r2.posIni === 2 && r2.posFin === 2, 'Caso 2 (sin soportes): ok=true (' + JSON.stringify(r2) + ')');
    var ocupFront2 = _restStaging_('get', 'ocupacion_siluetas?silueta=eq.' + SILUETA_PRUEBA_LOTE3 + '&pos=eq.2&layer=eq.front&pedido=eq.TEST_LOTE3_MAN_2&select=reservado')[0];
    _assertLote3_(ocupFront2.reservado === true, 'Caso 2: front reservado=true (default sin soportes)');

    var r3 = registrarPedidoManualViaSupabase({
      num: 'TEST_LOTE3_MAN_3', tienda: 'Málaga', flujo: 'transporte', silueta: SILUETA_PRUEBA_LOTE3,
      posIni: 1, soportes: soportes1, comentario: ''
    });
    _assertLote3_(r3.ok === false && r3.error === 'Posición ya ocupada', 'Caso 3 (posición ocupada): rechazado');

    var r4 = registrarPedidoManualViaSupabase({
      num: 'TEST_LOTE3_MAN_2', tienda: 'Málaga', flujo: 'transporte', silueta: SILUETA_PRUEBA_LOTE3,
      posIni: 3, soportes: [], comentario: 'actualizado'
    });
    _assertLote3_(r4.ok === true && r4.posIni === 3, 'Caso 4 (actualizar existente): ok=true, nueva pos 3 (' + JSON.stringify(r4) + ')');
    var pedidosMan2 = _restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_MAN_2&select=id');
    _assertLote3_(pedidosMan2.length === 1, 'Caso 4: sigue habiendo UNA sola fila de pedidos (no duplicó)');
    var ocupViejaLibre = _restStaging_('get', 'ocupacion_siluetas?silueta=eq.' + SILUETA_PRUEBA_LOTE3 + '&pos=eq.2&pedido=eq.TEST_LOTE3_MAN_2&select=silueta');
    _assertLote3_(ocupViejaLibre.length === 0, 'Caso 4: la posición 2 vieja quedó liberada');

    var r5 = registrarPedidoManualViaSupabase({
      num: 'TEST_LOTE3_MAN_5', tienda: 'Málaga', flujo: 'transporte', silueta: SILUETA_PRUEBA_LOTE3,
      posIni: 5, soportes: [], comentario: '', tiendasPyxis: ['Marbella', 'Mijas']
    });
    _assertLote3_(r5.ok === false && r5.error.indexOf('es de Marbella / Mijas') !== -1,
      'Caso 5 (tienda no coincide con Pyxis): rechazado (' + JSON.stringify(r5) + ')');

    var r6 = registrarPedidoManualViaSupabase({
      num: 'TEST_LOTE3_MAN_6', tienda: 'Málaga', flujo: 'transporte', silueta: 'SILUETA_QUE_NO_EXISTE',
      posIni: 1, soportes: soportes1, comentario: ''
    });
    _assertLote3_(r6.ok === false && r6.error === 'Silueta desconocida', 'Caso 6: silueta desconocida');

    Logger.log('=== ejecutarPruebaRegistrarPedidoManualLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

// ============================================================
// Grupo C · Importación y resincronización
// ============================================================

/**
 * Prueba funcional de importarClasificacionViaSupabase -- 9 casos:
 * 1) entrada nueva, zona Transporte -> alta creada.
 * 2) zona no mapeable -> se salta EN SILENCIO, no aparece en ninguna lista.
 * 3) tienda fuera de expedición (Granada) -> noEncontrados.
 * 4) pedido ya existe, terminal -> omitido "ya resuelto", no se toca.
 * 5) pedido ya existe, activo, líneas nuevas -> creados con detalle.
 * 6) mismo pedido, misma línea otra vez -> omitido "sin cambios".
 * 7) mismo pedido, transporte cambia -> creados con "transporte → X".
 * 8) dedup de líneas duplicadas (mismo ref+dir+ctd) al dar de alta.
 * 9) 'colisiones' siempre [] (recorte de alcance del wrapper).
 */
function ejecutarPruebaImportarClasificacionLote3() {
  var peds = [];
  try {
    var lineas1 = [{ ref: 'R1', dir: 'PASILLO1', ean: 'E1', des: 'Articulo 1', ctd: 2 }];
    var r1 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_1', tienda: 'Málaga', transporte: 'Transporte', lineas: lineas1, esParcial: false, comentario: '' }
    ]);
    peds.push('TEST_LOTE3_IMP_1');
    _assertLote3_(r1.ok === true && r1.creados.length === 1 && r1.creados[0] === 'TEST_LOTE3_IMP_1',
      'Caso 1 (alta nueva): creados (' + JSON.stringify(r1) + ')');
    var p1 = _restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_IMP_1&select=transportista,flujo,estado,n_lin')[0];
    _assertLote3_(p1.transportista === 'Correcaminos' && p1.flujo === 'transporte' && p1.estado === 'PENDIENTE' && p1.n_lin === 1,
      'Caso 1: pedido creado correctamente');

    var r2 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_2', tienda: 'Málaga', transporte: 'ZonaQueNoExiste', lineas: [], esParcial: false, comentario: '' }
    ]);
    _assertLote3_(r2.ok === true && r2.creados.length === 0 && r2.omitidos.length === 0 && r2.noEncontrados.length === 0,
      'Caso 2 (zona no mapeable): no aparece en ninguna lista (' + JSON.stringify(r2) + ')');
    _assertLote3_(_restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_IMP_2&select=id').length === 0, 'Caso 2: no se creó ningún pedido');

    var r3 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_3', tienda: 'Granada', transporte: 'Transporte', lineas: [], esParcial: false, comentario: '' }
    ]);
    _assertLote3_(r3.ok === true && r3.noEncontrados.length === 1 && r3.noEncontrados[0].indexOf('fuera de expedición') !== -1,
      'Caso 3 (Granada, fuera de expedición): noEncontrados (' + JSON.stringify(r3) + ')');

    // id con el formato real codigoTienda::ped (036=Málaga) -- importar_clasificacion
    // resuelve "¿ya existe?" buscando ESE id exacto, no basta con sembrar por 'ped'.
    _sembrarPedidoLote3_('036::TEST_LOTE3_IMP_4', 'TEST_LOTE3_IMP_4', 'Málaga', { estado: 'ENTREGADO' });
    peds.push('TEST_LOTE3_IMP_4');
    var r4 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_4', tienda: 'Málaga', transporte: 'Transporte', lineas: lineas1, esParcial: false, comentario: '' }
    ]);
    _assertLote3_(r4.ok === true && r4.omitidos.length === 1 && r4.omitidos[0].indexOf('ya resuelto') !== -1,
      'Caso 4 (ya resuelto): omitido, no se toca (' + JSON.stringify(r4) + ')');

    _sembrarPedidoLote3_('036::TEST_LOTE3_IMP_5', 'TEST_LOTE3_IMP_5', 'Málaga', { estado: 'PENDIENTE', transportista: 'Correcaminos', flujo: 'transporte' });
    peds.push('TEST_LOTE3_IMP_5');
    var r5 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_5', tienda: 'Málaga', transporte: 'Transporte', lineas: [{ ref: 'R5', dir: 'PASILLO5', ean: 'E5', des: 'Art 5', ctd: 1 }], esParcial: false, comentario: '' }
    ]);
    _assertLote3_(r5.ok === true && r5.creados.length === 1 && r5.creados[0].indexOf('nueva') !== -1,
      'Caso 5 (activo, líneas nuevas): creados con detalle (' + JSON.stringify(r5) + ')');

    var r6 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_5', tienda: 'Málaga', transporte: 'Transporte', lineas: [{ ref: 'R5', dir: 'PASILLO5', ean: 'E5', des: 'Art 5', ctd: 1 }], esParcial: false, comentario: '' }
    ]);
    _assertLote3_(r6.ok === true && r6.omitidos.length === 1 && r6.omitidos[0].indexOf('sin cambios') !== -1,
      'Caso 6 (misma línea, sin novedad): omitido sin cambios (' + JSON.stringify(r6) + ')');

    var r7 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_5', tienda: 'Málaga', transporte: 'Remansur', lineas: [{ ref: 'R5', dir: 'PASILLO5', ean: 'E5', des: 'Art 5', ctd: 1 }], esParcial: false, comentario: '' }
    ]);
    _assertLote3_(r7.ok === true && r7.creados.length === 1 && r7.creados[0].indexOf('transporte → Remansur') !== -1,
      'Caso 7 (transporte cambia): creados con detalle de cambio (' + JSON.stringify(r7) + ')');
    var p7 = _restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_IMP_5&select=transportista')[0];
    _assertLote3_(p7.transportista === 'Remansur', 'Caso 7: transportista corregido en PEDIDOS');

    var r8 = importarClasificacionViaSupabase([
      { ped: 'TEST_LOTE3_IMP_8', tienda: 'Mijas', transporte: 'PRO',
        lineas: [
          { ref: 'R8', dir: 'PASILLO8', ean: 'E8', des: 'Art 8', ctd: 1 },
          { ref: 'R8', dir: 'PASILLO8', ean: 'E8', des: 'Art 8', ctd: 1 }
        ], esParcial: false, comentario: '' }
    ]);
    peds.push('TEST_LOTE3_IMP_8');
    _assertLote3_(r8.ok === true && r8.creados.length === 1, 'Caso 8 (dedup): creado 1 pedido');
    var l8 = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.279::TEST_LOTE3_IMP_8&select=id');
    _assertLote3_(l8.length === 1, 'Caso 8: solo 1 línea insertada (la duplicada colapsó)');

    _assertLote3_(Array.isArray(r1.colisiones) && r1.colisiones.length === 0, 'Caso 9: colisiones siempre [] (recorte de alcance del wrapper)');

    Logger.log('=== ejecutarPruebaImportarClasificacionLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

/**
 * Prueba funcional de resincronizarPedidosActivosViaSupabase -- 4 casos.
 * Esta RPC recorre TODOS los pedidos activos de staging (sin filtro de
 * entrada), así que se comprueba la presencia/ausencia de LOS PROPIOS
 * pedidos sembrados dentro de la respuesta, nunca el tamaño total de los
 * arrays devueltos.
 * 1) activo, sin silueta, línea nueva en el inventario -> actualizado.
 * 2) activo, sin entrada en el inventario -> noEncontrados.
 * 3) CON silueta ya asignada -> queda fuera del filtro, no se toca.
 * 4) 'parcial' -> queda fuera del filtro, no se toca.
 */
function ejecutarPruebaResincronizarPedidosActivosLote3() {
  var peds = [];
  try {
    _sembrarPedidoLote3_('TEST_LOTE3_RESY_1', 'TEST_LOTE3_RESY_1', 'Málaga', { estado: 'PENDIENTE', nLin: 0 });
    peds.push('TEST_LOTE3_RESY_1');
    var inventario = [
      { ped: 'TEST_LOTE3_RESY_1', tienda: 'Málaga', lineas: [{ ref: 'RR1', dir: 'PASILLO_RR1', ean: 'ERR1', des: 'Art RR1', ctd: 1 }] }
    ];
    var r1 = resincronizarPedidosActivosViaSupabase(inventario);
    _assertLote3_(r1.ok === true, 'Caso 1: ok=true (' + JSON.stringify(r1) + ')');
    var actualizado1 = r1.actualizados.some(function(s) { return s.indexOf('TEST_LOTE3_RESY_1') === 0; });
    _assertLote3_(actualizado1, 'Caso 1: TEST_LOTE3_RESY_1 aparece en actualizados (' + JSON.stringify(r1.actualizados) + ')');
    // A diferencia de importar_clasificacion/registrar_pedido_manual,
    // resincronizar_pedidos_activos NO reconstruye el id -- usa tal cual el
    // que ya tenía la fila en staging.pedidos (aquí, el id sembrado a mano).
    var l1 = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE3_RESY_1&select=id');
    _assertLote3_(l1.length === 1, 'Caso 1: línea nueva insertada');

    _sembrarPedidoLote3_('TEST_LOTE3_RESY_2', 'TEST_LOTE3_RESY_2', 'Marbella', { estado: 'PENDIENTE' });
    peds.push('TEST_LOTE3_RESY_2');
    var r2 = resincronizarPedidosActivosViaSupabase(inventario);
    var noEnc2 = r2.noEncontrados.some(function(s) { return s.indexOf('TEST_LOTE3_RESY_2') === 0; });
    _assertLote3_(noEnc2, 'Caso 2: TEST_LOTE3_RESY_2 aparece en noEncontrados (' + JSON.stringify(r2.noEncontrados) + ')');

    _sembrarPedidoLote3_('TEST_LOTE3_RESY_3', 'TEST_LOTE3_RESY_3', 'Málaga', { estado: 'PENDIENTE', silueta: SILUETA_PRUEBA_LOTE3, posIni: '9', posFin: '9' });
    peds.push('TEST_LOTE3_RESY_3');
    var inv3 = [{ ped: 'TEST_LOTE3_RESY_3', tienda: 'Málaga', lineas: [{ ref: 'RR3', dir: 'PASILLO_RR3', ean: 'ERR3', des: 'Art RR3', ctd: 1 }] }];
    resincronizarPedidosActivosViaSupabase(inv3);
    var l3 = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE3_RESY_3&select=id');
    _assertLote3_(l3.length === 0, 'Caso 3 (con silueta): no se tocó, sigue sin líneas nuevas');

    _sembrarPedidoLote3_('TEST_LOTE3_RESY_4', 'TEST_LOTE3_RESY_4', 'Málaga', { estado: 'PENDIENTE', parcial: true });
    peds.push('TEST_LOTE3_RESY_4');
    var inv4 = [{ ped: 'TEST_LOTE3_RESY_4', tienda: 'Málaga', lineas: [{ ref: 'RR4', dir: 'PASILLO_RR4', ean: 'ERR4', des: 'Art RR4', ctd: 1 }] }];
    resincronizarPedidosActivosViaSupabase(inv4);
    var l4 = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE3_RESY_4&select=id');
    _assertLote3_(l4.length === 0, 'Caso 4 (parcial): no se tocó, sigue sin líneas nuevas');

    Logger.log('=== ejecutarPruebaResincronizarPedidosActivosLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}

/**
 * Concurrencia real de registrar_ya_cargados_masivo: 2 altas SIMULTÁNEAS a
 * la misma silueta ficticia (UrlFetchApp.fetchAll -- un `for` normal en Apps
 * Script es de un solo hilo y nunca simularía una carrera real). El
 * advisory lock (pg_advisory_xact_lock) serializa las dos llamadas
 * COMPLETAS entre sí (max_pos se lee una sola vez al principio de cada
 * llamada) -- las dos deben acabar OK, pero con posIni DISTINTOS, nunca con
 * el mismo v_max_pos+1 repetido.
 */
function ejecutarConcurrenciaYaCargadosLote3() {
  var peds = [];
  try {
    var resultados = _dispararEnParalelo_('registrar_ya_cargados_masivo', [
      { p_numeros_pedido: ['TEST_LOTE3_CONC_A'], p_tienda: 'Málaga' },
      { p_numeros_pedido: ['TEST_LOTE3_CONC_B'], p_tienda: 'Málaga' }
    ]);
    peds.push('TEST_LOTE3_CONC_A', 'TEST_LOTE3_CONC_B');
    var okA = resultados[0].body && resultados[0].body.ok === true;
    var okB = resultados[1].body && resultados[1].body.ok === true;
    _assertLote3_(okA && okB, 'Concurrencia Ya Cargados: las dos altas simultáneas OK (' + JSON.stringify(resultados) + ')');
    var pA = _restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_CONC_A&select=pos_ini')[0];
    var pB = _restStaging_('get', 'pedidos?ped=eq.TEST_LOTE3_CONC_B&select=pos_ini')[0];
    _assertLote3_(pA.pos_ini !== pB.pos_ini,
      'Concurrencia Ya Cargados: posIni distintos gracias al advisory lock (A=' + pA.pos_ini + ', B=' + pB.pos_ini + ')');

    Logger.log('=== ejecutarConcurrenciaYaCargadosLote3: TODO PASS ===');
  } finally {
    _limpiarPruebaLote3_(peds, []);
  }
}
