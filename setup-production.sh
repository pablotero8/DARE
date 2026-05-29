#!/bin/bash
set -e

echo "🚀 DARE Production Setup Script"
echo "================================"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo "⚠️  Please run as root: sudo bash setup-production.sh"
  exit 1
fi

# Variables
INSTALL_DIR="/opt/dare"
APP_USER="dare"
APP_GROUP="dare"

echo "📦 Step 1: Installing system dependencies..."
apt update
apt install -y curl git nodejs npm
npm install -g pm2

echo "👤 Step 2: Creating application user..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -m -d "$INSTALL_DIR" -s /bin/bash "$APP_USER"
  echo "✅ User '$APP_USER' created"
else
  echo "✅ User '$APP_USER' already exists"
fi

echo "📂 Step 3: Setting up application directory..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "📥 Step 4: Cloning/pulling code..."
if [ -d ".git" ]; then
  git pull origin main
  echo "✅ Code updated"
else
  read -p "Enter Git repository URL: " GIT_URL
  git clone "$GIT_URL" .
  echo "✅ Code cloned"
fi

echo "📦 Step 5: Installing dependencies..."
npm install
cd bot && npm install && cd ..

echo "📁 Step 6: Creating data directory..."
mkdir -p data
chmod 755 data
chown -R "$APP_USER:$APP_GROUP" "$INSTALL_DIR"

echo "🔑 Step 7: Configuring environment..."
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "⚠️  Created .env file. You MUST edit it with:"
  echo "   nano $INSTALL_DIR/.env"
  echo ""
  echo "   Required variables:"
  echo "   - OPENAI_API_KEY=your-key"
  echo "   - PORT=3001"
  echo "   - DATA_DIR=$INSTALL_DIR/data"
  echo ""
  read -p "Press Enter once you've edited .env..."
else
  echo "✅ .env already exists"
fi

echo "🔄 Step 8: Starting application with PM2..."
cd "$INSTALL_DIR"
sudo -u "$APP_USER" pm2 start bot/server.js --name dare --env .env
pm2 startup systemd -u "$APP_USER" --hp "$INSTALL_DIR"
pm2 save

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Configure Nginx reverse proxy (optional but recommended)"
echo "2. Setup HTTPS with Let's Encrypt"
echo "3. Check logs: pm2 logs dare"
echo "4. Access: http://localhost:3001 (before Nginx) or http://your-domain.com (after)"
echo ""
echo "💾 Backup regularly:"
echo "   cp $INSTALL_DIR/data/dare.db $INSTALL_DIR/data/dare.db.backup.\$(date +%Y%m%d)"
