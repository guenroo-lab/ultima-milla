/**
 * ============================================================
 * MigracionFase3Lote1.gs · Wrappers Apps Script → RPC (Lote 1), solo staging
 * ============================================================
 * Fase 3 "Pieza 2" de la migración a Supabase (ver docs/superpowers/specs/
 * 2026-09-01-fase3-lote1-wrappers-staging-design.md), acotada al Lote 1
 * (reclamo de posición: cerrar_pedido, mover_pedido_de_silueta,
 * corregir_soportes_pedido, liberar_pedido_de_silueta,
 * aplicar_compactar_siluetas) y SOLO contra el esquema `staging`.
 *
 * Ningún helper de este archivo acepta esquema como parámetro -- va fijo en
 * las cabeceras Accept-Profile/Content-Profile: 'staging', a propósito, para
 * que sea físicamente imposible llamar a `public` (producción real) desde
 * aquí. Backend.gs NO se toca en este bloque.
 */

/**
 * Llama a una función RPC de staging. Lanza si Supabase no está configurado
 * o si la RPC devuelve HTTP >= 300 -- estas funciones son un arnés de
 * prueba, no código best-effort: un fallo debe pararse y verse, no tragarse.
 */
function _rpcStaging_(nombreFuncion, payload) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + nombreFuncion, {
    method: 'post',
    headers: {
      apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Accept-Profile': 'staging', 'Content-Profile': 'staging',
      'User-Agent': 'GoogleAppsScript-lm_produccion-lote1-staging'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    throw new Error('_rpcStaging_(' + nombreFuncion + '): HTTP ' + resp.getResponseCode() + ' ' + body.slice(0, 500));
  }
  return body ? JSON.parse(body) : null;
}

/**
 * Petición REST directa contra staging (INSERT/DELETE/PATCH/GET de sembrado
 * y limpieza de datos de prueba -- no una función RPC). `tablaConFiltro`
 * incluye el nombre de tabla y, si aplica, el filtro PostgREST tras `?`.
 * `prefer` opcional añade/sustituye la cabecera Prefer (p.ej.
 * 'resolution=merge-duplicates,return=representation' para upsert).
 */
function _restStaging_(metodo, tablaConFiltro, payload, prefer) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var opciones = {
    method: metodo,
    headers: {
      apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Accept-Profile': 'staging', 'Content-Profile': 'staging',
      'User-Agent': 'GoogleAppsScript-lm_produccion-lote1-staging'
    },
    muteHttpExceptions: true
  };
  if (prefer) opciones.headers.Prefer = prefer;
  else if (metodo === 'post') opciones.headers.Prefer = 'return=representation';
  if (payload !== undefined) opciones.payload = JSON.stringify(payload);
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tablaConFiltro, opciones);
  var body = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    throw new Error('_restStaging_(' + metodo + ' ' + tablaConFiltro + '): HTTP ' + resp.getResponseCode() + ' ' + body.slice(0, 500));
  }
  return body ? JSON.parse(body) : null;
}

/**
 * Dispara N peticiones RPC genuinamente EN PARALELO (UrlFetchApp.fetchAll --
 * un `for` normal en Apps Script es de un solo hilo y nunca simularía una
 * carrera real). payloads: array de objetos, uno por petición.
 */
function _dispararEnParalelo_(nombreFuncion, payloads) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var requests = payloads.map(function(p) {
    return {
      url: cfg.url + '/rest/v1/rpc/' + nombreFuncion,
      method: 'post',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Accept-Profile': 'staging', 'Content-Profile': 'staging',
        'User-Agent': 'GoogleAppsScript-lm_produccion-lote1-staging'
      },
      payload: JSON.stringify(p),
      muteHttpExceptions: true
    };
  });
  return UrlFetchApp.fetchAll(requests).map(function(r) {
    var body = r.getContentText();
    return { status: r.getResponseCode(), body: body ? JSON.parse(body) : null };
  });
}

// Backend.gs real: cerrarPedido(idPedido, silueta, posIni, soportes, operario)
function cerrarPedidoViaSupabase(idPedido, silueta, posIni, soportes, operario) {
  var posiciones = calcularPosiciones(soportes); // pura, ya vive en Backend.gs
  return _rpcStaging_('cerrar_pedido', {
    p_id_pedido: idPedido, p_silueta: silueta, p_pos_ini: posIni,
    p_posiciones: posiciones, p_soportes: soportes, p_operario: operario || null
  });
}

// Backend.gs real: moverPedidoDeSilueta(numPed, nuevaSilueta, nuevaPosIni, tienda)
// EXCEPCIÓN de firma (ver design doc §3): recibe `soportes` extra porque el
// arnés de prueba ya conoce los soportes del pedido sintético que sembró.
function moverPedidoDeSiluetaViaSupabase(numPed, nuevaSilueta, nuevaPosIni, soportes, tienda) {
  var posiciones = calcularPosiciones(soportes);
  return _rpcStaging_('mover_pedido_de_silueta', {
    p_num_ped: String(numPed), p_nueva_silueta: nuevaSilueta, p_nueva_pos_ini: nuevaPosIni,
    p_posiciones: posiciones, p_tienda: tienda || null
  });
}

// Backend.gs real: corregirSoportesPedido(numPed, nuevosSoportes, nuevaSilueta, nuevaPosIni, tienda)
function corregirSoportesPedidoViaSupabase(numPed, nuevosSoportes, nuevaSilueta, nuevaPosIni, tienda) {
  var posiciones = calcularPosiciones(nuevosSoportes);
  return _rpcStaging_('corregir_soportes_pedido', {
    p_num_ped: String(numPed), p_nuevos_soportes: nuevosSoportes, p_posiciones: posiciones,
    p_nueva_silueta: nuevaSilueta || null, p_nueva_pos_ini: (nuevaPosIni === undefined ? null : nuevaPosIni),
    p_tienda: tienda || null
  });
}

// Backend.gs real: liberarPedidoDeSilueta(numPed, disposicion, motivo, tienda)
// disposicion aquí es el CÓDIGO CORTO que espera la RPC ('almacen'/'tienda'/
// 'desmarcar'/cualquier otro → SALIDA_MANUAL) -- NO el estado final; la RPC
// lo traduce internamente y devuelve el estado resultante en `.estado`.
function liberarPedidoDeSiluetaViaSupabase(numPed, disposicion, motivo, tienda) {
  return _rpcStaging_('liberar_pedido_de_silueta', {
    p_num_ped: String(numPed), p_disposicion: disposicion, p_motivo: motivo || null, p_tienda: tienda || null
  });
}

// Backend.gs real: aplicarCompactarSiluetas(movimientos)
// Cada movimiento: {ped, tienda, flujo, siluetaVieja, posIniVieja, posFinVieja,
// siluetaNueva, posIniNueva, posFinNueva, posiciones} -- forma real confirmada
// leyendo supabase/migrations/2026081308_aplicar_compactar_siluetas.sql.
function aplicarCompactarSiluetasViaSupabase(movimientos) {
  return _rpcStaging_('aplicar_compactar_siluetas', { p_movimientos: movimientos });
}
