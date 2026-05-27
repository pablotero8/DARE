# Despliegue en Railway + Netlify

## 1. Preparar el código local

```bash
cd /Users/pabloutero/Desktop/PAODAN
git add .
git commit -m "Bot ready for production"
git push origin main
```

## 2. Desplegar BOT en Railway

### 2.1 Crea cuenta en Railway
- Ve a https://railway.app
- Registrate con GitHub
- Conecta tu cuenta de GitHub

### 2.2 Nuevo proyecto
1. Haz clic en **New Project**
2. Selecciona **Deploy from GitHub repo**
3. Busca `pabloutero/PAODAN` (o similar)
4. Selecciona el repo
5. Elige branch `main`
6. Railway detecta automáticamente que es Node.js

### 2.3 Configurar variables de entorno
En el panel de Railway, ve a **Variables** y añade:

```
OPENAI_API_KEY=sk-proj-XXXXX
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=+14155238886
DANIEL_PHONE=whatsapp:+34651585260
PORT=3001
```

### 2.4 Obtén la URL pública
En Railway, ve a **Settings > Domains**. Verás algo como:
```
https://dare-bot-prod-production.up.railway.app
```

Copia esta URL.

## 3. Actualizar Twilio

Ve a https://console.twilio.com → **Messaging > Whatsapp Sandbox Settings**

En **When a message comes in**, reemplaza con:
```
https://dare-bot-prod-production.up.railway.app/webhook
```

Guarda.

## 4. Desplegar FRONTEND en Netlify

### 4.1 Crea cuenta en Netlify
- Ve a https://netlify.com
- Registrate con GitHub

### 4.2 Conecta el repo
1. Haz clic en **New site from Git**
2. Selecciona GitHub
3. Busca `pabloutero/PAODAN`
4. Netlify detecta que es un sitio estático
5. Haz clic en **Deploy site**

### 4.3 Actualizar URL de producción en client.html

En `/Users/pabloutero/Desktop/PAODAN/client.html`, busca esta línea:

```javascript
window.DARE_API_URL = isDev ? 'http://localhost:3001' : 'https://tu-app-railway.railway.app';
```

Reemplaza `https://tu-app-railway.railway.app` con la URL de Railway que copiaste:

```javascript
window.DARE_API_URL = isDev ? 'http://localhost:3001' : 'https://dare-bot-prod-production.up.railway.app';
```

Guarda y haz push:

```bash
git add client.html
git commit -m "Update production API URL"
git push origin main
```

Netlify redeploya automáticamente.

## 5. Verificar que funciona

1. **Abre el portal en producción:**
   ```
   https://tu-sitio-en-netlify.netlify.app/client.html?client=alex-hammond
   ```

2. **Envía un mensaje por WhatsApp desde el teléfono de Daniel:**
   ```
   plan de entrenamiento para alex hammond
   ```

3. Responde con los datos cuando pregunte

4. Cuando diga `[LISTO PARA GENERAR]`, confirma

5. **Recarga el portal**

El plan debería aparecer automáticamente.

## Notas

- Railway corre **24/7** sin costo (primeros $5/mes son gratis)
- Netlify aloja el frontend **gratis**
- Solo usas **WhatsApp** para generar planes
- No necesitas tocar la computadora después del despliegue
