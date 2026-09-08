FROM node:22-alpine
WORKDIR /app
COPY package.json ./
ARG WITH_ACS_BROKER=false
RUN if [ "$WITH_ACS_BROKER" = "true" ]; then npm install --omit=dev --ignore-scripts; fi
COPY public ./public
COPY server ./server
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/data ALLOW_REGISTRATION=false
USER node
EXPOSE 4173
VOLUME ["/data"]
CMD ["node", "--experimental-sqlite", "server/index.mjs"]
