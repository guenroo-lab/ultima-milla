# LM Málaga · Pipeline Completo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar toda la app de expedición de LM Málaga para que funcione de extremo a extremo: desde la carga de pedidos (clasificador → persistencia real) hasta el último paso de carga/expedición, sobre Google Apps Script + Google Sheets.

**Architecture:** Backend GAS ya existente (`Backend.gs`, `EstructuraSheets.gs`, `Configuracion.gs`, `ImportarPyxis.gs`, `Inventario.gs`) + dos frontends nuevos (`Index.html`, `Dashboard.html`) portados desde las demos de referencia, sustituyendo la capa de datos `localStorage` por llamadas async a `google.script.run`. Un único `doGet` enruta por `?vista`. Un puente nuevo `importarClasificacion` convierte la clasificación en pedidos reales.

**Tech Stack:** Google Apps Script (V8, sin arrow functions ni template literals en `.gs`), Google Sheets, HTML/CSS/JS vanilla en el frontend.

---

## Notas de entorno (leer antes de empezar)

- **No hay runner de tests ni se puede ejecutar GAS desde esta máquina.** Los "tests" del backend son funciones en `Pruebas.gs` con un assert que escribe PASS/FAIL en `Logger`. Cada paso de "ejecutar test" significa **pegar/guardar en el editor de Apps Script y ejecutar la función allí**, mirando el log. El frontend se verifica desplegando.
- **El proyecto no está bajo git.** Los pasos de `git commit` son opcionales. Si quieres la disciplina de commits frecuentes, ejecuta primero `git init` en `C:/Users/30081048/Desktop/lm_produccion` (Task 0). Si no, ignora los pasos de commit.
- **Convención `.gs`:** `function(){}` (no `=>`), concatenación con `+` (no backticks). El frontend HTML sí puede usar arrow/template literals.
- **Archivos `.gs` comparten ámbito global** en el proyecto GAS: una función de un archivo es visible desde otro sin import.

---

## Task 0 (opcional): Inicializar git para commits frecuentes

**Files:** ninguno (repo)

- [ ] **Step 1: Init**

```bash
cd "C:/Users/30081048/Desktop/lm_produccion"
git init
printf "node_modules/\n.clasp.json\n" > .gitignore
git add -A
git commit -m "chore: estado inicial lm_produccion antes del pipeline"
```

Expected: repo creado, primer commit. Si no quieres git, salta toda esta task y omite los "Step: Commit" del resto del plan.

---

# FASE 0 — Fontanería de backend

## Task 1: Unificar el `doGet` (eliminar la colisión)

Hay dos `doGet`: `Codigo.gs` (sirve `Clasificador`) y `WebApp.gs` (sirve `Index/Dashboard`). En GAS solo puede haber uno. Se conserva el de `WebApp.gs` y se le añade la ruta `clasificador`; se vacía `Codigo.gs`.

**Files:**
- Modify: `WebApp.gs:15-29`
- Modify: `Codigo.gs` (vaciar `doGet`)

- [ ] **Step 1: Reescribir `doGet` en `WebApp.gs`**

Reemplaza la función `doGet` (líneas 15-29) por:

```javascript
function doGet(e) {
  var vista = (e && e.parameter && e.parameter.vista) ? e.parameter.vista : 'app';
  var archivo;
  if (vista === 'dashboard') archivo = 'Dashboard';
  else if (vista === 'clasificador') archivo = 'Clasificador';
  else archivo = 'Index';

  return HtmlService.createTemplateFromFile(archivo).evaluate()
    .setTitle('LM Málaga · Expedición')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setFaviconUrl('https://www.google.com/favicon.ico');
}
```

- [ ] **Step 2: Vaciar el `doGet` de `Codigo.gs`**

Reemplaza TODO el contenido de `Codigo.gs` por (deja el archivo sin `doGet`):

```javascript
/**
 * Codigo.gs · Obsoleto.
 * El punto de entrada único del web app vive ahora en WebApp.gs (doGet enruta por ?vista).
 * Este archivo se deja vacío a propósito para no declarar un segundo doGet().
 */
```

- [ ] **Step 3: Verificar (manual, en el editor GAS tras desplegar)**

No ejecutable aún (faltan `Index.html`/`Dashboard.html`). Comprobación: buscar en el proyecto que solo exista **una** declaración `function doGet`. Expected: 1 resultado (en `WebApp.gs`).

- [ ] **Step 4: Commit** (si usas git)

```bash
git add WebApp.gs Codigo.gs
git commit -m "fix: unificar doGet en un único router por ?vista"
```

---

## Task 2: Arreglar la configuración del webhook de Chat

`enviarNotificacionChat` usa una constante hardcodeada `WEBHOOK_CHAT` en vez del `getWebhookChat()` de `Configuracion.gs`, y el deploy documenta `configurarWebhook(url)` que no existe. Además usa un template literal (backtick) prohibido en `.gs`.

**Files:**
- Modify: `NotificacionesChat.gs:16` (quitar const), `:24-68` (usar propiedad), añadir `configurarWebhook`

- [ ] **Step 1: Eliminar la constante hardcodeada**

Borra la línea 16:

```javascript
const WEBHOOK_CHAT = 'https://chat.googleapis.com/v1/spaces/XXXXX/messages?key=XXX&token=XXX';
```

- [ ] **Step 2: Hacer que `enviarNotificacionChat` lea la propiedad y no bloquee si falta**

Reemplaza la función `enviarNotificacionChat` (líneas ~24-68) por:

```javascript
function enviarNotificacionChat(datos) {
  try {
    var url = getWebhookChat();
    if (!url) {
      if (typeof logActividad === 'function') logActividad('NOTIF_CHAT_SKIP', 'Sin webhook configurado', datos.operario);
      return { ok: false, error: 'Webhook no configurado' };
    }

    var payload = {
      cardsV2: [{
        cardId: 'incidencia-' + new Date().getTime(),
        card: {
          header: { title: '⚠️ Incidencia de preparación', subtitle: 'No localizado · ' + datos.motivo, imageType: 'CIRCLE' },
          sections: [{
            widgets: [
              { decoratedText: { topLabel: 'Pedido',    text: '<b>' + datos.pedido + '</b>' } },
              { decoratedText: { topLabel: 'Ubicación', text: datos.ubicacion } },
              { decoratedText: { topLabel: 'Motivo',    text: datos.motivo } },
              { decoratedText: { topLabel: 'Operario',  text: datos.operario } },
              { decoratedText: { topLabel: 'Hora',      text: datos.hora } }
            ]
          }]
        }
      }]
    };

    var opciones = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };
    var resp = UrlFetchApp.fetch(url, opciones);
    var code = resp.getResponseCode();
    if (typeof logActividad === 'function') logActividad('NOTIF_CHAT', 'Pedido ' + datos.pedido + ' · ' + datos.motivo + ' (HTTP ' + code + ')', datos.operario);
    return { ok: code === 200, code: code };
  } catch (e) {
    console.error('Error enviando a Chat:', e);
    if (typeof logActividad === 'function') logActividad('NOTIF_CHAT_ERROR', e.toString(), datos.operario);
    return { ok: false, error: e.toString() };
  }
}
```

- [ ] **Step 3: Actualizar `enviarNotificacionChatTexto` para usar la propiedad**

En `enviarNotificacionChatTexto`, sustituye `WEBHOOK_CHAT` por una variable local:

```javascript
  var url = getWebhookChat();
  if (!url) return { ok: false, error: 'Webhook no configurado' };
  // ... y usar `url` en UrlFetchApp.fetch(url, opciones)
```

- [ ] **Step 4: Añadir `configurarWebhook`**

Añade al final de `NotificacionesChat.gs`:

```javascript
/**
 * Guarda la URL del webhook en las propiedades del script.
 * Ejecutar UNA VEZ desde el editor: configurarWebhook('https://chat.googleapis.com/...')
 */
function configurarWebhook(url) {
  setWebhookChat(url);
  Logger.log('Webhook configurado.');
  return 'OK';
}
```

- [ ] **Step 5: Verificar (en editor GAS, tras desplegar el backend)**

Ejecutar `probarNotificacion()` SIN webhook configurado. Expected: devuelve `{ok:false, error:'Webhook no configurado'}` y NO lanza excepción. Tras `configurarWebhook('<url real>')`, `probarNotificacion()` debe entregar una tarjeta al espacio de Chat.

- [ ] **Step 6: Commit** (si usas git)

```bash
git add NotificacionesChat.gs
git commit -m "fix: webhook Chat desde PropertiesService + configurarWebhook()"
```

---

## Task 3: Centralizar el código de tienda

`ImportarPyxis.codigoTienda` y `Inventario.TIENDA_POR_CODIGO` definen el mapa tienda↔código por separado. El `idPedido` (`036::942687`) debe ser idéntico en importación, buscador y carga. Centralizamos en `Configuracion.gs`.

**Files:**
- Modify: `Configuracion.gs` (añadir mapa), `ImportarPyxis.gs:182-185` (usar el central), `Inventario.gs:34` (usar el central)

- [ ] **Step 1: Añadir el mapa central en `Configuracion.gs`**

Añade dentro del objeto `CONFIG` (tras `TIENDAS`):

```javascript
  // Código numérico de tienda (prefijo de idPedido y nombre de archivo de inventario)
  CODIGO_TIENDA: { 'Marbella': '014', 'Málaga': '036', 'Granada': '043', 'Mijas': '279' },
```

Y añade, fuera de `CONFIG`, dos helpers:

```javascript
function codigoTienda(tienda) {
  return CONFIG.CODIGO_TIENDA[tienda] || '000';
}
function tiendaPorCodigo(codigo) {
  var m = CONFIG.CODIGO_TIENDA;
  for (var k in m) { if (m[k] === codigo) return k; }
  return null;
}
```

- [ ] **Step 2: Eliminar la `codigoTienda` duplicada de `ImportarPyxis.gs`**

Borra la función `codigoTienda` (líneas ~182-185) de `ImportarPyxis.gs`. Ahora usará la global de `Configuracion.gs`.

- [ ] **Step 3: Reapuntar `Inventario.gs` al mapa central**

En `Inventario.gs`, sustituye la línea 34:

```javascript
const TIENDA_POR_CODIGO = { '014': 'Marbella', '036': 'Málaga', '043': 'Granada', '279': 'Mijas' };
```

por:

```javascript
// Mapa centralizado en Configuracion.gs (tiendaPorCodigo / codigoTienda)
function _tiendaDeCodigo(c) { return tiendaPorCodigo(c); }
```

Y en `tiendaDeNombreArchivo` (línea ~92-93) sustituye `TIENDA_POR_CODIGO[m[1]]` por `tiendaPorCodigo(m[1])`.

- [ ] **Step 4: Verificar (editor GAS)**

Ejecutar en el editor: `Logger.log(codigoTienda('Málaga') + ' ' + tiendaPorCodigo('036'))`. Expected: `036 Málaga`.

- [ ] **Step 5: Commit** (si usas git)

```bash
git add Configuracion.gs ImportarPyxis.gs Inventario.gs
git commit -m "refactor: centralizar mapa código↔tienda en Configuracion.gs"
```

---

## Task 4: Extraer el helper compartido `crearPedidoConLineas`

`importarPedidosPyxis` y el futuro `importarClasificacion` crean pedido+líneas. Extraemos esa lógica a un helper único para no duplicar el esquema de líneas.

**Files:**
- Modify: `ImportarPyxis.gs` (añadir helper, reusar en `importarPedidosPyxis`)
- Test: `Pruebas.gs` (crear)

- [ ] **Step 1 (test primero): crear `Pruebas.gs` con un assert y un test del helper**

Crea `Pruebas.gs`:

```javascript
/** Pruebas ejecutables desde el editor de Apps Script. Ver el log para PASS/FAIL. */
function _assert(cond, msg) {
  if (!cond) { Logger.log('FAIL: ' + msg); throw new Error('FAIL: ' + msg); }
  Logger.log('PASS: ' + msg);
}

function test_crearPedidoConLineas() {
  // Limpia y siembra
  limpiarHoja('PEDIDOS'); limpiarHoja('LINEAS');
  var lineas = [
    { dir: '29031', ref: 'R1', ean: 'E1', des: 'Mesa', ctd: 1 },
    { dir: 'BULTO', ref: 'R2', ean: 'E2', des: 'Tornillos', ctd: 5 },
    { dir: '29030', ref: 'R3', ean: 'E3', des: 'Silla', ctd: 2 }
  ];
  crearPedidoConLineas('036::999001', '999001', 'Málaga', 'Correcaminos', lineas);

  var peds = leerHoja('PEDIDOS');
  _assert(peds.length === 1, 'se creó 1 pedido');
  _assert(peds[0].id === '036::999001', 'idPedido correcto');
  _assert(peds[0].flujo === 'transporte', 'flujo derivado de transportista');
  _assert(Number(peds[0].nUbic) === 3, 'nUbic = 3');

  var lin = leerHoja('LINEAS');
  _assert(lin.length === 3, '3 líneas creadas');
  // picking (BULTO) debe quedar al final (idx 2)
  var bulto = lin.find(function(l){ return l.dir === 'BULTO'; });
  _assert(Number(bulto.idx) === 2, 'la línea de picking va al final');
  _assert(bulto.esPicking === true || bulto.esPicking === 'true', 'BULTO marcado esPicking');
  Logger.log('test_crearPedidoConLineas OK');
}
```

- [ ] **Step 2: Ejecutar el test → debe fallar (función no existe)**

En el editor GAS, ejecuta `test_crearPedidoConLineas`. Expected: error `crearPedidoConLineas is not defined`.

- [ ] **Step 3: Implementar el helper en `ImportarPyxis.gs`**

Añade a `ImportarPyxis.gs`:

```javascript
/**
 * Crea un pedido + sus líneas a partir de líneas crudas { dir, ref, ean, des, ctd }.
 * Reutilizado por importarPedidosPyxis() e importarClasificacion().
 * Devuelve { nLin, nUbic }.
 */
function crearPedidoConLineas(idPedido, numPed, tienda, transportista, lineasRaw) {
  var flujo = CONFIG.TRANSPORTISTAS_FLUJO[transportista] || 'transporte';
  var lineasOrdenadas = ordenarLineasPyxis(lineasRaw);

  var ubic = {};
  lineasOrdenadas.forEach(function(l) { ubic[l.dir] = true; });
  var nUbic = Object.keys(ubic).length;

  anadirFila('PEDIDOS', {
    id: idPedido, ped: numPed, tienda: tienda, transportista: transportista,
    flujo: flujo, estado: 'PENDIENTE', pct: 0, operario: '',
    silueta: '', posIni: '', posFin: '', numeroCarga: '',
    soportes: '[]', nLin: lineasOrdenadas.length, nUbic: nUbic,
    actualizado: new Date().toISOString()
  });

  lineasOrdenadas.forEach(function(l, j) {
    anadirFila('LINEAS', {
      id: idPedido + '::L' + j, idPedido: idPedido, idx: j,
      dir: l.dir, ref: l.ref, ean: l.ean, des: l.des, ctd: l.ctd,
      tipoUbic: clasificarUbicacion(l.dir), esPicking: esPicking(l.dir),
      estado: 'PENDIENTE', motivo: '', operario: '', ts: ''
    });
  });

  return { nLin: lineasOrdenadas.length, nUbic: nUbic };
}
```

- [ ] **Step 4: Reusar el helper dentro de `importarPedidosPyxis`**

En `importarPedidosPyxis`, sustituye el bloque que crea pedido y líneas (dentro del `Object.keys(grupos).forEach`, líneas ~61-94) por:

```javascript
  Object.keys(grupos).forEach(function(numPed) {
    var idPedido = codigoTienda(tienda) + '::' + numPed;
    var res = crearPedidoConLineas(idPedido, numPed, tienda, transportista, grupos[numPed]);
    nPedidos++;
    nLineas += res.nLin;
  });
```

(Elimina el cálculo manual de `flujo`, `nUbic`, etc. que ahora hace el helper.)

- [ ] **Step 5: Ejecutar el test → debe pasar**

Ejecuta `test_crearPedidoConLineas`. Expected: log con varios `PASS:` y `test_crearPedidoConLineas OK`, sin excepción.

- [ ] **Step 6: Commit** (si usas git)

```bash
git add ImportarPyxis.gs Pruebas.gs
git commit -m "refactor: helper compartido crearPedidoConLineas + test"
```

---

## Task 5: Reconciliar `calcularPosiciones` con el empaquetado validado de la demo

El empaquetado de soportes en posiciones back/front es la "regla de oro". La demo tiene la versión validada (`empaquetarSoportes`, ordena de mayor a menor, empareja los 0.5). `Backend.calcularPosiciones` usa otro algoritmo que puede divergir. Lo sustituimos por un port fiel para que servidor (cierre) y cliente (preview) coincidan.

**Files:**
- Modify: `Backend.gs:207-255` (función `calcularPosiciones`)
- Test: `Pruebas.gs`

- [ ] **Step 1 (test primero): añadir test de empaquetado en `Pruebas.gs`**

```javascript
function test_calcularPosiciones() {
  // 2 palet euro (0.5) → 1 posición con back+front
  var r1 = calcularPosiciones([{ tipoId: 'palet_euro', cant: 2 }]);
  _assert(r1.length === 1, '2 euro = 1 posición');
  _assert(r1[0].back === true && r1[0].front === true, '2 euro llenan back+front');

  // 1 palet euro → 1 posición, front reservado
  var r2 = calcularPosiciones([{ tipoId: 'palet_euro', cant: 1 }]);
  _assert(r2.length === 1, '1 euro = 1 posición');
  _assert(r2[0].front === 'reservado', '1 euro reserva el front');

  // 1 palet doble → 1 posición completa
  var r3 = calcularPosiciones([{ tipoId: 'palet_doble', cant: 1 }]);
  _assert(r3.length === 1 && r3[0].front === true, '1 doble llena la posición');

  // 3 euro → 2 posiciones (2 emparejados + 1 con front reservado)
  var r4 = calcularPosiciones([{ tipoId: 'palet_euro', cant: 3 }]);
  _assert(r4.length === 2, '3 euro = 2 posiciones');

  // 1 palet medio (0.25) → 1 posición, front reservado
  var r5 = calcularPosiciones([{ tipoId: 'palet_medio', cant: 1 }]);
  _assert(r5.length === 1 && r5[0].front === 'reservado', '1 medio reserva front');

  // bulto (0) → 0 posiciones
  var r6 = calcularPosiciones([{ tipoId: 'bulto', cant: 5 }]);
  _assert(r6.length === 0, 'bultos no ocupan');
  Logger.log('test_calcularPosiciones OK');
}
```

- [ ] **Step 2: Ejecutar el test contra la implementación actual → anotar resultado**

Ejecuta `test_calcularPosiciones`. Expected: probablemente FALLA en algún assert (el algoritmo actual diverge). Anota cuál.

- [ ] **Step 3: Reemplazar `calcularPosiciones` por el port validado**

Sustituye la función `calcularPosiciones` (líneas 207-255) en `Backend.gs` por:

```javascript
/**
 * Empaqueta soportes en posiciones físicas (back+front), port de la lógica validada
 * de la demo (empaquetarSoportes). DEBE permanecer sincronizada con la copia en Index.html.
 * Devuelve array de { back: true, front: true|'reservado' }.
 */
function calcularPosiciones(soportes) {
  var unidades = [];
  soportes.forEach(function(s) {
    var def = CONFIG.SOPORTES.find(function(x) { return x.id === s.tipoId; });
    var ocupa = def ? def.ocupa : (Number(s.ocupa) || 0);
    if (!ocupa) return; // bultos no ocupan
    for (var i = 0; i < s.cant; i++) unidades.push(ocupa);
  });

  unidades.sort(function(a, b) { return b - a; }); // mayor a menor

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
```

- [ ] **Step 4: Ejecutar el test → debe pasar**

Ejecuta `test_calcularPosiciones`. Expected: todos `PASS:` y `test_calcularPosiciones OK`.

- [ ] **Step 5: Commit** (si usas git)

```bash
git add Backend.gs Pruebas.gs
git commit -m "fix: calcularPosiciones = port del empaquetado validado de la demo"
```

---

# FASE 1 — Puente clasificador → pedidos

## Task 6: `importarClasificacion` (persistir lo clasificado)

Función nueva, misma firma que `clasificarPedidos`, que crea los PEDIDOS+LINEAS reales. Idempotente: omite los que ya existen y no están ENTREGADO.

**Files:**
- Create: `ImportarClasificacion.gs`
- Test: `Pruebas.gs`

- [ ] **Step 1 (test primero): test de mapeo zona→transportista en `Pruebas.gs`**

```javascript
function test_zonaTransportista() {
  _assert(ZONA_TRANSPORTISTA['Transporte'] === 'Correcaminos', 'Transporte→Correcaminos');
  _assert(ZONA_TRANSPORTISTA['Instalaciones'] === 'Correcaminos Instalaciones', 'Instalaciones→Correcaminos Instalaciones');
  _assert(ZONA_TRANSPORTISTA['PRO'] === 'Correcaminos PRO', 'PRO→Correcaminos PRO');
  _assert(ZONA_TRANSPORTISTA['Remansur'] === 'Remansur', 'Remansur→Remansur');
  Logger.log('test_zonaTransportista OK');
}
```

- [ ] **Step 2: Ejecutar → falla (ZONA_TRANSPORTISTA no definido)**

Ejecuta `test_zonaTransportista`. Expected: `ZONA_TRANSPORTISTA is not defined`.

- [ ] **Step 3: Crear `ImportarClasificacion.gs`**

```javascript
/**
 * ============================================================
 * ImportarClasificacion.gs
 * Puente: convierte la clasificación de pedidos (Inventario.gs)
 * en PEDIDOS + LINEAS reales del sistema. Idempotente.
 * ============================================================
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
 * opciones: { tiendaColisiones, parciales:[{ped,transporte,dirs:[...]}] }
 * Devuelve { ok, creados:[], omitidos:[], noEncontrados:[], colisiones:[] }
 */
function importarClasificacion(numerosPorTransporte, opciones) {
  opciones = opciones || {};
  var tiendaColisiones = opciones.tiendaColisiones || null;
  var parciales = opciones.parciales || [];
  var inv = cargarInventario();
  var indice = inv.indice;

  // Pedidos ya existentes (para idempotencia): id → estado
  var existentes = {};
  leerHoja('PEDIDOS').forEach(function(p) { existentes[p.id] = p.estado; });

  var esParcial = {};
  parciales.forEach(function(p) { esParcial[p.transporte + '|' + String(p.ped).trim()] = true; });

  var creados = [], omitidos = [], noEncontrados = [], colisiones = [];

  function procesar(numPed, transporte, dirsSel) {
    var transportista = ZONA_TRANSPORTISTA[transporte];
    if (!transportista) { return; }
    var entry = indice[numPed];
    if (!entry) { noEncontrados.push(numPed); return; }
    var r = resolverOcurrencia(entry, tiendaColisiones);
    if (r.colision) { colisiones.push({ ped: numPed, transporte: transporte, tiendas: r.tiendas }); return; }
    var tienda = r.tienda;
    if (CONFIG.TIENDAS.indexOf(tienda) === -1) { noEncontrados.push(numPed + ' (' + tienda + ' fuera de expedición)'); return; }
    var idPedido = codigoTienda(tienda) + '::' + numPed;
    if (existentes[idPedido] !== undefined && existentes[idPedido] !== 'ENTREGADO') { omitidos.push(numPed); return; }

    var lineasRaw = r.data.lineas;
    if (dirsSel && dirsSel.length) {
      lineasRaw = lineasRaw.filter(function(l) { return dirsSel.indexOf(l.dir) !== -1; });
    }
    crearPedidoConLineas(idPedido, numPed, tienda, transportista, lineasRaw);
    creados.push(numPed);
    existentes[idPedido] = 'PENDIENTE';
  }

  // 1) bloques pegados
  TRANSPORTES.forEach(function(t) {
    var nums = (numerosPorTransporte[t] || []).map(function(n) { return String(n).trim(); }).filter(Boolean);
    nums.forEach(function(n) { if (esParcial[t + '|' + n]) return; procesar(n, t, null); });
  });
  // 2) parciales
  parciales.forEach(function(p) {
    procesar(String(p.ped).trim(), p.transporte, (p.dirs || []).map(function(d) { return String(d).trim(); }));
  });

  logActividad('IMPORTAR_CLASIF', creados.length + ' creados, ' + omitidos.length + ' omitidos, ' + noEncontrados.length + ' no encontrados', '');
  return { ok: true, creados: creados, omitidos: omitidos, noEncontrados: noEncontrados, colisiones: colisiones };
}
```

- [ ] **Step 4: Ejecutar `test_zonaTransportista` → pasa**

Expected: PASS en los 4 asserts.

- [ ] **Step 5: Verificar idempotencia (manual, requiere inventario en Drive)**

Tras configurar `INVENTARIO_FOLDER_ID` con datos reales, ejecutar dos veces seguidas:
`importarClasificacion({ Transporte: ['<un nº real>'] }, {})`.
Expected: 1ª vez → `creados:['<nº>']`; 2ª vez → `omitidos:['<nº>']`, `creados:[]`. Y `leerHoja('PEDIDOS')` no tiene duplicados de ese id.

- [ ] **Step 6: Commit** (si usas git)

```bash
git add ImportarClasificacion.gs Pruebas.gs
git commit -m "feat: importarClasificacion (puente clasificador→PEDIDOS, idempotente)"
```

---

## Task 7: Botón "Importar al sistema" en `Clasificador.html`

Tras *Clasificar* (preview, ya existe), un botón nuevo confirma y persiste vía `importarClasificacion`.

**Files:**
- Modify: `Clasificador.html` (`.acciones` ~112-116, y `<script>`)

- [ ] **Step 1: Añadir el botón en la barra de acciones**

En el bloque `<div class="acciones">` (líneas 112-116), añade tras el botón "Clasificar":

```html
    <button class="btn" id="btnImportar" onclick="importar()" style="background:var(--grn)" disabled>⬇ Importar al sistema</button>
```

- [ ] **Step 2: Habilitar el botón sólo cuando hay resultado clasificado**

En `onResultado(data)` (línea ~221), al final, añade:

```javascript
  window._ultimaClasificacion = { payload: window._ultimoPayload, opciones: { tiendaColisiones: tiendaColisiones, parciales: parciales } };
  document.getElementById('btnImportar').disabled = false;
```

Y en `clasificar()` (línea ~210), justo antes de la llamada `google.script.run`, guarda el payload:

```javascript
  window._ultimoPayload = payload;
```

- [ ] **Step 3: Añadir la función `importar()` al `<script>`**

Añade antes de `</script>`:

```javascript
function importar() {
  if (!window._ultimaClasificacion) { document.getElementById('estado').textContent = 'Clasifica primero.'; return; }
  if (!confirm('¿Importar al sistema los pedidos clasificados? Los que ya existan y no estén entregados se respetan.')) return;
  var btn = document.getElementById('btnImportar');
  btn.disabled = true;
  document.getElementById('estado').textContent = 'Importando al sistema…';
  google.script.run
    .withSuccessHandler(function(res) {
      btn.disabled = false;
      var msg = '✓ Importados ' + res.creados.length + ' · omitidos ' + res.omitidos.length + ' · no encontrados ' + res.noEncontrados.length;
      if (res.colisiones && res.colisiones.length) msg += ' · ' + res.colisiones.length + ' colisiones sin resolver';
      document.getElementById('estado').textContent = msg;
    })
    .withFailureHandler(function(e) {
      btn.disabled = false;
      document.getElementById('estado').textContent = 'Error: ' + e.message;
    })
    .importarClasificacion(window._ultimaClasificacion.payload, window._ultimaClasificacion.opciones);
}
```

- [ ] **Step 4: Verificar (tras desplegar)**

Abrir `?vista=clasificador`, pegar pedidos reales, *Clasificar* (se habilita Importar), *Importar al sistema*. Expected: mensaje con conteo de creados/omitidos; al abrir la app de operario los pedidos aparecen.

- [ ] **Step 5: Commit** (si usas git)

```bash
git add Clasificador.html
git commit -m "feat: botón Importar al sistema en el clasificador"
```

---

# FASE 2 — Index.html: flujo operario

> **Estrategia de port (aplica a TODAS las tasks de Fase 2-4):** copiar de `DEMO_referencia_v12.html` el `<style>` y el HTML del `<body>` **tal cual**, copiar las funciones `pantalla*`/`render*`/swipe **verbatim** y luego aplicar SOLO los cambios de capa de datos indicados. Patrón de conversión: las lecturas síncronas `API.x()` pasan a `await gas('x', ...)`; las pantallas que las consumen pasan a `async function`; añadir overlay durante la espera.

## Task 8: Andamiaje de `Index.html` (HTML/CSS + capa `gas()` + bootstrap CFG)

**Files:**
- Create: `Index.html`

- [ ] **Step 1: Copiar cabecera, `<style>` y `<body>` de la demo**

Crea `Index.html` con: el `<head>` (fuentes + `<base target="_top">`), el `<style>` íntegro de `DEMO_referencia_v12.html` (verbatim), y el HTML del `<body>` (la tab bar `tabApp/tabCarga/tabBuscar/tabDash`, el contenedor `#app`, `#toast`, `#breadcrumb`, `#userChip`) **verbatim**. NO copies aún el `<script>`.

- [ ] **Step 2: Añadir el helper `gas()` y el overlay en el `<script>`**

Empieza el `<script>` con:

```javascript
// === Capa de datos: backend GAS (sustituye al API/localStorage de la demo) ===
function gas(metodo) {
  var args = Array.prototype.slice.call(arguments, 1);
  mostrarOverlay(true);
  return new Promise(function(resolve, reject) {
    var runner = google.script.run
      .withSuccessHandler(function(r) { mostrarOverlay(false); resolve(r); })
      .withFailureHandler(function(e) { mostrarOverlay(false); reject(e); });
    runner[metodo].apply(runner, args);
  });
}
function mostrarOverlay(v) {
  var o = document.getElementById('gasOverlay');
  if (!o) {
    o = document.createElement('div'); o.id = 'gasOverlay';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(8,10,16,.45);display:none;align-items:center;justify-content:center;z-index:9999;font-family:Bebas Neue,sans-serif;letter-spacing:2px;color:#fff;font-size:20px';
    o.textContent = 'CARGANDO…';
    document.body.appendChild(o);
  }
  o.style.display = v ? 'flex' : 'none';
}

var CFG = null; // se rellena en arranque (obtenerConfig)
// Aliases para que el resto del código portado siga usando los nombres de la demo:
var SILUETAS, POSICIONES, SOPORTES, TIENDAS, TRANSPORTISTAS_FLUJO;
function flujoLetra(f) { return (CFG && CFG.flujoLetra[f]) || ''; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
```

- [ ] **Step 3: Bootstrap: cargar CFG una vez al arrancar**

Al final del `<script>`, sustituye el arranque de la demo (que llamaba a `pantallaOperario()` directamente) por:

```javascript
window.addEventListener('DOMContentLoaded', function() {
  gas('obtenerConfig').then(function(cfg) {
    CFG = cfg;
    SILUETAS = CFG.siluetas;
    POSICIONES = CFG.posiciones;
    SOPORTES = CFG.soportes;
    TIENDAS = CFG.tiendas;
    TRANSPORTISTAS_FLUJO = CFG.transportistasFlujo;
    iniciarTabs();        // listeners de la tab bar (copiar de la demo)
    pantallaOperario();   // pantalla inicial
  }).catch(function(e) {
    document.body.innerHTML = '<p style="color:#fff;padding:20px">Error cargando configuración: ' + e.message + '</p>';
  });
});
```

- [ ] **Step 4: Copiar el objeto `estado`, helpers de UI y el control de tabs (verbatim)**

Copia de la demo: el objeto `const estado = {...}` (línea 701), `toast`, `bread`, `$`, `app`, y la lógica de cambio de pestaña. Encapsula los listeners de la tab bar en `function iniciarTabs(){ ... }` (mueve allí el código que la demo ejecuta inline para `tabApp/tabCarga/tabBuscar/tabDash`). NO copies `DATA`, `PEDIDOS_INIT`, `OCUPACION_INIT`, `cargarEstado`, `guardarEstado`, `inicializarDatos`, `resetDemo`, `ordenarLineas`, `actualizarEstadoPedido`, ni el objeto `API` (todos se sustituyen por backend).

- [ ] **Step 5: Verificar (tras desplegar el backend completo de Fase 0-1)**

Abrir la URL `?vista=app`. Expected: carga sin error de consola, se ve la pantalla de selección de operario (aunque las listas aún no estén cableadas — eso es Task 9).

- [ ] **Step 6: Commit** (si usas git)

```bash
git add Index.html
git commit -m "feat: andamiaje Index.html (gas() + CFG bootstrap, sin capa demo)"
```

---

## Task 9: Navegación de operario y lista de pedidos (async)

**Files:**
- Modify: `Index.html` (`pantallaOperario`, `pantallaRaiz`, `pantallaTienda`, `pantallaRemansurTipo`, `pantallaListaPedidos`)

- [ ] **Step 1: Copiar las pantallas de navegación verbatim**

Copia de la demo `pantallaOperario` (813), `pantallaRaiz` (822), `pantallaTienda` (843), `pantallaRemansurTipo` (866) y `pantallaListaPedidos` (880). Usan `CFG`/`SILUETAS`/etc. vía los alias del Task 8.

- [ ] **Step 2: Convertir `pantallaListaPedidos` a async contra el backend**

La demo llama síncrona a `API.listarPedidosCorrecaminos(tienda, flujo)` / `API.listarPedidosRemansur(...)`. Sustituye esas llamadas por una sola async, y **filtra los que ya están en silueta** (esos no se preparan):

```javascript
async function pantallaListaPedidos() {
  var flujo = estado.remansurTipo ? estado.remansurTipo.id : (estado.raizSel ? estado.raizSel.id : null);
  var tienda = estado.tienda;
  var pedidos = await gas('listarPedidos', flujo, tienda);
  pedidos = pedidos.filter(function(p) { return !p.silueta; }); // excluir los ya cerrados a silueta
  // ... resto del render verbatim de la demo, usando `pedidos` ...
}
```

> Nota: `estado.raizSel.id`/`estado.remansurTipo.id` deben coincidir con los flujos de CFG (`transporte`, `instalacion`, `pro`, `remansur_transporte`). Verifica los `id` que la demo asigna en `pantallaRaiz`/`pantallaRemansurTipo` y ajústalos a los flujos de CFG si difieren.

- [ ] **Step 3: Verificar (desplegado)**

Importar pedidos vía clasificador, abrir operario → flujo → tienda. Expected: aparece la lista de pedidos de esa tienda/flujo, ordenada por nº de ubicaciones, sin los que ya estén en silueta.

- [ ] **Step 4: Commit** (si usas git)

```bash
git add Index.html
git commit -m "feat: navegación operario + lista de pedidos contra backend"
```

---

## Task 10: Preparación por líneas (swipe, marcar, deshacer)

**Files:**
- Modify: `Index.html` (`renderLinea`, swipe handlers, motivos, deshacer)

- [ ] **Step 1: Copiar `renderLinea` y los handlers de swipe verbatim**

Copia de la demo `renderLinea` (919) y todo el manejo de swipe/gestos y el modal de motivos. La pantalla de preparación carga las líneas del pedido activo.

- [ ] **Step 2: Cargar líneas del pedido vía backend al abrir el pedido**

Donde la demo hacía `const r = API.lineas(idPedido)`, sustituye por:

```javascript
async function abrirPedido(idPedido) {
  var r = await gas('obtenerPedidoConLineas', idPedido);
  estado.pedidoActivo = r.pedido;
  estado.lineas = r.lineas.slice().sort(function(a, b){ return a.idx - b.idx; });
  estado.idxActual = 0;
  renderLinea();
}
```

(Adapta el nombre real de la función de apertura de la demo; el contrato `{pedido, lineas}` de `obtenerPedidoConLineas` ya coincide con lo que la demo esperaba de `API.lineas`.)

- [ ] **Step 3: Convertir "marcar línea" a backend**

Donde la demo hacía `API.marcar(idPedido, idx, estado, motivo, operario, vuelveAlFinal)`, sustituye por una versión que llama al backend y guarda la acción para deshacer:

```javascript
async function marcarLineaUI(estadoNuevo, motivoLabel, vuelveAlFinal) {
  var l = estado.lineas[estado.idxActual];
  estado.ultimaAccion = { idx: l.idx, estadoAnterior: l.estado, motivoAnterior: l.motivo };
  await gas('marcarLinea', estado.pedidoActivo.id, l.idx, estadoNuevo, motivoLabel || '', estado.operario, !!vuelveAlFinal);
  l.estado = estadoNuevo; l.motivo = motivoLabel || '';
  avanzarLinea(); // lógica de avance verbatim de la demo
}
```

> El backend ya envía la notificación de Chat dentro de `marcarLinea` cuando el estado es `NO_ENCONTRADO`/`NO_SALE`. **Elimina** el modal simulado de notificación de la demo (líneas ~1055-1070).

- [ ] **Step 4: Convertir "deshacer" a backend (re-marcar al estado anterior)**

```javascript
async function deshacerUI() {
  var ua = estado.ultimaAccion;
  if (!ua) { toast('Nada que deshacer', 'err'); return; }
  await gas('marcarLinea', estado.pedidoActivo.id, ua.idx, ua.estadoAnterior || 'PENDIENTE', ua.motivoAnterior || '', estado.operario, false);
  var l = estado.lineas.find(function(x){ return x.idx === ua.idx; });
  if (l) { l.estado = ua.estadoAnterior; l.motivo = ua.motivoAnterior; }
  estado.ultimaAccion = null;
  renderLinea();
}
```

- [ ] **Step 5: Verificar (desplegado)**

Abrir un pedido, swipe derecha (preparado) e izquierda (motivo). Expected: el % del pedido avanza; "No encontrado"/"No sale" cierran la línea (y, con webhook configurado, llega aviso a Chat); deshacer restaura la línea.

- [ ] **Step 6: Commit** (si usas git)

```bash
git add Index.html
git commit -m "feat: preparación por líneas (marcar/deshacer) contra backend"
```

---

## Task 11: Cierre a silueta (ocupación cacheada + empaquetado local + cerrarPedido)

Esta pantalla es interactiva: cachea la ocupación UNA vez y mantiene empaquetado/asignación en local; solo el cierre final llama al backend.

**Files:**
- Modify: `Index.html` (`pantallaCerrarPedido` y funciones asociadas)

- [ ] **Step 1: Copiar verbatim el bloque de cierre de la demo**

Copia `pantallaCerrarPedido` (1079), `pintarSiluetas`, `addSop`, `recalc`, `selSilueta`, `activarModoManual`, `desactivarModoManual`, `calcularPosManual`, `pintarMapa`, `validar`, `confirmarCierre` (líneas 1079-1352), y **copia también `empaquetarSoportes` y `asignarAutomatico`** del objeto `API` de la demo (líneas 501-553) como funciones locales sueltas (sin el prefijo `API.`).

- [ ] **Step 2: Cachear la ocupación al entrar y dar `ocupacionSilueta` local**

Añade una cache de módulo y una función local que reemplaza `API.ocupacionSilueta`:

```javascript
var OCUP_CACHE = []; // ocupación de TODAS las siluetas, cacheada al entrar al cierre
function ocupacionSilueta(letra) { return OCUP_CACHE.filter(function(o){ return o.silueta === letra; }); }
```

Convierte `pantallaCerrarPedido` en async y carga la cache al inicio:

```javascript
async function pantallaCerrarPedido() {
  OCUP_CACHE = await gas('obtenerOcupacionTodas');
  // ... resto del cuerpo verbatim (pintarSiluetas, addSop, etc.) ...
}
```

- [ ] **Step 3: Sustituir `API.empaquetarSoportes`/`API.asignarAutomatico`/`API.ocupacionSilueta` por las locales**

En `recalc`, `selSilueta`, `pintarSiluetas`, `calcularPosManual`, reemplaza:
- `API.empaquetarSoportes(` → `empaquetarSoportes(`
- `API.asignarAutomatico(` → `asignarAutomatico(`
- `API.ocupacionSilueta(` → `ocupacionSilueta(`

(Son ahora funciones locales puras sobre `OCUP_CACHE`; la UI sigue siendo síncrona y fluida.)

- [ ] **Step 4: Convertir `confirmarCierre` a backend**

El backend recalcula posiciones desde `soportes` (mismo algoritmo, Task 5) y deriva `posFin`. Sustituye `confirmarCierre`:

```javascript
async function confirmarCierre() {
  if (!cierre.silueta || !cierre.asignacionOk) { toast('Faltan datos', 'err'); return; }
  var r = await gas('cerrarPedido', estado.pedidoActivo.id, cierre.silueta, cierre.posIni, cierre.soportes, estado.operario);
  if (!r.ok) { toast('Error: ' + r.error, 'err'); return; }
  toast('✓ Cerrado · ' + cierre.silueta + r.posIni + (r.posIni !== r.posFin ? '–' + r.posFin : ''), 'ok');
  setTimeout(pantallaListaPedidos, 1100);
}
```

- [ ] **Step 5: Verificar (desplegado)**

Preparar un pedido al 100%, ir a cierre, añadir soportes (p.ej. 2 palet euro), elegir silueta. Expected: el preview de "posiciones necesarias" coincide con lo que asigna el servidor; al cerrar, el pedido pasa a COMPLETADO_LISTO con silueta/posición y aparece ocupada en la silueta.

- [ ] **Step 6: Commit** (si usas git)

```bash
git add Index.html
git commit -m "feat: cierre a silueta (ocupación cacheada + cerrarPedido backend)"
```

---

# FASE 3 — Index.html: carga, buscador, dashboard interno

## Task 12: Cargador (crear carga → imprimir → confirmar entregas)

**Files:**
- Modify: `Index.html` (`pantallaCargaInicio`, `pantallaCargaImprimir`, `pantallaCargaConfirmar`)

- [ ] **Step 1: Copiar verbatim las 3 fases de carga**

Copia `pantallaCargaInicio` (1357), `pantallaCargaImprimir` (1437) y `pantallaCargaConfirmar` (1539), incluida la generación de la hoja imprimible con código de barras SVG (puro frontend, se copia tal cual).

- [ ] **Step 2: Convertir las llamadas de carga a backend**

Sustituye:
- `API.obtenerCargaActiva()` → `await gas('obtenerCargaActiva')`
- `API.pedidosDisponiblesParaCarga()` → `await gas('pedidosDisponiblesParaCarga')`
- `API.crearCarga(lista)` → `await gas('crearCarga', lista)`
- `API.confirmarEntregas(idCarga, nums)` → `await gas('confirmarEntregas', idCarga, nums)`

Marca como `async` las pantallas que las usan. Para `estadoCarga()` (helper que la demo derivaba en local), calcula los conteos en cliente a partir de `obtenerCargaActiva()` (total / entregados / pendientes filtrando `carga.items`).

- [ ] **Step 3: Verificar (desplegado)**

Con pedidos en silueta: crear carga pegando sus números → preview correcto → generar hoja → imprimir (abre ventana con códigos de barras) → confirmar entregas escaneando algunos. Expected: los confirmados liberan su silueta y pasan a ENTREGADO; los no escaneados quedan en CARGA_2.

- [ ] **Step 4: Commit** (si usas git)

```bash
git add Index.html
git commit -m "feat: cargador (crear/imprimir/confirmar) contra backend"
```

---

## Task 13: Buscador

**Files:**
- Modify: `Index.html` (`pantallaBuscar`)

- [ ] **Step 1: Copiar `pantallaBuscar` verbatim (1615)** y la función `renderResultadoBusqueda` asociada.

- [ ] **Step 2: Convertir la búsqueda a backend**

Sustituye `API.buscarPedido(num)` por `await gas('buscarPedido', num)`. El contrato (tienda, transportista, flujo, estado, silueta/posición, líneas con estado) ya coincide con lo que devuelve `Backend.buscarPedido`.

- [ ] **Step 3: Verificar (desplegado)**

Buscar un nº de pedido existente. Expected: muestra tienda/transportista/flujo/estado, silueta+posición si está en silueta, y la lista de ubicaciones con su estado.

- [ ] **Step 4: Commit** (si usas git)

```bash
git add Index.html
git commit -m "feat: buscador contra backend"
```

---

## Task 14: Dashboard interno (pestaña Dash)

**Files:**
- Modify: `Index.html` (`renderDashboard`)

- [ ] **Step 1: Copiar `renderDashboard` verbatim (1688)**.

- [ ] **Step 2: Convertir a backend + derivar resumen en cliente**

La demo usaba `API.estadoDashboard()` (que devolvía `resumen`, `porOperario`, `ocupacion` como mapa). El backend ofrece `obtenerDatosDashboard()` → `{pedidos, ocupacion(array), cargaActiva}`. Reemplaza por:

```javascript
async function renderDashboard() {
  var d = await gas('obtenerDatosDashboard');
  var pedidos = d.pedidos;
  var resumen = {
    total: pedidos.length,
    completados: pedidos.filter(function(p){ return p.estado === 'COMPLETADO' || p.estado === 'COMPLETADO_LISTO'; }).length,
    enPreparacion: pedidos.filter(function(p){ return p.estado === 'EN_PREPARACION'; }).length,
    pendientes: pedidos.filter(function(p){ return p.estado === 'PENDIENTE'; }).length
  };
  var ocupMapa = {};
  d.ocupacion.forEach(function(o){ if (!ocupMapa[o.silueta]) ocupMapa[o.silueta] = []; ocupMapa[o.silueta].push(o); });
  // ... resto del render verbatim, usando `resumen` y `ocupMapa` ...
}
```

- [ ] **Step 3: Verificar (desplegado)**

Abrir pestaña Dash. Expected: KPIs y mapa de siluetas reflejan el estado real.

- [ ] **Step 4: Commit** (si usas git)

```bash
git add Index.html
git commit -m "feat: dashboard interno contra backend"
```

---

# FASE 4 — Dashboard.html (TV de pared)

## Task 15: Port de `Dashboard.html`

**Files:**
- Create: `Dashboard.html` (desde `DASHBOARD_referencia_v3.html`)

- [ ] **Step 1: Copiar `DASHBOARD_referencia_v3.html` íntegro como `Dashboard.html`** (head, style, body, script verbatim).

- [ ] **Step 2: Añadir `gas()` (sin overlay) y CFG**

Reusa el helper `gas()` (versión sin overlay para TV) y carga `CFG` al arrancar igual que en Index (Task 8, Steps 2-3), adaptando los alias que use el dashboard.

- [ ] **Step 3: Sustituir la fuente de datos por backend con poll de 10s**

Donde el dashboard de referencia lee de `localStorage`/`DATA`, sustituye por un poll:

```javascript
async function refrescar() {
  try {
    var d = await gas('obtenerDatosDashboard');
    pintarDashboard(d); // adaptar el render existente al contrato {pedidos, ocupacion[], cargaActiva}
  } catch (e) { /* mantener última pintura */ }
}
window.addEventListener('DOMContentLoaded', function() {
  gas('obtenerConfig').then(function(cfg){ CFG = cfg; refrescar(); setInterval(refrescar, 10000); });
});
```

- [ ] **Step 4: Modo mañana/tarde automático**

Usa `CFG.horaCambioModo` y la hora local del navegador para alternar modo (`< horaCambioModo` = mañana). Conserva la lógica visual de la referencia.

- [ ] **Step 5: Verificar (desplegado)**

Abrir `?vista=dashboard`. Expected: pantalla TV en vivo, refresco cada 10s, modo correcto según la hora.

- [ ] **Step 6: Commit** (si usas git)

```bash
git add Dashboard.html
git commit -m "feat: Dashboard.html TV contra backend con poll 10s"
```

---

# FASE 5 — Verificación end-to-end

## Task 16: `verificarSistema()` — smoke test del pipeline completo

**Files:**
- Modify: `Pruebas.gs`

- [ ] **Step 1: Añadir el smoke test**

```javascript
/**
 * Smoke test end-to-end (ejecutar en el editor). NO requiere inventario de Drive:
 * crea un pedido directamente con crearPedidoConLineas y recorre todo el flujo.
 * Deja el sistema con un pedido ENTREGADO de prueba (id 036::999777).
 */
function verificarSistema() {
  limpiarHoja('PEDIDOS'); limpiarHoja('LINEAS'); limpiarHoja('OCUPACION'); limpiarHoja('CARGAS'); limpiarHoja('HISTORIAL');

  // 1) Carga de pedido
  crearPedidoConLineas('036::999777', '999777', 'Málaga', 'Correcaminos', [
    { dir: '29031', ref: 'R1', ean: 'E1', des: 'Mesa', ctd: 1 },
    { dir: '29032', ref: 'R2', ean: 'E2', des: 'Silla', ctd: 2 }
  ]);
  var pid = '036::999777';

  // 2) Preparación: marcar ambas líneas PREPARADO
  marcarLinea(pid, 0, 'PREPARADO', '', 'Pedro Gil', false);
  marcarLinea(pid, 1, 'PREPARADO', '', 'Pedro Gil', false);
  var ped = leerHoja('PEDIDOS').find(function(p){ return p.id === pid; });
  _assert(ped.estado === 'COMPLETADO_LISTO', 'pedido COMPLETADO_LISTO tras preparar todo');

  // 3) Cierre a silueta A con 2 palet euro (1 posición)
  var rc = cerrarPedido(pid, 'A', 1, [{ tipoId: 'palet_euro', cant: 2 }], 'Pedro Gil');
  _assert(rc.ok, 'cierre OK');
  _assert(rc.posIni === 1 && rc.posFin === 1, 'ocupa 1 posición (2 euro)');
  var ocup = obtenerOcupacionSilueta('A');
  _assert(ocup.length === 2, 'back+front ocupados en A1');

  // 4) Crear carga
  var cc = crearCarga(['999777']);
  _assert(cc.ok && cc.carga.numCarga === 1, 'carga 1 creada');

  // 5) Confirmar entrega
  var ce = confirmarEntregas(cc.carga.id, ['999777']);
  _assert(ce.entregados === 1, '1 entregado');
  var ocup2 = obtenerOcupacionSilueta('A');
  _assert(ocup2.length === 0, 'silueta A liberada tras entrega');
  var pedFinal = leerHoja('PEDIDOS').find(function(p){ return p.id === pid; });
  _assert(pedFinal.estado === 'ENTREGADO', 'pedido ENTREGADO');

  Logger.log('✓✓ verificarSistema OK — pipeline completo verificado');
}
```

- [ ] **Step 2: Ejecutar en el editor GAS**

Ejecuta `verificarSistema`. Expected: log con todos los `PASS:` y `✓✓ verificarSistema OK`. Si algún assert falla, corregir la función backend implicada antes de seguir.

- [ ] **Step 3: Commit** (si usas git)

```bash
git add Pruebas.gs
git commit -m "test: verificarSistema smoke end-to-end del pipeline"
```

---

## Task 17: Checklist de despliegue

**Files:**
- Create: `docs/DESPLIEGUE.md`

- [ ] **Step 1: Escribir el checklist**

Crea `docs/DESPLIEGUE.md`:

```markdown
# Despliegue — LM Málaga Expedición

1. `clasp create --type webapp --title "LM Málaga Expedición"` y `clasp push` (todos los .gs y .html).
2. Editor GAS → Servicios (+) → Drive API → Añadir (necesario para importar inventarios Excel).
3. Ejecutar UNA VEZ `inicializarSistema()` → anotar URL del Spreadsheet creado.
4. En `Inventario.gs`, comprobar `INVENTARIO_FOLDER_ID` (carpeta de Drive con los inventarios por tienda).
5. (Opcional) `configurarWebhook('<url webhook Chat>')` y `probarNotificacion()`.
6. Ejecutar `verificarSistema()` → debe loguear `✓✓ verificarSistema OK`.
7. Implementar → Nueva implementación → App web (Ejecutar como: Yo · Acceso: según política).
8. URLs:
   - App operario:  `.../exec`  (o `?vista=app`)
   - Clasificador:  `.../exec?vista=clasificador`
   - Dashboard TV:  `.../exec?vista=dashboard`
9. Recorrido manual: clasificar+importar pedidos reales → preparar → cerrar a silueta → crear carga → imprimir → confirmar entregas → ver dashboard.

> Tras `verificarSistema()` el sistema queda con datos de prueba; ejecuta de nuevo limpiezas o reimporta antes de producción.
```

- [ ] **Step 2: Commit** (si usas git)

```bash
git add docs/DESPLIEGUE.md
git commit -m "docs: checklist de despliegue"
```

---

## Auto-revisión del plan (cobertura del spec)

- **doGet unificado** → Task 1 ✓
- **Puente importarClasificacion idempotente** → Task 6 ✓ + botón Task 7 ✓
- **Webhook fix + configurarWebhook** → Task 2 ✓
- **Código de tienda centralizado / idPedido consistente** → Task 3 ✓
- **Helper compartido creación pedidos** → Task 4 ✓
- **Reconciliación algoritmo siluetas** → Task 5 (movida adelante porque el cierre depende de ella) ✓
- **Index.html (operario→cierre→carga→buscador→dash)** → Tasks 8-14 ✓
- **Dashboard.html** → Task 15 ✓
- **verificarSistema + checklist** → Tasks 16-17 ✓
- **Async/caching para UI fluida** → recogido en Tasks 8 (gas/overlay) y 11 (OCUP_CACHE) ✓
- **No añadir 5ª zona Remansur PRO** → respetado (ZONA_TRANSPORTISTA tiene 4 zonas) ✓

Consistencia de nombres verificada: `crearPedidoConLineas`, `calcularPosiciones`, `importarClasificacion`, `ZONA_TRANSPORTISTA`, `gas`, `OCUP_CACHE`, `ocupacionSilueta`, `empaquetarSoportes`, `asignarAutomatico` usados de forma idéntica en todas las tasks.
</content>
