# Editar chófer y cargador tras asignar — Diseño

## Contexto

Hoy, dentro de una carga concreta:
- **Cargador de plataforma** ya se puede cambiar en cualquier momento — cada vez que se reimprime la
  hoja de carga (`imprimirHojaCarga` → modal `#modalCargador`), se puede escribir un nombre nuevo y se
  guarda con `actualizarCargador(idCarga, cargador)`.
- **Chófer del vehículo** (`CARGAS.responsable`) solo se puede fijar UNA vez, al crear la carga
  (`crearCarga(listaNumPedidos, responsable)`). No existe ninguna función ni pantalla para cambiarlo
  después.

El usuario pidió poder cambiar los dos en cualquier momento, y específicamente **sin que eso dispare
una reimpresión** de la hoja (decisión ya tomada: botón aparte, no el cuadro de imprimir).

## Diseño

### Servidor — `Backend.gs`

Nueva función `actualizarChofer(idCarga, chofer)`, calcada exactamente de `actualizarCargador`
(Backend.gs:6889-6899) — mismo patrón: busca la carga por id, si no existe devuelve error, si existe
actualiza el campo `responsable` y sincroniza a Supabase.

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

No hay candado nuevo que añadir: `actualizarCargador` tampoco lo tiene (es una escritura de un único
campo sobre una fila ya localizada, mismo nivel de riesgo).

### Cliente — `Index.html`

En `pantallaCargaImprimir` (Index.html:2984-3014, la pantalla de una carga concreta, donde ya está el
botón "🖨️ Imprimir"), se añade un botón nuevo junto al título:

```
📋 Hoja de carga N lista                    [✏️ Editar chófer/cargador]
  1) Imprimir y entregar al cargador  [🖨️ Imprimir]
  ...
```

El botón abre un modal nuevo (mismo patrón visual que `#modalCargador`, pero independiente de él y de
la impresión) con **dos** campos, prerrellenos con los valores actuales de `CARGA_ACTIVA`:

- Chófer del vehículo
- Cargador de plataforma

Al pulsar "Guardar": llama a `actualizarChofer(idCarga, chofer)` y `actualizarCargador(idCarga,
cargador)` (las dos, aunque solo haya cambiado una — mismo coste, código más simple), actualiza
`CARGA_ACTIVA` en memoria, cierra el modal y refresca la pantalla para que se vean los valores nuevos.
No abre ninguna ventana de impresión.

El modal `#modalCargador` existente (ligado a "Imprimir") **se queda tal cual** — sigue funcionando
igual que hoy. Esto añade una vía adicional para corregir cargador (y ahora también chófer) sin pasar
por imprimir; no sustituye nada.

## Alcance fuera (YAGNI)

- No se toca `crearCarga` ni el formulario de "Nueva carga" — el chófer se sigue pudiendo poner ahí
  igual que siempre, esto solo añade la vía para corregirlo DESPUÉS.
- No se añade candado nuevo ni validación de permisos — mismo nivel de acceso que ya tiene
  `actualizarCargador` hoy (cualquiera con acceso a la pantalla de Cargador puede corregirlo).

## Pruebas

Contra un dato de prueba real en Sheets (una carga existente, con `id` conocido):
1. Llamar `actualizarChofer(idCarga, 'Chófer de prueba')` desde el editor → confirmar que
   `CARGAS.responsable` cambió y que no se tocó `cargador`.
2. Confirmar que la llamada a `sincronizarCargaSupabase_` se dispara (mismo patrón ya probado para
   `actualizarCargador`, no hace falta reprobar el propio sync).
3. En el cliente: abrir una carga real, pulsar el nuevo botón, cambiar los dos campos, guardar,
   confirmar que la pantalla refleja los valores nuevos sin abrir ninguna ventana de impresión.
