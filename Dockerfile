FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

COPY index.js network-debug.js ./
COPY public ./public/

ENV WEB_PORT=8888
EXPOSE 8888

CMD ["node", "index.js"]
