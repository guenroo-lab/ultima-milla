# LM Málaga · Expedición con Siluetas — Implantación de Producción

## Qué es esto
Sistema de gestión de expedición de última milla para **Leroy Merlin Málaga** (operado por **Taisa Logistics**). Migración de una demo HTML funcional a **Google Apps Script + Google Sheets** para producción real, sin datos ficticios.

## Objetivo de esta implantación
Convertir la demo en una webapp de producción que:
1. Cree automáticamente su Spreadsheet de datos al desplegar
2. Funcione con datos reales (no localStorage)
3. Incluya los 4 módulos: **preparación, carga/expedición, buscador, notificaciones Chat**
4. La parte central es la **expedición con siluetas** (asignación de pedidos a posiciones físicas)

---

## Archivos incluidos

### Backend (Apps Script) — LISTOS, no tocar salvo ajustes
| Archivo | Estado | Función |
|---|---|---|
| `appsscript.json` | ✅ Listo | Manifiesto (scopes, webapp config) |
| `Configuracion.gs` | ✅ Listo | Constantes, config, nombres de hojas y columnas |
| `EstructuraSheets.gs` | ✅ Listo | Creación automática del Spreadsheet + helpers CRUD |
| `Backend.gs` | ✅ Listo | Toda la lógica de negocio (API para el frontend) |
| `ImportarPyxis.gs` | ✅ Listo | Importación de pedidos desde Excel Pyxis |
| `NotificacionesChat.gs` | ✅ Listo | Webhook Google Chat para incidencias |
| `WebApp.gs` | ✅ Listo | doGet (sirve Index.html o Dashboard.html) |

### Frontend (HTML) — HAY QUE CREARLOS desde la demo
| Archivo | Estado | Cómo hacerlo |
|---|---|---|
| `Index.html` | ⚠️ Crear | Migrar UI de `DEMO_referencia_v12.html` conectando a backend |
| `Dashboard.html` | ⚠️ Crear | Migrar de `DASHBOARD_referencia_v3.html` conectando a backend |

### Referencias (demos funcionales, NO desplegar)
| Archivo | Uso |
|---|---|
| `DEMO_referencia_v12.html` | UI completa funcionando con localStorage. **Copiar de aquí el HTML+CSS+JS de UI** |
| `DASHBOARD_referencia_v3.html` | Dashboard TV funcionando. Copiar UI de aquí |

---

## TAREA PRINCIPAL: crear Index.html y Dashboard.html

### Estrategia
La demo `DEMO_referencia_v12.html` tiene TODO el HTML, CSS y la lógica de UI ya funcionando. El trabajo es:

1. **Copiar íntegro** el `<style>...</style>` de la demo → va igual en Index.html
2. **Copiar íntegro** el HTML del `<body>` (tabs, contenedores) → va igual
3. **Copiar** todas las funciones de UI (`pantalla*`, `render*`, `conectarSwipe`, tooltips, etc.) → van casi igual
4. **REEMPLAZAR la capa de datos**: en la demo hay un objeto `API = {...}` con funciones que leen/escriben `localStorage` y un `DATA` global. Eso se sustituye por llamadas asíncronas a `google.script.run`.

### Mapeo demo → producción (capa de datos)

La demo tiene funciones síncronas tipo `API.listarPedidos(flujo, tienda)`. En producción son **asíncronas** con `google.script.run`. Patrón de conversión:

```javascript
// === DEMO (síncrono, localStorage) ===
const pedidos = API.listarPedidos(flujo, tienda);
renderListaPedidos(pedidos);

// === PRODUCCIÓN (asíncrono, backend) ===
google.script.run
  .withSuccessHandler(function(pedidos) {
    renderListaPedidos(pedidos);
  })
  .withFailureHandler(function(err) {
    toast('Error: ' + err.message, 'err');
  })
  .listarPedidos(flujo, tienda);
```

### Tabla de equivalencias de funciones

Cada función `API.X` de la demo tiene su gemela en `Backend.gs` con el MISMO nombre y MISMOS parámetros. Solo cambia la forma de llamarla (síncrona → google.script.run):

| Demo (`API.*`) | Backend.gs | Parámetros |
|---|---|---|
| `obtenerConfig()` | `obtenerConfig()` | — |
| `listarPedidos(flujo, tienda)` | `listarPedidos(flujo, tienda)` | flujo, tienda |
| `lineas(idPedido)` | `obtenerPedidoConLineas(idPedido)` | idPedido |
| `marcar(...)` | `marcarLinea(idPedido, idx, estado, motivo, operario, vuelveAlFinal)` | 6 args |
| `ocupacionSilueta(s)` | `obtenerOcupacionSilueta(silueta)` | silueta |
| `asignarAutomatico(s, n)` | `asignarAutomatico(silueta, numPos)` | silueta, numPos |
| validación manual | `validarAsignacionManual(silueta, posIni, numPos)` | 3 args |
| cerrar pedido | `cerrarPedido(idPedido, silueta, posIni, soportes, operario)` | 5 args |
| `crearCarga(nums)` | `crearCarga(listaNumPedidos)` | array |
| `obtenerCargaActiva()` | `obtenerCargaActiva()` | — |
| `confirmarEntregas(...)` | `confirmarEntregas(idCarga, numerosEscaneados)` | 2 args |
| `pedidosDisponiblesParaCarga()` | `pedidosDisponiblesParaCarga()` | — |
| `buscarPedido(num)` | `buscarPedido(num)` | num |
| datos dashboard | `obtenerDatosDashboard()` | — |

### Notas importantes de la conversión

1. **Config al arrancar**: La demo tiene las constantes (SILUETAS, SOPORTES, etc.) hardcodeadas en JS. En producción, llamar `obtenerConfig()` UNA VEZ al cargar y guardar el resultado en una variable global `CFG`. Sustituir `SILUETAS` → `CFG.siluetas`, `SOPORTES` → `CFG.soportes`, `POSICIONES` → `CFG.posiciones`, etc.

2. **Cargas (spinner)**: Como las llamadas son asíncronas, añadir un indicador de carga (spinner/overlay) mientras se espera respuesta. Hay un patrón sencillo: mostrar overlay antes de `google.script.run` y ocultarlo en ambos handlers.

3. **El `doGet` no debe ser lento**: ya está resuelto en `WebApp.gs`. Solo sirve el HTML. Todo lo demás vía `google.script.run`.

4. **Notificación Chat**: en la demo hay `notificarIncidencia()` que muestra un modal simulado. En producción, ESO YA LO HACE EL BACKEND automáticamente dentro de `marcarLinea()` cuando el estado es NO_ENCONTRADO/NO_SALE. Así que en el frontend de producción se ELIMINA el modal simulado — la notificación se envía sola en el servidor.

5. **Impresión de hoja de carga**: la función `imprimirHojaCarga()` de la demo usa `window.open()` con HTML inline y código de barras SVG. Eso funciona igual en producción (es puro frontend). Copiarla tal cual.

6. **Botón deshacer**: en la demo es `deshacerUltima()` con estado local. En producción, lo más simple es volver a marcar la línea como PENDIENTE con `marcarLinea(idPedido, idx, 'PENDIENTE', '', operario, false)`. No requiere función especial en backend.

---

## DESPLIEGUE (orden de pasos)

### 1. Crear el proyecto Apps Script
```bash
# Opción A: con clasp (recomendado)
npm install -g @google/clasp
clasp login
clasp create --type webapp --title "LM Málaga Expedición"
# copiar todos los .gs y .html a la carpeta, luego:
clasp push
```

### 2. Habilitar Drive API avanzada (para importar Excel)
En el editor de Apps Script: Servicios (+) → Drive API → Añadir.
Esto es necesario para `importarDesdeArchivo()` en `ImportarPyxis.gs`.

### 3. Inicializar el sistema (crea el Spreadsheet)
Ejecutar UNA VEZ desde el editor: `inicializarSistema()`
- Crea el Spreadsheet con todas las hojas
- Guarda su ID en las propiedades del script
- Devuelve la URL (verla en los logs)

### 4. Configurar el webhook de Chat (opcional pero recomendado)
1. En el espacio de Google Chat: Aplicaciones e integraciones → Webhooks → Añadir
2. Copiar la URL
3. Ejecutar desde el editor: `configurarWebhook('LA_URL')`
4. Probar: `probarNotificacion()` → debe llegar un mensaje al espacio

### 5. Desplegar como webapp
Implementar → Nueva implementación → Aplicación web
- Ejecutar como: **Yo** (USER_DEPLOYING)
- Acceso: **Cualquier usuario** (o "cualquier usuario de la organización")
- Copiar la URL del despliegue

### 6. URLs de uso
- App: `https://script.google.com/.../exec`
- App explícita: `https://script.google.com/.../exec?vista=app`
- Dashboard TV: `https://script.google.com/.../exec?vista=dashboard`

### 7. Cargar pedidos iniciales
Hay 2 vías:
- **Desde Drive**: subir el Excel Pyxis a Drive, obtener su ID, ejecutar `importarDesdeArchivo(fileId, 'Málaga', 'Correcaminos')`
- **Programático**: pasar las filas directamente a `importarPedidosPyxis(filas, tienda, transportista)`

---

## MODELO DE DATOS (hojas creadas automáticamente)

### PEDIDOS
`id | ped | tienda | transportista | flujo | estado | pct | operario | silueta | posIni | posFin | numeroCarga | soportes | nLin | nUbic | actualizado`

### LINEAS_PREPARACION
`id | idPedido | idx | dir | ref | ean | des | ctd | tipoUbic | esPicking | estado | motivo | operario | ts`

### OCUPACION_SILUETAS
`silueta | pos | layer | pedido | tienda | flujo | reservado`
- `layer`: 'back' (detrás) o 'front' (delante)
- `reservado`: true si el front está reservado al mismo pedido pero vacío

### CARGAS
`id | numCarga | fecha | estado | items`
- `items` es JSON con los pedidos de la carga
- `estado`: GENERADA → CERRADA

### HISTORIAL_ENTREGAS
`pedido | tienda | transportista | silueta | posIni | posFin | cargador | ts | confirmadoTs`

### LOG_ACTIVIDAD
`ts | tipo | detalle | usuario`

---

## OPERATIVA DEL NEGOCIO (contexto imprescindible)

### Turnos
- **MAÑANA (< 14h)**: se expiden a última milla los pedidos que están en silueta (preparados ayer). Administración genera hoja imprimible con código de barras, el cargador sale, a la vuelta administración escanea los entregados → libera siluetas. Los no entregados → Carga 2.
- **TARDE (≥ 14h)**: operarios preparan los pedidos del día siguiente y los colocan en siluetas.

### Siluetas (lo más importante)
- 7 siluetas: A, B, C, D, E, F, G
- Cada una: 16 posiciones × 2 capas (back/front) = 32 palets
- Visualización: 2 filas de 16 celdas (front arriba, back abajo)
- **Color de celda = tienda** (Málaga verde, Marbella azul, Mijas morado)
- **Letra dentro de celda = flujo** (T transporte, I instalación, P pro, R remansur, R+ remansur pro)
- Número de pedido completo solo en tooltip al pasar cursor

### Regla de oro de las siluetas
Un pedido NUNCA puede tapar a otro distinto. El front (delante) de una posición solo puede contener el mismo pedido que está en el back (detrás). Si un soporte ocupa solo el back (0.5), el front queda RESERVADO a ese pedido (nadie más lo usa).

### Ocupación de soportes
| Soporte | Ocupa |
|---|---|
| Palet Euro/Americano/Estaríbel/Jaula | 0.5 |
| Palet Doble | 1.0 |
| Palet Medio | 0.25 |
| Bulto / picking | 0 |

2 palets euro (0.5+0.5) → ocupan back+front de la misma posición.

### Flujos de transporte
| transportista | flujo | letra |
|---|---|---|
| Correcaminos | transporte | T |
| Correcaminos Instalaciones | instalacion | I |
| Correcaminos PRO | pro | P |
| Remansur | remansur_transporte | R |
| Remansur PRO | remansur_pro | R+ |

### Preparación (swipe)
- Derecha = preparado
- Izquierda = motivo: "No encontrado" / "No sale" (cierran línea, ENVÍAN notificación Chat) o "Posponer/Revisar" (vuelve al final)
- Las ubicaciones de picking van siempre al final del pedido

### Ubicaciones Pyxis
- Códigos que empiezan por X = cantilever (no cuenta ocupación)
- 30000/31000/32000 = zonas especiales
- 467... = expedición
- LUNE/MART/etc = transitorias por día
- bulto/tapeta/espejo/0.5m = picking (no cuenta)

---

## CONVENCIONES DE CÓDIGO GAS (respetar)
- **NO** usar arrow functions (`=>`) en los .gs — usar `function()`
- **NO** usar template literals (backticks) en los .gs — usar concatenación con `+`
- En el frontend HTML sí se pueden usar (es navegador moderno)
- `doGet` nunca hace operaciones lentas de Sheets
- Botones HTML generados en cliente
- Toda escritura a Sheets pasa por los helpers de `EstructuraSheets.gs` (`anadirFila`, `actualizarFila`)
- Redesplegar tras cada cambio de código (clasp push + nueva versión si cambia doGet)

---

## CHECKLIST DE LA IMPLANTACIÓN
- [ ] `clasp create` + push de todos los .gs
- [ ] Habilitar Drive API avanzada
- [ ] Ejecutar `inicializarSistema()` → anotar URL del Spreadsheet
- [ ] Crear `Index.html` migrando UI de la demo (conectar google.script.run)
- [ ] Crear `Dashboard.html` migrando del dashboard de referencia
- [ ] `configurarWebhook(url)` + `probarNotificacion()`
- [ ] Desplegar webapp (ejecutar como Yo, acceso anónimo/organización)
- [ ] Importar primer Excel Pyxis de prueba
- [ ] Probar flujo completo: preparar pedido → asignar silueta → crear carga → imprimir → confirmar entrega
- [ ] Lanzar dashboard en TV (?vista=dashboard)
