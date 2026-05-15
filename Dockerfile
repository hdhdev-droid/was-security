FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ linux-headers

COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install


FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY index.js network-debug.js ./
COPY public ./public/

ENV WEB_PORT=8888
EXPOSE 8888

CMD ["node", "index.js"]
