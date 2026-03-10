# mi-turno

Stack Dockerizado para:
- Backend en TypeScript (ideal para Baileys)
- Frontend con Next.js
- Base de datos PostgreSQL
- Gestor de paquetes: pnpm

## Estructura esperada

- `backend/` con API Express TypeScript
- `frontend/` con su `package.json`

## Uso

1. Copia variables de entorno:

```bash
cp .env.example .env
```

2. Levanta los servicios:

```bash
docker compose up --build
```

Servicios:
- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001`
- PostgreSQL: `localhost:5432`

## Endpoints backend base

- `GET /health`
- `GET /db/ping`
- `GET /baileys/status`
- `POST /baileys/connect`
- `GET /baileys/qr?format=svg|terminal|raw`
