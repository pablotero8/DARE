# 🚂 Desplegar DARE en Railway

Guía paso a paso. La base de datos (usuarios + planes de entreno/nutrición) se guarda en un **volumen persistente** que sobrevive a los redeploys.

---

## Paso 1 — Subir el código a GitHub

El proyecto ya es un repo git local. Solo falta subirlo:

```bash
# Crea un repo nuevo en https://github.com/new (ej: "dare")
# Luego conecta y sube:
cd /Users/pablootero/Desktop/PAODAN
git remote add origin https://github.com/TU_USUARIO/dare.git
git branch -M main
git push -u origin main
```

> Los secretos (`.env`, `bot/.env`) y la base de datos (`data/`) **NO se suben** — están en `.gitignore`.

---

## Paso 2 — Crear el proyecto en Railway

1. Entra en **https://railway.app** y crea cuenta (gratis, conéctala con GitHub)
2. **New Project** → **Deploy from GitHub repo**
3. Selecciona tu repo `dare`
4. Railway detecta Node.js automáticamente (NIXPACKS) y empieza a construir

---

## Paso 3 — Configurar variables de entorno

En el servicio → pestaña **Variables** → añade estas:

| Variable | Valor |
|----------|-------|
| `OPENAI_API_KEY` | _(tu clave — está en tu `bot/.env` local)_ |
| `JWT_SECRET` | _(el valor de tu `bot/.env` local — IMPORTANTE: usa SIEMPRE el mismo, si cambia se cierran todas las sesiones)_ |
| `DATA_DIR` | `/data` |
| `ERIKA_PASSWORD` | `erika2026` _(o la que quieras)_ |
| `DANI_PASSWORD` | `dani2026` _(o la que quieras)_ |

> `PORT` lo inyecta Railway automáticamente — **no lo añadas**.

Para ver tus valores locales y copiarlos:
```bash
cat /Users/pablootero/Desktop/PAODAN/bot/.env
```

---

## Paso 4 — Crear el VOLUMEN PERSISTENTE (la base de datos) 🔑

Esto es lo más importante: sin volumen, la BD se borra en cada deploy.

1. En el servicio → pestaña **Settings** (o clic derecho en el servicio → **Add Volume**)
2. **New Volume**
3. **Mount path:** escribe exactamente `/data`
4. Guarda

Ahora `DATA_DIR=/data` (del paso 3) apunta al volumen → la BD vive ahí permanentemente:
- ✅ Usuarios creados se guardan
- ✅ Planes de entreno/nutrición se guardan
- ✅ Sobreviven a cada redeploy

---

## Paso 5 — Generar el dominio público

1. Servicio → **Settings** → **Networking** → **Generate Domain**
2. Railway te da una URL tipo `https://dare-production-xxxx.up.railway.app`
3. Tu app vive ahí. Accede a:
   - Coach: `https://...railway.app/coach.html`
   - Cliente: `https://...railway.app/client.html`

> El código usa `window.location.origin`, así que **funciona en cualquier dominio sin tocar nada**.

---

## Paso 6 — Conectar darehabits.com (opcional)

1. Servicio → **Settings** → **Networking** → **Custom Domain**
2. Escribe `darehabits.com` (o `app.darehabits.com`)
3. Railway te da un registro **CNAME**
4. En tu proveedor DNS (donde compraste darehabits.com), añade ese CNAME
5. Espera unos minutos → ya accedes desde tu dominio con HTTPS automático

---

## ✅ Verificación final

1. Abre `https://tu-url.railway.app/coach.html`
2. Login: `silvaepao@gmail.com` / `erika2026`
3. Pide un plan → recibes la plantilla rellenable
4. Crea un cliente de prueba
5. **Haz un redeploy** (push cualquier cambio) → el cliente sigue ahí ✅ (volumen funciona)

---

## 🔄 Actualizaciones futuras

Cada vez que hagas cambios:
```bash
git add .
git commit -m "descripción del cambio"
git push
```
Railway redespliega automáticamente. La BD (volumen) no se toca.

---

## 💾 Backup de la base de datos

Railway permite descargar el contenido del volumen, o puedes añadir un backup periódico.
Para descargar manualmente: Railway dashboard → Volume → Browse/Download.

---

## ❓ Problemas comunes

| Problema | Solución |
|----------|----------|
| "Application failed to respond" | Revisa que `OPENAI_API_KEY` esté puesta en Variables |
| Sesiones se cierran tras redeploy | `JWT_SECRET` cambió — fíjalo a un valor constante |
| Datos se borran en redeploy | Falta el volumen en `/data` o `DATA_DIR` mal escrito |
| Build falla | Revisa logs en Railway → pestaña Deployments |
