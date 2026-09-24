/**
 * ============================================================
 * PruebasLote1Staging.gs · Pruebas funcionales y de concurrencia del Lote 1
 * ============================================================
 * Todas las pruebas siembran sus propios pedidos sintéticos (prefijo
 * TEST_LOTE1_, silueta ZTEST -- fuera del rango real A-F) en `staging` y los
 * limpian en un `finally`, pase o falle la prueba. Ejecutar
 * ejecutarTodoLote1Staging() (primera función del archivo, autoseleccionada
 * en el editor) para correrlas todas en orden, o cualquier ejecutar*
 * individual para depurar una sola.
 */

var SILUETA_PRUEBA_LOTE1 = 'ZTEST';

/**
 * Runner maestro del Lote 1: ejecuta las 9 pruebas (5 funcionales + 4 de
 * concurrencia) en orden y para en el primer fallo. Colocada a propósito
 * como PRIMERA función del archivo -- mismo motivo que MigracionFase2.gs:
 * el desplegable del editor autoselecciona la primera función, cero
 * ambigüedad sobre qué se ejecuta.
 */
function ejecutarTodoLote1Staging() {
  var pruebas = [
    ejecutarPruebaCerrarPedidoLote1,
    ejecutarPruebaMoverPedidoLote1,
    ejecutarPruebaCorregirSoportesLote1,
    ejecutarPruebaLiberarPedidoLote1,
    ejecutarPruebaCompactarLote1,
    ejecutarConcurrenciaCerrarNormalLote1,
    ejecutarConcurrenciaCerrarRemansurLote1,
    ejecutarConcurrenciaCompartirFrenteLote1,
    ejecutarConcurrenciaLiberarLote1
  ];
  for (var i = 0; i < pruebas.length; i++) {
    try {
      pruebas[i]();
    } catch (e) {
      Logger.log('*** PARADO en la prueba #' + (i + 1) + ' (' + pruebas[i].name + '): ' + e.message + ' ***');
      return;
    }
  }
  var resto = _restStaging_('get', 'ocupacion_siluetas?silueta=eq.' + SILUETA_PRUEBA_LOTE1 + '&select=pos');
  Logger.log(resto.length === 0
    ? '=== TODAS LAS PRUEBAS DEL LOTE 1 PASARON, staging.' + SILUETA_PRUEBA_LOTE1 + ' quedó limpio ==='
    : '*** ADVERTENCIA: quedaron ' + resto.length + ' filas residuales en silueta ' + SILUETA_PRUEBA_LOTE1 + ' -- revisar limpieza ***');
}

/**
 * Siembra (o confirma que ya existe) la silueta de prueba en config_siluetas
 * -- idempotente vía upsert, se puede llamar en cada prueba sin problema.
 * Sin esto, _max_pos_silueta('ZTEST') devuelve null y cualquier RPC que
 * reclame una posición real falla con "Silueta desconocida".
 */
function _asegurarSiluetaPrueba_() {
  _restStaging_('post', 'config_siluetas', [{ silueta: SILUETA_PRUEBA_LOTE1, posiciones: 100 }],
    'resolution=merge-duplicates,return=minimal');
}

/**
 * Siembra un pedido sintético en staging.pedidos con silueta=null (aún sin
 * cerrar) -- listo para que una prueba lo cierre/mueva/corrija/libere.
 * `id`: string único, prefijado TEST_LOTE1_ por el llamador.
 */
function _sembrarPedidoPrueba_(id, ped, tienda, flujo, soportes) {
  var fila = {
    id: id, ped: ped, tienda: tienda, transportista: null, flujo: flujo,
    estado: 'EN_PREPARACION', pct: 100, operario: null,
    silueta: null, pos_ini: null, pos_fin: null, numero_carga: null,
    soportes: soportes, n_lin: 1, n_ubic: 1,
    actualizado: new Date().toISOString(), intento_carga: null,
    comentario: null, tipo_entrega: null, en_revision: false, sd_impreso: null
  };
  _restStaging_('post', 'pedidos', [fila]);
  return fila;
}

/** Siembra directamente una fila de ocupación (para pruebas que necesitan un hueco YA ocupado). */
function _sembrarOcupacionPrueba_(silueta, pos, layer, pedido, tienda, flujo, reservado) {
  _restStaging_('post', 'ocupacion_siluetas', [{
    silueta: silueta, pos: String(pos), layer: layer, pedido: pedido, tienda: tienda,
    flujo: flujo, reservado: !!reservado
  }]);
}

/** Borra TODO rastro de una tanda de pedidos de prueba (pedidos + su ocupación), por lista de `ped`. */
function _limpiarPruebaLote1_(peds) {
  if (!peds || !peds.length) return;
  var filtro = 'pedido=in.(' + peds.map(encodeURIComponent).join(',') + ')';
  try { _restStaging_('delete', 'ocupacion_siluetas?' + filtro); }
  catch (e) { Logger.log('⚠ _limpiarPruebaLote1_ (ocupacion_siluetas, filtro=' + filtro + '): ' + e.message); }
  var filtroPed = 'ped=in.(' + peds.map(encodeURIComponent).join(',') + ')';
  try { _restStaging_('delete', 'pedidos?' + filtroPed); }
  catch (e) { Logger.log('⚠ _limpiarPruebaLote1_ (pedidos, filtro=' + filtroPed + '): ' + e.message); }
}

/** Lee el estado actual de ocupación de la silueta de prueba (para aserciones). pos vuelve como STRING. */
function _leerOcupacionPrueba_() {
  return _restStaging_('get', 'ocupacion_siluetas?silueta=eq.' + SILUETA_PRUEBA_LOTE1 + '&select=*&order=pos.asc,layer.asc');
}

/** Assert mínimo: compara y lanza con mensaje claro si no coincide. */
function _assertLote1_(cond, mensaje) {
  if (!cond) throw new Error('FAIL: ' + mensaje);
  Logger.log('PASS: ' + mensaje);
}

/**
 * Prueba funcional de cerrarPedidoViaSupabase -- 4 casos:
 * 1) normal (transporte): reclama back+front en huecos libres.
 * 2) bultos (soportes con ocupa=0): va a posición 0, sin filas de ocupación.
 * 3) Remansur normal en posición LIBRE: reclama sin pasar por el chequeo lógico de conflicto que sí frena a un pedido normal (salta el EXISTS previo).
 * 3b) Remansur contra una colisión FÍSICA real (misma silueta+pos+layer ya ocupada): sigue fallando -- la PK de Postgres protege incluso a Remansur. CORRECCIÓN DE COMPRENSIÓN (2026-09-01, verificado contra validarAsignacionManual y ejecución real): "Remansur salta la validación" significa saltar el chequeo EXISTS lógico previo (línea 525 de Backend.gs, `if (esRemansur(flujo)) return {ok:true}` sin mirar ocupación), NO significa que pueda escribir dos filas físicas idénticas -- en Sheets esto SÍ podía pasar (appendRow no tiene restricción de unicidad, duplicación silenciosa posible), en Postgres la PK(silueta,pos,layer) lo impide para todos los flujos por igual. Es una mejora deliberada de la migración (ver documento padre, "el hallazgo más importante"), no una regresión ni un bug de esta prueba.
 * 4) Remansur compartir delante: un pedido de un solo soporte de 0.5 ocupa el front de una posición cuyo back ya es de OTRO pedido Remansur.
 */
function ejecutarPruebaCerrarPedidoLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    // Caso 1: normal, 1 soporte entero (ocupa=1) -> back+front en pos 1
    var soportesNormal = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_C1', 'TEST_LOTE1_C1', 'Málaga', 'transporte', soportesNormal);
    peds.push('TEST_LOTE1_C1');
    var r1 = cerrarPedidoViaSupabase('TEST_LOTE1_C1', SILUETA_PRUEBA_LOTE1, 1, soportesNormal, 'PRUEBA');
    _assertLote1_(r1.ok === true, 'Caso 1 (normal): ok=true (' + JSON.stringify(r1) + ')');
    _assertLote1_(r1.pos_ini === 1 && r1.pos_fin === 1, 'Caso 1: pos_ini=pos_fin=1');
    var ocup1 = _leerOcupacionPrueba_().filter(function(o) { return o.pos === '1'; });
    _assertLote1_(ocup1.length === 2, 'Caso 1: 2 filas de ocupación (back+front) en pos 1');

    // Caso 2: bultos, ocupa=0 -> posición 0, SIN filas de ocupación
    var soportesBultos = [{ tipoId: 'bulto', tipo: 'Bulto', cant: 3 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_C2', 'TEST_LOTE1_C2', 'Málaga', 'transporte', soportesBultos);
    peds.push('TEST_LOTE1_C2');
    var r2 = cerrarPedidoViaSupabase('TEST_LOTE1_C2', SILUETA_PRUEBA_LOTE1, 0, soportesBultos, 'PRUEBA');
    _assertLote1_(r2.ok === true && r2.pos_ini === 0 && r2.pos_fin === 0, 'Caso 2 (bultos): ok=true, pos 0');
    var ocup2 = _leerOcupacionPrueba_().filter(function(o) { return o.pedido === 'TEST_LOTE1_C2'; });
    _assertLote1_(ocup2.length === 0, 'Caso 2: cero filas de ocupación para bultos');

    // Caso 3: Remansur en posición LIBRE (pos 2, nadie la ha tocado) -- reclama sin pasar
    // por el chequeo EXISTS previo. No hay forma de demostrar "salta validación" con un
    // resultado ok:true DISTINTO de un pedido normal aquí (una posición libre la reclama
    // cualquiera) -- lo que sí se verifica es que NO pasa por el camino de error de
    // validación previa (ver Caso 3b para el límite real de "saltar validación").
    var soportesRemansur = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_C3', 'TEST_LOTE1_C3', 'Málaga', 'remansur_transporte', soportesRemansur);
    peds.push('TEST_LOTE1_C3');
    var r3 = cerrarPedidoViaSupabase('TEST_LOTE1_C3', SILUETA_PRUEBA_LOTE1, 2, soportesRemansur, 'PRUEBA');
    _assertLote1_(r3.ok === true, 'Caso 3 (Remansur en posición libre): ok=true (' + JSON.stringify(r3) + ')');

    // Caso 3b: Remansur contra una colisión FÍSICA real -- misma pos 1 que YA ocupó el Caso 1
    // por completo (back+front, flujo normal). La PK(silueta,pos,layer) de Postgres protege
    // esto para CUALQUIER flujo, incluido Remansur -- comportamiento real verificado, corrige
    // la comprensión inicial de esta prueba (ver comentario de cabecera de la función).
    var soportesRemansur3b = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_C3B', 'TEST_LOTE1_C3B', 'Málaga', 'remansur_transporte', soportesRemansur3b);
    peds.push('TEST_LOTE1_C3B');
    var r3b = cerrarPedidoViaSupabase('TEST_LOTE1_C3B', SILUETA_PRUEBA_LOTE1, 1, soportesRemansur3b, 'PRUEBA');
    _assertLote1_(r3b.ok === false && /no puede solapar/.test(r3b.error || ''),
      'Caso 3b (Remansur vs colisión física real): ok=false con el mensaje específico de Remansur (' + JSON.stringify(r3b) + ')');

    // Caso 4: Remansur compartir delante -- un soporte de 0.5 sobre una posición cuyo BACK ya es Remansur
    _sembrarOcupacionPrueba_(SILUETA_PRUEBA_LOTE1, 5, 'back', 'TEST_LOTE1_C4A', 'Málaga', 'remansur_transporte', false);
    _sembrarOcupacionPrueba_(SILUETA_PRUEBA_LOTE1, 5, 'front', 'TEST_LOTE1_C4A', 'Málaga', 'remansur_transporte', true);
    var soportesMedio = [{ tipoId: 'jaula', tipo: 'Jaula', ocupa: 0.5, cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_C4B', 'TEST_LOTE1_C4B', 'Málaga', 'remansur_pro', soportesMedio);
    peds.push('TEST_LOTE1_C4A', 'TEST_LOTE1_C4B');
    var r4 = cerrarPedidoViaSupabase('TEST_LOTE1_C4B', SILUETA_PRUEBA_LOTE1, 5, soportesMedio, 'PRUEBA');
    _assertLote1_(r4.ok === true && r4.compartido === true, 'Caso 4 (compartir delante): ok=true, compartido=true (' + JSON.stringify(r4) + ')');
    var ocup4 = _leerOcupacionPrueba_().filter(function(o) { return o.pos === '5' && o.layer === 'front'; });
    _assertLote1_(ocup4.length === 1 && ocup4[0].pedido === 'TEST_LOTE1_C4B' && ocup4[0].reservado === false,
      'Caso 4: front de pos 5 ahora es TEST_LOTE1_C4B, reservado=false');

    Logger.log('=== ejecutarPruebaCerrarPedidoLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/** Prueba funcional de moverPedidoDeSiluetaViaSupabase: pedido cerrado en pos 10, se mueve a pos 15 -- confirma que el hueco viejo (10) queda libre y el nuevo (15) reclamado. */
function ejecutarPruebaMoverPedidoLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_MOV', 'TEST_LOTE1_MOV', 'Málaga', 'transporte', soportes);
    peds.push('TEST_LOTE1_MOV');
    var cierre = cerrarPedidoViaSupabase('TEST_LOTE1_MOV', SILUETA_PRUEBA_LOTE1, 10, soportes, 'PRUEBA');
    _assertLote1_(cierre.ok === true, 'Setup: pedido cerrado en pos 10');

    var mov = moverPedidoDeSiluetaViaSupabase('TEST_LOTE1_MOV', SILUETA_PRUEBA_LOTE1, 15, soportes, 'Málaga');
    _assertLote1_(mov.ok === true, 'Mover: ok=true (' + JSON.stringify(mov) + ')');
    _assertLote1_(mov.pos_ini === 15 && mov.pos_fin === 15, 'Mover: nueva posición 15');

    var ocup = _leerOcupacionPrueba_();
    var enViejo = ocup.filter(function(o) { return o.pos === '10' && o.pedido === 'TEST_LOTE1_MOV'; });
    var enNuevo = ocup.filter(function(o) { return o.pos === '15' && o.pedido === 'TEST_LOTE1_MOV'; });
    _assertLote1_(enViejo.length === 0, 'Mover: pos 10 (vieja) liberada del todo');
    _assertLote1_(enNuevo.length === 2, 'Mover: pos 15 (nueva) tiene back+front');

    Logger.log('=== ejecutarPruebaMoverPedidoLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/** Prueba funcional de corregirSoportesPedidoViaSupabase: pedido cerrado con 1 posición, se corrige a 2 soportes enteros (2 posiciones) en la MISMA silueta/posIni -- confirma que crece a las 2 posiciones nuevas. */
function ejecutarPruebaCorregirSoportesLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportesIniciales = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_COR', 'TEST_LOTE1_COR', 'Málaga', 'transporte', soportesIniciales);
    peds.push('TEST_LOTE1_COR');
    var cierre = cerrarPedidoViaSupabase('TEST_LOTE1_COR', SILUETA_PRUEBA_LOTE1, 20, soportesIniciales, 'PRUEBA');
    _assertLote1_(cierre.ok === true, 'Setup: pedido cerrado en pos 20 (1 posición)');

    var soportesNuevos = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 2 }];
    var cor = corregirSoportesPedidoViaSupabase('TEST_LOTE1_COR', soportesNuevos, SILUETA_PRUEBA_LOTE1, 20, 'Málaga');
    _assertLote1_(cor.ok === true, 'Corregir: ok=true (' + JSON.stringify(cor) + ')');

    var ocup = _leerOcupacionPrueba_().filter(function(o) { return o.pedido === 'TEST_LOTE1_COR'; });
    _assertLote1_(ocup.length === 4, 'Corregir: ahora 4 filas de ocupación (2 posiciones x back+front)');

    Logger.log('=== ejecutarPruebaCorregirSoportesLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/** Prueba funcional de liberarPedidoDeSiluetaViaSupabase: pedido cerrado, se libera con disposicion='almacen' -- confirma que la ocupación desaparece, el pedido queda sin silueta, y el estado resultante es DEVUELTO_ALMACEN. */
function ejecutarPruebaLiberarPedidoLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_LIB', 'TEST_LOTE1_LIB', 'Málaga', 'transporte', soportes);
    peds.push('TEST_LOTE1_LIB');
    var cierre = cerrarPedidoViaSupabase('TEST_LOTE1_LIB', SILUETA_PRUEBA_LOTE1, 25, soportes, 'PRUEBA');
    _assertLote1_(cierre.ok === true, 'Setup: pedido cerrado en pos 25');

    var lib = liberarPedidoDeSiluetaViaSupabase('TEST_LOTE1_LIB', 'almacen', 'Prueba automática', 'Málaga');
    _assertLote1_(lib.ok === true, 'Liberar: ok=true (' + JSON.stringify(lib) + ')');
    _assertLote1_(lib.estado === 'DEVUELTO_ALMACEN', 'Liberar: disposicion=almacen → estado=DEVUELTO_ALMACEN');

    var ocup = _leerOcupacionPrueba_().filter(function(o) { return o.pos === '25'; });
    _assertLote1_(ocup.length === 0, 'Liberar: pos 25 completamente libre');

    var pedidoRestante = _restStaging_('get', 'pedidos?id=eq.TEST_LOTE1_LIB&select=*')[0];
    _assertLote1_(pedidoRestante.silueta === null, 'Liberar: pedido sin silueta tras liberar');

    Logger.log('=== ejecutarPruebaLiberarPedidoLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/** Prueba funcional de aplicarCompactarSiluetasViaSupabase: pedido en pos 30, se compacta a pos 1 (libre). */
function ejecutarPruebaCompactarLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_CMP', 'TEST_LOTE1_CMP', 'Málaga', 'transporte', soportes);
    peds.push('TEST_LOTE1_CMP');
    var cierre = cerrarPedidoViaSupabase('TEST_LOTE1_CMP', SILUETA_PRUEBA_LOTE1, 30, soportes, 'PRUEBA');
    _assertLote1_(cierre.ok === true, 'Setup: pedido cerrado en pos 30');

    var posiciones = calcularPosiciones(soportes);
    var movimientos = [{
      ped: 'TEST_LOTE1_CMP', tienda: 'Málaga', flujo: 'transporte',
      siluetaVieja: SILUETA_PRUEBA_LOTE1, posIniVieja: 30, posFinVieja: 30,
      siluetaNueva: SILUETA_PRUEBA_LOTE1, posIniNueva: 1, posFinNueva: 1,
      posiciones: posiciones
    }];
    var res = aplicarCompactarSiluetasViaSupabase(movimientos);
    _assertLote1_(res.ok === true, 'Compactar: ok=true (' + JSON.stringify(res) + ')');
    _assertLote1_(res.aplicados === 1, 'Compactar: 1 movimiento aplicado');
    _assertLote1_(res.omitidos.length === 0, 'Compactar: cero omitidos');

    var ocup = _leerOcupacionPrueba_();
    var enOrigen = ocup.filter(function(o) { return o.pos === '30' && o.pedido === 'TEST_LOTE1_CMP'; });
    var enDestino = ocup.filter(function(o) { return o.pos === '1' && o.pedido === 'TEST_LOTE1_CMP'; });
    _assertLote1_(enOrigen.length === 0, 'Compactar: pos 30 (origen) liberada');
    _assertLote1_(enDestino.length === 2, 'Compactar: pos 1 (destino) tiene back+front de TEST_LOTE1_CMP');

    Logger.log('=== ejecutarPruebaCompactarLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/** Concurrencia: 2 pedidos NO-Remansur, misma posición, en paralelo real -- exactamente uno debe ganar. */
function ejecutarConcurrenciaCerrarNormalLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_CC1', 'TEST_LOTE1_CC1', 'Málaga', 'transporte', soportes);
    _sembrarPedidoPrueba_('TEST_LOTE1_CC2', 'TEST_LOTE1_CC2', 'Málaga', 'transporte', soportes);
    peds.push('TEST_LOTE1_CC1', 'TEST_LOTE1_CC2');

    var posiciones = calcularPosiciones(soportes);
    var resultados = _dispararEnParalelo_('cerrar_pedido', [
      { p_id_pedido: 'TEST_LOTE1_CC1', p_silueta: SILUETA_PRUEBA_LOTE1, p_pos_ini: 40, p_posiciones: posiciones, p_soportes: soportes, p_operario: 'PRUEBA' },
      { p_id_pedido: 'TEST_LOTE1_CC2', p_silueta: SILUETA_PRUEBA_LOTE1, p_pos_ini: 40, p_posiciones: posiciones, p_soportes: soportes, p_operario: 'PRUEBA' }
    ]);

    var ganadores = resultados.filter(function(r) { return r.body && r.body.ok === true; });
    var perdedores = resultados.filter(function(r) { return !(r.body && r.body.ok === true); });
    _assertLote1_(ganadores.length === 1, 'Concurrencia normal: exactamente 1 ganador (hubo ' + ganadores.length + ', ' + JSON.stringify(resultados) + ')');
    _assertLote1_(perdedores.length === 1, 'Concurrencia normal: exactamente 1 perdedor');

    var ocup = _leerOcupacionPrueba_().filter(function(o) { return o.pos === '40'; });
    _assertLote1_(ocup.length === 2, 'Concurrencia normal: solo 2 filas en pos 40 (no 4) -- sin duplicado');

    Logger.log('=== ejecutarConcurrenciaCerrarNormalLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/**
 * Concurrencia Remansur: 2 pedidos Remansur, misma posición EXACTA, en paralelo.
 * CORRECCIÓN DE COMPRENSIÓN (2026-09-01, ver Caso 3b de ejecutarPruebaCerrarPedidoLote1
 * para el detalle): "Remansur salta la validación" es saltar el chequeo EXISTS lógico
 * previo, NO una excepción a la PK física de Postgres -- exactamente UNO gana (igual que
 * el caso normal de ejecutarConcurrenciaCerrarNormalLote1), el perdedor recibe el mensaje
 * específico de colisión física de Remansur, no el genérico de validación previa.
 */
function ejecutarConcurrenciaCerrarRemansurLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_CR1', 'TEST_LOTE1_CR1', 'Málaga', 'remansur_transporte', soportes);
    _sembrarPedidoPrueba_('TEST_LOTE1_CR2', 'TEST_LOTE1_CR2', 'Málaga', 'remansur_transporte', soportes);
    peds.push('TEST_LOTE1_CR1', 'TEST_LOTE1_CR2');

    var posiciones = calcularPosiciones(soportes);
    var resultados = _dispararEnParalelo_('cerrar_pedido', [
      { p_id_pedido: 'TEST_LOTE1_CR1', p_silueta: SILUETA_PRUEBA_LOTE1, p_pos_ini: 45, p_posiciones: posiciones, p_soportes: soportes, p_operario: 'PRUEBA' },
      { p_id_pedido: 'TEST_LOTE1_CR2', p_silueta: SILUETA_PRUEBA_LOTE1, p_pos_ini: 45, p_posiciones: posiciones, p_soportes: soportes, p_operario: 'PRUEBA' }
    ]);

    var ganadores = resultados.filter(function(r) { return r.body && r.body.ok === true; });
    var perdedores = resultados.filter(function(r) { return !(r.body && r.body.ok === true); });
    _assertLote1_(ganadores.length === 1, 'Concurrencia Remansur: exactamente 1 gana (hubo ' + ganadores.length + ', ' + JSON.stringify(resultados) + ')');
    _assertLote1_(perdedores.length === 1 && /no puede solapar/.test((perdedores[0].body && perdedores[0].body.error) || ''),
      'Concurrencia Remansur: el perdedor recibe el mensaje específico de colisión física de Remansur');

    var ocup = _leerOcupacionPrueba_().filter(function(o) { return o.pos === '45'; });
    _assertLote1_(ocup.length === 2, 'Concurrencia Remansur: solo 2 filas en pos 45 (no 4) -- sin duplicado');

    Logger.log('=== ejecutarConcurrenciaCerrarRemansurLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/** Concurrencia compartir_frente_remansur: un back Remansur ya ocupado, 2 pedidos intentan compartir el mismo front en paralelo -- solo UNO debe ganar el reservado=false. */
function ejecutarConcurrenciaCompartirFrenteLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    _sembrarOcupacionPrueba_(SILUETA_PRUEBA_LOTE1, 50, 'back', 'TEST_LOTE1_CF_BACK', 'Málaga', 'remansur_transporte', false);
    _sembrarOcupacionPrueba_(SILUETA_PRUEBA_LOTE1, 50, 'front', 'TEST_LOTE1_CF_BACK', 'Málaga', 'remansur_transporte', true);
    peds.push('TEST_LOTE1_CF_BACK');

    var resultados = _dispararEnParalelo_('compartir_frente_remansur', [
      { p_silueta: SILUETA_PRUEBA_LOTE1, p_pos: 50, p_ped: 'TEST_LOTE1_CF_A', p_tienda: 'Málaga', p_flujo: 'remansur_transporte' },
      { p_silueta: SILUETA_PRUEBA_LOTE1, p_pos: 50, p_ped: 'TEST_LOTE1_CF_B', p_tienda: 'Málaga', p_flujo: 'remansur_transporte' }
    ]);
    // El ganador reescribe `pedido` en la fila front (CF_A o CF_B) -- hay que
    // limpiar por los 3 nombres, no solo CF_BACK, o el ganador queda huérfano.
    peds.push('TEST_LOTE1_CF_A', 'TEST_LOTE1_CF_B');

    var ganadores = resultados.filter(function(r) { return r.body === true; });
    _assertLote1_(ganadores.length === 1, 'Concurrencia compartir frente: exactamente 1 gana (hubo ' + ganadores.length + ', ' + JSON.stringify(resultados) + ')');

    var front = _leerOcupacionPrueba_().filter(function(o) { return o.pos === '50' && o.layer === 'front'; })[0];
    _assertLote1_(front.reservado === false, 'Concurrencia compartir frente: front queda reservado=false');
    _assertLote1_(front.pedido === 'TEST_LOTE1_CF_A' || front.pedido === 'TEST_LOTE1_CF_B', 'Concurrencia compartir frente: front asignado a uno de los dos candidatos');

    Logger.log('=== ejecutarConcurrenciaCompartirFrenteLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}

/** Concurrencia liberar: mismo pedido, 2 llamadas a liberar en paralelo (disposicion='almacen') -- no debe quedar en estado a medias (ocupación borrada a medias, o duplicada). */
function ejecutarConcurrenciaLiberarLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_doble', tipo: 'Palet Doble', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_CL', 'TEST_LOTE1_CL', 'Málaga', 'transporte', soportes);
    peds.push('TEST_LOTE1_CL');
    var cierre = cerrarPedidoViaSupabase('TEST_LOTE1_CL', SILUETA_PRUEBA_LOTE1, 55, soportes, 'PRUEBA');
    _assertLote1_(cierre.ok === true, 'Setup: pedido cerrado en pos 55');

    var resultados = _dispararEnParalelo_('liberar_pedido_de_silueta', [
      { p_num_ped: 'TEST_LOTE1_CL', p_disposicion: 'almacen', p_motivo: 'Prueba concurrencia', p_tienda: 'Málaga' },
      { p_num_ped: 'TEST_LOTE1_CL', p_disposicion: 'almacen', p_motivo: 'Prueba concurrencia', p_tienda: 'Málaga' }
    ]);

    var ocup = _leerOcupacionPrueba_().filter(function(o) { return o.pos === '55'; });
    _assertLote1_(ocup.length === 0, 'Concurrencia liberar: pos 55 completamente libre, sin restos');

    var exitosos = resultados.filter(function(r) { return r.body && r.body.ok === true; });
    _assertLote1_(exitosos.length >= 1, 'Concurrencia liberar: al menos una llamada tiene éxito (' + JSON.stringify(resultados) + ')');

    Logger.log('=== ejecutarConcurrenciaLiberarLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}
