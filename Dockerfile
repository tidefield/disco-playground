FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYGROUND_DATA_DIR=/data/playground

COPY package.json ./
COPY server.mjs ./
COPY public ./public

RUN mkdir -p /data/playground

EXPOSE 8080
CMD ["node", "server.mjs"]
