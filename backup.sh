#!/bin/bash
# DARE Database Backup Script
# Descarga la BD de Railway y la guarda localmente con fecha

set -e

BACKUP_DIR="$HOME/.dare-backups"
mkdir -p "$BACKUP_DIR"

# Nombre del archivo con fecha
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/dare-backup-$TIMESTAMP.db"

echo "📦 Descargando backup de Railway..."

# Instrucciones para obtener el token:
# 1. Ir a https://railway.app/account/tokens
# 2. Crear nuevo token con acceso a volumes
# 3. Exportar: export RAILWAY_TOKEN=tu_token

if [ -z "$RAILWAY_TOKEN" ]; then
  echo "❌ ERROR: RAILWAY_TOKEN no está configurado"
  echo ""
  echo "Para configurar:"
  echo "  1. Ve a https://railway.app/account/tokens"
  echo "  2. Crea un nuevo token (API token)"
  echo "  3. Copia el token"
  echo "  4. Ejecuta: export RAILWAY_TOKEN=tu_token"
  echo "  5. Luego vuelve a ejecutar este script"
  exit 1
fi

# Obtener el ID del volumen de Railway
# Necesitas: RAILWAY_PROJECT_ID y RAILWAY_VOLUME_ID
# Para encontrarlos: railway volume ls (después de instalar Railway CLI)

echo "⏳ Descargando desde Railway..."

# Intenta usar railway CLI si existe
if command -v railway &> /dev/null; then
  railway volume download /data "$BACKUP_FILE" 2>/dev/null || {
    echo "⚠️  No se pudo descargar con railway CLI"
    echo "Instala Railway CLI: npm i -g @railway/cli"
    exit 1
  }
else
  echo "❌ Railway CLI no instalado"
  echo "Instala con: npm i -g @railway/cli"
  exit 1
fi

# Verificar que el archivo se creó y tiene datos
if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Error: Backup no se creó"
  exit 1
fi

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "✅ Backup exitoso: $BACKUP_FILE ($SIZE)"

# Mantener solo los últimos 30 backups
echo "🧹 Limpiando backups antiguos..."
cd "$BACKUP_DIR"
ls -t dare-backup-*.db | tail -n +31 | xargs -r rm

# Contar backups disponibles
COUNT=$(ls dare-backup-*.db 2>/dev/null | wc -l)
echo "📊 Total de backups guardados: $COUNT"
