FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

ENV QUICKEN_DB_PATH=/data/data

CMD ["node", "dist/index.js"]
