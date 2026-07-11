# Integración Fitbit (Google) — Guía de activación

El código ya está desplegado pero la integración permanece **oculta** hasta que
configures las credenciales. Sin `FITBIT_CLIENT_ID` / `FITBIT_CLIENT_SECRET`,
la tarjeta Fitbit no aparece en el portal y los endpoints responden
`configured: false`.

## 1. Registrar la app en Fitbit

1. Entra en <https://dev.fitbit.com/apps/new> (inicia sesión con una cuenta Google/Fitbit).
2. Rellena el formulario:
   - **Application Name:** `DARE Coaching`
   - **Description:** coaching privado de entrenamiento y nutrición; los clientes conectan su Fitbit para compartir sueño, FC y actividad con sus coaches.
   - **Application Website URL:** `https://darehabits.com`
   - **Organization:** DARE
   - **Organization Website URL:** `https://darehabits.com`
   - **Terms of Service URL:** `https://darehabits.com/legal.html`
   - **Privacy Policy URL:** `https://darehabits.com/privacy.html` ← obligatorio y ya actualizado con la sección Fitbit
   - **OAuth 2.0 Application Type:** **Server**
   - **Redirect URL:** `https://darehabits.com/api/fitbit/callback`
   - **Default Access Type:** **Read Only**
3. Acepta los términos y guarda. Obtendrás **OAuth 2.0 Client ID** y **Client Secret**.

## 2. Variables de entorno en Railway

En el servicio de Railway → Variables:

```
FITBIT_CLIENT_ID=<tu client id>
FITBIT_CLIENT_SECRET=<tu client secret>
```

(`APP_URL` ya existe y se usa para construir la redirect URI — debe seguir siendo `https://darehabits.com`.)

Redeploy. La tarjeta "Fitbit" aparecerá automáticamente en el perfil del portal de clientes.

## 3. Qué hace la integración

- **OAuth 2.0 + PKCE** contra la API web de Fitbit; el cliente autoriza en la pantalla de consentimiento de Fitbit.
- **Scopes mínimos:** `activity`, `heartrate`, `sleep`. Solo resúmenes diarios (sin datos intradía → no requiere aprobación especial de Google).
- Datos mostrados: sueño (duración/eficiencia), FC en reposo, VFC (HRV), pasos, minutos activos, calorías.
- Los coaches pueden consultar el resumen de cada cliente (`GET /api/fitbit/summary/:clientId`), igual que los check-ins.
- Caché de 10 min por cliente → muy por debajo del límite de 150 peticiones/usuario/hora de Fitbit.
- **Desconectar** desde el portal revoca el token en Fitbit y borra tokens + datos en nuestra base de datos.

## 4. Checklist legal (ya cumplido en el código)

- [x] Política de privacidad con sección específica Fitbit (EN y ES) — requisito de los términos de la plataforma Fitbit.
- [x] Consentimiento explícito del usuario vía pantalla OAuth de Fitbit (RGPD art. 9.2.a / PDPL EAU).
- [x] Scopes mínimos y solo lectura.
- [x] Sin uso publicitario, sin venta ni cesión de datos (declarado en la política).
- [x] Derecho de revocación: botón de desconexión + revocación desde la cuenta Fitbit.
- [x] Marca: solo se usa el nombre "Fitbit" en texto con atribución "Fitbit is a trademark of Google LLC" (no usamos logos de Google/Fitbit ni el programa de certificación "Works with Fitbit").

## 5. Prueba end-to-end

1. Entra en `https://darehabits.com/client.html` con un cliente de prueba.
2. Perfil → tarjeta "⌚ Fitbit" → **Conectar mi Fitbit**.
3. Autoriza en fitbit.com → vuelves al portal con "✓ ¡Fitbit conectado!".
4. Los tiles muestran los datos del día (si el dispositivo ha sincronizado).
5. **Desconectar Fitbit** → confirma → la tarjeta vuelve al estado inicial.
