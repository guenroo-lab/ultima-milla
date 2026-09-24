# LM Málaga · Expedición — Diseño del pipeline completo

**Fecha:** 2026-06-24
**Objetivo:** Que toda la app funcione en conjunto, desde la carga de pedidos hasta el último paso de carga/expedición, sobre Google Apps Script + Google Sheets (producción, sin datos ficticios).

---

## 1. Contexto y diagnóstico

El backend Apps Script está casi completo (`Configuracion.gs`, `EstructuraSheets.gs`, `Backend.gs`, `ImportarPyxis.gs`, `Inventario.gs`, `NotificacionesChat.gs`, `WebApp.gs`). Hoy **no funciona como conjunto** por cuatro cortes en la cadena:

1. **No existe el frontend de producción.** `WebApp.gs` sirve `Index.html` y `Dashboard.html`, que no están creados (solo hay las demos de referencia). La app principal no arranca.
2. **Dos `doGet()` colisionan.** `Codigo.gs` (sirve `Clasificador.html`) y `WebApp.gs` (sirve `Index/Dashboard`). En GAS solo puede haber un `doGet` por proyecto.
3. **El clasificador está desconectado del sistema de pedidos.** `clasificarPedidos()` localiza y agrupa pedidos pero **nunca los escribe** en `PEDIDOS`/`LINEAS`. "Cargar pedidos" produce una pantalla, no datos que el resto de la app pueda usar.
4. **La config del webhook de Chat está rota.** El deploy documenta `configurarWebhook(url)` (no existe) y `NotificacionesChat.gs` usa una constante hardcodeada en vez de `getWebhookChat()`.

**Restricción del entorno:** no se puede desplegar ni ejecutar Apps Script en esta sesión. El entregable es código correcto y desplegable + un guion de verificación (`verificarSistema()` + checklist) que el usuario ejecuta en el editor de GAS.

---

## 2. Decisiones tomadas

- **Carga de pedidos:** Clasificador + botón **"Importar al sistema"** (reutiliza `Inventario.gs` como fuente de líneas).
- **Reimportar:** **idempotente**. Un pedido solo aparece en el inventario de Pyxis mientras sigue vivo / con líneas por entregar; al entregarse del todo desaparece del inventario. Por tanto, al importar: si el pedido ya existe en `PEDIDOS` y no está `ENTREGADO`, se respeta (no se duplica ni se pisa su preparación); solo se crean los nuevos.
- **Ubicación del clasificador:** vista admin separada (`?vista=clasificador`).
- **Remansur PRO (R+):** **no** se añade 5ª zona por ahora. El flujo `remansur_pro` queda en CONFIG sin alimentarse.
- **Alcance:** construir el pipeline completo (Fases 0–5).

---

## 3. Arquitectura

### 3.1 Punto de entrada único
Un solo `doGet(e)` en `WebApp.gs` que enruta por `?vista`:

| `vista` | Sirve | Rol |
|---|---|---|
| `app` (defecto) | `Index.html` | Operario + carga + buscador + dashboard interno |
| `dashboard` | `Dashboard.html` | TV de pared |
| `clasificador` | `Clasificador.html` | Administración (carga de pedidos) |

Se elimina el `doGet` de `Codigo.gs` (su función la absorbe el router). El helper `include()` ya existe.

### 3.2 Puente clasificador → pedidos (pieza nueva clave)
Función `importarClasificacion(numerosPorTransporte, opciones)` — misma firma que `clasificarPedidos`, pero **persiste**:

1. Carga inventario (`cargarInventario()`) y resuelve tienda + líneas de cada pedido (reutiliza `resolverOcurrencia`, colisiones y parciales — misma lógica que `clasificarPedidos`).
2. Mapea zona → transportista → flujo:
   - `Transporte` → `Correcaminos` → `transporte` (T)
   - `Instalaciones` → `Correcaminos Instalaciones` → `instalacion` (I)
   - `PRO` → `Correcaminos PRO` → `pro` (P)
   - `Remansur` → `Remansur` → `remansur_transporte` (R)
3. **Idempotente:** si `idPedido` ya existe en `PEDIDOS` y `estado !== 'ENTREGADO'` → omitir. Si no existe → crear.
4. Crea `PEDIDOS` + `LINEAS` con la clasificación de ubicación de `ImportarPyxis` (`clasificarUbicacion`, `esPicking`, picking al final). Para parciales, solo las direcciones seleccionadas.
5. Devuelve `{ creados, omitidos, noEncontrados, colisiones, porTransporte }`.

**Refactor:** extraer la creación "pedido + líneas a partir de un conjunto de líneas" a un helper compartido (p. ej. `crearPedidoConLineas(idPedido, ped, tienda, transportista, lineasRaw)`), usado por `importarPedidosPyxis` y por `importarClasificacion`, para no duplicar lógica ni tener dos esquemas de línea.

**`idPedido` canónico:** `codigoTienda(tienda) + '::' + numPed` (p. ej. `036::942687`). Debe ser idéntico en importación, buscador y carga. El mapa de códigos de tienda se centraliza en un único sitio (`Configuracion.gs`).

`Clasificador.html` añade botón **"Importar al sistema"**: *Clasificar* = previsualizar (existente) → *Importar* = confirmar y persistir, mostrando el resumen devuelto.

### 3.3 Correcciones de backend
- Añadir `configurarWebhook(url)` (wrapper de `setWebhookChat`).
- `enviarNotificacionChat` lee `getWebhookChat()`; si está vacío, no-op con log (no bloquea la preparación). Quitar el template literal con backticks (convención GAS).
- Centralizar el código de tienda (`codigoTienda` / `TIENDA_POR_CODIGO`) en `Configuracion.gs`.

### 3.4 `Index.html` (port de la demo)
Estrategia (la que ya prescribe el `CLAUDE.md` del proyecto): copiar `<style>` y el HTML del `<body>` **tal cual** de `DEMO_referencia_v12.html`; copiar las funciones `pantalla*`/`render*`/swipe **casi igual**; **sustituir solo la capa de datos** (objeto `API` + `DATA`/`localStorage` → llamadas async a `google.script.run`).

- Helper `gas(metodo, ...args)`: envuelve `google.script.run` en Promesa + overlay de carga.
- `const CFG = await gas('obtenerConfig')` una vez al arrancar; sustituir `SILUETAS/SOPORTES/POSICIONES` por `CFG.*`.
- Pantallas que consumen retornos del API → `async/await`.
- Eliminar el modal simulado de Chat (el backend ya notifica en `marcarLinea`).
- "Deshacer" = volver a marcar la línea `PENDIENTE` vía `marcarLinea(idPedido, idx, 'PENDIENTE', '', operario, false)`.
- Hoja de carga imprimible (`window.open` + código de barras SVG): se copia tal cual (puro frontend).
- Pestañas: `tabApp` (operario) / `tabCarga` / `tabBuscar` / `tabDash`. El clasificador **no** es pestaña aquí.

**Contrato backend que consume Index.html** (todo ya existe en `Backend.gs`):
`obtenerConfig` · `listarPedidos(flujo,tienda)` · `obtenerPedidoConLineas(idPedido)` · `marcarLinea(idPedido,idx,estado,motivo,operario,vuelveAlFinal)` · `obtenerOcupacionSilueta(silueta)` · `asignarAutomatico(silueta,numPos)` · `validarAsignacionManual(silueta,posIni,numPos)` · `cerrarPedido(idPedido,silueta,posIni,soportes,operario)` · `pedidosDisponiblesParaCarga()` · `crearCarga(lista)` · `obtenerCargaActiva()` · `confirmarEntregas(idCarga,numeros)` · `buscarPedido(num)` · `obtenerDatosDashboard()`.

### 3.5 `Dashboard.html`
Port de `DASHBOARD_referencia_v3.html` cambiando la fuente de datos por `gas('obtenerDatosDashboard')` con poll cada 10 s. Modo mañana/tarde automático según `CFG.horaCambioModo`.

---

## 4. Verificación (no se puede ejecutar GAS aquí)

1. **`verificarSistema()`** — función GAS que siembra un pedido de prueba y recorre `importar → preparar → cerrar a silueta → crear carga → confirmar entrega`, comprobando el estado resultante de las hojas. Se ejecuta una vez en el editor.
2. **Checklist de despliegue y clics** — pasos de `clasp`/editor + recorrido manual.
3. **Reconciliación del algoritmo de siluetas** — revisar `calcularPosiciones` (Backend.gs) contra la lógica validada de la demo (`pantallaCerrarPedido`, líneas ~1079–1356), ya que es la pieza pura de mayor riesgo (la "regla de oro": el front de una posición solo puede ser del mismo pedido que el back).

---

## 5. Plan por fases (con checkpoint en `verificarSistema`)

| Fase | Contenido | Resultado |
|---|---|---|
| **0** | Fontanería backend: unificar `doGet`, fix webhook + `configurarWebhook`, centralizar código de tienda, helper compartido `crearPedidoConLineas`. | Base sin colisiones. |
| **1** | `importarClasificacion` + botón "Importar al sistema" en `Clasificador.html`. | "Carga de pedidos" mete datos reales en `PEDIDOS`/`LINEAS`. |
| **2** | `Index.html`: flujo operario (preparar → cerrar a silueta). | Operario funciona contra backend real. |
| **3** | `Index.html`: carga/expedición + buscador + dashboard interno. | Último paso de carga funciona. |
| **4** | `Dashboard.html` (TV). | Pantalla de pared en vivo. |
| **5** | `verificarSistema()` + checklist + reconciliación del algoritmo de siluetas. | End-to-end verificable por el usuario. |

---

## 6. Archivos afectados

**Editar:** `WebApp.gs` (router), `Codigo.gs` (quitar `doGet`), `NotificacionesChat.gs` (webhook desde propiedades + `configurarWebhook`), `ImportarPyxis.gs` (extraer helper), `Inventario.gs` (o nuevo `ImportarClasificacion.gs` para `importarClasificacion`), `Configuracion.gs` (código de tienda centralizado), `Clasificador.html` (botón importar).

**Crear:** `Index.html`, `Dashboard.html`, `Pruebas.gs` (`verificarSistema`).

---

## 7. Riesgos y notas

- **Async en Index.html:** la demo llama al `API` de forma síncrona; en producción es async. Cada call-site que consume el retorno debe pasar a `async/await` con overlay. Es el grueso del esfuerzo de la Fase 2–3.
- **Algoritmo `calcularPosiciones`:** posible divergencia con la demo; se reconcilia en Fase 5.
- **Granada:** aparece en `TIENDA_POR_CODIGO` (043) pero no en `CONFIG.TIENDAS`. Si un pedido resuelve a Granada, avisar en la importación (no es tienda de la expedición LM Málaga).
- **No es repo git:** el spec se guarda en disco; no se commitea (el proyecto no está bajo git).
</content>
</invoke>
