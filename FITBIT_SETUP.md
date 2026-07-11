# Datos Fitbit vía Google Health API — Guía de activación

La integración usa directamente la **Google Health API** (`health.googleapis.com`, v4),
la sustituta oficial de la antigua Fitbit Web API (que Google apaga en septiembre
de 2026). No hay que registrar nada en dev.fitbit.com: todo se configura en
**Google Cloud Console**.

El código ya está desplegado pero la integración permanece **oculta** hasta que
configures las credenciales. Sin `GOOGLE_HEALTH_CLIENT_ID` /
`GOOGLE_HEALTH_CLIENT_SECRET`, la tarjeta Fitbit no aparece en el portal y los
endpoints responden `configured: false`.

## 1. Proyecto en Google Cloud

1. Entra en <https://console.cloud.google.com> y crea un proyecto (p. ej. `dare-health`).
2. Habilita la **Google Health API**: <https://console.developers.google.com/apis/library/health.googleapis.com>.

## 2. Pantalla de consentimiento OAuth

En <https://console.developers.google.com/auth/audience>:

1. **User type:** External · **Publishing status:** Testing.
2. Nombre de la app: `DARE Coaching` · soporte: tu email · dominio: `darehabits.com`.
3. **Privacy Policy URL:** `https://darehabits.com/privacy.html` (obligatoria — ya actualizada).
4. **Test users:** añade tu email y el de cada cliente que vaya a conectar Fitbit
   (límite 100 en modo Testing).

En <https://console.developers.google.com/auth/scopes> ("Data Access") añade los
3 scopes de la Google Health API que usa la app:

- `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
- `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
- `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`

## 3. Credenciales OAuth 2.0

En <https://console.developers.google.com/apis/credentials>:

1. **Create credentials → OAuth client ID → Web application.**
2. Nombre: `DARE web`.
3. **Authorized redirect URI:** `https://darehabits.com/api/fitbit/callback`
4. Guarda el **Client ID** y el **Client Secret**.

## 4. Variables de entorno en Railway

```
GOOGLE_HEALTH_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_HEALTH_CLIENT_SECRET=<client secret>
```

(`APP_URL` ya existe y debe seguir siendo `https://darehabits.com`; con él se
construye la redirect URI. Opcional: `HEALTH_API_DEBUG=1` para volcar en los
logs las respuestas crudas de la API mientras ajustas la integración.)

Redeploy. La tarjeta "Fitbit" aparecerá automáticamente en el perfil del portal.

## 5. Importante: modo Testing vs producción

- **En modo Testing** (recomendado para empezar): funciona ya, hasta 100 usuarios
  que añadas como test users. **Los refresh tokens caducan a los 7 días**, así
  que el cliente tendrá que reconectar semanalmente — el portal lo gestiona solo
  (la tarjeta vuelve al estado "Conectar mi Fitbit").
- **Para producción** (sin recontecar y sin límite de 100): los scopes de la
  Google Health API son **restricted**, así que Google exige una **verificación
  de la app** (revisión de privacidad/seguridad: branding, política de privacidad,
  justificación de scopes; puede incluir evaluación de seguridad). Se solicita
  desde la pantalla de consentimiento → "Publish app". Cuenta con semanas de
  plazo. Mientras tanto, el modo Testing cubre el negocio actual (2 coaches +
  clientes contados).

## 6. Qué hace la integración

- **Google OAuth 2.0 + PKCE** (`access_type=offline`, `prompt=consent`): el
  cliente autoriza en la pantalla de consentimiento de Google.
- Endpoints v4: `dailyRollUp` de hoy para pasos / minutos en zona activa /
  calorías, y `list` reciente para sueño, FC en reposo diaria y VFC (HRV).
- Datos mostrados: sueño (duración/eficiencia), FC en reposo, VFC, pasos,
  minutos activos, calorías.
- Los coaches pueden consultar el resumen de cada cliente
  (`GET /api/fitbit/summary/:clientId`), igual que los check-ins.
- Caché de 10 min por cliente.
- **Desconectar** desde el portal revoca el token en Google
  (`oauth2.googleapis.com/revoke`) y borra tokens + datos en nuestra base de datos.
- La API es nueva (GA mayo 2026): los extractores de campos son tolerantes a
  cambios de esquema — si Google renombra un campo, el tile muestra "—" en vez
  de romper. Con `HEALTH_API_DEBUG=1` puedes ver las respuestas reales y ajustar
  `bot/fitbit.js` si hiciera falta.

## 7. Checklist legal (ya cumplido en el código)

- [x] Política de privacidad con sección específica de datos de wearable vía
  Google Health API (EN y ES) — requisito de la verificación de Google.
- [x] Consentimiento explícito del usuario en la pantalla OAuth de Google
  (RGPD art. 9.2.a / PDPL EAU).
- [x] Scopes mínimos y solo lectura (3 de los ~15 disponibles; sin ubicación,
  sin nutrición, sin perfil).
- [x] Sin uso publicitario, sin venta ni cesión de datos (declarado en la política).
- [x] Derecho de revocación: botón de desconexión en el portal + revocación desde
  myaccount.google.com/connections.
- [x] Marca: solo se usa el nombre "Fitbit" en texto con atribución
  "Fitbit is a trademark of Google LLC" (sin logos de Google/Fitbit).

## 8. Prueba end-to-end

1. Añádete como test user en la pantalla de consentimiento.
2. Entra en `https://darehabits.com/client.html` con un cliente de prueba.
3. Perfil → tarjeta "⌚ Fitbit" → **Conectar mi Fitbit** → autoriza en Google.
4. Vuelves al portal con "✓ ¡Fitbit conectado!" y los tiles con los datos del día
   (si tu dispositivo Fitbit ha sincronizado con la app).
5. **Desconectar Fitbit** → confirma → la tarjeta vuelve al estado inicial y el
   acceso desaparece de myaccount.google.com/connections.
