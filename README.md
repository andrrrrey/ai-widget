# AI Chat Widget + Admin Takeover — мультиклиент + API key на проект (вариант B)

Домен (пример): **loginov.futuguru.com**

Один backend + одна БД обслуживают много клиентов/сайтов через сущность **Project**.
У каждого Project задаются:
- `openai_api_key` (ключ клиента)
- `assistant_id` (ассистент клиента, с его Vector Store/File Search)
- `instructions`
- `allowed_origins` (домены, где разрешен виджет)

---

## 0) Требования
- Ubuntu 22.04/24.04
- Node.js 20+
- Nginx
- PostgreSQL 14+
- SSL (certbot)

---

## 1) Установка на VPS

### 1.1 Пакеты
```bash
sudo apt update
sudo apt install -y nginx git postgresql certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2
```

### 1.2 PostgreSQL: база и юзер
```bash
sudo -u postgres psql
```
```sql
CREATE USER aiwidget WITH PASSWORD 'STRONG_PASSWORD';
CREATE DATABASE aiwidget OWNER aiwidget;
\q
```

### 1.3 Код
```bash
sudo mkdir -p /var/www
sudo cp -r ./ai-widget /var/www/ai-widget
cd /var/www/ai-widget/server
npm i
```

### 1.4 ENV
```bash
cp .env.example .env
nano .env
```

Заполните:
- DATABASE_URL
- ADMIN_PASSWORD
- JWT_SECRET

⚠️ `OPENAI_API_KEY` больше не нужен в .env — ключи задаются по каждому Project в админке.

### 1.5 Схема БД
```bash
psql "postgresql://aiwidget:STRONG_PASSWORD@localhost:5432/aiwidget" -f ./sql/001_init.sql
```

Если вы обновляете существующую БД со старой версии:
```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS openai_api_key text NOT NULL DEFAULT '';
```

### 1.6 Запуск
```bash
npm run start:prod
pm2 start src/index.js --name ai-widget
pm2 save
pm2 startup
```

Проверка:
```bash
pm2 ls
curl -s http://127.0.0.1:3000/health
```

---

## 2) Nginx + SSL

Скопируйте `deploy/nginx-loginov.futuguru.com.conf` в:
`/etc/nginx/sites-available/loginov.futuguru.com`

```bash
sudo ln -s /etc/nginx/sites-available/loginov.futuguru.com /etc/nginx/sites-enabled/loginov.futuguru.com
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d loginov.futuguru.com
```

---

## 3) Админка

- https://loginov.futuguru.com/admin/
- Логин: `admin`
- Пароль: `ADMIN_PASSWORD` из `.env`

В проекте (Project) обязательно заполнить:
- OpenAI API key (клиента)
- assistant_id (клиента)
- allowed_origins (домены сайтов клиента)

---

## 4) Вставка виджета на сайт клиента

```html
<script
  src="https://loginov.futuguru.com/widget/widget.js"
  data-project-id="PROJECT_UUID_ИЗ_АДМИНКИ"
  data-title="Напишите нам"
  data-position="right"
></script>
```

Если домен сайта клиента не добавлен в allowed_origins — виджет получит 403 origin_not_allowed.

---

## 5) Важный нюанс по правам

`openai_api_key` проекта должен иметь доступ к указанному `assistant_id` (обычно это один и тот же аккаунт/организация).
Иначе OpenAI вернёт ошибку доступа.

---
