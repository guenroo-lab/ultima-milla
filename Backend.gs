/**
 * ============================================================
 * Backend.gs
 * Lógica de negocio. Funciones llamadas desde el frontend
 * mediante google.script.run.*
 * ============================================================
 *
 * Todas las funciones devuelven objetos JSON serializables.
 * No usar arrow functions ni template literals (compatibilidad GAS).
 */

// ============================================================
// CONFIGURACIÓN INICIAL PARA EL FRONTEND
// ============================================================
function obtenerConfig() {
  return {
    siluetas: CONFIG.SILUETAS,
    posiciones: CONFIG.POSICIONES_SILUETA,
    posicionesPorSilueta: posicionesPorSiluetaEfectivo(),
    tiendas: CONFIG.TIENDAS,
    operarios: obtenerOperarios(),
    transportistasFlujo: CONFIG.TRANSPORTISTAS_FLUJO,
    flujoLetra: CONFIG.FLUJO_LETRA,
    flujoLabel: CONFIG.FLUJO_LABEL,
    soportes: CONFIG.SOPORTES,
    horaCambioModo: CONFIG.HORA_CAMBIO_MODO
  };
}

// ============================================================
// OPERARIOS (editables, guardados en PropertiesService)
// ============================================================
function obtenerOperarios() {
  var raw = PropertiesService.getScriptProperties().getProperty('OPERARIOS');
  if (raw) {
    try { var a = JSON.parse(raw); if (a && a.length) return a; } catch (e) {}
  }
  return CONFIG.OPERARIOS; // por defecto, los del código
}

function guardarOperarios(lista) {
  var seen = {}, out = [];
  (lista || []).forEach(function(s) {
    var n = String(s).trim();
    if (n && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = true; out.push(n); }
  });
  PropertiesService.getScriptProperties().setProperty('OPERARIOS', JSON.stringify(out));
  return out;
}

// ============================================================
// CAPACIDAD DE SILUETA (ampliar/ajustar a mano, ver posicionesDeSilueta
// en Configuracion.gs — el override vive en PropertiesService)
// ============================================================
function obtenerCapacidadSiluetas() {
  var mapa = posicionesPorSiluetaEfectivo();
  return CONFIG.SILUETAS.map(function(s) {
    return { silueta: s, max: mapa[s] || CONFIG.POSICIONES_SILUETA };
  });
}

/**
 * Ajusta a mano la capacidad (nº de posiciones) de UNA silueta concreta —
 * pensado para poder AMPLIARLA y ganar espacio compactando mercancía, pero
 * también admite bajarla (con un suelo de seguridad: nunca por debajo de la
 * posición más alta que esa silueta tenga ocupada AHORA MISMO, ni en
 * OCUPACION_SILUETAS ni en PEDIDOS, para no dejar mercancía real "fuera" del
 * propio grid sin querer).
 */
function actualizarPosicionesSilueta(silueta, nuevoMax) {
  if (CONFIG.SILUETAS.indexOf(silueta) === -1) return { ok: false, error: 'Silueta desconocida' };
  var max = Math.floor(Number(nuevoMax));
  if (!max || max < 1) return { ok: false, error: 'Indica un número de posiciones válido' };

  var maxOcupada = 0;
  leerHoja('OCUPACION').forEach(function(o) {
    if (o.silueta === silueta) { var p = Number(o.pos) || 0; if (p > maxOcupada) maxOcupada = p; }
  });
  leerHoja('PEDIDOS').forEach(function(p) {
    if (p.silueta === silueta && Number(p.posIni) > 0) {
      var pf = Number(p.posFin) || Number(p.posIni);
      if (pf > maxOcupada) maxOcupada = pf;
    }
  });
  if (max < maxOcupada) {
    return { ok: false, error: 'No se puede bajar de ' + maxOcupada + ': hay mercancía ocupando esa posición ahora mismo' };
  }

  // CANDADO: el override es un único JSON con TODAS las siluetas dentro — si
  // dos admins guardan casi a la vez (misma silueta o distinta), sin esto la
  // segunda escritura pisaría por completo el JSON de la primera (read-
  // modify-write clásico), perdiendo en silencio el cambio recién guardado.
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  try {
    var props = PropertiesService.getScriptProperties();
    var override = {};
    try {
      var raw = props.getProperty('POSICIONES_POR_SILUETA_OVERRIDE');
      if (raw) override = JSON.parse(raw);
    } catch (e) { override = {}; }
    override[silueta] = max;
    props.setProperty('POSICIONES_POR_SILUETA_OVERRIDE', JSON.stringify(override));
    _POS_POR_SILUETA_MEMO = null; // por si algo más en esta misma ejecución vuelve a leerlo
  } finally {
    if (lock) lock.releaseLock();
  }

  // BUG REAL (revisión adversarial, 2026-09-05): este override SOLO vivía en
  // PropertiesService -- public.config_siluetas (de donde leen las RPC de
  // Postgres _max_pos_silueta(), usada por cerrarPedido/moverPedidoDeSilueta/
  // corregirSoportesPedido para validar rango) seguía congelada con los
  // valores sembrados el 2026-08-13. Cualquier ampliación/reducción de
  // capacidad hecha desde este panel era INVISIBLE para esas 3 RPC -- podían
  // rechazar una colocación válida (capacidad ampliada) o seguir aceptando
  // colocaciones en un rango que el admin acababa de declarar inseguro
  // (capacidad reducida). Se sincroniza aquí mismo, best-effort (si Supabase
  // falla, el override en Propiedades ya se guardó -- no se deshace).
  try {
    _restPublic_('post', 'config_siluetas', [{ silueta: silueta, posiciones: max }], 'resolution=merge-duplicates,return=minimal');
  } catch (eSync) {
    logActividad('ERROR_SYNC_CONFIG_SILUETAS', 'Silueta ' + silueta + ' → ' + max + ': ' + eSync, 'admin');
  }

  logActividad('CAPACIDAD_SILUETA', 'Silueta ' + silueta + ' → ' + max + ' posiciones', 'admin');
  marcarResumenObsoleto();
  return { ok: true, silueta: silueta, max: max, capacidades: obtenerCapacidadSiluetas() };
}

// ============================================================
// PEDIDOS
// ============================================================

/**
 * Lista de pedidos filtrada por flujo y/o tienda.
 * Solo pedidos no entregados, ordenados por nº de ubicaciones (asc).
 */
// Estados terminales: el pedido ya salió del sistema (no se prepara ni se carga).
var ESTADOS_TERMINALES = { ENTREGADO: true, DEVUELTO_ALMACEN: true, ENVIADO_TIENDA: true, SALIDA_MANUAL: true, CERRADO_SIN_SILUETA: true };

function listarPedidos(flujo, tienda) {
  const pedidos = leerHoja('PEDIDOS');
  let filtrados = pedidos.filter(function(p) {
    if (ESTADOS_TERMINALES[p.estado]) return false;
    // Pedidos apartados a revisión (alguna dirección se marcó "Posponer /
    // Revisar"): no deben aparecer en la lista normal de preparación — viven
    // aparte en listarPedidosEnRevision() hasta que alguien los reanuda.
    if (p.enRevision === true || p.enRevision === 'true') return false;
    if (flujo && p.flujo !== flujo) return false;
    if (tienda && p.tienda !== tienda) return false;
    return true;
  });

  // Avisos de ubicación (tienda / tránsito) por pedido: para que el operario
  // vea ANTES de entrar si el pedido tiene alguna línea que hay que ir a
  // buscar a tienda o que es un tránsito — una sola lectura de LINEAS,
  // agrupada por idPedido (no una lectura por pedido).
  const idsFiltrados = {};
  const idsFiltradosList = [];
  filtrados.forEach(function(p) { idsFiltrados[p.id] = true; idsFiltradosList.push(p.id); });
  const avisosPorPedido = {};
  // Rendimiento (2026-09-04): filtrado real por idPedido, no leerHoja('LINEAS')
  // entera (15000+ filas) para quedarse con las de un puñado de pedidos.
  buscarFilasPorCampo('LINEAS', 'idPedido', idsFiltradosList).forEach(function(l) {
    if (!idsFiltrados[l.idPedido]) return;
    const origen = origenUbicacion(l.dir);
    if (origen === 'plataforma') return;
    if (!avisosPorPedido[l.idPedido]) avisosPorPedido[l.idPedido] = {};
    avisosPorPedido[l.idPedido][origen] = true;
  });

  // Mapear a objeto ligero
  const out = filtrados.map(function(p) {
    return {
      id: p.id, ped: p.ped, tienda: p.tienda, transportista: p.transportista,
      flujo: p.flujo, estado: p.estado, pct: Number(p.pct) || 0,
      operario: p.operario, nLin: Number(p.nLin) || 0, nUbic: Number(p.nUbic) || 0,
      silueta: p.silueta || null,
      avisos: avisosPorPedido[p.id] ? Object.keys(avisosPorPedido[p.id]) : []
    };
  });
  out.sort(function(a, b) { return a.nUbic - b.nUbic; });
  return out;
}

/**
 * Pedidos apartados a revisión (enRevision=true): bolsa GLOBAL, cruzando
 * flujo/tienda/operario — para poder repasarlos todos juntos a última hora,
 * sin importar quién ni dónde los empezó.
 */
function listarPedidosEnRevision() {
  // Rendimiento: filtrado real (en_revision=true), no leerHoja('PEDIDOS') entera.
  var base = _esTablaPublic_('PEDIDOS')
    ? leerHojaPublicConFiltro_('PEDIDOS', 'en_revision=eq.true')
    : leerHoja('PEDIDOS');
  var pedidos = base.filter(function(p) {
    return (p.enRevision === true || p.enRevision === 'true') && !ESTADOS_TERMINALES[p.estado];
  });
  pedidos.sort(function(a, b) {
    return String(a.tienda).localeCompare(String(b.tienda)) || String(a.flujo).localeCompare(String(b.flujo));
  });
  return pedidos.map(function(p) {
    return {
      id: p.id, ped: p.ped, tienda: p.tienda, flujo: p.flujo, transportista: p.transportista,
      pct: Number(p.pct) || 0, nLin: Number(p.nLin) || 0, nUbic: Number(p.nUbic) || 0, operario: p.operario
    };
  });
}

/**
 * Quita la marca de revisión de un pedido para que vuelva a la preparación
 * normal (lo llama el cliente justo antes de abrirlo desde el apartado
 * "Revisar" — a partir de ahí se cierra exactamente igual que cualquier
 * otro pedido).
 */
function reanudarPedidoEnRevision(idPedido) {
  var pedido = buscarFilaPorCampo('PEDIDOS', 'id', idPedido);
  if (!pedido) return { ok: false, error: 'Pedido no encontrado' };
  // BUG REAL (2026-09-04): enRevision:'' se traducía a en_revision:null vía
  // la regla genérica ''->null de _cambiosSheetAPg_ -- pero esa columna es
  // boolean NOT NULL en Postgres, así que el PATCH fallaba SIEMPRE (un
  // pedido enviado a revisión no se podía reanudar nunca). false sí es un
  // valor válido y no dispara esa regla (solo se aplica a v==='').
  actualizarFila('PEDIDOS', pedido._fila, { enRevision: false });
  return { ok: true };
}

/**
 * Devuelve un pedido con todas sus líneas (ubicaciones), ordenadas.
 * Las líneas de picking van al final.
 */
function obtenerPedidoConLineas(idPedido) {
  // Rendimiento (2026-09-04, hot path -- se llama en cada apertura de pedido
  // Y tras cada marca): filtrado real contra Postgres, no leerHoja() entera.
  const pedido = buscarFilaPorCampo('PEDIDOS', 'id', idPedido);
  if (!pedido) return null;

  const lineas = buscarFilasPorCampo('LINEAS', 'idPedido', idPedido);
  lineas.sort(function(a, b) { return Number(a.idx) - Number(b.idx); });

  return {
    pedido: {
      id: pedido.id, ped: pedido.ped, tienda: pedido.tienda,
      transportista: pedido.transportista, flujo: pedido.flujo,
      estado: pedido.estado, pct: Number(pedido.pct) || 0,
      silueta: pedido.silueta || null,
      posIni: pedido.posIni || null, posFin: pedido.posFin || null,
      operario: pedido.operario,
      // Soportes ya guardados de un cierre/asignación anterior (p.ej. el pedido
      // se "Desmarcó" de su silueta para recolocar -- ver
      // _liberarPedidoDeSiluetaInterno disposicion='desmarcar' -- que limpia
      // silueta/posIni/posFin pero deliberadamente NO toca soportes). Sin esto
      // el cliente pierde el dato y el operario tiene que adivinar/re-rellenar
      // a mano un pedido que ya estaba resuelto -- bug real reportado
      // 2026-09-03 (pedido 290529: quedaba "para sacar" indefinidamente).
      soportes: parseJSON(pedido.soportes, [])
    },
    lineas: lineas.map(function(l) {
      return {
        id: l.id, idPedido: l.idPedido, idx: Number(l.idx),
        dir: l.dir, ref: l.ref, ean: l.ean, des: l.des, ctd: l.ctd,
        tipoUbic: l.tipoUbic, esPicking: l.esPicking === true || l.esPicking === 'true',
        estado: l.estado, motivo: l.motivo, operario: l.operario, ts: l.ts,
        _fila: l._fila
      };
    })
  };
}

/**
 * Marca una línea de pedido con un estado.
 * estadoNuevo: PREPARADO | NO_SALE | NO_ENCONTRADO | POSPUESTO
 * Si vuelveAlFinal, mueve la línea al final del orden.
 */
function marcarLinea(idPedido, idxLinea, estadoNuevo, motivo, operario, vuelveAlFinal) {
  // Una sola lectura de la hoja de líneas (antes se leía 2-3 veces por marca).
  const lineas = leerHoja('LINEAS').filter(function(l) { return l.idPedido === idPedido; });
  const linea = lineas.find(function(l) { return Number(l.idx) === Number(idxLinea); });
  if (!linea) return { ok: false, error: 'Línea no encontrada' };

  let nuevoIdx = Number(linea.idx);
  if (vuelveAlFinal) {
    const maxIdx = Math.max.apply(null, lineas.map(function(l) { return Number(l.idx); }));
    nuevoIdx = maxIdx + 1;
  }

  // Reflejar el cambio en la copia en memoria para recalcular sin releer la hoja.
  linea.estado = estadoNuevo;
  linea.idx = nuevoIdx;

  actualizarFila('LINEAS', linea._fila, {
    estado: estadoNuevo,
    motivo: motivo || '',
    operario: operario || '',
    ts: new Date().toISOString(),
    idx: nuevoIdx
  });

  // Recalcular estado del pedido reutilizando las líneas ya leídas.
  // POSPUESTO ("Posponer / Revisar") saca el pedido ENTERO a revisión — no
  // solo la línea — a petición del usuario (antes esa dirección volvía al
  // mismo operario antes de cerrar el pedido; ahora el pedido entero se
  // aparta a un apartado aparte para revisarlo más tarde, junto con los demás).
  const pedido = recalcularEstadoPedido(idPedido, operario, lineas, estadoNuevo === 'POSPUESTO' ? { enRevision: true } : null);

  // Notificación de incidencia si NO encontrado / NO sale
  if (estadoNuevo === 'NO_ENCONTRADO' || estadoNuevo === 'NO_SALE') {
    enviarNotificacionChat({
      pedido: pedido ? pedido.ped : idPedido,
      ubicacion: linea.dir,
      motivo: motivo,
      operario: operario,
      hora: Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM HH:mm')
    });
  }

  return { ok: true };
}

function obtenerNumeroPedido(idPedido) {
  const p = buscarFilaPorCampo('PEDIDOS', 'id', idPedido);
  return p ? p.ped : idPedido;
}

/**
 * Marca TODAS las líneas (artículos) de una dirección a la vez, en una sola
 * llamada. El operario prepara por dirección/soporte completo, no por artículo.
 * Una única notificación de incidencia por dirección (no una por artículo).
 */
// Fase 3, Pieza 3 (2026-09-04, HOT PATH): PEDIDOS/LINEAS ya viven en
// Postgres (public). public.marcar_lineas_direccion(...) ya hace TODO lo de
// dentro, con advisory lock por (función, id_pedido) -- mejora real sobre el
// candado GLOBAL best-effort de antes. El aviso a Chat sigue disparándose
// aquí (efecto externo, no puede hacerse desde SQL) -- la RPC devuelve
// 'notificar' para saber cuándo.
function marcarDireccion(idPedido, dir, estadoNuevo, motivo, operario, vuelveAlFinal) {
  var r = _rpcPublic_('marcar_lineas_direccion', {
    p_id_pedido: idPedido, p_dir: dir, p_estado_nuevo: estadoNuevo,
    p_motivo: motivo || null, p_operario: operario || null, p_vuelve_al_final: !!vuelveAlFinal
  });
  if (!r.ok) return r;
  if (r.notificar) {
    enviarNotificacionChat({
      pedido: r.ped || idPedido,
      ubicacion: dir,
      motivo: motivo,
      operario: operario,
      hora: Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM HH:mm')
    });
  }
  return { ok: true };
}

/**
 * Recalcula el % y estado de un pedido según sus líneas.
 * camposExtra (opcional): columnas adicionales a fusionar en la MISMA
 * escritura (p.ej. { enRevision: true } cuando una dirección se manda a
 * revisar), para no hacer una segunda escritura suelta a la misma fila.
 */
function recalcularEstadoPedido(idPedido, operario, lineasPre, camposExtra) {
  const pedidos = leerHoja('PEDIDOS');
  const pedido = pedidos.find(function(p) { return p.id === idPedido; });
  if (!pedido) return null;

  // Si quien llama ya leyó las líneas, las reutilizamos (evita otra lectura de hoja).
  const lineas = lineasPre || leerHoja('LINEAS').filter(function(l) { return l.idPedido === idPedido; });
  const total = lineas.length;
  const procesadas = lineas.filter(function(l) {
    return l.estado === 'PREPARADO' || l.estado === 'NO_SALE' || l.estado === 'NO_ENCONTRADO';
  }).length;
  const preparadas = lineas.filter(function(l) { return l.estado === 'PREPARADO'; }).length;

  const pct = total > 0 ? Math.round((procesadas / total) * 100) : 0;
  let estado;
  if (procesadas === total && preparadas === total) estado = 'COMPLETADO_LISTO';
  else if (procesadas === total) estado = 'PARCIAL_LISTO';
  else if (procesadas > 0) estado = 'EN_PREPARACION';
  else estado = 'PENDIENTE';

  // Actualización PARCIAL (solo las columnas que cambian): reescribir la fila
  // entera desde el snapshot podría pisar silueta/numeroCarga escritos por
  // administración en ese intervalo.
  const cambios = { pct: pct, estado: estado };
  if (operario) cambios.operario = operario;
  cambios.actualizado = new Date().toISOString();
  if (camposExtra) { for (var k in camposExtra) cambios[k] = camposExtra[k]; }
  actualizarFila('PEDIDOS', pedido._fila, cambios);
  return pedido;
}

// ============================================================
// SILUETAS · OCUPACIÓN Y ASIGNACIÓN
// ============================================================

/**
 * Devuelve la ocupación de una silueta concreta.
 */
function obtenerOcupacionSilueta(silueta) {
  return leerHoja('OCUPACION').filter(function(o) { return o.silueta === silueta; })
    .map(function(o) {
      return {
        silueta: o.silueta, pos: Number(o.pos), layer: o.layer,
        pedido: o.pedido, tienda: o.tienda, flujo: o.flujo,
        reservado: o.reservado === true || o.reservado === 'true'
      };
    });
}

/**
 * Devuelve toda la ocupación de todas las siluetas (para dashboard).
 */
function obtenerOcupacionTodas() {
  return leerHoja('OCUPACION').map(function(o) {
    return {
      silueta: o.silueta, pos: Number(o.pos), layer: o.layer,
      pedido: o.pedido, tienda: o.tienda, flujo: o.flujo,
      reservado: o.reservado === true || o.reservado === 'true'
    };
  });
}

/**
 * Empaqueta soportes en posiciones físicas (back+front). Port de la lógica
 * validada de la demo (empaquetarSoportes). DEBE permanecer sincronizada con
 * la copia local en Index.html (función empaquetarSoportes).
 * Devuelve array de { back: true, front: true|'reservado' }.
 *
 * Reglas: Doble (1.0) ocupa back+front · Euro/jaula/estaríbel/americano (0.5)
 * ocupa back y se empareja con el siguiente 0.5 en el front · Medio (0.25)
 * ocupa back y reserva el front · 0.5/0.25 sueltos reservan el front · bulto (0) no ocupa.
 */
function calcularPosiciones(soportes) {
  var unidades = [];
  soportes.forEach(function(s) {
    var def = CONFIG.SOPORTES.find(function(x) { return x.id === s.tipoId; });
    var ocupa = def ? def.ocupa : (Number(s.ocupa) || 0);
    if (!ocupa) return; // bultos no ocupan
    for (var i = 0; i < s.cant; i++) unidades.push(ocupa);
  });

  unidades.sort(function(a, b) { return b - a; }); // de mayor a menor

  var posiciones = [];
  unidades.forEach(function(ocupa) {
    if (ocupa >= 1.0) {
      posiciones.push({ back: true, front: true });
    } else if (ocupa === 0.5) {
      var existente = null;
      for (var k = 0; k < posiciones.length; k++) {
        if (posiciones[k]._media && posiciones[k].front === null) { existente = posiciones[k]; break; }
      }
      if (existente) { existente.front = true; }
      else { posiciones.push({ back: true, front: null, _media: true }); }
    } else {
      posiciones.push({ back: true, front: 'reservado' });
    }
  });

  posiciones.forEach(function(p) {
    if (p.front === null) p.front = 'reservado';
    delete p._media;
  });

  return posiciones;
}

/**
 * Marca como "ocupada" una posición si su DETRÁS tiene algo, o si su DELANTE
 * está genuinamente ocupado (reservado:false) aunque el detrás ya se haya
 * liberado — así una posición Remansur compartida (detrás entregado, delante
 * todavía en silueta) no se ofrece de nuevo a un pedido distinto. Esto es
 * ocupación REAL (agnóstica de flujo): un "reservado" no cuenta como ocupado
 * porque no hay ningún soporte físico ahí, esté reservado para quien esté.
 */
function posicionesOcupadas(ocup) {
  const ocupadas = {};
  ocup.forEach(function(o) {
    if (o.layer === 'back') ocupadas[o.pos] = true;
    if (o.layer === 'front' && !o.reservado) ocupadas[o.pos] = true;
  });
  return ocupadas;
}

/**
 * Busca el primer hueco libre de N posiciones consecutivas en una silueta —
 * SIEMPRE según ocupación real (también para Remansur): así la silueta se va
 * autorellenando en orden con los pedidos y soportes que de verdad hay, en
 * vez de proponer siempre la posición 1 solo porque Remansur no bloquea la
 * asignación manual (esa libertad es solo para el modo manual, ver
 * validarAsignacionManual).
 */
function asignarAutomatico(silueta, numPosiciones) {
  const ocup = obtenerOcupacionSilueta(silueta);
  const ocupadas = posicionesOcupadas(ocup);
  const maxPos = posicionesDeSilueta(silueta);

  for (let inicio = 1; inicio <= maxPos - numPosiciones + 1; inicio++) {
    let libre = true;
    for (let p = inicio; p < inicio + numPosiciones; p++) {
      if (ocupadas[p]) { libre = false; break; }
    }
    if (libre) return { ok: true, posIni: inicio, posFin: inicio + numPosiciones - 1 };
  }
  return { ok: false, error: 'No hay ' + numPosiciones + ' posiciones libres consecutivas en silueta ' + silueta };
}

/**
 * Valida una asignación MANUAL (o la posición ya elegida al cerrar/mover un
 * pedido). flujo (opcional): para Remansur se omite POR COMPLETO la
 * comprobación de conflicto — ahí sí se coloca donde decida el operario o
 * administración, "como queramos" (a diferencia del auto-relleno de
 * asignarAutomatico, que para Remansur SÍ respeta la ocupación real para
 * proponer huecos en orden). Se sigue validando que no se salga del rango
 * físico de la silueta, eso no depende del flujo.
 * excluirPedido (opcional): número de pedido a ignorar en la comprobación de
 * conflicto — imprescindible al MOVER un pedido a un destino que se solapa
 * con su propio hueco actual (p.ej. de A2-A5 a A1-A4): sin esto, el pedido
 * "chocaba consigo mismo" porque sus propias filas de OCUPACION en la zona
 * de solape todavía no se habían liberado en el momento de validar.
 */
function validarAsignacionManual(silueta, posIni, numPosiciones, flujo, excluirPedido) {
  const posFin = posIni + numPosiciones - 1;
  const maxPos = posicionesDeSilueta(silueta);
  if (posFin > maxPos) {
    return { ok: false, error: 'Se sale del rango (máx ' + maxPos + ')' };
  }
  if (esRemansur(flujo)) return { ok: true, posIni: posIni, posFin: posFin };
  var ocup = obtenerOcupacionSilueta(silueta);
  if (excluirPedido) ocup = ocup.filter(function(o) { return String(o.pedido) !== String(excluirPedido); });
  const ocupadas = posicionesOcupadas(ocup);
  for (let p = posIni; p <= posFin; p++) {
    if (ocupadas[p]) return { ok: false, error: 'Posición ' + p + ' ya ocupada' };
  }
  return { ok: true, posIni: posIni, posFin: posFin };
}

function esRemansur(flujo) {
  return flujo === 'remansur_transporte' || flujo === 'remansur_pro';
}

// intentarCompartirFrenteRemansur() (reparto de "delante" Remansur) se
// borró el 2026-09-05 (revisión adversarial): código muerto desde el corte
// de Pieza 3 -- la lógica de compartir frente ya vive en SQL dentro de
// compartir_frente_remansur(), llamada por la RPC cerrar_pedido. La versión
// JS seguía escribiendo OCUPACION directo en Sheets + un sync legado
// (sincronizarOcupacionSupabase_) -- una trampa de doble escritura si algo
// la hubiera vuelto a enganchar por error. Sin llamadores reales, se quita
// entera en vez de dejarla como trampa.

/**
 * Vuelca en el Drive externo de "Pedidos Disponibles" (ajeno a este sistema)
 * la descripción de palets/bultos generados al cerrar un pedido, para que ese
 * equipo lo vea sin entrar aquí. Busca la fila por nº de pedido (columna I) en
 * la pestaña DISP_<TIENDA> y escribe en columnas Y (palets) / Z (bultos) un
 * texto tipo "2 palet euro, 1 palet doble" — igual que se escribe a mano en
 * ese Drive, no solo el número.
 * Si el pedido NO está en la lista de esa tienda (antes esto se ignoraba en
 * silencio, sin dejar rastro): se da de alta en la primera fila totalmente
 * vacía por debajo de los datos existentes (columna ID en blanco -- mismo
 * hueco que dejaría borrar una fila a mano), escribiendo ahí el nº de pedido
 * además de palets/bultos. Se registra en LOG_ACTIVIDAD para que quede
 * constancia de que se creó una fila nueva, no solo de que se rellenó una ya
 * existente.
 * Envuelto en try/catch: si el Drive externo falla (permisos, etc.) NO debe
 * romper el cierre del pedido en este sistema.
 */
function actualizarPaletsBultosDisponibilidad(pedido, soportes) {
  try {
    var pestana = DISPONIBILIDAD_PESTANA_POR_TIENDA[pedido.tienda];
    if (!pestana) return;
    var hoja = getSSDisponibilidad().getSheetByName(pestana);
    if (!hoja) return;
    var ultimaFila = hoja.getLastRow();

    var filaEncontrada = -1;
    var filaVacia = -1;
    if (ultimaFila >= 2) {
      var idsPedido = hoja.getRange(2, DISPONIBILIDAD_COL_ID_PEDIDO, ultimaFila - 1, 1).getValues();
      for (var i = 0; i < idsPedido.length; i++) {
        var valorId = idsPedido[i][0];
        if (String(valorId) === String(pedido.ped)) { filaEncontrada = i + 2; break; }
        if (filaVacia === -1 && (valorId === '' || valorId === null || valorId === undefined)) filaVacia = i + 2;
      }
    }

    var filaDestino;
    var esAltaNueva = false;
    if (filaEncontrada !== -1) {
      filaDestino = filaEncontrada;
    } else {
      filaDestino = filaVacia !== -1 ? filaVacia : Math.max(ultimaFila + 1, 2);
      esAltaNueva = true;
    }

    var nombrePorTipoId = {};
    CONFIG.SOPORTES.forEach(function(s) { nombrePorTipoId[s.id] = s.nombre; });

    var partesPalets = [], partesBultos = [];
    (soportes || []).forEach(function(s) {
      var cant = Number(s.cant) || 0;
      if (!cant) return;
      var texto = cant + '× ' + (nombrePorTipoId[s.tipoId] || s.tipoId);
      if (s.tipoId === 'bulto') partesBultos.push(texto);
      else partesPalets.push(texto);
    });

    if (esAltaNueva) {
      hoja.getRange(filaDestino, DISPONIBILIDAD_COL_ID_PEDIDO).setValue(pedido.ped);
      logActividad('DISPONIBILIDAD_EXTERNA_ALTA', 'Pedido ' + pedido.ped + ' (' + pedido.tienda + ') no estaba en el Excel externo -- añadido en fila ' + filaDestino + ' de ' + pestana, 'sistema');
    }
    hoja.getRange(filaDestino, DISPONIBILIDAD_COL_PALETS).setValue(partesPalets.join(', '));
    hoja.getRange(filaDestino, DISPONIBILIDAD_COL_BULTOS).setValue(partesBultos.join(', '));
  } catch (e) {
    logActividad('ERROR_DISPONIBILIDAD_EXTERNA', 'Pedido ' + pedido.ped + ': ' + e.message, 'sistema');
  }
}

/**
 * FASE 1 DE LA MIGRACIÓN A SUPABASE (escritura en sombra): copia el pedido a
 * Supabase además de guardarlo en Sheets, para validar el nuevo datastore sin
 * depender todavía de él. Sheets sigue siendo la ÚNICA fuente de verdad real
 * — esto es best-effort y NUNCA bloqueante: si Supabase falla o no está
 * configurado (Propiedades del script vacías), el cierre del pedido en
 * Sheets YA se hizo antes de llamar aquí y no se deshace ni se reintenta.
 * `cambios` es el mismo objeto parcial que se le pasa a actualizarFila justo
 * antes — se fusiona sobre el pedido original para tener los valores NUEVOS
 * (silueta/posición/soportes) sin releer la hoja entera otra vez.
 * Cubre SOLO el momento de cerrarPedido() por ahora — no
 * marcarDireccion/confirmarEntregas/etc., eso es trabajo de una fase
 * posterior (ver docs/superpowers/specs/2026-07-28-migracion-sheets-supabase-design.md).
 */
function sincronizarPedidoSupabase_(pedidoOriginal, cambios) {
  try {
    var cfg = getSupabaseConfig_();
    if (!cfg) return; // no configurado todavía: no hacer nada, no es un error

    var f = Object.assign({}, pedidoOriginal, cambios);
    var numAoN = function(v) { return (v === '' || v === null || v === undefined) ? null : Number(v); };

    var row = {
      id: f.id,
      ped: f.ped,
      tienda: f.tienda,
      transportista: f.transportista || null,
      flujo: f.flujo || null,
      estado: f.estado,
      pct: numAoN(f.pct),
      operario: f.operario || null,
      silueta: f.silueta || null,
      pos_ini: numAoN(f.posIni) === null ? null : String(f.posIni),
      pos_fin: numAoN(f.posFin) === null ? null : String(f.posFin),
      soportes: (typeof f.soportes === 'string') ? parseJSON(f.soportes, []) : (f.soportes || []),
      n_lin: numAoN(f.nLin),
      n_ubic: numAoN(f.nUbic),
      actualizado: f.actualizado || new Date().toISOString(),
      intento_carga: numAoN(f.intentoCarga),
      comentario: f.comentario || null,
      tipo_entrega: f.tipoEntrega || null,
      en_revision: (f.enRevision === true || f.enRevision === 'true'),
      sd_impreso: f.sdImpreso || null,
      numero_carga: (f.numeroCarga === '' || f.numeroCarga === null || f.numeroCarga === undefined) ? null : String(f.numeroCarga),
      parcial: (f.parcial === true || f.parcial === 'true')
    };

    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/pedidos', {
      method: 'post',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      payload: JSON.stringify([row]),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      logActividad('ERROR_SYNC_SUPABASE', 'Pedido ' + f.ped + ': HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300), 'sistema');
    }
  } catch (e) {
    logActividad('ERROR_SYNC_SUPABASE', 'Pedido ' + (pedidoOriginal && pedidoOriginal.ped) + ': ' + e.message, 'sistema');
  }
}

/**
 * FASE 1 DE LA MIGRACIÓN A SUPABASE (escritura en sombra): copia las filas de
 * ocupación a la tabla ocupacion_siluetas de Supabase, igual de best-effort y
 * no bloqueante que sincronizarPedidoSupabase_(). Cubre tanto las filas
 * NUEVAS creadas en cerrarPedido()/registrarPedidoManual() (posición nueva)
 * como la reescritura de una fila YA EXISTENTE en
 * intentarCompartirFrenteRemansur() (upsert por la misma PK
 * silueta+pos+layer, gracias a merge-duplicates).
 */
function sincronizarOcupacionSupabase_(filasOcup) {
  try {
    if (!filasOcup || !filasOcup.length) return;
    var cfg = getSupabaseConfig_();
    if (!cfg) return;

    var rows = filasOcup.map(function(r) {
      return {
        silueta: r.silueta,
        pos: String(r.pos),
        layer: r.layer,
        pedido: r.pedido || null,
        tienda: r.tienda || null,
        flujo: r.flujo || null,
        reservado: !!r.reservado
      };
    });

    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/ocupacion_siluetas', {
      method: 'post',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      payload: JSON.stringify(rows),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      logActividad('ERROR_SYNC_SUPABASE', 'Ocupación (' + rows.length + ' filas): HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300), 'sistema');
    }
  } catch (e) {
    logActividad('ERROR_SYNC_SUPABASE', 'Ocupación: ' + e.message, 'sistema');
  }
}

/**
 * Contrapartida de sincronizarOcupacionSupabase_() (Fase 1): borra en Supabase
 * las mismas filas que liberarPosiciones()/liberarPosicionesLote() acaban de
 * borrar en Sheets. Mismo criterio de coincidencia (silueta + pos entre
 * posIni-posFin + pedido). pos es texto en Supabase (ver DDL), así que se usa
 * una lista IN de valores exactos en vez de gte/lte -- una comparación de
 * texto tipo gte/lte ordenaría mal ('10' < '9' alfabéticamente).
 */
function eliminarOcupacionSupabase_(silueta, posIni, posFin, pedido) {
  try {
    var posIniN = Number(posIni), posFinN = Number(posFin);
    if (!(posIniN > 0) || !(posFinN >= posIniN)) return; // bulto u otro caso sin posición real
    var cfg = getSupabaseConfig_();
    if (!cfg) return;
    var listaPos = [];
    for (var p = posIniN; p <= posFinN; p++) listaPos.push(p);
    var url = cfg.url + '/rest/v1/ocupacion_siluetas'
      + '?silueta=eq.' + encodeURIComponent(silueta)
      + '&pedido=eq.' + encodeURIComponent(String(pedido))
      + '&pos=in.(' + listaPos.join(',') + ')';
    var resp = UrlFetchApp.fetch(url, {
      method: 'delete',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      logActividad('ERROR_SYNC_SUPABASE', 'Liberar ocupación ' + silueta + ' ' + posIni + '-' + posFin + ' (pedido ' + pedido + '): HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300), 'sistema');
    }
  } catch (e) {
    logActividad('ERROR_SYNC_SUPABASE', 'Liberar ocupación: ' + e.message, 'sistema');
  }
}

/**
 * Sincroniza UNA fila de HISTORIAL_TRANSPORTISTA (Fase 1). Llamada desde el
 * único punto de escritura real, registrarHistorialTransportista()
 * (EstructuraSheets.gs), así que cubre de golpe los 7 sitios que la usan.
 * id_pedido NO lleva FK contra pedidos(id) en Supabase (a propósito, mismo
 * motivo que ocupacion_siluetas.pedido): registrarHistorialTransportista se
 * llama a veces ANTES de que el pedido nuevo se haya sincronizado (altas por
 * lote de Recogidas/Ya Cargados) — con FK, esos casos fallarían siempre.
 */
function sincronizarHistorialTransportistaSupabase_(fila) {
  try {
    if (!fila) return;
    var cfg = getSupabaseConfig_();
    if (!cfg) return;
    var row = {
      id: fila.id, id_pedido: fila.idPedido || null, ped: fila.ped || null,
      tienda: fila.tienda || null, transportista: fila.transportista || null,
      flujo: fila.flujo || null, evento: fila.evento || null, fecha: fila.fecha || null
    };
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/historial_transportista', {
      method: 'post',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      payload: JSON.stringify([row]),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      logActividad('ERROR_SYNC_SUPABASE', 'Historial transportista (' + fila.ped + '): HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300), 'sistema');
    }
  } catch (e) {
    logActividad('ERROR_SYNC_SUPABASE', 'Historial transportista: ' + e.message, 'sistema');
  }
}

/**
 * Añade UN pedido a la tabla de unión CARGAS_PEDIDOS (Fase 1) -- crearCarga()
 * llama a esto una vez por cada pedido inicial; anadirPedidoACarga() una vez
 * más tarde. pedido_id NO lleva FK contra pedidos(id) (mismo motivo que las
 * demás FK ya quitadas: el pedido podría no haberse sincronizado todavía).
 */
function sincronizarCargaPedidoSupabase_(cargaId, pedidoId, posicion) {
  try {
    if (!cargaId || !pedidoId) return;
    var cfg = getSupabaseConfig_();
    if (!cfg) return;
    var row = { carga_id: cargaId, pedido_id: pedidoId, posicion: posicion === undefined ? null : posicion };
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/cargas_pedidos', {
      method: 'post',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      payload: JSON.stringify([row]),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      logActividad('ERROR_SYNC_SUPABASE', 'Carga_pedido ' + cargaId + '/' + pedidoId + ': HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300), 'sistema');
    }
  } catch (e) {
    logActividad('ERROR_SYNC_SUPABASE', 'Carga_pedido: ' + e.message, 'sistema');
  }
}

/**
 * Contrapartida de sincronizarCargaPedidoSupabase_() -- borra el enlace
 * cuando un pedido sale de una carga activa (quitarPedidoDeCarga(),
 * _quitarPedidoDeSuCargaActiva()).
 */
function eliminarCargaPedidoSupabase_(cargaId, pedidoId) {
  try {
    if (!cargaId || !pedidoId) return;
    var cfg = getSupabaseConfig_();
    if (!cfg) return;
    var url = cfg.url + '/rest/v1/cargas_pedidos'
      + '?carga_id=eq.' + encodeURIComponent(cargaId)
      + '&pedido_id=eq.' + encodeURIComponent(pedidoId);
    var resp = UrlFetchApp.fetch(url, {
      method: 'delete',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      logActividad('ERROR_SYNC_SUPABASE', 'Quitar carga_pedido ' + cargaId + '/' + pedidoId + ': HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300), 'sistema');
    }
  } catch (e) {
    logActividad('ERROR_SYNC_SUPABASE', 'Quitar carga_pedido: ' + e.message, 'sistema');
  }
}

/**
 * Borra UNA fila de la tabla pedidos en Supabase. Contrapartida de
 * sincronizarPedidoSupabase_ para los casos en que la fila desaparece de la
 * Hoja entera (no solo cambia): hoy lo usa la limpieza de pedidos fantasma.
 */
function eliminarPedidoSupabase_(id) {
  try {
    if (!id) return;
    var cfg = getSupabaseConfig_();
    if (!cfg) return;
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/pedidos?id=eq.' + encodeURIComponent(id), {
      method: 'delete',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      logActividad('ERROR_SYNC_SUPABASE', 'Borrar pedido ' + id + ': HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300), 'sistema');
    }
  } catch (e) {
    logActividad('ERROR_SYNC_SUPABASE', 'Borrar pedido ' + id + ': ' + e.message, 'sistema');
  }
}

/**
 * FASE 1 DE LA MIGRACIÓN A SUPABASE — verificación nocturna de que nada se ha
 * quedado sin sincronizar. Solo LEE (Sheets y Supabase), nunca escribe nada.
 *
 * IMPORTANTE — por qué se compara solo lo RECIENTE (últimos
 * CUTOFF_DIAS_VERIFICACION_SYNC días) y no toda la hoja: la escritura en
 * sombra de la Fase 1 solo copia un pedido/carga/etc. a Supabase EN EL
 * MOMENTO en que algo lo modifica -- nunca hace un volcado de lo que ya
 * existía antes de que su sync respectivo se desplegara. Comparar contra la
 * hoja entera daría miles de "faltantes" que en realidad son pedidos
 * antiguos que nadie ha tocado desde entonces (nada que ver con un fallo de
 * sincronización) -- ese volcado histórico es precisamente el trabajo de la
 * Fase 2, todavía no hecha. Comparando solo lo reciente, cualquier
 * "faltante" que aparezca aquí SÍ es una sincronización real que falló.
 * Tampoco se compara al revés (Supabase con más filas que Sheets no es un
 * problema: PEDIDOS se purga de Sheets cada PURGA_DIAS_ANTIGUEDAD días,
 * SnapshotDiario.gs, pero nunca se borra de Supabase a propósito).
 *
 * HISTORIAL_ENTREGAS no tiene una clave natural que viaje a Supabase (id
 * autonumérico solo existe allí), así que para esa tabla solo se compara el
 * recuento de filas recientes.
 *
 * Se llama cada noche desde procesoDiarioSnapshots() (SnapshotDiario.gs). El
 * corte de "reciente" normalmente es la MEDIANOCHE DEL DÍA EN CURSO (no una
 * ventana fija de varios días): así el resultado de cada noche valida justo
 * la actividad de ESE día, sin arrastrar tocamientos de días anteriores a
 * los despliegues de cada sync. PERO se guarda en PropertiesService la marca
 * de la última vez que el chequeo se completó SIN errores de lectura
 * (ULTIMA_VERIFICACION_SYNC_OK) y, si esa marca es más antigua que la
 * medianoche de hoy, se usa ELLA como corte en su lugar -- así una ejecución
 * en lunes cubre también el fin de semana entero (viernes no se pierde
 * cuando el disparador no corre en fin de semana, ver esFinDeSemana en
 * SnapshotDiario.gs), en vez de dar por perdido para siempre lo que pasó
 * esos días. Cada tabla se comprueba en su propio try/catch: si leer UNA
 * hoja falla (fallo transitorio de Sheets/Apps Script), esa tabla se marca
 * como no comprobada esta noche pero el resto de tablas SÍ se evalúan y
 * registran -- y la marca de "última vez sin errores" no avanza, así ninguna
 * ventana queda sin mirar nunca.
 * Este es el mecanismo que pide el diseño original antes de pasar a la Fase 2
 * (docs/superpowers/specs/2026-07-28-migracion-sheets-supabase-design.md):
 * "cero divergencias no explicadas durante al menos una semana completa".
 */
function verificarSincronizacionSupabase() {
  var cfg = getSupabaseConfig_();
  if (!cfg) return { ok: true, omitido: 'Supabase no configurado' };

  var props = PropertiesService.getScriptProperties();
  var cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  var marcaAnterior = props.getProperty('ULTIMA_VERIFICACION_SYNC_OK');
  if (marcaAnterior) {
    var fechaMarca = new Date(marcaAnterior);
    if (!isNaN(fechaMarca.getTime()) && fechaMarca < cutoff) cutoff = fechaMarca;
  }
  var cutoffIso = cutoff.toISOString();
  function esReciente(fechaVal) {
    if (!fechaVal) return false;
    var f = new Date(fechaVal);
    return !isNaN(f.getTime()) && f >= cutoff;
  }
  var sufijo = ' (desde ' + cutoffIso.slice(0, 16).replace('T', ' ') + ')';

  var resultados = [];
  var huboErrorLectura = false;
  function intentar(nombre, fn) {
    try {
      resultados.push(fn());
    } catch (e) {
      huboErrorLectura = true;
      resultados.push({ ok: false, resumen: nombre + ': ERROR leyendo Sheets (' + e.message + ')' });
    }
  }

  var pedidos = null;
  intentar('PEDIDOS' + sufijo, function() {
    pedidos = leerHoja('PEDIDOS');
    return _verificarClavesSupabase_('PEDIDOS' + sufijo, 'pedidos', ['id'],
      pedidos.filter(function(p) { return p.id && esReciente(p.actualizado); }).map(function(p) { return String(p.id); }),
      'actualizado', cutoffIso);
  });

  // OCUPACION_SILUETAS no tiene columna de fecha propia (tabla pequeña, un
  // hueco físico por fila) -- "reciente" se hereda del pedido al que
  // pertenece cada hueco (siempre se actualiza a la vez, ver
  // sincronizarOcupacionSupabase_). OJO: el nº de pedido NO es único por sí
  // solo entre tiendas distintas (mismo motivo documentado en
  // anadirPedidoACarga/moverPedidoDeSilueta/etc.) -- la clave del mapa tiene
  // que llevar tienda+ped, nunca solo ped, o dos pedidos de tiendas distintas
  // con el mismo número se pisarían el uno al otro.
  intentar('OCUPACION_SILUETAS (huecos de pedidos recientes)', function() {
    if (!pedidos) throw new Error('PEDIDOS no se pudo leer (ver resultado anterior)');
    var actualizadoPorPed = {};
    pedidos.forEach(function(p) { actualizadoPorPed[String(p.tienda) + '::' + String(p.ped)] = p.actualizado; });
    return _verificarClavesSupabase_('OCUPACION_SILUETAS (huecos de pedidos recientes)', 'ocupacion_siluetas', ['silueta', 'pos', 'layer'],
      leerHoja('OCUPACION').filter(function(o) { return o.silueta && esReciente(actualizadoPorPed[String(o.tienda) + '::' + String(o.pedido)]); })
        .map(function(o) { return String(o.silueta) + '|' + String(o.pos) + '|' + String(o.layer); }));
  });

  intentar('HISTORIAL_TRANSPORTISTA' + sufijo, function() {
    return _verificarClavesSupabase_('HISTORIAL_TRANSPORTISTA' + sufijo, 'historial_transportista', ['id'],
      leerHoja('HIST_TRANSP').filter(function(h) { return h.id && esReciente(h.fecha); }).map(function(h) { return String(h.id); }),
      'fecha', cutoffIso);
  });

  // "Reciente" para CARGAS no puede ser solo "creada hoy" (c.fecha se pone
  // UNA vez, al crear): una carga puede cerrarse HOY habiéndose creado ayer,
  // así que también cuenta fechaCierre. Lo que NO se hace es incluir
  // "cualquier carga todavía abierta (GENERADA)" sin mirar fechas -- se probó
  // y disparaba una alarma falsa enorme (130 de 155), porque hay cargas
  // abiertas desde ANTES de que existiera esta sincronización que nunca se
  // copiaron a Supabase por diseño, no por fallo (mismo motivo por el que el
  // corte general es "de hoy" y no "toda la hoja"). Límite conocido y
  // aceptado, igual que el hueco de fin de semana: si una carga creada hace
  // días y aún abierta recibe un cambio hoy (añadir/quitar pedido), ese
  // cambio no se verifica hasta que la carga se cierre.
  var cargasRecientes = null;
  intentar('CARGAS' + sufijo, function() {
    cargasRecientes = leerHoja('CARGAS').filter(function(c) {
      return c.id && (esReciente(c.fecha) || esReciente(c.fechaCierre));
    });
    return _verificarClavesSupabase_('CARGAS' + sufijo, 'cargas', ['id'],
      cargasRecientes.map(function(c) { return String(c.id); }), 'fecha', cutoffIso);
  });

  intentar('VISAS' + sufijo, function() {
    return _verificarClavesSupabase_('VISAS' + sufijo, 'visas', ['id'],
      leerHoja('VISAS').filter(function(v) { return v.id && esReciente(v.fechaAlta); }).map(function(v) { return String(v.id); }),
      'fecha_alta', cutoffIso);
  });

  intentar('CARGAS_PEDIDOS (de cargas ' + sufijo + ')', function() {
    if (!cargasRecientes) throw new Error('CARGAS no se pudo leer (ver resultado anterior)');
    var paresCargaPedido = [];
    cargasRecientes.forEach(function(c) {
      parseJSON(c.items, []).forEach(function(it) {
        if (it.idPedido) paresCargaPedido.push(String(c.id) + '|' + String(it.idPedido));
      });
    });
    return _verificarClavesSupabase_('CARGAS_PEDIDOS (de cargas ' + sufijo + ')', 'cargas_pedidos', ['carga_id', 'pedido_id'],
      paresCargaPedido, 'added_at', cutoffIso);
  });

  intentar('HISTORIAL_ENTREGAS' + sufijo, function() {
    return _verificarRecuentoSupabase_('HISTORIAL_ENTREGAS' + sufijo, 'historial_entregas',
      leerHoja('HISTORIAL').filter(function(h) { return esReciente(h.confirmadoTs); }).length,
      'confirmado_ts', cutoffIso);
  });

  var conDivergencia = resultados.filter(function(r) { return !r.ok; });
  var resumenTotal = resultados.map(function(r) { return r.resumen; }).join(' · ');
  if (conDivergencia.length) {
    logActividad('SYNC_CHECK_DIVERGENCIA', resumenTotal, 'sistema');
  } else {
    logActividad('SYNC_CHECK_OK', resumenTotal, 'sistema');
  }
  // La marca solo avanza si TODAS las tablas se pudieron leer y comparar de
  // verdad esta noche -- si alguna falló, la próxima ejecución debe seguir
  // mirando desde el mismo punto de partida, no saltarse ese hueco.
  if (!huboErrorLectura) {
    props.setProperty('ULTIMA_VERIFICACION_SYNC_OK', new Date().toISOString());
  }
  return { ok: !conDivergencia.length, resultados: resultados };
}

/**
 * Descarga de Supabase TODOS los valores de `campos` de `tabla` (paginado de
 * 1000 en 1000 vía cabecera Range, formato PostgREST) y comprueba que cada
 * clave de `clavesSheet` (misma unión de `campos` con '|') exista entre
 * ellos. Si se pasan `columnaFecha`/`cutoffIso`, se filtra tambien el lado
 * de Supabase por esa columna (>=), para no descargar la tabla entera en las
 * que solo interesa lo reciente. Devuelve un resumen legible en texto plano,
 * no solo números, para que se pueda leer directamente en LOG_ACTIVIDAD sin
 * más herramientas.
 */
function _verificarClavesSupabase_(nombreLegible, tabla, campos, clavesSheet, columnaFecha, cutoffIso) {
  try {
    var cfg = getSupabaseConfig_();
    var filas = [];
    var PAGINA = 1000;
    var desde = 0;
    var filtroFecha = columnaFecha ? ('&' + columnaFecha + '=gte.' + encodeURIComponent(cutoffIso)) : '';
    while (true) {
      var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla + '?select=' + campos.join(',') + filtroFecha, {
        method: 'get',
        headers: {
          apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
          'Range-Unit': 'items', Range: desde + '-' + (desde + PAGINA - 1),
          'User-Agent': 'GoogleAppsScript-lm_produccion'
        },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() >= 300) throw new Error('HTTP ' + resp.getResponseCode() + ' (' + resp.getContentText().slice(0, 150) + ')');
      var pagina = JSON.parse(resp.getContentText() || '[]');
      filas = filas.concat(pagina);
      if (pagina.length < PAGINA) break;
      desde += PAGINA;
    }
    var enSupabase = {};
    filas.forEach(function(f) {
      enSupabase[campos.map(function(c) { return String(f[c]); }).join('|')] = true;
    });
    var faltantes = clavesSheet.filter(function(k) { return !enSupabase[k]; });
    var resumen = nombreLegible + ': ' + clavesSheet.length + ' en Sheets / ' + filas.length + ' en Supabase' +
      (faltantes.length ? ' — ' + faltantes.length + ' SIN SINCRONIZAR (' + faltantes.slice(0, 5).join(', ') + (faltantes.length > 5 ? '…' : '') + ')' : ' — todo presente');
    return { ok: !faltantes.length, resumen: resumen, faltantes: faltantes };
  } catch (e) {
    return { ok: false, resumen: nombreLegible + ': ERROR comprobando (' + e.message + ')' };
  }
}

/**
 * Igual que _verificarClavesSupabase_ pero solo compara recuentos totales,
 * para tablas sin clave natural común (HISTORIAL_ENTREGAS). Usa
 * Prefer: count=exact + limit=1 para no descargar filas de más, filtrando
 * por `columnaFecha` >= cutoffIso igual que las demás. Se acepta
 * Supabase >= Sheets como OK (por si algún día algo se reintenta a mano en
 * Supabase no queremos falsas alarmas por ese lado).
 */
function _verificarRecuentoSupabase_(nombreLegible, tabla, totalSheet, columnaFecha, cutoffIso) {
  try {
    var cfg = getSupabaseConfig_();
    var filtroFecha = columnaFecha ? ('&' + columnaFecha + '=gte.' + encodeURIComponent(cutoffIso)) : '';
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla + '?select=id&limit=1' + filtroFecha, {
      method: 'get',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        Prefer: 'count=exact', 'User-Agent': 'GoogleAppsScript-lm_produccion'
      },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) throw new Error('HTTP ' + resp.getResponseCode());
    var contentRange = resp.getHeaders()['Content-Range'] || resp.getHeaders()['content-range'] || '';
    var totalSupabase = Number(contentRange.split('/')[1]);
    var ok = !isNaN(totalSupabase) && totalSupabase >= totalSheet;
    var resumen = nombreLegible + ': ' + totalSheet + ' en Sheets / ' + (isNaN(totalSupabase) ? '?' : totalSupabase) + ' en Supabase' + (ok ? ' — OK' : ' — POSIBLE DIVERGENCIA');
    return { ok: ok, resumen: resumen };
  } catch (e) {
    return { ok: false, resumen: nombreLegible + ': ERROR comprobando (' + e.message + ')' };
  }
}

/**
 * Cierra un pedido: lo asigna a una silueta y registra la ocupación.
 * soportes: [{ tipoId, cant }]
 */
// Fase 3, Pieza 3 (2026-09-04, hot path -- se llama en cada cierre de
// pedido): PEDIDOS/OCUPACION ya viven en Postgres (public).
// public.cerrar_pedido(...) ya hace TODO lo de dentro (bultos, compartir
// delante Remansur, validación+ocupación) en una transacción con `for
// update` -- reemplaza el candado global de LockService por aislamiento real
// de fila. Devuelve pos_ini/pos_fin en snake_case (jsonb) -- se traduce a
// camelCase aquí para no tocar el contrato que espera el frontend.
function cerrarPedido(idPedido, silueta, posIni, soportes, operario) {
  var pedidoAntes = buscarFilaPorCampo('PEDIDOS', 'id', idPedido);
  var posiciones = calcularPosiciones(soportes);
  var r = _rpcPublic_('cerrar_pedido', {
    p_id_pedido: idPedido, p_silueta: silueta, p_pos_ini: posIni,
    p_posiciones: posiciones, p_soportes: soportes, p_operario: operario || null
  });
  if (!r.ok) return r;
  var out = { ok: true, silueta: r.silueta, posIni: r.pos_ini, posFin: r.pos_fin };
  if (r.compartido) out.compartido = true;
  // Nº de soportes de este cierre -- va al final del detalle en formato fijo
  // 'NNsop' (parseable con regex) para el ranking de operarios
  // (obtenerRankingOperarios): el LOG no tiene columna propia para esto y
  // añadir una en Postgres es más riesgo que un sufijo de texto, mismo
  // patrón que ya usa CERRAR_SIN_SILUETA (parsear el detalle con regex).
  var totalSoportes = (soportes || []).reduce(function(s, x) { return s + (Number(x && x.cant) || 0); }, 0);
  logActividad('CIERRE_PEDIDO', 'Pedido ' + idPedido + ' → ' + silueta + (r.pos_ini === r.pos_fin ? r.pos_ini : r.pos_ini + '-' + r.pos_fin) + ' · ' + totalSoportes + 'sop', operario);
  marcarResumenObsoleto();
  if (pedidoAntes) { try { actualizarPaletsBultosDisponibilidad(pedidoAntes, soportes); } catch (eD) {} }
  return out;
}

/**
 * Cierra un pedido en el que NINGUNA línea fue preparada (todo son faltantes).
 * No asigna silueta ni posición; deja el pedido en CERRADO_SIN_SILUETA — un
 * estado TERMINAL propio (antes reutilizaba PARCIAL_LISTO, que también es el
 * estado "recién marcado todo, esperando confirmar cierre" de un pedido
 * TODAVÍA activo — al no estar en ESTADOS_TERMINALES, listarPedidos() lo
 * seguía devolviendo como pendiente para siempre: el operario lo cerraba, el
 * pedido desaparecía un instante de la caché local, pero en cuanto se
 * refrescaba PEDIDOS_CACHE desde el servidor volvía a aparecer con las mismas
 * líneas en falta → la misma pantalla "todo faltante" en bucle infinito).
 */
function cerrarPedidoSinSilueta(idPedido, operario) {
  var pedidos = leerHoja('PEDIDOS');
  var pedido = pedidos.find(function(p) { return p.id === idPedido; });
  if (!pedido) return { ok: false, error: 'Pedido no encontrado' };
  var cambiosCierreSinSilueta = {
    estado: 'CERRADO_SIN_SILUETA',
    operario: operario || pedido.operario,
    actualizado: new Date().toISOString()
  };
  actualizarFila('PEDIDOS', pedido._fila, cambiosCierreSinSilueta);
  logActividad('CIERRE_SIN_SILUETA', 'Pedido ' + pedido.ped + ' cerrado sin silueta (todo faltante)', operario);
  marcarResumenObsoleto();
  sincronizarPedidoSupabase_(pedido, cambiosCierreSinSilueta);
  return { ok: true };
}

/**
 * Cierra un pedido de Granada directamente a CC.Granada: silueta ficticia fija
 * (sin fila en OCUPACION_SILUETAS, sin límite de capacidad -- mismo patrón que
 * "Recogidas"/"Ya Cargados"), pero A DIFERENCIA de esas dos SÍ guarda los
 * soportes (número + formato), porque este es el cierre normal del operario
 * con artículos reales preparados, no una reconversión admin posterior de un
 * pedido ya resuelto. posIni/posFin se guardan a '0' (no null), mismo
 * convenio que usa registrar_pedido_manual para "sin posiciones reales".
 * Granada no ocupa silueta física -- ver docs/superpowers/specs/2026-09-24-cc-granada-design.md.
 */
function cerrarPedidoAGranada(idPedido, operario, soportes) {
  var pedidos = leerHoja('PEDIDOS');
  var pedido = pedidos.find(function(p) { return p.id === idPedido; });
  if (!pedido) return { ok: false, error: 'Pedido no encontrado' };
  if (pedido.tienda !== 'Granada') return { ok: false, error: 'Esta acción es solo para pedidos de Granada' };
  var cambiosCierreGranada = {
    estado: 'COMPLETADO_LISTO',
    silueta: 'CC.Granada',
    posIni: '0',
    posFin: '0',
    soportes: soportes || [],
    operario: operario || pedido.operario,
    actualizado: new Date().toISOString()
  };
  actualizarFila('PEDIDOS', pedido._fila, cambiosCierreGranada);
  var totalSoportes = (soportes || []).reduce(function(s, x) { return s + (Number(x && x.cant) || 0); }, 0);
  logActividad('CIERRE_CC_GRANADA', 'Pedido ' + pedido.ped + ' cerrado a CC.Granada · ' + totalSoportes + 'sop', operario);
  marcarResumenObsoleto();
  sincronizarPedidoSupabase_(pedido, cambiosCierreGranada);
  // Mismo Excel externo de Disponibilidad que ya rellenan las otras 3 tiendas
  // al cerrar en silueta real (ver cerrarPedido) -- DISPONIBILIDAD_PESTANA_POR_TIENDA
  // ya tiene la pestaña DISP_GRANADA reservada.
  try { actualizarPaletsBultosDisponibilidad(pedido, soportes); } catch (eD) {}
  return { ok: true };
}

/**
 * REPARACIÓN PUNTUAL (bug histórico): antes de este arreglo, cerrarPedidoSinSilueta
 * dejaba el pedido en PARCIAL_LISTO (no terminal) en vez de CERRADO_SIN_SILUETA,
 * así que cualquier pedido cerrado así antes de este despliegue sigue "vivo"
 * para listarPedidos() y volverá a aparecer en bucle en el operario. Busca en
 * el LOG las entradas CIERRE_SIN_SILUETA ya generadas y, SOLO si el pedido
 * referenciado sigue hoy en PARCIAL_LISTO y sin silueta (exactamente la firma
 * que deja este bug, nunca la de un pedido recién marcado que aún espera su
 * PRIMER cierre), lo pasa a CERRADO_SIN_SILUETA. Idempotente: una vez
 * corregido un pedido ya no vuelve a coincidir, así que se puede ejecutar más
 * de una vez sin riesgo. Pensada para invocarse UNA vez desde el botón
 * temporal de administración y poder borrarse después.
 */
function repararCerradosSinSiluetaAtascados() {
  var pedidosCerradosSinSilueta = {};
  // Rendimiento (Pieza 4b, 2026-09-05): LOG_ACTIVIDAD ya es Postgres y tiene
  // ~15000 filas creciendo sin parar -- filtrar por tipo en el servidor en
  // vez de paginar la tabla ENTERA. El .forEach de abajo re-comprueba tipo
  // igual (autoridad de corrección, mismo patrón que obtenerMuellesHoy).
  var logs = _esTablaPublic_('LOG')
    ? leerHojaPublicConFiltro_('LOG', 'tipo=eq.CIERRE_SIN_SILUETA')
    : leerHoja('LOG');
  logs.forEach(function(l) {
    if (l.tipo !== 'CIERRE_SIN_SILUETA') return;
    var m = /^Pedido (\S+) cerrado sin silueta/.exec(String(l.detalle || ''));
    if (m) pedidosCerradosSinSilueta[m[1]] = true;
  });
  if (!Object.keys(pedidosCerradosSinSilueta).length) return { ok: true, corregidos: [] };

  var pedidos = leerHoja('PEDIDOS');
  var candidatos = pedidos.filter(function(p) {
    return p.estado === 'PARCIAL_LISTO' && !p.silueta && pedidosCerradosSinSilueta[String(p.ped)];
  });
  var corregidos = candidatos.map(function(p) { return p.ped + ' (' + p.tienda + ')'; });
  candidatos.forEach(function(p) {
    var cambiosReparacion = { estado: 'CERRADO_SIN_SILUETA', actualizado: new Date().toISOString() };
    actualizarFila('PEDIDOS', p._fila, cambiosReparacion);
    sincronizarPedidoSupabase_(p, cambiosReparacion);
  });
  if (corregidos.length) {
    logActividad('REPARACION_CIERRE_SIN_SILUETA', corregidos.length + ' pedido(s) atascados corregidos: ' + corregidos.join(', '), 'admin');
    marcarResumenObsoleto();
  }
  return { ok: true, corregidos: corregidos };
}

// ============================================================
// CARGA / EXPEDICIÓN (MAÑANA)
// ============================================================

/**
 * Datos completos de la pantalla de cargas en UNA sola llamada:
 * cargas activas + pedidos disponibles. Evita 2 viajes al servidor (cada viaje
 * a Apps Script cuesta ~1-2 s).
 */
function datosPantallaCargas() {
  // Una sola lectura de CARGAS y una de PEDIDOS para toda la pantalla.
  var cargasRaw = leerHoja('CARGAS');
  return {
    cargas: _cargasActivasDesde(cargasRaw),
    disponibles: _disponiblesDesde(cargasRaw, _pedidosEnSiluetaActivos_())
  };
}

/**
 * Pedidos disponibles para carga (los que están en silueta).
 */
function pedidosDisponiblesParaCarga() {
  return _disponiblesDesde(leerHoja('CARGAS'), _pedidosEnSiluetaActivos_());
}

// Rendimiento (2026-09-04): PEDIDOS con silueta asignada y no ENTREGADO --
// filtrado real en Postgres (silueta IS NOT NULL, ~100 filas de miles), no
// leerHoja('PEDIDOS') entera. Pantalla de Cargas, usada todo el día.
function _pedidosEnSiluetaActivos_() {
  var pedidos = _esTablaPublic_('PEDIDOS')
    ? leerHojaPublicConFiltro_('PEDIDOS', 'silueta=not.is.null&estado=neq.ENTREGADO')
    : leerHoja('PEDIDOS');
  return pedidos.filter(function(p) { return p.silueta && p.estado !== 'ENTREGADO'; });
}

function _disponiblesDesde(cargasRaw, pedidosRaw) {
  // Excluir los pedidos que ya están en una carga activa (GENERADA): un pedido va en una sola carga.
  var enCarga = {};
  cargasRaw.filter(function(c) { return c.estado === 'GENERADA'; }).forEach(function(c) {
    parseJSON(c.items, []).forEach(function(it) { enCarga[it.idPedido] = true; });
  });
  const pedidos = pedidosRaw.filter(function(p) {
    return p.silueta && p.estado !== 'ENTREGADO' && !enCarga[p.id];
  });
  return pedidos.map(function(p) {
    return {
      id: p.id, ped: p.ped, tienda: p.tienda, transportista: p.transportista,
      flujo: p.flujo, silueta: p.silueta, posIni: Number(p.posIni), posFin: Number(p.posFin),
      soportes: parseJSON(p.soportes, []), numeroCarga: p.numeroCarga || null
    };
  }).sort(function(a, b) {
    if (a.silueta !== b.silueta) return a.silueta < b.silueta ? -1 : 1;
    return a.posIni - b.posIni;
  });
}

/**
 * Crea una carga con una lista de números de pedido. El orden de la carga
 * generada es el INVERSO del orden en que se pegan los pedidos: lo primero
 * que se escribe queda en la última posición de la carga (y lo último
 * escrito, en la primera) — así el admin pega en orden de entrega y la hoja
 * de carga sale en orden de carga en el camión (a la inversa).
 */
function crearCarga(listaNumPedidos, responsable, esCamionGrua, agencia) {
  // CANDADO (2026-08-03): numCarga sale de leer el máximo actual y sumar 1 --
  // sin candado, dos admins pulsando "Crear carga" casi a la vez podían leer
  // el MISMO máximo y acabar con DOS cargas distintas compartiendo el mismo
  // número (confunde la hoja impresa, el dashboard y "Finalizar carga").
  var lockCarga = LockService.getScriptLock();
  var conCandadoCarga = false;
  try { conCandadoCarga = lockCarga.tryLock(15000); } catch (eLCa) { conCandadoCarga = false; }
  if (!conCandadoCarga) {
    return { ok: false, error: 'Hay otra creación de carga en curso -- espera un segundo y reintenta.' };
  }
  var pendienteVisas = null, pendienteSyncsCarga = [], pendienteCargaTaisa = null;
  try {
    const pedidos = leerHoja('PEDIDOS');
    const numeros = listaNumPedidos.map(function(n) { return String(n).trim(); }).filter(function(n) { return n; }).reverse();

    const encontrados = [];
    const noEncontrados = [];
    numeros.forEach(function(num) {
      const p = pedidos.find(function(x) {
        return String(x.ped) === num && x.silueta && x.estado !== 'ENTREGADO';
      });
      if (p) encontrados.push(p); else noEncontrados.push(num);
    });

    if (!encontrados.length) return { ok: false, error: 'Ningún pedido encontrado en silueta', noEncontrados: noEncontrados };

    // Nº de carga secuencial (permite VARIAS cargas activas a la vez: 1, 2, 3…).
    var maxNum = 0;
    leerHoja('CARGAS').forEach(function(c) { var n = Number(c.numCarga) || 0; if (n > maxNum) maxNum = n; });
    const numCarga = maxNum + 1;

    const items = encontrados.map(function(p) {
      return {
        idPedido: p.id, ped: p.ped, tienda: p.tienda,
        transportista: p.transportista, flujo: p.flujo,
        silueta: p.silueta, posIni: Number(p.posIni), posFin: Number(p.posFin),
        soportes: parseJSON(p.soportes, []),
        numeroCarga: numCarga, estado: 'PENDIENTE'
      };
    });

    // Marcar pedidos con su nº de carga: UNA sola operación para todos (RangeList).
    actualizarColumnaLote('PEDIDOS', encontrados.map(function(p) { return p._fila; }), 'numeroCarga', numCarga);
    encontrados.forEach(function(p) { pendienteSyncsCarga.push({ tipo: 'pedido', pedido: p, cambios: { numeroCarga: numCarga } }); });

    const carga = {
      id: 'CARGA_' + new Date().getTime(),
      numCarga: numCarga,
      fecha: new Date().toISOString(),
      estado: 'GENERADA',
      items: items,
      responsable: responsable || '',
      esCamionGrua: !!esCamionGrua,
      agencia: esCamionGrua ? (agencia || '') : ''
    };
    anadirFila('CARGAS', carga);
    items.forEach(function(item, idx) { pendienteSyncsCarga.push({ tipo: 'cargaPedido', cargaId: carga.id, idPedido: item.idPedido, idx: idx }); });
    logActividad('CREAR_CARGA', 'Carga ' + numCarga + ' · ' + items.length + ' pedidos' + (esCamionGrua ? ' · Camión Grúa (' + carga.agencia + ')' : ''), responsable || '');

    pendienteVisas = { ids: encontrados.map(function(p) { return p.id; }), numCarga: numCarga };
    if (esCamionGrua) pendienteCargaTaisa = { agencia: carga.agencia, fecha: carga.fecha, items: items, numCarga: numCarga };

    return { ok: true, carga: carga, noEncontrados: noEncontrados };
  } finally {
    lockCarga.releaseLock();
    pendienteSyncsCarga.forEach(function(s) {
      if (s.tipo === 'pedido') sincronizarPedidoSupabase_(s.pedido, s.cambios);
      else if (s.tipo === 'cargaPedido') sincronizarCargaPedidoSupabase_(s.cargaId, s.idPedido, s.idx);
    });
    if (pendienteVisas) _marcarVisasEnCarga(pendienteVisas.ids, pendienteVisas.numCarga);
    if (pendienteCargaTaisa) {
      try {
        _exportarCargaTaisa_(pendienteCargaTaisa.agencia, pendienteCargaTaisa.fecha, pendienteCargaTaisa.items);
      } catch (eTaisa) {
        logActividad('CARGAS_TAISA_ERROR', 'Fallo exportando carga ' + pendienteCargaTaisa.numCarga + ' a CARGAS TAISA: ' + eTaisa.message, '');
      }
    }
  }
}

/**
 * Saca un pedido de una carga TODAVÍA ACTIVA (GENERADA) — para cuando se
 * decide que ese pedido no debe ir con este chofer o esta agencia, ANTES de
 * llegar a "Finalizar carga". A diferencia de no escanearlo al finalizar
 * (que lo manda a CARGA_2 y dispara el correo automático de 2ª carga), esto
 * lo saca al momento SIN avisar a Correcaminos/Leroy Merlin — no es que no
 * haya cabido, es una corrección deliberada. El pedido no se toca
 * físicamente (sigue en su silueta): solo deja de pertenecer a esta carga y
 * vuelve a estar disponible para incluirlo en cualquier otra.
 */
function quitarPedidoDeCarga(idCarga, numPed) {
  // CANDADO: si dos administradores quitan pedidos DISTINTOS de la MISMA
  // carga casi a la vez, sin esto la segunda escritura de 'items' pisaría a
  // la primera partiendo de una copia ya obsoleta (el pedido quitado antes
  // "reaparecería"). No se anida con otros locks (esta función no llama a
  // ningún helper que a su vez pida su propio LockService).
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  var aSincronizar = null;
  try {
    var cargas = leerHoja('CARGAS');
    var cargaRow = cargas.find(function(c) { return c.id === idCarga; });
    if (!cargaRow) return { ok: false, error: 'Carga no encontrada' };
    if (cargaRow.estado !== 'GENERADA') return { ok: false, error: 'Esta carga ya está cerrada, no se puede modificar' };

    var items = parseJSON(cargaRow.items, []);
    var idx = items.findIndex(function(it) { return String(it.ped) === String(numPed); });
    if (idx === -1) return { ok: false, error: 'Ese pedido no está en esta carga' };
    var item = items[idx];
    items.splice(idx, 1);

    actualizarFila('CARGAS', cargaRow._fila, { items: items });

    // Liberar el nº de carga del pedido para que vuelva a salir en "disponibles".
    var pedidos = leerHoja('PEDIDOS');
    var pedido = pedidos.find(function(p) { return p.id === item.idPedido; });
    if (pedido) actualizarFila('PEDIDOS', pedido._fila, { numeroCarga: '' });

    logActividad('QUITAR_DE_CARGA', 'Pedido ' + numPed + ' sacado de la carga ' + cargaRow.numCarga, 'admin');
    marcarResumenObsoleto();
    aSincronizar = { idCarga: idCarga, idPedido: item.idPedido, pedido: pedido };
    return { ok: true, ped: numPed, numCarga: Number(cargaRow.numCarga), quedan: items.length };
  } finally {
    if (lock) lock.releaseLock();
    // Fase 1: las llamadas a Supabase se hacen DESPUÉS de soltar el candado
    // compartido -- son HTTP y pueden tardar, y no deben alargar el tiempo
    // que otros administradores esperan por este mismo candado.
    if (aSincronizar) {
      eliminarCargaPedidoSupabase_(aSincronizar.idCarga, aSincronizar.idPedido);
      if (aSincronizar.pedido) sincronizarPedidoSupabase_(aSincronizar.pedido, { numeroCarga: '' });
      _revertirVisaPendiente(aSincronizar.idPedido);
    }
  }
}

/**
 * Si el pedido pertenecía a una carga TODAVÍA ACTIVA (GENERADA), lo saca de
 * su snapshot de items — mismo candado/patrón que quitarPedidoDeCarga.
 * Reutilizado por cualquier función que resuelva un pedido "por otra vía"
 * (liberarlo a almacén/tienda, convertirlo a Ya Cargados...) SIN pasar por
 * quitarPedidoDeCarga: sin esto, el pedido queda como un "fantasma" en la
 * carga — confirmarEntregas() lo trataría más tarde como pendiente de 2ª
 * carga (aviso de correo falso a Correcaminos/Leroy Merlin + incremento de
 * intentoCarga sobre un pedido que ya no tiene nada que ver con esa carga)
 * o, si su número coincidiera con algo escaneado, le PISARÍA el estado
 * terminal ya puesto (DEVUELTO_ALMACEN/ENVIADO_TIENDA/SALIDA_MANUAL) de
 * vuelta a ENTREGADO — bug real: "los pedidos de las siluetas no se borran
 * cuando salen".
 */
function _quitarPedidoDeSuCargaActiva(numeroCarga, numPed) {
  if (!numeroCarga) return;
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  var aSincronizar = null;
  try {
    var cargaRow = leerHoja('CARGAS').find(function(c) { return String(c.numCarga) === String(numeroCarga) && c.estado === 'GENERADA'; });
    if (!cargaRow) return;
    var items = parseJSON(cargaRow.items, []);
    var idx = items.findIndex(function(it) { return String(it.ped) === String(numPed); });
    if (idx === -1) return;
    var itemQuitado = items[idx];
    items.splice(idx, 1);
    actualizarFila('CARGAS', cargaRow._fila, { items: items });
    aSincronizar = { idCarga: cargaRow.id, idPedido: itemQuitado.idPedido };
  } finally {
    if (lock) lock.releaseLock();
    if (aSincronizar) eliminarCargaPedidoSupabase_(aSincronizar.idCarga, aSincronizar.idPedido);
  }
}

/**
 * Si el pedido pertenece a una carga TODAVÍA ACTIVA (GENERADA), actualiza
 * también el flujo/transportista de su item dentro del snapshot — sin esto,
 * la hoja de carga impresa (htmlHojaCarga lee item.transportista del
 * snapshot, no PEDIDOS en vivo) seguiría mostrando el transportista VIEJO
 * después de corregirlo con cambiarFlujoPedido/cambiarFlujoPedidosMasivo,
 * entregando al chofer una hoja con la ruta/empresa de transporte incorrecta.
 */
function _sincronizarFlujoEnCargaActiva(numeroCarga, numPed, nuevoFlujo, nuevoTransportista) {
  if (!numeroCarga) return;
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  try {
    var cargaRow = leerHoja('CARGAS').find(function(c) { return String(c.numCarga) === String(numeroCarga) && c.estado === 'GENERADA'; });
    if (!cargaRow) return;
    var items = parseJSON(cargaRow.items, []);
    var it = items.find(function(x) { return String(x.ped) === String(numPed); });
    if (!it) return;
    it.flujo = nuevoFlujo; it.transportista = nuevoTransportista;
    actualizarFila('CARGAS', cargaRow._fila, { items: items });
  } finally {
    if (lock) lock.releaseLock();
  }
}

/**
 * Elimina COMPLETAMENTE una carga TODAVÍA ACTIVA (GENERADA, no CERRADA) — para
 * cuando se generó por error o hay que deshacerla entera, en vez de sacar sus
 * pedidos uno a uno con quitarPedidoDeCarga(). Libera el nº de carga de TODOS
 * sus pedidos (vuelven a estar "disponibles", igual que si se sacaran
 * individualmente). Los pedidos NO se tocan físicamente: siguen en su silueta
 * tal cual estaban.
 *
 * Solo se permite sobre cargas GENERADA (nunca CERRADA): una carga cerrada ya
 * tiene entregas/histórico real detrás (KPIs del día, log de actividad) y
 * borrarla sería destructivo de verdad, no deshacer un error de última hora.
 *
 * IMPORTANTE: NO se usa deleteRow() — la fila de CARGAS se marca con
 * estado:'ELIMINADA' (igual de "invisible" para todo lo que ya filtra por
 * estado==='GENERADA'/'CERRADA' en el resto del código: disponibilidad,
 * dashboard, cargasHoy...) y se conserva físicamente. Se probó primero con
 * deleteRow() y una revisión adversarial encontró dos problemas reales: (1)
 * confirmarEntregas() y actualizarCargador() escriben en CARGAS sin ningún
 * candado propio, así que el candado de esta función no las protege — un
 * borrado físico habría podido desplazar la fila de OTRA carga justo cuando
 * una de esas dos funciones, ya con su _fila leída de antes, escribe en ella
 * (a diferencia de purgarPedidosAntiguos, que solo corre de madrugada sin
 * actividad admin — aquí no hay ventana muerta equivalente); (2) al ser la
 * primera función que quitaría una fila física de CARGAS, el nº de carga de
 * crearCarga (max(numCarga existente)+1, sin candado) podría reutilizarse si
 * se borra la carga más reciente y se crea otra después — un mismo "Carga N"
 * usado dos veces en hojas impresas/histórico. Marcar en vez de borrar evita
 * ambos problemas de raíz sin tocar ninguna de esas otras funciones.
 *
 * Igual que quitarPedidoDeCarga: se actualiza CARGAS primero y los pedidos
 * después, para que si algo falla a media operación el estado inconsistente
 * sea "carga ya marcada ELIMINADA pero algún pedido con numeroCarga sin
 * limpiar" (cosmético, ese pedido ya no cuenta como en una carga GENERADA)
 * y no al revés (pedidos ya liberados pero la carga seguiría GENERADA con
 * posiciones desincronizadas si más tarde se confirmara por error).
 */
function eliminarCargaCompleta(idCarga) {
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  var aSincronizar = null;
  try {
    var cargas = leerHoja('CARGAS');
    var cargaRow = cargas.find(function(c) { return c.id === idCarga; });
    if (!cargaRow) return { ok: false, error: 'Carga no encontrada' };
    if (cargaRow.estado !== 'GENERADA') return { ok: false, error: 'Esta carga ya está cerrada, no se puede eliminar' };

    var items = parseJSON(cargaRow.items, []);
    actualizarFila('CARGAS', cargaRow._fila, { estado: 'ELIMINADA' });

    var pedidos = leerHoja('PEDIDOS');
    var filasLiberar = [];
    var pedidosLiberar = [];
    items.forEach(function(it) {
      var pedido = pedidos.find(function(p) { return p.id === it.idPedido; });
      if (pedido) { filasLiberar.push(pedido._fila); pedidosLiberar.push(pedido); }
    });
    if (filasLiberar.length) actualizarColumnaLote('PEDIDOS', filasLiberar, 'numeroCarga', '');

    logActividad('ELIMINAR_CARGA', 'Carga ' + cargaRow.numCarga + ' eliminada completa · ' + items.length + ' pedidos liberados', 'admin');
    marcarResumenObsoleto();
    aSincronizar = { cargaRow: cargaRow, pedidosLiberar: pedidosLiberar };
    return { ok: true, numCarga: Number(cargaRow.numCarga), pedidosLiberados: filasLiberar.length };
  } finally {
    if (lock) lock.releaseLock();
    if (aSincronizar) {
      aSincronizar.pedidosLiberar.forEach(function(p) { sincronizarPedidoSupabase_(p, { numeroCarga: '' }); });
    }
  }
}

/**
 * Añade un pedido a una carga YA GENERADA (aún no finalizada) — simétrico a
 * quitarPedidoDeCarga: a veces, antes de finalizar una carga, un chofer pide
 * que se le meta un pedido que estaba suelto en silueta (real o ficticia,
 * p.ej. Recogidas/Ya Cargados), igual que ya se puede sacar uno. Reutiliza
 * el MISMO criterio de "disponible para carga" que ya usa crearCarga/
 * pedidosDisponiblesParaCarga (silueta puesta, no entregado, no ya en OTRA
 * carga activa) — así el comportamiento es idéntico entre crear una carga
 * nueva y añadir a una ya en curso, sea cual sea la silueta del pedido.
 */
function anadirPedidoACarga(idCarga, numPed) {
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  var aSincronizar = null;
  try {
    var cargasRaw = leerHoja('CARGAS');
    var cargaRow = cargasRaw.find(function(c) { return c.id === idCarga; });
    if (!cargaRow) return { ok: false, error: 'Carga no encontrada' };
    if (cargaRow.estado !== 'GENERADA') return { ok: false, error: 'Esta carga ya está cerrada, no se puede modificar' };

    var items = parseJSON(cargaRow.items, []);
    if (items.some(function(it) { return String(it.ped) === String(numPed); })) {
      return { ok: false, error: 'Ese pedido ya está en esta carga' };
    }

    // OJO: el nº de pedido NO es único por sí solo — el identificador real es
    // tienda+número (idPedido = codigoTienda(tienda)+'::'+numPed), así que el
    // mismo número puede repetirse en tiendas distintas. La elegibilidad y la
    // fila que se usa DEBEN salir del MISMO resultado (por id), nunca de dos
    // búsquedas independientes por 'ped' — si no, con un número duplicado
    // entre tiendas se podría dar por "disponible" un pedido y acabar
    // metiendo en la carga los datos de OTRO (sin silueta real, posición 0).
    var pedidosRaw = leerHoja('PEDIDOS');
    var disponible = _disponiblesDesde(cargasRaw, pedidosRaw).find(function(d) { return String(d.ped) === String(numPed); });
    if (!disponible) {
      var cualquiera = pedidosRaw.find(function(x) { return String(x.ped) === String(numPed); });
      if (!cualquiera) return { ok: false, error: 'Pedido no encontrado' };
      if (!cualquiera.silueta) return { ok: false, error: 'Este pedido no está en ninguna silueta' };
      if (cualquiera.estado === 'ENTREGADO') return { ok: false, error: 'Este pedido ya está entregado' };
      return { ok: false, error: 'Este pedido ya está incluido en otra carga activa' };
    }
    var p = pedidosRaw.find(function(x) { return x.id === disponible.id; });
    if (!p) return { ok: false, error: 'Pedido no encontrado' };

    items.push({
      idPedido: p.id, ped: p.ped, tienda: p.tienda,
      transportista: p.transportista, flujo: p.flujo,
      silueta: p.silueta, posIni: Number(p.posIni), posFin: Number(p.posFin),
      soportes: parseJSON(p.soportes, []),
      numeroCarga: Number(cargaRow.numCarga), estado: 'PENDIENTE'
    });
    actualizarFila('CARGAS', cargaRow._fila, { items: items });
    var cambiosPedido = { numeroCarga: Number(cargaRow.numCarga) };
    actualizarFila('PEDIDOS', p._fila, cambiosPedido);

    logActividad('ANADIR_A_CARGA', 'Pedido ' + numPed + ' añadido a la carga ' + cargaRow.numCarga, 'admin');
    marcarResumenObsoleto();
    aSincronizar = { idCarga: idCarga, pedido: p, cambiosPedido: cambiosPedido, posicion: items.length - 1, numCarga: Number(cargaRow.numCarga) };
    return { ok: true, ped: numPed, numCarga: Number(cargaRow.numCarga), total: items.length };
  } finally {
    if (lock) lock.releaseLock();
    if (aSincronizar) {
      sincronizarCargaPedidoSupabase_(aSincronizar.idCarga, aSincronizar.pedido.id, aSincronizar.posicion);
      sincronizarPedidoSupabase_(aSincronizar.pedido, aSincronizar.cambiosPedido);
      _marcarVisasEnCarga([aSincronizar.pedido.id], aSincronizar.numCarga);
    }
  }
}

/**
 * Confirma entregas de una carga escaneando números.
 * Los entregados liberan silueta; los no escaneados pasan a CARGA_2.
 */
function confirmarEntregas(idCarga, numerosEscaneados) {
  // Candado + reclamo temprano (Fase 1): el bucle de más abajo hace una
  // llamada HTTP a Supabase por pedido entregado, así que una carga grande
  // puede tardar más de lo que espera el watchdog de 20s del cliente
  // (Index.html) -- si el operario, tras ver "el servidor no responde",
  // reintenta pulsando "Finalizar" otra vez MIENTRAS esta misma ejecución
  // sigue corriendo en el servidor (Apps Script no la cancela solo porque el
  // cliente dejó de escuchar), la segunda llamada vería la carga todavía
  // GENERADA y reprocesaría todo desde cero: historial duplicado y, si había
  // pendientes de 2ª carga, un SEGUNDO correo real a Correcaminos/Leroy
  // Merlin. Por eso se reclama la carga (estado: CERRADA) ANTES de hacer
  // ningún trabajo pesado -- cualquier llamada concurrente/repetida se
  // encuentra la carga ya no-GENERADA y se detiene aquí mismo.
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  var cargaRow;
  try {
    const cargas = leerHoja('CARGAS');
    cargaRow = cargas.find(function(c) { return c.id === idCarga; });
    if (!cargaRow) return { ok: false, error: 'Carga no encontrada' };
    if (cargaRow.estado !== 'GENERADA') return { ok: false, error: 'Esta carga ya se confirmó (o se está confirmando ahora mismo)' };
    actualizarFila('CARGAS', cargaRow._fila, { estado: 'CERRADA' });
  } finally {
    if (lock) lock.releaseLock();
  }

  const carga = { items: parseJSON(cargaRow.items, []), _fila: cargaRow._fila };
  const escaneados = {};
  numerosEscaneados.forEach(function(n) { escaneados[String(n).trim()] = true; });

  const entregados = [];
  const pendientes2 = [];
  const pendientes2Items = [];
  const itemsEntregados = [];
  const ts = new Date().toISOString();

  carga.items.forEach(function(item) {
    if (escaneados[String(item.ped)]) {
      item.estado = 'ENTREGADO';
      item.ts = ts;
      itemsEntregados.push(item);
      entregados.push(item.ped);
    } else {
      item.estado = 'CARGA_2';
      pendientes2.push(item.ped);
      pendientes2Items.push(item);
    }
  });

  // porId hace falta para AMBAS ramas (entregados Y pendientes de 2ª carga),
  // así que se construye una sola vez fuera del if.
  const pedidosHoja = leerHoja('PEDIDOS');
  const porId = {};
  pedidosHoja.forEach(function(p) { porId[p.id] = p; });

  // TODO EN LOTES (antes: ~7 operaciones de hoja POR pedido → 20-40 s con 10 pedidos).
  if (itemsEntregados.length) {
    // 1) Liberar la ocupación de TODOS los entregados en una sola pasada.
    // IMPORTANTE: se filtra también por pedido (no solo silueta+posición),
    // porque con el reparto de delante de Remansur dos pedidos DISTINTOS
    // pueden compartir una misma posición (uno detrás, otro delante) — al
    // entregar uno no debe borrarse la fila del otro que sigue en silueta.
    liberarPosicionesLote(itemsEntregados
      .filter(function(it) { return Number(it.posIni) > 0; })
      .map(function(it) { return { silueta: it.silueta, posIni: Number(it.posIni), posFin: Number(it.posFin), pedido: it.ped }; }));

    // 2) Marcar los pedidos ENTREGADO por lotes de columna (6 operaciones en total,
    //    da igual cuántos pedidos sean). intentoCarga se resetea: ya se resolvió,
    //    no debe seguir marcado como "pendiente de 2ª/3ª carga".
    const filasEnt = [];
    itemsEntregados.forEach(function(it) { var p = porId[it.idPedido]; if (p) filasEnt.push(p._fila); });
    actualizarColumnaLote('PEDIDOS', filasEnt, 'estado', 'ENTREGADO');
    actualizarColumnaLote('PEDIDOS', filasEnt, 'silueta', '');
    actualizarColumnaLote('PEDIDOS', filasEnt, 'posIni', '');
    actualizarColumnaLote('PEDIDOS', filasEnt, 'posFin', '');
    actualizarColumnaLote('PEDIDOS', filasEnt, 'actualizado', ts);
    actualizarColumnaLote('PEDIDOS', filasEnt, 'intentoCarga', '');

    // Sombra a Supabase (Fase 1, ver docs/superpowers/specs/2026-07-28-migracion-sheets-supabase-design.md):
    // mismo patrón best-effort no bloqueante que cerrarPedido. Solo cubre la
    // tabla pedidos; historial/cargas/liberación de ocupación quedan pendientes.
    itemsEntregados.forEach(function(it) {
      var p = porId[it.idPedido];
      if (p) sincronizarPedidoSupabase_(p, { estado: 'ENTREGADO', silueta: '', posIni: '', posFin: '', actualizado: ts, intentoCarga: '' });
    });

    // 3) Historial: un solo volcado con todas las filas. 'responsable' = chofer
    //    del vehículo (distinto de 'cargador' = quién lo cargó en la plataforma).
    var filasHistorial = itemsEntregados.map(function(it) {
      return {
        pedido: it.ped, tienda: it.tienda, transportista: it.transportista,
        silueta: it.silueta, posIni: it.posIni, posFin: it.posFin,
        cargador: cargaRow.cargador || '', ts: it.ts, confirmadoTs: ts,
        responsable: cargaRow.responsable || ''
      };
    });
    anadirFilas('HISTORIAL', filasHistorial);
  }

  // Pendientes de 2ª/3ª carga: incrementar su contador de intentos (1 = recién
  // creado/nunca ha rebotado, se guarda en blanco; 2 = ya rebotó una vez, va a
  // "2ª carga"; 3 = rebotó dos veces, "3ª carga"; etc). Cada pedido puede
  // llevar un contador DISTINTO, así que no se puede hacer en un solo lote de
  // columna (ese solo sirve para poner el MISMO valor a todos) — de todas
  // formas pendientes2Items suele ser una lista corta (lo que no cupo/no se
  // escaneó de una carga), así que un actualizarFila por pedido es barato.
  pendientes2Items.forEach(function(it) {
    var p = porId[it.idPedido];
    if (!p) return;
    var intentoActual = Number(p.intentoCarga) || 1;
    actualizarFila('PEDIDOS', p._fila, { intentoCarga: intentoActual + 1 });
    sincronizarPedidoSupabase_(p, { intentoCarga: intentoActual + 1 });
  });

  // Actualizar la carga. fechaCierre queda registrada aquí (distinta de
  // 'fecha', que es la de CREACIÓN) — la usan los KPIs del dashboard para
  // saber si esta carga se resolvió HOY, sea cual sea el día en que se creó.
  actualizarFila('CARGAS', carga._fila, {
    estado: 'CERRADA',
    items: carga.items,
    fechaCierre: ts
  });

  // Correo automático a Correcaminos / Leroy Merlin con los pedidos de 2ª carga.
  var correo = null;
  if (pendientes2Items.length > 0) {
    try {
      correo = enviarCorreosSegundasCargas({
        numCarga: cargaRow.numCarga,
        fecha: new Date().toISOString(),
        chofer: cargaRow.responsable || '',
        cargador: cargaRow.cargador || '',
        pendientes: pendientes2Items
      });
    } catch (e) { correo = { ok: false, error: e.toString() }; }
  }

  const visasAlerta = _resolverVisasTrasCarga(itemsEntregados, pendientes2Items, cargaRow.numCarga, ts);

  logActividad('CONFIRMAR_ENTREGAS', entregados.length + ' entregados, ' + pendientes2.length + ' a carga 2', '');
  marcarResumenObsoleto();
  return {
    ok: true, entregados: entregados.length, pendientes: pendientes2.length,
    pendientesList: pendientes2, correoEnviado: !!(correo && correo.ok),
    visasAlerta: visasAlerta
  };
}

// ============================================================
// VISAS · verificación de que un documento/talón que viaja con el pedido
// vuelve del transporte
// ============================================================
// Estados de una VISA:
//   PENDIENTE  → dada de alta, el pedido todavía no está en ninguna carga activa
//   EN_CARGA   → el pedido viaja en una carga GENERADA (aún sin confirmar)
//   RESUELTA   → esa carga se confirmó y el pedido salió ENTREGADO (visa OK, terminal)
//   ALERTA     → esa carga se confirmó pero el pedido NO salió entregado
//                (rebotó a 2ª carga) — puede autorresolverse si el pedido
//                vuelve a meterse en otra carga y esta vez sí se confirma.
// Cada día es un día nuevo: SIN histórico (a petición expresa del usuario,
// 2026-07-17) — limpiarVisasDiarias() vacía la hoja entera cada madrugada,
// sea cual sea el estado en que se quedara cada visa. Distinto de Store
// Delivery, que también se resetea por día pero solo excluye del listado, sin
// borrar filas.

/**
 * Resuelve un número de pedido pegado a una fila REAL de PEDIDOS. tiendaForzada
 * (opcional) desambigua cuando el mismo número existe en varias tiendas —
 * mismo problema de fondo ya documentado en moverPedidoDeSilueta/crearCarga
 * (el nº de pedido NO es único por sí solo, tienda+número sí).
 */
function _resolverVisaPedido(numero, tiendaForzada) {
  var candidatos = buscarFilasPorCampo('PEDIDOS', 'ped', numero);
  if (tiendaForzada) candidatos = candidatos.filter(function(p) { return p.tienda === tiendaForzada; });
  if (!candidatos.length) return { error: 'no encontrado' };
  var tiendasDistintas = {};
  candidatos.forEach(function(p) { tiendasDistintas[p.tienda] = true; });
  if (Object.keys(tiendasDistintas).length > 1) return { error: 'ambiguo' };
  return { pedido: candidatos[0] };
}

/**
 * Alta MASIVA de visas a partir de números de pedido pegados. tienda
 * (opcional): si se indica, desambigua TODOS los números de la lista contra
 * esa tienda; si se deja vacío, se autodetecta y solo se rechazan como
 * "ambiguos" los que de verdad existan en más de una tienda a la vez.
 */
function agregarVisasMasivo(numeros, tienda) {
  var lista = (numeros || []).map(function(n) { return String(n).trim(); }).filter(function(n) { return n; });
  if (!lista.length) return { ok: false, error: 'No se ha indicado ningún número de pedido' };

  var cargasRaw = leerHoja('CARGAS');
  var visasPorId = {};
  leerHoja('VISAS').forEach(function(v) { visasPorId[v.id] = v; });

  var anadidas = [], reactivadas = [], yaActivas = [], ambiguos = [], noEncontrados = [], noVerificables = [];
  var filasNuevas = [];
  var vistos = {};
  var ts = new Date().toISOString();

  lista.forEach(function(num) {
    if (vistos[num]) return;
    vistos[num] = true;
    var r = _resolverVisaPedido(num, tienda || '');
    if (r.error === 'no encontrado') { noEncontrados.push(num); return; }
    if (r.error === 'ambiguo') { ambiguos.push(num); return; }
    var p = r.pedido;
    if (ESTADOS_TERMINALES[p.estado]) {
      noVerificables.push(num + ' (' + (ESTADO_LABEL[p.estado] || p.estado) + ', ya no se puede verificar)');
      return;
    }

    var cargaDelPed = p.numeroCarga ? cargasRaw.find(function(c) { return String(c.numCarga) === String(p.numeroCarga); }) : null;
    var estadoInicial = (cargaDelPed && cargaDelPed.estado === 'GENERADA') ? 'EN_CARGA' : 'PENDIENTE';

    var existente = visasPorId[p.id];
    if (existente && existente.estado !== 'RESUELTA') {
      yaActivas.push(num + ' (ya está en Visas)');
      return;
    }
    if (existente) { // RESUELTA: reactivar para un nuevo ciclo
      var cambiosReactivar = {
        estado: estadoInicial, numeroCarga: p.numeroCarga || '',
        fechaAlta: ts, fechaResuelta: '', motivoAlerta: ''
      };
      actualizarFila('VISAS', existente._fila, cambiosReactivar);
      reactivadas.push(num);
      return;
    }
    filasNuevas.push({
      id: p.id, ped: p.ped, tienda: p.tienda, estado: estadoInicial,
      numeroCarga: p.numeroCarga || '', fechaAlta: ts, fechaResuelta: '', motivoAlerta: ''
    });
    anadidas.push(num);
  });

  if (filasNuevas.length) {
    anadirFilas('VISAS', filasNuevas);
  }
  if (anadidas.length || reactivadas.length) {
    logActividad('VISAS_ALTA', (anadidas.length + reactivadas.length) + ' visa(s) dadas de alta/reactivadas', 'admin');
  }

  return {
    ok: true, anadidas: anadidas.length, reactivadas: reactivadas.length,
    yaActivas: yaActivas, ambiguos: ambiguos, noEncontrados: noEncontrados, noVerificables: noVerificables
  };
}

/** Lista todas las visas (activas y resueltas), alertas primero. */
function listarVisas() {
  var visas = leerHoja('VISAS');
  var ORDEN = { ALERTA: 0, EN_CARGA: 1, PENDIENTE: 2, RESUELTA: 3 };
  visas.sort(function(a, b) {
    var oa = ORDEN.hasOwnProperty(a.estado) ? ORDEN[a.estado] : 9;
    var ob = ORDEN.hasOwnProperty(b.estado) ? ORDEN[b.estado] : 9;
    if (oa !== ob) return oa - ob;
    return String(b.fechaAlta || '').localeCompare(String(a.fechaAlta || ''));
  });
  return visas.map(function(v) {
    return {
      id: v.id, ped: v.ped, tienda: v.tienda, estado: v.estado,
      numeroCarga: v.numeroCarga || '', fechaAlta: v.fechaAlta || '',
      fechaResuelta: v.fechaResuelta || '', motivoAlerta: v.motivoAlerta || ''
    };
  });
}

/** Quita una visa de la lista a mano (p.ej. se dio de alta por error). */
function quitarVisa(id) {
  var v = leerHoja('VISAS').find(function(x) { return x.id === id; });
  if (!v) return { ok: false, error: 'Visa no encontrada' };
  borrarFila('VISAS', v._fila);
  logActividad('VISAS_QUITAR', 'Visa del pedido ' + v.ped + ' (' + v.tienda + ') quitada a mano', 'admin');
  return { ok: true };
}

// ============================================================
// LIMPIEZA DIARIA DE VISAS · cada día es un día nuevo, sin histórico
// ============================================================

/**
 * Vacía la hoja VISAS entera (TODAS las filas, sea cual sea su estado —
 * PENDIENTE/EN_CARGA/RESUELTA/ALERTA) — se llama por disparador automático de
 * madrugada. Se registra en LOG (que sí tiene histórico propio) para poder
 * auditar cuántas visas quedaron sin resolver ese día si hiciera falta.
 *
 * BUG REAL (encontrado 2026-09-02): antes usaba sheet.deleteRows(2, lastRow-1)
 * -- si la hoja se queda sin ninguna fila "de sobra" por debajo de los datos
 * (getMaxRows() == getLastRow()), eso intenta borrar TODAS las filas no
 * inmovilizadas (solo la cabecera, fila 1, está inmovilizada) y Sheets lo
 * rechaza: "No se pueden eliminar todas las filas que no estén
 * inmovilizadas". La excepción cortaba la función ANTES de llegar al
 * logActividad final, así que el fallo no dejaba ni rastro en LOG (ver
 * ejecución con error real del 2026-09-02 4:52:53 en el editor GAS) --
 * la limpieza de esa madrugada se saltó por completo, sin aviso. clearContent
 * vacía el mismo rango sin depender de que exista margen de filas.
 *
 * Pieza 4a (2026-09-05): VISAS ya vive en Postgres -- vaciar es un DELETE
 * directo contra la tabla (id=not.is.null es solo para darle a PostgREST una
 * condición explícita; como id es la clave primaria, siempre es true, borra
 * todo). Ya no toca la Hoja (congelada, igual que PEDIDOS/LINEAS/OCUPACION).
 */
function limpiarVisasDiarias() {
  var borradas = leerHoja('VISAS').length;
  _restPublic_('delete', 'visas?id=not.is.null');
  logActividad('VISAS_LIMPIEZA_DIARIA', borradas + ' visa(s) vaciadas (día nuevo, sin histórico)', 'sistema');
  return { ok: true, borradas: borradas };
}

/**
 * Activa (o reactiva) el vaciado automático diario: disparador de tiempo que
 * llama a limpiarVisasDiarias() cada madrugada (4:00, hora de Madrid — antes
 * de que empiece la operativa del día). Borra cualquier disparador previo de
 * la MISMA función antes de crear uno nuevo, para no duplicar.
 */
function activarLimpiezaDiariaVisas() {
  var reemplazados = _borrarTriggersLimpiezaVisas();
  ScriptApp.newTrigger('limpiarVisasDiarias').timeBased().everyDays(1).atHour(4).create();
  logActividad('AUTO_LIMPIEZA_VISAS_ACTIVADA', 'Vaciado automático diario de Visas activado (' + reemplazados + ' disparador(es) anterior(es) sustituido(s))', 'admin');
  return { ok: true, reemplazados: reemplazados };
}

/** Desactiva el vaciado automático diario. */
function desactivarLimpiezaDiariaVisas() {
  var quitados = _borrarTriggersLimpiezaVisas();
  logActividad('AUTO_LIMPIEZA_VISAS_DESACTIVADA', quitados + ' disparador(es) quitado(s)', 'admin');
  return { ok: true, quitados: quitados };
}

/** ¿Está activo el vaciado automático diario ahora mismo? */
function estadoLimpiezaDiariaVisas() {
  var activo = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === 'limpiarVisasDiarias'; });
  return { ok: true, activo: activo };
}

function _borrarTriggersLimpiezaVisas() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'limpiarVisasDiarias') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/**
 * crearCarga/anadirPedidoACarga llaman aquí con los ids de pedido recién
 * metidos en una carga: cualquier visa PENDIENTE o en ALERTA para esos ids
 * pasa a EN_CARGA. Si un id no tiene visa, no hace nada (caso normal).
 */
function _marcarVisasEnCarga(idsPedido, numCarga) {
  if (!idsPedido || !idsPedido.length) return;
  var idsSet = {};
  idsPedido.forEach(function(id) { idsSet[id] = true; });
  var visas = leerHoja('VISAS').filter(function(v) {
    return idsSet[v.id] && (v.estado === 'PENDIENTE' || v.estado === 'ALERTA');
  });
  visas.forEach(function(v) {
    var cambiosEnCarga = { estado: 'EN_CARGA', numeroCarga: numCarga };
    actualizarFila('VISAS', v._fila, cambiosEnCarga);
  });
}

/**
 * quitarPedidoDeCarga llama aquí: si el pedido sacado tenía una visa EN_CARGA
 * ligada precisamente a esa carga, vuelve a PENDIENTE (ya no viaja en nada).
 */
function _revertirVisaPendiente(idPedido) {
  var v = leerHoja('VISAS').find(function(x) { return x.id === idPedido && x.estado === 'EN_CARGA'; });
  if (!v) return;
  var cambiosRevertir = { estado: 'PENDIENTE', numeroCarga: '' };
  actualizarFila('VISAS', v._fila, cambiosRevertir);
}

/**
 * confirmarEntregas llama aquí tras cerrar la carga: las visas EN_CARGA de
 * esa carga cuyo pedido salió ENTREGADO pasan a RESUELTA; las que NO salieron
 * (rebotaron a 2ª carga) pasan a ALERTA — devuelve esas para que el cliente
 * avise EN EL MOMENTO (no hay que esperar a fin de jornada).
 */
function _resolverVisasTrasCarga(itemsEntregados, itemsPendientes2, numCarga, ts) {
  var idsEntregados = {};
  itemsEntregados.forEach(function(it) { idsEntregados[it.idPedido] = true; });
  var idsPendientes = {};
  itemsPendientes2.forEach(function(it) { idsPendientes[it.idPedido] = true; });

  var visas = leerHoja('VISAS').filter(function(v) { return v.estado === 'EN_CARGA' && String(v.numeroCarga) === String(numCarga); });
  var alertas = [];
  visas.forEach(function(v) {
    if (idsEntregados[v.id]) {
      var cambiosResuelta = { estado: 'RESUELTA', fechaResuelta: ts };
      actualizarFila('VISAS', v._fila, cambiosResuelta);
    } else if (idsPendientes[v.id]) {
      var motivo = 'No confirmada en la carga ' + numCarga + ' (rebotó a 2ª carga)';
      var cambiosAlerta = { estado: 'ALERTA', motivoAlerta: motivo };
      actualizarFila('VISAS', v._fila, cambiosAlerta);
      alertas.push({ ped: v.ped, tienda: v.tienda, numeroCarga: numCarga });
    }
  });
  return alertas;
}

/**
 * Desglose de "pedidos en silueta sin entregar", en dos grupos SIN solape:
 * pendientesSegundaCarga (ya rebotaron de una carga anterior) y
 * otrosSinCargar (nunca han rebotado — sueltos o en una carga activa aún sin
 * confirmar). Es la MISMA lógica que usan tanto la pantalla "Entregas" como
 * los KPIs de los dos dashboards (Pantalla admin y TV) — una sola fuente de
 * verdad para que nunca se desincronicen entre sí. Ver comentario de
 * obtenerHistorialCargas() para el porqué de yaRebotoAntes()/huérfanos.
 * Los 3 parámetros son OPCIONALES (si ya se leyeron esas hojas en el
 * llamador, se pasan para no releerlas — obtenerDatosDashboard() se llama
 * cada 10s desde la Pantalla TV, así que evitar lecturas duplicadas importa).
 */
function calcularPedidosEnSiluetaSinEntregar(pedidosIn, cargasIn, ocupacionIn) {
  const cargasRaw = cargasIn || leerHoja('CARGAS');
  const cargaPorNum = {};
  cargasRaw.forEach(function(c) { cargaPorNum[String(c.numCarga)] = c; });

  // Rendimiento: cuando se llama sin args (obtenerHistorialCargas), usar el
  // mismo filtrado real que ya usa el dashboard, no leerHoja('PEDIDOS') entera.
  const pedidos = pedidosIn || _pedidosEnSiluetaActivos_();
  const porNumero = {};
  pedidos.forEach(function(p) { porNumero[String(p.ped)] = p; });

  function yaRebotoAntes(p) {
    if (!p.numeroCarga) return false;
    var c = cargaPorNum[String(p.numeroCarga)];
    if (!c || c.estado !== 'CERRADA') return false;
    var items = parseJSON(c.items, []);
    var it = items.find(function(x) { return String(x.ped) === String(p.ped); });
    return !!(it && it.estado === 'CARGA_2');
  }
  function haRebotado(p) { return Number(p.intentoCarga) >= 2 || yaRebotoAntes(p); }
  function datosCarga(numeroCarga) {
    var c = numeroCarga ? cargaPorNum[String(numeroCarga)] : null;
    return { responsable: (c && c.responsable) || '', cargador: (c && c.cargador) || '' };
  }

  const enSilueta = pedidos.filter(function(p) { return p.silueta && !ESTADOS_TERMINALES[p.estado]; });

  const pendientesSegundaCarga = enSilueta
    .filter(haRebotado)
    .map(function(p) {
      var dc = datosCarga(p.numeroCarga);
      return {
        ped: p.ped, tienda: p.tienda, transportista: p.transportista, flujo: p.flujo,
        silueta: p.silueta || null, posIni: p.posIni || null, posFin: p.posFin || null,
        intentoCarga: Math.max(2, Number(p.intentoCarga) || 0), numeroCarga: p.numeroCarga || null, actualizado: p.actualizado,
        responsable: dc.responsable, cargador: dc.cargador
      };
    })
    .sort(function(a, b) { return b.intentoCarga - a.intentoCarga; });

  const yaListados = {};
  pendientesSegundaCarga.forEach(function(p) { yaListados[String(p.ped)] = true; });
  const otrosSinCargarBase = enSilueta
    .filter(function(p) { return !yaListados[String(p.ped)]; })
    .map(function(p) {
      yaListados[String(p.ped)] = true;
      var dc = datosCarga(p.numeroCarga);
      return {
        ped: p.ped, tienda: p.tienda, transportista: p.transportista, flujo: p.flujo,
        silueta: p.silueta || null, posIni: p.posIni || null, posFin: p.posFin || null,
        numeroCarga: p.numeroCarga || null, actualizado: p.actualizado, inconsistente: false,
        responsable: dc.responsable, cargador: dc.cargador
      };
    });

  const huerfanos = [];
  const vistosOcup = {};
  (ocupacionIn || leerHoja('OCUPACION')).forEach(function(o) {
    if (o.reservado === true || o.reservado === 'true') return;
    var numPed = String(o.pedido || '').trim();
    if (!numPed || yaListados[numPed] || vistosOcup[numPed]) return;
    vistosOcup[numPed] = true;
    var p = porNumero[numPed];
    var dc = datosCarga(p && p.numeroCarga);
    huerfanos.push({
      ped: o.pedido, tienda: o.tienda, transportista: (p && p.transportista) || '', flujo: o.flujo,
      silueta: o.silueta, posIni: Number(o.pos) || null, posFin: Number(o.pos) || null,
      numeroCarga: (p && p.numeroCarga) || null, actualizado: (p && p.actualizado) || null, inconsistente: true,
      responsable: dc.responsable, cargador: dc.cargador
    });
  });

  const otrosSinCargar = otrosSinCargarBase.concat(huerfanos).sort(function(a, b) {
    if (a.silueta !== b.silueta) return String(a.silueta).localeCompare(String(b.silueta));
    return (Number(a.posIni) || 0) - (Number(b.posIni) || 0);
  });

  return { pendientesSegundaCarga: pendientesSegundaCarga, otrosSinCargar: otrosSinCargar };
}

/**
 * Datos para la pantalla "📦 Entregas" (en paralelo a "Cargas"): quién ha
 * cargado cada pedido y cuándo (y con qué chofer), qué pedidos se han quedado
 * pendientes de una 2ª/3ª carga, y qué OTROS pedidos siguen en silueta sin
 * cargar todavía. 'entregados' sale de HISTORIAL (cargador+responsable+ts+
 * confirmadoTs). Para "pendiente de 2ª/3ª carga" NO basta con mirar
 * PEDIDOS.intentoCarga: ese contador solo existe desde que se añadió (no
 * detecta rebotes de ANTES de tener el contador) — así que también se
 * comprueba, como respaldo, si la carga a la que apunta numeroCarga ya está
 * CERRADA y ese pedido consta como CARGA_2 en su propio snapshot de items
 * (fuente de verdad que existe desde siempre). Además, "otrosSinCargar" se
 * completa con cualquier pedido que aparezca en el mapa de siluetas en vivo
 * (OCUPACION) pero que por lo que sea no haya salido ya en las dos listas
 * anteriores — para que esta pantalla NUNCA muestre menos de lo que enseña
 * el mapa de siluetas (si eso pasa, se marca 'inconsistente:true').
 */
function obtenerHistorialCargas() {
  // Rendimiento (Pieza 4a, 2026-09-05): HISTORIAL_ENTREGAS ya es Postgres y
  // crece sin purgarse (a diferencia de Sheets) -- pedir los 300 más
  // recientes por confirmado_ts directamente (mismo tope que el .slice(0,300)
  // de abajo) evita paginar la tabla ENTERA para acabar ordenando/recortando
  // en memoria. El .sort/.slice de abajo se deja tal cual como autoridad de
  // corrección (mismo patrón que obtenerMuellesHoy): si algún día esto
  // cambia, el resultado sigue siendo correcto, solo deja de ser óptimo.
  var historialRaw;
  if (_esTablaPublic_('HISTORIAL')) {
    var filasPg = _restPublic_('get', 'historial_entregas?select=*&order=confirmado_ts.desc.nullslast&limit=300');
    historialRaw = (filasPg || []).map(function(f) { return _filaPgAObjSheet_('HISTORIAL', f); });
  } else {
    historialRaw = leerHoja('HISTORIAL');
  }
  const entregados = historialRaw
    .map(function(h) {
      return {
        ped: h.pedido, tienda: h.tienda, transportista: h.transportista,
        silueta: h.silueta, posIni: h.posIni, posFin: h.posFin,
        cargador: h.cargador || '', responsable: h.responsable || '',
        ts: h.ts, confirmadoTs: h.confirmadoTs
      };
    })
    .sort(function(a, b) { return new Date(b.confirmadoTs) - new Date(a.confirmadoTs); })
    .slice(0, 300); // tope razonable: no acumular sin límite en una pantalla de consulta

  const desglose = calcularPedidosEnSiluetaSinEntregar();
  return { entregados: entregados, pendientesSegundaCarga: desglose.pendientesSegundaCarga, otrosSinCargar: desglose.otrosSinCargar };
}

/**
 * "Muelles" preparados HOY (huso Europe/Madrid): líneas cuya ubicación es de
 * TRÁNSITO tienda->plataforma (ver origenUbicacion) y que YA se marcaron
 * PREPARADO — es decir, ya se sacaron físicamente del Muelle hacia la
 * silueta de última milla. El admin necesita esta lista para, al cierre del
 * día, cambiar a mano esas direcciones a "467" en Pyxis (el artículo ya no
 * está en tránsito, está listo para reparto). Deduplicado por pedido+dir
 * (varios artículos de la misma dirección solo cuentan una vez, que es lo
 * que hay que cambiar en Pyxis).
 */
function obtenerMuellesHoy() {
  // Rendimiento: LINEAS filtrado por estado+fecha (margen de 2 días de
  // sobra por huso horario -- esHoyMadrid sigue siendo la autoridad exacta
  // más abajo, sin cambios), no leerHoja('LINEAS') entera. PEDIDOS solo se
  // pide para los idPedido que de verdad hacen falta.
  var lineas;
  if (_esTablaPublic_('LINEAS')) {
    var desde = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    lineas = leerHojaPublicConFiltro_('LINEAS', 'estado=eq.PREPARADO&ts=gte.' + encodeURIComponent(desde));
  } else {
    lineas = leerHoja('LINEAS');
  }
  var idsNecesarios = {};
  lineas.forEach(function(l) { if (l.idPedido) idsNecesarios[l.idPedido] = true; });
  var pedidos = buscarFilasPorCampo('PEDIDOS', 'id', Object.keys(idsNecesarios));
  var porId = {};
  pedidos.forEach(function(p) { porId[p.id] = p; });

  // Agrupado por pedido+dirección+REFERENCIA (antes solo pedido+dirección):
  // el admin ahora quiere ver qué artículo concreto es, y poder marcar cada
  // referencia como ya actualizada en Pyxis por separado. 'ids' guarda los
  // id(s) de LINEAS de ese grupo (normalmente 1; más de 1 solo si hubiera
  // líneas duplicadas del mismo ref+dir) para poder marcarlos todos a la vez.
  var porClave = {};
  var orden = [];
  lineas.forEach(function(l) {
    if (l.estado !== 'PREPARADO') return;
    if (l.muelleHecho === true || l.muelleHecho === 'true') return; // ya actualizado en Pyxis: fuera de la lista de pendientes
    if (origenUbicacion(l.dir) !== 'transito_tienda') return;
    if (!l.ts || !esHoyMadrid(l.ts)) return;
    var clave = l.idPedido + '|' + l.dir + '|' + l.ref;
    if (!porClave[clave]) {
      var p = porId[l.idPedido] || {};
      porClave[clave] = { ped: p.ped || '', tienda: p.tienda || '', dir: l.dir, ref: l.ref, ts: l.ts, ids: [], ctd: 0 };
      orden.push(clave);
    }
    porClave[clave].ids.push(l.id);
    porClave[clave].ctd += Number(l.ctd) || 0;
  });

  var salida = orden.map(function(clave) { return porClave[clave]; });
  salida.sort(function(a, b) {
    if (String(a.ped) !== String(b.ped)) return String(a.ped).localeCompare(String(b.ped));
    return String(a.dir).localeCompare(String(b.dir));
  });
  return salida;
}

/**
 * Pendientes de Muelles en el MISMO formato que espera el robot de
 * ubicación en Pyxis (robot-ubicacion-pyxis/robot): {id, idPedido, tienda,
 * referencia, cantidad, ubicacion}. 'ubicacion' siempre "467" (fijo, es lo
 * que se cambia al cierre del día para todo lo que vino de un Muelle).
 * 'id' guarda el/los id(s) de LINEAS de ese grupo como JSON, para poder
 * recuperarlos tal cual al importar los resultados (marcarMuelleHecho ya
 * acepta un array). El campo 'ref' de LINEAS en esta app YA es la
 * "Referencia" de Pyxis (viene del Excel de Pyxis, no del EAN escaneado),
 * a diferencia de robot-ubicacion-pyxis, que sí necesita traducir EAN→Ref.
 */
function pendientesMuellesParaRobot() {
  return obtenerMuellesHoy().map(function(m) {
    return {
      id: JSON.stringify(m.ids),
      idPedido: m.ped,
      tienda: m.tienda,
      referencia: m.ref,
      cantidad: m.ctd,
      ubicacion: '467'
    };
  });
}

/**
 * Importa los resultados que ha escrito el script del robot tras procesar
 * pendientesMuellesParaRobot(): resultados = [{id, estado, mensaje}], mismo
 * formato que ya usa robot-ubicacion-pyxis (VOLCADA_PYXIS/ERROR/
 * PENDIENTE_REVISION). Solo VOLCADA_PYXIS marca muelleHecho=true; los otros
 * dos NO se tocan (siguen sin marcar), así que la próxima exportación los
 * vuelve a incluir solos, sin necesidad de guardar aparte ningún estado de
 * error/revisión en la Hoja — se devuelven aquí mismo para verlos al
 * instante en pantalla.
 */
function importarResultadosMuellesRobot(resultados) {
  if (!resultados || !resultados.length) return { ok: false, error: 'Sin resultados' };
  var marcados = 0;
  var pendientesRevision = [];
  resultados.forEach(function(r) {
    var ids;
    try { ids = JSON.parse(r.id); } catch (e) { ids = null; }
    if (!ids || !ids.length) return;
    if (r.estado === 'VOLCADA_PYXIS') {
      marcarMuelleHecho(ids, true);
      marcados++;
    } else {
      pendientesRevision.push({ ids: ids, estado: r.estado, mensaje: r.mensaje || '' });
    }
  });
  logActividad('MUELLES_ROBOT_IMPORTAR', marcados + ' volcadas, ' + pendientesRevision.length + ' pendientes de revisión', 'admin');
  return { ok: true, marcados: marcados, pendientesRevision: pendientesRevision };
}

// ============================================================
// ROBOT MUELLES · script PowerShell autocontenido (sin instalar nada)
// ============================================================
// Puerto directo de robot-ubicacion-pyxis/robot/pyxis_ui.py (Python +
// pywinauto) a PowerShell + UI Automation de Windows (System.Windows.
// Automation, ya viene en Windows) -- pensado para un PC que no guarda
// nada entre sesiones: el script se genera con los pendientes YA
// incrustados cada vez que se descarga, sin depender de ningun Python/pip
// instalado de antes. Verificado el parseo/plumbing de PowerShell (Add-Type,
// JSON, bucle principal) con el parser de PowerShell -- la parte que SÍ hace
// falta validar en vivo es la automatizacion de la ventana real de Pyxis
// (misma necesidad que tuvo el robot Python original: usar -Simular primero).
var PLANTILLA_ROBOT_MUELLES_PS1 = `# ============================================================
# Robot de ubicacion Pyxis - Muelles (LM Malaga)
# Autocontenido: no requiere instalar nada (ni Python, ni paquetes) --
# solo usa PowerShell y .NET, que ya vienen en Windows. Pensado para un PC
# que no guarda nada entre sesiones: cada vez que se descarga desde la app,
# este script trae sus propios pendientes incrustados y funciona solo.
#
# Uso normal:      botón derecho -> Ejecutar con PowerShell
# Modo prueba (no escribe nada en Pyxis, solo navega y cancela):
#                   powershell -File robot_muelles.ps1 -Simular
#
# Puerto del robot Python "robot-ubicacion-pyxis/robot/pyxis_ui.py" a
# PowerShell + UI Automation de Windows -- misma tecnica (UIA), sin pywinauto.
# ============================================================
param(
    [switch]$Simular
)

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class VentanaInfo {
    public IntPtr Handle;
    public string Titulo;
}
public class Win32Mouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public const int SW_RESTORE = 9;
    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;
    public const uint WHEEL = 0x0800;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);

    // Enumeracion RAPIDA (Win32 puro, sin tocar UI Automation) de todas las
    // ventanas visibles con titulo -- para filtrar por titulo ANTES de
    // envolver en AutomationElement, en vez de pedir propiedades UIA a TODAS
    // las ventanas del escritorio (RootElement.FindAll(Children,...)): si
    // una sola ventana ajena (navegador, alguna app en segundo plano) no
    // responde bien al puente de accesibilidad, esa llamada se queda
    // colgada sin dar error -- confirmado en pruebas reales (el script se
    // quedaba parado justo despues de la cuenta atras, sin imprimir nada
    // mas ni lanzar excepcion). Con EnumWindows nativo esto no pasa: solo se
    // usa AutomationElement.FromHandle sobre las 1-2 ventanas que YA
    // coinciden por titulo con Pyxis.
    public static List<VentanaInfo> VentanasVisibles() {
        var resultado = new List<VentanaInfo>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            resultado.Add(new VentanaInfo { Handle = hWnd, Titulo = sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return resultado;
    }
}
"@

# ============================================================
# UI AUTOMATION NATIVO (COM directo, NO System.Windows.Automation)
# ============================================================
# System.Windows.Automation (el cliente .NET clasico de UI Automation,
# cargado con Add-Type -AssemblyName UIAutomationClient/UIAutomationTypes)
# tiene un fallo real y confirmado en pruebas en vivo: contra la ventana de
# Pyxis solo ve el menu superior (69 elementos, 0 campos Edit, 0 StatusBar),
# mientras que pywinauto (Python), que habla directamente con la interfaz
# COM nativa (IUIAutomation/"UIA3"), ve el contenido completo (113
# elementos, 8 Edit incluido "Acto de venta", StatusBar con la tienda) EN
# LA MISMA VENTANA, EN EL MISMO INSTANTE. No es un problema de Pyxis ni de
# Java Access Bridge (probado tambien, y activarlo ademas impide que Pyxis
# arranque en este equipo) -- es una limitacion documentada de ese cliente
# .NET concreto. La solucion: hablar con la interfaz COM nativa directamente.
#
# OJO importante: PowerShell NO sabe invocar metodos de una interfaz COM
# pura sin IDispatch (como IUIAutomation) con la sintaxis $obj.Metodo(),
# aunque el objeto se cree y se "castee" sin error aparente -- confirmado en
# pruebas reales (el cast no lanza excepcion pero la llamada al metodo
# falla con "no contiene ningun metodo llamado X"). Por eso TODA la
# interaccion con estas interfaces vive aqui, en C# compilado; el resto del
# script (mas abajo) solo llama a los metodos estaticos de [UiaHelper],
# igual que ya hace con [Win32Mouse].
Add-Type @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("B32A92B5-BC25-4078-9C08-D7EE95C48E03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCacheRequest { }

[ComImport, Guid("4042C624-389C-4AFC-A630-9DF854A541FC"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationTreeWalker
{
    IUIAutomationElement GetParentElement(IUIAutomationElement element);  // 1
}

[ComImport, Guid("352FFBA8-0973-437C-A61F-F64CAFD81DF9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCondition { }

[ComImport, Guid("14314595-B4BC-4055-95F2-58F2E42C9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElementArray
{
    int Length { get; }
    IUIAutomationElement GetElement(int index);
}

[ComImport, Guid("A94CD8B1-0844-4CD6-9D2D-640537AB39E9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationValuePattern
{
    void SetValue([MarshalAs(UnmanagedType.BStr)] string val);
    [return: MarshalAs(UnmanagedType.BStr)]
    string get_CurrentValue();
    int get_CurrentIsReadOnly();
}

[ComImport, Guid("D22108AA-8AC5-49A5-837B-37BBB3D7591E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElement
{
    void SetFocus();                                                                  // 1
    void GetRuntimeId_Unused();                                                       // 2
    void FindFirst_Unused();                                                          // 3
    IUIAutomationElementArray FindAll(int scope, IUIAutomationCondition condition);    // 4
    void FindFirstBuildCache_Unused();                                                // 5
    void FindAllBuildCache_Unused();                                                  // 6
    void BuildUpdatedCache_Unused();                                                  // 7
    [return: MarshalAs(UnmanagedType.Struct)]
    object GetCurrentPropertyValue(int propertyId);                                   // 8
    void GetCurrentPropertyValueEx_Unused();                                          // 9
    void GetCachedPropertyValue_Unused();                                             // 10
    void GetCachedPropertyValueEx_Unused();                                           // 11
    void GetCurrentPatternAs_Unused();                                                // 12
    void GetCachedPatternAs_Unused();                                                 // 13
    [return: MarshalAs(UnmanagedType.IUnknown)]
    object GetCurrentPattern(int patternId);                                          // 14
}

[ComImport, Guid("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomation
{
    void CompareElements_Unused();                                                    // 1
    void CompareRuntimeIds_Unused();                                                  // 2
    void GetRootElement_Unused();                                                     // 3
    IUIAutomationElement ElementFromHandle(IntPtr hwnd);                              // 4
    void ElementFromPoint_Unused();                                                   // 5
    void GetFocusedElement_Unused();                                                  // 6
    void GetRootElementBuildCache_Unused();                                           // 7
    void ElementFromHandleBuildCache_Unused();                                        // 8
    void ElementFromPointBuildCache_Unused();                                         // 9
    void GetFocusedElementBuildCache_Unused();                                        // 10
    void CreateTreeWalker_Unused();                                                   // 11
    IUIAutomationTreeWalker get_ControlViewWalker();                                  // 12
    IUIAutomationTreeWalker get_ContentViewWalker();                                  // 13
    IUIAutomationTreeWalker get_RawViewWalker();                                      // 14
    IUIAutomationCondition get_RawViewCondition();                                    // 15
    IUIAutomationCondition get_ControlViewCondition();                                // 16
    IUIAutomationCondition get_ContentViewCondition();                                // 17
    IUIAutomationCacheRequest CreateCacheRequest();                                   // 18
    IUIAutomationCondition CreateTrueCondition();                                     // 19
    IUIAutomationCondition CreateFalseCondition();                                    // 20
    IUIAutomationCondition CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value); // 21
}

public class UiaElem
{
    internal IUIAutomationElement Inner;
    internal UiaElem(IUIAutomationElement inner) { Inner = inner; }
}

// Mismos nombres que System.Windows.Automation.ControlType (Button, Edit...)
// para poder seguir escribiendo [ControlType]::Edit en el resto del script.
public static class ControlType
{
    public const int Button = 50000;
    public const int Edit = 50004;
    public const int ListItem = 50007;
    public const int TabItem = 50019;
    public const int Text = 50020;
    public const int StatusBar = 50017;
    public const int Header = 50034;
    public const int HeaderItem = 50035;
}

public static class UiaHelper
{
    public const int Prop_ControlType = 30003;
    public const int Prop_Name = 30005;
    public const int Prop_HelpText = 30013;
    public const int Prop_BoundingRectangle = 30001;
    public const int Prop_NativeWindowHandle = 30020;
    public const int Pattern_Value = 10002;
    public const int Scope_Children = 2;
    public const int Scope_Descendants = 4;

    private static IUIAutomation _auto;
    private static IUIAutomation Auto
    {
        get
        {
            if (_auto == null)
            {
                Type t = Type.GetTypeFromCLSID(new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E"));
                _auto = (IUIAutomation)Activator.CreateInstance(t);
            }
            return _auto;
        }
    }

    public static UiaElem ElementFromHandle(IntPtr hwnd)
    {
        var e = Auto.ElementFromHandle(hwnd);
        return e == null ? null : new UiaElem(e);
    }

    public static string GetName(UiaElem el)
    {
        if (el == null) return "";
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_Name); return v as string ?? ""; }
        catch { return ""; }
    }

    public static int GetControlType(UiaElem el)
    {
        if (el == null) return 0;
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_ControlType); return v is int ? (int)v : 0; }
        catch { return 0; }
    }

    public static string GetHelpText(UiaElem el)
    {
        if (el == null) return "";
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_HelpText); return v as string ?? ""; }
        catch { return ""; }
    }

    // Devuelve [left, top, width, height] -- formato nativo de UiaRect.
    public static double[] GetBoundingRect(UiaElem el)
    {
        if (el == null) return new double[] { 0, 0, 0, 0 };
        try
        {
            var v = el.Inner.GetCurrentPropertyValue(Prop_BoundingRectangle);
            if (v is double[] && ((double[])v).Length == 4) return (double[])v;
            return new double[] { 0, 0, 0, 0 };
        }
        catch { return new double[] { 0, 0, 0, 0 }; }
    }

    public static IntPtr GetNativeWindowHandle(UiaElem el)
    {
        if (el == null) return IntPtr.Zero;
        try
        {
            var v = el.Inner.GetCurrentPropertyValue(Prop_NativeWindowHandle);
            if (v is int) return new IntPtr((int)v);
            return IntPtr.Zero;
        }
        catch { return IntPtr.Zero; }
    }

    public static void SetFocus(UiaElem el)
    {
        if (el == null) return;
        try { el.Inner.SetFocus(); } catch { }
    }

    private static IUIAutomationTreeWalker _rawWalker;
    private static IUIAutomationTreeWalker RawWalker
    {
        get
        {
            if (_rawWalker == null) _rawWalker = Auto.get_RawViewWalker();
            return _rawWalker;
        }
    }

    public static UiaElem GetParent(UiaElem el)
    {
        if (el == null) return null;
        try
        {
            var p = RawWalker.GetParentElement(el.Inner);
            return p == null ? null : new UiaElem(p);
        }
        catch { return null; }
    }

    private static UiaElem[] ToArray(IUIAutomationElementArray arr)
    {
        if (arr == null) return new UiaElem[0];
        int n = arr.Length;
        var result = new UiaElem[n];
        for (int i = 0; i < n; i++) result[i] = new UiaElem(arr.GetElement(i));
        return result;
    }

    public static UiaElem[] FindAllChildren(UiaElem el, int controlType)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreatePropertyCondition(Prop_ControlType, controlType);
        return ToArray(el.Inner.FindAll(Scope_Children, cond));
    }

    public static UiaElem[] FindAllDescendants(UiaElem el, int controlType)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreatePropertyCondition(Prop_ControlType, controlType);
        return ToArray(el.Inner.FindAll(Scope_Descendants, cond));
    }

    public static UiaElem[] FindAllChildrenAny(UiaElem el)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreateTrueCondition();
        return ToArray(el.Inner.FindAll(Scope_Children, cond));
    }

    public static bool SetValue(UiaElem el, string value)
    {
        if (el == null) return false;
        try
        {
            object pattern = el.Inner.GetCurrentPattern(Pattern_Value);
            if (pattern == null) return false;
            IUIAutomationValuePattern vp = (IUIAutomationValuePattern)pattern;
            vp.SetValue(value);
            return true;
        }
        catch { return false; }
    }

    public static string GetValue(UiaElem el)
    {
        if (el == null) return null;
        try
        {
            object pattern = el.Inner.GetCurrentPattern(Pattern_Value);
            if (pattern == null) return null;
            IUIAutomationValuePattern vp = (IUIAutomationValuePattern)pattern;
            return vp.get_CurrentValue();
        }
        catch { return null; }
    }
}
"@

# Definida YA AL PRINCIPIO (no mas abajo): un "catch [RevisionManualException]"
# necesita poder resolver el tipo antes de que se ejecute nada del script.
Add-Type @"
using System;
public class RevisionManualException : Exception {
    public RevisionManualException(string mensaje) : base(mensaje) {}
}
"@

# ---------------- constantes ----------------
$VENTANA_PYXIS_TITULO_RE = "^Pyxis -.*"
$INDICE_COLUMNA_DONDE = 0
$ESTADO_VOLCADA = "VOLCADA_PYXIS"
$ESTADO_ERROR = "ERROR"
$ESTADO_REVISION = "PENDIENTE_REVISION"
$ESTADOS_LINEA_MUERTA = @("ANULADO", "RETIRADO", "SALDADO")
$SEGUNDOS_PREPARACION = 8
$MAX_SCROLLS_RESET = 40
$MAX_SCROLLS_BUSQUEDA = 25

$TC = [ControlType]

# ---------------- utilidades basicas ----------------

function Click-At([double]$x, [double]$y) {
    [Win32Mouse]::SetCursorPos([int]$x, [int]$y) | Out-Null
    Start-Sleep -Milliseconds 60
    [Win32Mouse]::mouse_event([Win32Mouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [Win32Mouse]::mouse_event([Win32Mouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function DoubleClick-At([double]$x, [double]$y) {
    Click-At $x $y
    Start-Sleep -Milliseconds 90
    Click-At $x $y
}

function Scroll-At([double]$x, [double]$y, [int]$delta) {
    [Win32Mouse]::SetCursorPos([int]$x, [int]$y) | Out-Null
    [Win32Mouse]::mouse_event([Win32Mouse]::WHEEL, 0, 0, $delta, [UIntPtr]::Zero)
}

function Centro($rect) {
    return @{ X = $rect.X + ($rect.Width / 2); Y = $rect.Y + ($rect.Height / 2) }
}

function Normalizar([string]$texto) {
    if (-not $texto) { return "" }
    $t = $texto.Trim().ToUpperInvariant()
    $formaD = $t.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $formaD.ToCharArray()) {
        $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($c)
        if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($c) }
    }
    return $sb.ToString()
}

# Quita un ".0" final que a veces trae un numero exportado desde Sheets
# (mismo problema ya resuelto en el robot Python: "14787843.0" -> "14787843").
function TextoLimpio($valor) {
    $texto = [string]$valor
    if ($texto -match '^\-?\d+\.0$') {
        return $texto.Substring(0, $texto.Length - 2)
    }
    return $texto
}

function Descendientes($elemento, $controlType) {
    return [UiaHelper]::FindAllDescendants($elemento, $controlType)
}

# Hijos DIRECTOS (no todos los descendientes) de un tipo concreto -- para
# los sitios donde el original en Python usaba .children() (p.ej. las filas
# de una lista concreta, o los HeaderItem de una cabecera concreta), donde
# buscar en TODO el subarbol podria coger elementos de mas.
function HijosDirectos($elemento, $controlType) {
    return [UiaHelper]::FindAllChildren($elemento, $controlType)
}

function TextoElemento($elemento) {
    return [UiaHelper]::GetName($elemento)
}

# Devuelve un objeto con X/Y/Width/Height (mismo formato que ya esperaba el
# resto del script) a partir de [left, top, width, height], que es como lo
# devuelve UiaHelper (formato nativo UiaRect, NO left/top/right/bottom).
function RectanguloElemento($elemento) {
    $r = [UiaHelper]::GetBoundingRect($elemento)
    return [pscustomobject]@{ X = $r[0]; Y = $r[1]; Width = $r[2]; Height = $r[3] }
}

# ---------------- conexion a la ventana de Pyxis ----------------

function VentanaUtilizable($ventana) {
    try {
        $r = RectanguloElemento $ventana
        return ($r.Width -gt 0 -and $r.Height -gt 0)
    } catch { return $false }
}

function TextoBarraEstado($ventana) {
    $barras = Descendientes $ventana $TC::StatusBar
    if ($barras.Count -eq 0) { return "" }
    $textos = @()
    $textosCtrl = Descendientes $barras[0] $TC::Text
    foreach ($t in $textosCtrl) {
        $v = TextoElemento $t
        if ($v) { $textos += $v }
    }
    return ($textos -join " ")
}

function Conectar-Pyxis([string]$tienda) {
    # Trazas [conectar] en DarkGray: mientras esto no esta 100% probado en
    # vivo contra Pyxis, sirven para localizar EXACTAMENTE en que llamada se
    # queda parado si algo se cuelga, en vez de quedarse en silencio total.
    Write-Host "  [conectar] buscando ventanas por titulo (Win32, sin UI Automation)..." -ForegroundColor DarkGray
    $candidatas = @([Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match $VENTANA_PYXIS_TITULO_RE })
    Write-Host ("  [conectar] {0} ventana(s) con titulo coincidente" -f $candidatas.Count) -ForegroundColor DarkGray

    $ventanas = @()
    for ($i = 0; $i -lt $candidatas.Count; $i++) {
        $c = $candidatas[$i]
        Write-Host ("  [conectar] verificando ventana {0}/{1} (titulo='{2}')..." -f ($i + 1), $candidatas.Count, $c.Titulo) -ForegroundColor DarkGray
        # Restaurar si esta minimizada -- si no, su BoundingRectangle via UI
        # Automation sale vacio/0x0 y VentanaUtilizable la descartaria como
        # si no existiera, aunque la ventana este perfectamente abierta (solo
        # minimizada en la barra de tareas). Confirmado en pruebas reales.
        if ([Win32Mouse]::IsIconic($c.Handle)) {
            Write-Host "  [conectar]   estaba minimizada, restaurando..." -ForegroundColor DarkGray
            [Win32Mouse]::ShowWindow($c.Handle, [Win32Mouse]::SW_RESTORE) | Out-Null
            Start-Sleep -Milliseconds 300
        }
        try { $v = [UiaHelper]::ElementFromHandle($c.Handle) } catch { Write-Host "  [conectar]   FromHandle fallo, se descarta" -ForegroundColor DarkGray; continue }
        if (-not $v) { Write-Host "  [conectar]   FromHandle devolvio null, se descarta" -ForegroundColor DarkGray; continue }
        Write-Host "  [conectar]   comprobando que la ventana sea utilizable (rectangulo)..." -ForegroundColor DarkGray
        if (VentanaUtilizable $v) {
            Write-Host "  [conectar]   OK, utilizable" -ForegroundColor DarkGray
            $ventanas += @{ Elemento = $v; Handle = $c.Handle }
        } else {
            Write-Host "  [conectar]   no utilizable, se descarta" -ForegroundColor DarkGray
        }
    }
    if ($ventanas.Count -eq 0) {
        throw "No se encuentra ninguna ventana de Pyxis abierta. Abre MultiPyxis e inicia sesion primero."
    }
    if ($tienda) {
        $tiendaNorm = Normalizar $tienda
        for ($i = 0; $i -lt $ventanas.Count; $i++) {
            $v = $ventanas[$i]
            Write-Host ("  [conectar] leyendo barra de estado de la ventana {0}/{1}..." -f ($i + 1), $ventanas.Count) -ForegroundColor DarkGray
            $barraEstado = TextoBarraEstado $v.Elemento
            Write-Host ("  [conectar]   barra de estado: '{0}'" -f $barraEstado) -ForegroundColor DarkGray
            if ((Normalizar $barraEstado) -like "*$tiendaNorm*") {
                Write-Host "  [conectar] tienda coincide, conectando..." -ForegroundColor DarkGray
                [Win32Mouse]::SetForegroundWindow([IntPtr]$v.Handle) | Out-Null
                Start-Sleep -Milliseconds 200
                return $v.Elemento
            }
        }
        throw ("No se encuentra ninguna ventana de Pyxis conectada a la tienda '" + $tienda + "'. Abre Pyxis e inicia sesion con esa tienda.")
    }
    $v = $ventanas[0]
    [Win32Mouse]::SetForegroundWindow([IntPtr]$v.Handle) | Out-Null
    Start-Sleep -Milliseconds 200
    return $v.Elemento
}

# ---------------- botones / dialogos ----------------

function Encontrar-Boton($ventana, [string]$texto) {
    $botones = Descendientes $ventana $TC::Button
    foreach ($b in $botones) {
        if ((TextoElemento $b).Trim() -eq $texto) { return $b }
    }
    return $null
}

function Esperar-Boton($ventana, [string]$texto, [int]$timeoutSeg = 5) {
    $transcurrido = 0.0
    while ($transcurrido -lt $timeoutSeg) {
        $b = Encontrar-Boton $ventana $texto
        if ($b) { return $b }
        Start-Sleep -Milliseconds 500
        $transcurrido += 0.5
    }
    return $null
}

function Click-Boton($boton) {
    $r = RectanguloElemento $boton
    $c = Centro $r
    Click-At $c.X $c.Y
}

function Aceptar-DialogosEmergentes($ventana, [int]$maximo = 3) {
    for ($i = 0; $i -lt $maximo; $i++) {
        $boton = $null
        foreach ($texto in @("Aceptar", "Validar", "Si", "Sí", "OK")) {
            $boton = Encontrar-Boton $ventana $texto
            if ($boton) { break }
        }
        if (-not $boton) { return }
        Click-Boton $boton
        Start-Sleep -Milliseconds 600
    }
}

# ---------------- abrir pedido ----------------

function Encontrar-CampoPorAyuda($ventana, [string]$textoBuscado) {
    $campos = Descendientes $ventana $TC::Edit
    foreach ($campo in $campos) {
        $ayuda = [UiaHelper]::GetHelpText($campo)
        if ($ayuda -and $ayuda.ToLowerInvariant().Contains($textoBuscado.ToLowerInvariant())) { return $campo }
    }
    return $null
}

function Pestana-Pedido($ventana, [string]$numeroPedido) {
    $pestanas = Descendientes $ventana $TC::TabItem
    foreach ($p in $pestanas) {
        if ((TextoElemento $p).Contains($numeroPedido)) { return $p }
    }
    return $null
}

function Escribir-Campo($campo, [string]$texto) {
    # ValuePattern es mas fiable que simular tecla a tecla; si el control no
    # lo soporta (raro en un Edit), se usa clic + Ctrl+A + escritura como red.
    if ([UiaHelper]::SetValue($campo, $texto)) { return }
    $r = RectanguloElemento $campo
    $c = Centro $r
    Click-At $c.X $c.Y
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait($texto)
}

function Abrir-Pedido($ventana, [string]$numeroPedido) {
    $pestana = Pestana-Pedido $ventana $numeroPedido
    if ($pestana) {
        Click-Boton $pestana
        Start-Sleep -Milliseconds 600
        Aceptar-DialogosEmergentes $ventana
        return
    }

    $campoActo = Encontrar-CampoPorAyuda $ventana "Acto de venta"
    if (-not $campoActo) { throw "No se encuentra el campo 'Acto de venta' en Pyxis" }

    Escribir-Campo $campoActo $numeroPedido
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

    $pestana = $null
    $transcurrido = 0.0
    while ($transcurrido -lt 6) {
        Aceptar-DialogosEmergentes $ventana
        $pestana = Pestana-Pedido $ventana $numeroPedido
        if ($pestana) { break }
        Start-Sleep -Milliseconds 300
        $transcurrido += 0.3
    }
    if (-not $pestana) { throw "No se pudo abrir el pedido $numeroPedido en Pyxis" }
    Click-Boton $pestana
}

# ---------------- fila de la referencia (viva vs. muerta) ----------------

function Texto-Fila($fila) {
    $partes = @()
    $n = TextoElemento $fila
    if ($n) { $partes += $n }
    try {
        $hijos = [UiaHelper]::FindAllChildrenAny($fila)
        foreach ($h in $hijos) {
            $t = TextoElemento $h
            if ($t) { $partes += $t }
        }
    } catch {}
    return ($partes -join " ")
}

function Fila-EstaMuerta($fila) {
    $texto = (Texto-Fila $fila).ToUpperInvariant()
    $tokens = $texto -replace ",", " " -split '\s+'
    foreach ($t in $tokens) {
        if ($ESTADOS_LINEA_MUERTA -contains $t) { return $true }
    }
    return $false
}

function Referencia-DeFila($fila) {
    try { return (TextoElemento $fila).Trim() } catch { return "" }
}

function Filas-QueMencionan($ventana, [string]$referencia) {
    $referencia = $referencia.Trim()
    $items = Descendientes $ventana $TC::ListItem
    return @($items | Where-Object { (Referencia-DeFila $_) -eq $referencia })
}

function Punto-SeguroVentana($ventana) {
    $r = RectanguloElemento $ventana
    return Centro $r
}

# Devuelve @{ Fila = <elemento o $null>; HuboMuerta = <bool> }
function Buscar-FilaVivaConScroll($ventana, [string]$referencia) {
    $huboMuerta = $false

    $revisarVisibles = {
        foreach ($f in (Filas-QueMencionan $ventana $referencia)) {
            if (Fila-EstaMuerta $f) { $huboMuerta = $true } else { return $f }
        }
        return $null
    }

    $fila = . $revisarVisibles
    if ($fila) { return @{ Fila = $fila; HuboMuerta = $false } }

    $punto = Punto-SeguroVentana $ventana

    for ($i = 0; $i -lt $MAX_SCROLLS_RESET; $i++) {
        Scroll-At $punto.X $punto.Y 3
        Start-Sleep -Milliseconds 10
    }
    Start-Sleep -Milliseconds 300

    $fila = . $revisarVisibles
    if ($fila) { return @{ Fila = $fila; HuboMuerta = $false } }

    for ($i = 0; $i -lt $MAX_SCROLLS_BUSQUEDA; $i++) {
        Scroll-At $punto.X $punto.Y -3
        Start-Sleep -Milliseconds 300
        $fila = . $revisarVisibles
        if ($fila) { return @{ Fila = $fila; HuboMuerta = $false } }
    }

    return @{ Fila = $null; HuboMuerta = $huboMuerta }
}

# ---------------- dialogo de ubicacion ----------------

function Columnas-Donde($ventana) {
    $items = Descendientes $ventana $TC::HeaderItem
    $filtradas = @($items | Where-Object { (TextoElemento $_).Trim() -eq "Donde" })
    return @($filtradas | Sort-Object { (RectanguloElemento $_).X })
}

function Abrir-DialogoUbicacion($ventana, [string]$referencia) {
    $resultado = Buscar-FilaVivaConScroll $ventana $referencia
    if (-not $resultado.Fila) {
        if ($resultado.HuboMuerta) {
            throw [RevisionManualException]::new("La referencia $referencia solo tiene lineas Anulada(s)/Retirada(s)/Saldada(s) en este pedido, sin ninguna linea viva donde ubicar -- revisar manualmente")
        }
        throw "No se encuentra la referencia $referencia en el pedido abierto"
    }
    $fila = $resultado.Fila

    $columnas = Columnas-Donde $ventana
    if ($columnas.Count -eq 0) { throw "No se encuentra ninguna columna 'Donde' en la rejilla del pedido" }
    if ($INDICE_COLUMNA_DONDE -ge $columnas.Count) {
        throw "INDICE_COLUMNA_DONDE=$INDICE_COLUMNA_DONDE fuera de rango ($($columnas.Count) columnas 'Donde' encontradas)"
    }
    $columnaDonde = $columnas[$INDICE_COLUMNA_DONDE]

    $rectFila = RectanguloElemento $fila
    $rectCol = RectanguloElemento $columnaDonde
    $puntoClic = @{ X = $rectCol.X + ($rectCol.Width / 2); Y = $rectFila.Y + ($rectFila.Height / 2) }

    DoubleClick-At $puntoClic.X $puntoClic.Y

    $botonAceptar = Esperar-Boton $ventana "Aceptar" 5
    if (-not $botonAceptar) { throw "No aparecio el dialogo de ubicacion (boton 'Aceptar' no encontrado) tras el doble clic" }
}

function Campo-CantidadRecepcionada($ventana) {
    $campos = Descendientes $ventana $TC::Edit
    foreach ($c in $campos) {
        if ((TextoElemento $c).Trim() -eq "Cantidad recepcionada") { return $c }
    }
    return $null
}

function Parsear-DecimalEs([string]$texto) {
    return [double]::Parse($texto.Trim().Replace(".", "").Replace(",", "."), [System.Globalization.CultureInfo]::InvariantCulture)
}

function Formatear-DecimalEs([double]$numero) {
    return $numero.ToString("F2", [System.Globalization.CultureInfo]::InvariantCulture).Replace(".", ",")
}

function Incrementar-CantidadRecepcionada($ventana, [double]$cantidadNueva) {
    $campo = Campo-CantidadRecepcionada $ventana
    if (-not $campo) { throw "No se encuentra el campo 'Cantidad recepcionada' en el dialogo" }
    $valorActual = 0.0
    try { $valorActual = Parsear-DecimalEs ([UiaHelper]::GetValue($campo)) } catch {}
    $nuevoTotal = $valorActual + $cantidadNueva

    $r = RectanguloElemento $campo
    $c = Centro $r
    Click-At $c.X $c.Y
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait((Formatear-DecimalEs $nuevoTotal) + "{TAB}")
}

$PATRON_CANTILEVER_PLATAFORMA = "^X\d{3}[A-Z]$"

function Es-DireccionPlataformaReal([string]$direccion) {
    $direccion = $direccion.Trim().ToUpperInvariant()
    if (-not $direccion) { return $false }
    if ($direccion -match '^\d+$') { return $true }
    return ($direccion -match $PATRON_CANTILEVER_PLATAFORMA)
}

function Direccion-DeFila($fila) {
    $texto = (TextoElemento $fila).ToUpperInvariant()
    $candidatos = @($texto -split '\s+' | Where-Object { $_ -and ($_ -notmatch ',') })
    if ($candidatos.Count -gt 0) { return $candidatos[0] }
    return $null
}

function Clasificar-FilasExistentes($filasLlenas) {
    $filaTransitoria = $null
    foreach ($fila in $filasLlenas) {
        $direccion = Direccion-DeFila $fila
        if (-not $direccion) { continue }
        if (Es-DireccionPlataformaReal $direccion) { return @{ DireccionPlataforma = $direccion; FilaTransitoria = $null } }
        if (-not $filaTransitoria) { $filaTransitoria = $fila }
    }
    return @{ DireccionPlataforma = $null; FilaTransitoria = $filaTransitoria }
}

# Devuelve el boton Aceptar SIN pulsarlo -- el llamante decide confirmar o cancelar.
function Rellenar-DialogoUbicacion($ventana, [string]$direccion, [string]$cantidad) {
    $headerObjetivo = $null
    $headers = Descendientes $ventana $TC::Header
    foreach ($h in $headers) {
        $hijos = @(HijosDirectos $h $TC::HeaderItem)
        $items = @($hijos | ForEach-Object { (TextoElemento $_).Trim() })
        if ($items.Count -eq 2 -and $items[0] -eq "Dirección" -and $items[1] -eq "Cantidad ubicada") { $headerObjetivo = $h; break }
    }
    if (-not $headerObjetivo) { throw "No se encuentra la lista 'Direccion/Cantidad ubicada' en el dialogo" }

    # El padre de la cabecera es el contenedor de la lista (filas ListItem
    # hermanas de la cabecera) -- mismo patron que header.parent() en Python.
    $listaContenedor = [UiaHelper]::GetParent($headerObjetivo)
    if (-not $listaContenedor) { throw "No se encuentra el contenedor de la lista de ubicaciones" }

    # Hijos DIRECTOS del contenedor (igual que lista.children() en Python) --
    # NO todos los descendientes, para no colar filas de otra parte del dialogo.
    $todasFilas = @(HijosDirectos $listaContenedor $TC::ListItem)
    if ($todasFilas.Count -eq 0) { throw "La lista de ubicaciones del dialogo no tiene ninguna fila (ni vacia)" }

    $filasLlenas = @($todasFilas | Where-Object { (Direccion-DeFila $_) -ne $null })
    $filasVacias = @($todasFilas | Where-Object { (Direccion-DeFila $_) -eq $null })

    $clasificacion = Clasificar-FilasExistentes $filasLlenas
    if ($clasificacion.DireccionPlataforma) {
        throw [RevisionManualException]::new("Ya existe la ubicacion de plataforma '$($clasificacion.DireccionPlataforma)' para esta referencia -- posible mercancia duplicada, queda pendiente de revision manual")
    }

    $hijosHeader = @(HijosDirectos $headerObjetivo $TC::HeaderItem)
    $rectDireccionCol = RectanguloElemento $hijosHeader[0]
    $rectCantidadCol = RectanguloElemento $hijosHeader[1]
    $xDireccion = $rectDireccionCol.X + ($rectDireccionCol.Width / 2)
    $xCantidad = $rectCantidadCol.X + ($rectCantidadCol.Width / 2)

    if ($clasificacion.FilaTransitoria) {
        $filaObjetivo = $clasificacion.FilaTransitoria
    } else {
        if ($filasVacias.Count -eq 0) {
            throw "No hay ninguna fila vacia en el dialogo de ubicacion para anadir la nueva direccion (todas las filas existentes ya tienen una direccion propia) -- revisar manualmente"
        }
        Incrementar-CantidadRecepcionada $ventana ([double]$cantidad)
        $filaObjetivo = $filasVacias[$filasVacias.Count - 1]
    }

    $rectFila = RectanguloElemento $filaObjetivo
    $yFila = $rectFila.Y + ($rectFila.Height / 2)

    DoubleClick-At $xDireccion $yFila
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait("$direccion{TAB}")

    DoubleClick-At $xCantidad $yFila
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait("$cantidad{TAB}")

    $botonAceptar = Esperar-Boton $ventana "Aceptar" 5
    if (-not $botonAceptar) { throw "El boton 'Aceptar' desaparecio tras rellenar los campos" }
    return $botonAceptar
}

function Cancelar-Dialogo($ventana) {
    $botonCancelar = Encontrar-Boton $ventana "Cancelar"
    if ($botonCancelar) { Click-Boton $botonCancelar }
}

function Guardar-Pedido($ventana) {
    $boton = $null
    foreach ($texto in @("Registrar", "Guardar", "Grabar")) {
        $boton = Encontrar-Boton $ventana $texto
        if ($boton) { break }
    }
    if ($boton) {
        Click-Boton $boton
    } else {
        [Win32Mouse]::SetForegroundWindow([UiaHelper]::GetNativeWindowHandle($ventana)) | Out-Null
        [System.Windows.Forms.SendKeys]::SendWait("^s")
    }
    Start-Sleep -Milliseconds 1200
    Aceptar-DialogosEmergentes $ventana
}

function Recuperar-Pantalla($ventana) {
    foreach ($texto in @("Cancelar", "Aceptar")) {
        try {
            $boton = Encontrar-Boton $ventana $texto
            if ($boton) { Click-Boton $boton; Start-Sleep -Milliseconds 1000; return }
        } catch {}
    }
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
    Start-Sleep -Milliseconds 500
}

function Ubicar-Referencia($ventana, [string]$numeroPedido, [string]$referencia, [string]$direccion, [string]$cantidad, [bool]$simular) {
    Abrir-Pedido $ventana $numeroPedido
    Abrir-DialogoUbicacion $ventana $referencia
    $botonAceptar = Rellenar-DialogoUbicacion $ventana $direccion $cantidad

    if ($simular) {
        Write-Host "  [SIMULACION] pedido=$numeroPedido referencia=$referencia direccion=$direccion cantidad=$cantidad -> NO se pulsa Aceptar, se cancela el dialogo" -ForegroundColor DarkYellow
        Cancelar-Dialogo $ventana
        return
    }

    Click-Boton $botonAceptar
    Start-Sleep -Milliseconds 600
}

# ============================================================
# DATOS INCRUSTADOS (generados por la app en el momento de la descarga)
# ============================================================
$pendientesJson = @'
__PENDIENTES_JSON__
'@
# OJO: ConvertFrom-Json sobre un array JSON VACIO "[]" devuelve $null (no un
# array vacio) en Windows PowerShell 5.1 -- envolver ese $null en @(...)
# daria un array de 1 elemento ($null), no de 0. Se comprueba $null aparte
# antes de envolver, para que $pendientes.Count sea 0 de verdad si no hay nada.
$pendientesCrudo = $pendientesJson | ConvertFrom-Json
if ($null -eq $pendientesCrudo) { $pendientes = @() } else { $pendientes = @($pendientesCrudo) }

# ============================================================
# EJECUCION
# ============================================================

if ($pendientes.Count -eq 0) {
    Write-Host "No hay lineas pendientes de volcar a Pyxis." -ForegroundColor Yellow
    Read-Host "Pulsa ENTER para salir"
    exit
}

Write-Host ("Lineas pendientes: {0}" -f $pendientes.Count) -ForegroundColor Cyan
Write-Host ""
if ($Simular) {
    Write-Host "MODO SIMULACION: se navega Pyxis pero no se confirma ni se guarda nada." -ForegroundColor DarkYellow
    Write-Host ""
}
Write-Host "Deja Pyxis abierto y no toques el raton ni el teclado mientras corre (el robot busca el pedido el solo)." -ForegroundColor Yellow
for ($restante = $SEGUNDOS_PREPARACION; $restante -gt 0; $restante--) {
    Write-Host ("  Empezando en {0}..." -f $restante)
    Start-Sleep -Seconds 1
}
Write-Host ""

$resultados = New-Object System.Collections.ArrayList
$exitosPedido = 0

for ($indice = 0; $indice -lt $pendientes.Count; $indice++) {
    $linea = $pendientes[$indice]
    $ventana = Conectar-Pyxis $linea.tienda
    $idPedido = TextoLimpio $linea.idPedido
    $referencia = TextoLimpio $linea.referencia
    $ubicacion = TextoLimpio $linea.ubicacion
    $cantidad = TextoLimpio $linea.cantidad

    Write-Host "Procesando pedido=$idPedido referencia=$referencia cantidad=$cantidad direccion=$ubicacion"

    $ok = $true
    try {
        Ubicar-Referencia $ventana $idPedido $referencia $ubicacion $cantidad $Simular.IsPresent
    } catch [RevisionManualException] {
        $ok = $false
        Write-Host ("  PENDIENTE DE REVISION: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow
        [void]$resultados.Add(@{ id = $linea.id; estado = $ESTADO_REVISION; mensaje = $_.Exception.Message })
        Recuperar-Pantalla $ventana
    } catch {
        $ok = $false
        Write-Host ("  ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
        [void]$resultados.Add(@{ id = $linea.id; estado = $ESTADO_ERROR; mensaje = $_.Exception.Message })
        Recuperar-Pantalla $ventana
    }

    if ($ok) {
        if ($Simular) {
            Write-Host "  [SIMULACION] no se guarda resultado" -ForegroundColor DarkYellow
        } else {
            [void]$resultados.Add(@{ id = $linea.id; estado = $ESTADO_VOLCADA; mensaje = "" })
            $exitosPedido++
            Write-Host "  OK: volcado en Pyxis" -ForegroundColor Green
        }
    }

    $siguiente = $null
    if ($indice -lt $pendientes.Count - 1) { $siguiente = $pendientes[$indice + 1] }
    $esUltimaDelPedido = (-not $siguiente) -or ([string]$siguiente.idPedido -ne [string]$linea.idPedido) -or ([string]$siguiente.tienda -ne [string]$linea.tienda)
    if ($esUltimaDelPedido) {
        if ($exitosPedido -gt 0 -and -not $Simular) {
            Write-Host "  Registrando pedido $idPedido en Pyxis..."
            Guardar-Pedido $ventana
        }
        $exitosPedido = 0
    }
}

if (-not $Simular -and $resultados.Count -gt 0) {
    $rutaResultados = Join-Path -Path ([System.Environment]::GetFolderPath("Desktop")) -ChildPath "resultados_muelles.json"
    ($resultados | ConvertTo-Json -Depth 5) | Out-File -FilePath $rutaResultados -Encoding utf8
    Write-Host ""
    Write-Host "Resultados guardados en $rutaResultados" -ForegroundColor Cyan
    Write-Host "Pegalos (o selecciona ese archivo) en la pestana Muelles de la app, boton 'Importar resultados'." -ForegroundColor Cyan
}

Write-Host ""
Read-Host "Terminado. Pulsa ENTER para cerrar"
`;

/**
 * Genera el .ps1 completo (con los pendientes de HOY ya incrustados) listo
 * para descargar. Cada llamada usa los pendientes MAS RECIENTES de
 * obtenerMuellesHoy() en ese momento.
 */
function generarScriptRobotMuelles() {
  var pendientes = pendientesMuellesParaRobot();
  var json = JSON.stringify(pendientes);
  return PLANTILLA_ROBOT_MUELLES_PS1.replace("__PENDIENTES_JSON__", json);
}


var PLANTILLA_ROBOT_INVENTARIOS_PS1 = `# ============================================================
# Robot de Inventarios Pyxis -> Drive (LM Malaga)
# Autocontenido: solo PowerShell + Excel + Pyxis, ya instalados en
# cualquier PC de la tienda. Recorre TODAS las ventanas de Pyxis que tengas
# abiertas (una por tienda), saca el "Listado de inventario Pedido Cliente"
# de cada una (direcciones en blanco = todo el inventario), lo guarda en el
# Escritorio como <codigo tienda>.xlsx, lo sube a la app (que lo guarda en
# Drive, sobrescribiendo el anterior) y borra la copia local del Escritorio
# en cuanto la subida termina bien.
#
# Uso: deja Pyxis abierto en la(s) tienda(s) que quieras, en la pantalla de
# inicio (NO en mitad de una venta), y ejecuta este script.
# ============================================================

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class VentanaInfo {
    public IntPtr Handle;
    public string Titulo;
}
public class Win32Mouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    public const int SW_RESTORE = 9;
    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);

    public static List<VentanaInfo> VentanasVisibles() {
        var resultado = new List<VentanaInfo>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            resultado.Add(new VentanaInfo { Handle = hWnd, Titulo = sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return resultado;
    }
}
"@

Add-Type @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("B32A92B5-BC25-4078-9C08-D7EE95C48E03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCacheRequest { }

[ComImport, Guid("4042C624-389C-4AFC-A630-9DF854A541FC"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationTreeWalker
{
    IUIAutomationElement GetParentElement(IUIAutomationElement element);
}

[ComImport, Guid("352FFBA8-0973-437C-A61F-F64CAFD81DF9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCondition { }

[ComImport, Guid("14314595-B4BC-4055-95F2-58F2E42C9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElementArray
{
    int Length { get; }
    IUIAutomationElement GetElement(int index);
}

[ComImport, Guid("A94CD8B1-0844-4CD6-9D2D-640537AB39E9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationValuePattern
{
    void SetValue([MarshalAs(UnmanagedType.BStr)] string val);
    [return: MarshalAs(UnmanagedType.BStr)]
    string get_CurrentValue();
    int get_CurrentIsReadOnly();
}

[ComImport, Guid("D22108AA-8AC5-49A5-837B-37BBB3D7591E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElement
{
    void SetFocus();
    void GetRuntimeId_Unused();
    void FindFirst_Unused();
    IUIAutomationElementArray FindAll(int scope, IUIAutomationCondition condition);
    void FindFirstBuildCache_Unused();
    void FindAllBuildCache_Unused();
    void BuildUpdatedCache_Unused();
    [return: MarshalAs(UnmanagedType.Struct)]
    object GetCurrentPropertyValue(int propertyId);
    void GetCurrentPropertyValueEx_Unused();
    void GetCachedPropertyValue_Unused();
    void GetCachedPropertyValueEx_Unused();
    void GetCurrentPatternAs_Unused();
    void GetCachedPatternAs_Unused();
    [return: MarshalAs(UnmanagedType.IUnknown)]
    object GetCurrentPattern(int patternId);
}

[ComImport, Guid("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomation
{
    void CompareElements_Unused();
    void CompareRuntimeIds_Unused();
    void GetRootElement_Unused();
    IUIAutomationElement ElementFromHandle(IntPtr hwnd);
    void ElementFromPoint_Unused();
    void GetFocusedElement_Unused();
    void GetRootElementBuildCache_Unused();
    void ElementFromHandleBuildCache_Unused();
    void ElementFromPointBuildCache_Unused();
    void GetFocusedElementBuildCache_Unused();
    void CreateTreeWalker_Unused();
    IUIAutomationTreeWalker get_ControlViewWalker();
    IUIAutomationTreeWalker get_ContentViewWalker();
    IUIAutomationTreeWalker get_RawViewWalker();
    IUIAutomationCondition get_RawViewCondition();
    IUIAutomationCondition get_ControlViewCondition();
    IUIAutomationCondition get_ContentViewCondition();
    IUIAutomationCacheRequest CreateCacheRequest();
    IUIAutomationCondition CreateTrueCondition();
    IUIAutomationCondition CreateFalseCondition();
    IUIAutomationCondition CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value);
}

public class UiaElem
{
    internal IUIAutomationElement Inner;
    internal UiaElem(IUIAutomationElement inner) { Inner = inner; }
}

public static class ControlType
{
    public const int Button = 50000;
    public const int Edit = 50004;
    public const int ComboBox = 50003;
    public const int ListItem = 50007;
    public const int TabItem = 50019;
    public const int Text = 50020;
    public const int StatusBar = 50017;
    public const int Header = 50034;
    public const int HeaderItem = 50035;
    public const int Hyperlink = 50005;
}

public static class UiaHelper
{
    public const int Prop_ControlType = 30003;
    public const int Prop_Name = 30005;
    public const int Prop_HelpText = 30013;
    public const int Prop_BoundingRectangle = 30001;
    public const int Prop_NativeWindowHandle = 30020;
    public const int Pattern_Value = 10002;
    public const int Scope_Children = 2;
    public const int Scope_Descendants = 4;

    private static IUIAutomation _auto;
    private static IUIAutomation Auto
    {
        get
        {
            if (_auto == null)
            {
                Type t = Type.GetTypeFromCLSID(new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E"));
                _auto = (IUIAutomation)Activator.CreateInstance(t);
            }
            return _auto;
        }
    }

    public static UiaElem ElementFromHandle(IntPtr hwnd)
    {
        var e = Auto.ElementFromHandle(hwnd);
        return e == null ? null : new UiaElem(e);
    }

    public static string GetName(UiaElem el)
    {
        if (el == null) return "";
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_Name); return v as string ?? ""; }
        catch { return ""; }
    }

    public static int GetControlType(UiaElem el)
    {
        if (el == null) return 0;
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_ControlType); return v is int ? (int)v : 0; }
        catch { return 0; }
    }

    public static string GetHelpText(UiaElem el)
    {
        if (el == null) return "";
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_HelpText); return v as string ?? ""; }
        catch { return ""; }
    }

    public static double[] GetBoundingRect(UiaElem el)
    {
        if (el == null) return new double[] { 0, 0, 0, 0 };
        try
        {
            var v = el.Inner.GetCurrentPropertyValue(Prop_BoundingRectangle);
            if (v is double[] && ((double[])v).Length == 4) return (double[])v;
            return new double[] { 0, 0, 0, 0 };
        }
        catch { return new double[] { 0, 0, 0, 0 }; }
    }

    public static IntPtr GetNativeWindowHandle(UiaElem el)
    {
        if (el == null) return IntPtr.Zero;
        try
        {
            var v = el.Inner.GetCurrentPropertyValue(Prop_NativeWindowHandle);
            if (v is int) return new IntPtr((int)v);
            return IntPtr.Zero;
        }
        catch { return IntPtr.Zero; }
    }

    public static void SetFocus(UiaElem el)
    {
        if (el == null) return;
        try { el.Inner.SetFocus(); } catch { }
    }

    private static IUIAutomationTreeWalker _rawWalker;
    private static IUIAutomationTreeWalker RawWalker
    {
        get
        {
            if (_rawWalker == null) _rawWalker = Auto.get_RawViewWalker();
            return _rawWalker;
        }
    }

    public static UiaElem GetParent(UiaElem el)
    {
        if (el == null) return null;
        try
        {
            var p = RawWalker.GetParentElement(el.Inner);
            return p == null ? null : new UiaElem(p);
        }
        catch { return null; }
    }

    private static UiaElem[] ToArray(IUIAutomationElementArray arr)
    {
        if (arr == null) return new UiaElem[0];
        int n = arr.Length;
        var result = new UiaElem[n];
        for (int i = 0; i < n; i++) result[i] = new UiaElem(arr.GetElement(i));
        return result;
    }

    public static UiaElem[] FindAllChildren(UiaElem el, int controlType)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreatePropertyCondition(Prop_ControlType, controlType);
        return ToArray(el.Inner.FindAll(Scope_Children, cond));
    }

    public static UiaElem[] FindAllDescendants(UiaElem el, int controlType)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreatePropertyCondition(Prop_ControlType, controlType);
        return ToArray(el.Inner.FindAll(Scope_Descendants, cond));
    }

    public static UiaElem[] FindAllChildrenAny(UiaElem el)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreateTrueCondition();
        return ToArray(el.Inner.FindAll(Scope_Children, cond));
    }

    public static UiaElem[] FindAllDescendantsAny(UiaElem el)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreateTrueCondition();
        return ToArray(el.Inner.FindAll(Scope_Descendants, cond));
    }

    public static bool SetValue(UiaElem el, string value)
    {
        if (el == null) return false;
        try
        {
            object pattern = el.Inner.GetCurrentPattern(Pattern_Value);
            if (pattern == null) return false;
            IUIAutomationValuePattern vp = (IUIAutomationValuePattern)pattern;
            vp.SetValue(value);
            return true;
        }
        catch { return false; }
    }

    public static string GetValue(UiaElem el)
    {
        if (el == null) return null;
        try
        {
            object pattern = el.Inner.GetCurrentPattern(Pattern_Value);
            if (pattern == null) return null;
            IUIAutomationValuePattern vp = (IUIAutomationValuePattern)pattern;
            return vp.get_CurrentValue();
        }
        catch { return null; }
    }
}
"@

# ---------------- constantes ----------------
$VENTANA_PYXIS_TITULO_RE = "^Pyxis -.*"
$SEGUNDOS_PREPARACION = 5
$TIMEOUT_GENERACION_SEGUNDOS = 420
$WEBAPP_URL = "__WEBAPP_URL__"
$TOKEN_ROBOT = "__TOKEN__"
$TC = [ControlType]

$CODIGO_POR_TIENDA = @{
    "MALAGA" = "036"
    "MARBELLA" = "014"
    "MIJAS" = "279"
    "GRANADA" = "043"
}

# ---------------- utilidades basicas (mismo patron que el robot de Muelles) ----------------

function Normalizar([string]$texto) {
    $t = ($texto | Out-String).Trim().ToUpperInvariant()
    $normalizado = $t.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $normalizado.ToCharArray()) {
        if ([System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($c)
        }
    }
    return $sb.ToString()
}

function Click-At([double]$x, [double]$y) {
    [Win32Mouse]::SetCursorPos([int]$x, [int]$y) | Out-Null
    Start-Sleep -Milliseconds 80
    [Win32Mouse]::mouse_event([Win32Mouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Win32Mouse]::mouse_event([Win32Mouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Centro($rect) {
    return @{ X = $rect[0] + ($rect[2] / 2); Y = $rect[1] + ($rect[3] / 2) }
}

function Click-Elemento($elemento) {
    $r = [UiaHelper]::GetBoundingRect($elemento)
    $c = Centro $r
    Click-At $c.X $c.Y
}

function TextoBarraEstado($ventana) {
    $barras = [UiaHelper]::FindAllDescendants($ventana, $TC::StatusBar)
    if ($barras.Length -eq 0) { return "" }
    $textos = @()
    $textosCtrl = [UiaHelper]::FindAllDescendants($barras[0], $TC::Text)
    foreach ($t in $textosCtrl) {
        $v = [UiaHelper]::GetName($t)
        if ($v) { $textos += $v }
    }
    return ($textos -join " ")
}

function VentanaUtilizable($ventana) {
    try {
        $r = [UiaHelper]::GetBoundingRect($ventana)
        return ($r[2] -gt 0 -and $r[3] -gt 0)
    } catch { return $false }
}

# Ventanas de Pyxis abiertas AHORA, con su tienda ya detectada (si se pudo).
function ObtenerVentanasPyxis() {
    $candidatas = @([Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match $VENTANA_PYXIS_TITULO_RE })
    $resultado = @()
    foreach ($c in $candidatas) {
        if ([Win32Mouse]::IsIconic($c.Handle)) {
            [Win32Mouse]::ShowWindow($c.Handle, [Win32Mouse]::SW_RESTORE) | Out-Null
            Start-Sleep -Milliseconds 300
        }
        $v = $null
        try { $v = [UiaHelper]::ElementFromHandle($c.Handle) } catch { continue }
        if (-not $v -or -not (VentanaUtilizable $v)) { continue }
        $barra = TextoBarraEstado $v
        $tiendaDetectada = $null
        foreach ($nombreTienda in $CODIGO_POR_TIENDA.Keys) {
            if ((Normalizar $barra) -like "*$nombreTienda*") { $tiendaDetectada = $nombreTienda }
        }
        $resultado += [pscustomobject]@{ Handle = $c.Handle; Elemento = $v; Tienda = $tiendaDetectada; BarraEstado = $barra }
    }
    return $resultado
}

function Encontrar-Hyperlink($ventana, [string]$nombre) {
    $links = [UiaHelper]::FindAllDescendants($ventana, $TC::Hyperlink)
    foreach ($l in $links) {
        if ([UiaHelper]::GetName($l) -eq $nombre) { return $l }
    }
    return $null
}

function Encontrar-Boton($ventana, [string]$texto) {
    $botones = [UiaHelper]::FindAllDescendants($ventana, $TC::Button)
    foreach ($b in $botones) {
        if ([UiaHelper]::GetName($b) -eq $texto) { return $b }
    }
    return $null
}

function Esperar-Boton($ventana, [string]$texto, [int]$timeoutSeg = 8) {
    $transcurrido = 0.0
    while ($transcurrido -lt $timeoutSeg) {
        $b = Encontrar-Boton $ventana $texto
        if ($b) { return $b }
        Start-Sleep -Milliseconds 400
        $transcurrido += 0.4
    }
    return $null
}

# Pulsa el boton "casita" (Inicio) de la barra superior de Pyxis. Es el
# primer boton de la fila de iconos de arriba a la izquierda, a la izquierda
# del carrito. Se busca por nombre y, si Pyxis no le pone nombre util, se
# cae a "el boton mas arriba-izquierda de la ventana", que es el que es.
function Ir-AInicioPyxis($ventanaPyxis) {
    try {
        $botones = [UiaHelper]::FindAllDescendants($ventanaPyxis, $TC::Button)
        if (-not $botones -or $botones.Length -eq 0) { return }

        $casita = $null
        foreach ($b in $botones) {
            $n = Normalizar ([UiaHelper]::GetName($b))
            if ($n -eq "INICIO" -or $n -eq "HOME" -or $n -like "*PANTALLA PRINCIPAL*") { $casita = $b; break }
        }

        if (-not $casita) {
            $rectVentana = [UiaHelper]::GetBoundingRect($ventanaPyxis)
            $limiteY = $rectVentana[1] + 120   # solo la barra de iconos de arriba
            $mejorX = [double]::MaxValue
            foreach ($b in $botones) {
                $r = [UiaHelper]::GetBoundingRect($b)
                if ($r[2] -le 0 -or $r[3] -le 0) { continue }
                if ($r[1] -gt $limiteY) { continue }
                if ($r[0] -lt $mejorX) { $mejorX = $r[0]; $casita = $b }
            }
        }

        if ($casita) { Click-Elemento $casita; Start-Sleep -Milliseconds 900 }
    } catch {}
}

# ---------------- exportar UN inventario ----------------

function Exportar-InventarioTienda($ventanaPyxis, [string]$codigoTienda) {
    # Pyxis puede haber quedado en cualquier pantalla (busqueda de pedido, un
    # acto de venta a medias...) de un uso anterior. El boton "casita" de
    # arriba a la izquierda vuelve SIEMPRE a la pantalla de inicio, que es
    # desde donde se puede entrar a GESTION PEDIDO CLIENTE.
    Ir-AInicioPyxis $ventanaPyxis

    Write-Host "  Navegando a Listado inventario Pedido Cliente..."
    $gestion = Encontrar-Hyperlink $ventanaPyxis "GESTIÓN PEDIDO CLIENTE"
    if (-not $gestion) { throw "No se encuentra 'GESTIÓN PEDIDO CLIENTE' -- ¿Pyxis está en la pantalla de inicio?" }
    Click-Elemento $gestion
    Start-Sleep -Milliseconds 800

    $listado = $null
    $intentos = 0
    while (-not $listado -and $intentos -lt 10) {
        $listado = Encontrar-Hyperlink $ventanaPyxis "Listado inventario Pedido Cliente"
        if (-not $listado) { Start-Sleep -Milliseconds 300; $intentos++ }
    }
    if (-not $listado) { throw "No se encuentra 'Listado inventario Pedido Cliente' tras entrar en Gestión Pedido Cliente" }
    Click-Elemento $listado
    Start-Sleep -Milliseconds 800

    Write-Host "  Confirmando rango (en blanco = todo el inventario)..."
    $aceptar1 = Esperar-Boton $ventanaPyxis "Aceptar" 8
    if (-not $aceptar1) { throw "No aparecio el dialogo 'Listado de inventario Pedido Cliente'" }
    Click-Elemento $aceptar1
    Start-Sleep -Milliseconds 800

    Write-Host "  Confirmando generacion (puede tardar varios minutos)..."
    $aceptar2 = Esperar-Boton $ventanaPyxis "Aceptar" 8
    if (-not $aceptar2) { throw "No aparecio la confirmacion 'va a empezar y puede tardar unos minutos'" }
    Click-Elemento $aceptar2

    Write-Host "  Esperando a que Excel abra el listado generado..."
    $transcurrido = 0
    $ventanaExcel = $null
    while ($transcurrido -lt $TIMEOUT_GENERACION_SEGUNDOS) {
        Start-Sleep -Seconds 5
        $transcurrido += 5
        $candidatas = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match "Listing_CommandeClient" }
        if ($candidatas) { $ventanaExcel = $candidatas[0]; break }
        if ($transcurrido % 30 -eq 0) { Write-Host "    ...siguen esperando ($transcurrido s)" }
    }
    if (-not $ventanaExcel) { throw "Excel no abrio el listado tras $TIMEOUT_GENERACION_SEGUNDOS s" }
    Write-Host "  Excel abierto, guardando como $codigoTienda..."

    [Win32Mouse]::SetForegroundWindow($ventanaExcel.Handle) | Out-Null
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait("{F12}")
    Start-Sleep -Milliseconds 1500

    $dialogoGuardar = $null
    $intentos2 = 0
    while (-not $dialogoGuardar -and $intentos2 -lt 15) {
        $candidatas2 = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -eq "Guardar como" }
        if ($candidatas2) { $dialogoGuardar = $candidatas2[0] } else { Start-Sleep -Milliseconds 400; $intentos2++ }
    }
    if (-not $dialogoGuardar) { throw "No aparecio el dialogo 'Guardar como' tras F12" }

    [Win32Mouse]::SetForegroundWindow($dialogoGuardar.Handle) | Out-Null
    Start-Sleep -Milliseconds 300
    $rootGuardar = [UiaHelper]::ElementFromHandle($dialogoGuardar.Handle)

    # El listado de Pyxis abre en "Libro de Excel 97-2003" (.xls, formato de
    # compatibilidad del propio origen) -- hay que cambiarlo a "Libro de
    # Excel" (.xlsx, la PRIMERA opcion de la lista) antes de guardar, para
    # que quede en el mismo formato que ya usan los inventarios en Drive.
    $comboTipo = $null
    foreach ($c in [UiaHelper]::FindAllDescendants($rootGuardar, $TC::ComboBox)) {
        if ([UiaHelper]::GetName($c) -eq "Tipo:") { $comboTipo = $c }
    }
    if (-not $comboTipo) { throw "No se encuentra el desplegable 'Tipo:' en Guardar como" }
    $rTipo = [UiaHelper]::GetBoundingRect($comboTipo)
    # Clic cerca del extremo derecho (la flecha), no en el centro del texto --
    # confirmado en pruebas reales que ahi es donde se abre la lista.
    Click-At ($rTipo[0] + $rTipo[2] - 15) ($rTipo[1] + $rTipo[3] / 2)
    Start-Sleep -Milliseconds 600
    $opcionXlsx = $null
    foreach ($it in [UiaHelper]::FindAllDescendants($rootGuardar, $TC::ListItem)) {
        if ([UiaHelper]::GetName($it) -eq "Libro de Excel ") { $opcionXlsx = $it }
    }
    if (-not $opcionXlsx) { throw "No se encuentra la opcion 'Libro de Excel' en el desplegable Tipo" }
    Click-Elemento $opcionXlsx
    Start-Sleep -Milliseconds 500

    $campoNombre = $null
    foreach ($e in [UiaHelper]::FindAllDescendants($rootGuardar, $TC::Edit)) {
        if ([UiaHelper]::GetName($e) -eq "Nombre de archivo:") { $campoNombre = $e }
    }
    if (-not $campoNombre) { throw "No se encuentra el campo 'Nombre de archivo:' en Guardar como" }

    # Se escribe la RUTA COMPLETA (no solo el nombre) para que el archivo se
    # guarde directamente en el Escritorio, sea cual sea la carpeta en la que
    # el dialogo haya abierto por defecto.
    $ruta = Join-Path -Path ([Environment]::GetFolderPath("Desktop")) -ChildPath ($codigoTienda + ".xlsx")

    # SetValue (ValuePattern) NO es fiable en este cuadro concreto -- confirmado
    # en pruebas reales (decia OK pero el dialogo seguia con el nombre viejo).
    # Clic + Ctrl+A + escribir SI funciona siempre.
    Click-Elemento $campoNombre
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($ruta)
    Start-Sleep -Milliseconds 300

    $botonGuardar = Encontrar-Boton $rootGuardar "Guardar"
    if (-not $botonGuardar) { throw "No se encuentra el boton 'Guardar'" }
    Click-Elemento $botonGuardar
    Start-Sleep -Milliseconds 1200

    # Si YA existe un archivo previo de esta tienda (ejecucion anterior), Windows
    # pregunta si reemplazar -- se acepta siempre (es justo lo que queremos).
    $candidatasConfirmar = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match "Confirmar Guardar como" }
    if ($candidatasConfirmar) {
        $rootConfirmar = [UiaHelper]::ElementFromHandle($candidatasConfirmar[0].Handle)
        $botonSi = Encontrar-Boton $rootConfirmar "Sí"
        if ($botonSi) { Click-Elemento $botonSi; Start-Sleep -Milliseconds 800 }
    }

    $esperaArchivo = 0
    while (-not (Test-Path $ruta) -and $esperaArchivo -lt 20) { Start-Sleep -Milliseconds 500; $esperaArchivo += 0.5 }
    if (-not (Test-Path $ruta)) { throw "Se guardo pero no se encuentra el archivo en $ruta" }

    Write-Host "  Guardado en $ruta"

    # Cerrar Excel AHORA, antes de devolver la ruta -- si se deja abierto, el
    # archivo queda bloqueado y la subida a Drive falla con "el proceso no
    # puede tener acceso al archivo porque esta siendo utilizado en otro
    # proceso" (confirmado en pruebas reales con las 4 tiendas).
    [uint32]$pidExcel = 0
    [Win32Mouse]::GetWindowThreadProcessId($ventanaExcel.Handle, [ref]$pidExcel) | Out-Null
    if ($pidExcel -gt 0) {
        try { Stop-Process -Id $pidExcel -Force -ErrorAction SilentlyContinue } catch {}
    }

    # Esperar a que el archivo quede realmente libre (el proceso puede tardar
    # un instante en soltar el handle tras Stop-Process).
    $esperaLibre = 0
    $libre = $false
    while (-not $libre -and $esperaLibre -lt 10) {
        try {
            $fs = [System.IO.File]::Open($ruta, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
            $fs.Close()
            $libre = $true
        } catch {
            Start-Sleep -Milliseconds 300
            $esperaLibre += 0.3
        }
    }

    # El dialogo "Listado de inventario Pedido Cliente" se queda abierto de
    # fondo en Pyxis tras generar el listado -- hay que cerrarlo con Cancelar
    # o se van acumulando uno por tienda.
    $cancelar = Encontrar-Boton $ventanaPyxis "Cancelar"
    if ($cancelar) { Click-Elemento $cancelar; Start-Sleep -Milliseconds 600 }

    return $ruta
}

# Sube el inventario abriendo la app YA autenticada en el navegador (Chrome
# -- Edge no vale, no tiene la sesion de Google del dominio en este PC) y
# haciendo clic el propio robot en "Seleccionar archivo". Google exige login
# de Google del dominio para esta app y bloquea a nivel de politica de Adeo
# cualquier despliegue publico/anonimo -- por eso NO se puede subir con un
# simple POST desde PowerShell, hay que pasar por un navegador con sesion
# real. Ver [[lm-malaga-robot-inventarios-navegador]] para el porque completo.
#
# IMPORTANTE: se usa SIEMPRE Start-Process para abrir/enfocar la pagina,
# NUNCA SendKeys de Ctrl+T/Ctrl+L -- confirmado en pruebas reales que
# SetForegroundWindow (incluso con el truco AttachThreadInput) puede fallar
# en silencio si el escritorio esta ocupado (p.ej. llega una notificacion de
# Chat), dejando las pulsaciones "en el aire" sin que lleguen a Chrome.
# Start-Process en cambio pasa la URL al Chrome ya abierto por comunicacion
# entre procesos (no por teclado), y Chrome activa la pestaña nueva el solo
# -- inmune a ese problema.
# Sube TODOS los inventarios ya descargados de una sola vez, en UNA sola
# pestaña (antes se abria una pestaña por tienda). El dialogo "Abrir" de
# Windows admite varios archivos escribiendo sus rutas entre comillas
# separadas por espacios, y la pagina de subida lleva <input multiple> y
# deduce el codigo de tienda del nombre de cada archivo.
function Subir-Inventarios([string[]]$rutasArchivos) {
    $resultado = $null
    for ($intentoGlobal = 1; $intentoGlobal -le 3; $intentoGlobal++) {
        $resultado = Subir-InventariosIntento $rutasArchivos
        if ($resultado.ok) { return $resultado }
        Write-Host "    (intento $intentoGlobal de subida fallido: $($resultado.error))" -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
    return $resultado
}

function Subir-InventariosIntento([string[]]$rutasArchivos) {
    $urlSubida = $WEBAPP_URL + "?vista=subirInventarioRobot"
    Start-Process "chrome.exe" $urlSubida
    Start-Sleep -Seconds 2
    $ventanaChrome = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match "Google Chrome$" } | Select-Object -First 1
    if (-not $ventanaChrome) { return @{ ok = $false; error = "No se encuentra ninguna ventana de Chrome abierta" } }

    # Hasta 30s -- la primera carga de la pagina (login de Google + generar
    # token en el servidor) puede tardar mas que una recarga normal.
    $tituloEsperado = "Robot Inventarios"
    $cargada = $false
    $intentos = 0
    while (-not $cargada -and $intentos -lt 60) {
        $actual = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Handle -eq $ventanaChrome.Handle }
        if ($actual -and $actual[0].Titulo -match [regex]::Escape($tituloEsperado)) { $cargada = $true } else { Start-Sleep -Milliseconds 500; $intentos++ }
    }
    if (-not $cargada) { return @{ ok = $false; error = "La pagina de subida no cargo -- comprueba que Chrome tenga sesion de Google iniciada" } }

    $root = [UiaHelper]::ElementFromHandle($ventanaChrome.Handle)
    $elegir = $null
    $intentosEl = 0
    while (-not $elegir -and $intentosEl -lt 10) {
        foreach ($el in [UiaHelper]::FindAllDescendantsAny($root)) {
            if ([UiaHelper]::GetName($el) -match "ROBOT_SELECCIONAR_ARCHIVO") { $elegir = $el }
        }
        if (-not $elegir) { Start-Sleep -Milliseconds 400; $intentosEl++ }
    }
    if (-not $elegir) { return @{ ok = $false; error = "No se encontro el boton 'Seleccionar archivo' en la pagina" } }
    Click-Elemento $elegir
    Start-Sleep -Milliseconds 1200

    $dialogo = $null
    $intentosD = 0
    while (-not $dialogo -and $intentosD -lt 15) {
        $cands = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -eq "Abrir" }
        if ($cands) { $dialogo = $cands[0] } else { Start-Sleep -Milliseconds 400; $intentosD++ }
    }
    if (-not $dialogo) { return @{ ok = $false; error = "No aparecio el dialogo 'Abrir'" } }
    [Win32Mouse]::SetForegroundWindow($dialogo.Handle) | Out-Null
    Start-Sleep -Milliseconds 300
    $rootDialogo = [UiaHelper]::ElementFromHandle($dialogo.Handle)
    $campoNombre = $null
    foreach ($e in [UiaHelper]::FindAllDescendants($rootDialogo, $TC::Edit)) {
        $n = [UiaHelper]::GetName($e)
        if ($n -eq "Nombre de archivo:" -or $n -eq "Nombre:") { $campoNombre = $e }
    }
    if (-not $campoNombre) { return @{ ok = $false; error = "No se encontro el campo de nombre en 'Abrir'" } }

    # Varios archivos a la vez: "ruta1" "ruta2" "ruta3" (comillas obligatorias).
    $textoRutas = ($rutasArchivos | ForEach-Object { '"' + $_ + '"' }) -join ' '
    Click-Elemento $campoNombre
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($textoRutas)
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

    # El resultado se lee del TEXTO de la pagina, NO del titulo de la
    # pestaña: la pagina vive en el iframe aislado de Apps Script y ahi
    # document.title no llega al navegador (por eso antes siempre daba
    # timeout y reintentaba subir lo mismo una y otra vez).
    $resultado = $null
    $intentosR = 0
    $maxEspera = 40 + ($rutasArchivos.Count * 30)
    while (-not $resultado -and $intentosR -lt $maxEspera) {
        try {
            $rootAhora = [UiaHelper]::ElementFromHandle($ventanaChrome.Handle)
            foreach ($t in [UiaHelper]::FindAllDescendants($rootAhora, $TC::Text)) {
                $txt = [UiaHelper]::GetName($t)
                if ($txt -match "ROBOT_FIN_OK:(\d+)/(\d+)") { $resultado = @{ ok = $true; subidos = [int]$Matches[1]; total = [int]$Matches[2] }; break }
                if ($txt -match "ROBOT_FIN_ERROR:\s*(.+)$") { $resultado = @{ ok = $false; error = $Matches[1] }; break }
            }
        } catch {}
        if (-not $resultado) { Start-Sleep -Milliseconds 500; $intentosR++ }
    }
    if (-not $resultado) { $resultado = @{ ok = $false; error = "Tiempo de espera agotado subiendo los archivos" } }

    Cerrar-PestanaSubida $ventanaChrome.Handle
    return $resultado
}

# Cierra la pestaña de subida clicando su propia "x" -- no se usa Ctrl+W
# porque depende de SetForegroundWindow, que no es fiable aqui (mismo motivo
# por el que la apertura usa Start-Process). Si no se cierra, se van
# acumulando pestañas "Robot Inventarios" en cada ejecucion.
function Cerrar-PestanaSubida([IntPtr]$handleChrome) {
    try {
        $root = [UiaHelper]::ElementFromHandle($handleChrome)
        foreach ($tab in [UiaHelper]::FindAllDescendants($root, $TC::TabItem)) {
            if ([UiaHelper]::GetName($tab) -notmatch "Robot Inventarios") { continue }
            foreach ($btn in [UiaHelper]::FindAllDescendants($tab, $TC::Button)) {
                if ([UiaHelper]::GetName($btn) -eq "Cerrar") { Click-Elemento $btn; Start-Sleep -Milliseconds 500; return }
            }
        }
    } catch {}
}

# ============================================================
# EJECUCION
# ============================================================
Write-Host "Buscando ventanas de Pyxis abiertas..." -ForegroundColor Cyan
for ($restante = $SEGUNDOS_PREPARACION; $restante -gt 0; $restante--) {
    Write-Host "  Empezando en $restante..."
    Start-Sleep -Seconds 1
}

$ventanas = ObtenerVentanasPyxis
if ($ventanas.Count -eq 0) {
    Write-Host "No se encuentra ninguna ventana de Pyxis abierta." -ForegroundColor Yellow
    Read-Host "Pulsa ENTER para salir"
    exit
}

Write-Host "Ventanas encontradas: $($ventanas.Count)"
foreach ($v in $ventanas) { Write-Host "  - $($v.Tienda) ($($v.BarraEstado))" }
Write-Host ""

# FASE 1: sacar el inventario de cada tienda al Escritorio (sin subir nada
# todavia). FASE 2, al final: subir los que se hayan podido sacar, TODOS de
# una vez en una sola pestaña del navegador.
$resultados = @()
$descargados = @()
foreach ($v in $ventanas) {
    if (-not $v.Tienda) {
        Write-Host "SALTANDO ventana (no se pudo identificar la tienda): $($v.BarraEstado)" -ForegroundColor Yellow
        continue
    }
    $codigo = $CODIGO_POR_TIENDA[$v.Tienda]
    Write-Host "=== $($v.Tienda) ($codigo) ===" -ForegroundColor Cyan
    try {
        [Win32Mouse]::SetForegroundWindow($v.Handle) | Out-Null
        Start-Sleep -Milliseconds 500
        $ruta = Exportar-InventarioTienda $v.Elemento $codigo
        $descargados += [pscustomobject]@{ Tienda = $v.Tienda; Codigo = $codigo; Ruta = $ruta }
    } catch {
        Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $resultados += [pscustomobject]@{ Tienda = $v.Tienda; Ok = $false; Detalle = $_.Exception.Message }
    }
    Write-Host ""
}

if ($descargados.Count -gt 0) {
    Write-Host "=== SUBIENDO $($descargados.Count) INVENTARIO(S) A DRIVE ===" -ForegroundColor Cyan
    $r = Subir-Inventarios ($descargados | ForEach-Object { $_.Ruta })
    if ($r.ok) {
        Write-Host "  OK: $($r.subidos)/$($r.total) subidos" -ForegroundColor Green
        foreach ($d in $descargados) {
            $resultados += [pscustomobject]@{ Tienda = $d.Tienda; Ok = $true; Detalle = "$($d.Codigo).xlsx subido" }
            # Ya esta en Drive -- se borra la copia local del Escritorio.
            Remove-Item -Path $d.Ruta -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host "  ERROR al subir: $($r.error)" -ForegroundColor Red
        foreach ($d in $descargados) {
            $resultados += [pscustomobject]@{ Tienda = $d.Tienda; Ok = $false; Detalle = $r.error }
        }
    }
    Write-Host ""
}

Write-Host "=== RESUMEN ===" -ForegroundColor Cyan
foreach ($r in $resultados) {
    $color = if ($r.Ok) { "Green" } else { "Red" }
    Write-Host ("  {0}: {1}" -f $r.Tienda, $r.Detalle) -ForegroundColor $color
}
Read-Host "Terminado. Pulsa ENTER para cerrar"
`;

/**
 * Genera el script del robot de inventarios con la URL de esta app y el
 * token de autenticacion ya incrustados (mismo patron que
 * generarScriptRobotMuelles con los pendientes).
 */
function generarScriptRobotInventarios() {
  var url = ScriptApp.getService().getUrl();
  var token = getOCrearTokenRobotInventario();
  return PLANTILLA_ROBOT_INVENTARIOS_PS1
    .replace('__WEBAPP_URL__', url)
    .replace('__TOKEN__', token);
}

// Cola de ejecucion en bucle, pensada para un PC AISLADO sin supervision
// (p.ej. dedicado solo a mantener Pyxis abierto y subir inventarios). Sustituye
// el bloque final "EJECUCION" (una sola pasada + Read-Host de pausa) de
// PLANTILLA_ROBOT_INVENTARIOS_PS1 -- todo lo de ARRIBA (Add-Type, funciones
// Exportar-InventarioTienda/Subir-Inventarios/etc.) se reutiliza tal cual,
// para no duplicar logica ya probada. Dos anadidos sobre la version normal:
//   1) Anti-suspension real via SetThreadExecutionState (Win32) -- NO
//      simula pulsaciones de teclado (por eso mismo nos dieron problemas
//      SendKeys/SetForegroundWindow en este mismo robot, ver memoria del
//      proyecto): esto le dice a Windows "no dejes de darme CPU/pantalla"
//      sin tocar nada del escritorio, asi que no puede interferir con
//      Pyxis ni con la pestana de Chrome a medio subir.
//   2) Bucle infinito cada $INTERVALO_MINUTOS, con log a fichero (nadie va
//      a estar mirando la consola) y try/catch por ciclo para que un fallo
//      puntual (Pyxis cerrado, ventana no encontrada) no tumbe el bucle
//      entero -- se registra y se reintenta en el siguiente ciclo.
var BLOQUE_EJECUCION_BUCLE_INVENTARIOS_PS1 = `# ============================================================
# EJECUCION EN BUCLE (PC aislado, sin supervision)
# ============================================================
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Energia {
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002;
}
"@
# Mientras este proceso viva, el PC no se suspende ni apaga pantalla -- sin
# tocar teclado/raton, asi que nunca interfiere con Pyxis ni con Chrome.
[Energia]::SetThreadExecutionState([Energia]::ES_CONTINUOUS -bor [Energia]::ES_SYSTEM_REQUIRED -bor [Energia]::ES_DISPLAY_REQUIRED) | Out-Null

$INTERVALO_MINUTOS = 30
$rutaLog = Join-Path $env:USERPROFILE "Desktop\\robot_inventarios_bucle.log"

function Escribir-Log([string]$texto) {
    $linea = "[{0}] {1}" -f (Get-Date -Format "dd/MM/yyyy HH:mm:ss"), $texto
    Write-Host $linea
    Add-Content -Path $rutaLog -Value $linea -Encoding UTF8
}

function Ejecutar-CicloInventario {
    $ventanas = ObtenerVentanasPyxis
    if ($ventanas.Count -eq 0) {
        Escribir-Log "Sin ventanas de Pyxis abiertas -- se salta este ciclo."
        return
    }
    Escribir-Log ("Ventanas encontradas: {0} ({1})" -f $ventanas.Count, (($ventanas | ForEach-Object { $_.Tienda }) -join ", "))

    $resultados = @()
    $descargados = @()
    foreach ($v in $ventanas) {
        if (-not $v.Tienda) {
            Escribir-Log "SALTANDO ventana (no se pudo identificar la tienda): $($v.BarraEstado)"
            continue
        }
        $codigo = $CODIGO_POR_TIENDA[$v.Tienda]
        try {
            [Win32Mouse]::SetForegroundWindow($v.Handle) | Out-Null
            Start-Sleep -Milliseconds 500
            $ruta = Exportar-InventarioTienda $v.Elemento $codigo
            $descargados += [pscustomobject]@{ Tienda = $v.Tienda; Codigo = $codigo; Ruta = $ruta }
            Escribir-Log "  $($v.Tienda) ($codigo): exportado OK"
        } catch {
            Escribir-Log "  $($v.Tienda) ($codigo): ERROR exportando -- $($_.Exception.Message)"
            $resultados += [pscustomobject]@{ Tienda = $v.Tienda; Ok = $false; Detalle = $_.Exception.Message }
        }
    }

    if ($descargados.Count -gt 0) {
        try {
            $r = Subir-Inventarios ($descargados | ForEach-Object { $_.Ruta })
            if ($r.ok) {
                Escribir-Log "Subida OK: $($r.subidos)/$($r.total)"
                foreach ($d in $descargados) {
                    $resultados += [pscustomobject]@{ Tienda = $d.Tienda; Ok = $true; Detalle = "$($d.Codigo).xlsx subido" }
                    Remove-Item -Path $d.Ruta -Force -ErrorAction SilentlyContinue
                }
            } else {
                Escribir-Log "ERROR al subir: $($r.error)"
                foreach ($d in $descargados) {
                    $resultados += [pscustomobject]@{ Tienda = $d.Tienda; Ok = $false; Detalle = $r.error }
                }
            }
        } catch {
            Escribir-Log "EXCEPCION subiendo: $($_.Exception.Message)"
        }
    }

    foreach ($r in $resultados) { Escribir-Log ("  Resumen: {0} -> {1}" -f $r.Tienda, $r.Detalle) }
}

Escribir-Log "=== Robot de inventarios en bucle iniciado (cada $INTERVALO_MINUTOS min, anti-suspension activa) ==="
while ($true) {
    try {
        Escribir-Log "--- Nuevo ciclo ---"
        Ejecutar-CicloInventario
    } catch {
        Escribir-Log "EXCEPCION no controlada en el ciclo: $($_.Exception.Message)"
    }
    Escribir-Log "Ciclo terminado. Esperando $INTERVALO_MINUTOS minutos..."
    Start-Sleep -Seconds ($INTERVALO_MINUTOS * 60)
}
`;

/**
 * Igual que generarScriptRobotInventarios(), pero para ejecucion desatendida
 * en un PC aislado: sustituye el bloque final "EJECUCION" (una pasada +
 * pausa Read-Host) por BLOQUE_EJECUCION_BUCLE_INVENTARIOS_PS1 (bucle cada 30
 * min + anti-suspension + log a fichero). Todo lo anterior (Add-Type,
 * funciones Exportar-InventarioTienda/Subir-Inventarios/etc.) es el MISMO
 * texto que la version normal -- una sola fuente de verdad para la parte de
 * automatizacion, solo cambia el driver de ejecucion.
 */
function generarScriptRobotInventariosBucle() {
  var marcador = '# ============================================================\n# EJECUCION\n# ============================================================';
  var idx = PLANTILLA_ROBOT_INVENTARIOS_PS1.indexOf(marcador);
  if (idx < 0) throw new Error('No se encontró el marcador de EJECUCION en PLANTILLA_ROBOT_INVENTARIOS_PS1 -- revisa que no haya cambiado el texto.');
  var url = ScriptApp.getService().getUrl();
  var token = getOCrearTokenRobotInventario();
  var cuerpo = PLANTILLA_ROBOT_INVENTARIOS_PS1.substring(0, idx);
  return (cuerpo + BLOQUE_EJECUCION_BUCLE_INVENTARIOS_PS1)
    .replace('__WEBAPP_URL__', url)
    .replace('__TOKEN__', token);
}



/**
 * Variante del robot de inventarios para LibreOffice Calc en vez de Excel.
 * Copia independiente de PLANTILLA_ROBOT_INVENTARIOS_PS1 -- no comparte texto
 * con ella a proposito, para no arriesgar nada de la version Excel ya probada
 * (ver docs/superpowers/specs/2026-08-06-robot-inventarios-libreoffice-design.md).
 * Unico cambio funcional: el paso de "Guardar como" dentro de
 * Exportar-InventarioTienda -- atajo Ctrl+Mayus+S en vez de F12, deteccion
 * best-effort del dialogo de "mantener formato Excel" si aparece, seleccion
 * del tipo por texto "Excel 2007-365" (no por posicion fija en la lista).
 * Todo lo demas es identico a la version Excel. Solo una pasada (sin bucle).
 * Se genera A MANO desde el editor, sin boton en la app -- decision explicita
 * del usuario, igual que generarScriptRobotInventariosBucle().
 */
var PREFIJO_DESCARTAR_RECUPERACION_LIBREOFFICE = `
# Si LibreOffice se cerro alguna vez de forma no limpia, la SIGUIENTE vez
# que se abre un documento puede mostrar un dialogo de "Recuperacion de
# documentos" tapando la ventana -- se descarta si aparece (best-effort,
# hasta 5 intentos por si es un asistente de varios pasos).
function Descartar-RecuperacionLibreOffice {
    try {
        $intentos = 0
        while ($intentos -lt 5) {
            $vRec = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match "[Rr]ecuperaci|[Rr]ecovery" } | Select-Object -First 1
            if (-not $vRec) { return }
            $rootRec = [UiaHelper]::ElementFromHandle($vRec.Handle)
            $boton = $null
            foreach ($b in [UiaHelper]::FindAllDescendants($rootRec, $TC::Button)) {
                $nb = [UiaHelper]::GetName($b)
                if ($nb -match "Descartar|Discard|Cancelar") { $boton = $b; break }
            }
            if (-not $boton) {
                foreach ($b in [UiaHelper]::FindAllDescendants($rootRec, $TC::Button)) {
                    $nb = [UiaHelper]::GetName($b)
                    if ($nb -match "Aceptar|OK|Cerrar|Close") { $boton = $b; break }
                }
            }
            if (-not $boton) { return }
            Click-Elemento $boton
            Start-Sleep -Milliseconds 600
            $intentos++
        }
    } catch {}
}
`;

var PLANTILLA_ROBOT_INVENTARIOS_LIBREOFFICE_PS1 = `# ============================================================
# Robot de Inventarios Pyxis -> Drive (LM Malaga) -- variante LibreOffice
# Autocontenido: solo PowerShell + Excel + Pyxis, ya instalados en
# cualquier PC de la tienda. Recorre TODAS las ventanas de Pyxis que tengas
# abiertas (una por tienda), saca el "Listado de inventario Pedido Cliente"
# de cada una (direcciones en blanco = todo el inventario), lo guarda en el
# Escritorio como <codigo tienda>.xlsx, lo sube a la app (que lo guarda en
# Drive, sobrescribiendo el anterior) y borra la copia local del Escritorio
# en cuanto la subida termina bien.
#
# Uso: deja Pyxis abierto en la(s) tienda(s) que quieras, en la pantalla de
# inicio (NO en mitad de una venta), y ejecuta este script.
# ============================================================

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class VentanaInfo {
    public IntPtr Handle;
    public string Titulo;
}
public class Win32Mouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    public const int SW_RESTORE = 9;
    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);

    public static List<VentanaInfo> VentanasVisibles() {
        var resultado = new List<VentanaInfo>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            resultado.Add(new VentanaInfo { Handle = hWnd, Titulo = sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return resultado;
    }
}
"@

Add-Type @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("B32A92B5-BC25-4078-9C08-D7EE95C48E03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCacheRequest { }

[ComImport, Guid("4042C624-389C-4AFC-A630-9DF854A541FC"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationTreeWalker
{
    IUIAutomationElement GetParentElement(IUIAutomationElement element);
}

[ComImport, Guid("352FFBA8-0973-437C-A61F-F64CAFD81DF9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationCondition { }

[ComImport, Guid("14314595-B4BC-4055-95F2-58F2E42C9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElementArray
{
    int Length { get; }
    IUIAutomationElement GetElement(int index);
}

[ComImport, Guid("A94CD8B1-0844-4CD6-9D2D-640537AB39E9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationValuePattern
{
    void SetValue([MarshalAs(UnmanagedType.BStr)] string val);
    [return: MarshalAs(UnmanagedType.BStr)]
    string get_CurrentValue();
    int get_CurrentIsReadOnly();
}

[ComImport, Guid("D22108AA-8AC5-49A5-837B-37BBB3D7591E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationElement
{
    void SetFocus();
    void GetRuntimeId_Unused();
    void FindFirst_Unused();
    IUIAutomationElementArray FindAll(int scope, IUIAutomationCondition condition);
    void FindFirstBuildCache_Unused();
    void FindAllBuildCache_Unused();
    void BuildUpdatedCache_Unused();
    [return: MarshalAs(UnmanagedType.Struct)]
    object GetCurrentPropertyValue(int propertyId);
    void GetCurrentPropertyValueEx_Unused();
    void GetCachedPropertyValue_Unused();
    void GetCachedPropertyValueEx_Unused();
    void GetCurrentPatternAs_Unused();
    void GetCachedPatternAs_Unused();
    [return: MarshalAs(UnmanagedType.IUnknown)]
    object GetCurrentPattern(int patternId);
}

[ComImport, Guid("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomation
{
    void CompareElements_Unused();
    void CompareRuntimeIds_Unused();
    void GetRootElement_Unused();
    IUIAutomationElement ElementFromHandle(IntPtr hwnd);
    void ElementFromPoint_Unused();
    void GetFocusedElement_Unused();
    void GetRootElementBuildCache_Unused();
    void ElementFromHandleBuildCache_Unused();
    void ElementFromPointBuildCache_Unused();
    void GetFocusedElementBuildCache_Unused();
    void CreateTreeWalker_Unused();
    IUIAutomationTreeWalker get_ControlViewWalker();
    IUIAutomationTreeWalker get_ContentViewWalker();
    IUIAutomationTreeWalker get_RawViewWalker();
    IUIAutomationCondition get_RawViewCondition();
    IUIAutomationCondition get_ControlViewCondition();
    IUIAutomationCondition get_ContentViewCondition();
    IUIAutomationCacheRequest CreateCacheRequest();
    IUIAutomationCondition CreateTrueCondition();
    IUIAutomationCondition CreateFalseCondition();
    IUIAutomationCondition CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value);
}

public class UiaElem
{
    internal IUIAutomationElement Inner;
    internal UiaElem(IUIAutomationElement inner) { Inner = inner; }
}

public static class ControlType
{
    public const int Button = 50000;
    public const int Edit = 50004;
    public const int ComboBox = 50003;
    public const int ListItem = 50007;
    public const int TabItem = 50019;
    public const int Text = 50020;
    public const int StatusBar = 50017;
    public const int Header = 50034;
    public const int HeaderItem = 50035;
    public const int Hyperlink = 50005;
}

public static class UiaHelper
{
    public const int Prop_ControlType = 30003;
    public const int Prop_Name = 30005;
    public const int Prop_HelpText = 30013;
    public const int Prop_BoundingRectangle = 30001;
    public const int Prop_NativeWindowHandle = 30020;
    public const int Pattern_Value = 10002;
    public const int Scope_Children = 2;
    public const int Scope_Descendants = 4;

    private static IUIAutomation _auto;
    private static IUIAutomation Auto
    {
        get
        {
            if (_auto == null)
            {
                Type t = Type.GetTypeFromCLSID(new Guid("FF48DBA4-60EF-4201-AA87-54103EEF594E"));
                _auto = (IUIAutomation)Activator.CreateInstance(t);
            }
            return _auto;
        }
    }

    public static UiaElem ElementFromHandle(IntPtr hwnd)
    {
        var e = Auto.ElementFromHandle(hwnd);
        return e == null ? null : new UiaElem(e);
    }

    public static string GetName(UiaElem el)
    {
        if (el == null) return "";
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_Name); return v as string ?? ""; }
        catch { return ""; }
    }

    public static int GetControlType(UiaElem el)
    {
        if (el == null) return 0;
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_ControlType); return v is int ? (int)v : 0; }
        catch { return 0; }
    }

    public static string GetHelpText(UiaElem el)
    {
        if (el == null) return "";
        try { var v = el.Inner.GetCurrentPropertyValue(Prop_HelpText); return v as string ?? ""; }
        catch { return ""; }
    }

    public static double[] GetBoundingRect(UiaElem el)
    {
        if (el == null) return new double[] { 0, 0, 0, 0 };
        try
        {
            var v = el.Inner.GetCurrentPropertyValue(Prop_BoundingRectangle);
            if (v is double[] && ((double[])v).Length == 4) return (double[])v;
            return new double[] { 0, 0, 0, 0 };
        }
        catch { return new double[] { 0, 0, 0, 0 }; }
    }

    public static IntPtr GetNativeWindowHandle(UiaElem el)
    {
        if (el == null) return IntPtr.Zero;
        try
        {
            var v = el.Inner.GetCurrentPropertyValue(Prop_NativeWindowHandle);
            if (v is int) return new IntPtr((int)v);
            return IntPtr.Zero;
        }
        catch { return IntPtr.Zero; }
    }

    public static void SetFocus(UiaElem el)
    {
        if (el == null) return;
        try { el.Inner.SetFocus(); } catch { }
    }

    private static IUIAutomationTreeWalker _rawWalker;
    private static IUIAutomationTreeWalker RawWalker
    {
        get
        {
            if (_rawWalker == null) _rawWalker = Auto.get_RawViewWalker();
            return _rawWalker;
        }
    }

    public static UiaElem GetParent(UiaElem el)
    {
        if (el == null) return null;
        try
        {
            var p = RawWalker.GetParentElement(el.Inner);
            return p == null ? null : new UiaElem(p);
        }
        catch { return null; }
    }

    private static UiaElem[] ToArray(IUIAutomationElementArray arr)
    {
        if (arr == null) return new UiaElem[0];
        int n = arr.Length;
        var result = new UiaElem[n];
        for (int i = 0; i < n; i++) result[i] = new UiaElem(arr.GetElement(i));
        return result;
    }

    public static UiaElem[] FindAllChildren(UiaElem el, int controlType)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreatePropertyCondition(Prop_ControlType, controlType);
        return ToArray(el.Inner.FindAll(Scope_Children, cond));
    }

    public static UiaElem[] FindAllDescendants(UiaElem el, int controlType)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreatePropertyCondition(Prop_ControlType, controlType);
        return ToArray(el.Inner.FindAll(Scope_Descendants, cond));
    }

    public static UiaElem[] FindAllChildrenAny(UiaElem el)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreateTrueCondition();
        return ToArray(el.Inner.FindAll(Scope_Children, cond));
    }

    public static UiaElem[] FindAllDescendantsAny(UiaElem el)
    {
        if (el == null) return new UiaElem[0];
        var cond = Auto.CreateTrueCondition();
        return ToArray(el.Inner.FindAll(Scope_Descendants, cond));
    }

    public static bool SetValue(UiaElem el, string value)
    {
        if (el == null) return false;
        try
        {
            object pattern = el.Inner.GetCurrentPattern(Pattern_Value);
            if (pattern == null) return false;
            IUIAutomationValuePattern vp = (IUIAutomationValuePattern)pattern;
            vp.SetValue(value);
            return true;
        }
        catch { return false; }
    }

    public static string GetValue(UiaElem el)
    {
        if (el == null) return null;
        try
        {
            object pattern = el.Inner.GetCurrentPattern(Pattern_Value);
            if (pattern == null) return null;
            IUIAutomationValuePattern vp = (IUIAutomationValuePattern)pattern;
            return vp.get_CurrentValue();
        }
        catch { return null; }
    }
}
"@

# ---------------- constantes ----------------
$VENTANA_PYXIS_TITULO_RE = "^Pyxis -.*"
$SEGUNDOS_PREPARACION = 5
$TIMEOUT_GENERACION_SEGUNDOS = 420
$WEBAPP_URL = "__WEBAPP_URL__"
$TOKEN_ROBOT = "__TOKEN__"
$TC = [ControlType]

$CODIGO_POR_TIENDA = @{
    "MALAGA" = "036"
    "MARBELLA" = "014"
    "MIJAS" = "279"
    "GRANADA" = "043"
}

# ---------------- utilidades basicas (mismo patron que el robot de Muelles) ----------------

function Normalizar([string]$texto) {
    $t = ($texto | Out-String).Trim().ToUpperInvariant()
    $normalizado = $t.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $normalizado.ToCharArray()) {
        if ([System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($c)
        }
    }
    return $sb.ToString()
}

function Click-At([double]$x, [double]$y) {
    [Win32Mouse]::SetCursorPos([int]$x, [int]$y) | Out-Null
    Start-Sleep -Milliseconds 80
    [Win32Mouse]::mouse_event([Win32Mouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Win32Mouse]::mouse_event([Win32Mouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Centro($rect) {
    return @{ X = $rect[0] + ($rect[2] / 2); Y = $rect[1] + ($rect[3] / 2) }
}

function Click-Elemento($elemento) {
    $r = [UiaHelper]::GetBoundingRect($elemento)
    $c = Centro $r
    Click-At $c.X $c.Y
}

function TextoBarraEstado($ventana) {
    $barras = [UiaHelper]::FindAllDescendants($ventana, $TC::StatusBar)
    if ($barras.Length -eq 0) { return "" }
    $textos = @()
    $textosCtrl = [UiaHelper]::FindAllDescendants($barras[0], $TC::Text)
    foreach ($t in $textosCtrl) {
        $v = [UiaHelper]::GetName($t)
        if ($v) { $textos += $v }
    }
    return ($textos -join " ")
}

function VentanaUtilizable($ventana) {
    try {
        $r = [UiaHelper]::GetBoundingRect($ventana)
        return ($r[2] -gt 0 -and $r[3] -gt 0)
    } catch { return $false }
}

# Ventanas de Pyxis abiertas AHORA, con su tienda ya detectada (si se pudo).
function ObtenerVentanasPyxis() {
    $candidatas = @([Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match $VENTANA_PYXIS_TITULO_RE })
    $resultado = @()
    foreach ($c in $candidatas) {
        if ([Win32Mouse]::IsIconic($c.Handle)) {
            [Win32Mouse]::ShowWindow($c.Handle, [Win32Mouse]::SW_RESTORE) | Out-Null
            Start-Sleep -Milliseconds 300
        }
        $v = $null
        try { $v = [UiaHelper]::ElementFromHandle($c.Handle) } catch { continue }
        if (-not $v -or -not (VentanaUtilizable $v)) { continue }
        $barra = TextoBarraEstado $v
        $tiendaDetectada = $null
        foreach ($nombreTienda in $CODIGO_POR_TIENDA.Keys) {
            if ((Normalizar $barra) -like "*$nombreTienda*") { $tiendaDetectada = $nombreTienda }
        }
        $resultado += [pscustomobject]@{ Handle = $c.Handle; Elemento = $v; Tienda = $tiendaDetectada; BarraEstado = $barra }
    }
    return $resultado
}

function Encontrar-Hyperlink($ventana, [string]$nombre) {
    $links = [UiaHelper]::FindAllDescendants($ventana, $TC::Hyperlink)
    foreach ($l in $links) {
        if ([UiaHelper]::GetName($l) -eq $nombre) { return $l }
    }
    return $null
}

function Encontrar-Boton($ventana, [string]$texto) {
    $botones = [UiaHelper]::FindAllDescendants($ventana, $TC::Button)
    foreach ($b in $botones) {
        if ([UiaHelper]::GetName($b) -eq $texto) { return $b }
    }
    return $null
}

function Esperar-Boton($ventana, [string]$texto, [int]$timeoutSeg = 8) {
    $transcurrido = 0.0
    while ($transcurrido -lt $timeoutSeg) {
        $b = Encontrar-Boton $ventana $texto
        if ($b) { return $b }
        Start-Sleep -Milliseconds 400
        $transcurrido += 0.4
    }
    return $null
}

# Pulsa el boton "casita" (Inicio) de la barra superior de Pyxis. Es el
# primer boton de la fila de iconos de arriba a la izquierda, a la izquierda
# del carrito. Se busca por nombre y, si Pyxis no le pone nombre util, se
# cae a "el boton mas arriba-izquierda de la ventana", que es el que es.
function Ir-AInicioPyxis($ventanaPyxis) {
    try {
        $botones = [UiaHelper]::FindAllDescendants($ventanaPyxis, $TC::Button)
        if (-not $botones -or $botones.Length -eq 0) { return }

        $casita = $null
        foreach ($b in $botones) {
            $n = Normalizar ([UiaHelper]::GetName($b))
            if ($n -eq "INICIO" -or $n -eq "HOME" -or $n -like "*PANTALLA PRINCIPAL*") { $casita = $b; break }
        }

        if (-not $casita) {
            $rectVentana = [UiaHelper]::GetBoundingRect($ventanaPyxis)
            $limiteY = $rectVentana[1] + 120   # solo la barra de iconos de arriba
            $mejorX = [double]::MaxValue
            foreach ($b in $botones) {
                $r = [UiaHelper]::GetBoundingRect($b)
                if ($r[2] -le 0 -or $r[3] -le 0) { continue }
                if ($r[1] -gt $limiteY) { continue }
                if ($r[0] -lt $mejorX) { $mejorX = $r[0]; $casita = $b }
            }
        }

        if ($casita) { Click-Elemento $casita; Start-Sleep -Milliseconds 900 }
    } catch {}
}

# ---------------- exportar UN inventario ----------------

function Exportar-InventarioTienda($ventanaPyxis, [string]$codigoTienda) {
    # Pyxis puede haber quedado en cualquier pantalla (busqueda de pedido, un
    # acto de venta a medias...) de un uso anterior. El boton "casita" de
    # arriba a la izquierda vuelve SIEMPRE a la pantalla de inicio, que es
    # desde donde se puede entrar a GESTION PEDIDO CLIENTE.
    Ir-AInicioPyxis $ventanaPyxis

    Write-Host "  Navegando a Listado inventario Pedido Cliente..."
    $gestion = Encontrar-Hyperlink $ventanaPyxis "GESTIÓN PEDIDO CLIENTE"
    if (-not $gestion) { throw "No se encuentra 'GESTIÓN PEDIDO CLIENTE' -- ¿Pyxis está en la pantalla de inicio?" }
    Click-Elemento $gestion
    Start-Sleep -Milliseconds 800

    $listado = $null
    $intentos = 0
    while (-not $listado -and $intentos -lt 10) {
        $listado = Encontrar-Hyperlink $ventanaPyxis "Listado inventario Pedido Cliente"
        if (-not $listado) { Start-Sleep -Milliseconds 300; $intentos++ }
    }
    if (-not $listado) { throw "No se encuentra 'Listado inventario Pedido Cliente' tras entrar en Gestión Pedido Cliente" }
    Click-Elemento $listado
    Start-Sleep -Milliseconds 800

    Write-Host "  Confirmando rango (en blanco = todo el inventario)..."
    $aceptar1 = Esperar-Boton $ventanaPyxis "Aceptar" 8
    if (-not $aceptar1) { throw "No aparecio el dialogo 'Listado de inventario Pedido Cliente'" }
    Click-Elemento $aceptar1
    Start-Sleep -Milliseconds 800

    Write-Host "  Confirmando generacion (puede tardar varios minutos)..."
    $aceptar2 = Esperar-Boton $ventanaPyxis "Aceptar" 8
    if (-not $aceptar2) { throw "No aparecio la confirmacion 'va a empezar y puede tardar unos minutos'" }
    Click-Elemento $aceptar2

    Write-Host "  Esperando a que LibreOffice Calc abra el listado generado..."
    $transcurrido = 0
    $ventanaExcel = $null
    while ($transcurrido -lt $TIMEOUT_GENERACION_SEGUNDOS) {
        Start-Sleep -Seconds 5
        $transcurrido += 5
        $candidatas = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match "Listing_CommandeClient" }
        if ($candidatas) { $ventanaExcel = $candidatas[0]; break }
        if ($transcurrido % 30 -eq 0) { Write-Host "    ...siguen esperando ($transcurrido s)" }
    }
    if (-not $ventanaExcel) { throw "LibreOffice Calc no abrio el listado tras $TIMEOUT_GENERACION_SEGUNDOS s" }
    Write-Host "  LibreOffice Calc abierto, guardando como $codigoTienda..."

    # Si un cierre anterior fue forzado, LibreOffice puede mostrar un dialogo
    # de "Recuperacion de documentos" antes de dejar usar la ventana nueva.
    # Se descarta si aparece (best-effort). El cierre al final de esta misma
    # funcion ahora es limpio (ver mas abajo) para que esto no se repita.
    Descartar-RecuperacionLibreOffice

    # Borrar cualquier copia anterior de esta tienda en el Escritorio ANTES
    # de guardar -- asi nunca aparece el aviso de "ya existe, ¿reemplazar?"
    # (mas simple y fiable que intentar detectar y aceptar ese dialogo).
    $ruta = Join-Path -Path ([Environment]::GetFolderPath("Desktop")) -ChildPath ($codigoTienda + ".xlsx")
    if (Test-Path $ruta) {
        Write-Host "  Borrando copia anterior de $codigoTienda.xlsx en el Escritorio..."
        Remove-Item -Path $ruta -Force -ErrorAction SilentlyContinue
    }

    [Win32Mouse]::SetForegroundWindow($ventanaExcel.Handle) | Out-Null
    Start-Sleep -Milliseconds 500
    # LibreOffice Calc: Guardar como es Ctrl+Mayus+S (no F12, ese es el atajo de Excel).
    [System.Windows.Forms.SendKeys]::SendWait("^+s")
    Start-Sleep -Milliseconds 1500

    $dialogoGuardar = $null
    $intentos2 = 0
    while (-not $dialogoGuardar -and $intentos2 -lt 15) {
        $candidatas2 = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -eq "Guardar como" }
        if ($candidatas2) { $dialogoGuardar = $candidatas2[0] } else { Start-Sleep -Milliseconds 400; $intentos2++ }
    }
    if (-not $dialogoGuardar) { throw "No aparecio el dialogo 'Guardar como' tras Ctrl+Mayus+S" }

    [Win32Mouse]::SetForegroundWindow($dialogoGuardar.Handle) | Out-Null
    Start-Sleep -Milliseconds 300
    $rootGuardar = [UiaHelper]::ElementFromHandle($dialogoGuardar.Handle)

    # El nombre del desplegable de tipo puede variar entre el dialogo nativo
    # de Windows y el propio de LibreOffice -- se prueban varios candidatos.
    $NOMBRES_COMBO_TIPO = @("Tipo de archivo:", "Tipo:")
    $comboTipo = $null
    foreach ($nombreCombo in $NOMBRES_COMBO_TIPO) {
        foreach ($c in [UiaHelper]::FindAllDescendants($rootGuardar, $TC::ComboBox)) {
            if ([UiaHelper]::GetName($c) -eq $nombreCombo) { $comboTipo = $c; break }
        }
        if ($comboTipo) { break }
    }
    if (-not $comboTipo) { throw "No se encuentra el desplegable de tipo ('Tipo de archivo:'/'Tipo:') en Guardar como" }
    $rTipo = [UiaHelper]::GetBoundingRect($comboTipo)
    Click-At ($rTipo[0] + $rTipo[2] - 15) ($rTipo[1] + $rTipo[3] / 2)
    Start-Sleep -Milliseconds 600

    # Se elige por CONTENIDO de texto ("Excel 2007-365"), no por posicion en
    # la lista -- la posicion puede variar entre versiones de LibreOffice.
    $opcionXlsx = $null
    foreach ($it in [UiaHelper]::FindAllDescendants($rootGuardar, $TC::ListItem)) {
        if ([UiaHelper]::GetName($it) -match "Excel 2007-365") { $opcionXlsx = $it; break }
    }
    if (-not $opcionXlsx) { throw "No se encuentra la opcion 'Excel 2007-365' en el desplegable de tipo" }
    Click-Elemento $opcionXlsx
    Start-Sleep -Milliseconds 500

    $campoNombre = $null
    foreach ($e in [UiaHelper]::FindAllDescendants($rootGuardar, $TC::Edit)) {
        $n = [UiaHelper]::GetName($e)
        if ($n -eq "Nombre de archivo:" -or $n -eq "Nombre:") { $campoNombre = $e }
    }
    if (-not $campoNombre) { throw "No se encuentra el campo de nombre en Guardar como" }

    Click-Elemento $campoNombre
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($ruta)
    Start-Sleep -Milliseconds 300

    $botonGuardar = Encontrar-Boton $rootGuardar "Guardar"
    if (-not $botonGuardar) { throw "No se encuentra el boton 'Guardar'" }
    Click-Elemento $botonGuardar
    Start-Sleep -Milliseconds 1200

    # LibreOffice pregunta si mantener el formato Excel o pasar a ODF --
    # confirmado en pruebas reales: "Usar Excel 2007-365!" es la opcion por
    # defecto, un solo Intro la acepta. Se espera un instante a que el
    # dialogo aparezca y se manda Intro.
    Start-Sleep -Milliseconds 800
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 500

    $esperaArchivo = 0
    while (-not (Test-Path $ruta) -and $esperaArchivo -lt 20) { Start-Sleep -Milliseconds 500; $esperaArchivo += 0.5 }
    if (-not (Test-Path $ruta)) { throw "Se guardo pero no se encuentra el archivo en $ruta" }

    Write-Host "  Guardado en $ruta"

    # Cerrar LibreOffice AHORA, antes de devolver la ruta -- si se deja
    # abierto, el archivo queda bloqueado y la subida a Drive falla.
    # Cierre CORRECTO, no Stop-Process -Force directo: un cierre forzado deja
    # a LibreOffice creyendo que hubo un cierre "sucio" y la PROXIMA vez que
    # se abra un documento muestra el dialogo de "Recuperacion de
    # documentos" -- confirmado en pruebas reales. Se pide cierre de ventana
    # (ya esta guardado, no debe preguntar nada mas) y solo si no cierra
    # sola en unos segundos se fuerza como ultimo recurso.
    [uint32]$pidExcel = 0
    [Win32Mouse]::GetWindowThreadProcessId($ventanaExcel.Handle, [ref]$pidExcel) | Out-Null
    if ($pidExcel -gt 0) {
        try {
            $procLO = Get-Process -Id $pidExcel -ErrorAction SilentlyContinue
            if ($procLO) {
                $procLO.CloseMainWindow() | Out-Null
                $esperaCierre = 0
                while (-not $procLO.HasExited -and $esperaCierre -lt 10) {
                    Start-Sleep -Milliseconds 500
                    $esperaCierre += 0.5
                    $procLO.Refresh()
                }
                if (-not $procLO.HasExited) { Stop-Process -Id $pidExcel -Force -ErrorAction SilentlyContinue }
            }
        } catch {}
    }

    $esperaLibre = 0
    $libre = $false
    while (-not $libre -and $esperaLibre -lt 10) {
        try {
            $fs = [System.IO.File]::Open($ruta, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
            $fs.Close()
            $libre = $true
        } catch {
            Start-Sleep -Milliseconds 300
            $esperaLibre += 0.3
        }
    }

    # El dialogo "Listado de inventario Pedido Cliente" se queda abierto de
    # fondo en Pyxis tras generar el listado -- hay que cerrarlo con Cancelar.
    $cancelar = Encontrar-Boton $ventanaPyxis "Cancelar"
    if ($cancelar) { Click-Elemento $cancelar; Start-Sleep -Milliseconds 600 }

    return $ruta
}

# Sube el inventario abriendo la app YA autenticada en el navegador (Chrome
# -- Edge no vale, no tiene la sesion de Google del dominio en este PC) y
# haciendo clic el propio robot en "Seleccionar archivo". Google exige login
# de Google del dominio para esta app y bloquea a nivel de politica de Adeo
# cualquier despliegue publico/anonimo -- por eso NO se puede subir con un
# simple POST desde PowerShell, hay que pasar por un navegador con sesion
# real. Ver [[lm-malaga-robot-inventarios-navegador]] para el porque completo.
#
# IMPORTANTE: se usa SIEMPRE Start-Process para abrir/enfocar la pagina,
# NUNCA SendKeys de Ctrl+T/Ctrl+L -- confirmado en pruebas reales que
# SetForegroundWindow (incluso con el truco AttachThreadInput) puede fallar
# en silencio si el escritorio esta ocupado (p.ej. llega una notificacion de
# Chat), dejando las pulsaciones "en el aire" sin que lleguen a Chrome.
# Start-Process en cambio pasa la URL al Chrome ya abierto por comunicacion
# entre procesos (no por teclado), y Chrome activa la pestaña nueva el solo
# -- inmune a ese problema.
# Sube TODOS los inventarios ya descargados de una sola vez, en UNA sola
# pestaña (antes se abria una pestaña por tienda). El dialogo "Abrir" de
# Windows admite varios archivos escribiendo sus rutas entre comillas
# separadas por espacios, y la pagina de subida lleva <input multiple> y
# deduce el codigo de tienda del nombre de cada archivo.
function Subir-Inventarios([string[]]$rutasArchivos) {
    $resultado = $null
    for ($intentoGlobal = 1; $intentoGlobal -le 3; $intentoGlobal++) {
        $resultado = Subir-InventariosIntento $rutasArchivos
        if ($resultado.ok) { return $resultado }
        Write-Host "    (intento $intentoGlobal de subida fallido: $($resultado.error))" -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
    return $resultado
}

function Subir-InventariosIntento([string[]]$rutasArchivos) {
    $urlSubida = $WEBAPP_URL + "?vista=subirInventarioRobot"
    Start-Process "chrome.exe" $urlSubida
    Start-Sleep -Seconds 2
    $ventanaChrome = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -match "Google Chrome$" } | Select-Object -First 1
    if (-not $ventanaChrome) { return @{ ok = $false; error = "No se encuentra ninguna ventana de Chrome abierta" } }

    # Hasta 30s -- la primera carga de la pagina (login de Google + generar
    # token en el servidor) puede tardar mas que una recarga normal.
    $tituloEsperado = "Robot Inventarios"
    $cargada = $false
    $intentos = 0
    while (-not $cargada -and $intentos -lt 60) {
        $actual = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Handle -eq $ventanaChrome.Handle }
        if ($actual -and $actual[0].Titulo -match [regex]::Escape($tituloEsperado)) { $cargada = $true } else { Start-Sleep -Milliseconds 500; $intentos++ }
    }
    if (-not $cargada) { return @{ ok = $false; error = "La pagina de subida no cargo -- comprueba que Chrome tenga sesion de Google iniciada" } }

    $root = [UiaHelper]::ElementFromHandle($ventanaChrome.Handle)
    $elegir = $null
    $intentosEl = 0
    while (-not $elegir -and $intentosEl -lt 10) {
        foreach ($el in [UiaHelper]::FindAllDescendantsAny($root)) {
            if ([UiaHelper]::GetName($el) -match "ROBOT_SELECCIONAR_ARCHIVO") { $elegir = $el }
        }
        if (-not $elegir) { Start-Sleep -Milliseconds 400; $intentosEl++ }
    }
    if (-not $elegir) { return @{ ok = $false; error = "No se encontro el boton 'Seleccionar archivo' en la pagina" } }
    Click-Elemento $elegir
    Start-Sleep -Milliseconds 1200

    $dialogo = $null
    $intentosD = 0
    while (-not $dialogo -and $intentosD -lt 15) {
        $cands = [Win32Mouse]::VentanasVisibles() | Where-Object { $_.Titulo -eq "Abrir" }
        if ($cands) { $dialogo = $cands[0] } else { Start-Sleep -Milliseconds 400; $intentosD++ }
    }
    if (-not $dialogo) { return @{ ok = $false; error = "No aparecio el dialogo 'Abrir'" } }
    [Win32Mouse]::SetForegroundWindow($dialogo.Handle) | Out-Null
    Start-Sleep -Milliseconds 300
    $rootDialogo = [UiaHelper]::ElementFromHandle($dialogo.Handle)
    $campoNombre = $null
    foreach ($e in [UiaHelper]::FindAllDescendants($rootDialogo, $TC::Edit)) {
        $n = [UiaHelper]::GetName($e)
        if ($n -eq "Nombre de archivo:" -or $n -eq "Nombre:") { $campoNombre = $e }
    }
    if (-not $campoNombre) { return @{ ok = $false; error = "No se encontro el campo de nombre en 'Abrir'" } }

    # Varios archivos a la vez: "ruta1" "ruta2" "ruta3" (comillas obligatorias).
    $textoRutas = ($rutasArchivos | ForEach-Object { '"' + $_ + '"' }) -join ' '
    Click-Elemento $campoNombre
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($textoRutas)
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

    # El resultado se lee del TEXTO de la pagina, NO del titulo de la
    # pestaña: la pagina vive en el iframe aislado de Apps Script y ahi
    # document.title no llega al navegador (por eso antes siempre daba
    # timeout y reintentaba subir lo mismo una y otra vez).
    $resultado = $null
    $intentosR = 0
    $maxEspera = 40 + ($rutasArchivos.Count * 30)
    while (-not $resultado -and $intentosR -lt $maxEspera) {
        try {
            $rootAhora = [UiaHelper]::ElementFromHandle($ventanaChrome.Handle)
            foreach ($t in [UiaHelper]::FindAllDescendants($rootAhora, $TC::Text)) {
                $txt = [UiaHelper]::GetName($t)
                if ($txt -match "ROBOT_FIN_OK:(\d+)/(\d+)") { $resultado = @{ ok = $true; subidos = [int]$Matches[1]; total = [int]$Matches[2] }; break }
                if ($txt -match "ROBOT_FIN_ERROR:\s*(.+)$") { $resultado = @{ ok = $false; error = $Matches[1] }; break }
            }
        } catch {}
        if (-not $resultado) { Start-Sleep -Milliseconds 500; $intentosR++ }
    }
    if (-not $resultado) { $resultado = @{ ok = $false; error = "Tiempo de espera agotado subiendo los archivos" } }

    Cerrar-PestanaSubida $ventanaChrome.Handle
    return $resultado
}

# Cierra la pestaña de subida clicando su propia "x" -- no se usa Ctrl+W
# porque depende de SetForegroundWindow, que no es fiable aqui (mismo motivo
# por el que la apertura usa Start-Process). Si no se cierra, se van
# acumulando pestañas "Robot Inventarios" en cada ejecucion.
function Cerrar-PestanaSubida([IntPtr]$handleChrome) {
    try {
        $root = [UiaHelper]::ElementFromHandle($handleChrome)
        foreach ($tab in [UiaHelper]::FindAllDescendants($root, $TC::TabItem)) {
            if ([UiaHelper]::GetName($tab) -notmatch "Robot Inventarios") { continue }
            foreach ($btn in [UiaHelper]::FindAllDescendants($tab, $TC::Button)) {
                if ([UiaHelper]::GetName($btn) -eq "Cerrar") { Click-Elemento $btn; Start-Sleep -Milliseconds 500; return }
            }
        }
    } catch {}
}

# ============================================================
# EJECUCION
# ============================================================
Write-Host "Buscando ventanas de Pyxis abiertas..." -ForegroundColor Cyan
for ($restante = $SEGUNDOS_PREPARACION; $restante -gt 0; $restante--) {
    Write-Host "  Empezando en $restante..."
    Start-Sleep -Seconds 1
}

$ventanas = ObtenerVentanasPyxis
if ($ventanas.Count -eq 0) {
    Write-Host "No se encuentra ninguna ventana de Pyxis abierta." -ForegroundColor Yellow
    Read-Host "Pulsa ENTER para salir"
    exit
}

Write-Host "Ventanas encontradas: $($ventanas.Count)"
foreach ($v in $ventanas) { Write-Host "  - $($v.Tienda) ($($v.BarraEstado))" }
Write-Host ""

# FASE 1: sacar el inventario de cada tienda al Escritorio (sin subir nada
# todavia). FASE 2, al final: subir los que se hayan podido sacar, TODOS de
# una vez en una sola pestaña del navegador.
$resultados = @()
$descargados = @()
foreach ($v in $ventanas) {
    if (-not $v.Tienda) {
        Write-Host "SALTANDO ventana (no se pudo identificar la tienda): $($v.BarraEstado)" -ForegroundColor Yellow
        continue
    }
    $codigo = $CODIGO_POR_TIENDA[$v.Tienda]
    Write-Host "=== $($v.Tienda) ($codigo) ===" -ForegroundColor Cyan
    try {
        [Win32Mouse]::SetForegroundWindow($v.Handle) | Out-Null
        Start-Sleep -Milliseconds 500
        $ruta = Exportar-InventarioTienda $v.Elemento $codigo
        $descargados += [pscustomobject]@{ Tienda = $v.Tienda; Codigo = $codigo; Ruta = $ruta }
    } catch {
        Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $resultados += [pscustomobject]@{ Tienda = $v.Tienda; Ok = $false; Detalle = $_.Exception.Message }
    }
    Write-Host ""
}

if ($descargados.Count -gt 0) {
    Write-Host "=== SUBIENDO $($descargados.Count) INVENTARIO(S) A DRIVE ===" -ForegroundColor Cyan
    $r = Subir-Inventarios ($descargados | ForEach-Object { $_.Ruta })
    if ($r.ok) {
        Write-Host "  OK: $($r.subidos)/$($r.total) subidos" -ForegroundColor Green
        foreach ($d in $descargados) {
            $resultados += [pscustomobject]@{ Tienda = $d.Tienda; Ok = $true; Detalle = "$($d.Codigo).xlsx subido" }
            # Ya esta en Drive -- se borra la copia local del Escritorio.
            Remove-Item -Path $d.Ruta -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host "  ERROR al subir: $($r.error)" -ForegroundColor Red
        foreach ($d in $descargados) {
            $resultados += [pscustomobject]@{ Tienda = $d.Tienda; Ok = $false; Detalle = $r.error }
        }
    }
    Write-Host ""
}

Write-Host "=== RESUMEN ===" -ForegroundColor Cyan
foreach ($r in $resultados) {
    $color = if ($r.Ok) { "Green" } else { "Red" }
    Write-Host ("  {0}: {1}" -f $r.Tienda, $r.Detalle) -ForegroundColor $color
}
Read-Host "Terminado. Pulsa ENTER para cerrar"
`;

function generarScriptRobotInventariosLibreOffice() {
  var url = ScriptApp.getService().getUrl();
  var token = getOCrearTokenRobotInventario();
  return (PREFIJO_DESCARTAR_RECUPERACION_LIBREOFFICE + PLANTILLA_ROBOT_INVENTARIOS_LIBREOFFICE_PS1)
    .replace('__WEBAPP_URL__', url)
    .replace('__TOKEN__', token);
}

/**
 * Igual que generarScriptRobotInventariosLibreOffice(), pero en bucle cada
 * 30 min para PC aislado -- mismo patron que generarScriptRobotInventariosBucle():
 * corta PLANTILLA_ROBOT_INVENTARIOS_LIBREOFFICE_PS1 antes del marcador
 * "EJECUCION" y le pega BLOQUE_EJECUCION_BUCLE_INVENTARIOS_PS1 (reutilizado
 * tal cual -- el driver del bucle no sabe ni le importa si exporta con
 * Excel o LibreOffice, solo llama a Exportar-InventarioTienda/Subir-Inventarios).
 */
function generarScriptRobotInventariosLibreOfficeBucle() {
  var marcador = '# ============================================================\n# EJECUCION\n# ============================================================';
  var idx = PLANTILLA_ROBOT_INVENTARIOS_LIBREOFFICE_PS1.indexOf(marcador);
  if (idx < 0) throw new Error('No se encontró el marcador de EJECUCION en PLANTILLA_ROBOT_INVENTARIOS_LIBREOFFICE_PS1 -- revisa que no haya cambiado el texto.');
  var url = ScriptApp.getService().getUrl();
  var token = getOCrearTokenRobotInventario();
  var cuerpo = PREFIJO_DESCARTAR_RECUPERACION_LIBREOFFICE + PLANTILLA_ROBOT_INVENTARIOS_LIBREOFFICE_PS1.substring(0, idx);
  return (cuerpo + BLOQUE_EJECUCION_BUCLE_INVENTARIOS_PS1)
    .replace('__WEBAPP_URL__', url)
    .replace('__TOKEN__', token);
}

/**
 * Marca (o desmarca) como "ya actualizado en Pyxis" una o varias líneas de la
 * pantalla Muelles a la vez (el/los id(s) de LINEAS que obtenerMuellesHoy()
 * agrupó bajo la misma pedido+dirección+referencia). El admin lo va
 * marcando a lo largo del día conforme cambia cada dirección a 467 en Pyxis;
 * una vez marcada deja de salir en obtenerMuellesHoy().
 */
function marcarMuelleHecho(ids, hecho) {
  if (!ids || !ids.length) return { ok: false, error: 'Sin líneas' };
  var lineasRaw = leerHoja('LINEAS');
  var idsSet = {};
  ids.forEach(function(id) { idsSet[id] = true; });
  var filas = lineasRaw.filter(function(l) { return idsSet[l.id]; }).map(function(l) { return l._fila; });
  if (!filas.length) return { ok: false, error: 'Líneas no encontradas' };
  actualizarColumnaLote('LINEAS', filas, 'muelleHecho', hecho ? true : '');
  return { ok: true };
}

/**
 * Repara una fila de OCUPACION "huérfana" (marcada 'inconsistente' en la
 * pantalla Entregas): un pedido ya resuelto por otro camino (normalmente
 * entregado) cuya posición nunca se llegó a liberar — típicamente porque se
 * movió de silueta con moverPedidoDeSilueta MIENTRAS ya estaba metido en una
 * carga activa, y esa carga liberó al entregarlo la posición VIEJA (guardada
 * en su propio snapshot de items) en vez de la nueva real. Borra la fila (o
 * filas, back+front) que coincidan exactamente con silueta+posición+pedido.
 */
function liberarOcupacionHuerfana(silueta, pos, pedido) {
  var datos = leerHoja('OCUPACION');
  var candidatas = datos.filter(function(o) {
    return String(o.silueta) === String(silueta) && Number(o.pos) === Number(pos) && String(o.pedido) === String(pedido);
  });
  if (!candidatas.length) return { ok: false, error: 'No se encontró esa fila de ocupación (puede que ya se haya limpiado)' };
  candidatas.forEach(function(o) { borrarFila('OCUPACION', o._fila); });
  logActividad('LIMPIAR_HUERFANO', 'Ocupación huérfana liberada: ' + silueta + pos + ' (pedido ' + pedido + ') · ' + candidatas.length + ' fila(s)', 'admin');
  marcarResumenObsoleto();
  return { ok: true, filas: candidatas.length };
}

/**
 * Libera VARIOS rangos de ocupación en una sola pasada: lee la hoja una vez,
 * reescribe las filas que quedan y borra el sobrante. 3 operaciones en total,
 * da igual cuántos pedidos sean (antes: 1 lectura completa + N borrados POR pedido).
 * Con candado para no chocar con cierres de pedido simultáneos; si no lo
 * consigue, cae al método clásico fila a fila.
 */
// Fase 3, Pieza 3 (2026-09-04): OCUPACION ya vive en Postgres (public) -- ver
// TABLAS_PUBLIC_ en Pieza3Publico.gs. Un DELETE por rango en Postgres es una
// sola operación atómica -- ya no hace falta candado ni reescribir la hoja.
function liberarPosicionesLote(rangos) {
  if (!rangos || !rangos.length) return;
  rangos.forEach(function(r) { liberarPosiciones(r.silueta, r.posIni, r.posFin, r.pedido); });
}

/**
 * Libera las filas de OCUPACIÓN de UN pedido concreto dentro de un rango de
 * posiciones. Filtra también por número de pedido (no solo silueta+posición):
 * con el reparto de delante de Remansur, dos pedidos DISTINTOS pueden compartir
 * una misma posición (uno detrás, otro delante) — liberar uno no debe tocar
 * la fila del otro, que sigue en silueta.
 */
function liberarPosiciones(silueta, posIni, posFin, numPedido) {
  // `pos` es TEXT en Postgres -- gte/lte de PostgREST compararía como texto
  // (orden equivocado: "10" < "2"). Filtramos por silueta+pedido en el
  // servidor y el rango numérico aquí, luego borramos por lista exacta de pos.
  var candidatas = leerHoja('OCUPACION').filter(function(o) {
    return o.silueta === silueta && String(o.pedido) === String(numPedido);
  });
  var posABorrar = candidatas
    .map(function(o) { return Number(o.pos); })
    .filter(function(p) { return p >= posIni && p <= posFin; });
  if (posABorrar.length) {
    var uniq = posABorrar.filter(function(p, i) { return posABorrar.indexOf(p) === i; });
    var filtro = 'silueta=eq.' + encodeURIComponent(silueta) + '&pedido=eq.' + encodeURIComponent(numPedido)
      + '&pos=in.(' + uniq.join(',') + ')';
    _restPublic_('delete', 'ocupacion_siluetas?' + filtro, undefined, 'return=minimal');
  }
  eliminarOcupacionSupabase_(silueta, posIni, posFin, numPedido);
}

/**
 * Acción manual desde la Pantalla de administración: saca un pedido de la silueta
 * y libera su hueco. disposicion: 'almacen' | 'tienda' | 'desmarcar' | 'otros'.
 * - almacen/tienda/otros → el pedido SALE del sistema (estado terminal).
 * - desmarcar → vuelve a quedar disponible SIN silueta (para recolocarlo).
 *
 * tienda (opcional): mismo motivo y patrón que moverPedidoDeSilueta/
 * corregirSoportesPedido — el nº de pedido no es único por sí solo entre
 * tiendas distintas; si se indica, se exige la coincidencia exacta; si no y
 * hay más de un candidato, se rechaza por ambigüedad en vez de adivinar.
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION ya viven en Postgres
// (public). public.liberar_pedido_de_silueta(...) hace TODO lo de dentro
// con `for update`. Solo _quitarPedidoDeSuCargaActiva (Sheets) queda por
// sincronizar -- numeroCarga se lee ANTES.
function liberarPedidoDeSilueta(numPed, disposicion, motivo, tienda) {
  var candidatos = buscarFilasPorCampo('PEDIDOS', 'ped', numPed).filter(function(p) { return p.silueta; });
  var pedidoAntes = tienda ? candidatos.find(function(p) { return p.tienda === tienda; }) : (candidatos.length === 1 ? candidatos[0] : null);
  var r = _rpcPublic_('liberar_pedido_de_silueta', { p_num_ped: String(numPed), p_disposicion: disposicion, p_motivo: motivo || null, p_tienda: tienda || null });
  if (!r.ok) return r;
  if (pedidoAntes && pedidoAntes.numeroCarga) _quitarPedidoDeSuCargaActiva(pedidoAntes.numeroCarga, numPed);
  logActividad('LIBERAR_SILUETA', 'Pedido ' + numPed + ' (silueta ' + r.silueta + ') · ' + (motivo || disposicion), 'admin');
  marcarResumenObsoleto();
  return r;
}

/**
 * Si el pedido movido pertenece a una carga TODAVÍA ACTIVA (numeroCarga
 * apunta a una fila GENERADA), su snapshot de items (congelado desde que se
 * creó la carga) sigue guardando la posición VIEJA. Sin esto, al entregar
 * ese pedido más tarde confirmarEntregas liberaría la posición vieja (ya
 * vacía, no-op) en vez de la nueva real, dejando la posición nueva como fila
 * de OCUPACION huérfana para siempre (bug real encontrado en producción:
 * dos pedidos ya entregados seguían "ocupando" su silueta en el mapa).
 */
function sincronizarPosicionEnCargaActiva(numeroCarga, numPed, nuevaSilueta, nuevaPosIni, nuevaPosFin) {
  if (!numeroCarga) return;
  // CANDADO: quitarPedidoDeCarga() también lee-modifica-escribe CARGAS.items
  // bajo su propio candado — sin este, un mover y un quitar casi simultáneos
  // sobre la MISMA carga podrían pisarse (el pedido quitado "reaparecería",
  // o esta sincronización se perdería). Se llama SIEMPRE después de que
  // liberarPosiciones/anadirFilas ya hayan soltado sus propios candados
  // (secuencial, no anidado).
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  try {
    var cargaRow = leerHoja('CARGAS').find(function(c) { return String(c.numCarga) === String(numeroCarga) && c.estado === 'GENERADA'; });
    if (!cargaRow) return;
    var items = parseJSON(cargaRow.items, []);
    var it = items.find(function(x) { return String(x.ped) === String(numPed); });
    if (!it) return;
    it.silueta = nuevaSilueta; it.posIni = nuevaPosIni; it.posFin = nuevaPosFin;
    actualizarFila('CARGAS', cargaRow._fila, { items: items });
  } finally {
    if (lock) lock.releaseLock();
  }
}

/**
 * Igual que sincronizarPosicionEnCargaActiva pero para MUCHOS pedidos a la
 * vez (p.ej. aplicarCompactarSiluetas, que puede reubicar decenas de golpe):
 * UNA sola lectura de CARGAS y UN solo candado, en vez de uno por pedido —
 * evita que una compactación grande tarde tanto que el cliente (watchdog de
 * 20s en gas(), Index.html) la dé por perdida mientras el backend sigue
 * trabajando de fondo.
 * actualizaciones: [{ numeroCarga, ped, silueta, posIni, posFin }, ...]
 */
function _sincronizarPosicionesEnCargasLote(actualizaciones) {
  if (!actualizaciones || !actualizaciones.length) return;
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (eL) { lock = null; }
  try {
    var cargasRaw = leerHoja('CARGAS');
    var porNumCarga = {};
    cargasRaw.forEach(function(c) {
      if (c.estado === 'GENERADA') porNumCarga[String(c.numCarga)] = c;
    });
    var afectadas = {};
    actualizaciones.forEach(function(a) {
      var cargaRow = porNumCarga[String(a.numeroCarga)];
      if (!cargaRow) return;
      var key = String(a.numeroCarga);
      if (!afectadas[key]) afectadas[key] = { cargaRow: cargaRow, items: parseJSON(cargaRow.items, []) };
      var it = afectadas[key].items.find(function(x) { return String(x.ped) === String(a.ped); });
      if (it) { it.silueta = a.silueta; it.posIni = a.posIni; it.posFin = a.posFin; }
    });
    Object.keys(afectadas).forEach(function(key) {
      var entry = afectadas[key];
      actualizarFila('CARGAS', entry.cargaRow._fila, { items: entry.items });
    });
  } finally {
    if (lock) lock.releaseLock();
  }
}

/**
 * Acción manual desde la Pantalla de administración: mueve un pedido YA en
 * silueta a otra posición (misma silueta u otra distinta), sin pasar por el
 * flujo del operario. Reutiliza el mismo empaquetado de soportes y las mismas
 * reglas de asignación que al cerrar un pedido (incluido el reparto de
 * delante de Remansur), pero SOLO libera el hueco viejo DESPUÉS de comprobar
 * que el destino es válido — así nunca se queda sin sitio a medio mover.
 *
 * tienda (opcional): el nº de pedido NO es único por sí solo entre tiendas
 * distintas (idPedido = tienda+número es la clave real — mismo motivo ya
 * corregido en anadirPedidoACarga/cambiarFlujoPedidosMasivo/
 * registrarPedidoManual). Si se indica, se exige la coincidencia exacta
 * pedido+tienda en vez de quedarse con el primer pedido que encuentre con
 * ese número; si no se indica y hay más de uno, se rechaza por ambigüedad
 * en vez de adivinar cuál.
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION ya viven en Postgres
// (public). public.mover_pedido_de_silueta(...) hace TODO lo de dentro
// (desambiguación por tienda, bultos, compartir Remansur, validar destino
// antes de liberar origen) con `for update` -- reemplaza el candado global.
// Solo CARGAS (Sheets) queda por sincronizar -- numeroCarga se lee ANTES
// (no cambia con esta operación).
function moverPedidoDeSilueta(numPed, nuevaSilueta, nuevaPosIni, tienda) {
  var candidatos = buscarFilasPorCampo('PEDIDOS', 'ped', numPed).filter(function(p) { return p.silueta; });
  var pedidoAntes = tienda ? candidatos.find(function(p) { return p.tienda === tienda; }) : (candidatos.length === 1 ? candidatos[0] : null);
  var soportes = pedidoAntes ? parseJSON(pedidoAntes.soportes, []) : [];
  var posiciones = calcularPosiciones(soportes);

  var r = _rpcPublic_('mover_pedido_de_silueta', {
    p_num_ped: String(numPed), p_nueva_silueta: nuevaSilueta, p_nueva_pos_ini: Number(nuevaPosIni),
    p_posiciones: posiciones, p_tienda: tienda || null
  });
  if (!r.ok) return r;
  var out = { ok: true, silueta: r.silueta, posIni: r.pos_ini, posFin: r.pos_fin };
  if (r.compartido) out.compartido = true;
  if (r.sin_cambios) out.sinCambios = true;

  if (pedidoAntes) sincronizarPosicionEnCargaActiva(pedidoAntes.numeroCarga, pedidoAntes.ped, r.silueta, r.pos_ini, r.pos_fin);
  logActividad('MOVER_PEDIDO', 'Pedido ' + numPed + ' → ' + r.silueta + (r.pos_ini === r.pos_fin ? r.pos_ini : r.pos_ini + '-' + r.pos_fin), 'admin');
  marcarResumenObsoleto();
  return out;
}

/**
 * Corrige los SOPORTES de un pedido YA en silueta (el operario se equivocó
 * al contarlos al cerrarlo) y lo recoloca según el recuento nuevo — mismo
 * patrón que moverPedidoDeSilueta, pero cambiando también el propio campo
 * soportes del pedido en vez de solo su posición. nuevaSilueta/nuevaPosIni
 * son el destino (normalmente la MISMA posición que ya tenía, para intentar
 * dejarlo donde estaba si el recuento corregido sigue cabiendo ahí; si no
 * cabe — p.ej. ahora ocupa una posición más — el admin puede indicar un
 * destino distinto desde la misma pantalla).
 *
 * A diferencia de moverPedidoDeSilueta (que valida el destino ANTES de
 * liberar el origen, porque origen y destino son sitios distintos), aquí el
 * hueco viejo puede solaparse con el nuevo (mismo sitio, tamaño distinto), así
 * que hace falta liberar primero para poder validar correctamente — y si el
 * recuento nuevo no cupiera en el destino pedido, se re-ocupa el hueco viejo
 * tal cual estaba (con los soportes de ANTES) para no dejar el pedido sin
 * silueta.
 *
 * tienda (opcional): el nº de pedido NO es único por sí solo entre tiendas
 * distintas — mismo motivo y mismo patrón ya aplicado en
 * moverPedidoDeSilueta: si se indica, se exige la coincidencia exacta
 * pedido+tienda; si no y hay más de un candidato, se rechaza por ambigüedad.
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION ya viven en Postgres
// (public). public.corregir_soportes_pedido(...) hace TODO lo de dentro
// (bultos, compartir Remansur, captura+rollback de filas reales si el
// destino no cabe) con `for update` -- reemplaza el candado global. Solo
// CARGAS (Sheets) queda por sincronizar -- numeroCarga se lee ANTES.
function corregirSoportesPedido(numPed, nuevosSoportes, nuevaSilueta, nuevaPosIni, tienda) {
  var candidatos = buscarFilasPorCampo('PEDIDOS', 'ped', numPed).filter(function(p) { return p.silueta; });
  var pedidoAntes = tienda ? candidatos.find(function(p) { return p.tienda === tienda; }) : (candidatos.length === 1 ? candidatos[0] : null);
  var posiciones = calcularPosiciones(nuevosSoportes);

  var r = _rpcPublic_('corregir_soportes_pedido', {
    p_num_ped: String(numPed), p_nuevos_soportes: nuevosSoportes, p_posiciones: posiciones,
    p_nueva_silueta: nuevaSilueta || null,
    p_nueva_pos_ini: (nuevaPosIni === undefined || nuevaPosIni === null || String(nuevaPosIni) === '') ? null : Number(nuevaPosIni),
    p_tienda: tienda || null
  });
  if (!r.ok) return r;
  var out = { ok: true, silueta: r.silueta, posIni: r.pos_ini, posFin: r.pos_fin };
  if (r.compartido) out.compartido = true;

  if (pedidoAntes) sincronizarPosicionEnCargaActiva(pedidoAntes.numeroCarga, pedidoAntes.ped, r.silueta, r.pos_ini, r.pos_fin);
  logActividad('CORREGIR_SOPORTES', 'Pedido ' + numPed + ': soportes corregidos → ' + r.silueta + (r.pos_ini === r.pos_fin ? r.pos_ini : r.pos_ini + '-' + r.pos_fin), 'admin');
  marcarResumenObsoleto();
  return out;
}

// ============================================================
// COMPACTAR SILUETAS (cerrar huecos, empezando por la A)
// ============================================================

/**
 * Calcula (SIN escribir nada) el plan de "compactar siluetas": recoloca los
 * pedidos que ya están en las siluetas FIJAS A-F, Y en cualquier "zona
 * libre" (nombre suelto creado a demanda cuando no cabe nada en A-F — SÍ
 * tiene posiciones físicas reales, a diferencia de "Recogidas"/"Ya
 * Cargados", que son las DOS únicas siluetas ficticias de verdad), para que
 * ocupen las primeras posiciones libres empezando por la silueta A, cerrando
 * los huecos que van dejando las entregas/salidas. Alcance deliberadamente
 * acotado: NI "Recogidas"/"Ya Cargados", NI pares que comparten posición
 * (reparto de delante Remansur: dos pedidos distintos con el mismo
 * silueta+posIni+posFin) — modelar bien "liberar el hueco de uno sin
 * desproteger al otro" añade una complejidad que no compensa para un caso ya
 * minoritario, así que esos pares se quedan tal cual están.
 *
 * Algoritmo: se recorre en orden de posición ACTUAL (silueta, posIni). Para
 * CADA pedido se libera temporalmente SU propio hueco actual antes de
 * buscarle el primer hueco libre desde la A (que puede volver a ser el
 * mismo, uno anterior que se acabe de liberar, u otro) — así en todo
 * momento el mapa de ocupación refleja fielmente la realidad: lo ya
 * procesado está en su sitio NUEVO, lo aún no procesado sigue en su sitio
 * VIEJO, y nunca hay un instante en que dos pedidos "planeen" el mismo
 * hueco real. Devuelve solo los movimientos que SÍ suponen un cambio real.
 *
 * BULTOS (posición 0, ubicación ilimitada, sin hueco real que cerrar): en
 * vez de compactar posiciones, se consolidan todos en la silueta A (para no
 * dejarlos dispersos por cada zona libre distinta que se haya creado) —
 * movimiento aparte, sin pasar por el mapa de ocupación de arriba.
 */
function previsualizarCompactarSiluetas() {
  // Rendimiento: filtrado real (silueta asignada), no leerHoja('PEDIDOS') entera.
  const pedidos = _esTablaPublic_('PEDIDOS')
    ? leerHojaPublicConFiltro_('PEDIDOS', 'silueta=not.is.null')
    : leerHoja('PEDIDOS');
  const candidatosBrutos = pedidos.filter(function(p) {
    return p.silueta && p.silueta !== 'Recogidas' && p.silueta !== 'Ya Cargados' &&
      Number(p.posIni) !== 0 && !ESTADOS_TERMINALES[p.estado];
  });

  // Orden de recorrido: primero las fijas A-F (en su orden), luego cualquier
  // zona libre encontrada en los datos, alfabéticamente — mismo criterio que
  // htmlCroquisSiluetaActual().
  const esFija = {};
  CONFIG.SILUETAS.forEach(function(s) { esFija[s] = true; });
  const zonasLibres = [];
  candidatosBrutos.forEach(function(p) {
    if (!esFija[p.silueta] && zonasLibres.indexOf(p.silueta) === -1) zonasLibres.push(p.silueta);
  });
  zonasLibres.sort(function(a, b) { return String(a).localeCompare(String(b)); });
  const ORDEN_SILUETAS = CONFIG.SILUETAS.concat(zonasLibres);
  function indiceSilueta(s) { var i = ORDEN_SILUETAS.indexOf(s); return i === -1 ? ORDEN_SILUETAS.length : i; }

  const grupoPorClave = {};
  candidatosBrutos.forEach(function(p) {
    var k = p.silueta + '|' + p.posIni + '|' + p.posFin;
    (grupoPorClave[k] = grupoPorClave[k] || []).push(p);
  });
  const candidatos = candidatosBrutos.filter(function(p) {
    return grupoPorClave[p.silueta + '|' + p.posIni + '|' + p.posFin].length === 1;
  });
  const excluidosCompartidos = candidatosBrutos.filter(function(p) {
    return grupoPorClave[p.silueta + '|' + p.posIni + '|' + p.posFin].length > 1;
  });

  candidatos.sort(function(a, b) {
    if (a.silueta !== b.silueta) return indiceSilueta(a.silueta) - indiceSilueta(b.silueta);
    return (Number(a.posIni) || 0) - (Number(b.posIni) || 0);
  });

  const ocupado = {}; // silueta -> {pos: true} (en memoria, no en hoja)
  ORDEN_SILUETAS.forEach(function(s) { ocupado[s] = {}; });

  function marcar(sil, ini, n, val) {
    for (var i = 0; i < n; i++) { ocupado[sil][ini + i] = val; }
  }
  // Sembrar con TODO lo que hay puesto AHORA MISMO: los compactables (se
  // irán liberando/reasignando uno a uno más abajo) y los excluidos por
  // compartir posición (quedan marcados para siempre, nunca se liberan, así
  // nadie más puede "planear" ocupar su sitio).
  candidatos.forEach(function(p) {
    marcar(p.silueta, Number(p.posIni), calcularPosiciones(parseJSON(p.soportes, [])).length || 1, true);
  });
  excluidosCompartidos.forEach(function(p) {
    marcar(p.silueta, Number(p.posIni), calcularPosiciones(parseJSON(p.soportes, [])).length || 1, true);
  });

  function hayHueco(sil, ini, n) {
    var max = posicionesDeSilueta(sil);
    if (ini + n - 1 > max) return false;
    for (var i = 0; i < n; i++) { if (ocupado[sil][ini + i]) return false; }
    return true;
  }
  function siguienteHueco(n) {
    for (var s = 0; s < ORDEN_SILUETAS.length; s++) {
      var sil = ORDEN_SILUETAS[s];
      var max = posicionesDeSilueta(sil);
      for (var pos = 1; pos + n - 1 <= max; pos++) {
        if (hayHueco(sil, pos, n)) return { silueta: sil, posIni: pos };
      }
    }
    return null;
  }

  const movimientos = [];
  candidatos.forEach(function(p) {
    var soportes = parseJSON(p.soportes, []);
    var numPos = calcularPosiciones(soportes).length || 1;
    marcar(p.silueta, Number(p.posIni), numPos, false); // liberar SU hueco actual antes de buscarle uno nuevo
    var hueco = siguienteHueco(numPos);
    if (!hueco) { marcar(p.silueta, Number(p.posIni), numPos, true); return; } // no debería pasar (su propio hueco recién liberado siempre vale); se queda donde está
    marcar(hueco.silueta, hueco.posIni, numPos, true);
    var posFinNueva = hueco.posIni + numPos - 1;
    if (hueco.silueta === p.silueta && hueco.posIni === Number(p.posIni)) return; // ya está en su sitio óptimo
    movimientos.push({
      ped: p.ped, tienda: p.tienda, transportista: p.transportista, flujo: p.flujo,
      siluetaVieja: p.silueta, posIniVieja: Number(p.posIni), posFinVieja: Number(p.posFin),
      siluetaNueva: hueco.silueta, posIniNueva: hueco.posIni, posFinNueva: posFinNueva
    });
  });

  const bultos = pedidos.filter(function(p) {
    return p.silueta && p.silueta !== 'Recogidas' && p.silueta !== 'Ya Cargados' &&
      Number(p.posIni) === 0 && p.silueta !== 'A' && !ESTADOS_TERMINALES[p.estado];
  });
  bultos.forEach(function(p) {
    movimientos.push({
      ped: p.ped, tienda: p.tienda, transportista: p.transportista, flujo: p.flujo,
      siluetaVieja: p.silueta, posIniVieja: 0, posFinVieja: 0,
      siluetaNueva: 'A', posIniNueva: 0, posFinNueva: 0
    });
  });

  return { movimientos: movimientos, totalRevisados: candidatos.length + bultos.length };
}

/**
 * Aplica un plan de compactado ya confirmado por el admin (el MISMO array
 * que devolvió previsualizarCompactarSiluetas, para que lo que se ve en la
 * confirmación sea EXACTAMENTE lo que se ejecuta). Revalida cada movimiento
 * en DOS frentes contra el estado EN VIVO justo antes de aplicarlo — si algo
 * cambió entre previsualizar y confirmar, ese movimiento se omite en vez de
 * aplicarse a ciegas sobre datos obsoletos:
 *   1) Origen: el pedido debe seguir en la silueta+posIni que asumía el plan.
 *   2) Destino: el hueco de llegada debe seguir libre (que no lo haya
 *      ocupado, mientras tanto, algo ajeno a este propio plan).
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION ya viven en Postgres
// (public). public.aplicar_compactar_siluetas(...) hace TODA la validación
// de origen/destino + escritura dentro de una única transacción SQL (sin
// candado de Apps Script -- la propia transacción serializa). calcularPosiciones
// sigue en Apps Script (igual que cerrarPedido/moverPedidoDeSilueta) -- se
// calcula aquí y se manda ya resuelto en cada movimiento.
function aplicarCompactarSiluetas(movimientos) {
  if (!movimientos || !movimientos.length) return { ok: true, aplicados: 0, movimientos: [], omitidos: [] };

  // Rendimiento (revisión adversarial 2026-09-05): filtrado real por los
  // ped de este plan concreto, no leerHoja('PEDIDOS') entera.
  var pedidos = buscarFilasPorCampo('PEDIDOS', 'ped', movimientos.map(function(m) { return m.ped; }));
  var porPed = {};
  pedidos.forEach(function(p) { porPed[String(p.ped)] = p; });

  var payload = movimientos.map(function(m) {
    var p = porPed[String(m.ped)];
    var posiciones = (Number(m.posIniNueva) === 0) ? [] : calcularPosiciones(parseJSON(p ? p.soportes : '', []));
    return {
      ped: String(m.ped), tienda: p ? p.tienda : (m.tienda || ''), flujo: p ? p.flujo : (m.flujo || ''),
      siluetaVieja: m.siluetaVieja, posIniVieja: m.posIniVieja, posFinVieja: m.posFinVieja,
      siluetaNueva: m.siluetaNueva, posIniNueva: m.posIniNueva, posFinNueva: m.posFinNueva,
      posiciones: posiciones
    };
  });

  var r = _rpcPublic_('aplicar_compactar_siluetas', { p_movimientos: payload });
  if (!r.ok) return r;

  // Sincronización de CARGAS EN LOTE -- mismo motivo que antes (evitar
  // leerHoja('CARGAS')+candado+escritura por cada pedido reubicado).
  var syncCarga = [];
  (r.movimientos || []).forEach(function(mov) {
    var p = porPed[String(mov.ped)];
    if (p && p.numeroCarga) syncCarga.push({ numeroCarga: p.numeroCarga, ped: mov.ped, silueta: mov.siluetaNueva, posIni: mov.posIniNueva, posFin: mov.posFinNueva });
  });
  if (syncCarga.length) _sincronizarPosicionesEnCargasLote(syncCarga);

  logActividad('COMPACTAR_SILUETAS', r.aplicados + ' pedidos reubicados' + ((r.omitidos && r.omitidos.length) ? ' · ' + r.omitidos.length + ' omitidos: ' + r.omitidos.join(', ') : ''), 'admin');
  marcarResumenObsoleto();
  return r;
}

/**
 * Croquis imprimible del estado ACTUAL de las siluetas (no depende de que se
 * acabe de compactar nada — funciona siempre, aunque ya esté todo compacto o
 * no se haya movido nunca un pedido). Pensado para reimprimir "cómo está
 * ahora mismo" si hace falta otra copia o se perdió la anterior. Excluye
 * bultos (posIni 0, sin hueco físico) y los cubos ficticios Recogidas/Ya
 * Cargados (mismo criterio que Store Delivery) — solo huecos físicos reales.
 */
function htmlCroquisSiluetaActual() {
  // Rendimiento: filtrado real (silueta asignada), no leerHoja('PEDIDOS') entera.
  var pedidosBase = _esTablaPublic_('PEDIDOS')
    ? leerHojaPublicConFiltro_('PEDIDOS', 'silueta=not.is.null')
    : leerHoja('PEDIDOS');
  var pedidos = pedidosBase.filter(function(p) {
    return p.silueta && p.silueta !== 'Recogidas' && p.silueta !== 'Ya Cargados' &&
      Number(p.posIni) > 0 && !ESTADOS_TERMINALES[p.estado];
  });
  pedidos.sort(function(a, b) {
    if (a.silueta !== b.silueta) {
      var ia = CONFIG.SILUETAS.indexOf(a.silueta), ib = CONFIG.SILUETAS.indexOf(b.silueta);
      if (ia === -1 && ib === -1) return String(a.silueta).localeCompare(String(b.silueta));
      if (ia === -1) return 1; // zonas libres al final
      if (ib === -1) return -1;
      return ia - ib;
    }
    return Number(a.posIni) - Number(b.posIni);
  });
  var fecha = Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM/yyyy HH:mm');

  var rows = '';
  pedidos.forEach(function(p) {
    var pos = (Number(p.posIni) === Number(p.posFin)) ? p.posIni : (p.posIni + '-' + p.posFin);
    rows += '<tr>' +
      '<td class="c-ped">' + esc(p.ped) + '</td>' +
      '<td class="c-tie">' + esc(p.tienda) + '</td>' +
      '<td class="c-sil">' + esc(p.silueta) + esc(pos) + '</td>' +
      '<td class="c-tie">' + esc(CONFIG.FLUJO_LABEL[p.flujo] || p.flujo) + '</td>' +
      '</tr>';
  });

  var css = 'body{font-family:Arial,sans-serif;margin:0;padding:20px}' +
    '@media print{body{padding:10px}.no-print{display:none}}' +
    'table{width:100%;border-collapse:collapse}' +
    'th{background:#e30613;color:#fff;padding:10px 8px;text-align:left;font-size:12px;text-transform:uppercase}' +
    'td{padding:10px 8px;border-bottom:1px solid #ddd;vertical-align:middle}' +
    '.c-ped{font-size:20px;font-weight:900;font-family:monospace;white-space:nowrap}' +
    '.c-tie{font-size:12px;color:#555}' +
    '.c-sil{font-size:22px;font-weight:900;text-align:center;font-family:monospace;white-space:nowrap;color:#e30613}' +
    '.info-bar{font-size:12px;color:#555;padding:6px 0 10px;margin-bottom:10px;border-bottom:1px solid #eee}' +
    '.info-bar b{color:#222}' +
    '.btn{margin-top:16px;padding:10px 24px;background:#e30613;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Croquis silueta actual</title>' +
    '<style>' + css + '</style></head><body>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #e30613;padding-bottom:8px;margin-bottom:8px">' +
      logoTaisaSVG('#111') +
      '<div style="text-align:right">' +
        '<div style="font-size:20px;font-weight:800;color:#e30613;line-height:1">Estado actual de siluetas</div>' +
        '<div style="font-size:13px;color:#555;margin-top:4px">' + fecha + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="info-bar"><b>' + pedidos.length + ' pedidos</b> colocados ahora mismo en silueta, ordenados de A en adelante</div>' +
    '<table><thead><tr><th>Nº Pedido</th><th>Tienda</th><th>Posición</th><th>Flujo</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<button class="btn no-print" onclick="window.print()">Imprimir</button>' +
    '</body></html>';
}

/**
 * Croquis imprimible (mismo patrón que htmlHojaCarga) para que el operario
 * reordene FÍSICAMENTE los pedidos exactamente como ha quedado el compactado
 * en el sistema. Ordenado por la posición ANTIGUA, para poder "caminar" la
 * estantería tal como está hoy y llevar cada pedido a su sitio nuevo.
 */
function htmlCroquisReorganizacion(movimientos) {
  if (!movimientos || !movimientos.length) return '<p>No hay movimientos que imprimir.</p>';
  var ordenados = movimientos.slice().sort(function(a, b) {
    if (a.siluetaVieja !== b.siluetaVieja) return CONFIG.SILUETAS.indexOf(a.siluetaVieja) - CONFIG.SILUETAS.indexOf(b.siluetaVieja);
    return Number(a.posIniVieja) - Number(b.posIniVieja);
  });
  var fecha = Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM/yyyy HH:mm');

  var rows = '';
  ordenados.forEach(function(m) {
    var posVieja = (m.posIniVieja === m.posFinVieja) ? m.posIniVieja : (m.posIniVieja + '-' + m.posFinVieja);
    var posNueva = (m.posIniNueva === m.posFinNueva) ? m.posIniNueva : (m.posIniNueva + '-' + m.posFinNueva);
    rows += '<tr>' +
      '<td class="c-ped">' + esc(m.ped) + '</td>' +
      '<td class="c-tie">' + esc(m.tienda) + '</td>' +
      '<td class="c-sil">' + esc(m.siluetaVieja) + esc(posVieja) + '</td>' +
      '<td class="c-fl">→</td>' +
      '<td class="c-sil c-nueva">' + esc(m.siluetaNueva) + esc(posNueva) + '</td>' +
      '</tr>';
  });

  var css = 'body{font-family:Arial,sans-serif;margin:0;padding:20px}' +
    '@media print{body{padding:10px}.no-print{display:none}}' +
    'table{width:100%;border-collapse:collapse}' +
    'th{background:#e30613;color:#fff;padding:10px 8px;text-align:left;font-size:12px;text-transform:uppercase}' +
    'td{padding:10px 8px;border-bottom:1px solid #ddd;vertical-align:middle}' +
    '.c-ped{font-size:20px;font-weight:900;font-family:monospace;white-space:nowrap}' +
    '.c-tie{font-size:12px;color:#555}' +
    '.c-sil{font-size:22px;font-weight:900;text-align:center;font-family:monospace;white-space:nowrap}' +
    '.c-nueva{color:#e30613}' +
    '.c-fl{font-size:18px;text-align:center;color:#888}' +
    '.info-bar{font-size:12px;color:#555;padding:6px 0 10px;margin-bottom:10px;border-bottom:1px solid #eee}' +
    '.info-bar b{color:#222}' +
    '.btn{margin-top:16px;padding:10px 24px;background:#e30613;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Croquis reorganización siluetas</title>' +
    '<style>' + css + '</style></head><body>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #e30613;padding-bottom:8px;margin-bottom:8px">' +
      logoTaisaSVG('#111') +
      '<div style="text-align:right">' +
        '<div style="font-size:20px;font-weight:800;color:#e30613;line-height:1">Reorganizar siluetas</div>' +
        '<div style="font-size:13px;color:#555;margin-top:4px">' + fecha + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="info-bar">Mueve cada pedido de su posición ACTUAL (columna izquierda) a la NUEVA (columna derecha, en rojo) · <b>' + ordenados.length + ' pedidos</b> a reubicar</div>' +
    '<table><thead><tr><th>Nº Pedido</th><th>Tienda</th><th>Posición actual</th><th></th><th>Posición nueva</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<button class="btn no-print" onclick="window.print()">Imprimir</button>' +
    '</body></html>';
}

// Flujo → transportista "oficial" del sistema (inverso de CONFIG.TRANSPORTISTAS_FLUJO).
var FLUJO_A_TRANSPORTISTA = {
  transporte: 'Correcaminos', instalacion: 'Correcaminos Instalaciones', pro: 'Correcaminos PRO',
  remansur_transporte: 'Remansur', remansur_pro: 'Remansur PRO',
  grua_remansur: 'GruaRemansur'
};

/**
 * Cambia el tipo de transporte (flujo) de un pedido, EN CUALQUIER ESTADO —
 * incluso si ya está colocado en una silueta. Si ya tiene silueta, también
 * actualiza sus filas de OCUPACION (mismo flujo que se pinta en el mapa).
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION/HIST_TRANSP ya viven en
// Postgres (public). public.cambiar_flujo_pedido(p_num_ped, p_nuevo_flujo,
// p_tienda) ya hace TODO lo de dentro (pedido+ocupación+historial, advisory
// lock propio -- no hace falta LockService aquí). Lo único que no puede
// hacer (CARGAS sigue en Sheets) es actualizar el snapshot de items de una
// carga activa -- se conserva esa llamada, igual que antes.
// FIX 2026-09-05 (revisión adversarial): sin tienda, un número de pedido
// duplicado entre tiendas se resolvía por 'ped' suelto (el de menor id) --
// podía cambiar el flujo del pedido de la tienda equivocada en silencio.
// Mismo criterio que liberarPedidoDeSilueta/moverPedidoDeSilueta: si se
// conoce la tienda se manda; si no y hay más de un candidato, la RPC
// devuelve ambigüedad en vez de adivinar.
function cambiarFlujoPedido(numPed, nuevoFlujo, tienda) {
  var nuevoTransportista = FLUJO_A_TRANSPORTISTA[nuevoFlujo];
  if (!nuevoTransportista) return { ok: false, error: 'Tipo de transporte no válido' };
  var candidatosAntes = buscarFilasPorCampo('PEDIDOS', 'ped', numPed);
  var pedidoAntes = tienda ? candidatosAntes.find(function(p) { return p.tienda === tienda; }) : (candidatosAntes.length === 1 ? candidatosAntes[0] : null);
  var r = _rpcPublic_('cambiar_flujo_pedido', { p_num_ped: String(numPed), p_nuevo_flujo: nuevoFlujo, p_tienda: tienda || null });
  if (!r.ok) return r;
  if (pedidoAntes && pedidoAntes.numeroCarga) {
    _sincronizarFlujoEnCargaActiva(pedidoAntes.numeroCarga, numPed, nuevoFlujo, nuevoTransportista);
  }
  logActividad('CAMBIO_FLUJO', 'Pedido ' + numPed + ': ' + (pedidoAntes ? pedidoAntes.flujo : '?') + ' → ' + nuevoFlujo, 'admin');
  marcarResumenObsoleto();
  return r;
}

/**
 * Igual que cambiarFlujoPedido pero para VARIOS pedidos de golpe (pegar una
 * lista + un flujo destino común). NO se implementa como un bucle llamando a
 * cambiarFlujoPedido N veces — esa función hace sus propias leerHoja(PEDIDOS)
 * + leerHoja(OCUPACION) completas POR CADA llamada, y repetir eso N veces es
 * exactamente el mismo patrón que causó el bug de timeout del croquis de
 * compactar siluetas (v86): con una lista larga, el cliente podría dar la
 * llamada por perdida a los 20s mientras el servidor sigue trabajando de
 * fondo. Aquí se lee cada hoja UNA sola vez y se escribe en lote
 * (actualizarColumnaLote, mismo primitivo que ya usa crearCarga).
 *
 * OJO nº de pedido NO único (mismo motivo ya documentado en anadirPedidoACarga,
 * v85): dos pedidos de tiendas DISTINTAS pueden compartir el mismo número. Si
 * el texto pegado trae un número que existe en más de una tienda, no hay forma
 * de saber cuál quería el admin — se omite como "ambiguo" en vez de adivinar
 * (evita el bug real que tuvo la primera versión de esta función: matchear
 * PEDIDOS por nº con un mapa simple, que se pisaba en silencio con un
 * duplicado, y actualizar OCUPACION también por nº suelto, que podía tocar el
 * flujo de un pedido de OTRA tienda que ni siquiera estaba en la lista
 * pegada). Para la actualización de OCUPACION se usa la pareja
 * pedido+tienda (que las filas de OCUPACION ya guardan, ver cerrarPedido)
 * — la MISMA unicidad que garantiza idPedido (tienda::número).
 */
// tienda (opcional, 2026-09-03): mismo patrón ya usado en agregarVisasMasivo/
// _resolverVisaPedido -- si se indica, desambigua TODA la tanda contra esa
// tienda; si se deja vacío, se autodetecta y solo se rechazan como
// "ambiguos" los números que de verdad existan en más de una tienda a la
// vez. Antes esta función no aceptaba tienda: un nº que coincidiera en dos
// tiendas (p.ej. Mijas Y Málaga -- caso real, no un dato corrupto, ver
// comentario de más arriba) se marcaba "ambiguo" sin dar NINGUNA forma de
// resolverlo desde esta pantalla -- bug real reportado 2026-09-03 (pedidos
// 291164/291463 de Mijas, coincidían con pedidos de Málaga).
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION/HIST_TRANSP ya viven en
// Postgres (public). public.cambiar_flujo_pedidos_masivo(p_numeros,
// p_nuevo_flujo, p_tienda) -- actualizada hoy mismo en Postgres con el
// parámetro p_tienda (mismo fix del bug real de pedidos ambiguos entre
// tiendas, ya aplicado en la versión Sheets antes de este corte). Hace
// pedidos+ocupación+historial. Solo CARGAS (Sheets) queda por sincronizar
// aquí -- numeroCarga no cambia con esta operación, se puede leer ANTES.
function cambiarFlujoPedidosMasivo(numeros, nuevoFlujo, tienda) {
  var nuevoTransportista = FLUJO_A_TRANSPORTISTA[nuevoFlujo];
  if (!nuevoTransportista) return { ok: false, error: 'Tipo de transporte no válido' };
  var lista = (numeros || []).map(function(n) { return String(n).trim(); }).filter(function(n) { return n; });
  if (!lista.length) return { ok: false, error: 'Sin pedidos' };

  var pedidosRaw = leerHoja('PEDIDOS');
  var gruposPorPed = {};
  pedidosRaw.forEach(function(p) {
    var key = String(p.ped);
    (gruposPorPed[key] = gruposPorPed[key] || []).push(p);
  });
  var conCargaActiva = [];
  var vistos = {};
  lista.forEach(function(n) {
    if (vistos[n]) return;
    vistos[n] = true;
    var grupo = gruposPorPed[n];
    if (tienda) grupo = (grupo || []).filter(function(p) { return p.tienda === tienda; });
    if (grupo && grupo.length === 1 && grupo[0].numeroCarga) conCargaActiva.push(grupo[0]);
  });

  var r = _rpcPublic_('cambiar_flujo_pedidos_masivo', { p_numeros: lista, p_nuevo_flujo: nuevoFlujo, p_tienda: tienda || null });
  if (!r.ok) return r;

  conCargaActiva.forEach(function(p) { _sincronizarFlujoEnCargaActiva(p.numeroCarga, p.ped, nuevoFlujo, nuevoTransportista); });

  logActividad('CAMBIO_FLUJO_MASIVO', r.cambiados + ' pedidos → ' + nuevoFlujo, 'admin');
  marcarResumenObsoleto();
  return r;
}

/**
 * Añade/edita el comentario de un pedido YA EXISTENTE (p.ej. uno ya colocado
 * en silueta) — mismo campo 'comentario' que usa registrarPedidoManual, para
 * dejar instrucciones complementarias al cargador. Se imprime en la hoja de
 * carga (ver htmlHojaCarga, que lo lee EN VIVO de PEDIDOS, no de un snapshot
 * congelado, así que sigue reflejándose aunque se edite después de generar
 * la carga). No cambia estado/silueta/flujo, solo el texto.
 */
function actualizarComentarioPedido(numPed, comentario) {
  var n = String(numPed).trim();
  if (!n) return { ok: false, error: 'Número de pedido requerido' };
  var pedidos = leerHoja('PEDIDOS');
  var pedido = pedidos.find(function(p) { return String(p.ped) === n; });
  if (!pedido) return { ok: false, error: 'Pedido no encontrado' };
  var texto = String(comentario || '').trim();
  actualizarFila('PEDIDOS', pedido._fila, { comentario: texto });
  logActividad('COMENTARIO_PEDIDO', 'Pedido ' + n + (texto ? ' → "' + texto + '"' : ' (comentario borrado)'), 'admin');
  marcarResumenObsoleto();
  return { ok: true, comentario: texto };
}

/**
 * Borra por completo un pedido (y sus líneas) que TODAVÍA NO ha tocado nadie:
 * ni tiene silueta asignada ni un operario ha marcado ninguna ubicación. Si
 * ya tiene silueta, se rechaza (para eso está "Devolver a almacenamiento"/
 * "Enviar a tienda"/"Desmarcar", que sí liberan el hueco). Si alguna línea
 * ya está marcada (PREPARADO/NO_SALE/etc.), también se rechaza para no
 * destruir el trabajo ya hecho por un operario.
 *
 * OJO: la comprobación mira las LÍNEAS, no pedido.estado — un pedido
 * COMPLETADO_LISTO recién "Desmarcado" desde liberarPedidoDeSilueta vuelve a
 * estar sin silueta pero con estado COMPLETADO_LISTO (no PENDIENTE); mirar
 * solo el estado bloqueaba SIEMPRE ese caso con el mensaje "un operario ya ha
 * empezado a prepararlo", aunque sus líneas siguieran intactas — bug real:
 * "no me deja borrar" un pedido que se acababa de liberar sin más.
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/LINEAS ya viven en Postgres (public).
// public.borrar_pedido_no_sacado(p_num_ped, p_tienda) -- misma lógica exacta,
// verificada línea a línea. El candado ya no hace falta: la RPC hace
// `for update` sobre la fila dentro de su propia transacción.
// FIX 2026-09-05 (revisión adversarial): sin p_tienda, un número de pedido
// duplicado entre tiendas se resolvía SOLO por 'ped' (el de menor id) -- podía
// borrar el pedido de la tienda equivocada en silencio. Ahora se manda
// siempre (null si el llamador no la conoce, cae al aviso de ambigüedad).
function borrarPedidoNoSacado(numPed, tienda) {
  var r = _rpcPublic_('borrar_pedido_no_sacado', { p_num_ped: String(numPed), p_tienda: tienda || null });
  if (r.ok) marcarResumenObsoleto();
  return r;
}

// ============================================================
// PEDIDOS ATASCADOS (mantenimiento manual, admin)
// ============================================================
/**
 * Lista pedidos "atascados": PENDIENTE de verdad (sin silueta, sin carga,
 * sin estado terminal) pero sin tocar desde hace `diasMinimo` días (por
 * defecto 7) -- ver detectar_pedidos_atascados (supabase/migrations/
 * pieza4e_pedidos_atascados.sql). Caso real que motivó esto (2026-09-07):
 * pedido 286601/Mijas, entregado el 21/07 (carga 126, cerrada), reabierto
 * el 21/08 y abandonado desde entonces -- ninguna herramienta admin
 * existente lo detectaba ni lo dejaba borrar (borrarPedidoNoSacado exige
 * que TODAS sus líneas sigan en PENDIENTE, y este tenía una ya PREPARADO
 * de aquel picking real). `yaEntregadoAntes` es la señal fuerte de "esto es
 * un fantasma, no trabajo real en peligro de perderse".
 */
function listarPedidosAtascados(diasMinimo) {
  var r = _rpcPublic_('detectar_pedidos_atascados', { p_dias_minimo: diasMinimo || 7 });
  return (r || []).map(function(p) {
    return {
      id: p.id, ped: p.ped, tienda: p.tienda, estado: p.estado, nLin: p.n_lin,
      diasDesdeActualizado: p.dias_desde_actualizado, yaEntregadoAntes: p.ya_entregado_antes
    };
  });
}

/** Borra un pedido atascado (ver listarPedidosAtascados) por su id real (tienda::ped, sin ambigüedad). */
function borrarPedidoAtascado(id) {
  var r = _rpcPublic_('borrar_pedido_atascado', { p_id: id });
  if (r && r.ok) {
    logActividad('BORRAR_PEDIDO_ATASCADO', 'Pedido ' + r.ped + ' (' + r.tienda + ') borrado por atascado · ' + r.lineasBorradas + ' línea(s)', 'admin');
    marcarResumenObsoleto();
  }
  return r;
}

/**
 * Lista huecos "fantasma": filas de OCUPACION_SILUETAS que bloquean una
 * posición física sin que haya un pedido real ocupándola de verdad ahora
 * mismo (pedido inexistente, ya entregado/resuelto, o movido a otra
 * silueta sin que esta fila se liberara) -- ver detectar_ocupacion_fantasma
 * (supabase/migrations/pieza4f_ocupacion_fantasma.sql). Caso real
 * (2026-09-11): pedido 287607/Málaga, entregado hace 2 días, seguía
 * bloqueando B/1 para siempre -- mismo tipo de incidente que
 * limpiarHuecoFantasma976313 (arreglado a mano una vez, sin herramienta
 * hasta ahora).
 */
function listarOcupacionFantasma() {
  var r = _rpcPublic_('detectar_ocupacion_fantasma', {});
  return (r || []).map(function(o) {
    return {
      silueta: o.silueta, pos: o.pos, layer: o.layer, pedido: o.pedido, tienda: o.tienda,
      flujo: o.flujo, pedidoId: o.pedido_id, estadoPedido: o.estado_pedido, siluetaPedido: o.silueta_pedido
    };
  });
}

/** Libera un hueco fantasma (ver listarOcupacionFantasma) por su clave real silueta+pos+layer. */
function liberarOcupacionFantasma(silueta, pos, layer) {
  var r = _rpcPublic_('liberar_ocupacion_fantasma', { p_silueta: silueta, p_pos: String(pos), p_layer: layer });
  if (r && r.ok) {
    logActividad('LIBERAR_OCUPACION_FANTASMA', 'Hueco ' + silueta + '/' + pos + '/' + layer + ' liberado (fantasma)', 'admin');
    marcarResumenObsoleto();
  }
  return r;
}

// ============================================================
// PURGA DE PEDIDOS ANTIGUOS (mantenimiento periódico)
// ============================================================
var PURGA_DIAS_ANTIGUEDAD = 90;

/**
 * Borra de PEDIDOS y LINEAS_PREPARACION los pedidos RESUELTOS (estado
 * terminal: ver ESTADOS_TERMINALES) con más de PURGA_DIAS_ANTIGUEDAD días
 * desde su último 'actualizado'. El histórico de esos pedidos sigue
 * disponible en el archivo diario de Drive (SnapshotDiario.gs) — este
 * borrado es solo para que PEDIDOS/LINEAS no crezcan sin límite: TODA la
 * app lee esas hojas enteras en casi cada petición, así que con los años
 * irían ralentizando cada vez más si nunca se archivara nada de lo viejo.
 * Invocada periódicamente desde SnapshotDiario.gs (ejecutarPurgaSiToca).
 *
 * Seguridad: NUNCA borra un pedido que todavía tenga alguna fila en
 * OCUPACION_SILUETAS a su nombre — un pedido terminal siempre debería tener
 * el hueco ya liberado; si hubiera una inconsistencia real, es preferible
 * dejarlo para revisión manual (queda igual que antes) que borrarlo y
 * perder el rastro de esa fila huérfana. Qué-se-borra y el borrado en sí se
 * calculan sobre la MISMA lectura, DENTRO del candado (no una decisión
 * tomada antes y aplicada después) — así la elegibilidad de cada pedido se
 * comprueba justo antes de escribir, cerrando la ventana en la que algo
 * pudiera cambiar entre decidir y borrar (hallazgo de la revisión adversarial).
 * Batch en 3 pasos (mismo patrón que liberarPosicionesLote): 1 lectura por
 * hoja + 1 reescritura de lo que se conserva + 1 deleteRows del sobrante —
 * así el coste no depende de cuántos pedidos se borren.
 *
 * Riesgo residual ACEPTADO conscientemente (no corregido): este borrado
 * desplaza hacia arriba los números de fila físicos de PEDIDOS/LINEAS por
 * debajo de lo borrado. Otras funciones (moverPedidoDeSilueta,
 * liberarPedidoDeSilueta, confirmarEntregas) leen el número de fila de un
 * pedido y escriben sobre ÉL más tarde SIN este mismo candado — si una de
 * ellas estuviera a medias justo cuando esta purga corre, podría escribir
 * sobre la fila física equivocada. Se acepta por lo mismo que ya se aceptó
 * en confirmarEntregas/quitarPedidoDeCarga (ver v64): envolver esas
 * funciones críticas ya verificadas en un candado exterior arriesgaría un
 * anidamiento de locks (moverPedidoDeSilueta ya llama internamente a
 * sincronizarPosicionEnCargaActiva, que pide su PROPIO candado). Mitigado en
 * la práctica porque la operativa está CERRADA de 22:00 a 06:00 (confirmado
 * por el usuario: no se gestiona nada en ese tramo) y la purga automática
 * corre a las 23:00, de lleno dentro de esa ventana — por eso mismo, si se
 * ejecuta probarPurgaAhora() a mano, hacerlo TAMBIÉN dentro de 22:00–06:00.
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/LINEAS ya viven en Postgres (public).
// public.purgar_pedidos_antiguos() (supabase/migrations/2026081402_...sql,
// promovida a public) replica el MISMO criterio exacto que este cuerpo tenía
// -- verificado línea a línea antes de sustituirlo. Toda la gimnasia de
// deleteRows/clearContent era solo para esquivar límites de la API de
// Sheets; un DELETE en Postgres no los tiene.
function purgarPedidosAntiguos() {
  var r = _rpcPublic_('purgar_pedidos_antiguos', {});
  // FIX 2026-09-05 (revisión adversarial): la RPC solo escribía en
  // public.log_actividad -- tabla que nadie lee, LOG_ACTIVIDAD real sigue en
  // Sheets -- así que la purga nocturna quedaba invisible en el log de
  // verdad. logActividad() SÍ escribe donde se mira de verdad.
  if (r && r.ok) {
    logActividad('PURGA_PEDIDOS', (r.borrados || 0) + ' pedido(s) purgado(s)' + (r.omitidos ? ' · ' + r.omitidos + ' omitido(s) (con ocupación huérfana)' : ''), '');
  }
  return r;
}

function marcarPedidoEntregado(idPedido) {
  const pedidos = leerHoja('PEDIDOS');
  const p = pedidos.find(function(x) { return x.id === idPedido; });
  if (p) {
    actualizarFila('PEDIDOS', p._fila, {
      estado: 'ENTREGADO', silueta: '', posIni: '', posFin: '',
      actualizado: new Date().toISOString()
    });
  }
}

/**
 * Obtiene la carga activa (la más reciente en estado GENERADA). [compat]
 */
function obtenerCargaActiva() {
  const cargas = leerHoja('CARGAS').filter(function(c) { return c.estado === 'GENERADA'; });
  if (!cargas.length) return null;
  cargas.sort(function(a, b) { return new Date(b.fecha) - new Date(a.fecha); });
  const c = cargas[0];
  return { id: c.id, numCarga: Number(c.numCarga), fecha: c.fecha, estado: c.estado, responsable: c.responsable || '', cargador: c.cargador || '', items: parseJSON(c.items, []) };
}

/**
 * Lista TODAS las cargas activas (estado GENERADA) en forma ligera, para que
 * administración pueda tener varias cargas a la vez.
 */
function obtenerCargasActivas() {
  return _cargasActivasDesde(leerHoja('CARGAS'));
}

function _cargasActivasDesde(cargasRaw) {
  return cargasRaw.filter(function(c) { return c.estado === 'GENERADA'; })
    .map(function(c) {
      var items = parseJSON(c.items, []);
      var tiendas = {};
      items.forEach(function(it) { tiendas[it.tienda] = true; });
      return { id: c.id, numCarga: Number(c.numCarga), fecha: c.fecha, nPedidos: items.length, tiendas: Object.keys(tiendas), responsable: c.responsable || '', cargador: c.cargador || '' };
    })
    .sort(function(a, b) { return a.numCarga - b.numCarga; });
}

/**
 * Devuelve una carga concreta por su id (con todos sus items).
 */
function obtenerCarga(idCarga) {
  var c = leerHoja('CARGAS').find(function(x) { return x.id === idCarga; });
  if (!c) return null;
  return { id: c.id, numCarga: Number(c.numCarga), fecha: c.fecha, estado: c.estado, responsable: c.responsable || '', cargador: c.cargador || '', items: parseJSON(c.items, []) };
}

/**
 * Actualiza el cargador de plataforma asignado a una carga.
 */
function actualizarCargador(idCarga, cargador) {
  var cargas = leerHoja('CARGAS');
  var c = cargas.find(function(x) { return x.id === idCarga; });
  if (!c) return { ok: false, error: 'Carga no encontrada' };
  actualizarFila('CARGAS', c._fila, { cargador: cargador || '' });
  return { ok: true };
}

/**
 * Actualiza el chófer del vehículo asignado a una carga.
 */
function actualizarChofer(idCarga, chofer) {
  var cargas = leerHoja('CARGAS');
  var c = cargas.find(function(x) { return x.id === idCarga; });
  if (!c) return { ok: false, error: 'Carga no encontrada' };
  actualizarFila('CARGAS', c._fila, { responsable: chofer || '' });
  return { ok: true };
}

// ============================================================
// HOJA DE CARGA IMPRIMIBLE (generada en servidor)
// ============================================================
// IMPORTANTE: este HTML se genera AQUÍ (servidor) y no en Index.html.
// Si se incrustan etiquetas <style>/<!DOCTYPE>/</body> dentro del <script>
// servido por HtmlService, Apps Script rompe la ejecución del JS de la página.

// Genera un código de barras Code39 REAL (escaneable) en SVG.
var CODE39 = {
  '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw',
  '5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
  'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn',
  'F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
  'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn',
  'P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
  'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn',
  'Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn'
};
function barcodeSVG(num) {
  var data = '*' + String(num).toUpperCase() + '*';
  var narrow = 2, wide = 5, h = 54, x = 0, bars = '';
  for (var i = 0; i < data.length; i++) {
    var pat = CODE39[data.charAt(i)];
    if (!pat) continue;
    for (var j = 0; j < 9; j++) {
      var w = (pat.charAt(j) === 'w') ? wide : narrow;
      if (j % 2 === 0) bars += '<rect x="' + x + '" y="0" width="' + w + '" height="' + h + '" fill="#000"/>';
      x += w;
    }
    x += narrow; // separación entre caracteres
  }
  var total = x;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + total + '" height="' + (h + 15) + '" viewBox="0 0 ' + total + ' ' + (h + 15) + '">' +
    '<rect width="' + total + '" height="' + (h + 15) + '" fill="#fff"/>' + bars +
    '<text x="' + (total / 2) + '" y="' + (h + 13) + '" font-size="12" text-anchor="middle" font-family="monospace" letter-spacing="2">' + esc(num) + '</text></svg>';
}

// Logo TAISA Logistics como SVG (recreación). colorTexto = color de la palabra "TAISA".
function logoTaisaSVG(colorTexto) {
  return '<svg width="178" height="48" viewBox="0 0 300 80" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="2" y="7" width="62" height="62" rx="8" fill="#e30613"/>' +
    '<rect x="15" y="23" width="38" height="11" fill="#fff"/>' +
    '<rect x="28" y="23" width="12" height="37" fill="#fff"/>' +
    '<path d="M68 26 L88 40 L68 54 Z" fill="#e30613"/>' +
    '<text x="98" y="44" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="35" fill="' + colorTexto + '">TAISA</text>' +
    '<text x="100" y="65" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="16.5" letter-spacing="3" fill="#e30613">LOGISTICS</text>' +
    '</svg>';
}

function htmlHojaCarga(carga) {
  if (!carga || !carga.items) return '<p>Sin datos de carga.</p>';
  var numCarga = carga.numCarga || 1;
  var fecha;
  try { fecha = Utilities.formatDate(new Date(carga.fecha), 'Europe/Madrid', 'dd/MM/yyyy'); }
  catch (e) { fecha = String(carga.fecha || ''); }
  var chofer = carga.responsable || '';
  var nombreCargador = carga.cargador || '';

  // Comentarios EN VIVO de PEDIDOS (no del snapshot congelado de carga.items):
  // así, si se añade o edita un comentario DESPUÉS de generar la carga, la
  // hoja impresa siempre muestra la instrucción más reciente para el cargador.
  var comentarioPorPed = {};
  leerHoja('PEDIDOS').forEach(function(p) {
    if (p.comentario) comentarioPorPed[String(p.ped)] = p.comentario;
  });

  var rows = '';
  for (var i = 0; i < carga.items.length; i++) {
    var item = carga.items[i];
    var sopsTxt = '—';
    if (item.soportes && item.soportes.length) {
      var parts = [];
      for (var j = 0; j < item.soportes.length; j++) {
        var s = item.soportes[j];
        parts.push((s.cant || '') + ' x ' + esc(s.tipo || s.tipoId || ''));
      }
      sopsTxt = parts.join('<br>');
    }
    var posStr = (item.posIni === item.posFin) ? item.posIni : (item.posIni + '-' + item.posFin);
    rows += '<tr>' +
      '<td class="c-ped">' + esc(item.ped) + '</td>' +
      '<td class="c-tie">' + esc(item.tienda) + '<br><span class="t-sub">' + esc(item.transportista) + '</span></td>' +
      '<td class="c-sil">' + esc(item.silueta) + '</td>' +
      '<td class="c-pos">' + esc(posStr) + '</td>' +
      '<td class="c-sop">' + sopsTxt + '</td>' +
      '<td class="c-bc">' + barcodeSVG(item.ped) + '</td>' +
      '</tr>';
    var nota = comentarioPorPed[String(item.ped)];
    if (nota) {
      rows += '<tr class="fila-nota"><td colspan="6" class="c-nota">📌 ' + esc(nota) + '</td></tr>';
    }
  }

  var css = 'body{font-family:Arial,sans-serif;margin:0;padding:20px}' +
    '@media print{body{padding:10px}.no-print{display:none}}' +
    'table{width:100%;border-collapse:collapse}' +
    'th{background:#e30613;color:#fff;padding:10px 8px;text-align:left;font-size:12px;text-transform:uppercase}' +
    'td{padding:10px 8px;border-bottom:1px solid #ddd;vertical-align:middle}' +
    '.fila-nota td{padding:2px 8px 10px 8px;border-bottom:2px solid #e30613}' +
    '.c-nota{font-size:12px;font-weight:700;color:#e30613;background:#fff5f5}' +
    '.c-ped{font-size:22px;font-weight:900;font-family:monospace;white-space:nowrap}' +
    '.c-tie{font-size:11px;color:#555}.t-sub{font-size:10px;color:#888}' +
    '.c-sil{font-size:26px;font-weight:900;color:#e30613;text-align:center}' +
    '.c-pos{font-size:22px;font-weight:700;text-align:center;font-family:monospace}' +
    '.c-sop{font-size:11px}.c-bc{text-align:center}' +
    '.info-bar{display:flex;gap:32px;font-size:12px;color:#555;padding:6px 0 10px;margin-bottom:10px;border-bottom:1px solid #eee}' +
    '.info-bar b{color:#222}' +
    '.btn{margin-top:16px;padding:10px 24px;background:#e30613;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}';

  var infoBar = '<div class="info-bar">' +
    '<span>Chofer del vehículo: <b>' + esc(chofer || '—') + '</b></span>' +
    '<span>Cargador de plataforma: <b>' + esc(nombreCargador || '—') + '</b></span>' +
    '<span>Carga: <b>' + numCarga + '</b></span>' +
    '<span>Pedidos: <b>' + carga.items.length + '</b></span>' +
    '</div>';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Hoja Carga ' + numCarga + '</title>' +
    '<style>' + css + '</style></head><body>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #e30613;padding-bottom:8px;margin-bottom:8px">' +
      logoTaisaSVG('#111') +
      '<div style="text-align:right">' +
        '<div style="font-size:22px;font-weight:800;color:#e30613;line-height:1">Leroy Merlin Málaga</div>' +
        '<div style="font-size:13px;color:#555;margin-top:4px">' + fecha + '</div>' +
      '</div>' +
    '</div>' +
    infoBar +
    '<table><thead><tr><th>Nº Pedido</th><th>Tienda / Trans.</th><th>Silueta</th><th>Posición</th><th>Soportes</th><th>Código barras</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<button class="btn no-print" onclick="window.print()">Imprimir</button>' +
    '</body></html>';
}

// ============================================================
// STORE DELIVERY (plantilla de reparto Delivery/Vonzu/Instalación/PRO)
// ============================================================
/**
 * Pedidos de una tienda, ya en silueta, colocados HOY, que encajan en el
 * grupo de flujo pedido — "Delivery Correcaminos" (Instalación + PRO) o
 * "Delivery Remansur" (Transporte + PRO Remansur). Es un agrupamiento propio
 * de ESTA plantilla, no toca el flujo real del pedido ni ningún otro filtro
 * de la app.
 */
function obtenerStoreDelivery(tienda, flujoGrupo) {
  var flujosPermitidos = (flujoGrupo === 'remansur')
    ? { remansur_transporte: true, remansur_pro: true }
    : { transporte: true, instalacion: true, pro: true };
  // Rendimiento: filtrado real (tienda + silueta asignada), no leerHoja('PEDIDOS') entera.
  var pedidosBase = _esTablaPublic_('PEDIDOS')
    ? leerHojaPublicConFiltro_('PEDIDOS', 'tienda=eq.' + encodeURIComponent(tienda) + '&silueta=not.is.null')
    : leerHoja('PEDIDOS');
  var pedidos = pedidosBase.filter(function(p) {
    // Excluye SOLO los dos cubos ficticios de verdad (mismos literales que
    // corregirSoportesPedido/registrarRecogidasMasivo/registrarYaCargadosMasivo)
    // — NO todo lo que no esté en CONFIG.SILUETAS, porque "zona libre" (creada
    // a demanda cuando no caben todos los pedidos en A-F) también usa un
    // nombre fuera de esa lista pero SÍ es una silueta real con posiciones
    // físicas, y esos pedidos también necesitan su reparto.
    // Si ya se imprimió HOY en un pase anterior de Store Delivery (Málaga por
    // la mañana, otro repaso más tarde para lo que se ha ido metiendo en
    // silueta desde entonces...), no debe volver a salir en el pase nuevo.
    return p.tienda === tienda && flujosPermitidos[p.flujo] && p.silueta &&
      p.silueta !== 'Recogidas' && p.silueta !== 'Ya Cargados' && esHoyMadrid(p.actualizado) &&
      !esHoyMadrid(p.sdImpreso);
  });
  pedidos.sort(function(a, b) {
    if (a.silueta !== b.silueta) return String(a.silueta).localeCompare(String(b.silueta));
    return (Number(a.posIni) || 0) - (Number(b.posIni) || 0);
  });
  var nombrePorTipoId = {};
  CONFIG.SOPORTES.forEach(function(s) { nombrePorTipoId[s.id] = s.nombre; });
  return pedidos.map(function(p) {
    var soportes = parseJSON(p.soportes, []);
    var textoSoportes = soportes
      .filter(function(s) { return Number(s.cant) > 0; })
      .map(function(s) { return Number(s.cant) + '× ' + (nombrePorTipoId[s.tipoId] || s.tipoId); })
      .join(', ');
    return {
      id: p.id, ped: p.ped, tienda: p.tienda, flujo: p.flujo,
      silueta: p.silueta, posIni: p.posIni, posFin: p.posFin,
      tipoEntrega: p.tipoEntrega || '',
      // Parcial DE VERDAD, en cualquiera de sus DOS sentidos reales -- no
      // confundir con la casilla manual "Parcial"/"Vonzu" de esta misma
      // plantilla (esa es una elección de la oficina sobre el TIPO de
      // entrega, esto es el estado/origen REAL del pedido):
      //   1) p.estado === 'PARCIAL_LISTO' -- le faltaron artículos al
      //      prepararlo (algo no salió).
      //   2) p.parcial === true -- se dio de alta A PROPÓSITO con solo
      //      algunas direcciones elegidas (ver clfToggleParcial/Clasificador),
      //      aunque haya salido 100% completo de lo que SÍ se pidió que
      //      trajera. Bug real corregido 2026-07-30: antes solo miraba (1),
      //      así que estos pedidos no salían marcados como parciales aquí y
      //      la retirada no quedaba bloqueada -- para la plantilla pueda
      //      avisar y para que no se pueda marcar "Delivery" en uno que en
      //      realidad no está completo (ver descargarProgramaRetiradas en el
      //      cliente).
      parcialReal: p.estado === 'PARCIAL_LISTO' || p.parcial === true || p.parcial === 'true',
      soportesTexto: textoSoportes
    };
  });
}

/**
 * Guarda de golpe la elección Delivery/Vonzu de varios pedidos (checkboxes de
 * la plantilla Store Delivery, antes de imprimir). cambios: [{id, tipo}],
 * tipo: 'delivery' | 'vonzu' | '' (sin marcar). Este es el único punto donde
 * se llama justo al pulsar "Guardar e imprimir" (imprimirStoreDelivery), así
 * que aquí mismo se marca sdImpreso = hoy — para que un pase posterior de
 * Store Delivery el MISMO día no vuelva a sacar estos pedidos (obtenerStoreDelivery
 * los excluye si ya salieron hoy).
 */
function guardarTiposEntregaLote(cambios) {
  if (!cambios || !cambios.length) return { ok: true, guardados: 0 };
  // Rendimiento: filtrado real por los ids de este lote, no leerHoja() entera.
  // sincronizarPedidoSupabase_ quitado: actualizarFila ya escribe directo a
  // Postgres, ese sync era el puente Fase 1, redundante desde el corte.
  var porId = {};
  buscarFilasPorCampo('PEDIDOS', 'id', cambios.map(function(c) { return c.id; })).forEach(function(p) { porId[p.id] = p; });
  var ahora = new Date().toISOString();
  var n = 0;
  cambios.forEach(function(c) {
    var p = porId[c.id];
    if (!p) return;
    actualizarFila('PEDIDOS', p._fila, { tipoEntrega: c.tipo || '', sdImpreso: ahora });
    n++;
  });
  if (n) marcarResumenObsoleto();
  return { ok: true, guardados: n };
}

/**
 * Hoja imprimible "STORE DELIVERY <código tienda>": Nº PC + Ubicación +
 * Soportes (informativas, para controlar el pedido en almacén) + columna
 * Delivery (elección manual, ya guardada) + segunda columna manual que
 * cambia según el grupo (Parcial en Correcaminos, Vonzu en Remansur) +
 * Instalación/Transporte/PRO (automáticas, según flujo real del pedido).
 * Los pedidos que de verdad están PARCIAL_LISTO (les faltó algún artículo al
 * prepararlos -- no confundir con la casilla manual "Parcial"/"Vonzu", que es
 * el tipo de entrega elegido por oficina) se marcan con un aviso junto al
 * número, para que no se confirme como retirada completa algo que no lo es.
 * Forzada a vertical (@page portrait) — a diferencia de la hoja de carga,
 * que va en horizontal.
 */
function htmlHojaStoreDelivery(tienda, flujoGrupo, pedidos, horaInicio) {
  var esRemansurGrupo = (flujoGrupo === 'remansur');
  var agencia = esRemansurGrupo ? 'REMANSUR' : 'CORRECAMINOS';
  var labelCheck2 = esRemansurGrupo ? 'VONZU' : 'PARCIAL';
  var valorCheck2 = esRemansurGrupo ? 'vonzu' : 'parcial';
  var codigo = codigoTienda(tienda) || tienda;
  var fecha;
  try { fecha = Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM/yyyy'); }
  catch (e) { fecha = ''; }

  var rows = '';
  (pedidos || []).forEach(function(p) {
    var esInstalacion = p.flujo === 'instalacion';
    var esTransporte = p.flujo === 'transporte';
    var esPro = (p.flujo === 'pro' || p.flujo === 'remansur_pro');
    var ubicacionTxt = (p.silueta && p.silueta !== '—')
      ? (Number(p.posIni) === 0 ? esc(p.silueta) + ' · 📦' : esc(p.silueta) + esc(p.posIni) + (p.posIni !== p.posFin ? '–' + esc(p.posFin) : ''))
      : '—';
    // La columna PARCIAL/VONZU normalmente solo refleja la elección manual de
    // oficina (tipoEntrega). Si el pedido es parcial DE VERDAD (parcialReal),
    // se marca también aquí sola -- pero SOLO cuando esta columna es de
    // verdad "PARCIAL" (grupo no-Remansur): en el grupo Remansur esa misma
    // columna es "VONZU" (un tipo de transporte, no "le faltó algo"), marcarla
    // ahí sería una información falsa para el almacén, no un aviso de más.
    var marcaCheck2 = (p.tipoEntrega === valorCheck2) || (p.parcialReal && !esRemansurGrupo);
    rows += '<tr' + (p.parcialReal ? ' class="fila-parcial"' : '') + '>' +
      '<td class="c-ped">' +
        '<span class="num">' + esc(p.ped) + (p.parcialReal ? ' <span class="aviso-parcial">⚠ PARCIAL</span>' : '') + '</span>' +
        '<span class="barcode">' + barcodeSVG(p.ped) + '</span>' +
      '</td>' +
      '<td class="c-ubic">' + ubicacionTxt + '</td>' +
      '<td class="c-sop">' + esc(p.soportesTexto || '') + '</td>' +
      '<td class="c-chk">' + (p.tipoEntrega === 'delivery' ? '✓' : '') + '</td>' +
      '<td class="c-chk">' + (marcaCheck2 ? '✓' : '') + '</td>' +
      '<td class="c-chk">' + (esInstalacion ? '✓' : '') + '</td>' +
      '<td class="c-chk">' + (esTransporte ? '✓' : '') + '</td>' +
      '<td class="c-chk">' + (esPro ? '✓' : '') + '</td>' +
      '<td class="c-inc"></td>' +
      '<td class="c-ok"></td>' +
      '</tr>';
  });
  // Filas en blanco de sobra, para poder anotar pedidos a mano en almacén.
  for (var i = 0; i < 6; i++) {
    rows += '<tr><td class="c-ped">&nbsp;</td><td class="c-ubic"></td><td class="c-sop"></td><td class="c-chk"></td><td class="c-chk"></td><td class="c-chk"></td><td class="c-chk"></td><td class="c-chk"></td><td class="c-inc"></td><td class="c-ok"></td></tr>';
  }

  var css = 'body{font-family:Arial,sans-serif;margin:0;padding:20px}' +
    '@page{size:portrait}' +
    '@media print{body{padding:10px}.no-print{display:none}}' +
    'table{width:100%;border-collapse:collapse;margin-top:14px}' +
    'th{border:1px solid #999;padding:8px 6px;text-align:center;font-size:11px;text-transform:uppercase;background:#f2f2f2}' +
    'th.grp-oficina{background:#e30613;color:#fff}' +
    'th.grp-almacen{background:#333;color:#fff}' +
    'td{border:1px solid #999;padding:11px 6px;text-align:center;vertical-align:middle;height:24px}' +
    '.c-ped{font-size:16px;font-weight:900;font-family:monospace;text-align:left;padding:5px 4px 5px 8px}' +
    '.c-ped .num{display:block;line-height:1.15}' +
    '.c-ped .barcode{display:block;margin-top:3px;line-height:0}' +
    '.c-ped .barcode svg{display:block;height:22px;width:auto}' +
    '.c-ubic{font-size:12px;font-weight:700;color:#333;white-space:nowrap}' +
    '.c-sop{font-size:11px;color:#333;text-align:left;padding-left:8px}' +
    '.c-chk{font-size:18px;font-weight:900;color:#e30613}' +
    '.fila-parcial{background:#fff3f3}' +
    '.aviso-parcial{display:inline-block;font-size:10px;font-weight:900;color:#fff;background:#e30613;border-radius:4px;padding:2px 6px;margin-left:6px;vertical-align:middle}' +
    '.info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #999;font-size:12px;margin-top:10px}' +
    '.info-grid div{padding:8px 10px;border-right:1px solid #999;border-bottom:1px solid #999}' +
    '.info-grid div:nth-child(3n){border-right:none}' +
    '.titulo{font-size:26px;font-weight:900;text-align:center;padding:16px 0}' +
    '.btn{margin-top:16px;padding:10px 24px;background:#e30613;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Store Delivery ' + esc(codigo) + '</title>' +
    '<style>' + css + '</style></head><body>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #e30613;padding-bottom:8px;margin-bottom:8px">' +
      logoTaisaSVG('#111') +
      '<div style="text-align:right">' +
        '<div style="font-size:18px;font-weight:800;color:#e30613;line-height:1">Leroy Merlin Málaga</div>' +
      '</div>' +
    '</div>' +
    '<div class="info-grid">' +
      '<div>FECHA: <b>' + esc(fecha) + '</b></div>' +
      '<div>HORA INICIO: <b>' + esc(horaInicio || '') + '</b></div>' +
      '<div>OPERARIO: </div>' +
      '<div>AGENCIA: <b>' + esc(agencia) + '</b></div>' +
      '<div>HORA FIN: </div>' +
      '<div>&nbsp;</div>' +
    '</div>' +
    '<div class="titulo">STORE DELIVERY ' + esc(codigo) + '</div>' +
    '<table><thead>' +
      '<tr><th class="grp-oficina" colspan="8">RELLENA OFICINA</th><th class="grp-almacen" colspan="2">RELLENA ALMACÉN</th></tr>' +
      '<tr><th>Nº PC</th><th>UBICACIÓN</th><th>SOPORTES</th><th>DELIVERY</th><th>' + labelCheck2 + '</th><th>INSTALACIÓN</th><th>TRANSPORTE</th><th>PRO</th><th>INCIDENCIA</th><th>OK</th></tr>' +
    '</thead><tbody>' + rows + '</tbody></table>' +
    '<button class="btn no-print" onclick="window.print()">Imprimir</button>' +
    '</body></html>';
}

// ============================================================
// PEDIDO MANUAL A SILUETA
// ============================================================
/**
 * Añade un pedido a una silueta manualmente, aunque no esté en el inventario.
 * datos: { num, tienda, flujo, silueta, posIni, soportes, comentario }
 * 'comentario' es libre (p.ej. "Pedido ya cargado" u otra causa) — solo para
 * dejar constancia de por qué se dio de alta a mano; no cambia estado ni flujo.
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION ya viven en Postgres
// (public). public.registrar_pedido_manual(...) hace TODA la validación
// (guarda de tienda, rango de posición, conflicto de hueco) + escritura
// dentro de un advisory lock transaccional -- ya no hace falta el candado
// de Apps Script. numeroCarga anterior se lee ANTES (CARGAS sigue en
// Sheets, fuera de esta pasada) para poder desligar el pedido de su carga
// activa tras el alta.
function registrarPedidoManual(datos) {
  var num = String(datos.num || '').trim();
  if (!num) return { ok: false, error: 'Número de pedido requerido' };
  var silueta = String(datos.silueta || '');
  if (!silueta) return { ok: false, error: 'Silueta requerida' };

  // OJO: "|| 1" trataría un 0 legítimo (bulto, ubicación 0) como "sin valor" y
  // lo convertiría en 1 en silencio — Number(0) es falsy en JS. Hay que
  // comprobar NaN explícitamente para no perder un 0 tecleado a propósito.
  var posIni = Number(datos.posIni);
  if (isNaN(posIni)) posIni = 1;
  var soportes = datos.soportes || [];
  var posiciones = (soportes.length > 0) ? calcularPosiciones(soportes) : [{ back: true, front: 'reservado' }];
  var comentario = String(datos.comentario || '').trim();
  var flujo = String(datos.flujo || 'transporte');
  var tienda = String(datos.tienda || '');

  // GUARDA DE TIENDA (bug real 2026-07-31): el inventario de Drive es la
  // fuente de verdad de a qué tienda pertenece cada número -- se resuelve
  // aquí (Postgres no puede leerlo) y se manda al RPC como lista de tiendas
  // conocidas para que él decida si bloquear.
  var tiendasPyxis = null;
  if (tienda) {
    try {
      var invMan = cargarInventario();
      var entryMan = (invMan && invMan.indice) ? invMan.indice[num] : null;
      if (entryMan) {
        var tiendasMan = Object.keys(entryMan.porTienda);
        if (tiendasMan.length) tiendasPyxis = tiendasMan;
      }
    } catch (e) {
      // Inventario no disponible: no bloquear un alta legítima por esto.
    }
  }

  // OJO: nº de pedido NO único por sí solo entre tiendas distintas (idPedido
  // = tienda+número es la clave real). Solo se usa aquí para leer el
  // numeroCarga ANTERIOR (CARGAS vive en Sheets) -- el RPC recalcula y
  // valida el idPedido real por su cuenta contra Postgres.
  var idPedido = codigoTienda(tienda) + '::' + num;
  var existing = buscarFilaPorCampo('PEDIDOS', 'id', idPedido);
  var numeroCargaAnterior = existing ? existing.numeroCarga : null;

  var r = _rpcPublic_('registrar_pedido_manual', {
    p_num: num, p_tienda: tienda, p_flujo: flujo, p_silueta: silueta, p_pos_ini: posIni,
    p_soportes: soportes, p_comentario: comentario, p_posiciones: posiciones, p_tiendas_pyxis: tiendasPyxis
  });
  if (!r.ok) return r;

  if (numeroCargaAnterior) _quitarPedidoDeSuCargaActiva(numeroCargaAnterior, num);

  logActividad('MANUAL_SILUETA', 'Pedido ' + num + ' → ' + r.silueta + r.posIni + (r.posIni !== r.posFin ? '-' + r.posFin : '') + ' (manual)' + (comentario ? ' · ' + comentario : ''), 'admin');
  marcarResumenObsoleto();
  return r;
}

/**
 * Reabre un pedido que YA se dio por resuelto (Entregado/Devuelto a
 * almacén/Enviado a tienda/Salida manual) para que un operario lo prepare
 * OTRA VEZ desde cero, como si acabara de importarse — a diferencia de
 * "Añadir pedido manual a silueta" (que asume que ya está embalado y solo
 * necesita un hueco donde esperar), esto es para cuando SÍ hay que volver a
 * recorrer sus ubicaciones (p.ej. una entrega aplazada que el transportista
 * trae de vuelta a plataforma). Deja PEDIDOS y TODAS sus LINEAS en el mismo
 * estado que crearPedidoConLineas al importar por primera vez, así que
 * reaparece tal cual en el listado normal del operario (pantallaListaPedidos).
 * Solo se puede reabrir un pedido en estado TERMINAL (no uno ya activo).
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/LINEAS/HIST_TRANSP ya viven en
// Postgres (public). public.reabrir_pedido(p_num_ped, p_tienda) ya hace TODO
// lo de dentro (pedido+líneas+historial), con su propio `for update` -- no
// hace falta LockService. Solo CARGAS (Sheets) queda por sincronizar --
// numeroCarga se lee ANTES porque la RPC lo pone a null.
function reabrirPedido(numPed, tienda) {
  var candidatos = buscarFilasPorCampo('PEDIDOS', 'ped', numPed);
  var pedidoAntes = tienda ? candidatos.find(function(p) { return p.tienda === tienda; }) : (candidatos.length === 1 ? candidatos[0] : null);
  var r = _rpcPublic_('reabrir_pedido', { p_num_ped: String(numPed), p_tienda: tienda || null });
  if (!r.ok) return r;
  if (pedidoAntes && pedidoAntes.numeroCarga) _quitarPedidoDeSuCargaActiva(pedidoAntes.numeroCarga, numPed);
  logActividad('REABRIR_PEDIDO', 'Pedido ' + numPed + (pedidoAntes ? ' (' + pedidoAntes.tienda + ')' : '') + ' reabierto para preparar de nuevo · ' + r.nLineas + ' ubicaciones', 'admin');
  marcarResumenObsoleto();
  return r;
}

/**
 * Alta MASIVA de pedidos "Recogidas": silueta ficticia fija (sin hueco físico
 * real, como los bultos en posición 0 — no crea filas OCUPACION, sin límite
 * de capacidad) para que por la mañana se puedan incluir en las cargas junto
 * al resto de pedidos, sin tener que asignarles ubicación real ni soportes.
 * numeros: array de números de pedido (texto). tienda: una sola, para toda la tanda.
 *
 * Si el número YA EXISTE en el sistema, dos casos:
 *  - Sigue "en juego" (PENDIENTE, EN_PREPARACION, ya en una silueta real...):
 *    se omite y se informa en yaExistian, SIN tocar esa fila — nunca se pisa
 *    en silencio un pedido que un operario podría estar preparando ahora
 *    mismo (antes esta función sí sobrescribía cualquier pedido existente
 *    sin silueta, aunque estuviera EN_PREPARACION — corregido tras revisión
 *    adversarial).
 *  - Ya está RESUELTO (ENTREGADO, DEVUELTO_ALMACEN...) y el transporte lo
 *    trae de vuelta: se reconvierte DIRECTAMENTE a Recogidas (contado aparte
 *    en reconvertidos), SIN pasar por "Reabrir pedido" — reabrir resetea
 *    todas sus líneas a PENDIENTE para repreparar desde cero, y Recogidas no
 *    usa líneas reales, así que exigir ese paso no tenía sentido (antes
 *    obligaba a reabrir primero para poder marcarlo como Recogidas).
 */
// Fase 3, Pieza 3 (2026-09-04): PEDIDOS/OCUPACION/HIST_TRANSP ya viven en
// Postgres (public). public.registrar_recogidas_masivo(p_numeros_pedido,
// p_tienda) ya hace TODO lo de dentro (alta/reconversión, libera ocupación
// vieja, historial), con su propio advisory lock. Solo CARGAS (Sheets)
// queda por sincronizar -- se identifican candidatos ANTES (mismo criterio
// exacto que la RPC usa para decidir "reconvertido").
function registrarRecogidasMasivo(numeros, tienda) {
  var lista = (numeros || []).map(function(n) { return String(n).trim(); }).filter(function(n) { return n; });
  if (!lista.length) return { ok: false, error: 'No se ha indicado ningún número de pedido' };

  // Rendimiento (2026-09-04): filtrado real por los números pegados, no
  // leerHoja('PEDIDOS') entera. Tienda-aware (2026-09-05, revisión
  // adversarial): con tienda, solo cuenta el candidato de ESA tienda --
  // mismo criterio que ahora usa la RPC -- para no desligar de su carga el
  // pedido de la tienda equivocada si el número colisiona entre tiendas.
  var candidatosPorNumero = {};
  buscarFilasPorCampo('PEDIDOS', 'ped', lista).forEach(function(p) {
    (candidatosPorNumero[String(p.ped)] = candidatosPorNumero[String(p.ped)] || []).push(p);
  });
  var porNumero = {};
  Object.keys(candidatosPorNumero).forEach(function(num) {
    var cands = candidatosPorNumero[num];
    porNumero[num] = tienda ? cands.find(function(p) { return p.tienda === tienda; }) : (cands.length === 1 ? cands[0] : null);
  });
  var conCargaActiva = [];
  var vistos = {};
  lista.forEach(function(num) {
    if (vistos[num]) return;
    vistos[num] = true;
    var e = porNumero[num];
    if (e && e.silueta !== 'Recogidas' && ESTADOS_TERMINALES[e.estado] && e.numeroCarga) conCargaActiva.push(e);
  });

  var r = _rpcPublic_('registrar_recogidas_masivo', { p_numeros_pedido: lista, p_tienda: tienda || null });
  if (!r.ok) return r;

  conCargaActiva.forEach(function(p) { _quitarPedidoDeSuCargaActiva(p.numeroCarga, p.ped); });

  logActividad('RECOGIDAS_MASIVO', r.anadidos + ' nuevos, ' + r.reconvertidos + ' reconvertidos a Recogidas (' + (tienda || 'sin tienda') + ')', 'admin');
  marcarResumenObsoleto();
  return r;
}

/**
 * Alta MASIVA de pedidos "Ya Cargados": MISMO patrón que registrarRecogidasMasivo
 * (silueta ficticia fija, sin hueco físico real — no crea filas OCUPACION, sin
 * límite de capacidad), pero para pedidos que YA se cargaron físicamente en el
 * camión con anterioridad (fuera de este sistema, o antes de registrarlos) — no
 * necesitan sitio real en ninguna silueta. A petición del usuario, se
 * comportan exactamente igual que Recogidas (COMPLETADO_LISTO): quedan
 * disponibles para incluirse en una carga nueva si hiciera falta. Se marcan
 * con un comentario fijo para que "Buscar pedido" refleje por qué están ahí.
 * Mismo criterio que registrarRecogidasMasivo si el número YA EXISTE: si
 * sigue "en juego" se omite (yaExistian); si ya está RESUELTO (ENTREGADO,
 * DEVUELTO_ALMACEN...) se reconvierte DIRECTAMENTE a Ya Cargados
 * (reconvertidos), sin exigir pasar antes por "Reabrir pedido" — antes esto
 * estaba bloqueado a propósito con "no se puede volver a cargar", que era
 * justo el problema reportado: un pedido ya entregado no debía necesitar
 * reabrirse solo para poder marcarlo como Ya Cargados.
 */
// Fase 3, Pieza 3 (2026-09-04): mismo corte que registrarRecogidasMasivo --
// public.registrar_ya_cargados_masivo(p_numeros_pedido, p_tienda) ya hace
// TODO lo de dentro. Solo CARGAS (Sheets) queda por sincronizar.
function registrarYaCargadosMasivo(numeros, tienda) {
  var lista = (numeros || []).map(function(n) { return String(n).trim(); }).filter(function(n) { return n; });
  if (!lista.length) return { ok: false, error: 'No se ha indicado ningún número de pedido' };

  // Rendimiento + tienda-aware: mismo motivo exacto que registrarRecogidasMasivo.
  var candidatosPorNumero = {};
  buscarFilasPorCampo('PEDIDOS', 'ped', lista).forEach(function(p) {
    (candidatosPorNumero[String(p.ped)] = candidatosPorNumero[String(p.ped)] || []).push(p);
  });
  var porNumero = {};
  Object.keys(candidatosPorNumero).forEach(function(num) {
    var cands = candidatosPorNumero[num];
    porNumero[num] = tienda ? cands.find(function(p) { return p.tienda === tienda; }) : (cands.length === 1 ? cands[0] : null);
  });
  var conCargaActiva = [];
  var vistos = {};
  lista.forEach(function(num) {
    if (vistos[num]) return;
    vistos[num] = true;
    var e = porNumero[num];
    if (e && e.silueta !== 'Ya Cargados' && ESTADOS_TERMINALES[e.estado] && e.numeroCarga) conCargaActiva.push(e);
  });

  var r = _rpcPublic_('registrar_ya_cargados_masivo', { p_numeros_pedido: lista, p_tienda: tienda || null });
  if (!r.ok) return r;

  conCargaActiva.forEach(function(p) { _quitarPedidoDeSuCargaActiva(p.numeroCarga, p.ped); });

  logActividad('YA_CARGADOS_MASIVO', r.anadidos + ' nuevos, ' + r.reconvertidos + ' reconvertidos a Ya Cargados (' + (tienda || 'sin tienda') + ')', 'admin');
  marcarResumenObsoleto();
  return r;
}

// ============================================================
// HOJA RESUMEN PARA ADMINISTRACIÓN
// ============================================================
// Crea/actualiza la pestaña "RESUMEN_ADMIN" del Spreadsheet con una vista legible:
// estado de cada pedido, soportes y ubicación en silueta. Se abre desde Drive.
var ESTADO_LABEL = {
  PENDIENTE: 'Pendiente', EN_PREPARACION: 'En preparación',
  COMPLETADO_LISTO: 'Listo · en silueta', PARCIAL_LISTO: 'Listo parcial · con faltantes',
  COMPLETADO: 'En silueta', ENTREGADO: 'Entregado', CARGA_2: 'Pendiente carga 2',
  DEVUELTO_ALMACEN: 'Devuelto a almacén', ENVIADO_TIENDA: 'Enviado a tienda', SALIDA_MANUAL: 'Salida manual',
  CERRADO_SIN_SILUETA: 'Cerrado · todo faltante'
};

/** Agrupa todas las LINEAS por idPedido (una sola lectura, para informes). */
function agruparLineasPorPedido() {
  var mapa = {};
  leerHoja('LINEAS').forEach(function(l) {
    if (!mapa[l.idPedido]) mapa[l.idPedido] = [];
    mapa[l.idPedido].push(l);
  });
  return mapa;
}

/**
 * ¿El pedido salió PARCIAL (alguna línea con faltante) o COMPLETO (todo
 * encontrado)? Devuelve '—' si todavía no se ha terminado de procesar
 * (Pendiente/En preparación) — aún no se sabe.
 */
function tipoParcialCompleto(p, lineasPorPedido) {
  if (p.estado === 'PENDIENTE' || p.estado === 'EN_PREPARACION') return '—';
  var lineas = lineasPorPedido[p.id] || [];
  var tieneFaltantes = lineas.some(function(l) { return l.estado === 'NO_SALE' || l.estado === 'NO_ENCONTRADO'; });
  return tieneFaltantes ? 'Parcial' : 'Completo';
}

/**
 * Marca la hoja "Administración" como pendiente de actualizar, SIN reconstruirla.
 * Es instantáneo. La hoja se regenera entera solo cuando administración pulsa
 * "Hoja administración" (actualizarResumen). Antes se reconstruía en cada cierre
 * de pedido, lo que ralentizaba muchísimo la operativa de los operarios.
 */
function marcarResumenObsoleto() {
  try { CacheService.getScriptCache().put('RESUMEN_OBSOLETO', '1', 21600); } catch (e) {}
}

function actualizarResumen() {
  var ss = getSS();
  var sheet = ss.getSheetByName('RESUMEN_ADMIN');
  if (!sheet) sheet = ss.insertSheet('RESUMEN_ADMIN');

  var nombreSoporte = {};
  CONFIG.SOPORTES.forEach(function(s) { nombreSoporte[s.id] = s.nombre; });

  var cab = ['Nº Pedido', 'Tienda', 'Transportista', 'Flujo', 'Estado', 'Tipo',
             'Silueta', 'Posición', 'Soportes', 'Líneas', 'Operario', 'Actualizado'];
  // "Store Delivery" es SIEMPRE la ÚLTIMA columna, calculada dinámicamente (si
  // se añaden más columnas de datos en el futuro, esto se mantiene solo).
  var colStoreDelivery = cab.length + 1;

  // Leer el estado ACTUAL de Store Delivery ANTES de borrar (por nº de pedido),
  // para no perder las casillas marcadas a mano al regenerar la hoja.
  var storeDeliveryPrevio = {};
  var lastRowPrevia = sheet.getLastRow();
  if (lastRowPrevia > 1 && sheet.getLastColumn() >= colStoreDelivery) {
    var datosPrevios = sheet.getRange(2, 1, lastRowPrevia - 1, colStoreDelivery).getValues();
    datosPrevios.forEach(function(fila) {
      var numPed = String(fila[0] || '').trim();
      if (numPed) storeDeliveryPrevio[numPed] = fila[colStoreDelivery - 1] === true;
    });
  }

  sheet.clear();

  var filas = [cab];
  var pedidos = leerHoja('PEDIDOS');
  var lineasPorPedido = agruparLineasPorPedido();
  pedidos.sort(function(a, b) {
    var sa = a.silueta || 'zzz', sb = b.silueta || 'zzz';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (Number(a.posIni) || 0) - (Number(b.posIni) || 0);
  });

  pedidos.forEach(function(p) {
    var sops = parseJSON(p.soportes, []);
    var sopsTxt = (sops && sops.length) ? sops.map(function(s) {
      return (s.cant || '') + '× ' + (nombreSoporte[s.tipoId] || s.tipoId || '');
    }).join(', ') : '';
    var pos = '';
    if (p.silueta) {
      pos = String(p.posIni || '');
      if (p.posFin && String(p.posFin) !== String(p.posIni)) pos += '–' + p.posFin;
    }
    filas.push([
      p.ped, p.tienda, p.transportista,
      (CONFIG.FLUJO_LABEL[p.flujo] || p.flujo),
      (ESTADO_LABEL[p.estado] || p.estado),
      tipoParcialCompleto(p, lineasPorPedido),
      p.silueta || '', pos, sopsTxt, p.nUbic || '', p.operario || '',
      p.actualizado ? String(p.actualizado).replace('T', ' ').substring(0, 16) : ''
    ]);
  });

  sheet.getRange(1, 1, filas.length, cab.length).setValues(filas);
  sheet.getRange(1, 1, 1, cab.length).setFontWeight('bold').setBackground('#e30613').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  try { sheet.autoResizeColumns(1, cab.length); } catch (e) {}

  // Última columna "Store Delivery": casillas de verificación reales,
  // restauradas desde storeDeliveryPrevio (por nº de pedido) para que no se
  // pisen al pulsar "Hoja administración" otra vez.
  sheet.getRange(1, colStoreDelivery).setValue('Store Delivery')
    .setFontWeight('bold').setBackground('#e30613').setFontColor('#ffffff');
  if (filas.length > 1) {
    var rangoCheckbox = sheet.getRange(2, colStoreDelivery, filas.length - 1, 1);
    rangoCheckbox.insertCheckboxes();
    var valoresCheckbox = [];
    for (var i = 1; i < filas.length; i++) {
      valoresCheckbox.push([storeDeliveryPrevio[String(filas[i][0]).trim()] === true]);
    }
    rangoCheckbox.setValues(valoresCheckbox);
  }
  try { sheet.autoResizeColumn(colStoreDelivery); } catch (e) {}

  try { CacheService.getScriptCache().remove('RESUMEN_OBSOLETO'); } catch (e) {}
  return { ok: true, filas: filas.length - 1, url: ss.getUrl() + '#gid=' + sheet.getSheetId() };
}

/**
 * Borra por completo el contenido de la hoja "Administración" (incluidas las
 * casillas de Store Delivery). Botón "🗑️ Borrar hoja administración" del panel.
 * Se puede regenerar en cualquier momento pulsando "Hoja administración".
 */
function borrarResumenAdmin() {
  var ss = getSS();
  var sheet = ss.getSheetByName('RESUMEN_ADMIN');
  if (!sheet) return { ok: true };
  sheet.clear();
  logActividad('RESUMEN_BORRADO', 'Hoja de administración borrada manualmente', 'admin');
  return { ok: true };
}

// ============================================================
// BUSCADOR
// ============================================================

function buscarPedido(num) {
  const n = String(num).trim();
  if (!n) return null;
  // Rendimiento (2026-09-04): filtrado real, no leerHoja() entera.
  const p = buscarFilaPorCampo('PEDIDOS', 'ped', n);
  if (!p) return null;

  const lineas = buscarFilasPorCampo('LINEAS', 'idPedido', p.id);
  lineas.sort(function(a, b) { return Number(a.idx) - Number(b.idx); });

  // Info de carga: quién la cargó y cuándo. p.numeroCarga se pone al crear la
  // carga y NO se borra al entregar (solo se limpia si se quita el pedido de
  // la carga con quitarPedidoDeCarga), así que sigue disponible aunque el
  // pedido ya esté ENTREGADO.
  var cargaInfo = null;
  if (p.numeroCarga) {
    var cargaRow = leerHoja('CARGAS').find(function(c) { return String(c.numCarga) === String(p.numeroCarga); });
    if (cargaRow) {
      cargaInfo = {
        numCarga: Number(cargaRow.numCarga), estado: cargaRow.estado,
        responsable: cargaRow.responsable || '', cargador: cargaRow.cargador || '',
        fecha: cargaRow.fecha || null, fechaCierre: cargaRow.fechaCierre || null
      };
    }
  }

  // Historial de transportistas: TODAS las asignaciones a lo largo de la vida
  // del pedido (alta, reimportaciones, cambios manuales, reconversiones,
  // reaperturas) — no solo el valor actual de p.transportista. Ver
  // registrarHistorialTransportista para el porqué (pedido que "vuelve" y se
  // carga con un transportista distinto).
  var historialTransportista = buscarFilasPorCampo('HIST_TRANSP', 'idPedido', p.id)
    .sort(function(a, b) { return new Date(a.fecha) - new Date(b.fecha); })
    .map(function(h) { return { transportista: h.transportista, flujo: h.flujo, evento: h.evento, fecha: h.fecha }; });

  return {
    id: p.id, ped: p.ped, tienda: p.tienda, transportista: p.transportista,
    flujo: p.flujo, estado: p.estado, pct: Number(p.pct) || 0,
    silueta: p.silueta || null, posIni: p.posIni || null, posFin: p.posFin || null,
    operario: p.operario, carga: cargaInfo,
    soportes: parseJSON(p.soportes, []),
    comentario: p.comentario || '',
    historialTransportista: historialTransportista,
    lineas: lineas.map(function(l) {
      return {
        dir: l.dir, ref: l.ref, des: l.des, ctd: l.ctd,
        tipoUbic: l.tipoUbic, esPicking: l.esPicking === true || l.esPicking === 'true',
        estado: l.estado, motivo: l.motivo
      };
    })
  };
}

/**
 * Buscador con filtros (tienda/flujo/estado/solo-hoy + substring de nº de
 * pedido) para poder LOCALIZAR pedidos sin conocer el número exacto — a
 * diferencia de buscarPedido (lookup exacto), esto devuelve una lista
 * ligera de coincidencias; cada fila se abre después con buscarPedido para
 * ver el detalle completo (soportes, tienda, flujo, carga…). Ordenado por
 * `actualizado` descendente para que la actividad más reciente (p.ej. lo
 * entregado/movido hoy) salga primero. Tope de 200 filas devueltas (con
 * `truncado:true` si hay más) para no volcar la hoja PEDIDOS entera.
 */
function buscarPedidosFiltro(filtros) {
  filtros = filtros || {};
  var texto = String(filtros.texto || '').trim();
  var tienda = filtros.tienda || '';
  var flujo = filtros.flujo || '';
  var estadoF = filtros.estado || '';
  var soloHoy = !!filtros.soloHoy;

  // Rendimiento: pre-filtro real en Postgres cuando hay algún criterio (todos
  // sobre-aproximan a propósito -- ilike es case-insensitive, indexOf no; el
  // filtro JS de abajo sigue siendo el que decide de verdad, sin cambios).
  // Sin ningún criterio (búsqueda vacía / solo "hoy") no hay nada seguro que
  // empujar al servidor -- cae a leerHoja('PEDIDOS') como antes.
  var partesFiltro = [];
  if (texto) partesFiltro.push('ped=ilike.*' + encodeURIComponent(texto) + '*');
  if (tienda) partesFiltro.push('tienda=eq.' + encodeURIComponent(tienda));
  if (flujo) partesFiltro.push('flujo=eq.' + encodeURIComponent(flujo));
  if (estadoF) partesFiltro.push('estado=eq.' + encodeURIComponent(estadoF));
  var basePedidos = (_esTablaPublic_('PEDIDOS') && partesFiltro.length)
    ? leerHojaPublicConFiltro_('PEDIDOS', partesFiltro.join('&'))
    : leerHoja('PEDIDOS');
  var coincidencias = basePedidos.filter(function(p) {
    if (texto && String(p.ped).indexOf(texto) === -1) return false;
    if (tienda && p.tienda !== tienda) return false;
    if (flujo && p.flujo !== flujo) return false;
    if (estadoF && p.estado !== estadoF) return false;
    if (soloHoy && !esHoyMadrid(p.actualizado)) return false;
    return true;
  });

  coincidencias.sort(function(a, b) { return String(b.actualizado || '').localeCompare(String(a.actualizado || '')); });

  var TOPE = 200;
  var truncado = coincidencias.length > TOPE;
  var pagina = coincidencias.slice(0, TOPE);

  // Direcciones únicas por pedido — UNA sola lectura de LINEAS para toda la
  // página (no una por pedido, mismo patrón ya usado por listarPedidos con
  // "avisos", v80), filtrando solo lo que hace falta para los pedidos de esta
  // página (nunca los truncados fuera del TOPE).
  var idsPagina = {};
  var idsPaginaList = [];
  pagina.forEach(function(p) { idsPagina[p.id] = true; idsPaginaList.push(p.id); });
  var direccionesPorId = {};
  buscarFilasPorCampo('LINEAS', 'idPedido', idsPaginaList).forEach(function(l) {
    if (!idsPagina[l.idPedido] || !l.dir) return;
    (direccionesPorId[l.idPedido] = direccionesPorId[l.idPedido] || {})[l.dir] = true;
  });

  var resultados = pagina.map(function(p) {
    return {
      ped: p.ped, tienda: p.tienda, transportista: p.transportista, flujo: p.flujo,
      estado: p.estado, silueta: p.silueta || null, posIni: p.posIni || null, posFin: p.posFin || null,
      actualizado: p.actualizado || null,
      soportes: parseJSON(p.soportes, []),
      direcciones: direccionesPorId[p.id] ? Object.keys(direccionesPorId[p.id]) : []
    };
  });

  return { resultados: resultados, total: coincidencias.length, truncado: truncado };
}

/**
 * Consulta EXACTA de varios pedidos a la vez (a diferencia de buscarPedidosFiltro,
 * que es un filtro por substring/criterios). Pensado para pegar una lista de
 * números y ver/copiar sus datos (silueta, soportes, etc.) de golpe. Si un
 * mismo número existe en varias tiendas se devuelven TODAS las coincidencias
 * (a diferencia de buscarPedido, que solo devuelve la primera) — aquí es solo
 * lectura, así que no hay riesgo de ambigüedad al escribir.
 */
function buscarPedidosMasivo(numeros) {
  var nums = (numeros || []).map(function(n) { return String(n).trim(); }).filter(Boolean);
  if (!nums.length) return { resultados: [], noEncontrados: [] };
  var setNums = {};
  nums.forEach(function(n) { setNums[n] = true; });

  // Rendimiento: filtrado real por los números pedidos, no leerHoja() entera.
  var coincidencias = buscarFilasPorCampo('PEDIDOS', 'ped', nums).filter(function(p) { return setNums[String(p.ped)]; });

  var idsPagina = {};
  var idsPaginaList = [];
  coincidencias.forEach(function(p) { idsPagina[p.id] = true; idsPaginaList.push(p.id); });
  var direccionesPorId = {};
  buscarFilasPorCampo('LINEAS', 'idPedido', idsPaginaList).forEach(function(l) {
    if (!idsPagina[l.idPedido] || !l.dir) return;
    (direccionesPorId[l.idPedido] = direccionesPorId[l.idPedido] || {})[l.dir] = true;
  });

  var resultados = coincidencias.map(function(p) {
    return {
      ped: p.ped, tienda: p.tienda, transportista: p.transportista, flujo: p.flujo,
      estado: p.estado, silueta: p.silueta || null, posIni: p.posIni || null, posFin: p.posFin || null,
      soportes: parseJSON(p.soportes, []),
      comentario: p.comentario || '',
      direcciones: direccionesPorId[p.id] ? Object.keys(direccionesPorId[p.id]) : []
    };
  });
  // Mismo orden en que se pegaron los números (agrupa coincidencias del mismo nº juntas).
  resultados.sort(function(a, b) { return nums.indexOf(String(a.ped)) - nums.indexOf(String(b.ped)); });

  var encontrados = {};
  coincidencias.forEach(function(p) { encontrados[String(p.ped)] = true; });
  var noEncontrados = nums.filter(function(n) { return !encontrados[n]; });

  return { resultados: resultados, noEncontrados: noEncontrados };
}

// ============================================================
// DASHBOARD
// ============================================================

// Compara una fecha ISO contra "hoy" en huso Europe/Madrid. Global (antes
// vivía anidada dentro de obtenerDatosDashboard) para poder reutilizarla
// también desde buscarPedidosFiltro (filtro "solo actividad de hoy").
function esHoyMadrid(fechaIso) {
  if (!fechaIso) return false;
  try {
    var hoyStr = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd');
    return Utilities.formatDate(new Date(fechaIso), 'Europe/Madrid', 'yyyy-MM-dd') === hoyStr;
  } catch (e) { return false; } // fecha corrupta en alguna fila antigua: no debe tumbar todo el dashboard
}

function obtenerDatosDashboard() {
  // Rendimiento (llamada cada 10s desde la Pantalla TV): ni las KPI ni
  // calcularPedidosEnSiluetaSinEntregar necesitan pedidos en estado
  // terminal -- filtrado real en Postgres, no leerHoja('PEDIDOS') entera.
  const pedidosRaw = _esTablaPublic_('PEDIDOS')
    ? leerHojaPublicConFiltro_('PEDIDOS', 'estado=not.in.(ENTREGADO,DEVUELTO_ALMACEN,ENVIADO_TIENDA,SALIDA_MANUAL,CERRADO_SIN_SILUETA)')
    : leerHoja('PEDIDOS');
  const pedidos = pedidosRaw.map(function(p) {
    return {
      id: p.id, ped: p.ped, tienda: p.tienda, transportista: p.transportista,
      flujo: p.flujo, estado: p.estado, pct: Number(p.pct) || 0,
      silueta: p.silueta || null, posIni: p.posIni, posFin: p.posFin,
      operario: p.operario || '', // quién tocó el pedido por última vez -- en EN_PREPARACION, quien lo está sacando ahora
      intentoCarga: Number(p.intentoCarga) || 1, // >=2 = ya rebotó de una carga anterior (pendiente 2ª/3ª)
      // Necesario para que la Pantalla/TV detecten bultos MEZCLADOS con un
      // soporte real (palet/jaula) en el mismo pedido -- ese pedido vive en
      // su posición numerada normal (posIni>0), pero sus bultos se cuentan
      // también en la zona "0 · 📦" de esa silueta (ver Index.html bultos0 /
      // Dashboard.html bultosMixtosPorSilueta).
      soportes: parseJSON(p.soportes, [])
    };
  });
  const ocupacion = obtenerOcupacionTodas();

  // Una sola lectura de CARGAS para derivar "cargaActiva" (compat, la más
  // reciente), "cargasActivas" (TODAS las GENERADA, con items+cargador, para
  // resaltar en la Pantalla TV/admin qué se está cargando ahora mismo) y
  // "cargasHoy" (TODAS las de hoy, GENERADA o ya CERRADA).
  const cargasRaw = leerHoja('CARGAS');
  const cargasGeneradas = cargasRaw.filter(function(c) { return c.estado === 'GENERADA'; });
  const cargasActivas = cargasGeneradas.map(function(c) {
    return {
      id: c.id, numCarga: Number(c.numCarga), fecha: c.fecha,
      responsable: c.responsable || '', cargador: c.cargador || '',
      items: parseJSON(c.items, [])
    };
  }).sort(function(a, b) { return a.numCarga - b.numCarga; });

  let cargaActiva = null;
  if (cargasActivas.length) {
    const porFecha = cargasActivas.slice().sort(function(a, b) { return new Date(b.fecha) - new Date(a.fecha); });
    cargaActiva = porFecha[0];
  }

  // IMPORTANTE: confirmarEntregas() marca la carga como CERRADA en el MISMO
  // momento en que sus pedidos pasan a ENTREGADO/CARGA_2 — justo cuando esos
  // datos existirían, la carga desaparece de "cargasActivas" (GENERADA). Los
  // KPIs "Cargados"/"2ª-3ª carga" de los dashboards necesitan ver también las
  // cargas YA CERRADAS de hoy para poder mostrar esos totales alguna vez.
  //
  // OJO: una carga puede CREARSE un día y CERRARSE otro (el chofer vuelve
  // tarde, se confirma al día siguiente, etc). 'fecha' es la de CREACIÓN y
  // nunca cambia — comparar solo esa contra "hoy" dejaba fuera cualquier
  // carga cerrada hoy pero creada antes (bug real: con datos reales de
  // producción, cargas creadas el día 3 y cerradas el día 6 seguían sin
  // aparecer). Ahora: si sigue GENERADA se mira 'fecha' (cuándo se creó,
  // que es cuando sus pedidos aún pendientes son "de hoy"); si ya está
  // CERRADA se mira 'fechaCierre' (cuándo se resolvió de verdad).
  const cargasHoy = cargasRaw.filter(function(c) {
    if (c.estado === 'GENERADA') return esHoyMadrid(c.fecha);
    if (c.estado === 'CERRADA') return esHoyMadrid(c.fechaCierre || c.fecha); // fallback por si es una carga cerrada antes de este cambio (sin fechaCierre)
    return false;
  }).map(function(c) {
    return { id: c.id, numCarga: Number(c.numCarga), estado: c.estado, items: parseJSON(c.items, []) };
  });

  // "Por cargar"/"2ª-3ª carga" fiables: NO solo lo que hay dentro de las
  // cargas de hoy (cargasHoy, arriba) — eso deja fuera cualquier pedido que
  // esté en silueta pero AÚN no se haya metido en ninguna carga, que es
  // justo el caso que confundía al usuario ("por cargar: 0" con pedidos
  // todavía en el mapa de siluetas). Reutiliza la misma lógica que la
  // pantalla Entregas, pasándole lo que YA se ha leído aquí para no repetir
  // lecturas de hoja (esta función se llama cada 10s desde la Pantalla TV).
  const desglose = calcularPedidosEnSiluetaSinEntregar(pedidosRaw, cargasRaw, ocupacion);

  return {
    pedidos: pedidos, ocupacion: ocupacion, cargaActiva: cargaActiva, cargasActivas: cargasActivas, cargasHoy: cargasHoy,
    enSiluetaSinCargar: desglose.otrosSinCargar.length,
    pendientesSegundaCargaCount: desglose.pendientesSegundaCarga.length,
    pendientesSegundaCargaPeds: desglose.pendientesSegundaCarga.map(function(p) { return p.ped; })
  };
}

/**
 * Ranking de operarios por pedidos CERRADOS (silueta asignada), última 30
 * días -- de ahí se sacan tanto "semana" (lunes actual en adelante) como
 * "mes" (los 30 días), sin leer LOG dos veces. Llamada aparte de
 * obtenerDatosDashboard (no cada 10s -- ver Dashboard.html, cada 5min basta).
 *
 * OJO rendimiento/correctud: leerHojaPublicConFiltro_ normal NO pagina --
 * vale para PEDIDOS activos (pocas filas) pero CIERRE_PEDIDO acumulado de
 * varias semanas puede superar el tope "Max Rows" de Postgres y truncarse en
 * SILENCIO. Por eso aquí se usa leerLogPublicFiltradoTodasFilas_, que sí
 * pagina completo (mismo patrón que leerHoja/_restPublicTodasFilas_).
 */
function obtenerRankingOperarios() {
  const desdeMes = new Date();
  desdeMes.setDate(desdeMes.getDate() - 30);

  const filtro = 'tipo=eq.CIERRE_PEDIDO&ts=gte.' + encodeURIComponent(desdeMes.toISOString());
  const logs = _esTablaPublic_('LOG')
    ? leerLogPublicFiltradoTodasFilas_(filtro)
    : leerHoja('LOG').filter(function(l) { return l.tipo === 'CIERRE_PEDIDO' && l.ts && new Date(l.ts) >= desdeMes; });

  const inicioSemana = new Date();
  const diaSemana = (inicioSemana.getDay() + 6) % 7; // lunes=0 ... domingo=6
  inicioSemana.setDate(inicioSemana.getDate() - diaSemana);
  inicioSemana.setHours(0, 0, 0, 0);

  // Soportes por cierre -- sufijo 'NNsop' añadido al detalle desde este
  // cambio (ver cerrarPedido). Cierres de ANTES de este cambio no lo llevan
  // -- cuentan como 0 soportes, no como error (histórico incompleto, no dato
  // corrupto).
  const RE_SOPORTES = /·\s*(\d+)sop\s*$/;
  const acumular = function(mapa, usuario, soportes) {
    const o = (mapa[usuario] = mapa[usuario] || { pedidos: 0, soportes: 0 });
    o.pedidos++;
    o.soportes += soportes;
  };
  const semana = {}, mes = {};
  logs.forEach(function(l) {
    if (!l.usuario) return;
    const m = RE_SOPORTES.exec(String(l.detalle || ''));
    const soportes = m ? Number(m[1]) : 0;
    const t = new Date(l.ts);
    acumular(mes, l.usuario, soportes);
    if (t >= inicioSemana) acumular(semana, l.usuario, soportes);
  });
  const aLista = function(obj) {
    return Object.keys(obj)
      .map(function(u) { return { operario: u, pedidos: obj[u].pedidos, soportes: obj[u].soportes }; })
      .sort(function(a, b) { return b.pedidos - a.pedidos; })
      .slice(0, 8);
  };
  return { semana: aLista(semana), mes: aLista(mes) };
}

// ============================================================
// SUGERENCIAS / FALLOS (botón de la app) — mismo patrón que el botón
// equivalente de la app de Cargas/Descargas Plataforma Málaga.
// ============================================================

/**
 * Recibe {tipo, autor, texto} desde el botón "Sugerencias" de la app y
 * manda un correo con el mensaje. Nunca lanza -- siempre devuelve
 * {ok, mensaje} para que la UI pueda mostrar el resultado.
 */
function enviarSugerencia(datos) {
  try {
    var texto = (datos && datos.texto ? String(datos.texto) : '').trim();
    if (!texto) return { ok: false, mensaje: 'Escribe tu sugerencia o fallo.' };
    var sello = Utilities.formatDate(new Date(), 'Europe/Madrid', "dd/MM/yyyy 'a las' HH:mm");
    var tipo = (datos.tipo || 'Sugerencia');
    var autor = (datos.autor ? String(datos.autor).trim() : '') || 'Anónimo';
    var colorCab = (tipo === 'Fallo') ? '#e30613' : (tipo === 'Mejora' ? '#3498db' : '#22c55e');
    var textoHtml = esc(texto).replace(/\n/g, '<br>');

    var html =
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f4f6f8;padding:24px">' +
        '<div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">' +
          '<div style="background:' + colorCab + ';padding:18px 22px">' +
            '<h2 style="margin:0;color:#fff;font-size:18px">' + esc(tipo) + ' · App Preparación LM Málaga</h2>' +
            '<p style="margin:4px 0 0;color:rgba(255,255,255,.85);font-size:13px">TAISA Logistics</p>' +
          '</div>' +
          '<div style="padding:22px">' +
            '<table style="width:100%;border-collapse:collapse;font-size:14px;color:#1b2733">' +
              '<tr><td style="padding:8px 0;color:#6b7899;width:42%;border-bottom:1px solid #eef1f4">Tipo</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #eef1f4">' + esc(tipo) + '</td></tr>' +
              '<tr><td style="padding:8px 0;color:#6b7899;width:42%;border-bottom:1px solid #eef1f4">Enviado por</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #eef1f4">' + esc(autor) + '</td></tr>' +
              '<tr><td style="padding:8px 0;color:#6b7899;width:42%;border-bottom:1px solid #eef1f4">Fecha</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #eef1f4">' + sello + '</td></tr>' +
            '</table>' +
            '<p style="margin:18px 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#6b7899">Mensaje</p>' +
            '<div style="background:#f5f7fa;border:1px solid #eef1f4;border-radius:8px;padding:14px;font-size:14px;color:#1b2733;line-height:1.6">' + textoHtml + '</div>' +
          '</div>' +
        '</div>' +
        '<p style="text-align:center;color:#6b7899;font-size:11px;margin-top:14px">Enviado desde la app de Preparación + Carga · LM Málaga</p>' +
      '</div>';

    MailApp.sendEmail({
      to: CONFIG.CORREO_SUGERENCIAS,
      subject: '[App LM Málaga] ' + tipo + ' · ' + autor,
      htmlBody: html,
      name: 'App LM Málaga - TAISA'
    });
    return { ok: true, mensaje: '¡Gracias! Tu mensaje se ha enviado.' };
  } catch (e) {
    return { ok: false, mensaje: 'Error: ' + e.message };
  }
}

// ============================================================
// UTILIDADES
// ============================================================

function parseJSON(str, fallback) {
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// Escape HTML para generar la hoja de carga en el servidor.
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
