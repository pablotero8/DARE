# 🎯 DARE - AI Fitness Coaching Platform

An AI-powered platform for personalized training and nutrition coaching with a coach portal and client dashboard.

## Quick Start (Local Development)

### Prerequisites
- Node.js >= 20
- OpenAI API key (get at https://platform.openai.com/api-keys)

### Setup (< 2 minutes)

```bash
# 1. Install dependencies
npm install
npm run install-all

# 2. Add your OpenAI API key to .env
# Edit .env and replace:
#   OPENAI_API_KEY=sk-proj-your-key-here
# With your actual key from https://platform.openai.com/api-keys

# 3. Start the server
npm start

# Server runs at http://localhost:3001
```

### Access the app

| Role | URL | Email | Password |
|------|-----|-------|----------|
| **Coach (Training)** | http://localhost:3001/coach.html | silvaepao@gmail.com | SET_VIA_ENV |
| **Coach (Nutrition)** | http://localhost:3001/coach.html | daniotero15@gmail.com | SET_VIA_ENV |
| **Client (Demo)** | http://localhost:3001/client.html | client@dare.ae | SET_VIA_ENV |

## 🗂️ Project Structure

```
DARE/
├── bot/                      # Backend (Node.js/Express)
│   ├── server.js            # Main server
│   ├── db.js                # SQLite database setup
│   ├── clients.js           # Client management
│   ├── auth.js              # Authentication (JWT)
│   ├── planner.js           # Plan generation & storage
│   ├── tools.js             # OpenAI tool definitions
│   └── env.js               # Environment variables
│
├── client.html              # Client portal (responsive)
├── coach.html               # Coach portal (AI chat + plan builder)
├── index.html               # Landing page
│
├── .env                     # Environment variables (LOCAL)
├── .env.example             # Environment template
├── package.json             # Root scripts
├── DEPLOYMENT.md            # Production deployment guide
├── setup-production.sh       # Automated production setup
└── README.md                # This file
```

## 🔑 Key Features

✅ **Coach Portal**
- AI-powered training/nutrition planning (GPT-4 Turbo)
- Prompt caching for cost optimization
- Create new client accounts
- Reset client passwords
- Real-time plan generation

✅ **Client Portal**
- Weekly training & nutrition plans
- Progress tracking (weight, body fat, lean mass)
- Plan history by week
- Clean, responsive interface

✅ **Database**
- SQLite for data persistence
- Automatic migrations
- Foreign key constraints
- Session management with JWT tokens

✅ **Authentication**
- Email/password login
- JWT tokens (6-hour expiry)
- Role-based access (coach/client)
- Automatic session validation

## 📊 Database Schema

### clients
- id, name, email, password_hash, phone
- goal, currentWeek, totalWeeks
- height, weight, bodyFat, leanMass
- role (coach/client), specialty (training/nutrition)

### sessions
- token, client_id, created_at, expires_at

### plans
- client_id, week_of, plan_json
- training_ready, nutrition_ready flags
- created_at, published_at

## 🚀 Production Deployment

### Option 1: VPS (Recommended)
```bash
sudo bash setup-production.sh
# Automated setup on DigitalOcean, Linode, AWS, etc.
```

### Option 2: Manual
See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions.

### Option 3: Docker
```bash
docker build -t dare .
docker run -d -p 3001:3001 -e OPENAI_API_KEY=... -v dare-data:/app/data dare
```

## 🔄 Development

```bash
# Watch mode (auto-restart on file changes)
npm run dev

# Production build
npm start

# Install all dependencies
npm run install-all
```

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| **"Cannot find module 'better-sqlite3'"** | `cd bot && npm rebuild && cd ..` |
| **"OPENAI_API_KEY is not set"** | Check `.env` file, add your key |
| **Port 3001 already in use** | `lsof -i :3001` then `kill -9 <PID>` |
| **"Database is locked"** | Restart the server |
| **Coach chat not working** | Check OpenAI API key is valid and has credits |

## 📈 Monitoring

```bash
# View logs
npm run logs

# Check server status
curl http://localhost:3001/health

# Database backup
cp data/dare.db data/dare.db.backup.$(date +%Y%m%d)
```

## 📞 API Endpoints

### Authentication
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user info

### Plans (Client)
- `GET /api/plans/:clientId` - Get latest plan
- `GET /api/plans/:clientId/week/:weekOf` - Get plan for specific week
- `GET /api/plans/:clientId/weeks` - List all plan weeks

### Coach Tools
- `GET /api/coach/clients` - List all clients
- `POST /api/coach/chat` - AI chat endpoint (supports function calling)

### Utilities
- `GET /health` - Server health check

## 🔐 Security Notes

- Passwords are hashed with bcrypt
- JWTs expire after 6 hours
- CORS enabled for client access
- Foreign keys enforced in database
- SQL injection prevented with parameterized queries

## 📝 Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-proj-...          # Your OpenAI API key

# Optional
PORT=3001                           # Server port (default: 3001)
NODE_ENV=production                 # Environment (development/production)
DATA_DIR=./data                     # Database directory (default: ./data)
ERIKA_PASSWORD=SET_VIA_ENV           # Coach 1 password (default: SET_VIA_ENV)
DANI_PASSWORD=SET_VIA_ENV             # Coach 2 password (default: SET_VIA_ENV)
```

## 🎓 Learn More

- [OpenAI API Docs](https://platform.openai.com/docs)
- [Express.js](https://expressjs.com)
- [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3)
- [JWT Guide](https://jwt.io)

## 📄 License

Proprietary - All rights reserved

---

**Need help?** Check [DEPLOYMENT.md](./DEPLOYMENT.md) for production setup and troubleshooting.
