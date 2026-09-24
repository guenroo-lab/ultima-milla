# Editar chófer y cargador tras asignar — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un botón "✏️ Editar chófer/cargador" en la pantalla de una carga que permite corregir
ambos campos en cualquier momento, sin pasar por la impresión de la hoja.

**Architecture:** Nueva función de servidor `actualizarChofer` (calco exacto de `actualizarCargador`
ya existente) + un modal nuevo e independiente en el cliente, con sus dos campos prerrellenos.

**Tech Stack:** Google Apps Script (V8) + HTML/JS cliente vía `google.script.run` (helper `gas()` ya
existente en Index.html). Sin framework de test — verificación manual vía Apps Script editor
(`Pruebas.gs`) y recorrido real en el navegador.

---

### Task 1: Función de servidor `actualizarChofer` (`Backend.gs`)

**Files:**
- Modify: `Backend.gs:6889-6899` (justo después de `actualizarCargador`)

- [ ] **Paso 1: Añadir la función**

Después de la función `actualizarCargador` existente (`Backend.gs:6892-6899`), añadir:

```javascript
/**
 * Actualiza el chófer del vehículo asignado a una carga.
 */
function actualizarChofer(idCarga, chofer) {
  var cargas = leerHoja('CARGAS');
  var c = cargas.find(function(x) { return x.id === idCarga; });
  if (!c) return { ok: false, error: 'Carga no encontrada' };
  actualizarFila('CARGAS', c._fila, { responsable: chofer || '' });
  sincronizarCargaSupabase_(c, { responsable: chofer || '' });
  return { ok: true };
}
```

- [ ] **Paso 2: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 2: Prueba de la función de servidor (`Pruebas.gs`)

**Files:**
- Modify: `Pruebas.gs` (nueva función, primera del archivo)

- [ ] **Paso 1: Escribir la prueba**

Usa una carga real existente (elegida por el usuario en el Paso 3) para no depender de crear datos de
prueba en `CARGAS` (una carga de prueba arrastraría pedidos reales marcados con `numeroCarga`, más
delicado que otras pruebas de este proyecto). Verifica que `actualizarChofer` cambia SOLO `responsable`
y no toca `cargador`, y que revierte el valor al terminar.

```javascript
/**
 * Prueba actualizarChofer contra una carga real (2026-09-01) -- el usuario debe indicar el idCarga
 * a usar antes de ejecutar (variable ID_CARGA_PRUEBA de abajo). Guarda el valor original y lo
 * restaura al final, incluso si algo falla (try/finally) -- no debe dejar la carga real modificada.
 */
var ID_CARGA_PRUEBA_CHOFER = 'PON_AQUI_UN_ID_DE_CARGA_REAL';

function ejecutarPruebaActualizarChofer() {
  var cargas = leerHoja('CARGAS');
  var original = cargas.find(function(c) { return c.id === ID_CARGA_PRUEBA_CHOFER; });
  if (!original) { Logger.log('❌ No se encontró la carga ' + ID_CARGA_PRUEBA_CHOFER); return; }
  var choferOriginal = original.responsable;
  var cargadorOriginal = original.cargador;
  Logger.log('Antes: responsable=' + JSON.stringify(choferOriginal) + ' cargador=' + JSON.stringify(cargadorOriginal));

  try {
    var r = actualizarChofer(ID_CARGA_PRUEBA_CHOFER, 'CHOFER_PRUEBA_TEMPORAL');
    Logger.log('Resultado: ' + JSON.stringify(r));
    var tras = leerHoja('CARGAS').find(function(c) { return c.id === ID_CARGA_PRUEBA_CHOFER; });
    Logger.log('Después: responsable=' + JSON.stringify(tras.responsable) + ' cargador=' + JSON.stringify(tras.cargador));
    var ok = r.ok && tras.responsable === 'CHOFER_PRUEBA_TEMPORAL' && tras.cargador === cargadorOriginal;
    Logger.log(ok ? '✓ OK (chófer cambiado, cargador intacto)' : '❌ FALLO');
  } finally {
    actualizarChofer(ID_CARGA_PRUEBA_CHOFER, choferOriginal || '');
    var restaurado = leerHoja('CARGAS').find(function(c) { return c.id === ID_CARGA_PRUEBA_CHOFER; });
    Logger.log('Restaurado a: ' + JSON.stringify(restaurado.responsable));
  }
}
```

- [ ] **Paso 2: Pedir al usuario un `idCarga` real para la prueba**

No hay forma segura de adivinar uno (crear una carga de prueba real marcaría pedidos reales con
`numeroCarga`). Preguntar al usuario por el `id` de una carga ya existente (visible en la pantalla de
Cargador, o vía `leerHoja('CARGAS')` desde el editor) y sustituir `ID_CARGA_PRUEBA_CHOFER` con ese valor
antes de ejecutar.

- [ ] **Paso 3: Push, ejecutar y verificar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

Ejecutar `ejecutarPruebaActualizarChofer` desde el editor. Confirmar en el log: `✓ OK`, y que el
`responsable` quedó restaurado al valor original al final.

---

### Task 3: Modal y botón en el cliente (`Index.html`)

**Files:**
- Modify: `Index.html:2984-2996` (cabecera de `pantallaCargaImprimir`)
- Modify: `Index.html` (nuevas funciones `editarChoferCargador`/`guardarChoferCargador`, junto a
  `imprimirHojaCarga`/`ejecutarImpresion`)

- [ ] **Paso 1: Añadir el botón en la cabecera de la pantalla de carga**

En `Index.html:2988-2994`, cambiar:
```javascript
  app().innerHTML = `
    <button class="back-btn" onclick="pantallaCargaInicio()">‹ Volver a cargas</button>
    <div class="step-title">📋 Hoja de carga ${numCarga} lista</div>
    <div class="section-card">
      <h3 style="justify-content:space-between">
        <span><span class="step-num">1</span> Imprimir y entregar al cargador</span>
        <button onclick="imprimirHojaCarga()" style="background:var(--red);border:none;color:#fff;padding:8px 16px;border-radius:10px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer">🖨️ Imprimir</button>
      </h3>
```
por:
```javascript
  app().innerHTML = `
    <button class="back-btn" onclick="pantallaCargaInicio()">‹ Volver a cargas</button>
    <div class="step-title" style="display:flex;justify-content:space-between;align-items:center">
      <span>📋 Hoja de carga ${numCarga} lista</span>
      <button onclick="editarChoferCargador()" style="background:var(--sur2);border:1px solid var(--bor);color:var(--tx2);padding:7px 14px;border-radius:10px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">✏️ Editar chófer/cargador</button>
    </div>
    <div class="section-card">
      <h3 style="justify-content:space-between">
        <span><span class="step-num">1</span> Imprimir y entregar al cargador</span>
        <button onclick="imprimirHojaCarga()" style="background:var(--red);border:none;color:#fff;padding:8px 16px;border-radius:10px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer">🖨️ Imprimir</button>
      </h3>
```

- [ ] **Paso 2: Añadir las funciones del modal**

Justo antes de `function imprimirHojaCarga()` (`Index.html:3016`), insertar:

```javascript
function editarChoferCargador() {
  const carga = CARGA_ACTIVA; if (!carga) return;
  const viejo = document.getElementById('modalChoferCargador'); if (viejo) viejo.remove();
  const valChofer = esc(carga.responsable || '');
  const valCargador = esc(carga.cargador || '');
  const html = '<div class="modal-overlay" id="modalChoferCargador" onclick="if(event.target===this)document.getElementById(\'modalChoferCargador\').remove()">' +
    '<div class="modal">' +
      '<h2>✏️ Editar chófer / cargador</h2>' +
      '<p style="font-size:12px;color:var(--tx2);margin-bottom:14px">Carga ' + (carga.numCarga || '') + '. Corrige el nombre y guarda -- no imprime nada.</p>' +
      '<label style="display:block;font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">Chófer del vehículo</label>' +
      '<input type="text" id="inChoferEdit" value="' + valChofer + '" placeholder="Nombre del chófer o matrícula" style="width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:11px;color:var(--tx);font-family:inherit;font-size:15px;padding:13px;margin-bottom:14px">' +
      '<label style="display:block;font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">Cargador de plataforma</label>' +
      '<input type="text" id="inCargadorEdit" value="' + valCargador + '" placeholder="Nombre del cargador" style="width:100%;background:var(--sur2);border:1px solid var(--bor);border-radius:11px;color:var(--tx);font-family:inherit;font-size:15px;padding:13px;margin-bottom:14px" onkeydown="if(event.key===\'Enter\')guardarChoferCargador()">' +
      '<button class="btn-submit" onclick="guardarChoferCargador()">💾 Guardar</button>' +
      '<button class="modal-cancel" onclick="document.getElementById(\'modalChoferCargador\').remove()">Cancelar</button>' +
    '</div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(function() { var i = document.getElementById('inChoferEdit'); if (i) { i.focus(); i.select(); } }, 100);
}
async function guardarChoferCargador() {
  const carga = CARGA_ACTIVA; if (!carga) return;
  const chofer = ((document.getElementById('inChoferEdit') || {}).value || '').trim();
  const cargador = ((document.getElementById('inCargadorEdit') || {}).value || '').trim();
  try {
    await gas('actualizarChofer', carga.id, chofer);
    await gas('actualizarCargador', carga.id, cargador);
  } catch (e) {
    toast('Error: ' + e.message, 'err');
    return;
  }
  CARGA_ACTIVA.responsable = chofer;
  CARGA_ACTIVA.cargador = cargador;
  const modal = document.getElementById('modalChoferCargador'); if (modal) modal.remove();
  toast('✓ Chófer y cargador actualizados', 'ok');
  pantallaCargaImprimir(CARGA_ACTIVA);
}
```

- [ ] **Paso 3: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 4: Verificación end-to-end

**Files:** ninguno — solo verificación en el navegador (misma limitación ya conocida: el "Registro de
ejecución"/editor SÍ funciona desde esta sesión, la implementación de prueba del despliegue no).

- [ ] **Paso 1: Pedir al usuario que abra una carga real** en la pantalla de Cargador (o usar la misma
      que en la Tarea 2).
- [ ] **Paso 2: Confirmar visualmente**: aparece el botón "✏️ Editar chófer/cargador" junto al título,
      al pulsarlo se abre el modal con los dos campos ya rellenos con los valores actuales, cambiar
      ambos y pulsar Guardar refleja el cambio en pantalla sin abrir ninguna ventana de impresión.
- [ ] **Paso 3: Confirmar que "Imprimir" sigue funcionando igual que antes** (el modal de imprimir
      sigue dejando cambiar el cargador, sin regresión).

Si algo falla, volver a la tarea correspondiente y corregir antes de dar por completo el trabajo.
