FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache libc6-compat
RUN corepack enable

COPY . .
RUN pnpm install

EXPOSE 3000

CMD ["pnpm", "dev"]
