/**
 * ============================================================
 * PruebasLote4Staging.gs · Pruebas funcionales y de concurrencia del Lote 4
 * ============================================================
 * Último lote de la Fase 3 "Pieza 2" (hot path de marcado + mantenimiento
 * periódico). Todas las pruebas siembran sus propios pedidos/líneas
 * sintéticos (prefijo TEST_LOTE4_, silueta ficticia ZTEST) en `staging` y
 * los limpian en un `finally`, pase o falle la prueba. Ejecutar
 * ejecutarTodoLote4Staging() (primera función del archivo, autoseleccionada
 * en el editor) para correrlas todas en orden.
 *
 * A diferencia de los Lotes 1-3, ninguna RPC de este lote genera un id
 * nuevo del lado del servidor -- marcar_lineas_direccion solo actualiza
 * filas existentes, purgar_pedidos_antiguos solo borra -- así que el
 * chequeo de residuos SÍ puede filtrar por 'id like TEST_LOTE4_*' con
 * seguridad (no hay ningún id server-generado que se escape a ese filtro).
 */

var SILUETA_PRUEBA_LOTE4 = 'ZTEST';

/**
 * Runner maestro del Lote 4: limpia cualquier residuo de una ejecución
 * anterior interrumpida, ejecuta las 3 pruebas (2 funcionales + 1 de
 * concurrencia) en orden, para en el primer fallo, y verifica al final que
 * no quedó ningún residuo. Colocada a propósito como PRIMERA función del
 * archivo, mismo motivo que en los Lotes 1-3.
 */
function ejecutarTodoLote4Staging() {
  _limpiarTodoResiduoLote4_();

  var pruebas = [
    ejecutarPruebaMarcarLineasDireccionLote4,
    ejecutarConcurrenciaMarcarLineasDireccionLote4,
    ejecutarPruebaPurgarPedidosAntiguosLote4
  ];
  for (var i = 0; i < pruebas.length; i++) {
    try {
      pruebas[i]();
    } catch (e) {
      Logger.log('*** PARADO en la prueba #' + (i + 1) + ' (' + pruebas[i].name + '): ' + e.message + ' ***');
      return;
    }
  }

  var residuales = _restStaging_('get', 'pedidos?id=like.TEST_LOTE4_*&select=id');
  Logger.log(residuales.length === 0
    ? '=== TODAS LAS PRUEBAS DEL LOTE 4 PASARON, sin residuos TEST_LOTE4_ ==='
    : '*** ADVERTENCIA: quedaron ' + residuales.length + ' pedidos residuales -- revisar limpieza ***');
}

/** Borra cualquier rastro de pruebas del Lote 4 de una ejecución anterior interrumpida. */
function _limpiarTodoResiduoLote4_() {
  var ids = _restStaging_('get', 'pedidos?id=like.TEST_LOTE4_*&select=ped').map(function(p) { return p.ped; });
  if (ids.length) {
    Logger.log('Limpieza defensiva previa: ' + ids.length + ' pedido(s) de una ejecución anterior');
    _limpiarPruebaLote4_(ids);
  }
}

/**
 * Siembra un pedido sintético en staging.pedidos. `opts.actualizado`
 * permite forzar una fecha vieja (para las pruebas de purgar_pedidos_
 * antiguos) -- si se omite, se usa la hora actual, igual que el resto de
 * columnas por defecto de _sembrarPedidoLote3_ (Lote 3, MISMA forma de
 * fila, reutilizada aquí sin cambios).
 */
function _sembrarPedidoLote4_(id, ped, tienda, opts) {
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
    numero_carga: null, soportes: [],
    n_lin: opts.nLin === undefined ? 0 : opts.nLin,
    n_ubic: opts.nUbic === undefined ? 0 : opts.nUbic,
    parcial: false, comentario: null,
    en_revision: !!opts.enRevision,
    actualizado: opts.actualizado || new Date().toISOString()
  };
  _restStaging_('post', 'pedidos', [fila]);
  return fila;
}

/** Siembra una fila en staging.lineas_preparacion para un idPedido ya sembrado. */
function _sembrarLineaLote4_(idPedido, idx, opts) {
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

/**
 * Borra todo rastro de una tanda de prueba del Lote 4: primero
 * lineas_preparacion (resolviendo el id real de cada pedido por 'ped',
 * igual que en el Lote 3), luego ocupacion_siluetas y por último pedidos.
 */
function _limpiarPruebaLote4_(peds) {
  if (!peds || !peds.length) return;
  var filtroPed = 'ped=in.(' + peds.map(encodeURIComponent).join(',') + ')';
  var filasPedidos = _restStaging_('get', 'pedidos?' + filtroPed + '&select=id');
  var ids = filasPedidos.map(function(r) { return r.id; });
  if (ids.length) {
    var filtroIdPedido = 'id_pedido=in.(' + ids.map(encodeURIComponent).join(',') + ')';
    try { _restStaging_('delete', 'lineas_preparacion?' + filtroIdPedido); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote4_ (lineas_preparacion, filtro=' + filtroIdPedido + '): ' + e.message); }
  }
  var filtroOcupacion = 'pedido=in.(' + peds.map(encodeURIComponent).join(',') + ')';
  try { _restStaging_('delete', 'ocupacion_siluetas?' + filtroOcupacion); }
  catch (e) { Logger.log('⚠ _limpiarPruebaLote4_ (ocupacion_siluetas, filtro=' + filtroOcupacion + '): ' + e.message); }
  try { _restStaging_('delete', 'pedidos?' + filtroPed); }
  catch (e) { Logger.log('⚠ _limpiarPruebaLote4_ (pedidos, filtro=' + filtroPed + '): ' + e.message); }
}

/** Assert mínimo: compara y lanza con mensaje claro si no coincide. */
function _assertLote4_(cond, mensaje) {
  if (!cond) throw new Error('FAIL: ' + mensaje);
  Logger.log('PASS: ' + mensaje);
}

/**
 * Prueba funcional de marcarLineasDireccionViaSupabase -- 6 casos:
 * 1) marca TODAS las líneas de una dirección a la vez, recalcula pct/estado
 *    del pedido a partir de TODAS sus líneas (no solo las de esa dirección).
 * 2) dirección no encontrada -> error específico.
 * 3) vuelve_al_final=true reordena idx de esa dirección al final.
 * 4) notificar=true solo para NO_ENCONTRADO/NO_SALE, false en los demás.
 * 5) estado_nuevo=POSPUESTO marca en_revision=true en el pedido.
 * 6) operario vacío NO sobrescribe el operario existente; uno no vacío sí.
 */
function ejecutarPruebaMarcarLineasDireccionLote4() {
  var peds = [];
  try {
    // Caso 1: pedido con 2 líneas en dir X + 1 línea en dir Y, todas PENDIENTE.
    // Marcar dir X como PREPARADO -> pct=67 (2/3), estado=EN_PREPARACION.
    _sembrarPedidoLote4_('TEST_LOTE4_MARC_1', 'TEST_LOTE4_MARC_1', 'Málaga', { nLin: 3, estado: 'PENDIENTE' });
    peds.push('TEST_LOTE4_MARC_1');
    _sembrarLineaLote4_('TEST_LOTE4_MARC_1', 0, { dir: 'DIRX' });
    _sembrarLineaLote4_('TEST_LOTE4_MARC_1', 1, { dir: 'DIRX' });
    _sembrarLineaLote4_('TEST_LOTE4_MARC_1', 2, { dir: 'DIRY' });
    var r1 = marcarLineasDireccionViaSupabase('TEST_LOTE4_MARC_1', 'DIRX', 'PREPARADO', null, 'Carlos', false);
    _assertLote4_(r1.ok === true && r1.pct === 67 && r1.estado === 'EN_PREPARACION',
      'Caso 1 (marca dirección completa): ok=true, pct=67, EN_PREPARACION (' + JSON.stringify(r1) + ')');
    var lineasX = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE4_MARC_1&dir=eq.DIRX&select=estado');
    _assertLote4_(lineasX.every(function(l) { return l.estado === 'PREPARADO'; }), 'Caso 1: las 2 líneas de DIRX quedaron PREPARADO');
    var lineaY = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE4_MARC_1&dir=eq.DIRY&select=estado')[0];
    _assertLote4_(lineaY.estado === 'PENDIENTE', 'Caso 1: la línea de DIRY NO se tocó');
    _assertLote4_(r1.notificar === false, 'Caso 1: notificar=false para PREPARADO');

    // Caso 2: dirección no encontrada.
    var r2 = marcarLineasDireccionViaSupabase('TEST_LOTE4_MARC_1', 'DIR_QUE_NO_EXISTE', 'PREPARADO', null, null, false);
    _assertLote4_(r2.ok === false && r2.error === 'Dirección no encontrada', 'Caso 2: dirección no encontrada');

    // Caso 3: vuelve_al_final=true reordena idx de DIRY al final.
    var maxIdxAntes = 2; // 3 líneas sembradas, idx 0..2
    var r3 = marcarLineasDireccionViaSupabase('TEST_LOTE4_MARC_1', 'DIRY', 'POSPUESTO', 'motivo', null, true);
    _assertLote4_(r3.ok === true, 'Caso 3 (vuelve al final): ok=true (' + JSON.stringify(r3) + ')');
    var lineaYReord = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE4_MARC_1&dir=eq.DIRY&select=idx')[0];
    _assertLote4_(lineaYReord.idx > maxIdxAntes, 'Caso 3: idx de DIRY quedó por detrás de las demás (idx=' + lineaYReord.idx + ')');

    // Caso 5 (junto al 3, mismo r3): POSPUESTO marca en_revision=true.
    var pMarc1 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_MARC_1&select=en_revision')[0];
    _assertLote4_(pMarc1.en_revision === true, 'Caso 5: en_revision=true tras marcar POSPUESTO');

    // Caso 4: notificar=true para NO_ENCONTRADO/NO_SALE.
    _sembrarPedidoLote4_('TEST_LOTE4_MARC_4', 'TEST_LOTE4_MARC_4', 'Málaga', { nLin: 1, estado: 'PENDIENTE' });
    peds.push('TEST_LOTE4_MARC_4');
    _sembrarLineaLote4_('TEST_LOTE4_MARC_4', 0, { dir: 'DIRZ' });
    var r4 = marcarLineasDireccionViaSupabase('TEST_LOTE4_MARC_4', 'DIRZ', 'NO_ENCONTRADO', 'no estaba', null, false);
    _assertLote4_(r4.ok === true && r4.notificar === true, 'Caso 4: notificar=true para NO_ENCONTRADO (' + JSON.stringify(r4) + ')');

    // Caso 6: operario vacío NO sobrescribe; uno no vacío sí.
    _sembrarPedidoLote4_('TEST_LOTE4_MARC_6', 'TEST_LOTE4_MARC_6', 'Málaga', { nLin: 1, estado: 'PENDIENTE', operario: 'OperarioOriginal' });
    peds.push('TEST_LOTE4_MARC_6');
    _sembrarLineaLote4_('TEST_LOTE4_MARC_6', 0, { dir: 'DIRW' });
    marcarLineasDireccionViaSupabase('TEST_LOTE4_MARC_6', 'DIRW', 'NO_SALE', 'motivo', '', false);
    var p6a = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_MARC_6&select=operario')[0];
    _assertLote4_(p6a.operario === 'OperarioOriginal', 'Caso 6a: operario vacío NO sobrescribe (sigue OperarioOriginal)');
    // Reabrir la línea a PENDIENTE para poder marcarla otra vez con un operario real.
    marcarLineasDireccionViaSupabase('TEST_LOTE4_MARC_6', 'DIRW', 'PREPARADO', null, 'Ana', false);
    var p6b = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_MARC_6&select=operario')[0];
    _assertLote4_(p6b.operario === 'Ana', 'Caso 6b: operario no vacío SÍ sobrescribe (pasa a Ana)');

    Logger.log('=== ejecutarPruebaMarcarLineasDireccionLote4: TODO PASS ===');
  } finally {
    _limpiarPruebaLote4_(peds);
  }
}

/**
 * Concurrencia real de marcar_lineas_direccion: el motivo de ser del
 * advisory lock por id_pedido (hot path -- se llama en cada marca durante
 * el picking). 2 direcciones DISTINTAS del MISMO pedido, marcadas EN
 * PARALELO (UrlFetchApp.fetchAll -- un `for` normal en Apps Script es de un
 * solo hilo y nunca simularía una carrera real). Sin el candado, las dos
 * llamadas podrían leer el mismo pct/estado de partida y una pisar el
 * recálculo de la otra (lost update); con el candado, ambas deben quedar
 * aplicadas y el estado final debe ser el correcto para las DOS líneas
 * marcadas, no solo una.
 */
function ejecutarConcurrenciaMarcarLineasDireccionLote4() {
  var peds = [];
  try {
    _sembrarPedidoLote4_('TEST_LOTE4_CONC', 'TEST_LOTE4_CONC', 'Málaga', { nLin: 2, estado: 'PENDIENTE' });
    peds.push('TEST_LOTE4_CONC');
    _sembrarLineaLote4_('TEST_LOTE4_CONC', 0, { dir: 'DIRA' });
    _sembrarLineaLote4_('TEST_LOTE4_CONC', 1, { dir: 'DIRB' });

    var resultados = _dispararEnParalelo_('marcar_lineas_direccion', [
      { p_id_pedido: 'TEST_LOTE4_CONC', p_dir: 'DIRA', p_estado_nuevo: 'PREPARADO', p_motivo: null, p_operario: 'Carlos', p_vuelve_al_final: false },
      { p_id_pedido: 'TEST_LOTE4_CONC', p_dir: 'DIRB', p_estado_nuevo: 'PREPARADO', p_motivo: null, p_operario: 'Ana', p_vuelve_al_final: false }
    ]);
    var okA = resultados[0].body && resultados[0].body.ok === true;
    var okB = resultados[1].body && resultados[1].body.ok === true;
    _assertLote4_(okA && okB, 'Concurrencia marcar: las dos marcas simultáneas OK (' + JSON.stringify(resultados) + ')');

    var lineas = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE4_CONC&select=dir,estado');
    _assertLote4_(lineas.every(function(l) { return l.estado === 'PREPARADO'; }),
      'Concurrencia marcar: LAS DOS líneas quedaron PREPARADO, ninguna se perdió (' + JSON.stringify(lineas) + ')');
    var pConc = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_CONC&select=pct,estado')[0];
    _assertLote4_(pConc.pct === 100 && pConc.estado === 'COMPLETADO_LISTO',
      'Concurrencia marcar: pedido recalculado sobre el estado FINAL, no uno intermedio pisado (pct=100, COMPLETADO_LISTO) (' + JSON.stringify(pConc) + ')');

    Logger.log('=== ejecutarConcurrenciaMarcarLineasDireccionLote4: TODO PASS ===');
  } finally {
    _limpiarPruebaLote4_(peds);
  }
}

/**
 * Prueba funcional de purgarPedidosAntiguosViaSupabase -- 4 casos, sembrados
 * juntos y verificados con UNA sola llamada a la RPC (que recorre TODOS los
 * pedidos de staging, no solo los de esta prueba -- por eso se verifica la
 * EXISTENCIA de cada pedido propio después, nunca el valor exacto de
 * 'borrados'/'omitidos' devuelto, que puede incluir otras filas):
 * 1) terminal + >90 días + SIN ocupación -> borrado (pedido y sus líneas).
 * 2) terminal + >90 días + CON ocupación (mismo ped) -> omitido, se conserva.
 * 3) terminal pero RECIENTE (<90 días) -> no es candidato, se conserva.
 * 4) NO terminal (aunque antiguo) -> no es candidato, se conserva.
 */
function ejecutarPruebaPurgarPedidosAntiguosLote4() {
  var peds = [];
  try {
    var hace95Dias = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();

    _sembrarPedidoLote4_('TEST_LOTE4_PURG_1', 'TEST_LOTE4_PURG_1', 'Málaga', { estado: 'ENTREGADO', nLin: 1, actualizado: hace95Dias });
    peds.push('TEST_LOTE4_PURG_1');
    _sembrarLineaLote4_('TEST_LOTE4_PURG_1', 0, {});

    _sembrarPedidoLote4_('TEST_LOTE4_PURG_2', 'TEST_LOTE4_PURG_2', 'Málaga', { estado: 'DEVUELTO_ALMACEN', actualizado: hace95Dias });
    peds.push('TEST_LOTE4_PURG_2');
    _restStaging_('post', 'ocupacion_siluetas', [
      { silueta: SILUETA_PRUEBA_LOTE4, pos: '1', layer: 'back', pedido: 'TEST_LOTE4_PURG_2', tienda: 'Málaga', flujo: 'transporte', reservado: false }
    ]);

    _sembrarPedidoLote4_('TEST_LOTE4_PURG_3', 'TEST_LOTE4_PURG_3', 'Málaga', { estado: 'ENTREGADO' }); // actualizado = ahora (reciente)
    peds.push('TEST_LOTE4_PURG_3');

    _sembrarPedidoLote4_('TEST_LOTE4_PURG_4', 'TEST_LOTE4_PURG_4', 'Málaga', { estado: 'PENDIENTE', actualizado: hace95Dias });
    peds.push('TEST_LOTE4_PURG_4');

    var r = purgarPedidosAntiguosViaSupabase();
    _assertLote4_(r.ok === true, 'purgar_pedidos_antiguos: ok=true (' + JSON.stringify(r) + ')');

    var p1 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_PURG_1&select=id');
    _assertLote4_(p1.length === 0, 'Caso 1 (terminal, viejo, sin ocupación): pedido BORRADO');
    var l1 = _restStaging_('get', 'lineas_preparacion?id_pedido=eq.TEST_LOTE4_PURG_1&select=id');
    _assertLote4_(l1.length === 0, 'Caso 1: sus líneas también se borraron');

    var p2 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_PURG_2&select=id');
    _assertLote4_(p2.length === 1, 'Caso 2 (terminal, viejo, CON ocupación): pedido se CONSERVA');

    var p3 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_PURG_3&select=id');
    _assertLote4_(p3.length === 1, 'Caso 3 (terminal, RECIENTE): pedido se CONSERVA');

    var p4 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE4_PURG_4&select=id');
    _assertLote4_(p4.length === 1, 'Caso 4 (NO terminal, aunque viejo): pedido se CONSERVA');

    Logger.log('=== ejecutarPruebaPurgarPedidosAntiguosLote4: TODO PASS ===');
  } finally {
    _limpiarPruebaLote4_(peds);
  }
}
