FROM node:20-alpine

WORKDIR /app
COPY server/package.json ./
RUN npm install --production

COPY server/ .

ENV DB_PATH=/data/pacman.db
EXPOSE 3001
CMD ["node", "index.js"]
