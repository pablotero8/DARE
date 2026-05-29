# DARE Deployment Guide

## 🚀 Local Development

### Prerequisites
- Node.js >= 20
- npm

### Setup
```bash
cd /Users/pablootero/Desktop/PAODAN
npm install
cd bot && npm install && cd ..
```

### Run locally
```bash
npm start
# Server runs on http://localhost:3001
```

Access the app:
- **Coach portal:** http://localhost:3001/coach.html
- **Client portal:** http://localhost:3001/client.html

**Demo credentials:**
- Coach (Training): `silvaepao@gmail.com` / `erika2026`
- Coach (Nutrition): `daniotero15@gmail.com` / `dani2026`
- Client: `client@dare.ae` / `dare2026`

---

## 🌐 Production Deployment

### Option A: VPS (DigitalOcean, Linode, AWS, etc.)

#### 1. Prepare your server
```bash
# SSH into your server
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install Node.js (v20+)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs

# Install PM2 (process manager)
npm install -g pm2
```

#### 2. Clone and setup the project
```bash
cd /opt
git clone <your-repo-url> dare
cd dare
npm install
cd bot && npm install && cd ..
```

#### 3. Configure environment
```bash
# Copy template and edit
cp .env.example .env
nano .env

# Add your values:
# - OPENAI_API_KEY=your-key
# - PORT=3001
# - DATA_DIR=/opt/dare/data
```

#### 4. Create data directory
```bash
mkdir -p /opt/dare/data
chmod 755 /opt/dare/data
```

#### 5. Start the app with PM2
```bash
cd /opt/dare
pm2 start bot/server.js --name dare --env .env
pm2 startup
pm2 save
```

#### 6. Setup Nginx reverse proxy (optional but recommended)
```bash
# Install Nginx
apt install -y nginx

# Create config
cat > /etc/nginx/sites-available/dare << 'NGINX'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

# Enable site
ln -s /etc/nginx/sites-available/dare /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

#### 7. Setup HTTPS with Let's Encrypt (optional)
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

---

### Option B: Docker

#### 1. Create Dockerfile
```dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy files
COPY package*.json ./
COPY bot/package*.json ./bot/

# Install dependencies
RUN npm install && cd bot && npm install && cd ..

# Copy app code
COPY . .

# Expose port
EXPOSE 3001

# Start server
CMD ["npm", "start"]
```

#### 2. Create docker-compose.yml
```yaml
version: '3.8'

services:
  dare:
    build: .
    ports:
      - "3001:3001"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - PORT=3001
      - NODE_ENV=production
      - DATA_DIR=/app/data
    volumes:
      - dare-data:/app/data
    restart: unless-stopped

volumes:
  dare-data:
```

#### 3. Run with Docker
```bash
# Build
docker build -t dare .

# Run
docker run -d \
  -p 3001:3001 \
  -e OPENAI_API_KEY=your-key \
  -v dare-data:/app/data \
  --name dare \
  --restart unless-stopped \
  dare
```

---

## 🔒 Database Backup

The app uses SQLite. Backup your data regularly:

```bash
# Manual backup
cp /opt/dare/data/dare.db /opt/dare/data/dare.db.backup.$(date +%Y%m%d)

# Automated backup (cron)
0 2 * * * cp /opt/dare/data/dare.db /backups/dare.db.$(date +\%Y\%m\%d)
```

---

## ✅ Verification Checklist

- [ ] Node.js installed (node --version >= 20)
- [ ] Dependencies installed (npm install completed)
- [ ] .env file created with OPENAI_API_KEY
- [ ] Server starts without errors (npm start)
- [ ] Can login as coach (silvaepao@gmail.com / erika2026)
- [ ] Can login as client (client@dare.ae / dare2026)
- [ ] Plans load and display correctly
- [ ] Coach chat works and calls OpenAI
- [ ] Database file exists at ./data/dare.db or $DATA_DIR/dare.db

---

## 🐛 Troubleshooting

### "Cannot find module 'better-sqlite3'"
```bash
cd bot
npm rebuild
cd ..
```

### "OPENAI_API_KEY is not set"
```bash
# Make sure .env file exists with OPENAI_API_KEY
cat .env | grep OPENAI_API_KEY
```

### "Database is locked"
```bash
# Better-sqlite3 uses WAL mode. If you see lock errors:
rm /opt/dare/data/dare.db-wal
rm /opt/dare/data/dare.db-shm
npm start
```

### Port 3001 already in use
```bash
# Change PORT in .env or kill existing process
lsof -i :3001
kill -9 <PID>
```

---

## 📊 Monitoring

```bash
# View PM2 logs
pm2 logs dare

# Check PM2 status
pm2 status

# Monitor in real-time
pm2 monit
```

---

## 🔄 Updates

To update the app:

```bash
cd /opt/dare
git pull origin main
npm install
cd bot && npm install && cd ..
pm2 restart dare
```

---

## 📞 Support

For issues:
1. Check logs: pm2 logs dare
2. Verify .env settings
3. Ensure OpenAI API key is valid
4. Check database exists at $DATA_DIR/dare.db
