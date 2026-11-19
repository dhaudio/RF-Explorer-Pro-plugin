# RF Explorer Pro para SoundBase

Plugin de SoundBase que convierte un **RF Explorer Pro** (RF Venue) en un
analizador de espectro en vivo: lo que dibuja el Pro pasa a ser la traza del
gráfico de SoundBase.

Creado a partir de
[soundbase-plugin-template](https://github.com/soundbase-lab/soundbase-plugin-template).

> **Estado: probado con capturas reales de un RF Explorer Pro RFEPRO A1GPS
> (firmware 1.25) y con un servidor VNC real; pendiente de probar el plugin
> completo con el equipo.** El mismo método, en una versión anterior en
> Python, ya funcionó con el equipo real en SoundBase.

## Cómo funciona

El RF Explorer Pro no ofrece ninguna interfaz de datos a otros programas: su
único acceso remoto es **VNC**, que muestra su pantalla. El plugin se conecta
por VNC **solo para mirar** (nunca pulsa ni escribe nada en el Pro) y:

1. **lee los números de los ejes** de la pantalla (frecuencia de inicio y fin,
   y los dBm de arriba abajo), así que el rango sale del propio Pro, sin
   configurar nada;
2. **lee la traza amarilla** en tiempo real: un punto por columna del gráfico,
   en el rango que muestre el Pro. Son **1181 puntos con el menú lateral del
   Pro oculto** y 911 con él visible (el gráfico es más estrecho), y el
   plugin detecta solo cuál de las dos disposiciones hay;
3. si **cambias el rango en el Pro**, lo detecta y se reconecta con el nuevo;
4. lee también la **versión del firmware** que muestra el Pro, y la indica como
   firmware del equipo.

Cada lectura de los ejes se comprueba antes de usarla: los once niveles de dBm
tienen que estar equiespaciados y la frecuencia central tiene que quedar justo
entre inicio y fin. Si algo no cuadra, el plugin lo dice en vez de adivinar.

## Antes de empezar

- **El Pro en red, por cable**: un adaptador USB‑Ethernet en su puerto **USB
  3.0 tipo A**. Conectado directamente al ordenador, el Pro toma una dirección
  `169.254.x.x`; mírala en sus ajustes de red.
- **El Pro en la pantalla del analizador, en LIVE**, sin menús abiertos. Con
  Hold o reproduciendo una grabación, la traza no se actualiza (el plugin
  avisa).
- **La traza en tiempo real (amarilla) visible.**

## Usarlo en SoundBase

1. Instala el plugin y, en el plot, abre el engranaje de **live scan**.
2. En *Select a device*, elige **RF Explorer Pro (by address)** y escribe la
   **IP del Pro**. El puerto VNC es 5900. Si le pusiste contraseña al VNC del
   Pro (recomendable: sin ella, cualquiera en la red puede manejarlo),
   escríbela; si no, déjala vacía.
3. **Save** y **Live**.

En los controles del live scan aparecen:

- **Screen detector**: **Peak** (por defecto) toma la parte alta de la línea en
  cada columna, así que nunca se pierde una señal; sobre el ruido lee unos dB
  por encima de los marcadores del Pro. **Center of line** se parece más a los
  marcadores sobre el ruido, a costa de unos 2 dB en los picos.
- **Pro start / stop / top / bottom (manual)**: se dejan **vacíos**. Solo hacen
  falta si el plugin avisa de que no puede leer los ejes; entonces se escriben
  los números que muestra el Pro.

## Limitaciones

- **La resolución es la de la pantalla**: 1181 puntos en el rango del Pro con
  el menú lateral oculto (911 con él visible), sea cual sea el número de puntos
  de su barrido. Con 430 MHz de span son ~365 kHz por punto; con ~118 MHz,
  ~100 kHz. Para más resolución, oculta el menú lateral y estrecha el span en
  el Pro. La amplitud queda en pasos de ~0,22 dB (un píxel).
- **Si muestras u ocultas el menú lateral del Pro**, el gráfico cambia de ancho
  y el plugin se reconecta solo con el nuevo número de puntos.
- **Solo lectura**: el span, la RBW y el nivel de referencia se cambian en el
  Pro. En SoundBase se puede ver cualquier parte del span del Pro, pero no más.
- **Las líneas de los marcadores tapan columnas**; esas columnas se rellenan
  interpolando. Con menos marcadores en pantalla, mejor.
- **Hecho para la pantalla de 1280×800 del firmware 1.25.** Si un firmware
  cambia la disposición o la fuente de los números, hay que actualizar
  `driver/layout.js` o `driver/glyphs.js`.

## Probarlo con tu RF Explorer Pro

```sh
npm install
npm run probe -- 169.254.225.207
```

Se conecta por VNC, lee los ejes y tres trazas, y guarda la pantalla tal como
la ve el plugin (`probe-rfepro-<fecha>.png`) y un informe
(`probe-rfepro-<fecha>.json`). Opciones: `--port 5900 --sweeps 3`.

## Probarlo sin el equipo

```sh
npm test                    # driver y contrato, con un servidor VNC falso
SB_RFEPRO_MOCK=1 npm start  # un Pro simulado, para probarlo con curl
```

Dentro de SoundBase, activa **Simulated RF Explorer Pro** en los ajustes del
plugin. El Pro simulado dibuja su pantalla como uno real (ejes con su fuente,
traza amarilla), así que pasa por la misma lectura que un equipo de verdad.

Los tests usan **dos capturas reales** de un RF Explorer Pro, con y sin el menú
lateral (`__tests__/fixtures/`), y comprueban que el plugin nunca envía ni una
pulsación ni un clic al equipo.

## Estructura

```
adapter.js                  el analizador para SoundBase
driver/rfb.js               cliente VNC mínimo (RFB 3.3/3.7/3.8, solo mirar)
driver/des.js               cifrado de la contraseña VNC (no depende de OpenSSL)
driver/axes.js              lectura de los números de los ejes
driver/glyphs.js            la fuente de los números del Pro
driver/trace.js             píxeles → traza en dBm
driver/layout.js            dónde está cada cosa en la pantalla
driver/sources.js           pantalla real (VNC) o simulada
driver/simulated-screen.js  dibuja una pantalla del Pro
driver/fake-vnc-server.js   servidor VNC falso, para los tests
scripts/probe-rfepro.mjs    prueba con un equipo real
```
