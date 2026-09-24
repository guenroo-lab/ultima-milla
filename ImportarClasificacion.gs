/**
 * ============================================================
 * ImportarClasificacion.gs
 * Puente: convierte la clasificación de pedidos (Inventario.gs)
 * en PEDIDOS + LINEAS reales del sistema. Idempotente.
 * ============================================================
 *
 * El inventario de Pyxis es la fuente de verdad: un pedido solo aparece
 * mientras sigue vivo / con líneas por entregar. Por eso la importación es
 * idempotente: si el pedido YA existe en PEDIDOS, en CUALQUIER estado, se
 * respeta (no se duplica ni se pisa su preparación en curso) — incluido
 * ENTREGADO/DEVUELTO_ALMACEN/ENVIADO_TIENDA/SALIDA_MANUAL, porque Pyxis
 * puede seguir listando un pedido varios días después de resuelto (el
 * almacén no lo actualiza al instante); antes de corregir esto, un pedido
 * ya entregado se recreaba como fila NUEVA con estado PENDIENTE cada vez
 * que se reimportaba mientras Pyxis siguiera listándolo (bug real: el
 * pedido "reaparecía" constantemente en la lista del operario).
 */

// Zona del clasificador → transportista del sistema
var ZONA_TRANSPORTISTA = {
  'Transporte': 'Correcaminos',
  'Instalaciones': 'Correcaminos Instalaciones',
  'PRO': 'Correcaminos PRO',
  'Remansur': 'Remansur'
};

/**
 * Importa al sistema los pedidos clasificados. Misma firma que clasificarPedidos.
 * numerosPorTransporte: { Transporte:[...], Instalaciones:[...], PRO:[...], Remansur:[...] }
 * opciones: { tiendaColisiones, parciales:[{ped,transporte,dirs:[...]}], comentarios:{numPed:texto} }
 * comentarios (opcional): instrucciones escritas a mano en el clasificador
 * ANTES de importar (ver clfSetComentario en Index.html) -- se guardan en
 * PEDIDOS.comentario, tanto si el pedido se crea ahora como si ya existía
 * (reimportar un lote no debe ser la única forma de dejar una instrucción).
 * Devuelve { ok, creados:[], omitidos:[], noEncontrados:[], colisiones:[] }
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/LINEAS/HIST_TRANSP ya viven en
// Postgres (public). public.importar_clasificacion(...) hace TODO el bloque
// "1) bloques pegados" + "2) parciales" (alta nueva o renovar direcciones)
// dentro de un advisory lock transaccional -- ya no hace falta el candado de
// Apps Script ni el diferido de sincronizarPedidoSupabase_. El inventario
// Pyxis (cargarInventario/indice) y resolverOcurrencia (colisiones de
// tienda) siguen resolviéndose aquí -- Postgres no puede leer Drive/Excel --
// así que se resuelven ANTES y se mandan ya decididos como 'entradas'.
// El bloque "3) forzados" sigue con leerHoja/actualizarFila/anadirFila
// (redirigen solas a Postgres) -- no tiene RPC propia.
function importarClasificacion(numerosPorTransporte, opciones) {
  opciones = opciones || {};
  var tiendaColisiones = opciones.tiendaColisiones || null;
  var parciales = opciones.parciales || [];
  var comentarios = opciones.comentarios || {};
  // forzar=true: este es el paso que de verdad ESCRIBE en PEDIDOS/LINEAS, a
  // diferencia de clasificarPedidos (solo vista previa) — si se dejara la
  // caché de 30 min (cargarInventario sin forzar) y administración acabara
  // de subir un Excel con líneas nuevas, la importación podía usar el
  // inventario viejo y esas líneas nunca llegaban a LINEAS_PREPARACION hasta
  // que la caché caducara sola o alguien pulsara "Recargar inventarios" a
  // mano (bug real reportado: "a veces no me salen las líneas nuevas").
  var inv = cargarInventario(null, true);
  var indice = inv.indice;

  // Snapshot de PEDIDOS SOLO para decidir omitidosForzables (pista de UI,
  // best-effort) -- el RPC es quien decide de verdad, bajo `for update`.
  var existentes = {};
  leerHoja('PEDIDOS').forEach(function(p) { existentes[p.id] = p.estado; });

  var esParcial = {};
  parciales.forEach(function(p) { esParcial[p.transporte + '|' + String(p.ped).trim()] = true; });

  var noEncontrados = [], colisiones = [], omitidosForzables = [], entradas = [];

  function resolver(numPed, transporte, dirsSel) {
    var transportista = ZONA_TRANSPORTISTA[transporte];
    if (!transportista) { return; }
    var entry = indice[numPed];
    if (!entry) { noEncontrados.push(numPed + ' (no está en el inventario de Pyxis)'); return; }
    var r = resolverOcurrencia(entry, tiendaColisiones);
    if (r.colision) { colisiones.push({ ped: numPed, transporte: transporte, tiendas: r.tiendas }); return; }
    var tienda = r.tienda;
    if (CONFIG.TIENDAS.indexOf(tienda) === -1) { noEncontrados.push(numPed + ' (' + tienda + ' fuera de expedición)'); return; }
    var idPedido = codigoTienda(tienda) + '::' + numPed;

    var lineasRaw = r.data.lineas;
    if (dirsSel && dirsSel.length) {
      lineasRaw = lineasRaw.filter(function(l) { return dirsSel.indexOf(l.dir) !== -1; });
    }

    var estadoExistente = existentes[idPedido];
    if (estadoExistente !== undefined && ESTADOS_TERMINALES[estadoExistente]) {
      omitidosForzables.push({ ped: numPed, tienda: tienda, transporte: transporte, estadoLabel: ESTADO_LABEL[estadoExistente] || estadoExistente });
    }

    entradas.push({
      ped: numPed, tienda: tienda, transporte: transporte,
      lineas: lineasRaw, esParcial: !!(dirsSel && dirsSel.length),
      comentario: comentarios[numPed] || ''
    });
  }

  // 1) bloques pegados
  TRANSPORTES.forEach(function(t) {
    var nums = (numerosPorTransporte[t] || []).map(function(n) { return String(n).trim(); }).filter(Boolean);
    nums.forEach(function(n) { if (esParcial[t + '|' + n]) return; resolver(n, t, null); });
  });
  // 2) parciales (solo las direcciones elegidas)
  parciales.forEach(function(p) {
    resolver(String(p.ped).trim(), p.transporte, (p.dirs || []).map(function(d) { return String(d).trim(); }));
  });

  var r = _rpcPublic_('importar_clasificacion', { p_entradas: entradas });
  if (!r.ok) return r;

  var creados = r.creados || [];
  var omitidos = r.omitidos || [];
  noEncontrados = noEncontrados.concat(r.noEncontrados || []);

  // 3) forzados: pedidos que YA se saltaron por estado terminal en una importación
  // anterior y el usuario decide, explícitamente y uno a uno desde el Clasificador, que
  // SÍ han vuelto de verdad y hay que volver a prepararlos -- con las direcciones
  // FRESCAS de Pyxis ahora mismo (no las líneas viejas: para eso ya existe
  // reabrirPedido). opciones.forzados: [{ ped, tienda, dirsSel }] -- no lleva
  // 'transporte': el forzado NO cambia transportista/flujo, se queda el que ya tenía el
  // pedido (solo se usa el zona→transportista al darlo de alta la primera vez).
  // existentesFrescos: releído DESPUÉS del RPC -- el import de arriba puede haber
  // cambiado el estado de pedidos que también aparezcan como forzados.
  var existentesFrescos = {};
  leerHoja('PEDIDOS').forEach(function(p) { existentesFrescos[p.id] = p.estado; });

  var forzadosOk = [], forzadosError = [];
  (opciones.forzados || []).forEach(function(f) {
    var numPedF = String(f.ped).trim();
    var tiendaF = f.tienda;
    var idPedidoF = codigoTienda(tiendaF) + '::' + numPedF;

    // Revalidar AHORA, no fiarse del estado que tenía cuando se listó como omitido --
    // puede haber pasado tiempo desde entonces (alguien más pudo reabrirlo mientras
    // tanto por otra vía, p.ej. reabrirPedido desde 🔍 Buscar).
    var estadoActualF = existentesFrescos[idPedidoF];
    if (estadoActualF === undefined || !ESTADOS_TERMINALES[estadoActualF]) {
      forzadosError.push({ ped: numPedF, motivo: 'Ya no está en un estado que se pueda forzar (puede que alguien ya lo reabriera)' });
      return;
    }

    var entryF = indice[numPedF];
    if (!entryF || !entryF.porTienda[tiendaF]) {
      forzadosError.push({ ped: numPedF, motivo: 'Ya no está en el inventario de Pyxis' });
      return;
    }

    var lineasRawF = entryF.porTienda[tiendaF].lineas;
    if (f.dirsSel && f.dirsSel.length) {
      lineasRawF = lineasRawF.filter(function(l) { return f.dirsSel.indexOf(l.dir) !== -1; });
    }
    if (!lineasRawF.length) {
      forzadosError.push({ ped: numPedF, motivo: 'No queda ninguna dirección seleccionada' });
      return;
    }

    var pedidoRowF = leerHoja('PEDIDOS').find(function(p) { return p.id === idPedidoF; });
    if (!pedidoRowF) {
      forzadosError.push({ ped: numPedF, motivo: 'Pedido no encontrado' });
      return;
    }
    var numeroCargaAnteriorF = pedidoRowF.numeroCarga;

    _borrarLineasDePedido(idPedidoF);
    var rF = _construirEInsertarLineas(idPedidoF, numPedF, lineasRawF);

    var cambiosForzarF = {
      estado: 'PENDIENTE', pct: 0, operario: '',
      silueta: '', posIni: '', posFin: '', numeroCarga: '',
      soportes: [], intentoCarga: '', comentario: '',
      nLin: rF.nLin, nUbic: rF.nUbic, parcial: !!(f.dirsSel && f.dirsSel.length),
      actualizado: new Date().toISOString()
    };
    actualizarFila('PEDIDOS', pedidoRowF._fila, cambiosForzarF);
    if (numeroCargaAnteriorF) _quitarPedidoDeSuCargaActiva(numeroCargaAnteriorF, numPedF);

    registrarHistorialTransportista(idPedidoF, numPedF, pedidoRowF.tienda, pedidoRowF.transportista, pedidoRowF.flujo, 'REABIERTO_FORZADO');

    existentesFrescos[idPedidoF] = 'PENDIENTE';
    forzadosOk.push(numPedF);
  });

  logActividad('IMPORTAR_CLASIF', creados.length + ' creados, ' + omitidos.length + ' omitidos, ' + noEncontrados.length + ' no encontrados' +
    ((forzadosOk.length || forzadosError.length) ? ' · ' + forzadosOk.length + ' forzados, ' + forzadosError.length + ' forzados con error' : ''), '');
  return { ok: true, creados: creados, omitidos: omitidos, noEncontrados: noEncontrados, colisiones: colisiones, omitidosForzables: omitidosForzables, forzadosOk: forzadosOk, forzadosError: forzadosError };
}

/**
 * Resincroniza TODOS los pedidos activos (no terminales, todavía SIN
 * silueta) contra el inventario Pyxis más fresco de golpe — sin tener que
 * saber ni repegar el número de cada pedido que haya cambiado. Pensado para
 * pulsarlo después de subir un Excel nuevo, en vez de reimportar pedido a
 * pedido a mano. Mismo alcance/límite que renovarDireccionesPedidoExistente
 * (si el pedido YA tiene silueta, no se toca — se deja tal cual a propósito).
 * Los pedidos marcados PEDIDOS.parcial (importados a propósito con solo
 * algunas direcciones elegidas a mano) se excluyen del todo de este pase —
 * antes no se distinguían y esta resincronización podía volver a añadir las
 * direcciones que se habían dejado fuera a propósito (bug real, corregido
 * 2026-07-29 al añadir la columna 'parcial').
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/LINEAS/HIST_TRANSP ya viven en
// Postgres (public). public.resincronizar_pedidos_activos(...) hace TODO el
// pase (filtrar activos, emparejar contra el inventario, renovar
// direcciones) dentro de un advisory lock transaccional PROPIO (con reintento
// 100ms x20 = 2s, mismo timeout que el candado de Apps Script que sustituye)
// -- ya no hace falta LockService aquí. El inventario Pyxis sigue
// resolviéndose en Apps Script (Postgres no puede leer Drive/Excel) y se
// manda entero aplanado (ped/tienda/lineas), porque el RPC decide él mismo
// qué pedidos están activos ahora mismo en Postgres.
function resincronizarPedidosActivos() {
  var inv = cargarInventario(null, true); // siempre fresco, igual que importarClasificacion
  var indice = inv.indice;

  var pInventario = [];
  Object.keys(indice).forEach(function(numPed) {
    var entry = indice[numPed];
    Object.keys(entry.porTienda).forEach(function(tienda) {
      pInventario.push({ ped: numPed, tienda: tienda, lineas: entry.porTienda[tienda].lineas });
    });
  });

  var r = _rpcPublic_('resincronizar_pedidos_activos', { p_inventario: pInventario });
  if (!r.ok || r.omitidoPorSolape) return r;

  logActividad('RESYNC_PEDIDOS_ACTIVOS',
    r.actualizados.length + ' actualizados, ' + r.sinCambios + ' sin cambios, ' + r.noEncontrados.length + ' no encontrados en inventario', 'admin');
  if (r.actualizados.length) marcarResumenObsoleto();
  return r;
}

// ============================================================
// AUTO-RESYNC · disparador de tiempo para que resincronizarPedidosActivos()
// se ejecute SOLO, sin que nadie tenga que entrar a la app a pulsar nada.
// ============================================================

/**
 * Activa (o reactiva) la actualización automática: instala un disparador de
 * TIEMPO que llama a resincronizarPedidosActivos() cada 15 minutos. Borra
 * cualquier disparador previo de la MISMA función antes de crear uno nuevo,
 * para no acumular duplicados si se pulsa el botón más de una vez.
 * NOTA de permisos: la PRIMERA vez que se use ScriptApp.newTrigger en este
 * proyecto puede hacer falta autorizar el permiso nuevo una vez desde el
 * editor de Apps Script (mismo caso ya resuelto con MailApp/script.send_mail:
 * el despliegue como app web no puede conceder un permiso nuevo por sí solo,
 * hace falta que un humano lo apruebe una vez en el editor).
 */
function activarAutoResyncPedidos() {
  var reemplazados = _borrarTriggersResync();
  ScriptApp.newTrigger('resincronizarPedidosActivos').timeBased().everyMinutes(15).create();
  logActividad('AUTO_RESYNC_ACTIVADO', 'Actualización automática cada 15 min activada (' + reemplazados + ' disparador(es) anterior(es) sustituido(s))', 'admin');
  return { ok: true, reemplazados: reemplazados };
}

/** Desactiva la actualización automática (quita el/los disparador(es)). */
function desactivarAutoResyncPedidos() {
  var quitados = _borrarTriggersResync();
  logActividad('AUTO_RESYNC_DESACTIVADO', quitados + ' disparador(es) quitado(s)', 'admin');
  return { ok: true, quitados: quitados };
}

/** ¿Está activa la actualización automática ahora mismo? */
function estadoAutoResyncPedidos() {
  var activo = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === 'resincronizarPedidosActivos'; });
  return { ok: true, activo: activo };
}

function _borrarTriggersResync() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'resincronizarPedidosActivos') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/**
 * Sincroniza las líneas de un pedido YA EXISTENTE contra los datos frescos de
 * Pyxis (lineasNuevasRaw). Dos cosas, emparejando por 'ref' (la referencia
 * del artículo, que NO cambia; a diferencia de 'dir', que sí puede cambiar):
 *   1) AÑADE las direcciones genuinamente nuevas (ref sin pareja existente).
 *   2) ACTUALIZA la dirección de una línea ya existente si el MISMO artículo
 *      (misma ref) aparece ahora en un sitio distinto — el caso real que
 *      motiva esto: un artículo que llegó primero por tránsito tienda->
 *      plataforma ("Muelles": códigos de día como M1/X1/DEV/TIEND) y, al
 *      llegar físicamente a la plataforma, Pyxis ya le asigna su ubicación
 *      real definitiva. Si esa línea ya estaba marcada (PREPARADO/NO_SALE/
 *      NO_ENCONTRADO/POSPUESTO) con la dirección VIEJA, se resetea a
 *      PENDIENTE — lo marcado/aplazado en el sitio antiguo ya no vale, hay
 *      que ir a buscarlo al sitio nuevo. Solo se toca 'dir' (+ tipoUbic/
 *      esPicking derivados); NO se actualiza cantidad/descripción aunque
 *      también hubieran cambiado (fuera de alcance de este ajuste).
 *
 * Emparejamiento POSICIONAL dentro de cada grupo de 'ref' (no 1-a-1 directo):
 * un mismo ref puede tener MÁS DE UNA línea (p.ej. cantidad partida en dos
 * ubicaciones — crearPedidoConLineas no lo impide). Agrupamos existentes y
 * nuevas por ref y emparejamos la 1ª existente de ese ref con la 1ª nueva de
 * ese ref, la 2ª con la 2ª, etc. Si sobran nuevas del grupo (más ubicaciones
 * que antes), esas son altas nuevas. Si sobran existentes (menos que antes),
 * se dejan tal cual (esta función no borra). Sin este emparejamiento por
 * grupo, dos líneas nuevas del mismo ref pisarían la MISMA línea existente y
 * una de las dos ubicaciones se perdería en silencio (hallazgo real de la
 * revisión adversarial).
 *
 * ALCANCE (acordado con el usuario): SOLO mientras el pedido NO se haya
 * colocado aún en una silueta — más seguro. Si ya está colocado, se deja tal
 * cual (no se actualiza ni se libera nada automáticamente).
 *
 * transportistaNuevo: si se pasa y es DISTINTO del transportista que ya
 * tenía el pedido, se corrige (junto con el 'flujo' derivado, igual que al
 * crear un pedido nuevo) — caso real: se importó primero como Instalaciones
 * y luego se reimporta el mismo número bajo Transporte/Remansur. Antes esto
 * se ignoraba en silencio (el pedido se quedaba con el transporte del
 * primer import); ahora se corrige, SOLO mientras siga sin silueta.
 *
 * Devuelve { nuevas: n, actualizadas: n, yaEnSilueta: bool, transporteCambiado: bool }.
 */
// pedidosPre/lineasPre (opcionales): si quien llama YA leyó esas hojas
// enteras (p.ej. resincronizarPedidosActivos, que la llama una vez POR CADA
// pedido activo), se pasan para no releer PEDIDOS/LINEAS enteras desde cero
// en cada llamada — con muchos pedidos activos a la vez eso era releer la
// hoja completa N veces (mismo tipo de coste ya resuelto antes en
// marcarLinea/recalcularEstadoPedido con el parámetro lineasPre).
function renovarDireccionesPedidoExistente(idPedido, lineasNuevasRaw, transportistaNuevo, pedidosPre, lineasPre) {
  var pedidos = pedidosPre || leerHoja('PEDIDOS');
  var pedido = pedidos.find(function(p) { return p.id === idPedido; });
  if (!pedido) return { nuevas: 0, actualizadas: 0, yaEnSilueta: false, transporteCambiado: false };
  if (pedido.silueta) return { nuevas: 0, actualizadas: 0, yaEnSilueta: true, transporteCambiado: false };
  // Pedido importado a propósito como "parcial" (solo algunas direcciones
  // elegidas a mano, ver clfToggleParcial en Index.html): NUNCA tocar sus
  // direcciones automáticamente -- ni añadir las que se dejaron fuera a
  // propósito ni "corregir" su ubicación. Antes esto no se distinguía y una
  // reimportación o el disparador automático (resincronizarPedidosActivos,
  // cada 15 min) podía volver a meter las direcciones excluidas a propósito.
  if (pedido.parcial === true || pedido.parcial === 'true') {
    return { nuevas: 0, actualizadas: 0, yaEnSilueta: false, transporteCambiado: false, esParcial: true };
  }

  var lineasExistentes = (lineasPre || leerHoja('LINEAS')).filter(function(l) { return l.idPedido === idPedido; });
  var existentesPorRef = {};
  lineasExistentes.forEach(function(l) {
    if (!existentesPorRef[l.ref]) existentesPorRef[l.ref] = [];
    existentesPorRef[l.ref].push(l);
  });
  var consumidoPorRef = {}; // ref -> cuántas de ese grupo ya se han emparejado

  var lineasAAgregar = [];
  var actualizaciones = []; // { fila, cambios }
  lineasNuevasRaw.forEach(function(lNueva) {
    var grupo = existentesPorRef[lNueva.ref] || [];
    var idx = consumidoPorRef[lNueva.ref] || 0;
    if (idx >= grupo.length) { lineasAAgregar.push(lNueva); return; } // sin pareja existente que le quede: es alta nueva
    consumidoPorRef[lNueva.ref] = idx + 1;
    var existente = grupo[idx];
    if (String(existente.dir) === String(lNueva.dir)) return; // mismo sitio, nada que hacer
    var cambios = { dir: lNueva.dir, tipoUbic: clasificarUbicacion(lNueva.dir), esPicking: esPicking(lNueva.dir) };
    if (existente.estado === 'PREPARADO' || existente.estado === 'NO_SALE' || existente.estado === 'NO_ENCONTRADO' || existente.estado === 'POSPUESTO') {
      cambios.estado = 'PENDIENTE'; cambios.motivo = ''; cambios.operario = ''; cambios.ts = '';
    }
    actualizaciones.push({ fila: existente._fila, cambios: cambios });
  });

  actualizaciones.forEach(function(a) { actualizarFila('LINEAS', a.fila, a.cambios); });

  // DEDUPLICAR (2026-08-03): mismo motivo y misma función que
  // crearPedidoConLineas (ImportarPyxis.gs) -- una línea "nueva" repetida
  // aquí (por una carrera ya corregida, o por el propio Excel de Pyxis)
  // creaba tantas filas de LINEAS como copias hubiera, duplicando el
  // artículo en la pantalla del operario.
  var dedupNuevas = deduplicarLineasPyxis_(lineasAAgregar);
  if (dedupNuevas.colapsadas > 0) {
    logActividad('LINEAS_DUPLICADAS_COLAPSADAS', 'Pedido ' + idPedido + ': ' + dedupNuevas.colapsadas +
      ' línea(s) nueva(s) duplicada(s) colapsada(s) a 1 al resincronizar', 'sistema');
  }
  var ordenadas = ordenarLineasPyxis(dedupNuevas.lineas);
  var maxIdx = -1;
  lineasExistentes.forEach(function(l) { var i = Number(l.idx); if (i > maxIdx) maxIdx = i; });
  var filasNuevas = ordenadas.map(function(l, j) {
    return {
      id: idPedido + '::L' + (maxIdx + 1 + j), idPedido: idPedido, idx: maxIdx + 1 + j,
      dir: l.dir, ref: l.ref, ean: l.ean, des: l.des, ctd: l.ctd,
      tipoUbic: clasificarUbicacion(l.dir), esPicking: esPicking(l.dir),
      estado: 'PENDIENTE', motivo: '', operario: '', ts: ''
    };
  });
  if (filasNuevas.length) anadirFilas('LINEAS', filasNuevas);

  // Corregir transporte si se reimporta bajo uno distinto al que ya tenía
  // (p.ej. se metió primero como Instalaciones y ahora se pega en
  // Transporte) — el flujo se deriva del transportista, igual que al crear
  // un pedido nuevo (ver crearPedidoConLineas).
  var transporteCambiado = false;
  var cambiosPedido = { actualizado: new Date().toISOString() };
  if (transportistaNuevo && pedido.transportista !== transportistaNuevo) {
    cambiosPedido.transportista = transportistaNuevo;
    cambiosPedido.flujo = CONFIG.TRANSPORTISTAS_FLUJO[transportistaNuevo] || pedido.flujo;
    transporteCambiado = true;
    registrarHistorialTransportista(idPedido, pedido.ped, pedido.tienda, transportistaNuevo, cambiosPedido.flujo, 'REIMPORTADO');
  }

  if (!filasNuevas.length && !actualizaciones.length && !transporteCambiado) {
    return { nuevas: 0, actualizadas: 0, yaEnSilueta: false, transporteCambiado: false };
  }

  // Recalcular con TODAS las líneas (existentes ya actualizadas + nuevas) —
  // una relectura fresca, para no arrastrar el estado viejo de las líneas
  // que se acaban de resetear arriba.
  var todasLasLineas = leerHoja('LINEAS').filter(function(l) { return l.idPedido === idPedido; });
  var totalLineas = todasLasLineas.length;
  var procesadas = todasLasLineas.filter(function(l) {
    return l.estado === 'PREPARADO' || l.estado === 'NO_SALE' || l.estado === 'NO_ENCONTRADO';
  }).length;
  var preparadas = todasLasLineas.filter(function(l) { return l.estado === 'PREPARADO'; }).length;
  var pct = totalLineas > 0 ? Math.round((procesadas / totalLineas) * 100) : 0;
  var estadoNuevo;
  if (procesadas === totalLineas && preparadas === totalLineas) estadoNuevo = 'COMPLETADO_LISTO';
  else if (procesadas === totalLineas) estadoNuevo = 'PARCIAL_LISTO';
  else if (procesadas > 0) estadoNuevo = 'EN_PREPARACION';
  else estadoNuevo = 'PENDIENTE';

  var dirsUnicas = {};
  todasLasLineas.forEach(function(l) { dirsUnicas[l.dir] = true; });

  cambiosPedido.nLin = totalLineas;
  cambiosPedido.nUbic = Object.keys(dirsUnicas).length;
  cambiosPedido.pct = pct;
  cambiosPedido.estado = estadoNuevo;

  actualizarFila('PEDIDOS', pedido._fila, cambiosPedido);
  marcarResumenObsoleto();

  return { nuevas: filasNuevas.length, actualizadas: actualizaciones.length, yaEnSilueta: false, transporteCambiado: transporteCambiado };
}
