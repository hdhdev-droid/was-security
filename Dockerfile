FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache iputils-ping

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY index.js network-debug.js ./
COPY public ./public/

ENV WEB_PORT=8888
EXPOSE 8888

CMD ["node", "index.js"]
