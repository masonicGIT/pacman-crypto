FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json ./
RUN npm install --production

COPY . .

# SQLite DB lives on persistent volume
ENV DB_PATH=/data/pacman.db

EXPOSE 3001
CMD ["node", "index.js"]
