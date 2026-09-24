# Fase 3 · Pieza 2 (Lote 1, staging) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

## ✅ Resultado real (2026-09-01, ejecutado y verificado)

**Las 12 tareas están completas y las 9 pruebas pasan limpias, dos veces seguidas** (`ejecutarTodoLote1Staging`, 1 sept 2026 20:21:41, 51.294s): `=== TODAS LAS PRUEBAS DEL LOTE 1 PASARON, staging.ZTEST quedó limpio ===`. Verificado también por fuera de Apps Script, directo contra Supabase (`select count(*) from staging.ocupacion_siluetas where silueta='ZTEST'` → `0`).

**Tres hallazgos reales encontrados durante la implementación, todos resueltos** (no eran bugs de las RPC — dos eran de comprensión/diseño de la prueba, uno era un bug real del arnés de limpieza):

1. **`palet_euro` ocupa media posición (0.5), no una entera (1.0)** — CONFIG.SOPORTES real: solo `palet_doble` tiene `ocupa:1`. Todos los tests que pretendían "1 soporte = 1 posición completa" usaban el tipo equivocado; corregido a `palet_doble` en todo el archivo.
2. **"Remansur salta la validación" no es una excepción a la constraint física de Postgres.** En Sheets, `validarAsignacionManual` deja pasar a Remansur sin comprobar nada, y `appendRow` no tiene restricción de unicidad — duplicación física silenciosa posible. En Postgres, la `PK(silueta,pos,layer)` protege a **todos** los flujos por igual: Remansur salta el chequeo `EXISTS` lógico previo, pero si hay una colisión física real, sigue fallando (con un mensaje específico distinto). Es una mejora deliberada de la migración, ya anticipada por el documento de diseño padre — no una regresión. Corregidas las pruebas de Caso 3 (Task 3) y concurrencia Remansur (Task 9) para verificar el comportamiento real.
3. **Bug real de limpieza en `ejecutarConcurrenciaCompartirFrenteLote1`**: al transcribir del plan al código, faltaba `peds.push('TEST_LOTE1_CF_A', 'TEST_LOTE1_CF_B')` tras el disparo en paralelo — la limpieza solo conocía `CF_BACK`, así que la fila `front` (cuyo `pedido` cambia al ganador tras el `UPDATE` de `compartir_frente_remansur`) quedaba huérfana. Reproducido de forma 100% consistente en 2 ejecuciones antes de corregirlo; confirmado limpio en las 2 ejecuciones posteriores al fix.

**Alcance real, sin cambios respecto al plan**: cero cambios en Backend.gs, cero promoción a `public` — todo construido y validado exclusivamente contra `staging`, tal como se acordó. La decisión de promover el Lote 1 a `public` y cablear Backend.gs de verdad sigue pendiente, como una decisión aparte.

---

**Goal:** Construir y validar contra el esquema `staging` de Supabase (nunca `public`) las 5 funciones "vía Supabase" del Lote 1 (reclamo de posición), con pruebas funcionales y de concurrencia real — sin tocar Backend.gs ni promover nada a producción.

**Architecture:** Un archivo nuevo, `MigracionFase3Lote1.gs`, con un caller RPC hardcodeado a `staging` (imposible apuntar a `public`), 5 funciones wrapper que llaman a las RPC ya desplegadas (`cerrar_pedido`, `mover_pedido_de_silueta`, `corregir_soportes_pedido`, `liberar_pedido_de_silueta`, `aplicar_compactar_siluetas`), y un segundo archivo `PruebasLote1Staging.gs` con funciones `ejecutar*` (funcionales + concurrencia con `UrlFetchApp.fetchAll()`), cada una sembrando y limpiando sus propios pedidos sintéticos `TEST_LOTE1_*`.

**Tech Stack:** Google Apps Script (V8) + `UrlFetchApp` contra PostgREST (Supabase, cabeceras `Accept-Profile`/`Content-Profile: staging`) + las 6 RPC PL/pgSQL ya aplicadas y **leídas verbatim de `supabase/migrations/2026081302..09_*.sql`** para este plan (no del resumen del documento de diseño de hace 3 semanas — se encontraron 3 discrepancias reales entre el resumen y el SQL realmente aplicado, todas corregidas abajo, ver nota de cada tarea afectada).

**Nota de fontanería importante, verificada leyendo el SQL real de todas las RPC (no asumida):**
- `ocupacion_siluetas.pos` es **`text`**, no `int` — PostgREST siempre lo devuelve como string en el JSON. Todas las comparaciones contra un número literal en las pruebas de abajo usan `String(n)` o `Number(o.pos)`, nunca `o.pos === 5`.
- `_max_pos_silueta(silueta)` lee `staging.config_siluetas` — una silueta que no exista ahí devuelve `Silueta desconocida`. La silueta de prueba `ZTEST` **debe sembrarse una vez** en `config_siluetas` antes de cualquier prueba que reclame una posición (Task 2).
- `liberar_pedido_de_silueta`: `p_disposicion` **NO** es el estado final — es un código corto que la función traduce internamente (`'almacen'→DEVUELTO_ALMACEN`, `'tienda'→ENVIADO_TIENDA`, `'desmarcar'→COMPLETADO_LISTO`, cualquier otro valor→`SALIDA_MANUAL`). El estado final resultante viene en la respuesta (`.estado`).
- `aplicar_compactar_siluetas`: cada movimiento del array espera las claves `ped, tienda, flujo, siluetaVieja, posIniVieja, posFinVieja, siluetaNueva, posIniNueva, posFinNueva, posiciones` — **no** `pedido/posOrigenIni/posDestinoIni` (nombres inventados en un borrador anterior de este plan, corregidos en Task 7 tras leer el SQL real). Valida el origen contra el estado REAL actual antes de mover (mismo mecanismo anti-drift que ya se vio en el bug real de "Compactar Siluetas: A1 vacía" de esta misma sesión).

---

### Task 1: Archivo nuevo — caller RPC + 5 wrappers

**Files:**
- Create: `MigracionFase3Lote1.gs`

- [x] **Paso 1: Crear el archivo completo**

```javascript
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
```

- [x] **Paso 2: Añadir a `.claspignore` y hacer push**

Añadir `!MigracionFase3Lote1.gs` a `.claspignore` (patrón de lista blanca, mismo gotcha que ya pasó hoy con `CargasTaisa.gs` — sin esto, el archivo nunca se sube), luego:
```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Expected: `MigracionFase3Lote1.gs` aparece listado en la salida de `clasp push`.

---

### Task 2: Helpers de sembrado, limpieza, y silueta de prueba en `config_siluetas`

**Files:**
- Create: `PruebasLote1Staging.gs`

- [x] **Paso 1: Crear el archivo con los helpers de sembrado/limpieza**

Silueta de prueba `ZTEST` (fuera del rango real A-F) sembrada UNA VEZ (idempotente, upsert) en `staging.config_siluetas` con capacidad amplia (100 posiciones) — sin esto, `_max_pos_silueta('ZTEST')` devuelve `null` y toda RPC que reclame una posición real (no bultos, no compartir-delante) falla con `Silueta desconocida`.

```javascript
/**
 * ============================================================
 * PruebasLote1Staging.gs · Pruebas funcionales y de concurrencia del Lote 1
 * ============================================================
 * Todas las pruebas siembran sus propios pedidos sintéticos (prefijo
 * TEST_LOTE1_, silueta ZTEST -- fuera del rango real A-F) en `staging` y los
 * limpian en un `finally`, pase o falle la prueba. Ejecutar cada función
 * ejecutar* desde el editor y mirar el log, o ejecutarTodoLote1Staging()
 * (Task 12) para correrlas todas en orden.
 */

var SILUETA_PRUEBA_LOTE1 = 'ZTEST';

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
  try { _restStaging_('delete', 'ocupacion_siluetas?' + filtro); } catch (e) {}
  var filtroPed = 'ped=in.(' + peds.map(encodeURIComponent).join(',') + ')';
  try { _restStaging_('delete', 'pedidos?' + filtroPed); } catch (e) {}
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
```

- [x] **Paso 2: Añadir a `.claspignore` y hacer push**

Añadir `!PruebasLote1Staging.gs` a `.claspignore`, luego:
```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 3: Prueba funcional — `cerrarPedidoViaSupabase`

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la función de prueba (4 casos: normal, bultos, Remansur salta validación, Remansur compartir delante)**

```javascript
/**
 * Prueba funcional de cerrarPedidoViaSupabase -- 4 casos:
 * 1) normal (transporte): reclama back+front en huecos libres.
 * 2) bultos (soportes con ocupa=0): va a posición 0, sin filas de ocupación.
 * 3) Remansur normal: reclama SIN validar conflicto (puede "pisar" sitio ya ocupado por otro flujo -- regla de negocio, no bug).
 * 4) Remansur compartir delante: un pedido de un solo soporte de 0.5 ocupa el front de una posición cuyo back ya es de OTRO pedido Remansur.
 */
function ejecutarPruebaCerrarPedidoLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    // Caso 1: normal, 1 soporte entero (ocupa=1) -> back+front en pos 1
    var soportesNormal = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
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

    // Caso 3: Remansur normal -- reclama pos 1 aunque YA esté ocupada por el Caso 1 (salta validación)
    var soportesRemansur = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_C3', 'TEST_LOTE1_C3', 'Málaga', 'remansur_transporte', soportesRemansur);
    peds.push('TEST_LOTE1_C3');
    var r3 = cerrarPedidoViaSupabase('TEST_LOTE1_C3', SILUETA_PRUEBA_LOTE1, 1, soportesRemansur, 'PRUEBA');
    _assertLote1_(r3.ok === true, 'Caso 3 (Remansur salta validación): ok=true pese a pos 1 ya ocupada (' + JSON.stringify(r3) + ')');

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
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarPruebaCerrarPedidoLote1` desde el editor. Expected: log termina con `=== ejecutarPruebaCerrarPedidoLote1: TODO PASS ===`, sin ninguna línea `FAIL:`.

---

### Task 4: Prueba funcional — `moverPedidoDeSiluetaViaSupabase`

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la función de prueba**

```javascript
/** Prueba funcional de moverPedidoDeSiluetaViaSupabase: pedido cerrado en pos 10, se mueve a pos 15 -- confirma que el hueco viejo (10) queda libre y el nuevo (15) reclamado. */
function ejecutarPruebaMoverPedidoLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
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
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarPruebaMoverPedidoLote1`. Expected: `TODO PASS`, sin `FAIL:`.

---

### Task 5: Prueba funcional — `corregirSoportesPedidoViaSupabase`

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la función de prueba**

```javascript
/** Prueba funcional de corregirSoportesPedidoViaSupabase: pedido cerrado con 1 posición, se corrige a 2 soportes enteros (2 posiciones) en la MISMA silueta/posIni -- confirma que crece a las 2 posiciones nuevas. */
function ejecutarPruebaCorregirSoportesLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportesIniciales = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_COR', 'TEST_LOTE1_COR', 'Málaga', 'transporte', soportesIniciales);
    peds.push('TEST_LOTE1_COR');
    var cierre = cerrarPedidoViaSupabase('TEST_LOTE1_COR', SILUETA_PRUEBA_LOTE1, 20, soportesIniciales, 'PRUEBA');
    _assertLote1_(cierre.ok === true, 'Setup: pedido cerrado en pos 20 (1 posición)');

    var soportesNuevos = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 2 }];
    var cor = corregirSoportesPedidoViaSupabase('TEST_LOTE1_COR', soportesNuevos, SILUETA_PRUEBA_LOTE1, 20, 'Málaga');
    _assertLote1_(cor.ok === true, 'Corregir: ok=true (' + JSON.stringify(cor) + ')');

    var ocup = _leerOcupacionPrueba_().filter(function(o) { return o.pedido === 'TEST_LOTE1_COR'; });
    _assertLote1_(ocup.length === 4, 'Corregir: ahora 4 filas de ocupación (2 posiciones x back+front)');

    Logger.log('=== ejecutarPruebaCorregirSoportesLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarPruebaCorregirSoportesLote1`. Expected: `TODO PASS`, sin `FAIL:`.

---

### Task 6: Prueba funcional — `liberarPedidoDeSiluetaViaSupabase`

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la función de prueba**

`p_disposicion` es el código corto `'almacen'` (no `'DEVUELTO_ALMACEN'` directamente — ver nota de fontanería al principio del plan). La RPC traduce y devuelve el estado final en `.estado`.

```javascript
/** Prueba funcional de liberarPedidoDeSiluetaViaSupabase: pedido cerrado, se libera con disposicion='almacen' -- confirma que la ocupación desaparece, el pedido queda sin silueta, y el estado resultante es DEVUELTO_ALMACEN. */
function ejecutarPruebaLiberarPedidoLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
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
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarPruebaLiberarPedidoLote1`. Expected: `TODO PASS`, sin `FAIL:`.

---

### Task 7: Prueba funcional — `aplicarCompactarSiluetasViaSupabase`

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la función de prueba**

Forma real del movimiento confirmada leyendo `supabase/migrations/2026081308_aplicar_compactar_siluetas.sql` (no la asumida en un borrador anterior de este plan): `{ped, tienda, flujo, siluetaVieja, posIniVieja, posFinVieja, siluetaNueva, posIniNueva, posFinNueva, posiciones}`. La RPC valida el origen contra el estado REAL antes de mover (mismo mecanismo anti-drift del bug real de "Compactar Siluetas: A1 vacía" de esta sesión) y devuelve `{ok, aplicados, movimientos, omitidos}`.

```javascript
/** Prueba funcional de aplicarCompactarSiluetasViaSupabase: pedido en pos 30, se compacta a pos 1 (libre). */
function ejecutarPruebaCompactarLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
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
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarPruebaCompactarLote1`. Expected: `TODO PASS`, sin `FAIL:`.

---

### Task 8: Concurrencia — dos pedidos normales al mismo hueco

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la prueba de concurrencia**

```javascript
/** Concurrencia: 2 pedidos NO-Remansur, misma posición, en paralelo real -- exactamente uno debe ganar. */
function ejecutarConcurrenciaCerrarNormalLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
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
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarConcurrenciaCerrarNormalLote1`. Expected: `TODO PASS`. Si a veces pasan los DOS (`ganadores.length === 2`), es un hallazgo real de una condición de carrera no resuelta por `for update` — no reintentar hasta que pase, parar y reportarlo tal cual (ver Riesgo #2 del design doc padre sobre el nivel de aislamiento).

---

### Task 9: Concurrencia — dos pedidos Remansur al mismo hueco (los dos deben ganar)

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la prueba de concurrencia**

```javascript
/** Concurrencia Remansur: 2 pedidos Remansur, misma posición, en paralelo -- los DOS deben ganar (regla de negocio, no bug: Remansur salta la validación de conflicto). */
function ejecutarConcurrenciaCerrarRemansurLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
    _sembrarPedidoPrueba_('TEST_LOTE1_CR1', 'TEST_LOTE1_CR1', 'Málaga', 'remansur_transporte', soportes);
    _sembrarPedidoPrueba_('TEST_LOTE1_CR2', 'TEST_LOTE1_CR2', 'Málaga', 'remansur_transporte', soportes);
    peds.push('TEST_LOTE1_CR1', 'TEST_LOTE1_CR2');

    var posiciones = calcularPosiciones(soportes);
    var resultados = _dispararEnParalelo_('cerrar_pedido', [
      { p_id_pedido: 'TEST_LOTE1_CR1', p_silueta: SILUETA_PRUEBA_LOTE1, p_pos_ini: 45, p_posiciones: posiciones, p_soportes: soportes, p_operario: 'PRUEBA' },
      { p_id_pedido: 'TEST_LOTE1_CR2', p_silueta: SILUETA_PRUEBA_LOTE1, p_pos_ini: 45, p_posiciones: posiciones, p_soportes: soportes, p_operario: 'PRUEBA' }
    ]);

    var ganadores = resultados.filter(function(r) { return r.body && r.body.ok === true; });
    _assertLote1_(ganadores.length === 2, 'Concurrencia Remansur: los 2 ganan (hubo ' + ganadores.length + ', ' + JSON.stringify(resultados) + ')');

    Logger.log('=== ejecutarConcurrenciaCerrarRemansurLote1: TODO PASS ===');
  } finally {
    _limpiarPruebaLote1_(peds);
  }
}
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarConcurrenciaCerrarRemansurLote1`. Expected: `TODO PASS`.

---

### Task 10: Concurrencia — dos intentos simultáneos de compartir el mismo frente

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la prueba de concurrencia**

```javascript
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
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarConcurrenciaCompartirFrenteLote1`. Expected: `TODO PASS`.

---

### Task 11: Concurrencia — dos liberaciones simultáneas del mismo pedido

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final)

- [x] **Paso 1: Añadir la prueba de concurrencia**

```javascript
/** Concurrencia liberar: mismo pedido, 2 llamadas a liberar en paralelo (disposicion='almacen') -- no debe quedar en estado a medias (ocupación borrada a medias, o duplicada). */
function ejecutarConcurrenciaLiberarLote1() {
  _asegurarSiluetaPrueba_();
  var peds = [];
  try {
    var soportes = [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 1 }];
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
```

- [x] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```
Ejecutar `ejecutarConcurrenciaLiberarLote1`. Expected: `TODO PASS`.

---

### Task 12: Runner maestro + verificación de idempotencia

**Files:**
- Modify: `PruebasLote1Staging.gs` (añadir al final, luego mover al PRINCIPIO del archivo, justo tras las variables/helpers de Task 2)

- [x] **Paso 1: Añadir el runner maestro**

Ejecuta las 9 pruebas en orden, para y reporta en el primer fallo (no sigue acumulando ruido). Al final, relee la ocupación de la silueta de prueba para confirmar que no queda ningún resto.

```javascript
/**
 * Runner maestro del Lote 1: ejecuta las 9 pruebas (5 funcionales + 4 de
 * concurrencia) en orden y para en el primer fallo. Colocada a propósito
 * como PRIMERA función EJECUTABLE del archivo (tras los helpers de sembrado,
 * que no son pruebas en sí) -- mismo motivo que MigracionFase2.gs: el
 * desplegable del editor autoselecciona la primera función del archivo,
 * cero ambigüedad sobre qué se ejecuta.
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
```

- [x] **Paso 2: Mover `ejecutarTodoLote1Staging` al principio del archivo**

Cortar la función recién añadida y pegarla justo después del bloque de helpers de Task 2 (tras `_assertLote1_`), antes de `ejecutarPruebaCerrarPedidoLote1` — así queda como primera función EJECUTABLE real del archivo (los helpers `_algo_` con guion bajo no aparecen resaltados como "la función seleccionada" de la misma forma en el desplegable, pero por claridad y para que el hábito ya establecido en `MigracionFase2.gs` se mantenga, el runner debe ser lo primero que se vea al abrir el archivo).

- [x] **Paso 3: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

- [x] **Paso 4: Ejecutar `ejecutarTodoLote1Staging` dos veces seguidas desde el editor**

Expected ambas veces: `=== TODAS LAS PRUEBAS DEL LOTE 1 PASARON, staging.ZTEST quedó limpio ===`, sin ninguna línea `*** PARADO` ni `*** ADVERTENCIA`. Si la primera pasa y la segunda no (o viceversa), hay un problema de limpieza entre ejecuciones — diagnosticar antes de dar el Lote 1 por cerrado, no repetir sin más.
