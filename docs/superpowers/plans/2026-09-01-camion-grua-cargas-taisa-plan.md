# Camión Grúa → CARGAS TAISA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Al crear una carga marcada "Camión Grúa" (con agencia elegida), exportar
automáticamente una fila por pedido a la hoja externa "CARGAS TAISA", rellenando
localidad/CP/peso/tipo cliente desde `pedidos_totales.csv`.

**Architecture:** Dos campos nuevos en `CARGAS` (`esCamionGrua`, `agencia`). `crearCarga`
sigue igual para cargas normales; si es Camión Grúa, tras crear la carga (y soltar el
candado) llama a un exportador nuevo, en un archivo propio (`CargasTaisa.gs`), que lee un
índice cacheado y troceado de `pedidos_totales.csv` y escribe las filas en la hoja externa
-- todo envuelto en `try/catch` para que un fallo ahí nunca afecte a la carga ya creada.

**Tech Stack:** Google Apps Script (V8) + `CacheService` (troceado, límite real 100KB por
clave) + `SpreadsheetApp.openById` contra una hoja externa. Sin framework de test --
verificación manual vía Apps Script editor (`Pruebas.gs`) y recorrido real en el navegador.

**Datos reales ya confirmados (2026-09-01, ver `ejecutarDiagnosticoTamanoPedidosTotales` en
Pruebas.gs y la lectura en vivo de la hoja CARGAS TAISA):**
- `pedidos_totales.csv` vive en `INVENTARIO_FOLDER_ID` (la MISMA carpeta que los inventarios
  por tienda), separado por `;`, con BOM al principio del archivo.
- 39.096 líneas totales, **7.129 pedidos únicos**. Columnas usadas (por nombre de cabecera,
  no por posición fija -- el índice se calcula con `indexOf`): `Nº Pedido cliente` (col 0),
  `Cliente PRO` (col 81, `"si"`/`"no"`), `Peso` (col 23), `Código postal envío` (col 91),
  `Ciudad envío` (col 92).
- El índice compacto resultante pesa **~440KB en JSON** -- por encima del límite real de
  100KB por clave de `CacheService`, hace falta trocearlo.
- Parsear el CSV entero tarda **~13 segundos** en vivo.
- Hoja externa: id `1BShlbVdf3UWetJlOGKzFsOO19VwxWd2DkTkqO2XqJjg`, pestaña `CARGAS TAISA`,
  columnas A-I: `AGENCIA, FECHA, TIENDA, PC, TIPO CLIENTE, LOCALIDAD, C.P., KG,
  OBSERVACIONES` (I se deja vacía).

---

### Task 1: Esquema — nuevas columnas en `CARGAS` (`Configuracion.gs`)

**Files:**
- Modify: `Configuracion.gs:193`

- [ ] **Paso 1: Añadir las dos columnas nuevas**

Cambiar:
```javascript
  CARGAS: ['id', 'numCarga', 'fecha', 'estado', 'items', 'responsable', 'cargador', 'fechaCierre'],
```
por:
```javascript
  CARGAS: ['id', 'numCarga', 'fecha', 'estado', 'items', 'responsable', 'cargador', 'fechaCierre', 'esCamionGrua', 'agencia'],
```

No hace falta tocar la cabecera de la hoja real -- este proyecto ya tiene precedente de
columnas nuevas sin cabecera de texto en la hoja, resueltas siempre por posición vía
`COLUMNAS` (ver `PEDIDOS.enRevision`/`sdImpreso`, añadidas igual).

- [ ] **Paso 2: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 2: Nuevo archivo `CargasTaisa.gs` — índice cacheado de `pedidos_totales.csv`

**Files:**
- Create: `CargasTaisa.gs`

- [ ] **Paso 1: Crear el archivo completo**

```javascript
/**
 * ============================================================
 * CargasTaisa.gs
 * ============================================================
 * Exporta cargas marcadas "Camión Grúa" a la hoja externa "PANEL RUTAS GRÚA
 * MÁLAGA" (pestaña CARGAS TAISA), mantenida por otro equipo. Los datos de
 * localidad/CP/peso/tipo cliente no existen en el inventario Pyxis que ya
 * importa esta app -- salen de pedidos_totales.csv, un export completo de
 * Pyxis que vive en la MISMA carpeta de Drive que los inventarios por tienda
 * (INVENTARIO_FOLDER_ID), actualizado a diario por el propio Pyxis.
 * Ver docs/superpowers/specs/2026-09-01-camion-grua-cargas-taisa-design.md
 */

var CARGAS_TAISA_SHEET_ID = '1BShlbVdf3UWetJlOGKzFsOO19VwxWd2DkTkqO2XqJjg';
var CARGAS_TAISA_TAB = 'CARGAS TAISA';
var CACHE_PREFIX_PEDIDOS_TOTALES = 'idxGrua_';
var CACHE_TTL_PEDIDOS_TOTALES = 21600; // 6h -- máximo real que permite CacheService.put

/**
 * Índice ped -> {peso, cp, ciudad, esPro} de pedidos_totales.csv, con caché troceada
 * (confirmado en vivo el 2026-09-01: 7.129 pedidos únicos, índice ~440KB, parseo completo
 * ~13s -- ver ejecutarDiagnosticoTamanoPedidosTotales en Pruebas.gs).
 */
function _indicePedidosTotales() {
  var cache = CacheService.getScriptCache();
  var reensamblado = _leerIndiceCacheado(cache);
  if (reensamblado) return reensamblado;

  var indice = _construirIndicePedidosTotales();
  _guardarIndiceEnCache(cache, indice);
  return indice;
}

function _leerIndiceCacheado(cache) {
  var meta = cache.get(CACHE_PREFIX_PEDIDOS_TOTALES + 'meta');
  if (!meta) return null;
  var n = Number(meta);
  var partes = [];
  for (var i = 0; i < n; i++) {
    var parte = cache.get(CACHE_PREFIX_PEDIDOS_TOTALES + i);
    if (!parte) return null; // caché parcialmente caducada -- recalcular todo
    partes.push(parte);
  }
  try { return JSON.parse(partes.join('')); } catch (e) { return null; }
}

function _guardarIndiceEnCache(cache, indice) {
  var json = JSON.stringify(indice);
  var TAM_TROZO = 90000; // margen bajo el límite real de 100KB por clave
  var n = Math.ceil(json.length / TAM_TROZO) || 1;
  try {
    for (var i = 0; i < n; i++) {
      cache.put(CACHE_PREFIX_PEDIDOS_TOTALES + i, json.substr(i * TAM_TROZO, TAM_TROZO), CACHE_TTL_PEDIDOS_TOTALES);
    }
    cache.put(CACHE_PREFIX_PEDIDOS_TOTALES + 'meta', String(n), CACHE_TTL_PEDIDOS_TOTALES);
  } catch (e) {
    // Si guardar la caché fallara por lo que sea, no pasa nada -- se
    // recalcula la próxima vez, más lento pero sin romper nada.
  }
}

function _construirIndicePedidosTotales() {
  var carpeta = DriveApp.getFolderById(INVENTARIO_FOLDER_ID);
  var it = carpeta.getFilesByName('pedidos_totales.csv');
  if (!it.hasNext()) return {};
  var file = it.next();
  var texto = file.getBlob().getDataAsString('UTF-8').replace(/^\uFEFF/, '');
  var lineas = texto.split('\n');
  if (!lineas.length) return {};

  var cab = lineas[0].split(';').map(function(c) { return c.replace(/"/g, '').trim(); });
  var idxPed = cab.indexOf('Nº Pedido cliente');
  var idxPro = cab.indexOf('Cliente PRO');
  var idxPeso = cab.indexOf('Peso');
  var idxCp = cab.indexOf('Código postal envío');
  var idxCiudad = cab.indexOf('Ciudad envío');
  if (idxPed === -1) return {}; // cabecera cambió de formato -- mejor vacío que datos mal alineados

  var indice = {};
  for (var i = 1; i < lineas.length; i++) {
    if (!lineas[i]) continue;
    var f = lineas[i].split(';');
    var ped = (f[idxPed] || '').replace(/"/g, '').trim();
    if (!ped || indice[ped]) continue; // primera aparición de cada pedido -- cabecera de línea es idéntica en todas sus filas
    indice[ped] = {
      peso: (f[idxPeso] || '').replace(/"/g, '').trim(),
      cp: (f[idxCp] || '').replace(/"/g, '').trim(),
      ciudad: (f[idxCiudad] || '').replace(/"/g, '').trim(),
      esPro: (f[idxPro] || '').replace(/"/g, '').trim().toLowerCase() === 'si'
    };
  }
  return indice;
}

/**
 * Añade una fila por pedido a la pestaña CARGAS TAISA de la hoja externa.
 * Pensada para llamarse DESPUÉS de crear la carga real (fuera del candado de
 * crearCarga) -- un fallo aquí no debe deshacer ni bloquear la carga, que ya
 * se creó bien. items: mismo array que ya construye crearCarga ({ped,tienda,...}).
 * Devuelve el número de filas escritas.
 */
function _exportarCargaTaisa_(agencia, fechaIso, items) {
  var indice = _indicePedidosTotales();
  var ss = SpreadsheetApp.openById(CARGAS_TAISA_SHEET_ID);
  var hoja = ss.getSheetByName(CARGAS_TAISA_TAB);
  if (!hoja) throw new Error('No existe la pestaña "' + CARGAS_TAISA_TAB + '" en la hoja externa');

  var fechaCorta = Utilities.formatDate(new Date(fechaIso), 'Europe/Madrid', 'dd/MM/yyyy');
  var filas = items.map(function(item) {
    var datos = indice[String(item.ped)] || {};
    var codigo = codigoTienda(item.tienda);
    return [
      agencia, fechaCorta, codigo ? Number(codigo) : item.tienda, item.ped,
      datos.esPro === true ? 'PRO' : (datos.esPro === false ? 'PARTICULAR' : ''),
      datos.ciudad || '', datos.cp || '', datos.peso || '', ''
    ];
  });
  if (filas.length) {
    hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, 9).setValues(filas);
  }
  return filas.length;
}
```

- [ ] **Paso 2: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 3: Probar el índice y el exportador de forma AISLADA (`Pruebas.gs`)

**Files:**
- Modify: `Pruebas.gs` (nueva función, primera del archivo)

- [ ] **Paso 1: Escribir la prueba**

Prueba `_construirIndicePedidosTotales` contra un pedido real conocido (elegido por el
usuario en el Paso 2) y `_exportarCargaTaisa_` con un `items` sintético claramente marcado
como prueba (para poder borrar esa fila después en la hoja externa a mano).

```javascript
/**
 * Prueba el índice de pedidos_totales.csv y el exportador a CARGAS TAISA de forma AISLADA
 * (sin pasar por crearCarga real). Escribe una fila de prueba real en la hoja externa --
 * el usuario debe borrarla a mano después de confirmar que salió bien (ver Paso 3 del
 * plan). PED_REAL_CONOCIDO: un pedido real que el usuario sepa que está en
 * pedidos_totales.csv, para comprobar que sale con datos -- si se deja en blanco, ese
 * bloque se salta.
 */
var PED_REAL_CONOCIDO_GRUA = '';

function ejecutarPruebaCargasTaisa() {
  if (PED_REAL_CONOCIDO_GRUA) {
    var indice = _indicePedidosTotales();
    var datos = indice[PED_REAL_CONOCIDO_GRUA];
    Logger.log('Datos de ' + PED_REAL_CONOCIDO_GRUA + ': ' + JSON.stringify(datos));
    if (!datos) Logger.log('⚠ No se encontró -- revisa que el número sea correcto y esté en el CSV');
  } else {
    Logger.log('PED_REAL_CONOCIDO_GRUA vacío -- se salta la comprobación con pedido real.');
  }

  var itemsPrueba = [
    { ped: 'TESTGRUA_CONDATOS', tienda: 'Málaga' },
    { ped: 'TESTGRUA_SINDATOS_99999999', tienda: 'Mijas' }
  ];
  var n = _exportarCargaTaisa_('Remansur', new Date().toISOString(), itemsPrueba);
  Logger.log('Filas escritas en CARGAS TAISA: ' + n + ' -- revisa la hoja externa y BÓRRALAS a mano tras confirmar que el formato es correcto (agencia/fecha/tienda/pedido en las columnas A-D, y en la fila SINDATOS las columnas E-H vacías).');
}
```

- [ ] **Paso 2: Pedir al usuario un pedido real conocido en el CSV**

Rellenar `PED_REAL_CONOCIDO_GRUA` con un número de pedido real que el usuario sepa con
certeza que está en `pedidos_totales.csv` (por ejemplo uno de un envío a domicilio reciente).

- [ ] **Paso 3: Push, ejecutar, y limpiar la hoja externa a mano**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

Ejecutar `ejecutarPruebaCargasTaisa` desde el editor. Confirmar en el log que el pedido real
sale con datos reales, y que se escribieron 2 filas. Abrir la hoja externa
(`https://docs.google.com/spreadsheets/d/1BShlbVdf3UWetJlOGKzFsOO19VwxWd2DkTkqO2XqJjg`,
pestaña CARGAS TAISA) y **borrar a mano las 2 filas de prueba** (`TESTGRUA_CONDATOS` /
`TESTGRUA_SINDATOS_99999999`) una vez confirmado que el formato es correcto -- son datos de
otro equipo, no se dejan restos de prueba ahí.

---

### Task 4: Conectar el exportador a `crearCarga` (`Backend.gs`)

**Files:**
- Modify: `Backend.gs:1571-1641` (función `crearCarga`)

- [ ] **Paso 1: Extender la firma y el objeto `carga`**

Cambiar:
```javascript
function crearCarga(listaNumPedidos, responsable) {
```
por:
```javascript
function crearCarga(listaNumPedidos, responsable, esCamionGrua, agencia) {
```

Cambiar:
```javascript
  var pendienteVisas = null, pendienteSyncsCarga = [];
```
por:
```javascript
  var pendienteVisas = null, pendienteSyncsCarga = [], pendienteCargaTaisa = null;
```

Cambiar:
```javascript
    const carga = {
      id: 'CARGA_' + new Date().getTime(),
      numCarga: numCarga,
      fecha: new Date().toISOString(),
      estado: 'GENERADA',
      items: items,
      responsable: responsable || ''
    };
    anadirFila('CARGAS', carga);
    pendienteSyncsCarga.push({ tipo: 'carga', carga: carga });
    items.forEach(function(item, idx) { pendienteSyncsCarga.push({ tipo: 'cargaPedido', cargaId: carga.id, idPedido: item.idPedido, idx: idx }); });
    logActividad('CREAR_CARGA', 'Carga ' + numCarga + ' · ' + items.length + ' pedidos', responsable || '');

    pendienteVisas = { ids: encontrados.map(function(p) { return p.id; }), numCarga: numCarga };

    return { ok: true, carga: carga, noEncontrados: noEncontrados };
```
por:
```javascript
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
    pendienteSyncsCarga.push({ tipo: 'carga', carga: carga });
    items.forEach(function(item, idx) { pendienteSyncsCarga.push({ tipo: 'cargaPedido', cargaId: carga.id, idPedido: item.idPedido, idx: idx }); });
    logActividad('CREAR_CARGA', 'Carga ' + numCarga + ' · ' + items.length + ' pedidos' + (esCamionGrua ? ' · Camión Grúa (' + carga.agencia + ')' : ''), responsable || '');

    pendienteVisas = { ids: encontrados.map(function(p) { return p.id; }), numCarga: numCarga };
    if (esCamionGrua) pendienteCargaTaisa = { agencia: carga.agencia, fecha: carga.fecha, items: items, numCarga: numCarga };

    return { ok: true, carga: carga, noEncontrados: noEncontrados };
```

- [ ] **Paso 2: Disparar el exportador en el `finally`, después de soltar el candado**

Leer primero el `finally` completo tal cual está en el archivo real (puede haber cambiado de
línea desde que se escribió este plan) y añadir el bloque nuevo justo después de la línea
`if (pendienteVisas) _marcarVisasEnCarga(pendienteVisas.ids, pendienteVisas.numCarga);`:

```javascript
    if (pendienteCargaTaisa) {
      try {
        _exportarCargaTaisa_(pendienteCargaTaisa.agencia, pendienteCargaTaisa.fecha, pendienteCargaTaisa.items);
      } catch (eTaisa) {
        logActividad('CARGAS_TAISA_ERROR', 'Fallo exportando carga ' + pendienteCargaTaisa.numCarga + ' a CARGAS TAISA: ' + eTaisa.message, '');
      }
    }
```

- [ ] **Paso 3: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 5: Cliente — checkbox + agencia en "Nueva carga" (`Index.html`)

**Files:**
- Modify: `Index.html` (declaración de `BORRADOR_CARGA`, formulario de "Nueva carga",
  función `crearCarga()` cliente)

- [ ] **Paso 1: Extender el borrador**

Buscar `var BORRADOR_CARGA = { responsable: '', pedidos: '' };` y cambiar por:
```javascript
var BORRADOR_CARGA = { responsable: '', pedidos: '', esCamionGrua: false, agencia: '' };
```

- [ ] **Paso 2: Añadir el checkbox + selector al formulario**

Localizar el bloque de "Nueva carga" (busca `<span class="step-num">+</span> Nueva carga`) y,
justo después del `<input id="inResponsable" ...>` existente y antes del `<p>` de "Pega los
pedidos...", insertar:

```javascript
    '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--tx2);margin-bottom:12px;cursor:pointer">' +
      '<input type="checkbox" id="chkCamionGrua" ' + (BORRADOR_CARGA.esCamionGrua ? 'checked' : '') + ' onchange="BORRADOR_CARGA.esCamionGrua=this.checked;document.getElementById(\'selAgencia\').style.display=this.checked?\'block\':\'none\'" style="width:16px;height:16px">' +
      '🏗️ Es Camión Grúa' +
    '</label>' +
    '<select id="selAgencia" onchange="BORRADOR_CARGA.agencia=this.value" style="width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:11px;color:var(--tx);font-family:inherit;font-size:14px;padding:11px 13px;margin-bottom:12px;display:' + (BORRADOR_CARGA.esCamionGrua ? 'block' : 'none') + '">' +
      '<option value="">— Elegir agencia —</option>' +
      '<option value="Remansur"' + (BORRADOR_CARGA.agencia === 'Remansur' ? ' selected' : '') + '>Remansur</option>' +
      '<option value="Correcaminos"' + (BORRADOR_CARGA.agencia === 'Correcaminos' ? ' selected' : '') + '>Correcaminos</option>' +
      '<option value="Malaga Transport"' + (BORRADOR_CARGA.agencia === 'Malaga Transport' ? ' selected' : '') + '>Malaga Transport</option>' +
    '</select>' +
```

(Nota: el bloque de "Nueva carga" en `Index.html` está escrito con template literal backtick
`` ` `` en vez de concatenación con `+` -- si al leer el archivo real resulta ser un template
literal, adaptar la sintaxis de arriba a `${...}` en vez de concatenación, manteniendo
exactamente la misma lógica condicional.)

- [ ] **Paso 3: Extender `crearCarga()` (cliente)**

Cambiar:
```javascript
async function crearCarga() {
  const txt = document.getElementById('taPedidos').value;
  const numeros = txt.split(/[\s,;\n]+/).map(s => s.trim()).filter(s => s);
  const inResp = document.getElementById('inResponsable');
  const responsable = (inResp ? inResp.value : '').trim();
  let r;
  try { r = await gas('crearCarga', numeros, responsable); } catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast(`✓ Carga ${r.carga.numCarga} generada: ${r.carga.items.length} pedidos`, 'ok');
  BORRADOR_CARGA = { responsable: '', pedidos: '' }; // ya se generó la carga: el borrador queda obsoleto
  // Nos quedamos en la misma pantalla: la carga se suma a la lista de arriba.
  pantallaCargaInicio();
}
```
por:
```javascript
async function crearCarga() {
  const txt = document.getElementById('taPedidos').value;
  const numeros = txt.split(/[\s,;\n]+/).map(s => s.trim()).filter(s => s);
  const inResp = document.getElementById('inResponsable');
  const responsable = (inResp ? inResp.value : '').trim();
  const chkGrua = document.getElementById('chkCamionGrua');
  const esCamionGrua = chkGrua ? chkGrua.checked : false;
  const selAgencia = document.getElementById('selAgencia');
  const agencia = (selAgencia ? selAgencia.value : '').trim();
  if (esCamionGrua && !agencia) { toast('Elige la agencia del Camión Grúa.', 'err'); return; }
  let r;
  try { r = await gas('crearCarga', numeros, responsable, esCamionGrua, agencia); } catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast(r.error, 'err'); return; }
  toast(`✓ Carga ${r.carga.numCarga} generada: ${r.carga.items.length} pedidos`, 'ok');
  BORRADOR_CARGA = { responsable: '', pedidos: '', esCamionGrua: false, agencia: '' }; // ya se generó la carga: el borrador queda obsoleto
  // Nos quedamos en la misma pantalla: la carga se suma a la lista de arriba.
  pantallaCargaInicio();
}
```

- [ ] **Paso 4: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 6: Verificación end-to-end en producción (implementación de prueba no disponible)

**Files:** ninguno.

- [ ] **Paso 1: Confirmar que una carga NORMAL sigue funcionando igual**

Con un pedido real en silueta, crear una carga SIN marcar el checkbox. Confirmar que se
crea exactamente igual que siempre y que NO aparece ninguna fila nueva en CARGAS TAISA.

- [ ] **Paso 2: Confirmar el caso Camión Grúa con datos reales**

Pedir al usuario un pedido real en silueta, listo para probar. Marcar el checkbox, elegir
una agencia, crear la carga. Confirmar en CARGAS TAISA que apareció la fila correcta con
datos reales (agencia/fecha/tienda/pedido/tipo cliente/localidad/CP/kg).

Si algo falla, volver a la tarea correspondiente y corregir antes de dar el trabajo por
completo.

---

### Task 7: Desplegar a producción — REQUIERE CONFIRMACIÓN EXPLÍCITA DEL USUARIO

**No ejecutar sin que el usuario diga explícitamente que sí**, mismo criterio que el resto
de este proyecto para cualquier cambio que afecta a los operarios reales ahora mismo.

- [ ] **Paso 1: Pedir confirmación explícita**, explicando qué cambia para los usuarios
      ("aparece un checkbox nuevo 'Es Camión Grúa' al crear una carga; el resto del flujo de
      cargas no cambia").
- [ ] **Paso 2: Solo si el usuario confirma** — Implementar → Gestionar implementaciones →
      editar la implementación activa (mismo ID ya usado hoy) → Versión nueva → Implementar.
- [ ] **Paso 3: Confirmar en producción** que crear una carga normal sigue funcionando igual
      que antes.
