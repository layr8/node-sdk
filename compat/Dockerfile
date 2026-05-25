FROM node:20-alpine
WORKDIR /app

COPY package.json ./
ARG SDK_VERSION
RUN npm install @layr8/sdk@${SDK_VERSION}

COPY dist/scenarios/ ./scenarios/
COPY dist/bin/ ./bin/

LABEL org.opencontainers.image.source=https://github.com/layr8/node-sdk

ENTRYPOINT ["node", "bin/compat.js"]