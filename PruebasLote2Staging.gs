/**
 * ============================================================
 * PruebasLote2Staging.gs · Pruebas funcionales y de concurrencia del Lote 2
 * ============================================================
 * Todas las pruebas siembran sus propios pedidos/cargas/vínculos sintéticos
 * (prefijo TEST_LOTE2_, silueta ficticia ZTEST) en `staging` y los limpian
 * en un `finally`, pase o falle la prueba. Ejecutar ejecutarTodoLote2Staging()
 * (primera función del archivo, autoseleccionada en el editor) para
 * correrlas todas en orden, o cualquier función ejecutar... individual para
 * depurar una sola.
 *
 * A diferencia del Lote 1, las 4 RPC del Lote 2 (crear_carga,
 * quitar_pedido_de_carga, eliminar_carga_completa, anadir_pedido_a_carga)
 * NUNCA tocan ocupacion_siluetas ni config_siluetas -- solo leen/escriben
 * staging.pedidos, staging.cargas y staging.cargas_pedidos. Por eso aquí no
 * hay equivalente a _asegurarSiluetaPrueba_ del Lote 1: basta con que
 * pedidos.silueta sea una cadena no vacía, no hace falta reservar hueco real
 * ni dar de alta la silueta en config_siluetas.
 *
 * IMPORTANTE (hallazgo de la verificación adversarial): crear_carga es la
 * ÚNICA RPC del lote que genera una carga con id NUEVO del lado del
 * servidor ('CARGA_'||epoch_ms, igual que Backend.gs real) -- ese id NUNCA
 * lleva el prefijo TEST_LOTE2_, así que un chequeo de residuos que solo
 * busque por 'id like TEST_LOTE2_*' es ciego a esas filas. Por eso TODAS las
 * cargas de este archivo (sembradas a mano O creadas vía crearCargaViaSupabase)
 * llevan el mismo `responsable` marcador (RESPONSABLE_PRUEBA_LOTE2) -- el
 * chequeo de residuos y la limpieza defensiva usan ESE marcador, no el id.
 */

var SILUETA_PRUEBA_LOTE2 = 'ZTEST';
var RESPONSABLE_PRUEBA_LOTE2 = 'TEST_LOTE2_MARCADOR';

/**
 * Runner maestro del Lote 2: limpia cualquier residuo de una ejecución
 * anterior interrumpida (staging.cargas.num_carga tiene UNIQUE real -- una
 * ejecución que muera a mitad, p.ej. por el límite de 6 min de Apps Script,
 * no llega a su `finally` y puede dejar num_carga fijos ya ocupados),
 * ejecuta las 6 pruebas (4 funcionales + 2 de concurrencia/casos extra) en
 * orden, para en el primer fallo, y verifica al final que no quedó ningún
 * residuo -- por marcador de responsable, no por prefijo de id (ver nota de
 * cabecera). Colocada a propósito como PRIMERA función del archivo, mismo
 * motivo que en el Lote 1.
 */
function ejecutarTodoLote2Staging() {
  _limpiarTodoResiduoLote2_();

  var pruebas = [
    ejecutarPruebaCrearCargaLote2,
    ejecutarPruebaQuitarPedidoDeCargaLote2,
    ejecutarPruebaEliminarCargaCompletaLote2,
    ejecutarPruebaAnadirPedidoACargaLote2,
    ejecutarConcurrenciaAnadirPedidoLote2
  ];
  for (var i = 0; i < pruebas.length; i++) {
    try {
      pruebas[i]();
    } catch (e) {
      Logger.log('*** PARADO en la prueba #' + (i + 1) + ' (' + pruebas[i].name + '): ' + e.message + ' ***');
      return;
    }
  }

  var pedidosResiduales = _restStaging_('get', 'pedidos?id=like.TEST_LOTE2_*&select=id');
  // cargas_pedidos.pedido_id SIEMPRE lleva el prefijo (los pedidos son
  // siempre sembrados a mano con id explícito) -- a diferencia de carga_id,
  // que para las cargas creadas vía crear_carga es un id de formato
  // producción. Este filtro SÍ detecta vínculos huérfanos de esas cargas.
  var vinculosResiduales = _restStaging_('get', 'cargas_pedidos?pedido_id=like.TEST_LOTE2_*&select=carga_id,pedido_id');
  var cargasResiduales = _restStaging_('get',
    'cargas?or=(id.like.TEST_LOTE2_*,responsable.eq.' + encodeURIComponent(RESPONSABLE_PRUEBA_LOTE2) + ')&select=id');
  var totalResiduos = pedidosResiduales.length + vinculosResiduales.length + cargasResiduales.length;
  Logger.log(totalResiduos === 0
    ? '=== TODAS LAS PRUEBAS DEL LOTE 2 PASARON, sin residuos TEST_LOTE2_ ==='
    : '*** ADVERTENCIA: quedaron ' + pedidosResiduales.length + ' pedidos, ' + cargasResiduales.length +
      ' cargas y ' + vinculosResiduales.length + ' vínculos residuales -- revisar limpieza ***');
}

/**
 * Borra CUALQUIER rastro de pruebas del Lote 2 que pueda haber quedado de
 * una ejecución anterior (interrumpida o fallida) -- por prefijo de id
 * (pedidos, y cargas sembradas a mano) y por marcador de responsable
 * (cargas generadas dinámicamente por crear_carga, que nunca llevan el
 * prefijo). Se llama al INICIO del runner, antes de sembrar nada nuevo --
 * sin esto, staging.cargas.num_carga (UNIQUE real) puede chocar con un
 * valor fijo ya usado por una ejecución previa que no llegó a su `finally`.
 */
function _limpiarTodoResiduoLote2_() {
  var cargas = _restStaging_('get',
    'cargas?or=(id.like.TEST_LOTE2_*,responsable.eq.' + encodeURIComponent(RESPONSABLE_PRUEBA_LOTE2) + ')&select=id');
  var cargaIds = cargas.map(function(c) { return c.id; });
  var peds = _restStaging_('get', 'pedidos?id=like.TEST_LOTE2_*&select=ped').map(function(p) { return p.ped; });
  if (cargaIds.length || peds.length) {
    Logger.log('Limpieza defensiva previa: ' + cargaIds.length + ' cargas + ' + peds.length + ' pedidos de una ejecución anterior');
    _limpiarPruebaLote2_(cargaIds, peds);
  }
}

/**
 * Siembra un pedido sintético en staging.pedidos YA "cerrado" (silueta,
 * pos_ini, pos_fin puestos por defecto) y disponible para carga
 * (numero_carga=null salvo que se indique lo contrario). `opts` permite
 * forzar el estado ('ENTREGADO' para probar el rechazo), dejar la silueta a
 * null (pedido "sin silueta") o fijar numeroCarga (para simular un pedido
 * ya vinculado a una carga vía _sembrarCargaPedidoPrueba_).
 * `id`: string único, prefijado TEST_LOTE2_ por el llamador -- normalmente
 * igual que `ped`, EXCEPTO en el caso de duplicados entre tiendas (Caso 9
 * de anadirPedidoACarga), donde `id` y `ped` deliberadamente difieren.
 */
function _sembrarPedidoCarga_(id, ped, tienda, opts) {
  opts = opts || {};
  var silueta = opts.hasOwnProperty('silueta') ? opts.silueta : SILUETA_PRUEBA_LOTE2;
  var fila = {
    id: id, ped: ped, tienda: tienda, transportista: null, flujo: opts.flujo || 'transporte',
    estado: opts.estado || 'EN_PREPARACION', pct: 100, operario: null,
    silueta: silueta, pos_ini: (silueta ? 1 : null), pos_fin: (silueta ? 1 : null),
    numero_carga: (opts.numeroCarga === undefined ? null : opts.numeroCarga),
    soportes: opts.soportes || [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }],
    n_lin: 1, n_ubic: 1, actualizado: new Date().toISOString(), intento_carga: null,
    comentario: null, tipo_entrega: null, en_revision: false, sd_impreso: null
  };
  _restStaging_('post', 'pedidos', [fila]);
  return fila;
}

/**
 * Siembra una carga sintética en staging.cargas. `estado` por defecto
 * 'GENERADA' (activa); pásalo a 'CERRADA' para probar el rechazo de
 * modificar/eliminar cargas ya cerradas. `id`: string único, prefijado
 * TEST_LOTE2_ por el llamador. `responsable` SIEMPRE RESPONSABLE_PRUEBA_LOTE2
 * salvo que se pase explícitamente otro -- es el marcador que permite
 * detectar residuos independientemente del formato del id (ver cabecera).
 */
function _sembrarCargaPrueba_(id, numCarga, estado, responsable) {
  var fila = {
    id: id, num_carga: String(numCarga), fecha: new Date().toISOString().slice(0, 10),
    estado: estado || 'GENERADA', responsable: responsable || RESPONSABLE_PRUEBA_LOTE2
  };
  _restStaging_('post', 'cargas', [fila]);
  return fila;
}

/**
 * Vincula directamente un pedido a una carga en cargas_pedidos, SIN pasar
 * por anadir_pedido_a_carga -- para montar de antemano el estado previo que
 * necesitan las pruebas de quitar/eliminar/anadir (una carga que YA trae
 * pedidos dentro).
 */
function _sembrarCargaPedidoPrueba_(idCarga, idPedido, posicion) {
  _restStaging_('post', 'cargas_pedidos', [{ carga_id: idCarga, pedido_id: idPedido, posicion: posicion }]);
}

/**
 * Borra TODO rastro de una tanda de prueba del Lote 2: primero
 * cargas_pedidos (por carga_id, para no chocar con FKs), luego cargas (por
 * id) y por último pedidos (por ped). Pasa cada lista vacía si no aplica --
 * no lanza si algo ya no existe. Cada DELETE fallido se loguea con detalle
 * (⚠) en vez de tragarse en silencio -- mismo criterio ya aplicado en el
 * Lote 1 tras el bug de limpieza encontrado ahí.
 */
function _limpiarPruebaLote2_(cargaIds, peds) {
  if (cargaIds && cargaIds.length) {
    var filtroCp = 'carga_id=in.(' + cargaIds.map(encodeURIComponent).join(',') + ')';
    try { _restStaging_('delete', 'cargas_pedidos?' + filtroCp); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote2_ (cargas_pedidos, filtro=' + filtroCp + '): ' + e.message); }
    var filtroCargas = 'id=in.(' + cargaIds.map(encodeURIComponent).join(',') + ')';
    try { _restStaging_('delete', 'cargas?' + filtroCargas); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote2_ (cargas, filtro=' + filtroCargas + '): ' + e.message); }
  }
  if (peds && peds.length) {
    var filtroPed = 'ped=in.(' + peds.map(encodeURIComponent).join(',') + ')';
    try { _restStaging_('delete', 'pedidos?' + filtroPed); }
    catch (e) { Logger.log('⚠ _limpiarPruebaLote2_ (pedidos, filtro=' + filtroPed + '): ' + e.message); }
  }
}

/** Assert mínimo: compara y lanza con mensaje claro si no coincide. */
function _assertLote2_(cond, mensaje) {
  if (!cond) throw new Error('FAIL: ' + mensaje);
  Logger.log('PASS: ' + mensaje);
}

/**
 * Prueba funcional de crearCargaViaSupabase -- 3 casos:
 * 1) 2 pedidos válidos -> carga creada con ambos, numCarga entero positivo,
 *    numero_carga escrito en PEDIDOS para los dos.
 * 2) lista mixta (1 válido + 1 número inexistente) -> ok:true igual, el
 *    inexistente cae en noEncontrados.
 * 3) ninguno válido (uno ENTREGADO, otro inexistente) -> ok:false, Y se
 *    verifica explícitamente que NO se creó ninguna carga (invariante de
 *    la RPC, no asumida sin más -- hallazgo de la verificación adversarial).
 */
function ejecutarPruebaCrearCargaLote2() {
  var cargaIds = [];
  var peds = [];
  try {
    // Caso 1: 2 pedidos válidos
    _sembrarPedidoCarga_('TEST_LOTE2_CC1', 'TEST_LOTE2_CC1', 'Málaga');
    _sembrarPedidoCarga_('TEST_LOTE2_CC2', 'TEST_LOTE2_CC2', 'Málaga');
    peds.push('TEST_LOTE2_CC1', 'TEST_LOTE2_CC2');
    var r1 = crearCargaViaSupabase(['TEST_LOTE2_CC1', 'TEST_LOTE2_CC2'], RESPONSABLE_PRUEBA_LOTE2);
    _assertLote2_(r1.ok === true, 'Caso 1 (2 pedidos válidos): ok=true (' + JSON.stringify(r1) + ')');
    _assertLote2_(r1.carga && r1.carga.id, 'Caso 1: la respuesta trae carga.id');
    cargaIds.push(r1.carga.id);
    _assertLote2_(r1.carga.items.length === 2, 'Caso 1: 2 items en la carga');
    _assertLote2_(typeof r1.carga.numCarga === 'number' && r1.carga.numCarga > 0, 'Caso 1: numCarga es entero positivo');
    _assertLote2_(r1.carga.items.every(function(it) { return it.numeroCarga === r1.carga.numCarga; }),
      'Caso 1: todos los items llevan numeroCarga = ' + r1.carga.numCarga);
    _assertLote2_(r1.noEncontrados.length === 0, 'Caso 1: sin noEncontrados');
    var p1 = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE2_CC1&select=numero_carga')[0];
    _assertLote2_(p1.numero_carga === String(r1.carga.numCarga), 'Caso 1: numero_carga escrito en PEDIDOS');

    // Caso 2: mezcla válido + inexistente
    _sembrarPedidoCarga_('TEST_LOTE2_CC3', 'TEST_LOTE2_CC3', 'Málaga');
    peds.push('TEST_LOTE2_CC3');
    var r2 = crearCargaViaSupabase(['TEST_LOTE2_CC3', 'TEST_LOTE2_NOEXISTE'], RESPONSABLE_PRUEBA_LOTE2);
    _assertLote2_(r2.ok === true, 'Caso 2 (mezcla): ok=true (' + JSON.stringify(r2) + ')');
    _assertLote2_(r2.carga && r2.carga.id, 'Caso 2: la respuesta trae carga.id');
    cargaIds.push(r2.carga.id);
    _assertLote2_(r2.carga.items.length === 1, 'Caso 2: 1 item encontrado');
    _assertLote2_(r2.noEncontrados.length === 1 && r2.noEncontrados[0] === 'TEST_LOTE2_NOEXISTE',
      'Caso 2: el número inexistente cae en noEncontrados');

    // Caso 3: ninguno válido (uno ENTREGADO, otro inexistente) -- verificar
    // explícitamente que no se creó ninguna carga fantasma.
    var cargasAntes = _restStaging_('get', 'cargas?responsable=eq.' + encodeURIComponent(RESPONSABLE_PRUEBA_LOTE2) + '&select=id').length;
    _sembrarPedidoCarga_('TEST_LOTE2_CC4', 'TEST_LOTE2_CC4', 'Málaga', { estado: 'ENTREGADO' });
    peds.push('TEST_LOTE2_CC4');
    var r3 = crearCargaViaSupabase(['TEST_LOTE2_CC4', 'TEST_LOTE2_NOEXISTE2'], RESPONSABLE_PRUEBA_LOTE2);
    _assertLote2_(r3.ok === false && r3.error === 'Ningún pedido encontrado en silueta',
      'Caso 3 (ninguno válido): ok=false con el error genérico (' + JSON.stringify(r3) + ')');
    _assertLote2_(r3.noEncontrados.length === 2, 'Caso 3: ambos números en noEncontrados');
    var cargasDespues = _restStaging_('get', 'cargas?responsable=eq.' + encodeURIComponent(RESPONSABLE_PRUEBA_LOTE2) + '&select=id').length;
    _assertLote2_(cargasDespues === cargasAntes, 'Caso 3: NO se creó ninguna carga (antes=' + cargasAntes + ', después=' + cargasDespues + ')');

    Logger.log('=== ejecutarPruebaCrearCargaLote2: TODO PASS ===');
  } finally {
    _limpiarPruebaLote2_(cargaIds, peds);
  }
}

/**
 * Prueba funcional de quitarPedidoDeCargaViaSupabase -- 5 casos:
 * 1) ok: carga GENERADA con 2 pedidos, se quita uno -> queda 1, numero_carga
 *    del pedido quitado vuelve a NULL (no '').
 * 2) carga inexistente -> error específico.
 * 3) carga ya CERRADA -> rechazada, no se toca nada.
 * 4) pedido que no pertenece a esa carga -> error específico.
 * 5) (encadenado sobre el hueco que deja el Caso 1) añadir un pedido nuevo a
 *    esa misma carga y confirmar que su posición es max(posicion)+1 = 2, no
 *    count(*) = 1 -- exactamente el escenario "hueco real" que la RPC dice
 *    haber verificado para el Lote 1 y que este archivo no replicaba.
 */
function ejecutarPruebaQuitarPedidoDeCargaLote2() {
  var cargaIds = [];
  var peds = [];
  try {
    // Setup: carga GENERADA con 2 pedidos vinculados directamente (sin pasar por crear_carga)
    var carga = _sembrarCargaPrueba_('TEST_LOTE2_QP_CARGA', 900, 'GENERADA');
    cargaIds.push(carga.id);
    var pA = _sembrarPedidoCarga_('TEST_LOTE2_QP_A', 'TEST_LOTE2_QP_A', 'Málaga', { numeroCarga: '900' });
    var pB = _sembrarPedidoCarga_('TEST_LOTE2_QP_B', 'TEST_LOTE2_QP_B', 'Málaga', { numeroCarga: '900' });
    peds.push('TEST_LOTE2_QP_A', 'TEST_LOTE2_QP_B');
    _sembrarCargaPedidoPrueba_(carga.id, pA.id, 0);
    _sembrarCargaPedidoPrueba_(carga.id, pB.id, 1);

    // Caso 1: ok
    var r1 = quitarPedidoDeCargaViaSupabase(carga.id, 'TEST_LOTE2_QP_A');
    _assertLote2_(r1.ok === true, 'Caso 1 (ok): ok=true (' + JSON.stringify(r1) + ')');
    _assertLote2_(r1.quedan === 1, 'Caso 1: queda 1 pedido en la carga');
    _assertLote2_(r1.numCarga === 900, 'Caso 1: numCarga=900');
    var pARestante = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE2_QP_A&select=numero_carga')[0];
    _assertLote2_(pARestante.numero_carga === null, 'Caso 1: numero_carga vuelve a NULL (no cadena vacía)');
    var cp = _restStaging_('get', 'cargas_pedidos?carga_id=eq.' + carga.id + '&select=pedido_id');
    _assertLote2_(cp.length === 1 && cp[0].pedido_id === pB.id, 'Caso 1: solo queda el vínculo de QP_B (posicion 1 -- deja un hueco en posicion 0)');

    // Caso 2: carga inexistente
    var r2 = quitarPedidoDeCargaViaSupabase('TEST_LOTE2_QP_NOEXISTE', 'TEST_LOTE2_QP_B');
    _assertLote2_(r2.ok === false && r2.error === 'Carga no encontrada', 'Caso 2 (carga inexistente): error específico');

    // Caso 3: carga cerrada
    var cargaCerrada = _sembrarCargaPrueba_('TEST_LOTE2_QP_CERRADA', 901, 'CERRADA');
    cargaIds.push(cargaCerrada.id);
    var r3 = quitarPedidoDeCargaViaSupabase(cargaCerrada.id, 'TEST_LOTE2_QP_B');
    _assertLote2_(r3.ok === false && r3.error === 'Esta carga ya está cerrada, no se puede modificar',
      'Caso 3 (carga cerrada): rechazada');

    // Caso 4: pedido que no está en esta carga
    var r4 = quitarPedidoDeCargaViaSupabase(carga.id, 'TEST_LOTE2_QP_NOVINCULADO');
    _assertLote2_(r4.ok === false && r4.error === 'Ese pedido no está en esta carga',
      'Caso 4 (pedido no vinculado): error específico');

    // Caso 5: la carga tiene un HUECO real en posicion (0 quedó libre tras el
    // Caso 1, solo existe la fila de QP_B en posicion 1) -- añadir un pedido
    // nuevo debe calcular posicion=2 (max(1)+1), NUNCA 1 (que sería lo que
    // daría un cálculo erróneo por count(*) de filas existentes + 1).
    var pC = _sembrarPedidoCarga_('TEST_LOTE2_QP_C', 'TEST_LOTE2_QP_C', 'Málaga');
    peds.push('TEST_LOTE2_QP_C');
    var r5 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_QP_C');
    _assertLote2_(r5.ok === true, 'Caso 5 (añadir sobre hueco): ok=true (' + JSON.stringify(r5) + ')');
    _assertLote2_(r5.total === 2, 'Caso 5: total=2 (QP_B + QP_C, pese al hueco en posicion 0)');
    var cpC = _restStaging_('get', 'cargas_pedidos?carga_id=eq.' + carga.id + '&pedido_id=eq.TEST_LOTE2_QP_C&select=posicion')[0];
    _assertLote2_(cpC.posicion === 2, 'Caso 5: posicion=2 (max(1)+1), no 1 (que daría un cálculo por count(*) erróneo)');

    Logger.log('=== ejecutarPruebaQuitarPedidoDeCargaLote2: TODO PASS ===');
  } finally {
    _limpiarPruebaLote2_(cargaIds, peds);
  }
}

/**
 * Prueba funcional de eliminarCargaCompletaViaSupabase -- 3 casos:
 * 1) ok: carga GENERADA con 2 pedidos -> pedidosLiberados=2; la fila de
 *    CARGAS SIGUE EXISTIENDO marcada ELIMINADA (no deleteRow); las filas de
 *    cargas_pedidos NO se borran (quedan como histórico); numero_carga de
 *    ambos pedidos vuelve a NULL.
 * 2) carga inexistente -> error específico.
 * 3) carga ya cerrada -> rechazada.
 */
function ejecutarPruebaEliminarCargaCompletaLote2() {
  var cargaIds = [];
  var peds = [];
  try {
    var carga = _sembrarCargaPrueba_('TEST_LOTE2_EC_CARGA', 910, 'GENERADA');
    cargaIds.push(carga.id);
    var pA = _sembrarPedidoCarga_('TEST_LOTE2_EC_A', 'TEST_LOTE2_EC_A', 'Málaga', { numeroCarga: '910' });
    var pB = _sembrarPedidoCarga_('TEST_LOTE2_EC_B', 'TEST_LOTE2_EC_B', 'Málaga', { numeroCarga: '910' });
    peds.push('TEST_LOTE2_EC_A', 'TEST_LOTE2_EC_B');
    _sembrarCargaPedidoPrueba_(carga.id, pA.id, 0);
    _sembrarCargaPedidoPrueba_(carga.id, pB.id, 1);

    // Caso 1: ok
    var r1 = eliminarCargaCompletaViaSupabase(carga.id);
    _assertLote2_(r1.ok === true, 'Caso 1 (ok): ok=true (' + JSON.stringify(r1) + ')');
    _assertLote2_(r1.pedidosLiberados === 2, 'Caso 1: 2 pedidos liberados');
    _assertLote2_(r1.numCarga === 910, 'Caso 1: numCarga=910');

    var cargaRestante = _restStaging_('get', 'cargas?id=eq.' + carga.id + '&select=estado')[0];
    _assertLote2_(cargaRestante.estado === 'ELIMINADA', 'Caso 1: la fila de CARGAS sigue existiendo, marcada ELIMINADA (no deleteRow)');
    var cpRestante = _restStaging_('get', 'cargas_pedidos?carga_id=eq.' + carga.id + '&select=pedido_id');
    _assertLote2_(cpRestante.length === 2, 'Caso 1: cargas_pedidos NO se borra -- queda como histórico');
    var pARestante = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE2_EC_A&select=numero_carga')[0];
    _assertLote2_(pARestante.numero_carga === null, 'Caso 1: numero_carga del pedido liberado vuelve a NULL');

    // Caso 2: carga inexistente
    var r2 = eliminarCargaCompletaViaSupabase('TEST_LOTE2_EC_NOEXISTE');
    _assertLote2_(r2.ok === false && r2.error === 'Carga no encontrada', 'Caso 2 (carga inexistente): error específico');

    // Caso 3: carga ya cerrada
    var cargaCerrada = _sembrarCargaPrueba_('TEST_LOTE2_EC_CERRADA', 911, 'CERRADA');
    cargaIds.push(cargaCerrada.id);
    var r3 = eliminarCargaCompletaViaSupabase(cargaCerrada.id);
    _assertLote2_(r3.ok === false && r3.error === 'Esta carga ya está cerrada, no se puede eliminar',
      'Caso 3 (carga cerrada): rechazada');

    Logger.log('=== ejecutarPruebaEliminarCargaCompletaLote2: TODO PASS ===');
  } finally {
    _limpiarPruebaLote2_(cargaIds, peds);
  }
}

/**
 * Prueba funcional de anadirPedidoACargaViaSupabase -- 9 casos, cubriendo el
 * orden de diagnóstico real de la RPC (found principal -> segunda búsqueda
 * sin condiciones -> silueta -> entregado -> otra carga activa) MÁS el
 * mecanismo anti-duplicados por id (Caso 9):
 * 1) ok: pedido disponible añadido a carga GENERADA -> posicion=0, total=1,
 *    numero_carga escrito en PEDIDOS.
 * 2) mismo pedido, misma carga otra vez -> 'Ese pedido ya está en esta carga'.
 * 3) carga inexistente.
 * 4) carga ya cerrada.
 * 5) pedido inexistente -> 'Pedido no encontrado'.
 * 6) pedido sin silueta -> 'Este pedido no está en ninguna silueta'.
 * 7) pedido entregado -> 'Este pedido ya está entregado'.
 * 8) pedido ya vinculado a OTRA carga GENERADA -> 'Este pedido ya está
 *    incluido en otra carga activa'.
 * 9) DOS pedidos con el MISMO número de pedido ('ped') en tiendas distintas
 *    -- uno disponible (Málaga), otro NO disponible (Marbella, ENTREGADO).
 *    Verifica que se resuelve por el id/disponibilidad CORRECTO (el de
 *    Málaga), nunca mezclando los datos de un pedido con la disponibilidad
 *    de otro -- el mecanismo "CLAVE anti-duplicados" que tanto el RPC
 *    (FOR UPDATE OF p1) como Backend.gs real documentan explícitamente
 *    como la razón de ser del diseño, y que ningún caso anterior ejercitaba.
 */
function ejecutarPruebaAnadirPedidoACargaLote2() {
  var cargaIds = [];
  var peds = [];
  try {
    var carga = _sembrarCargaPrueba_('TEST_LOTE2_AP_CARGA', 920, 'GENERADA');
    cargaIds.push(carga.id);

    // Caso 1: ok, pedido disponible
    var p1 = _sembrarPedidoCarga_('TEST_LOTE2_AP_1', 'TEST_LOTE2_AP_1', 'Málaga');
    peds.push('TEST_LOTE2_AP_1');
    var r1 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_AP_1');
    _assertLote2_(r1.ok === true, 'Caso 1 (ok): ok=true (' + JSON.stringify(r1) + ')');
    _assertLote2_(r1.total === 1, 'Caso 1: total=1');
    _assertLote2_(r1.numCarga === 920, 'Caso 1: numCarga=920');
    var cp1 = _restStaging_('get', 'cargas_pedidos?carga_id=eq.' + carga.id + '&pedido_id=eq.TEST_LOTE2_AP_1&select=posicion')[0];
    _assertLote2_(cp1.posicion === 0, 'Caso 1: posicion=0 (primer pedido de la carga)');
    var p1Restante = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE2_AP_1&select=numero_carga')[0];
    _assertLote2_(p1Restante.numero_carga === '920', 'Caso 1: numero_carga escrito en PEDIDOS');

    // Caso 2: ese pedido ya está en esta carga
    var r2 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_AP_1');
    _assertLote2_(r2.ok === false && r2.error === 'Ese pedido ya está en esta carga', 'Caso 2: rechazado por duplicado en la misma carga');

    // Caso 3: carga inexistente
    var r3 = anadirPedidoACargaViaSupabase('TEST_LOTE2_AP_NOEXISTE', 'TEST_LOTE2_AP_1');
    _assertLote2_(r3.ok === false && r3.error === 'Carga no encontrada', 'Caso 3: carga inexistente');

    // Caso 4: carga cerrada
    var cargaCerrada = _sembrarCargaPrueba_('TEST_LOTE2_AP_CERRADA', 921, 'CERRADA');
    cargaIds.push(cargaCerrada.id);
    var p4 = _sembrarPedidoCarga_('TEST_LOTE2_AP_4', 'TEST_LOTE2_AP_4', 'Málaga');
    peds.push('TEST_LOTE2_AP_4');
    var r4 = anadirPedidoACargaViaSupabase(cargaCerrada.id, 'TEST_LOTE2_AP_4');
    _assertLote2_(r4.ok === false && r4.error === 'Esta carga ya está cerrada, no se puede modificar', 'Caso 4: carga cerrada rechazada');

    // Caso 5: pedido no encontrado
    var r5 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_AP_NOEXISTE');
    _assertLote2_(r5.ok === false && r5.error === 'Pedido no encontrado', 'Caso 5: pedido inexistente');

    // Caso 6: pedido sin silueta
    var p6 = _sembrarPedidoCarga_('TEST_LOTE2_AP_6', 'TEST_LOTE2_AP_6', 'Málaga', { silueta: null });
    peds.push('TEST_LOTE2_AP_6');
    var r6 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_AP_6');
    _assertLote2_(r6.ok === false && r6.error === 'Este pedido no está en ninguna silueta', 'Caso 6: pedido sin silueta');

    // Caso 7: pedido entregado
    var p7 = _sembrarPedidoCarga_('TEST_LOTE2_AP_7', 'TEST_LOTE2_AP_7', 'Málaga', { estado: 'ENTREGADO' });
    peds.push('TEST_LOTE2_AP_7');
    var r7 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_AP_7');
    _assertLote2_(r7.ok === false && r7.error === 'Este pedido ya está entregado', 'Caso 7: pedido entregado');

    // Caso 8: pedido ya incluido en otra carga activa
    var otraCarga = _sembrarCargaPrueba_('TEST_LOTE2_AP_OTRA', 922, 'GENERADA');
    cargaIds.push(otraCarga.id);
    var p8 = _sembrarPedidoCarga_('TEST_LOTE2_AP_8', 'TEST_LOTE2_AP_8', 'Málaga', { numeroCarga: '922' });
    peds.push('TEST_LOTE2_AP_8');
    _sembrarCargaPedidoPrueba_(otraCarga.id, p8.id, 0);
    var r8 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_AP_8');
    _assertLote2_(r8.ok === false && r8.error === 'Este pedido ya está incluido en otra carga activa', 'Caso 8: pedido ya en otra carga activa');

    // Caso 9: MISMO ped en dos tiendas -- uno disponible (Málaga), otro NO
    // disponible (Marbella, ENTREGADO). Debe resolver por el id/disponible
    // real (Málaga), nunca mezclar datos del pedido de Marbella.
    var pDupOk = _sembrarPedidoCarga_('TEST_LOTE2_AP_DUP_MALAGA', 'TEST_LOTE2_AP_DUP', 'Málaga');
    var pDupNo = _sembrarPedidoCarga_('TEST_LOTE2_AP_DUP_MARBELLA', 'TEST_LOTE2_AP_DUP', 'Marbella', { estado: 'ENTREGADO' });
    peds.push('TEST_LOTE2_AP_DUP'); // ambos comparten el mismo `ped` -- un solo filtro los limpia a los dos
    var r9 = anadirPedidoACargaViaSupabase(carga.id, 'TEST_LOTE2_AP_DUP');
    _assertLote2_(r9.ok === true, 'Caso 9 (ped duplicado entre tiendas): ok=true, resuelve el disponible (' + JSON.stringify(r9) + ')');
    var cp9 = _restStaging_('get', 'cargas_pedidos?carga_id=eq.' + carga.id + '&pedido_id=eq.TEST_LOTE2_AP_DUP_MALAGA&select=pedido_id');
    _assertLote2_(cp9.length === 1, 'Caso 9: el vínculo real es con el pedido de Málaga (el disponible), no con el de Marbella');
    var cp9Marbella = _restStaging_('get', 'cargas_pedidos?carga_id=eq.' + carga.id + '&pedido_id=eq.TEST_LOTE2_AP_DUP_MARBELLA&select=pedido_id');
    _assertLote2_(cp9Marbella.length === 0, 'Caso 9: el pedido de Marbella (ENTREGADO, no disponible) NO quedó vinculado');

    Logger.log('=== ejecutarPruebaAnadirPedidoACargaLote2: TODO PASS ===');
  } finally {
    _limpiarPruebaLote2_(cargaIds, peds);
  }
}

/**
 * Concurrencia real de anadir_pedido_a_carga: 2 cargas GENERADA distintas
 * intentan añadir el MISMO pedido a la vez (UrlFetchApp.fetchAll -- un `for`
 * normal en Apps Script es de un solo hilo y nunca simularía una carrera
 * real). El FOR UPDATE OF p1 sobre la fila del pedido candidato serializa
 * las dos peticiones dentro de Postgres; exactamente UNA debe ganar y la
 * otra debe perder con el mensaje específico 'Este pedido ya está incluido
 * en otra carga activa' (verificado a nivel RPC contra staging el 13/08 --
 * ver memoria del proyecto). El pedido debe terminar vinculado a UNA sola
 * carga, nunca dos.
 */
function ejecutarConcurrenciaAnadirPedidoLote2() {
  var cargaIds = [];
  var peds = [];
  try {
    var cargaA = _sembrarCargaPrueba_('TEST_LOTE2_CC_A', 930, 'GENERADA');
    var cargaB = _sembrarCargaPrueba_('TEST_LOTE2_CC_B', 931, 'GENERADA');
    cargaIds.push(cargaA.id, cargaB.id);
    var pedido = _sembrarPedidoCarga_('TEST_LOTE2_CC_P', 'TEST_LOTE2_CC_P', 'Málaga');
    peds.push('TEST_LOTE2_CC_P');

    var resultados = _dispararEnParalelo_('anadir_pedido_a_carga', [
      { p_id_carga: cargaA.id, p_num_ped: 'TEST_LOTE2_CC_P' },
      { p_id_carga: cargaB.id, p_num_ped: 'TEST_LOTE2_CC_P' }
    ]);

    var ganadores = resultados.filter(function(r) { return r.body && r.body.ok === true; });
    var perdedores = resultados.filter(function(r) { return !(r.body && r.body.ok === true); });
    _assertLote2_(ganadores.length === 1, 'Concurrencia añadir: exactamente 1 gana (hubo ' + ganadores.length + ', ' + JSON.stringify(resultados) + ')');
    _assertLote2_(perdedores.length === 1 && perdedores[0].body.error === 'Este pedido ya está incluido en otra carga activa',
      'Concurrencia añadir: el perdedor recibe el mensaje específico de carga activa (' + JSON.stringify(perdedores[0]) + ')');

    var vinculos = _restStaging_('get', 'cargas_pedidos?pedido_id=eq.TEST_LOTE2_CC_P&select=carga_id');
    _assertLote2_(vinculos.length === 1, 'Concurrencia añadir: el pedido queda vinculado a UNA sola carga (no duplicado)');

    var pedidoRestante = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE2_CC_P&select=numero_carga')[0];
    var numCargaGanadora = ganadores[0].body.numCarga;
    _assertLote2_(pedidoRestante.numero_carga === String(numCargaGanadora),
      'Concurrencia añadir: numero_carga del pedido coincide con la carga ganadora (' + numCargaGanadora + ')');

    Logger.log('=== ejecutarConcurrenciaAnadirPedidoLote2: TODO PASS ===');
  } finally {
    _limpiarPruebaLote2_(cargaIds, peds);
  }
}
