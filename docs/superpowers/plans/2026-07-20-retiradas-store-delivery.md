# Retiradas de pedido (Store Delivery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir, dentro de la pestaña admin "🗂️ Store Delivery" de `lm_produccion`, una sección para pegar una lista de números de pedido de una tienda y registrar en bloque la simulación de "cliente viene a recoger" contra la API pública de Leroy Merlin, sin necesidad de navegador ni programa externo.

**Architecture:** Todo en Apps Script existente. Backend nuevo en `Backend.gs` que llama por `UrlFetchApp` a `store-delivery-api-pro.sales-pro-eslm.tech.adeo.cloud` (API pública, sin login). Frontend nuevo en `Index.html`, segunda `.section-card` dentro de `pantallaStoreDelivery()`, que llama al backend **una vez por pedido** (no en lote) para no bloquear el watchdog de 20s de `gas()` y para mostrar progreso en vivo. Resultados quedados en una hoja nueva `RETIRADAS_STOCK`.

**Tech Stack:** Google Apps Script (`.gs`, sin arrow functions ni template literals), HTML/JS de cliente (`Index.html`, sí permite ES6), Google Sheets como almacenamiento, `UrlFetchApp` como cliente HTTP.

---

## Nota sobre pruebas y verificación (leer antes de empezar)

Este proyecto **no puede ejecutar Apps Script en local** (confirmado por convención existente en `Pruebas.gs`: los tests son funciones `test_*`/`probarNotificacion()`/`probarAvisoChat()` que el usuario ejecuta a mano desde el editor de Apps Script y lee en el log). Además, la API de Leroy Merlin que vamos a llamar es de **producción real**: un `POST` de confirmación contra un pedido real tiene el mismo efecto que si el cliente hubiera confirmado su recogida en el kiosco de tienda. Por eso:

- No hay un paso "run pytest" — no existe ese runner aquí.
- No se escribe un test automático que llame a la API real (no hay forma segura de repetirlo sin afectar pedidos reales).
- Verificación = desplegar con `clasp push` + ejecutar manualmente desde el editor de Apps Script (funciones `probarRetiradaPedido`, igual que `probarNotificacion`) + probar en el navegador real.
- **No hay repositorio git en este proyecto** (`Desktop\Proyectos\lm_produccion` no es un repo git) — los pasos de "commit" de esta plantilla se sustituyen por "guardar el archivo" (ya hecho por la propia edición) y el `clasp push` final del Task 6 hace de punto de control.

---

### Task 1: Registrar la hoja `RETIRADAS_STOCK`

**Files:**
- Modify: `Configuracion.gs:127-135` (bloque `HOJAS`)
- Modify: `Configuracion.gs:138-148` (bloque `COLUMNAS`)

- [ ] **Step 1: Añadir la clave `RETIRADAS` a `HOJAS`**

En `Configuracion.gs`, sustituir:

```javascript
const HOJAS = {
  PEDIDOS: 'PEDIDOS',
  LINEAS: 'LINEAS_PREPARACION',
  OCUPACION: 'OCUPACION_SILUETAS',
  CARGAS: 'CARGAS',
  HISTORIAL: 'HISTORIAL_ENTREGAS',
  LOG: 'LOG_ACTIVIDAD',
  VISAS: 'VISAS'
};
```

por:

```javascript
const HOJAS = {
  PEDIDOS: 'PEDIDOS',
  LINEAS: 'LINEAS_PREPARACION',
  OCUPACION: 'OCUPACION_SILUETAS',
  CARGAS: 'CARGAS',
  HISTORIAL: 'HISTORIAL_ENTREGAS',
  LOG: 'LOG_ACTIVIDAD',
  VISAS: 'VISAS',
  RETIRADAS: 'RETIRADAS_STOCK'
};
```

- [ ] **Step 2: Añadir las columnas de `RETIRADAS`**

En el mismo archivo, sustituir la línea final del bloque `COLUMNAS`:

```javascript
  VISAS: ['id', 'ped', 'tienda', 'estado', 'numeroCarga', 'fechaAlta', 'fechaResuelta', 'motivoAlerta']
};
```

por:

```javascript
  VISAS: ['id', 'ped', 'tienda', 'estado', 'numeroCarga', 'fechaAlta', 'fechaResuelta', 'motivoAlerta'],
  RETIRADAS: ['fecha', 'tienda', 'pedido', 'cliente', 'resultado', 'code', 'ts']
};
```

- [ ] **Step 3: Verificar que no se ha roto la sintaxis**

`getHoja('RETIRADAS')` autocrea la hoja la primera vez que se use (mismo mecanismo defensivo que ya usa `VISAS`, ver `EstructuraSheets.gs:148-170`) — no hace falta ejecutar `inicializarSistema()` a mano para esta hoja. Simplemente confirmar visualmente que las comas y llaves del bloque `HOJAS`/`COLUMNAS` quedan bien cerradas (revisar el archivo tras la edición).

---

### Task 2: Backend — llamadas a la API de Leroy Merlin y `procesarRetiradaPedido`

**Files:**
- Modify: `Backend.gs:2881-2883` (insertar entre `guardarTiposEntregaLote` y el comentario de `htmlHojaStoreDelivery`)

- [ ] **Step 1: Insertar las funciones nuevas**

En `Backend.gs`, localizar el final de `guardarTiposEntregaLote` (línea 2881, `}`) seguido del comentario de `htmlHojaStoreDelivery` (línea 2883). Insertar el siguiente bloque **entre** esas dos líneas:

```javascript
// ============================================================
// RETIRADAS DE PEDIDO (simulación "cliente viene a recoger" en la
// web pública de Leroy Merlin — dispara el control de stock delivery)
// ============================================================
// API pública de Leroy Merlin (SIN login, CORS abierto a *). Contrato
// descubierto inspeccionando el Network tab de
// store-delivery-client-web-pro.sales-pro-eslm.tech.adeo.cloud:
//   GET  .../v1/commands/check/{codTienda}/{pedido} → {code, command}
//     code:0 + command = pedido procesable (equivale a que aparezca
//       "Recoger ahora" en el kiosco)
//     code:2 (u otro) + command:null = NO procesable (equivale a la
//       pantalla "Pregunta en el mostrador" del kiosco)
//   POST .../v1/commands/check  (body = el MISMO objeto "command" del
//     GET, sin modificar) → {code:0} si confirma bien (equivale a
//     "Recoger ahora" → "Sí, soy el titular" → "Ok" en el kiosco)
// AVISO: esta es la API de PRODUCCIÓN real de Leroy Merlin. El GET es
// de solo lectura; el POST confirma la recogida de un pedido real.
var LM_RETIRADA_API = 'https://store-delivery-api-pro.sales-pro-eslm.tech.adeo.cloud/v1/commands/check';

function _lmComprobarPedido(codTienda, pedido) {
  var resp = UrlFetchApp.fetch(LM_RETIRADA_API + '/' + codTienda + '/' + pedido, {
    method: 'get',
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  return { code: data.code, command: data.command };
}

function _lmConfirmarPedido(command) {
  var resp = UrlFetchApp.fetch(LM_RETIRADA_API, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(command),
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  return { code: data.code };
}

/**
 * Procesa UN pedido de la lista de retiradas: consulta la API de Leroy
 * Merlin y, si es procesable, confirma la recogida. Registra el resultado
 * en la hoja RETIRADAS_STOCK. Se llama UNA VEZ POR PEDIDO desde el
 * frontend (no en lote) para que cada llamada gas() sea rápida y no
 * choque con el watchdog de 20s (2 peticiones HTTP externas por pedido
 * pueden sumar varios segundos si se hicieran todas en una sola llamada).
 */
function procesarRetiradaPedido(tienda, pedido) {
  var ped = String(pedido).trim();
  var codTienda = codigoTienda(tienda);
  var resultado, code, cliente = '';
  try {
    var chk = _lmComprobarPedido(codTienda, ped);
    code = chk.code;
    if (chk.code === 0 && chk.command) {
      var cust = chk.command.customer || {};
      cliente = ((cust.firstName || '') + ' ' + (cust.lastName || '')).trim();
      try {
        var conf = _lmConfirmarPedido(chk.command);
        resultado = (conf.code === 0) ? 'OK' : 'ERROR_CONFIRMACION';
      } catch (e2) {
        resultado = 'ERROR_CONFIRMACION';
      }
    } else {
      resultado = 'REVISAR_MOSTRADOR';
    }
  } catch (e) {
    resultado = 'ERROR_CONFIRMACION';
    code = -1;
  }
  anadirFila('RETIRADAS', {
    fecha: Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM/yyyy'),
    tienda: tienda,
    pedido: ped,
    cliente: cliente,
    resultado: resultado,
    code: code,
    ts: new Date().toISOString()
  });
  return { pedido: ped, cliente: cliente, resultado: resultado, code: code };
}

/**
 * Prueba manual — ejecutar desde el editor de Apps Script (Ejecutar →
 * probarRetiradaPedido, o pegar en una celda de "Ejecutar función").
 * AVISO: usa un pedido REAL que realmente se quiera procesar — si es
 * procesable, esto confirma su recogida de verdad (mismo efecto que el
 * kiosco de tienda), no es una llamada de prueba inofensiva.
 */
function probarRetiradaPedido(tienda, pedido) {
  var r = procesarRetiradaPedido(tienda, pedido);
  Logger.log(JSON.stringify(r));
  return r;
}

```

- [ ] **Step 2: Comprobación estática (sin ejecutar)**

Releer el bloque insertado y confirmar:
- No hay arrow functions (`=>`) ni template literals (backticks) — todo `function()` y concatenación con `+`, igual que el resto de `Backend.gs`.
- `codigoTienda` y `anadirFila` ya existen en el proyecto (`Configuracion.gs:81-83` y `EstructuraSheets.gs:208-219` respectivamente) — no hace falta definirlos de nuevo.

- [ ] **Step 3: Desplegar para poder probar desde el editor**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

Expected: `└─ Backend.gs` (y demás archivos) listados sin error.

- [ ] **Step 4: Probar manualmente con UN pedido real (el usuario, desde el editor de Apps Script)**

Desde script.google.com, abrir el proyecto, seleccionar la función `probarRetiradaPedido`, pulsar Ejecutar pasando una tienda y un nº de pedido real que se quiera procesar (por ejemplo desde la consola: `probarRetiradaPedido('Málaga', '280424')` cambiando el número por uno real vigente). Ver → Registros y confirmar que el JSON devuelto tiene forma `{pedido, cliente, resultado, code}` y que `resultado` es `'OK'` o `'REVISAR_MOSTRADOR'` según corresponda al estado real de ese pedido.

---

### Task 3: Frontend — sección "Retiradas de pedido" dentro de `pantallaStoreDelivery()`

**Files:**
- Modify: `Index.html:3341-3359` (función `pantallaStoreDelivery`)

- [ ] **Step 1: Añadir la segunda `.section-card`**

En `Index.html`, sustituir:

```javascript
function pantallaStoreDelivery() {
  bread();
  const html = `
    <div class="step-title">🗂️ Store Delivery · Plantillas de reparto</div>
    <div class="section-card">
      <p style="font-size:12px;color:var(--tx2);margin-bottom:10px">Genera la hoja de reparto para imprimir, con los pedidos que hoy están en silueta.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <select id="sdTienda" style="flex:1;min-width:110px">
          ${TIENDAS.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
        </select>
        <select id="sdFlujoGrupo" style="flex:1;min-width:170px">
          <option value="correcaminos">Delivery Correcaminos</option>
          <option value="remansur">Delivery Remansur</option>
        </select>
        <button class="btn-opc" style="flex:0 0 auto;justify-content:center;background:var(--sur2)" onclick="generarStoreDelivery()">Generar lista</button>
      </div>
      <div id="resultadoStoreDelivery"></div>
    </div>`;
  app().innerHTML = html;
}
```

por:

```javascript
function pantallaStoreDelivery() {
  bread();
  const html = `
    <div class="step-title">🗂️ Store Delivery · Plantillas de reparto</div>
    <div class="section-card">
      <p style="font-size:12px;color:var(--tx2);margin-bottom:10px">Genera la hoja de reparto para imprimir, con los pedidos que hoy están en silueta.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <select id="sdTienda" style="flex:1;min-width:110px">
          ${TIENDAS.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
        </select>
        <select id="sdFlujoGrupo" style="flex:1;min-width:170px">
          <option value="correcaminos">Delivery Correcaminos</option>
          <option value="remansur">Delivery Remansur</option>
        </select>
        <button class="btn-opc" style="flex:0 0 auto;justify-content:center;background:var(--sur2)" onclick="generarStoreDelivery()">Generar lista</button>
      </div>
      <div id="resultadoStoreDelivery"></div>
    </div>
    <div class="section-card">
      <h3><span class="step-num" style="background:var(--grn)">🧾</span> Retiradas de pedido</h3>
      <p style="font-size:12px;color:var(--tx2);margin-bottom:10px">Pega los números de pedido de una tienda para simular en la web de Leroy Merlin que el cliente viene a recogerlos (dispara el control de stock delivery). Se procesan uno a uno.</p>
      <div class="field" style="margin-bottom:10px"><label>Tienda (para toda la tanda)</label>
        <select id="retTienda">
          ${TIENDAS.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
        </select>
      </div>
      <textarea id="retPedidos" placeholder="941500&#10;274600&#10;942600"></textarea>
      <button class="btn-submit" id="btnProcesarRetiradas" style="margin-top:10px" onclick="procesarRetiradas()">🧾 Procesar retiradas</button>
      <div id="estadoRetiradas" style="font-size:12px;color:var(--tx2);margin-top:8px"></div>
      <div id="resultadoRetiradas" style="margin-top:10px"></div>
    </div>`;
  app().innerHTML = html;
}
```

(Si `var(--grn)` no existe como variable CSS en este proyecto, usar `var(--pur)` en su lugar — ambas ya se usan como fondo de `step-num` en otras pantallas de este mismo archivo, ej. línea 2449 y 2461/2476.)

- [ ] **Step 2: Comprobación visual del HTML generado (sin backend)**

No hay forma de renderizar esto localmente (es una plantilla de string dentro de Apps Script). Se verificará en el navegador junto con el Task 4, una vez añadida también la lógica JS (si se prueba solo el HTML sin `procesarRetiradas()` definida, el botón daría "procesarRetiradas is not defined" en la consola — normal, se resuelve en el siguiente task).

---

### Task 4: Frontend — `procesarRetiradas()` y `renderResultadoRetiradas()`

**Files:**
- Modify: `Index.html:4291` (insertar justo antes de `</script>`)

- [ ] **Step 1: Añadir las funciones nuevas**

En `Index.html`, localizar el final de `reimprimirCompactado()` (línea 4291, `}`) justo antes de la etiqueta `</script>` (línea 4292). Insertar el siguiente bloque:

```javascript
// === RETIRADAS DE PEDIDO (Store Delivery) ===
// Se procesa UN pedido por llamada a gas() (no en lote) para que cada
// llamada sea rápida (2 peticiones HTTP externas por pedido) y para
// poder pintar el progreso en vivo, línea a línea.
let RETIRADAS_RESULTADOS = [];
async function procesarRetiradas() {
  const txt = document.getElementById('retPedidos').value;
  const numeros = txt.split(/[\s,;\n]+/).map(s => s.trim()).filter(s => s);
  if (!numeros.length) { toast('Pega al menos un número de pedido', 'err'); return; }
  const tienda = document.getElementById('retTienda').value;
  const boton = document.getElementById('btnProcesarRetiradas');
  const estadoEl = document.getElementById('estadoRetiradas');
  boton.disabled = true;
  RETIRADAS_RESULTADOS = [];
  renderResultadoRetiradas();
  for (let i = 0; i < numeros.length; i++) {
    estadoEl.textContent = `Procesando ${i + 1}/${numeros.length}…`;
    let r;
    try {
      r = await gas('procesarRetiradaPedido', tienda, numeros[i]);
    } catch (e) {
      r = { pedido: numeros[i], cliente: '', resultado: 'ERROR_CONFIRMACION', code: null };
    }
    RETIRADAS_RESULTADOS.push(r);
    renderResultadoRetiradas();
  }
  estadoEl.textContent = `Terminado: ${numeros.length} pedido${numeros.length !== 1 ? 's' : ''} procesado${numeros.length !== 1 ? 's' : ''}.`;
  boton.disabled = false;
  document.getElementById('retPedidos').value = '';
}
function renderResultadoRetiradas() {
  const cont = document.getElementById('resultadoRetiradas');
  if (!cont) return;
  if (!RETIRADAS_RESULTADOS.length) { cont.innerHTML = ''; return; }
  const colorResultado = { OK: 'var(--grn)', REVISAR_MOSTRADOR: 'var(--gold)', ERROR_CONFIRMACION: 'var(--red)' };
  const labelResultado = { OK: '✓ OK', REVISAR_MOSTRADOR: '⚠ Revisar en mostrador', ERROR_CONFIRMACION: '✕ Error' };
  let html = '<div class="section-card" style="padding:8px 12px">';
  html += RETIRADAS_RESULTADOS.map(r => `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--bor);font-size:12px;flex-wrap:wrap">
    <b style="font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:.5px;min-width:56px">${esc(r.pedido)}</b>
    <span style="color:var(--tx2)">${esc(r.cliente || '—')}</span>
    <span style="margin-left:auto;color:${colorResultado[r.resultado] || 'var(--tx2)'};font-weight:700">${esc(labelResultado[r.resultado] || r.resultado)}</span>
  </div>`).join('');
  html += '</div>';
  cont.innerHTML = html;
}
```

- [ ] **Step 2: Desplegar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

Expected: todos los archivos suben sin error de sintaxis.

- [ ] **Step 3: Verificación manual en el navegador (el usuario)**

1. Implementar → Gestionar implementaciones → editar el despliegue en vivo → Versión: Nueva versión → Implementar (para que la URL `/exec` sirva el código nuevo).
2. Abrir la app en modo admin, ir a la pestaña "🗂️ Store Delivery".
3. Confirmar que aparece la nueva sección "🧾 Retiradas de pedido" debajo de "Plantillas de reparto", con el selector de tienda, el textarea y el botón.
4. Pegar UN pedido real que se quiera procesar de verdad (no un número inventado) y pulsar "Procesar retiradas".
5. Confirmar que aparece "Procesando 1/1…", luego la fila de resultado con el nombre del cliente y "✓ OK" o "⚠ Revisar en mostrador" según corresponda.
6. Abrir el Spreadsheet de datos (botón "Hoja administración" o `dondeEstanLosDatos()` desde el editor) y confirmar que la hoja `RETIRADAS_STOCK` tiene una fila nueva con esos datos.
7. Si el pedido era procesable y salió "✓ OK", comprobar en la propia web de Leroy Merlin (o preguntando en tienda) que el pedido pasó a estado de recogida — confirma que el flujo real quedó disparado.

---

### Task 5: Ajuste de volumen (solo si aparece en el uso real)

No implementar todavía (YAGNI) — dejar anotado para revisar si el uso real lo requiere:

- Si las listas pegadas empiezan a ser de varias decenas/cientos de pedidos y el procesamiento se hace demasiado lento fila a fila desde el navegador, considerar mover el bucle al backend con `anadirFilas` (escritura en bloque) y devolver progreso parcial vía `PropertiesService`/`CacheService` consultado por polling desde el frontend. No construir esto por adelantado sin necesidad confirmada.
