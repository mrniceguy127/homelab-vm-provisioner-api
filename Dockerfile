# Runtime Dockerfile for the API service
FROM node:18-bookworm-slim

# Configurable port (default: 3001)
ARG API_PORT=3001
ENV PORT=${API_PORT}

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE ${API_PORT}

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.PORT||3001; require('http').get('http://localhost:'+p+'/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "src/server.js"]
