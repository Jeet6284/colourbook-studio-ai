FROM node:22-bookworm-slim
# Fonts used when drawing cover/title text (Noto covers Latin, Devanagari and many other scripts).
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-noto-core fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* && fc-cache -f
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
