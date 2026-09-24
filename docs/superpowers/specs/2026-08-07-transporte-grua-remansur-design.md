# Nuevo transporte GruaRemansur — LM Málaga

## Contexto y objetivo

Nuevo tipo de transporte, **GruaRemansur**: un vehículo especial del grupo Remansur (independiente de Correcaminos) que se usa en situaciones de saturación, cuando hace falta pasarle pedidos que estaban asignados a Correcaminos.

Requisitos confirmados con el usuario:
1. Poder **añadir pedidos directamente** a GruaRemansur (para pedidos que no están en el inventario Pyxis).
2. Poder **cambiar un pedido ya asignado** (a Correcaminos u otro transportista), incluso ya colocado en silueta, para que pase a ser de GruaRemansur — así Correcaminos deja de tener nada que gestionar sobre ese pedido.
3. Cuando una carga de GruaRemansur se confirma y quedan pedidos pendientes para segunda carga, el correo automático debe ir a `antonia.zambrano@leroymerlin.es` (en vez de a Correcaminos) con la gente de nuestra plataforma en copia.

Decisiones de diseño confirmadas por el usuario:
- GruaRemansur aparece como un **cajón nuevo e independiente** en el menú principal del operario (no como sub-tipo dentro del cajón "Remansur" que ya existe).
- Cada pedido GruaRemansur **ocupa su posición entera** en el croquis, como Correcaminos — no hereda el comportamiento de "compartir hueco delantero" que sí tienen Remansur/Remansur PRO.
- Nombre a mostrar en toda la app: **"GruaRemansur"**, tal cual, una sola palabra.
- Una carga puede acabar con pendientes mezclados de varios transportistas (aunque el flujo correcto es reasignar ANTES de cargar) — el correo de segundas cargas debe separarse automáticamente por grupo, cada uno a su lista de destinatarios, para que nadie vea pedidos que no son suyos.

## Encaje con el sistema existente

Hoy cada "tipo de transporte" es un par `flujo` ↔ `transportista` definido en configuración (`CONFIG.TRANSPORTISTAS_FLUJO` en `Configuracion.gs`, más el mapa inverso `FLUJO_A_TRANSPORTISTA` en `Backend.gs`). Este par ya alimenta genéricamente:
- El croquis de siluetas (`FLUJO_LETRA`/`FLUJO_LABEL`).
- Los dos desplegables de "cambiar tipo de transporte" en `Index.html` (individual y masivo), que se construyen dinámicamente a partir de `FLUJO_LABELS` — **no hace falta tocarlos**, en cuanto exista la entrada de config, aparecen solos.
- `cambiarFlujoPedido()`/`cambiarFlujoPedidosMasivo()` (Backend.gs), que ya funcionan con el pedido en cualquier estado, incluso en silueta, y ya actualizan `OCUPACION` y el historial de transportista.

GruaRemansur encaja como una entrada más de este mismo mecanismo. La única pieza sin cobertura genérica es el correo de segundas cargas, que hoy manda todo a una única lista fija de destinatarios sin mirar el transportista.

## 1. Configuración del nuevo flujo

**`Configuracion.gs`** — añadir a `CONFIG`:
```javascript
TRANSPORTISTAS_FLUJO: {
  ...
  'GruaRemansur': 'grua_remansur'
},
FLUJO_LETRA: {
  ...
  grua_remansur: 'G'
},
FLUJO_LABEL: {
  ...
  grua_remansur: 'GruaRemansur'
}
```

**`Backend.gs`** — añadir a `FLUJO_A_TRANSPORTISTA` (línea ~5532):
```javascript
grua_remansur: 'GruaRemansur'
```

**No se toca `esRemansur()`** (Backend.gs:535): comprueba explícitamente `flujo === 'remansur_transporte' || flujo === 'remansur_pro'`. Como el flujo nuevo es `grua_remansur`, esta función devuelve `false` para pedidos GruaRemansur sin ningún cambio — así se obtiene automáticamente el comportamiento "posición entera, sin compartir delante" que pidió el usuario.

## 2. Cajón nuevo en el menú del operario

**`Index.html`** — nueva entrada en `RAIZ` (línea ~476-481), mismo patrón simple que Transporte/Instalación/PRO (sin pantalla de sub-tipo intermedia):
```javascript
{ id: 'grua_remansur', nombre: 'GruaRemansur', desc: 'Remansur (grúa)', flujo: 'grua_remansur', modo: 'tienda_primero' }
```

Con `modo: 'tienda_primero'`, el operario sigue el flujo ya existente para Transporte/Instalación/PRO: elige tienda → ve la lista de pedidos filtrada por `flujo === 'grua_remansur'`. No hace falta tocar `pantallaTienda()`/`pantallaListaPedidos()` — ya generalizan sobre `estado.raizSel.flujo`.

## 3. Reasignar un pedido ya existente — sin código nuevo

Ambas pantallas de "cambiar tipo de transporte" ya construyen su desplegable con `Object.keys(FLUJO_LABELS).map(...)`:
- Individual: pantalla Buscar → detalle de pedido → "Cambiar tipo de transporte" (Index.html:4412, llama a `cambiarFlujoPedido`).
- Masivo: pestaña Silueta → "Cambiar flujo masivo" (Index.html:2592, llama a `cambiarFlujoPedidosMasivo`).

En cuanto `FLUJO_LABELS` (client-side, Index.html:491-494, espejo de `CONFIG.FLUJO_LABEL`) incluya `grua_remansur: 'GruaRemansur'`, GruaRemansur aparece en los dos desplegables sin tocar más código. Esto cubre el requisito 2 (reasignar un pedido ya en silueta) completo.

## 4. Añadir un pedido directamente a GruaRemansur

**`Index.html`** — el formulario "Añadir pedido manual a silueta" (pestaña Silueta, línea ~2540-2547) tiene un desplegable de flujo con opciones **fijas en el HTML** (a diferencia de los dos anteriores, que son genéricos). Se añade una opción más:
```html
<option value="grua_remansur">GruaRemansur</option>
```
Este formulario llama a `registrarPedidoManual` (Backend.gs), que ya acepta cualquier `flujo` sin validación de lista cerrada — no hace falta tocar el backend.

## 5. Correo de segundas cargas dividido por grupo

**`CorreoSegundasCargas.gs`** — nueva lista de destinatarios independiente, mismo patrón que la actual (editable vía `PropertiesService` sin tocar código):
```javascript
var DESTINATARIOS_SEGUNDAS_CARGAS_GRUA = [
  'antonia.zambrano@leroymerlin.es',
  'pedidocliente.alm-malaga@leroymerlin.es',
  'jose-manuel.lachambre@leroymerlin.es'
];
function getDestinatariosSegundasCargasGrua() { /* igual que getDestinatariosSegundasCargas, propiedad 'DEST_SEGUNDAS_CARGAS_GRUA' */ }
function setDestinatariosSegundasCargasGrua(lista) { /* igual que setDestinatariosSegundasCargas */ }
```

`enviarCorreoSegundasCargas(info, destinatariosOverride)` gana un segundo parámetro opcional — si se pasa, se usa en vez de `getDestinatariosSegundasCargas()`. Cambio mínimo, no rompe la llamada existente sin ese parámetro.

Nueva función orquestadora que separa por grupo antes de enviar:
```javascript
function enviarCorreosSegundasCargas(infoBase) {
  var pendientes = infoBase.pendientes || [];
  var deGrua = pendientes.filter(function(p) { return p.transportista === 'GruaRemansur'; });
  var resto = pendientes.filter(function(p) { return p.transportista !== 'GruaRemansur'; });
  var resultados = [];
  if (deGrua.length) {
    resultados.push(enviarCorreoSegundasCargas(
      Object.assign({}, infoBase, { pendientes: deGrua }),
      getDestinatariosSegundasCargasGrua()
    ));
  }
  if (resto.length) {
    resultados.push(enviarCorreoSegundasCargas(Object.assign({}, infoBase, { pendientes: resto })));
  }
  return { ok: resultados.every(function(r) { return r.ok; }), correos: resultados };
}
```
Si un grupo queda vacío, no se manda correo para ese grupo — el caso normal (una carga de un solo transportista) sigue mandando un único correo, igual que hoy.

**`Backend.gs`** — único punto de enganche, dentro de `confirmarEntregas()` (línea ~2032): la llamada pasa de `enviarCorreoSegundasCargas({...})` a `enviarCorreosSegundasCargas({...})`. El resto de la función no cambia — la partición por transportista ya se puede hacer con el campo `transportista` que cada `pendientes2Items[i]` ya lleva, sin tocar cómo se construye esa lista.

`_enviarPruebaCorreo`/`probarCorreoSegundasCargas` (correo de prueba) no se tocan — siguen probando solo el formato del correo "normal"; si se quiere, se puede añadir después una prueba específica para el grupo GruaRemansur, pero no es necesario para el objetivo de hoy.

## Fuera de alcance

- No se cambia el comportamiento de importación desde Pyxis/Clasificador — los pedidos siguen entrando como hoy (normalmente Correcaminos) y se reasignan a GruaRemansur después, a mano, como pidió el usuario ("esos pedidos deben pasar antes a ser de GruaRemansur").
- No se añade ningún color/estilo especial al botón del menú (el cajón "Remansur" existente tiene una clase CSS `.remansur` propia; GruaRemansur usa el estilo por defecto de los demás cajones, como Transporte/Instalación/PRO).
- No se toca `REMANSUR_TIPOS` ni la pantalla "Tipo de pedido Remansur" — GruaRemansur no vive dentro de ese flujo.
- No se valida en el backend que un pedido no pueda tener `flujo` fuera de la lista conocida — ya es así hoy para el resto de flujos (`estado`/`transportista` tampoco tienen `CHECK` en Supabase, ver memoria de la migración), y añadir esa validación sería un cambio no pedido.

## Archivos a tocar

- `Configuracion.gs` — 3 entradas de config (`TRANSPORTISTAS_FLUJO`, `FLUJO_LETRA`, `FLUJO_LABEL`).
- `Backend.gs` — 1 entrada en `FLUJO_A_TRANSPORTISTA`, 1 línea cambiada en `confirmarEntregas()`.
- `Index.html` — 1 entrada en `RAIZ`, 1 entrada en `FLUJO_LABELS`, 1 `<option>` en el formulario de alta manual.
- `CorreoSegundasCargas.gs` — nueva lista de destinatarios + getter/setter, parámetro opcional en `enviarCorreoSegundasCargas`, nueva función `enviarCorreosSegundasCargas`.
