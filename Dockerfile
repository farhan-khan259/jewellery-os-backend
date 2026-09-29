# Build from project root: docker build -f backend/Dockerfile -t jeweller-os .
FROM mcr.microsoft.com/playwright:v1.55.0-noble AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.55.0-noble AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM mcr.microsoft.com/playwright:v1.55.0-noble
ENV NODE_ENV=production PORT=4000
WORKDIR /app/backend
COPY --from=backend-build --chown=pwuser:pwuser /app/backend/node_modules ./node_modules
COPY --chown=pwuser:pwuser backend/ ./
COPY --from=frontend-build --chown=pwuser:pwuser /app/frontend/dist /app/frontend/dist
RUN mkdir -p /app/backend/var/uploads && chown -R pwuser:pwuser /app/backend/var
USER pwuser
EXPOSE 4000
CMD ["node", "index.mjs"]
