FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git git-lfs ca-certificates tar \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install

WORKDIR /app

COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY server.js ./

RUN npm install --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
ENV PORT=7860
ENV HF_LFS=1

EXPOSE 7860

RUN mkdir -p /app/data/attachments && chown -R 1000:1000 /app

USER 1000

CMD ["node", "server.js"]
